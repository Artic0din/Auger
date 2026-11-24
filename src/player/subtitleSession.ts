import { sleep, type Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { abortedError } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import type { PlaybackDecision, PlaybackPlan, SelectedTracks } from "../contracts/v2/playback.ts";
import type { SubtitlePreferences } from "../contracts/v2/preplaySubtitles.ts";
import type { NativeSession } from "../session/session.ts";
import { initialSubtitle, playableIntent } from "./preplaySubtitles.ts";
import { unanswered } from "./playbackRecovery.ts";
import type { LiveStats } from "./playerHUD.ts";
import { CAPTION_FAILED, SubtitleCaptions, SUBTITLE_REFETCH_DELAYS_MS, downloadSubtitle, type CaptionsOverlayView } from "./subtitleCaptions.ts";
import { SubtitleTools } from "./subtitleTools.ts";
import {
    inStreamCandidate,
    keepsHlsTransport,
    loadsEmbeddedFile,
    orderedInventory,
    parseAVPlayTextTracks,
    renditionSwitch,
    sameDirectTransport,
    selectableSubtitle,
    selectedSubtitle,
    startingDefault,
    streamRenditionAnswer,
    subtitleChoice,
    subtitleStart,
    textTrackIndex,
    unsupportedFormat,
} from "./subtitleTransportRules.ts";
import type {
    PendingStoredTrack,
    PreparedTrackReplan,
    RouteFailureDisposition,
    StreamAlignmentResult,
    StreamCompletedDisposition,
    SubtitleHost,
    SubtitlePostSettle,
    SubtitleSessionDeps,
    SubtitleSessionRequest,
    SubtitleToolAction,
    SubtitleTrackViewSlice,
    SubtitleTransportSnapshot,
    TrackChange,
} from "./subtitleTypes.ts";

export { SUBTITLE_REFETCH_DELAYS_MS, downloadSubtitle, orderedInventory, parseAVPlayTextTracks, subtitleStart, unsupportedFormat };

const RESEND_DELAYS_MS = [1000, 2000];
const SWITCH_REPLAY_DELAYS_MS = [5000, 10000, 15000, 30000];
const REPLAN_LEASE_MS = 15000;
const SWITCH_NOTE_AFTER_MS = 60000;
const SWITCH_FAILURE_DEADLINE_MS = 30000;

type TrackOverride = { readonly id: string | undefined };

type DirectSwitchFallback =
    | { readonly mode: "waiting" }
    | { readonly mode: "deferred_redraw"; readonly plan: PlaybackPlan; readonly trackId: string }
    | { readonly mode: "active_native"; readonly overrideId: string };

interface DirectSwitchFailureWait {
    readonly classification: string;
    readonly failedAtMs: number;
    wakeUsed: boolean;
}

type BlockingOrigin = "viewer_pick" | "stored_inventory_refresh" | "initial_start" | "unavailable_native";

type SubtitleSwitchState =
    | {
          readonly phase: "idle";
          nativeOverride?: TrackOverride | undefined;
          deferredPick?: TrackOverride | undefined;
          queuedAfterReopen?: TrackOverride | undefined;
          pendingStored?: PendingStoredTrack | undefined;
          outcome?: { readonly state: "refused"; readonly message: string } | { readonly state: "failed" } | undefined;
      }
    | {
          readonly phase: "hls_reporting";
          reportedId: string | undefined;
          restoreId: string | undefined;
          appliedOverride: TrackOverride;
          pending?: { readonly id: string | undefined; readonly applied: boolean } | undefined;
          endedWhileOut: boolean;
          routeFailure?: string | undefined;
      }
    | {
          readonly phase: "direct_embedded_switching";
          readonly targetId: string;
          readonly sentAtMs: number;
          readonly priorOverride?: TrackOverride | undefined;
          noteShown: boolean;
          localFallback: DirectSwitchFallback;
          pending?: TrackOverride | undefined;
          failureWait?: DirectSwitchFailureWait | undefined;
          wake?: (() => void) | undefined;
      }
    | {
          readonly phase: "replanning_blocking";
          readonly origin: BlockingOrigin;
          readonly targetId: string | undefined;
          readonly priorOverride?: TrackOverride | undefined;
          queuedAfterReopen?: TrackOverride | undefined;
          pendingStored?: PendingStoredTrack | undefined;
          endedWhileOut: boolean;
          routeFailure?: string | undefined;
      };

function sessionGone(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false;
    if (error.aborted || error.status === 404 || error.status === 410) return true;
    return error.failure.kind === "problem" && error.failure.problem.id === "installation_changed";
}

/** Per-attempt owner of subtitle delivery, switching, dual-cue sidecar fetching, Profile preference loading, and tool coordination. */
export class SubtitleSession {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    private readonly host: SubtitleHost;
    private readonly request: SubtitleSessionRequest;
    private readonly signal: AbortSignal;
    private readonly captions: SubtitleCaptions;
    private readonly tools: SubtitleTools;

    private state: SubtitleSwitchState = { phase: "idle" };
    private orderingLanguage: string | undefined;
    private nativeUnavailable = false;
    private destroyed = false;

    constructor(deps: SubtitleSessionDeps, request: SubtitleSessionRequest, signal: AbortSignal) {
        this.session = deps.session;
        this.clock = deps.clock;
        this.host = deps.host;
        this.request = request;
        this.signal = signal;
        this.captions = new SubtitleCaptions(deps.session, deps.clock, signal, deps.publicStorage, () => this.notifyChanged());
        this.tools = new SubtitleTools(
            deps.session,
            deps.clock,
            request.contentId,
            request.episode,
            signal,
            () => this.notifyChanged(),
            key => this.refetchCaptionsForSync(key),
            id => this.attachDownloaded(id),
        );
    }

    get subtitleSwitchOut(): boolean { return this.state.phase === "direct_embedded_switching"; }
    get isReporting(): boolean { return this.state.phase === "hls_reporting"; }
    get holdsTransportBusy(): boolean { return this.state.phase === "hls_reporting" || this.state.phase === "replanning_blocking"; }
    get nativeSubtitleUnavailable(): boolean { return this.nativeUnavailable; }

    async resolveInitialSubtitles(plan: PlaybackPlan, serverFeatures: readonly string[]): Promise<void> {
        const implicit = this.request.subtitle === undefined;
        const intent = playableIntent(this.request.subtitle ?? { kind: "auto" }, plan.subtitle.inventory);
        try {
            if (intent.kind !== "auto") void this.readSubtitlePreferences(plan).catch(() => undefined);
            let preferences: SubtitlePreferences | undefined;
            if (intent.kind === "auto") {
                try {
                    preferences = await this.readSubtitlePreferences(plan);
                } catch (error) {
                    if (!implicit) throw error;
                    if (this.alive()) this.host.adoptPlan(plan, serverFeatures, false);
                    return;
                }
            }
            if (!this.alive()) return;
            const subtitle = initialSubtitle(intent, plan.subtitle.inventory, preferences, startingDefault(this.request, plan) ?? plan.subtitle.trackId);
            if (subtitle === plan.subtitle.trackId) {
                this.host.adoptPlan(plan, serverFeatures, false);
                return;
            }
            const audio = plan.selectedTracks.audio;
            const selected: SelectedTracks = { ...(audio === undefined ? {} : { audio }), ...(subtitle === undefined ? {} : { subtitle: { id: subtitle } }) };
            this.startBlockingReplan(plan, selected, "initial_start", subtitle);
        } catch {
            const message = intent.kind === "track"
                ? "The selected subtitles are unavailable on this version. Choose another track in Details."
                : "Could not read subtitle preferences. Return to Details to retry or choose Off.";
            if (this.alive()) {
                this.host.fail({ kind: "terminal", reason: "subtitle_selection_unavailable", message, retryable: false }, true);
            }
        }
    }

    onPlanAdopted(plan: PlaybackPlan, profileId: string | undefined): void {
        if (this.destroyed) return;
        const carriedQueue = this.extractQueuedAfterReopen();
        let carriedStored = this.extractPendingStored();
        this.wakePendingDirectSwitch();

        this.captions.ensureDisplay(profileId);
        const { aiRotated, searchRotated } = this.tools.adoptFile(plan);
        if (aiRotated && carriedStored?.kind === "ai") carriedStored = undefined;
        if (searchRotated && carriedStored?.kind === "download") carriedStored = undefined;

        this.state = {
            phase: "idle",
            ...(carriedQueue === undefined ? {} : { queuedAfterReopen: carriedQueue }),
            ...(carriedStored === undefined ? {} : { pendingStored: carriedStored }),
        };
        this.readCaptionsFor(plan);
    }

    alignOpenStream(plan: PlaybackPlan): StreamAlignmentResult {
        this.applyCaptionFallback(plan);
        if (plan.subtitle.mode === "off" || plan.subtitle.mode === "burn_in" || plan.subtitle.mode === "unknown" || plan.subtitle.artifact !== undefined) {
            return "aligned";
        }
        const id = this.shownSubtitleId(plan);
        if (id === undefined) return "aligned";
        const row = plan.subtitle.inventory.find(entry => entry.trackId === id);
        if (row !== undefined && inStreamCandidate(plan, row) && this.applyStreamSubtitle(plan, id)) return "aligned";
        if (plan.delivery !== "original_http" || this.nativeUnavailable) {
            this.host.fail({ kind: "playback_failed" }, true);
            return "failed";
        }
        this.nativeUnavailable = true;
        this.host.closeForReplan();
        this.startBlockingReplan(plan, plan.selectedTracks, "unavailable_native", selectedSubtitle(plan), false);
        return "replan_unavailable_native";
    }

    consumePreparedChoices(plan: PlaybackPlan): void {
        if (this.state.phase !== "idle") return;
        const stored = this.state.pendingStored;
        const queued = this.state.queuedAfterReopen;
        this.state.pendingStored = undefined;
        this.state.queuedAfterReopen = undefined;
        if (stored !== undefined) this.tools.activateStored(plan, stored, trackId => this.selectSubtitle(trackId));
        if (queued !== undefined) this.selectSubtitle(queued.id);
    }

    onWarmRestored(): void {
        if (this.state.phase === "direct_embedded_switching" && this.state.localFallback.mode === "deferred_redraw") {
            const { plan, trackId } = this.state.localFallback;
            this.state.localFallback = { mode: "waiting" };
            this.drawSwitchLocally(plan, trackId);
        }
        this.restoreNativeVisibility();
    }

    onSeekSettled(): void {
        if (this.state.phase !== "idle" || this.state.deferredPick === undefined || this.host.snapshot().busy) return;
        const pick = this.state.deferredPick;
        this.state.deferredPick = undefined;
        this.selectSubtitle(pick.id);
    }

    onTransportChangeStarted(): void {
        if (this.state.phase === "idle") this.state.outcome = undefined;
    }

    onConnectionRecoveryStarted(): void {
        if ((this.state.phase === "idle" || this.state.phase === "replanning_blocking") && this.state.pendingStored?.kind === "ai") {
            this.state.pendingStored = undefined;
        }
    }

    onRouteFailed(classification: string, transportBusy: boolean): RouteFailureDisposition {
        if (this.state.phase === "hls_reporting" || this.state.phase === "replanning_blocking") {
            this.state.routeFailure = this.state.routeFailure ?? classification;
            return "absorbed_by_blocking_change";
        }
        // While a local seek holds transport busy, the seek owns the failure and replays routeFailed once settled (#750).
        if (this.state.phase === "direct_embedded_switching" && !transportBusy) {
            if (this.state.failureWait === undefined) {
                this.state.failureWait = { classification, failedAtMs: this.clock.now(), wakeUsed: false };
            }
            this.state.wake?.();
            return "absorbed_by_direct_switch";
        }
        return "not_owned";
    }

    onStreamCompleted(): StreamCompletedDisposition {
        if (this.state.phase === "hls_reporting" || this.state.phase === "replanning_blocking") {
            this.state.endedWhileOut = true;
            return "deferred";
        }
        return "not_owned";
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.wakePendingDirectSwitch();
        this.captions.destroy();
        this.tools.destroy();
    }

    // --- Track identity & view projections ---

    shownSubtitleId(plan: PlaybackPlan): string | undefined {
        const override = this.activeNativeOverride();
        return override !== undefined ? override.id : selectedSubtitle(plan);
    }

    chosenTracks(plan: PlaybackPlan): SelectedTracks {
        const audio = plan.selectedTracks.audio;
        const id = this.shownSubtitleId(plan);
        if (id === undefined) return { ...(audio === undefined ? {} : { audio }) };
        const planned = plan.selectedTracks.subtitle;
        const subtitle = planned !== undefined && planned.id === id ? planned : { id };
        return { ...(audio === undefined ? {} : { audio }), subtitle };
    }

    recoveryStartTrackId(plan: PlaybackPlan): string | undefined {
        const override = this.activeNativeOverride();
        if (override !== undefined) return override.id;
        return plan.subtitle.mode === "off" ? undefined : plan.subtitle.trackId ?? plan.selectedTracks.subtitle?.id;
    }

    liveStatsSubtitle(plan: PlaybackPlan): LiveStats["subtitle"] {
        const shown = this.shownSubtitleId(plan);
        const entry = shown === undefined ? undefined : plan.subtitle.inventory.find(row => row.trackId === shown);
        return entry === undefined ? undefined : { entry, generated: this.tools.generatedLabel(entry.syncKey) };
    }

    trackViewSlice(plan: PlaybackPlan): SubtitleTrackViewSlice {
        const sync = this.tools.syncView;
        const search = this.tools.searchView;
        const shown = this.shownSubtitleId(plan);
        const shownKey = plan.subtitle.inventory.find(track => track.trackId === shown)?.syncKey;
        return {
            ai: this.tools.aiView(plan),
            aiMenu: this.tools.aiMenuView(plan, shown, this.host.snapshot().audioVersions),
            seriesSubtitle: this.tools.seriesSubtitle,
            subtitles: orderedInventory(plan.subtitle.inventory, this.orderingLanguage).map(entry => {
                const choice = subtitleChoice(entry, this.tools.generatedLabel(entry.syncKey));
                const status = entry.unplayable === true || entry.syncKey === undefined ? undefined : sync?.status[entry.syncKey];
                return status === undefined ? choice : { ...choice, detail: choice.detail === undefined || choice.detail === "" ? status : `${choice.detail} · ${status}` };
            }),
            selectedSubtitleId: shown,
            subtitleMode: shown === undefined ? "off" : plan.subtitle.mode === "off" ? "render" : plan.subtitle.mode,
            change: this.subtitleTrackChange(),
            reporting: this.state.phase === "hls_reporting",
            notices: this.captions.notices(plan),
            ...(shownKey === undefined || sync?.timing[shownKey] === undefined ? {} : { syncTiming: sync.timing[shownKey] }),
            ...this.captions.secondaryView(plan, shown, this.orderingLanguage),
            ...(search === undefined ? {} : {
                subtitleTools: {
                    search,
                    ...(this.captions.displayView === undefined ? {} : { display: this.captions.displayView }),
                    overlay: this.subtitleOverlay(plan),
                },
            }),
        };
    }

    captionsView(plan: PlaybackPlan, transportHiddenOrFrozen: boolean): CaptionsOverlayView | undefined {
        const heldByDirectSwitch = this.state.phase === "direct_embedded_switching" && this.state.localFallback.mode !== "active_native";
        return this.captions.captionsView(this.captionInstant(plan), transportHiddenOrFrozen || heldByDirectSwitch);
    }

    // --- Viewer actions ---

    selectSubtitle(trackId: string | undefined): void {
        const snap = this.host.snapshot();
        if (!snap.live || this.destroyed) return;
        const plan = snap.plan;

        if (this.state.phase === "hls_reporting") {
            if (plan === undefined) return;
            const latest = this.state.pending !== undefined ? this.state.pending.id : this.shownSubtitleId(plan);
            if (trackId === latest || (trackId !== undefined && !selectableSubtitle(plan, trackId))) return;
            const applied = !loadsEmbeddedFile(plan, trackId) && this.applyStreamSubtitle(plan, trackId);
            if (applied) this.state.appliedOverride = { id: trackId };
            this.state.pending = { id: trackId, applied };
            this.notifyChanged();
            return;
        }

        if (this.state.phase === "direct_embedded_switching") {
            if (snap.started && plan !== undefined && (trackId === undefined || selectableSubtitle(plan, trackId))) {
                this.state.pending = { id: trackId };
            }
            return;
        }

        if (!this.canStartTrackChange(snap) || plan === undefined || trackId === this.shownSubtitleId(plan)) return;
        if (trackId !== undefined && !selectableSubtitle(plan, trackId)) return;

        const previous = this.shownSubtitleId(plan);
        if (!loadsEmbeddedFile(plan, trackId) && this.applyStreamSubtitle(plan, trackId)) {
            if (renditionSwitch(plan, trackId)) this.startHlsReport(plan, trackId, previous);
            else {
                this.state = { phase: "idle", nativeOverride: { id: trackId } };
                this.notifyChanged();
            }
            return;
        }

        const audio = plan.selectedTracks.audio;
        const selected: SelectedTracks = { ...(audio === undefined ? {} : { audio }), ...(trackId === undefined ? {} : { subtitle: { id: trackId } }) };
        if (loadsEmbeddedFile(plan, trackId) && trackId !== undefined) this.startDirectEmbeddedSwitch(plan, selected, trackId);
        else this.startBlockingReplan(plan, selected, "viewer_pick", trackId);
    }

    selectSecondarySubtitle(trackId: string | undefined): void {
        const snap = this.host.snapshot();
        if (!snap.live || this.destroyed || snap.plan === undefined || snap.hidden || snap.restoring) return;
        this.captions.selectSecondary(snap.plan, trackId, key => this.tools.timingVersion(key));
    }

    saveSeriesSubtitle(): void {
        const snap = this.host.snapshot();
        if (!this.canStartTrackChange(snap) || snap.plan === undefined) return;
        this.tools.saveSeries(snap.plan, this.shownSubtitleId(snap.plan), () => this.alive());
    }

    startSubtitleAI(language: string): void {
        const snap = this.host.snapshot();
        if (!this.canStartTrackChange(snap) || snap.plan === undefined || snap.hidden || snap.restoring) return;
        this.tools.startAI(snap.plan, this.shownSubtitleId(snap.plan), snap.audioVersions, language, snap.sourceSeconds);
    }

    subtitleAIAction(action: "open" | "cancel" | "dismiss" | "discard"): void {
        if (this.alive()) this.tools.aiAction(action);
    }

    selectAIResult(id: string): void {
        const snap = this.host.snapshot();
        const plan = snap.plan;
        if (!this.canStartTrackChange(snap) || plan === undefined || snap.hidden || snap.restoring || !this.tools.hasAIResult(id)) return;
        const track = plan.subtitle.inventory.find(entry => entry.syncKey === `stored-${id}`);
        if (track !== undefined) {
            this.selectSubtitle(track.trackId);
            return;
        }
        this.startBlockingReplan(plan, this.chosenTracks(plan), "stored_inventory_refresh", this.shownSubtitleId(plan), true, { kind: "ai", id });
    }

    applyTool(action: SubtitleToolAction): void {
        const snap = this.host.snapshot();
        if (!snap.live || this.destroyed || !snap.started || snap.plan === undefined) return;
        switch (action.kind) {
            case "search-open":
            case "search-language":
            case "search-back":
            case "search-close":
            case "search-download":
            case "search-retry":
                this.tools.applySearch(action);
                return;
            case "delay":
            case "size":
            case "position":
            case "device":
            case "appearance":
                this.captions.applyDisplayAction(action);
                return;
            default: {
                const unexpected: never = action;
                return unexpected;
            }
        }
    }

    syncSubtitle(key: string): void { if (this.alive()) this.tools.syncRequest(key); }
    resetSubtitleTiming(key: string): void { if (this.alive()) this.tools.syncReset(key); }

    // --- Internal switching & replan orchestration ---

    private startHlsReport(plan: PlaybackPlan, trackId: string | undefined, previous: string | undefined): void {
        this.state = {
            phase: "hls_reporting",
            reportedId: trackId,
            restoreId: previous,
            appliedOverride: { id: trackId },
            endedWhileOut: false,
        };
        this.host.beginSwitch("reporting");
        const audio = plan.selectedTracks.audio;
        const selected: SelectedTracks = { ...(audio === undefined ? {} : { audio }), ...(trackId === undefined ? {} : { subtitle: { id: trackId } }) };
        void this.executeReplan(plan, selected, "hls_reporting");
    }

    private startDirectEmbeddedSwitch(plan: PlaybackPlan, selected: SelectedTracks, trackId: string): void {
        const priorOverride = this.activeNativeOverride();
        this.state = {
            phase: "direct_embedded_switching",
            targetId: trackId,
            sentAtMs: this.clock.now(),
            ...(priorOverride === undefined ? {} : { priorOverride }),
            noteShown: false,
            localFallback: { mode: "waiting" },
        };
        this.host.beginSwitch("non_blocking");
        void this.executeReplan(plan, selected, "direct_embedded");
    }

    private startBlockingReplan(
        plan: PlaybackPlan,
        selected: SelectedTracks,
        origin: BlockingOrigin,
        targetId: string | undefined,
        notifyBegin = true,
        pendingStored?: PendingStoredTrack,
    ): void {
        const priorOverride = this.activeNativeOverride();
        const carriedQueue = this.extractQueuedAfterReopen();
        const carriedStored = pendingStored ?? this.extractPendingStored();
        this.state = {
            phase: "replanning_blocking",
            origin,
            targetId,
            ...(priorOverride === undefined ? {} : { priorOverride }),
            ...(carriedQueue === undefined ? {} : { queuedAfterReopen: carriedQueue }),
            ...(carriedStored === undefined ? {} : { pendingStored: carriedStored }),
            endedWhileOut: false,
        };
        if (notifyBegin) this.host.beginSwitch("blocking");
        void this.executeReplan(plan, selected, "blocking");
    }

    private async executeReplan(plan: PlaybackPlan, selected: SelectedTracks, kind: "blocking" | "direct_embedded" | "hls_reporting"): Promise<void> {
        const replan = this.host.prepareTrackReplan(plan, selected, this.host.snapshot().sourceSeconds);
        if (replan === undefined) return;
        const isCurrent = (): boolean => !this.destroyed && replan.isCurrent();

        let decision: PlaybackDecision;
        try {
            decision = kind === "direct_embedded"
                ? await this.replayDirectSwitch(plan, selected, replan, isCurrent)
                : await this.resend(replan.send, isCurrent);
        } catch (error) {
            if (isCurrent()) this.handleReplanError(plan, selected, error);
            return;
        }
        if (!isCurrent()) return;

        if (decision.outcome === "adaptation_unavailable") {
            this.handleAdaptationUnavailable(plan, selected, decision);
            return;
        }
        if (decision.outcome !== "playable") {
            this.state = { phase: "idle" };
            this.host.failFromDecision(decision, true);
            return;
        }
        if (decision.sessionId !== replan.sessionId) {
            this.state = { phase: "idle" };
            this.host.fail({ kind: "server" }, true);
            return;
        }
        await this.applyPlayableDecision(plan, selected, decision, isCurrent);
    }

    private async applyPlayableDecision(
        plan: PlaybackPlan,
        selected: SelectedTracks,
        decision: Extract<PlaybackDecision, { readonly outcome: "playable" }>,
        isCurrent: () => boolean,
    ): Promise<void> {
        const currentPlan = this.host.snapshot().plan;
        if (currentPlan === undefined) {
            if (decision.plan.effectiveMediaFileId !== plan.effectiveMediaFileId) {
                this.state = { phase: "idle" };
                this.host.fail({ kind: "server" }, true);
                return;
            }
            if (selectedSubtitle(decision.plan) !== selected.subtitle?.id || decision.plan.subtitle.mode === "unknown") {
                this.state = { phase: "idle" };
                this.host.fail({
                    kind: "terminal",
                    reason: "subtitle_selection_unavailable",
                    message: "The selected subtitles are no longer available. Choose another track in Details.",
                    retryable: false,
                }, true);
                return;
            }
            this.host.adoptPlan(decision.plan, decision.serverFeatures, false);
            return;
        }

        if (this.state.phase === "hls_reporting") {
            this.finishSubtitleReport(decision.plan, decision.serverFeatures, selected);
            return;
        }
        if (sameDirectTransport(currentPlan, decision.plan, selected)) {
            await this.host.waitForPendingSeeks(false);
            if (!isCurrent() || this.host.snapshot().plan === undefined) return;
            this.applyKeptSubtitle(decision.plan, decision.serverFeatures);
            return;
        }
        if (this.state.phase === "direct_embedded_switching") {
            await this.host.waitForPendingSeeks(true);
            if (!isCurrent()) return;
            this.host.adoptPlan(decision.plan, decision.serverFeatures, true);
            return;
        }
        this.host.adoptPlan(decision.plan, decision.serverFeatures, false);
    }

    private handleReplanError(plan: PlaybackPlan, selected: SelectedTracks, error: unknown): void {
        const snap = this.host.snapshot();
        if (snap.plan === undefined || (!snap.started && this.nativeUnavailable)) {
            this.state = { phase: "idle" };
            this.host.failFromStartError(error, true);
            return;
        }
        if (unanswered(error) && snap.presented && (snap.recoveryActive || (error instanceof ApiError && error.transient))) {
            const carriedQueue = this.extractQueuedAfterReopen();
            const carriedStored = this.extractPendingStored();
            const nativeOverride = this.preservedOverrideOnInterrupt(snap.plan);
            this.state = {
                phase: "idle",
                ...(nativeOverride === undefined ? {} : { nativeOverride }),
                ...(carriedQueue === undefined ? {} : { queuedAfterReopen: carriedQueue }),
                ...(carriedStored === undefined ? {} : { pendingStored: carriedStored }),
                outcome: { state: "failed" },
            };
            this.host.recoverConnection();
            return;
        }
        if (error instanceof ApiError && !error.transient && error.failure.kind !== "invalid_response" && !sessionGone(error)) {
            if (this.tryEmbeddedSwitchFallback(plan, selected)) return;
            this.settleRefusedOrFailed(snap.plan, { state: "failed" });
            return;
        }
        this.state = { phase: "idle" };
        this.host.sessionFailure(error);
    }

    private handleAdaptationUnavailable(
        plan: PlaybackPlan,
        selected: SelectedTracks,
        decision: Extract<PlaybackDecision, { readonly outcome: "adaptation_unavailable" }>,
    ): void {
        const snap = this.host.snapshot();
        if (snap.plan === undefined || (!snap.started && this.nativeUnavailable)) {
            this.state = { phase: "idle" };
            this.host.failFromDecision(decision, true);
            return;
        }
        if (this.tryEmbeddedSwitchFallback(plan, selected)) return;
        this.settleRefusedOrFailed(snap.plan, { state: "refused", message: decision.terminal.message });
    }

    private settleRefusedOrFailed(
        plan: PlaybackPlan | undefined,
        outcome: { readonly state: "refused"; readonly message: string } | { readonly state: "failed" },
    ): void {
        const prev = this.state;
        const nativeOverride = this.preservedOverrideOnInterrupt(plan);
        const pendingPick = this.extractPendingPick();
        const carriedQueue = prev.phase === "replanning_blocking" ? prev.queuedAfterReopen : undefined;
        const pendingStored = this.extractPendingStored();
        const postSettle = this.postSettleOf(prev);
        this.tools.notifyDroppedStored(pendingStored);
        this.state = {
            phase: "idle",
            ...(nativeOverride === undefined ? {} : { nativeOverride }),
            ...(carriedQueue === undefined ? {} : { queuedAfterReopen: carriedQueue }),
            outcome,
        };
        this.finishSettlement(prev.phase === "direct_embedded_switching", postSettle, pendingPick, undefined);
    }

    private finishSubtitleReport(next: PlaybackPlan, serverFeatures: readonly string[], reported: SelectedTracks): void {
        if (this.state.phase !== "hls_reporting") return;
        const state = this.state;
        const current = this.host.snapshot().plan;
        const reportedId = reported.subtitle?.id;
        const pending = state.pending;
        const kept = current !== undefined && keepsHlsTransport(current, next);

        if (pending !== undefined && (pending.id !== reportedId || !pending.applied)) {
            this.finishSupersededReport(state, next, serverFeatures, pending, kept);
            return;
        }
        if (state.endedWhileOut && !kept) {
            this.state = { phase: "idle" };
            this.host.settleSwitch(false, { kind: "complete_stream" });
            return;
        }
        if (kept && streamRenditionAnswer(next, state.appliedOverride.id ?? reportedId)) {
            const postSettle = this.postSettleOf(state);
            this.rememberKeptPlan(next, serverFeatures);
            this.state = { phase: "idle" };
            this.finishSettlement(false, postSettle, undefined, undefined);
            return;
        }
        if (current !== undefined && sameDirectTransport(current, next, reported)) {
            this.applyKeptSubtitle(next, serverFeatures);
            return;
        }
        this.state = { phase: "idle" };
        this.host.adoptPlan(next, serverFeatures, false);
    }

    private finishSupersededReport(
        state: Extract<SubtitleSwitchState, { readonly phase: "hls_reporting" }>,
        next: PlaybackPlan,
        serverFeatures: readonly string[],
        pending: { readonly id: string | undefined; readonly applied: boolean },
        kept: boolean,
    ): void {
        state.pending = undefined;
        if (!kept || state.endedWhileOut) {
            this.state = { phase: "idle", queuedAfterReopen: { id: pending.id } };
            if (state.endedWhileOut) this.host.settleSwitch(false, { kind: "complete_stream" });
            else this.host.adoptPlan(next, serverFeatures, false);
            return;
        }
        this.rememberKeptPlan(next, serverFeatures);
        if (!pending.applied || !renditionSwitch(next, pending.id)) {
            if (!this.applyStreamSubtitle(next, selectedSubtitle(next))) {
                this.state = { phase: "idle", queuedAfterReopen: { id: pending.id } };
                this.host.adoptPlan(next, serverFeatures, false);
                return;
            }
            this.state = { phase: "idle" };
            this.host.releaseBusyForReselect();
            this.selectSubtitle(pending.id);
            return;
        }
        state.reportedId = pending.id;
        state.restoreId = selectedSubtitle(next);
        state.appliedOverride = { id: pending.id };
        const audio = next.selectedTracks.audio;
        const selected: SelectedTracks = { ...(audio === undefined ? {} : { audio }), ...(pending.id === undefined ? {} : { subtitle: { id: pending.id } }) };
        this.host.beginSwitch("reporting");
        void this.executeReplan(next, selected, "hls_reporting");
    }

    private applyKeptSubtitle(next: PlaybackPlan, serverFeatures: readonly string[]): void {
        const prev = this.state;
        const pendingPick = this.extractPendingPick();
        const pendingStored = this.extractPendingStored();
        const postSettle = this.postSettleOf(prev);
        this.host.nativeText.setSilentSubtitle(true);
        this.rememberKeptPlan(next, serverFeatures);
        const keptInventory = postSettle.kind !== "complete_stream";
        if (!keptInventory) this.tools.notifyDroppedStored(pendingStored);
        this.state = { phase: "idle" };
        this.finishSettlement(prev.phase === "direct_embedded_switching", postSettle, pendingPick, keptInventory ? pendingStored : undefined);
    }

    private rememberKeptPlan(plan: PlaybackPlan, serverFeatures: readonly string[]): void {
        this.host.keepPlan(plan, serverFeatures);
        this.tools.adoptSync(plan);
        this.readCaptionsFor(plan);
    }

    private finishSettlement(
        keepBusyIfSeeking: boolean,
        postSettle: SubtitlePostSettle,
        pendingPick: TrackOverride | undefined,
        keptStored: PendingStoredTrack | undefined,
    ): void {
        if (postSettle.kind === "recover_route" && this.state.phase === "idle") {
            if (pendingPick !== undefined) this.state.queuedAfterReopen = pendingPick;
            if (keptStored !== undefined) this.state.pendingStored = keptStored;
        }
        this.host.settleSwitch(keepBusyIfSeeking, postSettle);
        if (postSettle.kind !== "none") return;

        const snap = this.host.snapshot();
        if (pendingPick !== undefined) {
            if (!snap.busy) this.selectSubtitle(pendingPick.id);
            else if (this.state.phase === "idle") this.state.deferredPick = pendingPick;
        }
        const afterPick = this.host.snapshot();
        if (keptStored !== undefined && afterPick.plan !== undefined && !afterPick.busy && this.state.phase === "idle") {
            this.tools.activateStored(afterPick.plan, keptStored, trackId => this.selectSubtitle(trackId));
        }
        if (!this.host.snapshot().busy && this.state.phase === "idle") {
            this.host.flushQueuedReanchor();
        }
    }

    private preservedOverrideOnInterrupt(plan: PlaybackPlan | undefined): TrackOverride | undefined {
        if (this.state.phase === "hls_reporting") return this.restoreReportedSubtitle(plan);
        if (this.state.phase === "direct_embedded_switching") {
            return this.state.localFallback.mode === "active_native"
                ? { id: this.state.localFallback.overrideId }
                : this.state.priorOverride;
        }
        if (this.state.phase === "replanning_blocking") return this.state.priorOverride;
        return this.state.nativeOverride;
    }

    private restoreReportedSubtitle(plan: PlaybackPlan | undefined): TrackOverride | undefined {
        if (this.state.phase !== "hls_reporting") return undefined;
        const restoreId = this.state.restoreId;
        if (plan !== undefined && !this.applyStreamSubtitle(plan, restoreId) && plan.subtitle.artifact !== undefined) {
            this.host.nativeText.setSilentSubtitle(true);
            this.readCaptionsFor(plan);
            return undefined;
        }
        return { id: restoreId };
    }

    private tryEmbeddedSwitchFallback(plan: PlaybackPlan, selected: SelectedTracks): boolean {
        if (this.state.phase !== "direct_embedded_switching") return false;
        const id = selected.subtitle?.id;
        const snap = this.host.snapshot();
        if (id === undefined || !snap.started || snap.plan !== plan || !loadsEmbeddedFile(plan, id)) return false;
        if (!this.applyStreamSubtitle(plan, id)) return false;
        this.host.nativeText.setSilentSubtitle(false);
        const prev = this.state;
        const pendingPick = this.extractPendingPick();
        const postSettle = this.postSettleOf(prev);
        this.state = { phase: "idle", nativeOverride: { id } };
        this.finishSettlement(true, postSettle, pendingPick, undefined);
        return true;
    }

    private async replayDirectSwitch(
        plan: PlaybackPlan,
        selected: SelectedTracks,
        replan: PreparedTrackReplan,
        current: () => boolean,
    ): Promise<PlaybackDecision> {
        const deadline = (): number =>
            this.state.phase === "direct_embedded_switching" && this.state.failureWait !== undefined
                ? this.state.failureWait.failedAtMs + SWITCH_FAILURE_DEADLINE_MS
                : Number.POSITIVE_INFINITY;
        const waitUntil = (until: number): Promise<void> =>
            sleep(this.clock, Math.max(0, Math.min(until, deadline()) - this.clock.now()), this.signal, abortedError);

        for (let index = 0; ; index++) {
            try {
                return await replan.send();
            } catch (error) {
                if (!(error instanceof ApiError) || !unanswered(error) || error.aborted || !current()) throw error;
                if (this.state.phase !== "direct_embedded_switching") throw abortedError();
                if (this.clock.now() >= deadline()) {
                    this.state = { phase: "idle" };
                    this.host.fail({ kind: "playback_failed" }, true);
                    throw error;
                }
                await this.waitBeforeNextReplay(plan, selected, error, index, waitUntil);
                if (!current() || this.state.phase !== "direct_embedded_switching") throw abortedError();
                if (this.clock.now() >= deadline()) {
                    this.state = { phase: "idle" };
                    this.host.fail({ kind: "playback_failed" }, true);
                    throw error;
                }
            }
        }
    }

    private async waitBeforeNextReplay(
        plan: PlaybackPlan,
        selected: SelectedTracks,
        error: ApiError,
        index: number,
        waitUntil: (until: number) => Promise<void>,
    ): Promise<void> {
        if (this.state.phase !== "direct_embedded_switching") return;
        const quick = RESEND_DELAYS_MS[index];
        if (quick === undefined && this.state.localFallback.mode !== "active_native" && selected.subtitle?.id !== undefined) {
            this.drawSwitchLocally(plan, selected.subtitle.id);
        }
        if (this.state.phase !== "direct_embedded_switching") return;
        if (!this.state.noteShown && this.clock.now() - this.state.sentAtMs >= SWITCH_NOTE_AFTER_MS) {
            this.state.noteShown = true;
            this.captions.setNotice(CAPTION_FAILED);
            if (this.state.failureWait === undefined) this.notifyChanged();
        }
        const backoff = quick
            ?? SWITCH_REPLAY_DELAYS_MS[Math.min(index - RESEND_DELAYS_MS.length, SWITCH_REPLAY_DELAYS_MS.length - 1)]
            ?? REPLAN_LEASE_MS;
        const serverWait = Math.max(error.problemId === "replan_in_progress" ? REPLAN_LEASE_MS : 0, (error.retryAfterSeconds ?? 0) * 1000);
        const serverReady = this.clock.now() + serverWait;
        const wakeDue = (): boolean =>
            this.state.phase === "direct_embedded_switching" && this.state.failureWait !== undefined && !this.state.failureWait.wakeUsed;
        if (!wakeDue()) {
            const sleepUntil = this.clock.now() + Math.max(backoff, serverWait);
            if (this.state.failureWait?.wakeUsed === true) {
                await waitUntil(sleepUntil);
            } else {
                const switchState = this.state;
                const woken = new Promise<void>(resolve => { switchState.wake = resolve; });
                try {
                    await Promise.race([waitUntil(sleepUntil), woken]);
                } finally {
                    switchState.wake = undefined;
                }
            }
        }
        if (wakeDue() && this.state.phase === "direct_embedded_switching" && this.state.failureWait !== undefined) {
            this.state.failureWait.wakeUsed = true;
            await waitUntil(serverReady);
        }
    }

    private drawSwitchLocally(plan: PlaybackPlan, trackId: string): void {
        if (this.state.phase !== "direct_embedded_switching") return;
        const snap = this.host.snapshot();
        let drawn = snap.plan === plan && loadsEmbeddedFile(plan, trackId) && this.applyStreamSubtitle(plan, trackId);
        if (drawn && !this.host.nativeText.setSilentSubtitle(false)) drawn = false;
        if (!drawn) {
            this.state.localFallback = { mode: "deferred_redraw", plan, trackId };
            return;
        }
        this.state.localFallback = { mode: "active_native", overrideId: trackId };
        if (this.state.failureWait === undefined) this.notifyChanged();
    }

    private async resend<T>(send: () => Promise<T>, current: () => boolean): Promise<T> {
        for (let index = 0; ; index++) {
            try {
                return await send();
            } catch (error) {
                const delay = RESEND_DELAYS_MS[index];
                if (!(error instanceof ApiError) || !error.transient || delay === undefined || !current()) throw error;
                await sleep(this.clock, Math.max(delay, (error.retryAfterSeconds ?? 0) * 1000), this.signal, abortedError);
                if (!current()) throw abortedError();
            }
        }
    }

    // --- Native text & sidecar fallback helpers ---

    private applyStreamSubtitle(plan: PlaybackPlan, trackId: string | undefined): boolean {
        const nativeText = this.host.nativeText;
        if (!nativeText.canSelectInStream) return false;
        if (trackId === undefined) {
            if (!renditionSwitch(plan, undefined) || !nativeText.setSilentSubtitle(true)) return false;
            this.captions.clearOverlay();
            return true;
        }
        const row = plan.subtitle.inventory.find(entry => entry.trackId === trackId);
        if (row === undefined || !inStreamCandidate(plan, row)) return false;
        const tracks = nativeText.listTextTracks();
        if (tracks === undefined) return false;
        const index = textTrackIndex(tracks, row, plan.delivery === "original_http");
        if (index === undefined || !nativeText.selectTextTrack(index)) return false;
        nativeText.setSilentSubtitle(false);
        this.captions.clearOverlay();
        return true;
    }

    private nativeCaptionFallback(loaded: PlaybackPlan): boolean {
        const snap = this.host.snapshot();
        const plan = snap.plan;
        const id = loaded.subtitle.trackId;
        if (plan === undefined || id === undefined || plan.subtitle.trackId !== id || this.shownSubtitleId(plan) !== id) return false;
        const currentArt = plan.subtitle.mode === "render" || plan.subtitle.mode === "convert" ? plan.subtitle.artifact : undefined;
        const loadedArt = loaded.subtitle.mode === "render" || loaded.subtitle.mode === "convert" ? loaded.subtitle.artifact : undefined;
        if (currentArt === undefined || loadedArt === undefined || currentArt.url !== loadedArt.url || currentArt.format !== loadedArt.format || currentArt.origin !== loadedArt.origin) {
            return false;
        }
        const row = plan.subtitle.inventory.find(entry => entry.trackId === id);
        if (plan.delivery !== "original_http" || row === undefined || !inStreamCandidate(plan, row)) return false;
        if (!this.applyStreamSubtitle(plan, id)) {
            if (snap.started) return false;
            this.captions.setCaptionFallback(id);
            return true;
        }
        this.host.nativeText.setSilentSubtitle(false);
        return true;
    }

    private applyCaptionFallback(plan: PlaybackPlan): void {
        const id = this.captions.consumeCaptionFallback();
        if (id === undefined || this.shownSubtitleId(plan) !== id) return;
        if (this.applyStreamSubtitle(plan, id)) this.host.nativeText.setSilentSubtitle(false);
        else this.captions.setNotice(CAPTION_FAILED);
    }

    private restoreNativeVisibility(): void {
        const override = this.activeNativeOverride();
        if (override?.id !== undefined) {
            this.host.nativeText.setSilentSubtitle(false);
            return;
        }
        if (this.captions.captionKey === undefined || override !== undefined) return;
        this.host.nativeText.setSilentSubtitle(true);
    }

    private refetchCaptionsForSync(key: string): void {
        const plan = this.host.snapshot().plan;
        if (plan === undefined || this.destroyed) return;
        this.captions.refetchForTiming(plan, key, this.tools.timingVersion(key), syncKey => this.tools.timingVersion(syncKey), loaded => this.nativeCaptionFallback(loaded));
    }

    private readCaptionsFor(plan: PlaybackPlan): void {
        this.captions.readPrimary(plan, key => this.tools.timingVersion(key), loaded => this.nativeCaptionFallback(loaded));
    }

    private attachDownloaded(id: string): boolean {
        const snap = this.host.snapshot();
        const plan = snap.plan;
        if (!snap.live || this.destroyed || plan === undefined || snap.hidden || snap.restoring) return false;
        const track = plan.subtitle.inventory.find(entry => entry.syncKey === `stored-${id}`);
        if (track !== undefined) {
            if (!snap.started || snap.busy || track.unplayable === true) return false;
            this.selectSubtitle(track.trackId);
            return true;
        }
        if (!snap.started || snap.busy) return false;
        this.startBlockingReplan(plan, this.chosenTracks(plan), "stored_inventory_refresh", this.shownSubtitleId(plan), true, { kind: "download", id });
        return true;
    }

    private async readSubtitlePreferences(plan: PlaybackPlan): Promise<SubtitlePreferences> {
        const preferences = await this.session.call({
            ...operations.preplaySubtitlePreferences(this.request.contentId, plan.effectiveMediaFileId, plan.selectedTracks.audio?.id),
            profileScoped: true,
            signal: this.signal,
        });
        if (this.alive() && this.orderingLanguage !== preferences.language) {
            this.orderingLanguage = preferences.language;
            this.notifyChanged();
        }
        return preferences;
    }

    // --- Projection & state helpers ---

    private subtitleOverlay(plan: PlaybackPlan): boolean {
        const id = this.shownSubtitleId(plan);
        if (id === undefined) return true;
        if (plan.subtitle.mode === "burn_in") return false;
        if (id === plan.subtitle.trackId && (this.captions.captionKey !== undefined || this.captions.captionNotice === CAPTION_FAILED)) return true;
        const row = plan.subtitle.inventory.find(entry => entry.trackId === id);
        return row === undefined || !inStreamCandidate(plan, row);
    }

    private captionInstant(plan: PlaybackPlan): number {
        const syncSeconds = this.captions.syncDelayMs / 1000;
        const ms = this.host.readPlayerTimeMs();
        return (ms !== undefined ? ms / 1000 + plan.timeline.timelineOffsetSeconds : this.host.snapshot().sourceSeconds) - syncSeconds;
    }

    private subtitleTrackChange(): TrackChange {
        switch (this.state.phase) {
            case "direct_embedded_switching": return { state: "changing", kind: "subtitle" };
            case "replanning_blocking": return { state: "changing" };
            case "hls_reporting": return { state: "idle" };
            case "idle": return this.state.outcome ?? { state: "idle" };
            default: {
                const unexpected: never = this.state;
                return unexpected;
            }
        }
    }

    private activeNativeOverride(): TrackOverride | undefined {
        if (this.state.phase === "idle") return this.state.nativeOverride;
        if (this.state.phase === "hls_reporting") return this.state.appliedOverride;
        if (this.state.phase === "direct_embedded_switching") {
            return this.state.localFallback.mode === "active_native"
                ? { id: this.state.localFallback.overrideId }
                : this.state.priorOverride;
        }
        return this.state.priorOverride;
    }

    private extractPendingPick(): TrackOverride | undefined {
        if (this.state.phase === "hls_reporting" && this.state.pending !== undefined) return { id: this.state.pending.id };
        if (this.state.phase === "direct_embedded_switching" && this.state.pending !== undefined) return { id: this.state.pending.id };
        return undefined;
    }

    private extractQueuedAfterReopen(): TrackOverride | undefined {
        const pending = this.extractPendingPick();
        if (pending !== undefined) return pending;
        if (this.state.phase === "idle") return this.state.deferredPick ?? this.state.queuedAfterReopen;
        if (this.state.phase === "replanning_blocking") return this.state.queuedAfterReopen;
        return undefined;
    }

    private extractPendingStored(): PendingStoredTrack | undefined {
        if (this.state.phase === "idle" || this.state.phase === "replanning_blocking") return this.state.pendingStored;
        return undefined;
    }

    private postSettleOf(state: SubtitleSwitchState): SubtitlePostSettle {
        if (state.phase === "idle") return { kind: "none" };
        if (state.phase === "direct_embedded_switching") {
            return state.failureWait !== undefined
                ? { kind: "recover_route", classification: state.failureWait.classification }
                : { kind: "none" };
        }
        if (state.endedWhileOut) return { kind: "complete_stream" };
        if (state.routeFailure !== undefined) return { kind: "recover_route", classification: state.routeFailure };
        return { kind: "none" };
    }

    private wakePendingDirectSwitch(): void {
        if (this.state.phase === "direct_embedded_switching") {
            const wake = this.state.wake;
            this.state.wake = undefined;
            wake?.();
        }
    }

    private canStartTrackChange(snap: SubtitleTransportSnapshot): boolean {
        return snap.live && !this.destroyed && snap.started && !snap.busy && this.state.phase === "idle";
    }

    private alive(): boolean {
        return !this.destroyed && !this.signal.aborted && this.host.snapshot().live;
    }

    private notifyChanged(): void {
        if (!this.destroyed) this.host.changed();
    }
}
