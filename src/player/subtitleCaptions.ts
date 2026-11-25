import { sleep, type Clock } from "../api/clock.ts";
import { abortedError, SubtitleTruncated } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { PlaybackPlan, SubtitleTrack } from "../contracts/v2/playback.ts";
import { DEFAULT_APPEARANCE, decodeCues, type SubtitleAppearance, type SubtitleCue } from "../contracts/v2/subtitles.ts";
import { translate } from "../i18n/translate.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import type { AppearanceMember } from "./subtitleAppearance.ts";
import { SubtitleDisplay, type SubtitleDisplayLoadResult, type SubtitleDisplayView } from "./subtitleDisplay.ts";
import { captionKeyOf, orderedInventory, secondaryFormat, secondaryRows, subtitleChoice } from "./subtitleTransportRules.ts";
import type { TrackChoice } from "./subtitleTypes.ts";

/** Apple's `AetherEngine.sidecarTruncationRetryDelaysSeconds`: a server still extracting the track serves each refetch more of it. */
export const SUBTITLE_REFETCH_DELAYS_MS = [2000, 5000, 10000, 10000, 10000];

export const CAPTION_LOADING = "Loading subtitles…";
/** Kept in `captionNotice` as an id; `captionNoticeText` gives its words. Turning the track off and on fetches it again. */
export const CAPTION_FAILED = "caption-failed";

const PREFERENCE_LOAD_FAILED = "Some subtitle preferences could not be loaded; using defaults.";

/** A caption notice as the menu shows it: the failure is Apple's `player.subtitles.dataLoadFailed`. */
export function captionNoticeText(notice: string): string {
    return notice === CAPTION_FAILED ? translate("player.subtitles.dataLoadFailed") : notice;
}

/**
 * Apple's `decodeSidecarRetryingTruncation`. Fetches until a download arrives whole. After one ends
 * early the cues it held go to `showPartial` (only when more than the ones already shown) and the
 * file is fetched again after each delay, a refetch that fails outright included. Returns the
 * largest partial once the refetches are spent. A first fetch that never got going throws.
 */
export async function downloadSubtitle<Cue>(
    clock: Clock,
    signal: AbortSignal,
    fetchText: () => Promise<string>,
    decode: (text: string) => readonly Cue[],
    showPartial: (cues: readonly Cue[]) => void,
): Promise<readonly Cue[]> {
    let best: readonly Cue[] | undefined;
    for (let attempt = 0; ; attempt++) {
        let failure: unknown;
        try {
            return decode(await fetchText());
        } catch (error) {
            failure = error;
        }
        if (signal.aborted) throw failure;
        if (failure instanceof SubtitleTruncated) {
            const partial = decode(failure.text);
            if (partial.length > (best?.length ?? -1)) {
                best = partial;
                showPartial(partial);
            }
        }
        if (best === undefined) throw failure;
        const delay = SUBTITLE_REFETCH_DELAYS_MS[attempt];
        if (delay === undefined) return best;
        await sleep(clock, delay, signal, abortedError);
    }
}

export type PreferenceLoadState =
    | { readonly kind: "unstarted" }
    | { readonly kind: "loading_modern" }
    | { readonly kind: "loaded_modern"; readonly readAppearance: boolean; readonly readSync: boolean }
    | { readonly kind: "deferred_legacy" }
    | { readonly kind: "failed_modern" };

export type DisplayAction =
    | { readonly kind: "delay"; readonly milliseconds: number }
    | { readonly kind: "size"; readonly size: SubtitleAppearance["fontSize"] }
    | { readonly kind: "position"; readonly position: SubtitleAppearance["position"] }
    | { readonly kind: "device"; readonly enabled: boolean }
    | { readonly kind: "appearance"; readonly member: AppearanceMember; readonly value: string | number | boolean };

export interface CaptionsOverlayView {
    readonly text: string;
    readonly secondaryText?: string;
    readonly appearance: SubtitleAppearance;
    readonly status?: "none" | "loading" | "failed" | "ready";
    readonly cueCount?: number;
    readonly instant?: number;
}

/**
 * Owns primary + secondary sidecar cue loading, truncation refetch, sync-triggered refresh,
 * and the single unified Profile subtitle preference read (appearance + delay).
 */
export class SubtitleCaptions {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    private readonly signal: AbortSignal;
    private readonly publicStorage: PublicStorage | undefined;
    private readonly onChanged: () => void;

    private destroyed = false;
    private display: SubtitleDisplay | undefined;
    private preferenceState: PreferenceLoadState = { kind: "unstarted" };
    private profileId: string | undefined;
    private artifactRequested = false;
    private legacyAppearanceRead = false;
    private legacySyncRead = false;

    private appearance: SubtitleAppearance = DEFAULT_APPEARANCE;
    private delayMs = 0;
    private preferenceNotice = "";

    private cues: readonly SubtitleCue[] = [];
    private key: string | undefined;
    private abort: AbortController | undefined;
    private notice = "";
    private timing = 0;
    private fallbackTrackId: string | undefined;

    private secondaryId: string | undefined;
    private secondaryCues: readonly SubtitleCue[] = [];
    private secondaryOrigin = 0;
    private secondaryUrl: string | undefined;
    private secondaryTiming = 0;
    private secondaryAbort: AbortController | undefined;

    constructor(
        session: NativeSession,
        clock: Clock,
        signal: AbortSignal,
        publicStorage: PublicStorage | undefined,
        onChanged: () => void,
    ) {
        this.session = session;
        this.clock = clock;
        this.signal = signal;
        this.publicStorage = publicStorage;
        this.onChanged = onChanged;
    }

    get captionKey(): string | undefined { return this.key; }
    get captionNotice(): string { return this.notice; }
    get syncDelayMs(): number { return this.delayMs; }
    get displayView(): SubtitleDisplayView | undefined { return this.display?.view; }

    notices(plan: PlaybackPlan): readonly string[] {
        if (plan.subtitle.mode !== "render" && plan.subtitle.mode !== "convert") return [];
        const items: string[] = [];
        if (this.notice !== "") items.push(captionNoticeText(this.notice));
        if (this.preferenceNotice !== "") items.push(this.preferenceNotice);
        return items;
    }

    ensureDisplay(profileId: string | undefined): void {
        if (this.destroyed || this.signal.aborted) return;
        this.profileId = profileId;
        if (this.display !== undefined) {
            this.display.adopt(this.appearance, this.delayMs);
            return;
        }
        if (profileId === undefined) return;
        const display = new SubtitleDisplay(
            this.session,
            profileId,
            (appearance, sync) => {
                if (this.destroyed || this.signal.aborted) return;
                this.appearance = appearance;
                this.delayMs = sync;
                this.onChanged();
            },
            () => {
                if (!this.destroyed && !this.signal.aborted) this.onChanged();
            },
            this.publicStorage,
        );
        this.display = display;
        this.preferenceState = { kind: "loading_modern" };
        void display.load().then(result => this.finishDisplayLoad(profileId, result));
    }

    applyDisplayAction(action: DisplayAction): void {
        const display = this.display;
        if (display === undefined) return;
        switch (action.kind) {
            case "delay": void display.setDelay(action.milliseconds); return;
            case "size": void display.setSize(action.size); return;
            case "position": void display.setPosition(action.position); return;
            case "device": void display.setDeviceOverride(action.enabled); return;
            case "appearance": void display.setAppearance(action.member, action.value); return;
            default: {
                const unexpected: never = action;
                return unexpected;
            }
        }
    }

    setNotice(notice: string): void {
        this.notice = notice;
    }

    setCaptionFallback(trackId: string): void {
        this.fallbackTrackId = trackId;
    }

    consumeCaptionFallback(): string | undefined {
        const id = this.fallbackTrackId;
        this.fallbackTrackId = undefined;
        return id;
    }

    clearOverlay(): void {
        this.abort?.abort();
        this.clearSecondary();
        this.key = undefined;
        this.cues = [];
        this.notice = "";
    }

    clearSecondary(): void {
        this.secondaryAbort?.abort();
        this.secondaryId = undefined;
        this.secondaryCues = [];
    }

    /** `refresh` rereads the shown track past the HTTP cache after a timing change: its cues stay on screen until the new ones load, and stay if that fails. */
    readPrimary(
        plan: PlaybackPlan,
        timingVersionOf: (key: string | undefined) => number,
        onPrimaryFailed: (loaded: PlaybackPlan) => boolean,
        refresh = false,
    ): void {
        const artifact = plan.subtitle.mode === "render" || plan.subtitle.mode === "convert" ? plan.subtitle.artifact : undefined;
        const key = captionKeyOf(plan);
        this.reconcileSecondary(plan, timingVersionOf);
        if (!refresh && key !== undefined && key === this.key) return;
        const shownTiming = this.timing;
        this.key = key;
        this.fallbackTrackId = undefined;
        this.timing = timingVersionOf(plan.subtitle.inventory.find(track => track.trackId === plan.subtitle.trackId)?.syncKey);
        this.abort?.abort();
        const abort = new AbortController();
        this.abort = abort;
        const cancel = (): void => abort.abort();
        this.signal.addEventListener("abort", cancel, { once: true });
        abort.signal.addEventListener("abort", () => this.signal.removeEventListener("abort", cancel), { once: true });
        if (!refresh) {
            this.cues = [];
            this.notice = "";
        }
        if (artifact === undefined) return;
        if (!refresh) this.notice = CAPTION_LOADING;
        const current = (): boolean => !this.destroyed && !abort.signal.aborted && this.abort === abort;
        void (async () => {
            try {
                const show = (cues: readonly SubtitleCue[]): void => {
                    if (!current() || refresh) return;
                    this.cues = cues;
                    this.notice = "";
                    this.onChanged();
                };
                const cues = await downloadSubtitle(
                    this.clock,
                    abort.signal,
                    async () => {
                        const url = await this.captionUrl(artifact.url, abort.signal);
                        this.ensurePreferencesForArtifact();
                        return this.session.http.subtitleText(url, abort.signal, refresh);
                    },
                    text => decodeCues(text, artifact.format, artifact.origin),
                    show,
                );
                if (!current()) return;
                this.cues = cues;
                this.notice = "";
            } catch {
                if (!current()) return;
                // Cues on screen are still the track's, at the older timing: keep them, and let the next timing change try again. With none loaded yet, fail as usual.
                if (refresh && this.cues.length > 0) {
                    this.timing = shownTiming;
                    return;
                }
                this.key = undefined;
                // SECONDARY needs a drawn primary: without it the list is gone, so its second line must go too.
                this.clearSecondary();
                if (onPrimaryFailed(plan)) {
                    this.onChanged();
                    return;
                }
                this.notice = CAPTION_FAILED;
            }
            if (current()) this.onChanged();
        })();
    }

    selectSecondary(plan: PlaybackPlan, trackId: string | undefined, timingVersionOf: (key: string | undefined) => number): void {
        if (trackId === undefined) {
            this.clearSecondary();
            this.onChanged();
            return;
        }
        const artifact = plan.subtitle.artifact;
        const row = secondaryRows(plan).find(candidate => candidate.trackId === trackId);
        if (this.key === undefined || artifact === undefined || row === undefined || row.trackId === plan.subtitle.trackId) return;
        this.startSecondary(row, artifact.origin, timingVersionOf);
        this.onChanged();
    }

    /** The server retimed a subtitle: the track's URL serves the new timing, but the cues already read are the old ones. */
    refetchForTiming(
        plan: PlaybackPlan,
        key: string,
        version: number,
        timingVersionOf: (syncKey: string | undefined) => number,
        onPrimaryFailed: (loaded: PlaybackPlan) => boolean,
    ): void {
        const retimed = (trackId: string | undefined): boolean =>
            trackId !== undefined && plan.subtitle.inventory.find(track => track.trackId === trackId)?.syncKey === key;
        const secondary = retimed(this.secondaryId) && this.secondaryTiming < version
            ? secondaryRows(plan).find(row => row.trackId === this.secondaryId)
            : undefined;
        if (secondary !== undefined) this.startSecondary(secondary, this.secondaryOrigin, timingVersionOf, true);
        if (this.key !== undefined && retimed(plan.subtitle.trackId) && this.timing < version) {
            this.readPrimary(plan, timingVersionOf, onPrimaryFailed, true);
        }
        this.onChanged();
    }

    secondaryView(
        plan: PlaybackPlan,
        shownId: string | undefined,
        orderingLanguage: string | undefined,
    ): { readonly secondary?: { readonly choices: readonly TrackChoice[]; readonly selectedId: string | undefined } } {
        if (this.key === undefined || shownId === undefined) return {};
        const rows = orderedInventory(secondaryRows(plan), orderingLanguage);
        if (rows.length === 0) return {};
        return {
            secondary: {
                choices: rows.map(row => ({ ...subtitleChoice(row, undefined), ...(row.trackId === shownId ? { unavailable: true } : {}) })),
                selectedId: this.secondaryId,
            },
        };
    }

    captionsView(captionTime: number, hidden: boolean): CaptionsOverlayView | undefined {
        if (hidden) return undefined;
        return {
            text: this.cues.filter(cue => captionTime >= cue.start && captionTime < cue.end).map(cue => cue.text).join("\n"),
            secondaryText: this.secondaryCues.filter(cue => captionTime >= cue.start && captionTime < cue.end).map(cue => cue.text).join("\n"),
            appearance: this.appearance,
            status: this.notice === CAPTION_LOADING ? "loading" : this.notice === CAPTION_FAILED ? "failed" : this.cues.length > 0 ? "ready" : "none",
            cueCount: this.cues.length,
            instant: captionTime,
        };
    }

    destroy(): void {
        this.destroyed = true;
        this.abort?.abort();
        this.secondaryAbort?.abort();
        this.display?.destroy();
    }

    /** SECONDARY follows its primary: it ends with the primary's artifact, or when the primary becomes the same track. */
    private reconcileSecondary(plan: PlaybackPlan, timingVersionOf: (key: string | undefined) => number): void {
        if (this.secondaryId === undefined) return;
        const artifact = plan.subtitle.mode === "render" || plan.subtitle.mode === "convert" ? plan.subtitle.artifact : undefined;
        const row = secondaryRows(plan).find(candidate => candidate.trackId === this.secondaryId && candidate.trackId !== plan.subtitle.trackId);
        if (artifact === undefined || row === undefined) this.clearSecondary();
        // A replan that moved the primary's timing origin moves where the second track's cues belong, and one that gave the row a new session URL leaves the old read against a dead session.
        else if (artifact.origin !== this.secondaryOrigin || row.url !== this.secondaryUrl) this.startSecondary(row, artifact.origin, timingVersionOf);
    }

    /** `refresh` rereads the shown secondary after a timing change, keeping its line and its selection unless new cues load. */
    private startSecondary(row: SubtitleTrack, origin: number, timingVersionOf: (key: string | undefined) => number, refresh = false): void {
        const shownTiming = this.secondaryTiming;
        const keep = refresh && this.secondaryId === row.trackId;
        if (keep) this.secondaryAbort?.abort();
        else this.clearSecondary();
        this.secondaryId = row.trackId;
        this.secondaryOrigin = origin;
        this.secondaryUrl = row.url;
        this.secondaryTiming = timingVersionOf(row.syncKey);
        const abort = new AbortController();
        this.secondaryAbort = abort;
        const cancel = (): void => abort.abort();
        this.signal.addEventListener("abort", cancel, { once: true });
        abort.signal.addEventListener("abort", () => this.signal.removeEventListener("abort", cancel), { once: true });
        const current = (): boolean => !this.destroyed && !abort.signal.aborted;
        void (async () => {
            try {
                const cues = await downloadSubtitle(
                    this.clock,
                    abort.signal,
                    async () => this.session.http.subtitleText(await this.captionUrl(row.url ?? "", abort.signal), abort.signal, keep),
                    text => decodeCues(text, secondaryFormat(row) ?? "", origin),
                    partial => {
                        if (!current() || keep) return;
                        this.secondaryCues = partial;
                        this.onChanged();
                    },
                );
                if (!current()) return;
                this.secondaryCues = cues;
            } catch {
                if (!current()) return;
                // A reread that fails leaves the line it replaced; with none loaded yet, or a track that cannot be read at all, it is not shown as chosen.
                if (keep && this.secondaryCues.length > 0) {
                    this.secondaryTiming = shownTiming;
                    return;
                }
                this.secondaryId = undefined;
            }
            if (current()) this.onChanged();
        })();
    }

    /** A subtitle URL with the account's media token, since AVPlay and the app's own reads send no header for it. */
    private async captionUrl(raw: string, signal: AbortSignal): Promise<string> {
        const base = this.session.http.base;
        const url = new URL(raw.startsWith("/") ? base.baseUrl + raw : raw);
        if (url.origin === base.origin && !url.searchParams.has("token")) url.searchParams.set("token", await this.session.mediaToken(signal));
        return url.href;
    }

    private finishDisplayLoad(profileId: string, result: SubtitleDisplayLoadResult): void {
        if (this.destroyed || this.signal.aborted || result.kind === "aborted") return;
        if (result.kind === "loaded") {
            this.preferenceState = { kind: "loaded_modern", readAppearance: result.readAppearance, readSync: result.readSync };
            if (this.artifactRequested && (!result.readAppearance || !result.readSync)) {
                this.readLegacyPreferences(profileId, !result.readAppearance, !result.readSync);
            }
            return;
        }
        this.preferenceState = result.kind === "legacy" ? { kind: "deferred_legacy" } : { kind: "failed_modern" };
        if (this.artifactRequested) {
            this.readLegacyPreferences(profileId, true, true);
        }
    }

    private ensurePreferencesForArtifact(): void {
        this.artifactRequested = true;
        if (this.preferenceState.kind === "loading_modern") return;
        if (this.preferenceState.kind === "loaded_modern") {
            if (!this.preferenceState.readAppearance || !this.preferenceState.readSync) {
                this.readLegacyPreferences(this.profileId ?? "", !this.preferenceState.readAppearance, !this.preferenceState.readSync);
            }
            return;
        }
        this.readLegacyPreferences(this.profileId ?? "", true, true);
    }

    private readLegacyPreferences(profileId: string, readAppearance: boolean, readSync: boolean): void {
        const current = (): boolean => !this.destroyed && !this.signal.aborted;
        const failed = (): void => {
            if (!current()) return;
            this.preferenceNotice = PREFERENCE_LOAD_FAILED;
            this.onChanged();
        };
        if (readAppearance && !this.legacyAppearanceRead) {
            this.legacyAppearanceRead = true;
            void this.session.call({ ...operations.subtitleAppearance(profileId), profileScoped: true, signal: this.signal }).then(appearance => {
                if (!current() || this.display?.editedAppearance) return;
                this.appearance = appearance;
                this.display?.adopt(appearance, this.delayMs);
                this.onChanged();
            }, failed);
        }
        if (readSync && !this.legacySyncRead) {
            this.legacySyncRead = true;
            void this.session.call({ ...operations.subtitleSync(), profileScoped: true, signal: this.signal }).then(sync => {
                if (!current() || this.display?.editedDelay) return;
                this.delayMs = sync;
                this.display?.adopt(this.appearance, sync);
                this.onChanged();
            }, failed);
        }
    }
}
