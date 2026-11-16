import type { Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { subtitleOperations as operations } from "../api/subtitleOperations.ts";
import { isIdentityTiming, jobInProgress, type SubtitleSyncJob, type SubtitleSyncState, type SubtitleTiming } from "../contracts/v2/subtitleSync.ts";
import type { NativeSession } from "../session/session.ts";

// SubtitleSyncModel and SubtitleSyncLabel (silo-apple main, SubtitleSync.swift). Words are `player.subtitleSync.*` and `player.tracks.*`.

const POLL_INTERVAL_MS = 3000;
const POLL_LIMIT_MS = 5 * 60000;

const FORBIDDEN = "This server doesn't allow changing subtitle timing.";
const FORMAT_UNSUPPORTED = "This format can't be synced.";
const SUBTITLE_CHANGED = "The subtitle changed. Try again.";
const SYNC_FAILED_RETRY = "Couldn't sync this subtitle. Try again.";
const RESET_FAILED = "Couldn't reset the timing. Try again.";
const SYNCING = "Syncing…";

/** A tie that printf's `%.1f` rounds to even and `toFixed` rounds up: a quarter second, e.g. 250 ms. */
function tenths(offsetMs: number): string {
    const magnitude = Math.abs(offsetMs);
    if (magnitude % 500 !== 250) return (magnitude / 1000).toFixed(1);
    const below = (magnitude - 50) / 100;
    return ((below % 2 === 0 ? below : below + 1) / 10).toFixed(1);
}

function offsetText(offsetMs: number): string {
    return `${offsetMs < 0 ? "−" : "+"}${tenths(offsetMs)} s`;
}

const FRAME_RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60] as const;

/** Names a scale as the frame-rate conversion it most likely is ("25→23.976 fps"), or as a plain speed factor. */
export function scaleText(scale: number): string | undefined {
    if (!Number.isFinite(scale) || scale === 1) return undefined;
    for (const from of FRAME_RATES) {
        for (const to of FRAME_RATES) if (from !== to && Math.abs(from / to - scale) <= 1e-6) return `${from}→${to} fps`;
    }
    return `×${Math.round(scale * 10000) / 10000} speed`;
}

/** "+2.3 s · 25→23.976 fps": a correction in a few characters. */
export function describeTiming(timing: SubtitleTiming): string {
    const scale = scaleText(timing.scale);
    return [timing.offsetMs !== 0 || scale === undefined ? offsetText(timing.offsetMs) : undefined, scale].filter(part => part !== undefined).join(" · ");
}

/** An active job's progress as a whole percentage, or undefined once it ended. */
export function syncPercent(job: SubtitleSyncJob): number | undefined {
    return jobInProgress(job) ? Math.round(Math.min(1, Math.max(0, job.progress ?? 0)) * 100) : undefined;
}

export function phaseText(job: SubtitleSyncJob): string | undefined {
    if (!jobInProgress(job)) return undefined;
    switch (job.phase) {
        case "matching": return "Matching lines to speech…";
        case "analyzing": return "Listening to the audio…";
        default: return "Waiting to start…";
    }
}

export function failureText(failure: string | undefined): string {
    switch (failure) {
        case "subtitle_changed": return "The subtitle changed while it was syncing. Try again.";
        case "no_audio": return "This video has no audio Silo can read.";
        case "unavailable": return "The server is busy. Try again in a few minutes.";
        default: return "Sync failed. Try again.";
    }
}

/** One short line describing a track's timing, or undefined when there is nothing to say. */
export function syncStatusLabel(timing: SubtitleTiming, job: SubtitleSyncJob | undefined): string | undefined {
    switch (job?.status ?? "") {
        case "pending":
        case "running": {
            const percent = job === undefined ? 0 : syncPercent(job) ?? 0;
            return percent > 0 ? `${SYNCING} ${percent}%` : SYNCING;
        }
        case "no_match": return "Doesn't match this video";
        case "failed": return "Sync failed";
        case "already_synced":
            if (isIdentityTiming(timing)) return "Already in sync";
            break;
        case "synced":
            if (isIdentityTiming(timing)) return "Original timing";
            if (job?.result !== undefined && job.result.offsetMs === timing.offsetMs && job.result.scale === timing.scale) return `Synced ${describeTiming(timing)}`;
            break;
        default: break;
    }
    return isIdentityTiming(timing) ? undefined : `Timing adjusted ${describeTiming(timing)}`;
}

/** The last finished job's result, for the selected track's timing controls. */
export function syncResult(timing: SubtitleTiming, job: SubtitleSyncJob | undefined): { readonly text: string; readonly warning: boolean } | undefined {
    switch (job?.status) {
        case "synced": return isIdentityTiming(timing) ? undefined : { text: `Synced to the audio: ${describeTiming(timing)}`, warning: false };
        case "already_synced": return { text: "Already matches the audio.", warning: false };
        case "no_match": return { text: "Doesn't match this video's audio; probably for another release.", warning: true };
        case "failed": return { text: failureText(job.failure), warning: true };
        default: return undefined;
    }
}

export function syncActionNote(external: boolean): string {
    return external ? "Matches the timing to the audio for everyone. The file itself isn't changed." : "Matches the timing to the audio for everyone watching.";
}

export interface SyncNote { readonly text: string; readonly tone: "error" | "warning" | "plain" | "hint" }

/** What the Subtitles tab draws under TIMING for the selected track. */
export interface SyncTimingView {
    readonly key: string;
    readonly canSync: boolean;
    readonly canReset: boolean;
    /** A sync or timing request is on the wire. */
    readonly busy: boolean;
    readonly inProgress: boolean;
    /** The server refused this viewer: the Sync row is shown dimmed with this message, and nothing else. */
    readonly forbidden: string | undefined;
    readonly progress: { readonly percent: number; readonly phase: string } | undefined;
    readonly note: SyncNote | undefined;
}

export interface SubtitleSyncView {
    readonly available: boolean;
    /** By sync key, for the tracks that have timing controls. */
    readonly timing: Readonly<Record<string, SyncTimingView>>;
    /** By sync key: the line after a track's attributes ("Syncing… 40%", "Synced −3.0 s"). */
    readonly status: Readonly<Record<string, string>>;
}

interface Entry {
    state: SubtitleSyncState;
    busy: boolean;
    /** The server refused to let this viewer retime the subtitle (403). */
    forbidden: boolean;
    /** The subtitle's format cannot be synced (422). */
    unsupported: boolean;
    error: string | undefined;
    /** Polling gave up; pressing Sync to Audio again re-arms it. */
    pollExpired: boolean;
}

/** Timing and sync state of the playing file's syncable subtitles, by sync key. Follows a running job by polling. */
export class SubtitleSync {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    readonly fileId: string;
    private readonly changed: () => void;
    private readonly onTimingChanged: (key: string) => void;
    private readonly abort = new AbortController();
    private readonly stopAuthority: () => void;
    private cancelPoll: (() => void) | undefined;
    private available = false;
    private external = false;
    private readonly entries = new Map<string, Entry>();
    private readonly pollStarted = new Map<string, number>();
    /** Counts the answers recorded for a subtitle, so a list read that left before one arrived cannot overwrite it. */
    private readonly versions = new Map<string, number>();

    constructor(session: NativeSession, clock: Clock, fileId: string, changed: () => void, onTimingChanged: (key: string) => void) {
        this.session = session;
        this.clock = clock;
        this.fileId = fileId;
        this.changed = changed;
        this.onTimingChanged = onTimingChanged;
        const signal = session.authoritySignal;
        const cancel = (): void => this.destroy();
        signal.addEventListener("abort", cancel, { once: true });
        this.stopAuthority = () => signal.removeEventListener("abort", cancel);
        if (signal.aborted) this.destroy();
        else void this.discover();
    }

    destroy(): void {
        this.abort.abort();
        this.cancelPoll?.();
        this.cancelPoll = undefined;
        this.stopAuthority();
    }

    private call<T>(spec: RequestSpec<T>): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: spec.method === "GET", signal: this.abort.signal });
    }

    get view(): SubtitleSyncView {
        const timing: Record<string, SyncTimingView> = {};
        const status: Record<string, string> = {};
        if (this.available) {
            for (const entry of this.entries.values()) {
                const label = syncStatusLabel(entry.state.timing, entry.state.job);
                if (label !== undefined) status[entry.state.key] = label;
                if (this.showsTimingControls(entry)) timing[entry.state.key] = this.timingView(entry);
            }
        }
        return { available: this.available, timing, status };
    }

    private canSync(entry: Entry): boolean {
        return this.available && !entry.unsupported && (!entry.state.external || this.external);
    }

    private active(entry: Entry): boolean {
        return jobInProgress(entry.state.job) && !entry.pollExpired;
    }

    private showsTimingControls(entry: Entry): boolean {
        return this.available && (entry.forbidden || this.canSync(entry) || !isIdentityTiming(entry.state.timing) || entry.error !== undefined);
    }

    private timingView(entry: Entry): SyncTimingView {
        const { state } = entry;
        const inProgress = this.active(entry);
        const canSync = this.canSync(entry);
        const result = !inProgress && entry.error === undefined ? syncResult(state.timing, state.job) : undefined;
        let note: SyncNote | undefined;
        if (entry.error !== undefined) note = { text: entry.error, tone: "error" };
        else if (result !== undefined) note = { text: result.text, tone: result.warning ? "warning" : "plain" };
        else if (canSync && !inProgress) note = { text: syncActionNote(state.external), tone: "hint" };
        const job = state.job;
        return {
            key: state.key,
            canSync,
            canReset: !isIdentityTiming(state.timing),
            busy: entry.busy,
            inProgress,
            forbidden: entry.forbidden ? FORBIDDEN : undefined,
            progress: inProgress && job !== undefined ? { percent: syncPercent(job) ?? 0, phase: phaseText(job) ?? "" } : undefined,
            note,
        };
    }

    /** Sync is decoration: the tracks play without it, so a failed read leaves the rows out. */
    private async discover(): Promise<void> {
        try {
            const status = await this.call(operations.subtitleSyncStatus());
            if (this.abort.signal.aborted || !status.available) return;
            this.available = true;
            this.external = status.external;
            await this.list();
        } catch { /* Unavailable sync is omitted; it never gates playback. */ }
    }

    private async list(): Promise<void> {
        const before = new Map(this.versions);
        const states = await this.call(operations.subtitleSyncList(this.fileId));
        if (this.abort.signal.aborted) return;
        for (const state of states) if (this.versions.get(state.key) === before.get(state.key) && !this.entries.get(state.key)?.busy) this.observe(state);
        this.schedulePoll();
        this.changed();
    }

    knows(key: string): boolean {
        return this.entries.has(key);
    }

    /** Lists the file's subtitles again, for a subtitle the plan gained since. */
    reload(): void {
        if (this.available) void this.list().catch(() => undefined);
    }

    /** Records a fresh server view of a subtitle and reports a timing change. An answer for another file, or for another subtitle than the one asked for, is refused. */
    private observe(state: SubtitleSyncState, key?: string): void {
        if (state.mediaFileId !== this.fileId || (key !== undefined && state.key !== key)) throw new Error("The server answered for a different subtitle");
        const entry = this.entries.get(state.key);
        this.versions.set(state.key, (this.versions.get(state.key) ?? 0) + 1);
        const previous = entry?.state.timing;
        if (entry === undefined) this.entries.set(state.key, { state, busy: false, forbidden: false, unsupported: false, error: undefined, pollExpired: false });
        else entry.state = state;
        const current = this.entries.get(state.key);
        if (current !== undefined && !jobInProgress(state.job)) {
            this.pollStarted.delete(state.key);
            current.pollExpired = false;
        }
        if (previous !== undefined && (previous.offsetMs !== state.timing.offsetMs || previous.scale !== state.timing.scale)) this.onTimingChanged(state.key);
    }

    private entry(key: string): Entry | undefined {
        return this.abort.signal.aborted ? undefined : this.entries.get(key);
    }

    async request(key: string): Promise<void> {
        const entry = this.entry(key);
        if (entry === undefined || entry.busy || this.active(entry)) return;
        const expired = entry.pollExpired;
        entry.busy = true;
        entry.error = undefined;
        entry.pollExpired = false;
        this.pollStarted.delete(key);
        this.changed();
        try {
            const state = await this.call(operations.subtitleSyncStart(this.fileId, key));
            if (this.abort.signal.aborted) return;
            this.observe(state, key);
            entry.busy = false;
            this.schedulePoll();
        } catch (error) {
            if (this.abort.signal.aborted) return;
            // A refused re-arm leaves the old job unfollowed: keep it expired so the next press can try again.
            entry.pollExpired = expired;
            this.fail(entry, error, SYNC_FAILED_RETRY);
        }
        this.changed();
    }

    async reset(key: string): Promise<void> {
        const entry = this.entry(key);
        if (entry === undefined || entry.busy || this.active(entry)) return;
        entry.busy = true;
        entry.error = undefined;
        this.changed();
        try {
            let etag: string | undefined;
            await this.call(operations.subtitleSyncRead(this.fileId, key, value => { etag = value; }));
            if (etag === undefined) throw new Error("The server sent no validator for the subtitle's timing");
            const state = await this.call(operations.subtitleTimingReset(this.fileId, key, etag));
            if (this.abort.signal.aborted) return;
            this.observe(state, key);
            entry.busy = false;
        } catch (error) {
            if (this.abort.signal.aborted) return;
            this.fail(entry, error, RESET_FAILED);
        }
        this.changed();
    }

    private fail(entry: Entry, error: unknown, fallback: string): void {
        entry.busy = false;
        const status = error instanceof ApiError ? error.status : undefined;
        if (status === 403) {
            entry.forbidden = true;
            entry.error = undefined;
        } else if (status === 422) {
            entry.unsupported = true;
            entry.error = FORMAT_UNSUPPORTED;
        } else entry.error = status === 412 ? SUBTITLE_CHANGED : fallback;
    }

    private polling(): Entry[] {
        return [...this.entries.values()].filter(entry => this.active(entry));
    }

    private schedulePoll(): void {
        if (this.cancelPoll !== undefined || this.abort.signal.aborted || this.polling().length === 0) return;
        this.cancelPoll = this.clock.schedule(() => {
            this.cancelPoll = undefined;
            void this.tick();
        }, POLL_INTERVAL_MS);
    }

    /** One poll of every running job. */
    private async tick(): Promise<void> {
        for (const entry of this.polling()) {
            const key = entry.state.key;
            const started = this.pollStarted.get(key) ?? this.clock.now();
            this.pollStarted.set(key, started);
            if (this.clock.now() - started >= POLL_LIMIT_MS) {
                this.pollStarted.delete(key);
                entry.pollExpired = true;
                continue;
            }
            try {
                const state = await this.call(operations.subtitleSyncRead(this.fileId, key));
                if (this.abort.signal.aborted) return;
                this.observe(state, key);
            } catch (error) {
                if (this.abort.signal.aborted) return;
                // A lost or unreadable subtitle stops its poll; any other failure is tried again at the next tick.
                const status = error instanceof ApiError ? error.status : undefined;
                if (status === 401 || status === 403 || status === 404 || status === 410) entry.pollExpired = true;
            }
        }
        this.changed();
        this.schedulePoll();
    }
}
