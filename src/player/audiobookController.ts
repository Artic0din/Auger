import { audiobookOperations } from "../api/audiobookOperations.ts";
import { type Clock, sleep } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { abortedError, type RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { isPermittedUrl } from "../api/serverUrl.ts";
import {
    AUDIOBOOK_SEEK_KEYS, type Audiobook, type AudiobookChapter, bookPosition, chapterAt, playerStartPosition,
    relativeSeekTarget,
} from "../contracts/v2/audiobooks.ts";
import type { PlaybackPlan } from "../contracts/v2/playback.ts";
import { AUDIOBOOK_SEEK_BACK_KEY, AUDIOBOOK_SEEK_FORWARD_KEY, profileSettings } from "../contracts/v2/settings.ts";
import { translate } from "../i18n/translate.ts";
import type { RandomBytes } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import { AudiobookSleepTimer, type SleepTimerSnapshot } from "./audiobookSleepTimer.ts";
import type { AVPlay, AVPlayListener } from "./avplay.ts";
import { type PendingTransport, transportLock } from "./avplayTransport.ts";
import {
    AUDIOBOOK_CAPABILITIES, AUDIOBOOK_CLIENT_FEATURES, audiobookAvailableRates, audiobookPlaybackContext,
} from "./capabilities.ts";

const PROGRESS_INTERVAL_MS = 10_000;
const PREVIOUS_CHAPTER_RESTART_SECONDS = 3;
const DEFAULT_SEEK_INTERVALS = { backward: 10, forward: 30 } as const;

export interface AudiobookPlayRequest {
    readonly contentId: string;
    readonly title?: string | undefined;
    readonly posterUrl?: string | undefined;
    readonly startSeconds?: number | undefined;
    readonly restart?: boolean | undefined;
}

export interface AudiobookPlaybackExits {
    readonly onFinished?: () => void;
    readonly onClose?: () => void;
}

export interface AudiobookPlaybackDeps {
    readonly session: NativeSession;
    readonly avplay: AVPlay;
    readonly clock: Clock;
    readonly randomBytes: RandomBytes;
    readonly device: { readonly model: string; readonly appVersion: string };
    readonly exits?: AudiobookPlaybackExits | undefined;
}

export interface AudiobookChapterEntry {
    readonly index: number;
    readonly title: string;
    readonly start: number;
    readonly end: number | undefined;
    readonly partIndex: number;
}

export type AudiobookErrorKind =
    | "no_profile"
    | "no_playable_track"
    | "unavailable_part"
    | "network"
    | "auth"
    | "playback_failed"
    | "unavailable"
    | "server";

export type AudiobookPlaybackView =
    | { readonly phase: "idle" }
    | {
        readonly phase: "loading";
        readonly contentId: string;
        readonly title: string;
        readonly posterUrl: string | undefined;
        readonly subtitle: string | undefined;
    }
    | {
        readonly phase: "playing" | "paused";
        readonly contentId: string;
        readonly title: string;
        readonly authorLine: string | undefined;
        readonly posterUrl: string | undefined;
        readonly duration: number;
        readonly position: number;
        readonly bufferedTarget: number | undefined;
        readonly partIndex: number;
        readonly partCount: number;
        readonly chapters: readonly AudiobookChapterEntry[];
        readonly currentChapter: {
            readonly index: number;
            readonly title: string;
            readonly start: number;
            readonly end: number;
        } | undefined;
        readonly seekIntervals: { readonly backward: number; readonly forward: number };
        readonly playbackRate: number;
        readonly availableRates: readonly number[];
        readonly sleepTimer: SleepTimerSnapshot;
        readonly seeking: boolean;
        readonly buffering: boolean;
    }
    | {
        readonly phase: "error";
        readonly contentId: string;
        readonly title: string;
        readonly posterUrl: string | undefined;
        readonly kind: AudiobookErrorKind;
        readonly message: string;
        readonly retryable: boolean;
    };

interface Attempt {
    readonly request: AudiobookPlayRequest;
    readonly profileId: string;
    readonly abort: AbortController;
    removeAuthority: () => void;
    live: boolean;
    book: Audiobook | undefined;
    installationId: string | undefined;
    attemptId: string;
    sessionId: string | undefined;
    plan: PlaybackPlan | undefined;
    partIndex: number;
    partLocalSeconds: number;
    wholeBookSeconds: number;
    partStarted: boolean;
    hasPlayed: boolean;
    paused: boolean;
    buffering: boolean;
    playbackRate: number;
    seekIntervals: { readonly backward: number; readonly forward: number };
    pendingSeekTarget: number | undefined;
    queuedSeekTarget: number | undefined;
    seekSequence: number;
    sequence: number;
    inFlightProgress: Promise<void> | undefined;
    syncInFlight: Promise<void> | undefined;
    pendingSyncPosition: number | undefined;
    cancelProgressTimer: (() => void) | undefined;
    suspended: boolean;
    suspendedReady: boolean;
    finalSynced: boolean;
}

function formatUuid(bytes: Uint8Array): string {
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function appendMediaToken(published: string, token: string): string {
    const hash = published.indexOf("#");
    const head = hash === -1 ? published : published.slice(0, hash);
    const fragment = hash === -1 ? "" : published.slice(hash);
    return `${head}${head.indexOf("?") === -1 ? "?" : "&"}token=${encodeURIComponent(token)}${fragment}`;
}

function authorSummary(book: Audiobook): string | undefined {
    const authors = book.detail.authors.map(person => person.name).filter(name => name.trim() !== "");
    if (authors.length > 0) return authors.join(", ");
    const narrators = book.detail.narrators.map(person => person.name).filter(name => name.trim() !== "");
    return narrators.length > 0 ? narrators.join(", ") : undefined;
}

function mapFailure(error: unknown): { readonly kind: AudiobookErrorKind; readonly message: string; readonly retryable: boolean } {
    if (error instanceof ApiError) {
        if (error.status === 401 || error.status === 403) {
            return { kind: "auth", message: translate("error.invalid_token"), retryable: false };
        }
        if (error.failure.kind === "timeout") {
            return { kind: "network", message: translate("player.error.serverNoResponse"), retryable: true };
        }
        if (error.failure.kind === "network") {
            return { kind: "network", message: translate("player.error.connectionLost"), retryable: true };
        }
        if (error.failure.kind === "http") {
            return { kind: "server", message: translate("errors.apple.v2.httpStatus", { status: String(error.failure.status) }), retryable: true };
        }
        return { kind: "server", message: translate("player.error.cantPlayTitle"), retryable: true };
    }
    return { kind: "playback_failed", message: translate("player.error.cantPlayTitle"), retryable: true };
}

/**
 * Native audiobook playback controller over AVPlay + Silo V3 playback sessions + whole-book `syncProgress`.
 * Shares the singleton AVPlay transport lock with video `PlaybackController` so transitions never collide.
 */
export class AudiobookController {
    private readonly deps: AudiobookPlaybackDeps;
    private readonly pending: PendingTransport;
    private readonly sleepTimer: AudiobookSleepTimer;
    private readonly listeners: ((view: AudiobookPlaybackView) => void)[] = [];
    private current: AudiobookPlaybackView = { phase: "idle" };
    private attempt: Attempt | undefined;
    private lastRequest: AudiobookPlayRequest | undefined;
    private retryPositionSeconds: number | undefined;
    private startGen = 0;
    private transport = 0;
    private activeTeardown: Promise<void> | undefined;
    private destroyed = false;

    constructor(deps: AudiobookPlaybackDeps) {
        this.deps = deps;
        this.pending = transportLock(deps.avplay);
        this.sleepTimer = new AudiobookSleepTimer(
            deps.clock,
            () => this.onSleepTimerExpired(),
            () => {
                const attempt = this.attempt;
                if (attempt?.live && attempt.partStarted) this.emitPlayback(attempt);
            },
        );
    }

    get view(): AudiobookPlaybackView {
        return this.current;
    }

    subscribe(listener: (view: AudiobookPlaybackView) => void): () => void {
        this.listeners.push(listener);
        listener(this.current);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) this.listeners.splice(index, 1);
        };
    }

    async start(request: AudiobookPlayRequest): Promise<void> {
        if (this.destroyed) return;
        const generation = ++this.startGen;
        this.lastRequest = request;
        this.retryPositionSeconds = undefined;
        const profile = this.deps.session.activeProfile;
        if (profile === undefined) {
            await this.teardownActive(false, false);
            if (generation !== this.startGen || this.destroyed) return;
            this.emit({
                phase: "error",
                contentId: request.contentId,
                title: request.title ?? "",
                posterUrl: request.posterUrl,
                kind: "no_profile",
                message: translate("player.error.selectProfile"),
                retryable: false,
            });
            return;
        }

        const sameRestart = request.restart === true && this.attempt?.book?.id === request.contentId;
        const teardown = this.teardownActive(true, !sameRestart);
        this.emit({
            phase: "loading",
            contentId: request.contentId,
            title: request.title ?? "",
            posterUrl: request.posterUrl,
            subtitle: translate("audiobook.player.starting"),
        });
        await teardown;
        if (generation !== this.startGen || this.destroyed) return;

        const currentProfile = this.deps.session.activeProfile;
        if (currentProfile === undefined || currentProfile.id !== profile.id || this.deps.session.authoritySignal.aborted) {
            this.emit({ phase: "idle" });
            return;
        }

        const attempt = this.createAttempt(request, currentProfile.id);
        this.attempt = attempt;
        await this.bootstrapAttempt(attempt, generation);
    }

    play(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || !attempt.partStarted) return;
        if (!attempt.paused) return;
        attempt.paused = false;
        try {
            const state = this.deps.avplay.getState();
            if (state === "READY" || state === "PAUSED") {
                this.deps.avplay.play();
                this.applySpeedSafe(attempt);
            }
        } catch {
            this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
            return;
        }
        this.emitPlayback(attempt);
        this.syncDualSinkNow(attempt);
    }

    pause(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || !attempt.partStarted) return;
        if (attempt.paused) return;
        attempt.paused = true;
        try {
            if (this.deps.avplay.getState() === "PLAYING") {
                this.deps.avplay.pause();
            }
        } catch {
            // AVPlay in READY stays paused until play() is called.
        }
        this.emitPlayback(attempt);
        this.syncDualSinkNow(attempt);
    }

    togglePlayPause(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || !attempt.partStarted) return;
        if (attempt.paused) this.play();
        else this.pause();
    }

    seekTo(wholeBookSeconds: number): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.book === undefined || !attempt.partStarted) return;
        const clamped = relativeSeekTarget(0, wholeBookSeconds, attempt.book.duration);
        attempt.pendingSeekTarget = clamped;
        attempt.seekSequence += 1;
        this.dispatchSeek(attempt, clamped, attempt.seekSequence);
    }

    skipBy(deltaSeconds: number): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.book === undefined || !attempt.partStarted) return;
        const base = attempt.pendingSeekTarget ?? attempt.wholeBookSeconds;
        const target = relativeSeekTarget(base, deltaSeconds, attempt.book.duration);
        attempt.pendingSeekTarget = target;
        attempt.seekSequence += 1;
        this.dispatchSeek(attempt, target, attempt.seekSequence);
    }

    skip(direction: "backward" | "forward"): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live) return;
        const delta = direction === "backward" ? -attempt.seekIntervals.backward : attempt.seekIntervals.forward;
        this.skipBy(delta);
    }

    previousChapter(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.book === undefined || !attempt.partStarted) return;
        const chapters = attempt.book.chapters;
        if (chapters.length === 0) return;
        const position = attempt.pendingSeekTarget ?? attempt.wholeBookSeconds;
        const current = chapterAt(chapters, position, attempt.book.duration);
        if (current === undefined) return;
        if (current.index === 0 || position - current.start > PREVIOUS_CHAPTER_RESTART_SECONDS) {
            this.seekTo(current.start);
            return;
        }
        const previous = chapters[current.index - 1];
        if (previous !== undefined) this.seekTo(previous.start);
    }

    nextChapter(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.book === undefined || !attempt.partStarted) return;
        const chapters = attempt.book.chapters;
        if (chapters.length === 0) return;
        const position = attempt.pendingSeekTarget ?? attempt.wholeBookSeconds;
        const current = chapterAt(chapters, position, attempt.book.duration);
        if (current === undefined) return;
        const next = chapters[current.index + 1];
        if (next !== undefined) this.seekTo(next.start);
    }

    selectChapter(index: number): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.book === undefined || !attempt.partStarted) return;
        const chapter = attempt.book.chapters[index];
        if (chapter !== undefined) this.seekTo(chapter.start);
    }

    setPlaybackRate(rate: number): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.plan === undefined) return;
        const allowed = audiobookAvailableRates(this.deps.avplay.setSpeed !== undefined, attempt.plan.streamProtocol);
        if (!allowed.includes(rate)) return;
        attempt.playbackRate = rate;
        if (attempt.partStarted && !attempt.paused) {
            this.applySpeedSafe(attempt);
        }
        this.emitPlayback(attempt);
    }

    setSleepTimer(minutes: number): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || !attempt.partStarted) return;
        this.sleepTimer.start(minutes);
    }

    async refreshSeekIntervals(): Promise<void> {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live) return;
        const loaded = await this.readSeekIntervals(attempt);
        if (attempt.live && this.attempt === attempt) {
            attempt.seekIntervals = loaded;
            if (attempt.partStarted) this.emitPlayback(attempt);
        }
    }

    suspend(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.suspended) return;
        attempt.cancelProgressTimer?.();
        attempt.cancelProgressTimer = undefined;
        try {
            const state = this.deps.avplay.getState();
            if (state === "PLAYING" || state === "PAUSED" || state === "READY") {
                this.deps.avplay.suspend?.();
                attempt.suspended = state === "PLAYING" || state === "PAUSED";
                attempt.suspendedReady = state === "READY";
            }
        } catch {
            attempt.suspended = false;
            attempt.suspendedReady = false;
        }
    }

    async restore(): Promise<void> {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.abort.signal.aborted) return;
        if (!attempt.suspended && !attempt.suspendedReady) return;
        const generation = this.startGen;
        const wasSuspendedReady = attempt.suspendedReady;
        attempt.suspended = false;
        attempt.suspendedReady = false;
        const plan = attempt.plan;
        if (plan === undefined) return;
        try {
            const url = await this.resolveStreamUrl(attempt, plan);
            if (!attempt.live || this.attempt !== attempt || attempt.abort.signal.aborted || generation !== this.startGen) return;
            if (url === undefined) {
                this.failAttempt(attempt, "server", translate("player.error.cantPlayTitle"), true);
                return;
            }

            const resumeMs = Math.max(0, Math.round((attempt.partLocalSeconds - plan.timeline.timelineOffsetSeconds) * 1000));
            const restore = this.deps.avplay.restoreAsync;
            if (!wasSuspendedReady && restore !== undefined) {
                const transport = this.transport;
                const restored = await new Promise<boolean>((resolve) => {
                    try {
                        restore.call(this.deps.avplay, url, resumeMs, false, () => resolve(transport === this.transport && attempt.live), () => resolve(false));
                    } catch {
                        resolve(false);
                    }
                });
                if (!attempt.live || this.attempt !== attempt || attempt.abort.signal.aborted || generation !== this.startGen) return;
                if (restored) {
                    try {
                        if (attempt.paused) {
                            if (this.deps.avplay.getState() === "PLAYING") this.deps.avplay.pause();
                        } else {
                            const state = this.deps.avplay.getState();
                            if (state === "PAUSED" || state === "READY") this.deps.avplay.play();
                            this.applySpeedSafe(attempt);
                        }
                    } catch {
                        this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
                        return;
                    }
                    this.emitPlayback(attempt);
                    this.scheduleProgress(attempt);
                    return;
                }
            }
            // Fallback: retire the prior server session and reopen with a fresh playback attempt ID.
            const oldSessionId = attempt.sessionId;
            const installationId = attempt.installationId;
            attempt.sessionId = undefined;
            if (oldSessionId !== undefined && installationId !== undefined) {
                await this.stopServerSession(attempt, oldSessionId, installationId, attempt.partLocalSeconds, attempt.paused);
                if (!attempt.live || this.attempt !== attempt || attempt.abort.signal.aborted || generation !== this.startGen) return;
            }
            attempt.attemptId = this.newId();
            await this.openPart(attempt, attempt.partIndex, attempt.partLocalSeconds, generation);
        } catch (error) {
            this.failFromError(attempt, generation, error);
        }
    }

    retry(): void {
        if (this.destroyed || this.lastRequest === undefined) return;
        const savedPos = this.retryPositionSeconds;
        this.retryPositionSeconds = undefined;
        const req: AudiobookPlayRequest = savedPos !== undefined && savedPos > 0
            ? { ...this.lastRequest, startSeconds: savedPos, restart: false }
            : this.lastRequest;
        void this.start(req);
    }

    async stop(): Promise<void> {
        if (this.destroyed) return;
        const generation = ++this.startGen;
        this.retryPositionSeconds = undefined;
        await this.teardownActive(true, true);
        if (this.destroyed || generation !== this.startGen) return;
        if (this.current.phase !== "idle") {
            this.emit({ phase: "idle" });
        }
        this.deps.exits?.onClose?.();
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.startGen++;
        this.retryPositionSeconds = undefined;
        void this.teardownActive(true, true);
        this.sleepTimer.cancel();
        this.current = { phase: "idle" };
        this.listeners.length = 0;
    }

    // --- internal lifecycle ---

    private newId(): string {
        const bytes = new Uint8Array(16);
        this.deps.randomBytes(bytes);
        return formatUuid(bytes);
    }

    private createAttempt(request: AudiobookPlayRequest, profileId: string): Attempt {
        const abort = new AbortController();
        const attempt: Attempt = {
            request,
            profileId,
            abort,
            removeAuthority: () => undefined,
            live: true,
            book: undefined,
            installationId: undefined,
            attemptId: this.newId(),
            sessionId: undefined,
            plan: undefined,
            partIndex: 0,
            partLocalSeconds: 0,
            wholeBookSeconds: request.startSeconds ?? 0,
            partStarted: false,
            hasPlayed: false,
            paused: false,
            buffering: false,
            playbackRate: 1,
            seekIntervals: DEFAULT_SEEK_INTERVALS,
            pendingSeekTarget: undefined,
            queuedSeekTarget: undefined,
            seekSequence: 0,
            sequence: 0,
            inFlightProgress: undefined,
            syncInFlight: undefined,
            pendingSyncPosition: undefined,
            cancelProgressTimer: undefined,
            suspended: false,
            suspendedReady: false,
            finalSynced: false,
        };
        const onAuthorityLost = (): void => { this.abortForAuthorityLoss(attempt); };
        this.deps.session.authoritySignal.addEventListener("abort", onAuthorityLost, { once: true });
        attempt.removeAuthority = () => this.deps.session.authoritySignal.removeEventListener("abort", onAuthorityLost);
        return attempt;
    }

    private abortForAuthorityLoss(attempt: Attempt): void {
        if (!attempt.live) return;
        attempt.live = false;
        attempt.finalSynced = true;
        this.retryPositionSeconds = undefined;
        attempt.cancelProgressTimer?.();
        attempt.cancelProgressTimer = undefined;
        attempt.abort.abort();
        attempt.removeAuthority();
        this.sleepTimer.cancel();
        this.closeTransport();
        if (this.attempt === attempt) {
            this.attempt = undefined;
            if (!this.destroyed) this.emit({ phase: "idle" });
        }
    }

    private async teardownActive(stopSession: boolean, syncBook: boolean): Promise<void> {
        const prior = this.activeTeardown;
        const attempt = this.attempt;
        if (attempt === undefined) {
            if (prior !== undefined) await prior;
            return;
        }
        this.attempt = undefined;
        let work!: Promise<void>;
        work = (async (): Promise<void> => {
            if (prior !== undefined) await prior;
            await this.retireAttempt(attempt, stopSession && !attempt.abort.signal.aborted, syncBook && !attempt.abort.signal.aborted);
        })();
        this.activeTeardown = work;
        try {
            await work;
        } finally {
            if (this.activeTeardown === work) this.activeTeardown = undefined;
        }
    }

    private async retireAttempt(attempt: Attempt, stopSession: boolean, sendBookSync: boolean): Promise<void> {
        if (!attempt.live) return;
        attempt.live = false;
        attempt.cancelProgressTimer?.();
        attempt.cancelProgressTimer = undefined;
        this.sleepTimer.cancel();
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        const book = attempt.book;
        const finalWholeSeconds = attempt.wholeBookSeconds;
        const finalLocalSeconds = attempt.partLocalSeconds;
        const wasPaused = attempt.paused;
        const authorityOk = !attempt.abort.signal.aborted && !this.deps.session.authoritySignal.aborted;
        const canSyncBook = sendBookSync && attempt.hasPlayed && book !== undefined && !attempt.finalSynced && authorityOk;
        const canStopSession = stopSession && sessionId !== undefined && installationId !== undefined && authorityOk;
        if (canSyncBook) attempt.finalSynced = true;
        this.closeTransport();

        if (!canSyncBook && !canStopSession) {
            attempt.abort.abort();
            attempt.removeAuthority();
            return;
        }
        const tasks: Promise<void>[] = [];
        if (canSyncBook && book !== undefined) {
            tasks.push(this.queueBookSync(attempt, finalWholeSeconds));
        }
        if (canStopSession && sessionId !== undefined && installationId !== undefined) {
            tasks.push(this.stopServerSession(attempt, sessionId, installationId, finalLocalSeconds, wasPaused));
        }
        await Promise.all(tasks);
        attempt.abort.abort();
        attempt.removeAuthority();
    }

    private failFromError(attempt: Attempt, generation: number, error: unknown): void {
        if (!attempt.live || generation !== this.startGen || (error instanceof ApiError && error.aborted)) return;
        const mapped = mapFailure(error);
        this.failAttempt(attempt, mapped.kind, mapped.message, mapped.retryable);
    }

    private async bootstrapAttempt(attempt: Attempt, generation: number): Promise<void> {
        const call = <T>(spec: RequestSpec<T>): Promise<T> =>
            this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.abort.signal });
        try {
            const book = await call(audiobookOperations.getAudiobook(attempt.request.contentId));
            if (!attempt.live || generation !== this.startGen) return;
            attempt.book = book;
            if (book.parts.length === 0) {
                this.failAttempt(attempt, "no_playable_track", translate("audiobook.error.noPlayableTrack"), false);
                return;
            }
            const [caps, intervals] = await Promise.all([
                call(operations.playbackCapabilities()),
                this.readSeekIntervals(attempt),
            ]);
            if (!attempt.live || generation !== this.startGen) return;
            attempt.seekIntervals = intervals;
            if (caps.state !== "available" || !caps.allowed || !caps.protocolVersions.includes(3) || caps.installationId === undefined) {
                this.failAttempt(attempt, "unavailable", translate("error.capability_unsupported"), true);
                return;
            }
            attempt.installationId = caps.installationId;

            const startWhole = attempt.request.startSeconds !== undefined
                ? relativeSeekTarget(0, attempt.request.startSeconds, book.duration)
                : playerStartPosition(book.played, book.position, book.duration, attempt.request.restart === true);
            const dest = bookPosition(book, startWhole);
            attempt.wholeBookSeconds = dest.part.offset + dest.localSeconds;
            await this.openPart(attempt, dest.partIndex, dest.localSeconds, generation);
        } catch (error) {
            this.failFromError(attempt, generation, error);
        }
    }

    private async readSeekIntervals(attempt: Attempt): Promise<{ readonly backward: number; readonly forward: number }> {
        const call = <T>(spec: RequestSpec<T>): Promise<T> =>
            this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.abort.signal });
        try {
            const capability = await call(operations.settingsCapabilities());
            if (!attempt.live || capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed || !capability.scopes.includes("profile") || capability.manifestRevision < 9) {
                return DEFAULT_SEEK_INTERVALS;
            }
            const contract = await call(operations.settingsContract());
            if (!attempt.live || contract.apiVersion !== 1 || contract.revision < capability.manifestRevision) {
                return DEFAULT_SEEK_INTERVALS;
            }
            const definitions = profileSettings(contract, capability);
            if (!AUDIOBOOK_SEEK_KEYS.every(key => definitions.some(def => def.key === key))) {
                return DEFAULT_SEEK_INTERVALS;
            }
            const batches = (capability.supportsBatchedEffective ? [AUDIOBOOK_SEEK_KEYS] : AUDIOBOOK_SEEK_KEYS.map(key => [key]))
                .map(keys => call(operations.effectiveSettings(keys)));
            const maps = await Promise.all(batches);
            const merged = new Map(maps.flatMap(entry => [...entry]));
            const backward = merged.get(AUDIOBOOK_SEEK_BACK_KEY)?.value;
            const forward = merged.get(AUDIOBOOK_SEEK_FORWARD_KEY)?.value;
            if (typeof backward === "number" && typeof forward === "number") {
                return { backward, forward };
            }
        } catch {
            // Skip intervals remain selectable even when settings cannot be read; fall back to contract defaults.
        }
        return DEFAULT_SEEK_INTERVALS;
    }

    private async openPart(attempt: Attempt, partIndex: number, localSeconds: number, generation: number): Promise<void> {
        const book = attempt.book;
        const installationId = attempt.installationId;
        if (book === undefined || installationId === undefined) return;
        const part = book.parts[partIndex];
        if (part === undefined) {
            this.failAttempt(attempt, "unavailable_part", translate("audiobook.error.unavailablePart"), false);
            return;
        }
        attempt.partStarted = false;
        attempt.partIndex = partIndex;
        attempt.partLocalSeconds = localSeconds;
        attempt.wholeBookSeconds = part.offset + localSeconds;
        attempt.sequence = 0;

        try {
            const spec = operations.startPlayback({
                installation_id: installationId,
                protocol_version: 3,
                client_features: AUDIOBOOK_CLIENT_FEATURES,
                file_id: part.fileId,
                profile_id: attempt.profileId,
                playback_attempt_id: attempt.attemptId,
                quality_preference: "auto",
                subtitle_fidelity_preference: "preserve",
                progress_persistence: "client",
                start_position: localSeconds,
                allow_alternate_versions: false,
                client_capabilities: AUDIOBOOK_CAPABILITIES,
                client_playback_context: audiobookPlaybackContext(this.deps.device.model, this.deps.device.appVersion),
            });
            const decision = await this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.abort.signal });
            if (!attempt.live || generation !== this.startGen) return;
            if (decision.outcome === "adaptation_unavailable") {
                this.failAttempt(attempt, "unavailable", decision.terminal.message || translate("error.capability_unsupported"), decision.terminal.retryable);
                return;
            }
            if (decision.outcome !== "playable") {
                this.failAttempt(attempt, "unavailable_part", translate("audiobook.error.unavailablePart"), true);
                return;
            }
            const matchedIndex = book.parts.findIndex(candidate => candidate.fileId === decision.plan.effectiveMediaFileId);
            if (matchedIndex === -1) {
                void this.stopOrphanedSession(decision.sessionId, installationId, attempt.sequence, localSeconds, attempt.paused);
                this.failAttempt(attempt, "unavailable_part", translate("audiobook.error.unavailablePart"), false);
                return;
            }
            attempt.partIndex = matchedIndex;
            attempt.sessionId = decision.sessionId;
            attempt.plan = decision.plan;

            const url = await this.resolveStreamUrl(attempt, decision.plan);
            if (!attempt.live || generation !== this.startGen) return;
            if (url === undefined) {
                this.failAttempt(attempt, "server", translate("player.error.cantPlayTitle"), true);
                return;
            }
            if (await this.playlistUnreadable(attempt, decision.plan, url)) {
                if (attempt.live && generation === this.startGen) {
                    this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
                }
                return;
            }
            if (!attempt.live || generation !== this.startGen) return;
            await this.openAVPlay(attempt, decision.plan, url, generation);
        } catch (error) {
            this.failFromError(attempt, generation, error);
        }
    }

    private async resolveStreamUrl(attempt: Attempt, plan: PlaybackPlan): Promise<string | undefined> {
        const base = this.deps.session.http.base;
        const published = plan.streamUrl.charAt(0) === "/" ? base.baseUrl + plan.streamUrl : plan.streamUrl;
        let media: URL;
        try {
            media = new URL(published);
            if (!isPermittedUrl(media, base.baseUrl)) return undefined;
        } catch {
            return undefined;
        }
        if (media.origin !== base.origin) return published;
        const token = await this.deps.session.mediaToken(attempt.abort.signal);
        return appendMediaToken(published, token);
    }

    private async playlistUnreadable(attempt: Attempt, plan: PlaybackPlan, url: string): Promise<boolean> {
        if (plan.delivery !== "server_remux_hls" && plan.delivery !== "server_transcode_hls" && plan.streamProtocol !== "hls") {
            return false;
        }
        try {
            const heads = await this.deps.session.http.playlistHeads(url, attempt.abort.signal);
            return heads.some(head => /#EXT-X-DEFINE|\{\$/.test(head));
        } catch {
            return false;
        }
    }

    private async openAVPlay(attempt: Attempt, plan: PlaybackPlan, url: string, generation: number): Promise<void> {
        this.closeTransport();
        const transport = this.transport;
        await this.waitTransport();
        if (transport !== this.transport || !attempt.live || generation !== this.startGen) return;

        const avplay = this.deps.avplay;
        try {
            avplay.open(url);
            avplay.setListener(this.createListener(attempt, plan, transport));
            avplay.prepareAsync(
                () => this.onPrepared(attempt, plan, transport, generation),
                () => {
                    if (transport === this.transport && attempt.live && generation === this.startGen) {
                        this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
                    }
                },
            );
        } catch {
            this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
        }
    }

    private onPrepared(attempt: Attempt, plan: PlaybackPlan, transport: number, generation: number): void {
        if (transport !== this.transport || !attempt.live || generation !== this.startGen) return;
        const finishStart = (): void => {
            if (transport !== this.transport || !attempt.live || generation !== this.startGen) return;
            try {
                if (!attempt.paused) {
                    this.deps.avplay.play();
                    this.applySpeedSafe(attempt);
                }
            } catch {
                this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
                return;
            }
            const book = attempt.book;
            const part = book?.parts[attempt.partIndex];
            if (part !== undefined) {
                attempt.partLocalSeconds = Math.max(0, plan.timeline.timelineOffsetSeconds + plan.timeline.playerStartSeconds);
                attempt.wholeBookSeconds = part.offset + attempt.partLocalSeconds;
            }
            attempt.partStarted = true;
            attempt.hasPlayed = true;
            attempt.buffering = false;
            this.scheduleProgress(attempt);
            this.emitPlayback(attempt);
            if (attempt.paused) this.syncDualSinkNow(attempt);
            if (attempt.queuedSeekTarget !== undefined) {
                const queued = attempt.queuedSeekTarget;
                attempt.queuedSeekTarget = undefined;
                this.dispatchSeek(attempt, queued, attempt.seekSequence);
            }
        };

        const startMs = Math.round(plan.timeline.playerStartSeconds * 1000);
        if (startMs <= 0) {
            finishStart();
            return;
        }
        this.runSeek(startMs, finishStart, () => {
            if (transport === this.transport && attempt.live && generation === this.startGen) {
                this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
            }
        });
    }

    private createListener(attempt: Attempt, plan: PlaybackPlan, transport: number): AVPlayListener {
        const current = (): boolean => transport === this.transport && attempt.live;
        return {
            onbufferingstart: () => {
                if (current() && attempt.partStarted) {
                    attempt.buffering = true;
                    this.emitPlayback(attempt);
                }
            },
            onbufferingprogress: () => undefined,
            onbufferingcomplete: () => {
                if (current() && attempt.partStarted) {
                    attempt.buffering = false;
                    this.emitPlayback(attempt);
                }
            },
            oncurrentplaytime: (milliseconds) => {
                if (!current() || !attempt.partStarted || attempt.book === undefined) return;
                const local = Math.max(0, milliseconds / 1000 + plan.timeline.timelineOffsetSeconds);
                const part = attempt.book.parts[attempt.partIndex];
                if (part === undefined) return;
                attempt.partLocalSeconds = local;
                attempt.wholeBookSeconds = part.offset + local;
                this.emitPlayback(attempt);
            },
            onstreamcompleted: () => {
                if (current() && attempt.partStarted) {
                    void this.handlePartCompleted(attempt);
                }
            },
            onevent: () => undefined,
            onerror: () => {
                if (current() && attempt.partStarted) {
                    this.failAttempt(attempt, "playback_failed", translate("player.error.cantPlayTitle"), true);
                }
            },
        };
    }

    private dispatchSeek(attempt: Attempt, targetWholeSeconds: number, seq: number): void {
        if (attempt.book === undefined) return;
        if (this.pending.seek !== undefined || !attempt.partStarted) {
            attempt.queuedSeekTarget = targetWholeSeconds;
            this.emitPlayback(attempt);
            return;
        }
        const dest = bookPosition(attempt.book, targetWholeSeconds);
        const plan = attempt.plan;
        const samePart = dest.partIndex === attempt.partIndex && plan !== undefined
            && (plan.timeline.canSeekAnywhere || dest.localSeconds >= plan.timeline.timelineOffsetSeconds);
        if (samePart && plan !== undefined) {
            const streamMs = Math.max(0, Math.round((dest.localSeconds - plan.timeline.timelineOffsetSeconds) * 1000));
            const transport = this.transport;
            this.emitPlayback(attempt);
            this.runSeek(
                streamMs,
                () => {
                    if (transport !== this.transport || !attempt.live) return;
                    if (attempt.queuedSeekTarget !== undefined && attempt.seekSequence !== seq) {
                        const queued = attempt.queuedSeekTarget;
                        attempt.queuedSeekTarget = undefined;
                        this.dispatchSeek(attempt, queued, attempt.seekSequence);
                        return;
                    }
                    attempt.partLocalSeconds = dest.localSeconds;
                    attempt.wholeBookSeconds = dest.part.offset + dest.localSeconds;
                    if (attempt.seekSequence === seq) attempt.pendingSeekTarget = undefined;
                    this.emitPlayback(attempt);
                    this.syncDualSinkNow(attempt);
                },
                () => {
                    if (transport !== this.transport || !attempt.live) return;
                    if (attempt.queuedSeekTarget !== undefined) {
                        const queued = attempt.queuedSeekTarget;
                        attempt.queuedSeekTarget = undefined;
                        this.dispatchSeek(attempt, queued, attempt.seekSequence);
                        return;
                    }
                    attempt.pendingSeekTarget = undefined;
                    this.emitPlayback(attempt);
                },
            );
            return;
        }
        attempt.queuedSeekTarget = undefined;
        attempt.pendingSeekTarget = undefined;
        void this.switchPart(attempt, dest.partIndex, dest.localSeconds, seq);
    }

    private async switchPart(attempt: Attempt, partIndex: number, localSeconds: number, seq: number): Promise<void> {
        const book = attempt.book;
        const oldSessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (book === undefined || installationId === undefined) return;
        const generation = this.startGen;

        attempt.partStarted = false;
        attempt.cancelProgressTimer?.();
        attempt.cancelProgressTimer = undefined;
        this.closeTransport();
        try {
            if (oldSessionId !== undefined) {
                await this.stopServerSession(attempt, oldSessionId, installationId, attempt.partLocalSeconds, attempt.paused);
                if (!attempt.live || this.attempt !== attempt || generation !== this.startGen) return;
            }
            attempt.sessionId = undefined;
            attempt.attemptId = this.newId();
            await this.openPart(attempt, partIndex, localSeconds, generation);
            if (attempt.live && this.attempt === attempt && attempt.partStarted && attempt.seekSequence === seq) {
                this.syncDualSinkNow(attempt);
            }
        } catch (error) {
            this.failFromError(attempt, generation, error);
        }
    }

    private async handlePartCompleted(attempt: Attempt): Promise<void> {
        const book = attempt.book;
        if (book === undefined || !attempt.live) return;
        const nextPartIndex = attempt.partIndex + 1;
        if (nextPartIndex < book.parts.length) {
            attempt.paused = false;
            const nextPart = book.parts[nextPartIndex];
            if (nextPart === undefined) return;
            attempt.wholeBookSeconds = nextPart.offset;
            attempt.pendingSeekTarget = undefined;
            attempt.queuedSeekTarget = undefined;
            await this.switchPart(attempt, nextPartIndex, 0, ++attempt.seekSequence);
            if (attempt.live && this.attempt === attempt && attempt.partStarted) {
                void this.queueBookSync(attempt, attempt.wholeBookSeconds);
            }
            return;
        }

        // Final part ended naturally: persist finished whole-book position and stop session.
        const generation = this.startGen;
        this.retryPositionSeconds = undefined;
        attempt.live = false;
        attempt.finalSynced = true;
        attempt.cancelProgressTimer?.();
        attempt.cancelProgressTimer = undefined;
        this.sleepTimer.cancel();
        this.attempt = undefined;
        const finishedPosition = book.duration > 0 ? book.duration : attempt.wholeBookSeconds;
        const currentPart = book.parts[attempt.partIndex];
        const finalLocal = currentPart !== undefined && currentPart.duration > 0 ? currentPart.duration : attempt.partLocalSeconds;
        this.closeTransport();

        if (!attempt.abort.signal.aborted && !this.deps.session.authoritySignal.aborted) {
            const tasks: Promise<void>[] = [this.queueBookSync(attempt, finishedPosition)];
            if (attempt.sessionId !== undefined && attempt.installationId !== undefined) {
                tasks.push(this.stopServerSession(attempt, attempt.sessionId, attempt.installationId, finalLocal, false));
            }
            await Promise.all(tasks);
        }
        attempt.abort.abort();
        attempt.removeAuthority();
        if (!this.destroyed && generation === this.startGen) {
            this.emit({ phase: "idle" });
            this.deps.exits?.onFinished?.();
        }
    }

    private onSleepTimerExpired(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live) return;
        if (!attempt.paused) {
            attempt.paused = true;
            if (attempt.partStarted) {
                try {
                    if (this.deps.avplay.getState() === "PLAYING") this.deps.avplay.pause();
                } catch {
                    // Keep logically paused if platform already transitioned.
                }
                this.syncDualSinkNow(attempt);
            }
        }
        if (attempt.partStarted) {
            this.emitPlayback(attempt);
        }
    }

    private applySpeedSafe(attempt: Attempt): void {
        const plan = attempt.plan;
        if (plan === undefined) return;
        const supported = audiobookAvailableRates(this.deps.avplay.setSpeed !== undefined, plan.streamProtocol);
        if (!supported.includes(attempt.playbackRate)) {
            attempt.playbackRate = 1;
            return;
        }
        if (attempt.playbackRate === 1 && this.deps.avplay.setSpeed === undefined) return;
        try {
            this.deps.avplay.setSpeed?.(attempt.playbackRate);
        } catch {
            attempt.playbackRate = 1;
        }
    }

    private closeTransport(): void {
        this.transport++;
        const seek = this.pending.seek;
        if (seek !== undefined) {
            const closing = seek.then(() => this.closeAVPlay());
            this.pending.closing = closing;
            void closing.then(() => {
                if (this.pending.closing === closing) this.pending.closing = undefined;
            });
        } else {
            this.closeAVPlay();
        }
    }

    private closeAVPlay(): void {
        try {
            this.deps.avplay.close();
        } catch {
            // Already closed or settled; platform state cannot be recovered here.
        }
    }

    private async waitTransport(): Promise<void> {
        while (this.pending.closing !== undefined || this.pending.seek !== undefined) {
            await (this.pending.closing ?? this.pending.seek);
        }
    }

    private runSeek(milliseconds: number, onSuccess: () => void, onError: () => void): void {
        let release: () => void = () => undefined;
        const seek = new Promise<void>(resolve => { release = resolve; });
        this.pending.seek = seek;
        const settle = (cb: () => void): void => {
            if (this.pending.seek === seek) this.pending.seek = undefined;
            release();
            cb();
        };
        try {
            this.deps.avplay.seekTo(milliseconds, () => settle(onSuccess), () => settle(onError));
        } catch {
            settle(onError);
        }
    }

    private scheduleProgress(attempt: Attempt): void {
        attempt.cancelProgressTimer?.();
        attempt.cancelProgressTimer = this.deps.clock.schedule(() => {
            attempt.cancelProgressTimer = undefined;
            if (!attempt.live || !attempt.partStarted || attempt.suspended) return;
            this.syncDualSinkNow(attempt);
            this.scheduleProgress(attempt);
        }, PROGRESS_INTERVAL_MS);
    }

    private syncDualSinkNow(attempt: Attempt): void {
        if (!attempt.live || attempt.book === undefined || attempt.abort.signal.aborted || this.deps.session.authoritySignal.aborted) {
            return;
        }
        this.sendSessionProgress(attempt);
        void this.queueBookSync(attempt, attempt.wholeBookSeconds);
    }

    private sendSessionProgress(attempt: Attempt): void {
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined || attempt.inFlightProgress !== undefined) return;
        const spec = operations.updatePlaybackProgress(sessionId, {
            installation_id: installationId,
            sequence: ++attempt.sequence,
            position: attempt.partLocalSeconds,
            is_paused: attempt.paused,
        });
        attempt.inFlightProgress = this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.abort.signal }).then(
            () => { if (attempt.sessionId === sessionId) attempt.inFlightProgress = undefined; },
            () => { if (attempt.sessionId === sessionId) attempt.inFlightProgress = undefined; },
        );
    }

    private queueBookSync(attempt: Attempt, wholeBookSeconds: number): Promise<void> {
        const book = attempt.book;
        if (book === undefined || attempt.abort.signal.aborted || this.deps.session.authoritySignal.aborted) {
            return Promise.resolve();
        }
        attempt.pendingSyncPosition = wholeBookSeconds;
        if (attempt.syncInFlight !== undefined) return attempt.syncInFlight;
        let work!: Promise<void>;
        work = (async (): Promise<void> => {
            try {
                while (attempt.pendingSyncPosition !== undefined) {
                    if (attempt.abort.signal.aborted || this.deps.session.authoritySignal.aborted) {
                        attempt.pendingSyncPosition = undefined;
                        return;
                    }
                    const nextPosition = attempt.pendingSyncPosition;
                    attempt.pendingSyncPosition = undefined;
                    await this.sendBookSyncSnapshot(book, nextPosition, attempt.abort.signal);
                }
            } finally {
                if (attempt.syncInFlight === work) attempt.syncInFlight = undefined;
            }
        })();
        attempt.syncInFlight = work;
        return work;
    }

    private async sendBookSyncSnapshot(book: Audiobook, wholeBookSeconds: number, signal: AbortSignal): Promise<void> {
        if (signal.aborted || this.deps.session.authoritySignal.aborted) return;
        const clamped = book.duration > 0 ? Math.min(Math.max(0, wholeBookSeconds), book.duration) : Math.max(0, wholeBookSeconds);
        const spec = audiobookOperations.syncProgress([{
            mediaItemId: book.id,
            positionSeconds: clamped,
            durationSeconds: book.duration,
        }]);
        try {
            await this.deps.session.call({ ...spec, profileScoped: true, replayAfterRefresh: false, signal });
        } catch {
            // syncProgress uses non_retryable / replayAfterRefresh=false; failed writes never block or resend.
        }
    }

    private async stopServerSession(attempt: Attempt, sessionId: string, installationId: string, positionSeconds: number, isPaused: boolean): Promise<void> {
        try {
            await attempt.inFlightProgress;
            if (attempt.abort.signal.aborted || this.deps.session.authoritySignal.aborted) return;
            const spec = operations.stopPlayback(sessionId, {
                installation_id: installationId,
                stop_id: this.newId(),
                sequence: ++attempt.sequence,
                position: Math.max(0, positionSeconds),
                is_paused: isPaused,
            });
            await this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.abort.signal });
        } catch (error) {
            if (error instanceof ApiError && (error.status === 404 || error.status === 410 || error.aborted)) return;
            try { await sleep(this.deps.clock, 0, attempt.abort.signal, abortedError); } catch { /* ignore */ }
        }
    }

    private async stopOrphanedSession(sessionId: string, installationId: string, sequence: number, positionSeconds: number, isPaused: boolean): Promise<void> {
        const signal = this.deps.session.authoritySignal;
        if (signal.aborted) return;
        try {
            const spec = operations.stopPlayback(sessionId, {
                installation_id: installationId,
                stop_id: this.newId(),
                sequence: sequence + 1,
                position: Math.max(0, positionSeconds),
                is_paused: isPaused,
            });
            await this.deps.session.call({ ...spec, profileScoped: true, signal });
        } catch {
            // Best-effort server cleanup for rejected plans.
        }
    }

    private failAttempt(attempt: Attempt, kind: AudiobookErrorKind, message: string, retryable: boolean): void {
        if (!attempt.live) return;
        attempt.live = false;
        attempt.cancelProgressTimer?.();
        attempt.cancelProgressTimer = undefined;
        this.sleepTimer.cancel();
        if (attempt.hasPlayed && attempt.wholeBookSeconds > 0) {
            this.retryPositionSeconds = attempt.wholeBookSeconds;
        }
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        const sequence = attempt.sequence;
        const localSeconds = attempt.partLocalSeconds;
        const wasPaused = attempt.paused;
        attempt.sessionId = undefined;
        if (sessionId !== undefined && installationId !== undefined && !attempt.abort.signal.aborted && !this.deps.session.authoritySignal.aborted) {
            void this.stopOrphanedSession(sessionId, installationId, sequence, localSeconds, wasPaused);
        }
        this.closeTransport();
        attempt.abort.abort();
        attempt.removeAuthority();
        if (this.attempt === attempt) this.attempt = undefined;
        this.emit({
            phase: "error",
            contentId: attempt.book?.id ?? attempt.request.contentId,
            title: attempt.book?.title ?? attempt.request.title ?? "",
            posterUrl: attempt.book?.posterUrl ?? attempt.request.posterUrl,
            kind,
            message,
            retryable,
        });
    }

    private emitPlayback(attempt: Attempt): void {
        const book = attempt.book;
        const plan = attempt.plan;
        if (book === undefined || plan === undefined) return;
        const activePosition = attempt.pendingSeekTarget ?? attempt.wholeBookSeconds;
        const chapterInfo = chapterAt(book.chapters, activePosition, book.duration);
        const mappedChapters: readonly AudiobookChapterEntry[] = book.chapters.map((chapter: AudiobookChapter, index) => ({
            index,
            title: chapter.title,
            start: chapter.start,
            end: chapter.end,
            partIndex: chapter.partIndex,
        }));
        const availableRates = audiobookAvailableRates(this.deps.avplay.setSpeed !== undefined, plan.streamProtocol);
        const effectiveRate = availableRates.includes(attempt.playbackRate) ? attempt.playbackRate : 1;
        this.emit({
            phase: attempt.paused ? "paused" : "playing",
            contentId: book.id,
            title: book.title,
            authorLine: authorSummary(book),
            posterUrl: book.posterUrl,
            duration: book.duration,
            position: attempt.wholeBookSeconds,
            bufferedTarget: attempt.pendingSeekTarget,
            partIndex: attempt.partIndex,
            partCount: book.parts.length,
            chapters: mappedChapters,
            currentChapter: chapterInfo === undefined
                ? undefined
                : { index: chapterInfo.index, title: chapterInfo.chapter.title, start: chapterInfo.start, end: chapterInfo.end },
            seekIntervals: attempt.seekIntervals,
            playbackRate: effectiveRate,
            availableRates,
            sleepTimer: this.sleepTimer.snapshot(),
            seeking: attempt.pendingSeekTarget !== undefined || this.pending.seek !== undefined,
            buffering: attempt.buffering,
        });
    }

    private emit(view: AudiobookPlaybackView): void {
        this.current = view;
        for (const listener of [...this.listeners]) {
            listener(view);
        }
    }
}
