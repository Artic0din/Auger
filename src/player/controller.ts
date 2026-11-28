// The one owner of native playback: capability read, server planning (start, replan), the AVPlay
// transport, progress, stop, timers and cancellation. The server chooses every route; this client
// reports failures and positions and replays opaque plan identities unchanged.
//
// Identities (protocol v3 §6, §9): one playback_attempt_id per play() for its start and every
// replan; one plan_attempt_id per adopted plan; a fresh replan_request_id per replan, kept on its
// resends; a fresh stop_id per stop, kept on its resends. Every AVPlay callback and every answer
// is checked against the attempt and transport it was made for, because the platform cannot
// cancel them: a late one is dropped, never played or reported.
//
// Authority: every request carries the authority signal from when the attempt began, so a
// sign-out or profile switch aborts it and nothing more is sent for the old profile.
//
// Tracks (#11): a choice is a server track_change replan naming the server's own identity: a
// subtitle inventory track_id, or `file:{effective file}:audio:{n}` for the version's nth
// audio_tracks entry. The server request never carries an AVPlay index. When the open stream
// already lists the embedded text row, AVPlay setSelectTrack switches it without a new open.
// A direct-play sidecar or Off on the same stream path stays on that open picture too: this
// overlay draws the VTT, so the plan does not need a new AVPlay open. A renewed `st` on that
// path is the same media. A different path, an audio change, a native embedded selection, or
// a burn-in still reopens. A refused change leaves the current plan playing.
// On an original file, AVPlay then plays the plan's audio ordinal (client_selected_audio_track_v1, #507).

import { type MessageKey, translate } from "../i18n/translate.ts";
import { type Clock, sleep } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { abortedError, type RequestSpec } from "../api/http.ts";
import { operations } from "../api/operations.ts";
import { isPermittedUrl } from "../api/serverUrl.ts";
import { CONNECTION_SPEED_FEATURE } from "../contracts/v2/connectionSpeed.ts";
import type { FileVersionTracks, PlaybackCapabilities, PlaybackDecision, PlaybackDefaults, PlaybackMutation, PlaybackPlan, ReplanOperation, ReplanPlaybackBody, SelectedTracks, StartPlaybackBody, TrackIdentity } from "../contracts/v2/playback.ts";
import type { PublicStorage, RandomBytes } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import type { AVPlay, AVPlayListener } from "./avplay.ts";
import { type PendingTransport, transportLock } from "./avplayTransport.ts";
import { bandwidthReadings, FALLBACK_MAX_AGE_SECONDS, readingsKey } from "./bandwidthReadings.ts";
import { BUFFERING_QUALITY_FEATURE, clientCapabilities, clientFeatures, HLS_SUBTITLE_RENDITIONS_ALL_FEATURE, hdrPanelFor, playbackContext, probeHdr, probeUhd, resolutionFor, type HdrPanel, type HdrProbe, type PanelResolution } from "./capabilities.ts";
import { BufferingBridge, type BufferingNoticeView, type BufferingPillView } from "./bufferingBridge.ts";
import { storedSpeed, type BufferingEvidenceTrace, type SpeedEvidence } from "./bufferingEvidence.ts";
import { AUTO_QUALITY, DEFAULT_BUFFERING_QUALITY_MODE, type BufferingQualityMode, type ReplanRequest } from "./bufferingQuality.ts";
import type { BufferingSnapshot } from "./bufferingSignals.ts";
import { SeekThumbnails, type ThumbnailSheetLoader } from "./seekThumbnails.ts";
import { AUTO_NEXT_KEY, HDR_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SEEK_KEYS, profileSettings } from "../contracts/v2/settings.ts";
import type { SeekThumbnail } from "../contracts/v2/trickplay.ts";
import { markerAt, type SkipMarker, type TimelineMarker } from "../contracts/v2/markers.ts";
import { currentNetwork } from "../ui/connectionSpeed.ts";
import { episodeDetailPresentation, type EpisodeSpoilerSettings, present } from "../ui/episodeSpoilers.ts";
import { nextEpisode, onDeckPlays, readOnDeck } from "./nextEpisode.ts";
import type { ResolutionCap } from "../ui/resolutionCap.ts";
import { NEXT_UP_KEY } from "../contracts/v2/settings.ts";
import { BUFFERING_MODE_KEY, INTRO_SKIP_KEY, CREDITS_SKIP_KEY } from "../contracts/v2/settingsRows.ts";
import { advanceShufflePick, nextShufflePart, refreshShuffle, shufflePick, skipShuffle } from "./nextShuffle.ts";
import type { Shuffle } from "../contracts/v2/shuffle.ts";
import type { SubtitleAIView } from "./subtitleAI.ts";
import type { AIMenu } from "./subtitleAIRoute.ts";
import type { SyncTimingView } from "./subtitleSync.ts";
import type { SubtitleDisplayView } from "./subtitleDisplay.ts";
import type { SubtitleSearchView } from "./subtitleSearch.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { CatalogSubtitleTrack, SubtitleIntent, SubtitlePreferences } from "../contracts/v2/preplaySubtitles.ts";
import { PlaybackRecovery, recoveryVerdict, type RecoveryStep, type RecoveryVerdict, unanswered } from "./playbackRecovery.ts";
import { audioRow, qualityMenuLabel } from "./trackLabels.ts";
import { HUDState } from "./hudState.ts";
import { textIsRightToLeft } from "../i18n/direction.ts";
import { UP_NEXT_PREVIEW, upNextPreviewLeft } from "./upNextPreview.ts";
import { type LiveStats, type PlaybackStatus, planStats, videoOptions, type PlayerHUD } from "./playerHUD.ts";
import { PlayerSettingsFlusher, sessionPlayerSettingsTransport } from "./playerSettingsFlusher.ts";
import { DEFAULT_STILL_WATCHING_THRESHOLD, PlayerStillWatchingGuard } from "./stillWatchingGuard.ts";
import type { DiagnosticsPlanDetails } from "../diagnostics.ts";
import {
    type AudioFormatEvidence, type CaptionLoadState, cleanIncidentCode, type MediaEvidence, type MediaFailure, type MediaFailureStage,
    type MediaSwitchEvidence, type MediaSwitchResult, type PlaybackAttemptTrace, type PlaybackStage, type PlaybackTraceFailure, type TraceStepResult,
} from "../diagnosticsIncident.ts";
import { readAvplayAudio } from "./mediaEvidence.ts";
import {
    orderedInventory,
    parseAVPlayTextTracks,
    SubtitleSession,
    subtitleStart,
    unsupportedFormat,
} from "./subtitleSession.ts";
import type {
    NativeTextPort,
    SubtitleHost,
    SubtitlePostSettle,
    SubtitleToolAction,
    TrackChange,
    TrackChoice,
} from "./subtitleTypes.ts";

export { orderedInventory, unsupportedFormat, type SubtitleToolAction, type TrackChange, type TrackChoice };

/** What browse hands over: one file of one catalog item. */
export interface PlayRequest {
    readonly overview?: string | undefined;
    /** Up Next's metadata line: the season row's air date and runtime in minutes (PlayerView.episodeMetadataLine). */
    readonly airDate?: string | undefined;
    readonly runtimeMinutes?: number | undefined;
    readonly backdropUrl?: string | undefined;
    /** False for series key art. Absent or true is an episode still. */
    readonly backdropIsEpisodeStill?: boolean | undefined;
    /** On Deck blurs this still. Series art stays sharp. */
    readonly hideBackdrop?: true;
    readonly seriesTitle?: string | undefined;
    readonly seasonNumber?: number | undefined;
    readonly episodeNumber?: number | undefined;
    readonly shuffleId?: string;
    readonly shuffleScopeLabel?: string | undefined;
    readonly episode?: true;
    /** Watch progress for the Up Next synopsis and On Deck progress bar. Absent means the item has not started. */
    readonly watch?: { readonly played: boolean; readonly isInProgress?: boolean; readonly positionSeconds?: number };
    /** Cosmetic card fallback position for On Deck progress bars when watch detail carries none, kept separate from spoiler watch state. */
    readonly thumbnailPositionSeconds?: number | undefined;
    /** Media duration in seconds for On Deck thumbnail progress bars. */
    readonly durationSeconds?: number | undefined;
    readonly audioTrackId?: string;
    readonly subtitle?: SubtitleIntent;
    /** Catalog rows used to name a subtitle before start. Absent when the version published none. */
    readonly subtitleTracks?: readonly CatalogSubtitleTrack[];
    /** Effective subtitle preferences already on the version, so Auto can be named before start. */
    readonly subtitlePreferences?: SubtitlePreferences;
    readonly allowAlternateVersions?: false;
    /** Synchronized Watch Party playback keeps normal seek/EOF behavior for Skip Credits (#795). */
    readonly watchParty?: true;
    readonly contentId: string;
    readonly fileId: string;
    readonly title: string;
    /** Source seconds; undefined lets the server resume from the profile's saved position. */
    readonly startSeconds: number | undefined;
}

export type EndReason = "completed" | "ended_by_server" | "authority_changed";

export type PlaybackError =
    | { readonly kind: "settings" }
    /** The server has no native playback for this client (not configured, not allowed, no protocol 3). */
    | { readonly kind: "unavailable" }
    /** The server decided this file cannot play here. */
    | { readonly kind: "terminal"; readonly reason: string; readonly message: string; readonly retryable: boolean }
    /** Every route the server offered failed on this TV. */
    | { readonly kind: "playback_failed" }
    /** Media or API unreachable. Reconnecting belongs to recovery (#13). */
    | { readonly kind: "network"; readonly noResponse?: true }
    /** The server no longer knows the session (expired or restarted). Recovery belongs to #13. */
    | { readonly kind: "session_expired" }
    | { readonly kind: "installation_changed" }
    | { readonly kind: "revoked" }
    | { readonly kind: "backgrounded" }
    | { readonly kind: "server"; readonly reason?: ServerReason };

/**
 * Why the server refused, kept as data so the error page words it in the shown language: the HTTP status with the
 * problem's type and first field code, or the update prompt for client_upgrade_required. A problem's detail and title
 * are left out: they are server free text, which can carry URLs, addresses or credentials onto a shared screen.
 */
export type ServerReason =
    | { readonly status: number; readonly problemId?: string; readonly fieldCode?: string }
    | { readonly update: true };

export interface PlaybackExits {
    onBack(): void;
    /** `completed` comes only from AVPlay's stream-completed callback. */
    onEnd(reason: EndReason): void;
    /** After the viewer dismissed the error the player showed. */
    onError(error: PlaybackError): void;
}

export type AudioTracks = { readonly state: "loading" } | { readonly state: "failed" } | { readonly state: "ready"; readonly choices: readonly TrackChoice[] };

export interface TrackView {
    readonly ai?: SubtitleAIView | undefined;
    /** The AI Subtitles… menu, present only when the server and this file offer something to run. */
    readonly aiMenu?: { readonly menu: AIMenu; /** Shown while a language relies on transcription. */ readonly quota: string | undefined; readonly quotaExhausted: boolean } | undefined;
    readonly quality?: { readonly choices: readonly TrackChoice[]; readonly selectedId: string | undefined };
    readonly audio: AudioTracks;
    readonly selectedAudioId: string | undefined;
    readonly subtitles: readonly TrackChoice[];
    /** Undefined: subtitles off. */
    readonly selectedSubtitleId: string | undefined;
    readonly subtitleMode: string;
    readonly change: TrackChange;
    /** A subtitle report is in flight. Subtitle choices can still queue; other track actions wait. */
    readonly reporting?: boolean;
    readonly notices: readonly string[];
    readonly subtitleTools?: { readonly search: SubtitleSearchView; readonly display?: SubtitleDisplayView; readonly overlay: boolean };
    /** The selected subtitle's Sync to Audio and Reset Timing state, when the server can retime it. */
    readonly syncTiming?: SyncTimingView | undefined;
    /** SECONDARY: other text tracks the app can draw under the primary one; present only while the app draws the primary. */
    readonly secondary?: { readonly choices: readonly TrackChoice[]; readonly selectedId: string | undefined } | undefined;
}

/** Apple's buffering prompt, undo pill and notice, drawn over loading and playback alike. */
export interface BufferingOverlay {
    readonly bufferingPill?: BufferingPillView | undefined;
    readonly bufferingNotice?: BufferingNoticeView | undefined;
}

export type PlaybackView =
    /**
     * `status` is the card's status line (Apple's statusLabel) as a catalog key, so a language change redraws it; `shuffle` words the card
     * for a Shuffle, as Apple's does; `failure: "session"` marks a failed state that came from ending the session, before any lookup.
     */
    | { readonly phase: "completion"; readonly status: MessageKey; readonly state: "finalizing" | "resolving" | "ready" | "failed"; readonly next: PlayRequest | undefined; readonly retryable: boolean; readonly countdown?: number | undefined; readonly deck?: readonly PlayRequest[]; readonly shuffle?: true; readonly shuffleScopeLabel?: string | undefined; readonly shuffleActionError?: MessageKey | undefined; readonly failure?: "session"; readonly autoNext?: boolean }
    | ({ readonly phase: "loading"; readonly title: string; readonly detail?: "reconnecting" | "restoring"; /** A different file of a Shuffle pick follows: the screen forgets the last file's skip decisions. */ readonly nextPart?: true } & BufferingOverlay)
    | ({
          readonly phase: "playing" | "paused";
          readonly seriesTitle?: string | undefined;
          readonly seasonNumber?: number | undefined;
          readonly episodeNumber?: number | undefined;
          readonly title: string;
          /** Source time. */
          readonly positionSeconds: number;
          readonly durationSeconds: number | undefined;
          readonly buffering: boolean;
          /** Apple's episodes icon: a next episode, On Deck row, in-flight read, or a failed read that can be tried again. */
          readonly episodes?: boolean;
          readonly upNext?: { readonly next: PlayRequest | undefined; readonly deck: readonly PlayRequest[]; readonly countdown: number | undefined; /** The countdown's full length, for the ring (Apple's `nextUpCountdownTotalSeconds`). */ readonly countdownTotal?: number; readonly status: string; readonly loading?: boolean; readonly failed?: boolean; readonly shuffle?: true };
          readonly resumePending?: boolean;
          readonly transportCommandCount?: number;
          readonly tracks: TrackView;
          readonly hud?: PlayerHUD;
          readonly seekIntervals: { readonly backward: number; readonly forward: number };
          readonly previewKey?: string | undefined;
          /** `status`, `cueCount` and `instant` expose why the layer is empty: no sidecar, still loading, failed, or ready at this clock reading. */
          readonly captions?: { readonly text: string; /** The second line, from Secondary. */ readonly secondaryText?: string; readonly appearance: SubtitleAppearance; readonly status?: "none" | "loading" | "failed" | "ready"; readonly cueCount?: number; readonly instant?: number } | undefined;
          readonly skipMarker?: SkipMarker | undefined;
          readonly markers?: readonly TimelineMarker[] | undefined;
          readonly undoSkipSeconds?: number | undefined;
      } & BufferingOverlay)
    | { readonly phase: "error"; readonly title: string; readonly error: PlaybackError; readonly retryable?: boolean }
    | { readonly phase: "closed" };

/** What the player screen drives. */
export interface PlayerControls {
    setVideo(kind: "speed" | "aspect", value: string): void;
    toggleAutoNext(): void;
    retryChapters(): void;
    subscribe(listener: (view: PlaybackView) => void): () => void;
    togglePause(): void;
    setPaused(paused: boolean): void;
    /** Source seconds, negative to go back. */
    seekBy(seconds: number): void;
    seekToSeconds(seconds: number): void;
    /** PlayerViewModel.performCreditsSkip: opens Up Next with a fixed 10 s countdown when credits reach EOF (#795). */
    skipCredits(seconds: number): void;
    back(): void;
    /** Ends the attempt. Visibility uses suspend/restore instead. */
    background(): void;
    /** App hide: suspend AVPlay, keep the session, and do not rely on timers firing. */
    suspend(): void;
    /** App show: revalidate authority, then restore the pipeline or reconnect. */
    restore(): void;
    dismissError(): void;
    selectAudio(trackId: string): void;
    /** Undefined turns subtitles off. */
    selectSubtitle(trackId: string | undefined): void;
    selectQuality(preference: string): void;
    retryTrackInfo(): void;
    retrySettings(): void;
    retryCompletion(): void;
    playNext(request?: PlayRequest): void;
    /** Opens the manual Up Next panel. Apple tvOS `showNextUpNow`. */
    showUpNext(): void;
    cancelAutoplay(): void;
    /** PlayerViewModel.stopShuffling: cancels countdown, fires DELETE /shuffles/{id} without awaiting, and closes the player (#807). */
    stopShuffling(): void;
    /** PlayerViewModel.pickAnotherShufflePick: replaces the announced shuffle pick via POST /shuffles/{id}/skip (#778). */
    pickAnother(): void;
    keepWatching(): void;
    /** AI Subtitles…: one language choice; the controller picks translate, transcribe or both. */
    startSubtitleAI(language: string): void;
    /** Open: the viewer opened AI Subtitles…. Cancel stops the running job, Dismiss clears a failure or a finished job, Discard lets a request go out after one whose outcome is unknown. */
    subtitleAIAction(action: "open" | "cancel" | "dismiss" | "discard"): void;
    selectAIResult(id: string): void;
    subtitleTool(action: SubtitleToolAction): void;
    /** Sync to Audio for the subtitle with this sync key. */
    syncSubtitle(key: string): void;
    /** Reset Timing for the subtitle with this sync key. */
    resetSubtitleTiming(key: string): void;
    /** SECONDARY: undefined turns the second line off. */
    selectSecondarySubtitle(trackId: string | undefined): void;
    seekThumbnail(seconds: number, signal: AbortSignal, loadSheet: ThumbnailSheetLoader): Promise<SeekThumbnail | undefined>;
    /** Select on the buffering pill: Lower quality on the prompt, Restore quality on the undo. */
    selectBufferingPrimary(): void;
    /** Keep quality on the buffering prompt. */
    selectBufferingKeep(): void;
    /** Back with a buffering pill up. True when it took the pill down, so the press ends there. */
    dismissBufferingPill(): boolean;
    /** A skip pill is on screen: a buffering pill waits for it, as Apple's does. */
    setSkipPillShown(shown: boolean): void;
    /** A language landed: send the current playback view again, so the names built into it read in that language. */
    refreshView(): void;
}

export interface PlaybackDeps {
    readonly session: NativeSession;
    readonly avplay: AVPlay;
    readonly clock: Clock;
    readonly randomBytes: RandomBytes;
    /**
     * `webapis.productinfo.getRealModel()` and the package version, for the server's device-quirk match.
     * `probeScope` holds the `webapis` both panel probes read; absent reads the page's own.
     */
    readonly device: { readonly model: string; readonly appVersion: string; readonly probeScope?: unknown };
    readonly exits: PlaybackExits;
    /** The profile spoiler owner. Absent reads as both switches off. */
    readonly spoilers?: () => EpisodeSpoilerSettings;
    /** Public per-install storage for the once-only leftover subtitle-delay clear. Never tokens. */
    readonly publicStorage?: PublicStorage;
    /** The profile's Resolution cap. Absent reads as no cap. Next-episode, On Deck and shuffle picks rank files by it. */
    readonly resolutionCap?: Pick<ResolutionCap, "quality" | "ready">;
    /** Shared debounced, retried writer for player device settings (#810). */
    readonly settingsFlusher?: PlayerSettingsFlusher;
    /** Local Still Watching threshold (0 = Off, 1..20 consecutive auto-advances; default 3) (#796). */
    readonly stillWatchingThreshold?: () => number;
}

const PROGRESS_INTERVAL_MS = 10000;
/**
 * How long AVPlay may take to prepare a stream before the route counts as failed: a backstop for a prepare that hangs while the page still
 * runs. It cannot catch a playlist that freezes the page's JavaScript, which is checked before `open` instead (`playlistUnreadable`, #650).
 * A failed route is replanned, and the third replan that fails ends in the error page. The server keeps a fresh plan 90 s (protocol v3 §2.5).
 */
const STARTUP_TIMEOUT_MS = 15000;
/** Failed routes this client replans before giving up; the protocol allows up to 8. */
const MAX_RECOVERY_REPLANS = 3;
/** Apple's typed failure for a track its engine could not select (AetherEngine PlaybackErrorKind). */
const AUDIO_TRACK_SWITCH_FAILED = "audioTrackSwitchFailed";
/** Waits before resending an identical start, replan or stop that got no usable answer. */
const RESEND_DELAYS_MS = [1000, 2000];
/** AVPlay's display coordinates are in the app's 1920x1080 space. */
const SCREEN = { width: 1920, height: 1080 };
/** Apple tvOS `nextUpHUDCountdownThresholdSeconds`: a manual panel counts down only inside this. */
const MANUAL_COUNTDOWN_THRESHOLD_SECONDS = 100;
/** The countdown after a video ends before the next one starts (Apple's `nextUpCountdownDefaultSeconds`). */
export const AUTOPLAY_COUNTDOWN_SECONDS = 10;

type TrackInfo = { readonly state: "loading" | "failed" } | { readonly state: "ready"; readonly versions: readonly FileVersionTracks[] };

/** Plain-text notices for the plan's degradation warnings a viewer can notice (protocol v3 §7.2). */
const WARNING_NOTICES: Readonly<Record<string, string>> = {
    subtitle_burn_in: "Subtitles are burned into the video.",
    audio_track_unavailable: "The chosen audio track isn't in this version, so its default track is playing.",
    subtitle_track_unavailable: "The chosen subtitles aren't available in this version, so subtitles are off.",
};

interface Attempt {
    readonly hud: HUDState;
    /** Lower quality when buffering: the decision controller, its pill and notice. */
    readonly bufferingQuality: BufferingBridge;
    /** `playback.buffering_quality_mode`; Apple's default until the profile's value is read. */
    bufferingMode: BufferingQualityMode;
    /** The server advertises `buffering_quality_v1`: the capability response at start, then each decision. */
    bufferingAdvertised: boolean;
    /** Restore quality pressed while a replan or reload is in flight; it goes out once the player can send it. */
    bufferingRestore: ReplanRequest | undefined;
    /** The screen is drawing a skip pill. */
    skipPillShown: boolean;
    autoNextSupported: boolean;
    promptSeconds: number;
    promptSupported: boolean;
    promptDismissed: boolean;
    promptPending: boolean;
    promptLookedUp: boolean;
    prompt: { next: PlayRequest | undefined; deck: readonly PlayRequest[]; fromDeck: boolean; loading?: boolean; failed?: boolean } | undefined;
    /** AVPlay refused the picture rectangle, usually during an outstanding seek. */
    rectPending: boolean;
    /** Last rectangle handed to AVPlay so periodic prompt ticks only resize on real changes. */
    appliedRect: readonly [number, number, number, number] | undefined;
    /** Discovery shared by the episodes icon and the pre-end prompt. A seek does not cancel it. */
    offer: {
        started: boolean;
        manual: boolean;
        /** Skip Credits reached EOF: Up Next stays open over playing credits with a fixed 10 s countdown (#795). */
        credits: boolean;
        creditsCountdown: number | undefined;
        creditsDeadline: number | undefined;
        cancelCreditsTimer: (() => void) | undefined;
        episodeLoading: boolean;
        deckLoading: boolean;
        episodeSettled: boolean;
        episodeFailed: boolean;
        episode: PlayRequest | undefined;
        deckSettled: boolean;
        deckFailed: boolean;
        episodeWindowRetried: boolean;
        deckWindowRetried: boolean;
        /** On Deck has been read again after a failure (Up Next opened, or the prompt window). */
        deckRetried: boolean;
        /** Opening Up Next retries each failed part once, as the prompt window does. */
        episodeManualRetried: boolean;
        deckManualRetried: boolean;
        deck: PlayRequest[];
        /** Successor whose catalog presentation was requested. Ticks must not read it again. */
        presentationFor: string | undefined;
    };
    transportCommandCount: number;
    autoNext: boolean;
    /** Auto-play toggles advance this so an older settings read cannot overwrite them. */
    settingsEpoch: number;
    introMode: "never" | "ask" | "always";
    skipCredits: boolean;
    skippedMarkers: Set<SkipMarker>;
    /** Where Watch Intro returns to. The player screen's skip timer decides how long it is offered, as Apple's IntroSkipPrompt does. */
    undoSkip: number | undefined;
    pendingSkipUndo: number | undefined;
    readonly subtitles: SubtitleSession;
    readonly request: PlayRequest;
    playbackAttemptId: string;
    /** The session's authority signal when the attempt began. */
    readonly signal: AbortSignal;
    live: boolean;
    installationId: string | undefined;
    profileId: string | undefined;
    sessionId: string | undefined;
    plan: PlaybackPlan | undefined;
    planAttemptId: string;
    /** The scrub preview's identity: it changes only when the transport is replaced, so a kept stream keeps an active scrub (#745). */
    previewKey: string;
    /** A seek outside the window made while a subtitle switch is out: its reanchor waits for the switch's answer (#745). */
    queuedReanchorSeconds: number | undefined;
    readonly attemptedKeys: string[];
    recoveries: number;
    sequence: number;
    sourceSeconds: number;
    paused: boolean;
    qualityPreference: string;
    bandwidthCapKbps: number | undefined;
    autoBandwidthCapKbps: number | undefined;
    qualityPicked: boolean;
    seekIntervals: { readonly backward: number; readonly forward: number };
    /** Apple's default is on. A failed read of an offered HDR key forces it off. */
    hdrEnabled: boolean;
    hdrPanel: HdrPanel;
    /** Probed once per attempt, so start, every replan and a replacement start claim the same size. */
    panelResolution: PanelResolution;
    /** Most recent native AVPlay error code or exception name recorded during this attempt. */
    lastAvplayError: string | undefined;
    /** What this attempt reached and where it first failed, for incident reports; never carried into a later attempt. */
    trace: AttemptTrace;
    batchedSettings: boolean;
    serverFeatures: readonly string[];
    /** The capability response advertised `hls_subtitle_renditions_all_v1`. */
    renditionsAll: boolean;
    trickplayEnabled: boolean;
    thumbnails: SeekThumbnails | undefined;
    markers: { readonly fileId: string; segments: readonly TimelineMarker[] } | undefined;
    /** The current transport is playing or paused. */
    started: boolean;
    /** A transport of this attempt has shown a frame. Stays true across reconnects. */
    presented: boolean;
    hidden: boolean;
    /** suspend() succeeded from PLAYING or PAUSED, so restoreAsync is valid. */
    suspended: boolean;
    /** suspend() succeeded from READY, where restoreAsync is not valid. */
    suspendedReady: boolean;
    deferredOpen: boolean;
    restoring: boolean;
    /** The restoreAsync that has not answered; revalidation already cleared `restoring`. Only its own answer or the close of its transport clears it. */
    restoreOpen: object | undefined;
    /** The next open is a reconnect handoff and should say so. */
    resuming: boolean;
    recovery: PlaybackRecovery | undefined;
    recoveryPending: boolean;
    recoverySpec: ReturnType<typeof operations.replanPlayback> | undefined;
    recoveryRetryAt: number;
    cancelRecovery: (() => void) | undefined;
    /** Identical body for an unanswered replacement start. */
    replacementBody: StartPlaybackBody | undefined;
    retirePredecessor: boolean;
    resumeGeneration: number;
    progressDue: number | undefined;
    buffering: boolean;
    /** A seek or replan (including a track change) is in flight. */
    busy: boolean;
    /** The item's versions, read once per attempt for the audio menu. */
    tracks: TrackInfo | undefined;
    trackRead: number;
    change: TrackChange;
    /** A failed route reported while a track change was pending; recovered once it settles. */
    changeFailure: string | undefined;
    endedDuringChange: boolean;
    seekFailure: string | undefined;
    /** Pause or resume asked for while a local seek is settling. Applied when that seek ends. */
    pauseAfterSeek: boolean | undefined;
    queuedSeekSeconds: number | undefined;
    /** The target of the local seek in flight; read only while `pending.seek` is set. */
    seekTarget: number | undefined;
    /** The skips behind `queuedSeekSeconds`, in press order, when only skips queued it: a failed seek replays them from the real position. */
    queuedSkips: number[] | undefined;
    progress: Promise<void> | undefined;
    cancelTimer: (() => void) | undefined;
    stopSpec: RequestSpec<PlaybackMutation> | undefined;
    stopped: boolean;
    /** The advance may go on: the session stopped, or its STOP failed in a way that may clear and is left to the background (#709). */
    ended: boolean;
    stopRetryAt: number;
    progressRefusal: unknown;
}

export class PlaybackController implements PlayerControls {
    private readonly deps: PlaybackDeps;
    private readonly flusher: PlayerSettingsFlusher;
    private readonly ownsFlusher: boolean;
    private readonly stillWatching = new PlayerStillWatchingGuard();
    private readonly readStillWatchingThreshold: () => number;
    private nextStartUnattended = false;
    private readonly stopFlusherCommit: () => void;
    private readonly pending: PendingTransport;
    private attempt: Attempt | undefined;
    /** Increases on every AVPlay open and teardown; callbacks of an older value are dropped. */
    private transport = 0;
    private cancelStartup: (() => void) | undefined;
    private shownError: PlaybackError | undefined;
    private traceSeq = 0;
    private current: PlaybackView = { phase: "closed" };
    private readonly listeners: ((view: PlaybackView) => void)[] = [];
    private readonly stopAuthority: () => void;
    private startupDue: number | undefined;
    /** The last view as the player built it, before the buffering pill and notice are added. */
    private base: PlaybackView = { phase: "closed" };
    /** Counts show() calls that reach the buffering sync, so a nested one can supersede its caller. */
    private shown = 0;
    /** Holds off `showPlayback` while `seekAbsolute` notifies the buffering controller right before closing or seeking AVPlay. */
    private suppressBufferingPlayback = false;
    /** The last `playback.buffering_quality_mode` read, kept for a later attempt whose read fails, as Apple keeps the device's cached value. */
    private lastBufferingMode: BufferingQualityMode | undefined;
    /** The device going offline or online is transport trouble for the buffering controller. */
    private readonly onConnectivity = (): void => {
        const attempt = this.active();
        if (attempt === undefined) return;
        this.syncBuffering(attempt);
        if (this.base.phase === "playing" || this.base.phase === "paused") this.showPlayback(attempt);
    };
    /** `autoplays`: the card's pick is one Apple counts down to (the next episode or a Shuffle pick), not an On Deck title. */
    private completion: { readonly attempt: Attempt; readonly abort: AbortController; pending: boolean; autoplays: boolean; pickingAnother: boolean; advancingShuffle: boolean; advancedShuffle?: Shuffle | undefined; advancedShuffleUnattended?: boolean | undefined; shuffleScopeLabel?: string | undefined } | undefined;
    private cancelAutoplayTimer: (() => void) | undefined;
    private nextStart: PlayRequest | undefined;

    constructor(deps: PlaybackDeps) {
        this.deps = deps;
        this.ownsFlusher = deps.settingsFlusher === undefined;
        this.readStillWatchingThreshold = deps.stillWatchingThreshold ?? (() => DEFAULT_STILL_WATCHING_THRESHOLD);
        this.flusher = deps.settingsFlusher ?? new PlayerSettingsFlusher(sessionPlayerSettingsTransport(deps.session), deps.clock, {
            scopeId: () => deps.session.activeProfile?.id ?? "default",
            signal: () => deps.session.authoritySignal,
            ...(deps.publicStorage === undefined ? {} : { storage: deps.publicStorage }),
        });
        this.stopFlusherCommit = this.flusher.onCommit(key => {
            if (key === AUTO_NEXT_KEY && this.attempt !== undefined) this.attempt.settingsEpoch += 1;
        });
        this.pending = transportLock(deps.avplay);
        globalThis.addEventListener?.("online", this.onConnectivity);
        globalThis.addEventListener?.("offline", this.onConnectivity);
        this.stopAuthority = deps.session.onAuthorityChange(() => {
            const attempt = this.attempt;
            if (attempt === undefined || (!attempt.live && this.completion === undefined)) {
                return;
            }
            this.cancelCompletion();
            this.leave(attempt, "abandon");
            this.attempt = undefined;
            this.show({ phase: "closed" });
            deps.exits.onEnd("authority_changed");
        });
    }

    /**
     * Track names, flags and Up Next's words are built into each view, so a language that lands while playback is paused has to send the view again.
     * The screen asks, once no Select is held; a loading, restoring, completion or error view is left as it is. It also puts the Up Next preview rectangle where the language now reads.
     */
    refreshView(): void {
        const attempt = this.attempt;
        if (attempt === undefined || (this.current.phase !== "playing" && this.current.phase !== "paused")) return;
        // The Up Next preview sits on the side the language reads from, so a direction that changes moves the video with the panel.
        if (attempt.prompt !== undefined) this.paintRect(attempt);
        this.showPlayback(attempt);
    }

    /** Starts a new attempt; one already running is stopped and never plays. */
    play(request: PlayRequest): void {
        this.startPlay(request, false);
    }

    private stillWatchingGated(): boolean {
        return this.stillWatching.shouldGate(this.readStillWatchingThreshold());
    }

    private startPlay(request: PlayRequest, preserveGuard: boolean): void {
        if (this.completion !== undefined) return;
        const previous = this.attempt;
        if (!preserveGuard && previous !== undefined && previous.request.contentId !== request.contentId) {
            this.stillWatching.recordViewerAction();
        }
        if (previous !== undefined) {
            this.leave(previous, "stop");
        }
        this.shownError = undefined;
        const bufferingQuality: BufferingBridge = new BufferingBridge(this.deps.clock, {
            issueReplan: (request, restore) => this.issueBufferingReplan(bufferingQuality, request, restore),
            changed: () => this.bufferingChanged(bufferingQuality),
            stalledChanged: () => this.bufferingChanged(bufferingQuality),
        });
        const signal = this.deps.session.authoritySignal;
        const attemptRef: { current?: Attempt } = {};
        const subtitles = new SubtitleSession(
            {
                session: this.deps.session,
                clock: this.deps.clock,
                publicStorage: this.deps.publicStorage,
                host: this.createSubtitleHost(attemptRef),
            },
            request,
            signal,
        );
        const attempt: Attempt = {
            hud: new HUDState(),
            bufferingQuality, bufferingMode: this.lastBufferingMode ?? DEFAULT_BUFFERING_QUALITY_MODE, bufferingAdvertised: false, bufferingRestore: undefined, skipPillShown: false,
            autoNextSupported: false,
            promptSeconds: 30, promptSupported: false, promptDismissed: false, promptPending: false, promptLookedUp: false, prompt: undefined,
            offer: { started: false, manual: false, credits: false, creditsCountdown: undefined, creditsDeadline: undefined, cancelCreditsTimer: undefined, episodeLoading: false, deckLoading: false, episodeSettled: false, episodeFailed: false, episode: undefined, deckSettled: false, deckFailed: false, episodeWindowRetried: false, deckWindowRetried: false, deckRetried: false, episodeManualRetried: false, deckManualRetried: false, deck: [], presentationFor: undefined },
            rectPending: false,
            appliedRect: undefined,
            transportCommandCount: 0,
            autoNext: false, settingsEpoch: 0,
            introMode: "ask", skipCredits: false, skippedMarkers: new Set(), undoSkip: undefined, pendingSkipUndo: undefined,
            subtitles,
            request,
            playbackAttemptId: this.newId(),
            signal,
            live: true,
            installationId: undefined,
            profileId: undefined,
            sessionId: undefined,
            plan: undefined,
            planAttemptId: this.newId(),
            previewKey: this.newId(),
            queuedReanchorSeconds: undefined,
            attemptedKeys: [],
            recoveries: 0,
            sequence: 0,
            sourceSeconds: request.startSeconds ?? 0,
            paused: false,
            qualityPreference: "auto",
            bandwidthCapKbps: undefined,
            autoBandwidthCapKbps: undefined,
            qualityPicked: false,
            seekIntervals: { backward: 10, forward: 10 },
            hdrEnabled: true,
            hdrPanel: { hdr10: false, hlg: false, dolbyVision: false },
            panelResolution: "1080p",
            lastAvplayError: undefined,
            trace: newTrace(++this.traceSeq),
            batchedSettings: true,
            serverFeatures: [],
            renditionsAll: false,
            trickplayEnabled: false,
            thumbnails: undefined,
            markers: undefined,
            started: false,
            presented: false,
            hidden: false,
            suspended: false,
            suspendedReady: false,
            deferredOpen: false,
            restoring: false,
            restoreOpen: undefined,
            resuming: false,
            recovery: undefined,
            recoveryPending: false,
            recoverySpec: undefined,
            recoveryRetryAt: 0,
            cancelRecovery: undefined,
            replacementBody: undefined,
            retirePredecessor: false,
            resumeGeneration: 0,
            progressDue: undefined,
            buffering: false,
            busy: false,
            tracks: undefined,
            trackRead: 0,
            change: { state: "idle" },
            changeFailure: undefined,
            endedDuringChange: false,
            seekFailure: undefined,
            pauseAfterSeek: undefined,
            queuedSeekSeconds: undefined,
            seekTarget: undefined,
            queuedSkips: undefined,
            progress: undefined,
            cancelTimer: undefined,
            stopSpec: undefined,
            stopped: false,
            ended: false,
            stopRetryAt: 0,
            progressRefusal: undefined,
        };
        attemptRef.current = attempt;
        this.attempt = attempt;
        this.show({ phase: "loading", title: request.title });
        void this.begin(attempt);
    }

    subscribe(listener: (view: PlaybackView) => void): () => void {
        this.listeners.push(listener);
        listener(this.current);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index !== -1) {
                this.listeners.splice(index, 1);
            }
        };
    }

    diagnosticsDetails(): DiagnosticsPlanDetails | undefined {
        const attempt = this.attempt;
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined) return undefined;
        const { subtitleMode, subtitleTrack } = attempt.subtitles.diagnosticsSubtitle(plan);
        return {
            source: plan.source,
            ...(plan.sourceBitrateKbps === undefined ? {} : { sourceBitrateKbps: plan.sourceBitrateKbps }),
            ...(plan.durationSeconds === undefined ? {} : { durationSeconds: plan.durationSeconds }),
            ...(plan.streamProtocol === undefined ? {} : { streamProtocol: plan.streamProtocol }),
            ...(plan.streamContainer === undefined ? {} : { streamContainer: plan.streamContainer }),
            ...(plan.activeQuality === undefined ? {} : { activeQuality: plan.activeQuality }),
            subtitleMode,
            ...(subtitleTrack === undefined ? {} : {
                subtitleSource: subtitleTrack.source,
                subtitleDelivery: subtitleTrack.delivery,
                ...(subtitleTrack.codec === undefined ? {} : { subtitleCodec: subtitleTrack.codec }),
            }),
            positionSeconds: attempt.sourceSeconds,
            hdrEnabled: attempt.hdrEnabled,
            ...(attempt.lastAvplayError === undefined ? {} : { avplayError: attempt.lastAvplayError }),
            ...(attempt.recoveries > 0 ? { routeFallbacks: attempt.recoveries } : {}),
        };
    }

    /** The current attempt's structured trace for incident reports. Plan and settings appear only once this attempt reached them. */
    incidentTrace(): PlaybackAttemptTrace | undefined {
        return this.attempt === undefined ? undefined : this.traceOf(this.attempt);
    }

    /** The current attempt's live buffering evidence; a recovered chain's frozen trace keeps its own copy. */
    bufferingTrace(): BufferingEvidenceTrace | undefined {
        return this.attempt === undefined ? undefined : this.qualityOf(this.attempt);
    }

    private qualityOf(attempt: Attempt): BufferingEvidenceTrace {
        return attempt.bufferingQuality.evidence.trace({
            mode: attempt.bufferingMode, advertised: attempt.bufferingAdvertised, preference: attempt.qualityPreference, manualCapKbps: attempt.autoBandwidthCapKbps,
        });
    }

    /** The current attempt's latest definite audio/subtitle failure, with the live trace: a frozen playback chain is older than it. */
    mediaFailure(): { readonly trace: PlaybackAttemptTrace; readonly failure: MediaFailure } | undefined {
        const attempt = this.attempt;
        const failure = attempt?.trace.media.failure;
        return attempt === undefined || failure === undefined ? undefined : { trace: this.traceOf(attempt, true), failure };
    }

    /** What the current attempt selected and delivered for audio and subtitles, without names or text. Undefined until it has a plan. */
    mediaEvidence(): MediaEvidence | undefined {
        const attempt = this.attempt;
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined) return undefined;
        const media = attempt.trace.media;
        // AVPlay answers stream info only while playing or paused, and takes no call while a seek is out. Read once per transport.
        if (attempt.started && !attempt.busy && !attempt.hidden && !attempt.restoring && !attempt.suspended && this.pending.seek === undefined && media.observedFor !== attempt.planAttemptId) {
            media.observedFor = attempt.planAttemptId;
            media.observed = readAvplayAudio(this.deps.avplay);
        }
        // Only the plan's ordinal names the source row; without it the source stays unknown rather than guessed.
        const ordinal = plan.selectedTracks.audio?.index;
        const version = attempt.tracks?.state === "ready" ? attempt.tracks.versions.find(candidate => candidate.fileId === plan.effectiveMediaFileId) : undefined;
        const source = ordinal === undefined ? undefined : version?.audio[ordinal];
        const { subtitleMode: mode, subtitleTrack: row, drawnBy, cues, syncMs, secondary } = attempt.subtitles.diagnosticsSubtitle(plan);
        return {
            audio: {
                language: source?.language,
                source: source === undefined ? undefined : { codec: source.codec, channels: source.channels },
                planned: plan.recipe === undefined ? undefined : { codec: plan.recipe.audioCodec, channels: plan.recipe.audioChannels },
                observed: media.observed,
            },
            subtitle: {
                mode,
                track: row === undefined ? undefined : { source: row.source, delivery: row.delivery, codec: row.codec, language: row.language, forced: row.forced, hearingImpaired: row.hearingImpaired },
                drawnBy,
                // AVPlay-drawn text has no file of Auger's to load, unless it stands in for one that failed.
                load: drawnBy === "overlay" || (drawnBy === "avplay" && media.load === "fallback") ? media.load : "not_needed",
                cues,
                syncMs,
                secondary,
            },
            switch: media.switch,
        };
    }

    /** `live` skips the recovered chain's freeze, for evidence recorded after it. */
    private traceOf(attempt: Attempt, live = false): PlaybackAttemptTrace {
        const trace = attempt.trace;
        if (!live && trace.frozen !== undefined) return trace.frozen;
        // A plan the server sent but this attempt refused before adopting it still describes the failure.
        const plan = attempt.plan ?? trace.received;
        const subtitle = attempt.request.subtitle?.kind ?? "auto";
        return {
            seq: trace.seq,
            chain: trace.chain,
            stage: trace.stage,
            done: trace.done,
            first: trace.first,
            http: trace.http,
            decision: trace.decision,
            firstAvplay: trace.firstAvplay,
            lastAvplay: trace.lastAvplay,
            resends: trace.resends,
            fallbacks: trace.fallbacks,
            reconnects: trace.reconnects,
            opened: trace.opened,
            shown: trace.shown,
            recovered: trace.recovered,
            exhausted: trace.exhausted,
            timedOut: trace.timedOut,
            steps: trace.steps.slice(),
            settings: trace.settingsRead ? { quality: attempt.qualityPreference, capKbps: attempt.bandwidthCapKbps, hdr: attempt.hdrEnabled } : undefined,
            hdrPanel: trace.hdrProbe === "unavailable" ? "unavailable" : { hdr10: attempt.hdrPanel.hdr10, hlg: attempt.hdrPanel.hlg, dolbyVision: attempt.hdrPanel.dolbyVision },
            request: { startSeconds: attempt.request.startSeconds, subtitle, audio: attempt.request.audioTrackId === undefined ? "default" : "track" },
            quality: this.qualityOf(attempt),
            plan: plan === undefined ? undefined : {
                delivery: plan.delivery,
                protocol: plan.streamProtocol,
                container: plan.streamContainer,
                quality: plan.activeQuality,
                sourceKbps: plan.sourceBitrateKbps,
                videoCodec: plan.source.videoCodec,
                width: plan.source.width,
                height: plan.source.height,
                dynamicRange: plan.source.dolbyVisionProfile !== undefined ? "dolby_vision" : plan.source.dynamicRange,
                startSeconds: plan.timeline.sourceStartSeconds,
                // Before adoption the position is the received plan's own start, not the plan it would replace.
                atSeconds: attempt.plan === undefined ? plan.timeline.sourceStartSeconds : attempt.sourceSeconds,
            },
        };
    }

    setVideo(kind: "speed" | "aspect", value: string): void {
        const attempt = this.active();
        if (attempt?.plan === undefined || attempt.busy || attempt.hidden || attempt.restoring) return;
        this.stillWatching.recordViewerAction();
        attempt.hud.setVideo(this.deps.avplay, attempt.plan, kind, value);
        this.showPlayback(attempt);
    }

    retryChapters(): void {
        const attempt = this.active();
        if (attempt?.plan === undefined) return;
        attempt.hud.read(this.deps.session, attempt.request.contentId, attempt.plan.effectiveMediaFileId, attempt.signal, () => this.showPlayback(attempt), true);
        this.showPlayback(attempt);
    }

    toggleAutoNext(): void {
        // The finished card's toggle (PlayerView.autoPlayToggle) acts on the ended attempt.
        const completion = this.completion;
        const attempt = this.active() ?? (completion !== undefined && completion.attempt === this.attempt && completion.attempt.ended ? completion.attempt : undefined);
        if (attempt === undefined || !attempt.autoNextSupported) return;
        // PlayerViewModel.setNextUpAutoPlayEnabled -> PlayerSettings.setAutoPlayNextEpisode -> PlayerSettingsFlusher:
        // the local value changes and the countdown updates at once, while the flusher debounces, retries transient
        // failures, and holds exhausted writes for Settings without showing an error in the player.
        const enabled = !attempt.autoNext;
        this.stillWatching.recordViewerAction();
        attempt.settingsEpoch += 1;
        attempt.autoNext = enabled;
        if (attempt.live && attempt.offer.credits) this.startCreditsCountdownIfNeeded(attempt);
        this.showPlayback(attempt);
        if (!attempt.live) this.completionAutoNextChanged(attempt);
        this.flusher.enqueue(AUTO_NEXT_KEY, enabled, "profile_device");
    }

    /** A settings read may apply Auto-play only if no press came after it started, and never over an unsettled local write. */
    private applyAutoNextRead(attempt: Attempt, epoch: number, serverValue: boolean): void {
        if (epoch !== attempt.settingsEpoch) return;
        const unsettled = this.flusher.unsettledValue(AUTO_NEXT_KEY);
        attempt.autoNext = typeof unsettled === "boolean" ? unsettled : serverValue;
    }

    togglePause(): void {
        const attempt = this.active();
        if (attempt !== undefined) this.setPaused(!(attempt.pauseAfterSeek ?? attempt.paused));
    }

    setPaused(paused: boolean): void {
        const attempt = this.active();
        if (attempt === undefined) {
            return;
        }
        this.stillWatching.recordViewerAction();
        attempt.transportCommandCount++;
        // A seek reanchor replaces the transport; preparation must use the latest intent.
        if (!attempt.started) {
            if (attempt.presented) attempt.paused = paused;
            return;
        }
        // AVPlay rejects play and pause while seekTo is outstanding. Keep the request and apply it when the seek ends.
        if (attempt.busy && this.pending.seek !== undefined && !changeHoldsBusy(attempt)) {
            attempt.pauseAfterSeek = paused;
            this.showPlayback(attempt);
            return;
        }
        if (attempt.paused === paused) { this.showPlayback(attempt); return; }
        if (attempt.busy && !attempt.subtitles.isReporting && !(attempt.change.state === "changing" && attempt.change.kind === "quality")) {
            return;
        }
        if (attempt.hidden || attempt.restoring) {
            attempt.paused = paused;
            return;
        }
        try {
            if (paused) {
                this.deps.avplay.pause();
            } else {
                this.deps.avplay.play();
            }
            attempt.paused = paused;
        } catch {
            // Not allowed in the player's state right now; the next key press tries again.
        }
        this.showPlayback(attempt);
    }

    seekBy(seconds: number): void {
        const attempt = this.active();
        if (attempt === undefined) return;
        this.stillWatching.recordViewerAction();
        // PlayerViewModel.queueSkipDebounce (RelativeSeek.target(current:pending:delta:)): a skip pressed while a seek is in flight adds
        // to the target already asked for, the queued one first, never to the position from before that seek.
        const inFlight = attempt.busy && this.pending.seek !== undefined;
        const pending = inFlight ? attempt.queuedSeekSeconds ?? attempt.seekTarget : undefined;
        const skips = attempt.queuedSeekSeconds === undefined ? [] : attempt.queuedSkips;
        // A reanchor queued behind a subtitle switch is the newest target, so a skip adds to it (#756).
        this.seekToSeconds((pending ?? attempt.queuedReanchorSeconds ?? attempt.sourceSeconds) + seconds);
        if (inFlight && attempt.queuedSeekSeconds !== undefined && skips !== undefined) attempt.queuedSkips = [...skips, seconds];
    }

    retrySettings(): void {
        const attempt = this.attempt;
        if (this.shownError?.kind === "settings" && attempt !== undefined && !attempt.signal.aborted && attempt.signal === this.deps.session.authoritySignal) this.play(attempt.request);
    }

    async seekThumbnail(seconds: number, signal: AbortSignal, loadSheet: ThumbnailSheetLoader): Promise<SeekThumbnail | undefined> {
        // Apple keeps a file's previews through a replan of that file (PlayerViewModel.swift:349-366), so a subtitle switch,
        // which holds nothing, still previews (#757). A seek or quality change in flight is still a barrier.
        const active = this.active();
        const attempt = active !== undefined && active.started && !active.busy ? active : undefined;
        const fileId = attempt?.plan?.effectiveMediaFileId;
        if (attempt === undefined || fileId === undefined || !attempt.trickplayEnabled) return undefined;
        // Keyed by file, as Apple's contentId#fileId cache: a provider for another file is never reused, whichever path adopted the plan.
        if (attempt.thumbnails !== undefined && attempt.thumbnails.fileId !== fileId) this.clearThumbnails(attempt);
        const provider = attempt.thumbnails ?? new SeekThumbnails(this.deps.session, this.deps.clock, attempt.request.contentId, fileId);
        attempt.thumbnails = provider;
        const tile = await provider.load(seconds, signal, loadSheet);
        return attempt.live && attempt.thumbnails === provider && !attempt.busy && !signal.aborted ? tile : undefined;
    }

    private clearThumbnails(attempt: Attempt): void {
        attempt.thumbnails?.destroy();
        attempt.thumbnails = undefined;
    }

    seekToSeconds(seconds: number): void {
        this.stillWatching.recordViewerAction();
        this.seekAbsolute(seconds);
    }

    skipCredits(seconds: number): void {
        const attempt = this.active();
        if (attempt === undefined || !attempt.started || attempt.busy) return;
        this.stillWatching.recordViewerAction();
        this.performCreditsSkip(attempt, seconds);
    }

    /** PlayerViewModel.performCreditsSkip (silo-apple d315ef9c): credits running to EOF open Up Next over playing credits. */
    private performCreditsSkip(attempt: Attempt, targetSeconds: number): void {
        const duration = attempt.plan?.durationSeconds;
        if (duration !== undefined && Number.isFinite(duration) && duration > 0 && targetSeconds >= duration - 0.5) {
            if (this.presentNextUpOverCredits(attempt)) return;
        }
        this.seekAbsolute(targetSeconds);
        this.showPlayback(attempt);
    }

    /** PlayerViewModel.presentNextUpOverCredits: returns true when Up Next takes over instead of seeking to EOF. */
    private presentNextUpOverCredits(attempt: Attempt): boolean {
        if (attempt.request.watchParty === true || attempt.ended || this.completion !== undefined || attempt.hidden || attempt.busy || !attempt.started) return false;
        if (!this.episodesVisible(attempt)) return false;
        attempt.offer.credits = true;
        attempt.promptDismissed = false;
        if (!attempt.offer.started) this.beginDiscovery(attempt);
        else {
            const offer = attempt.offer;
            if (offer.episodeFailed && !offer.episodeLoading && !offer.episodeManualRetried) { offer.episodeManualRetried = true; this.retryEpisode(attempt); }
            if (offer.deckFailed && !offer.deckLoading && !offer.deckManualRetried) { offer.deckManualRetried = true; this.retryDeck(attempt); }
        }
        this.publishOffer(attempt);
        return true;
    }

    private cancelCreditsCountdown(attempt: Attempt, clearDeadline = true): void {
        attempt.offer.cancelCreditsTimer?.();
        attempt.offer.cancelCreditsTimer = undefined;
        attempt.offer.creditsCountdown = undefined;
        if (clearDeadline) attempt.offer.creditsDeadline = undefined;
    }

    /** PlayerViewModel.startNextUpCountdownIfNeeded for `.credits`: fixed 10 s countdown while credits keep playing. */
    private startCreditsCountdownIfNeeded(attempt: Attempt): void {
        const prompt = attempt.prompt;
        const canRun = attempt.offer.credits
            && prompt !== undefined
            && prompt.loading !== true
            && prompt.failed !== true
            && !prompt.fromDeck
            && prompt.next !== undefined
            && attempt.autoNext
            && !this.stillWatchingGated()
            && !attempt.promptDismissed
            && this.completion === undefined;
        if (!canRun) {
            this.cancelCreditsCountdown(attempt);
            return;
        }
        if (attempt.offer.cancelCreditsTimer !== undefined) return;
        const deadline = attempt.offer.creditsDeadline ?? (this.deps.clock.now() + AUTOPLAY_COUNTDOWN_SECONDS * 1000);
        attempt.offer.creditsDeadline = deadline;
        const tick = (): void => {
            if (this.active() !== attempt || !attempt.offer.credits || attempt.prompt === undefined || attempt.prompt.next === undefined || !attempt.autoNext || this.stillWatchingGated() || attempt.promptDismissed || this.completion !== undefined) {
                this.cancelCreditsCountdown(attempt);
                return;
            }
            const remaining = Math.max(0, Math.ceil((deadline - this.deps.clock.now()) / 1000));
            if (remaining === 0) {
                if (this.current.phase !== "playing" && this.current.phase !== "paused") {
                    this.cancelCreditsCountdown(attempt, false);
                    return;
                }
                this.cancelCreditsCountdown(attempt);
                this.advanceNext(undefined, true);
                return;
            }
            attempt.offer.creditsCountdown = remaining;
            this.showPlayback(attempt);
            attempt.offer.cancelCreditsTimer = this.deps.clock.schedule(tick, 1000);
        };
        tick();
    }

    private seekAbsolute(seconds: number, requestedPaused?: boolean): void {
        const attempt = this.active();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || !attempt.started) {
            return;
        }
        const duration = plan.durationSeconds;
        const target = Math.max(0, Math.min(seconds, duration ?? Number.MAX_VALUE));
        if (attempt.busy) {
            if (this.pending.seek !== undefined && !changeHoldsBusy(attempt) && !attempt.hidden && !attempt.restoring) {
                attempt.queuedSeekSeconds = target;
                attempt.queuedSkips = undefined;
                attempt.queuedReanchorSeconds = undefined;
            }
            return;
        }
        if (attempt.undoSkip === target) attempt.undoSkip = undefined;
        const local = seekableAt(plan, target);
        // A reanchor closes AVPlay and would race the switch's replan: it waits for the answer, as in-window seeks need not.
        if (!local && attempt.subtitles.subtitleSwitchOut) {
            attempt.queuedReanchorSeconds = target;
            return;
        }
        // A newer seek that runs now replaces any reanchor still queued (#756).
        attempt.queuedReanchorSeconds = undefined;
        attempt.pauseAfterSeek = requestedPaused;
        attempt.busy = true;
        this.clearThumbnails(attempt);
        // The buffering controller must see the seek begin: the buffering that follows belongs to it.
        this.suppressBufferingPlayback = true;
        try {
            this.syncBuffering(attempt);
        } finally {
            this.suppressBufferingPlayback = false;
        }
        if (!local) {
            if (requestedPaused !== undefined) attempt.paused = requestedPaused;
            attempt.pauseAfterSeek = undefined;
            // An open or partial window has no bytes there yet: the server re-anchors the timeline.
            this.closeTransport();
            attempt.started = false;
            this.show({ phase: "loading", title: attempt.request.title });
            void this.replan(attempt, plan, "seek_reanchor", target, undefined);
            return;
        }
        const transport = this.transport;
        attempt.seekTarget = target;
        const settled = (moved: boolean): void => {
            if (transport !== this.transport || !attempt.live) {
                attempt.pauseAfterSeek = undefined;
                attempt.queuedSeekSeconds = undefined;
                attempt.queuedSkips = undefined;
                return;
            }
            attempt.busy = false;
            if (moved) {
                attempt.sourceSeconds = target;
            }
            const failure = attempt.seekFailure;
            attempt.seekFailure = undefined;
            const pauseAfterSeek = attempt.pauseAfterSeek;
            attempt.pauseAfterSeek = undefined;
            // Skips queued behind a seek that did not move count from where playback still is, not from the failed target, each held at
            // 0 and the end as it was when pressed, so a failed seek and a landed one end in the same place.
            const queued = !moved && attempt.queuedSkips !== undefined && attempt.queuedSeekSeconds !== undefined
                ? attempt.queuedSkips.reduce((at, skip) => Math.max(0, Math.min(at + skip, duration ?? Number.MAX_VALUE)), attempt.sourceSeconds)
                : attempt.queuedSeekSeconds;
            attempt.queuedSeekSeconds = undefined;
            attempt.queuedSkips = undefined;
            if (failure !== undefined) {
                if (pauseAfterSeek !== undefined) attempt.paused = pauseAfterSeek;
                this.routeFailed(attempt, failure);
                return;
            }
            if (queued !== undefined) {
                this.finishSkipSeek(attempt, moved);
                this.seekAbsolute(queued, pauseAfterSeek);
                this.showPlayback(attempt);
                return;
            }
            if (pauseAfterSeek !== undefined && pauseAfterSeek !== attempt.paused) {
                if (attempt.hidden || attempt.restoring) {
                    attempt.paused = pauseAfterSeek;
                } else {
                    try {
                        if (pauseAfterSeek) this.deps.avplay.pause();
                        else this.deps.avplay.play();
                        attempt.paused = pauseAfterSeek;
                    } catch {
                        // The platform still refuses play or pause; the next key tries again.
                    }
                }
            }
            if (moved) {
                if (attempt.offer.credits && markerAt((attempt.markers?.segments ?? []).filter(segment => segment.kind === "credits"), attempt.sourceSeconds) === undefined) {
                    attempt.offer.credits = false;
                    this.cancelCreditsCountdown(attempt);
                }
                this.updatePrompt(attempt);
            }
            this.flushPendingRect(attempt);
            this.finishSkipSeek(attempt, moved);
            this.showPlayback(attempt);
            // A switch that settled while this seek held the controls left its queued subtitle choice for now (#738).
            if (!attempt.busy && attempt.change.state !== "changing") {
                attempt.subtitles.onSeekSettled();
            }
        };
        try {
            this.seekTo(
                Math.round((target - plan.timeline.timelineOffsetSeconds) * 1000),
                () => settled(true),
                () => settled(false),
            );
        } catch {
            settled(false);
        }
        if (this.attempt === attempt && attempt.live && this.pending.seek !== undefined) {
            this.showPlayback(attempt);
        }
    }

    background(): void {
        if (this.completion !== undefined) {
            this.cancelCompletion();
            this.back();
            return;
        }
        const attempt = this.active();
        if (attempt !== undefined) {
            this.fail(attempt, { kind: "backgrounded" }, true);
        }
    }

    suspend(): void {
        if (this.completion !== undefined) {
            this.cancelCompletion();
            this.back();
            return;
        }
        const attempt = this.active();
        if (attempt === undefined || attempt.hidden) {
            return;
        }
        if (attempt.prompt !== undefined) this.cancelAutoplay();
        attempt.resumeGeneration += 1;
        attempt.restoring = false;
        attempt.hidden = true;
        attempt.queuedSeekSeconds = undefined;
        attempt.queuedSkips = undefined;
        // A backgrounded app is paused to the buffering controller: nothing waits, prompts or lowers unseen.
        this.syncBuffering(attempt);
        this.capturePosition(attempt);
        this.holdTimers(attempt);
        const seek = this.pending.seek;
        if (seek !== undefined) {
            const transport = this.transport;
            void seek.then(() => {
                if (this.attempt === attempt && attempt.live && transport === this.transport && (attempt.hidden || attempt.restoring)) {
                    this.capturePosition(attempt);
                    if (!attempt.suspended && !attempt.suspendedReady) this.suspendTransport(attempt);
                }
            });
            return;
        }
        this.suspendTransport(attempt);
    }

    private suspendTransport(attempt: Attempt): void {
        const state = this.deps.avplay.getState();
        if ((state === "PLAYING" || state === "PAUSED" || state === "READY") && this.deps.avplay.suspend !== undefined) {
            try {
                this.deps.avplay.suspend();
                if (state === "READY") {
                    attempt.suspendedReady = true;
                } else {
                    attempt.suspended = true;
                }
            } catch {
                attempt.suspended = false;
                attempt.suspendedReady = false;
            }
        }
    }

    restore(): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || !attempt.hidden || attempt.restoring) {
            return;
        }
        attempt.hidden = false;
        if (this.shownError !== undefined) {
            return;
        }
        attempt.restoring = true;
        this.showLoading(attempt, "restoring");
        const generation = attempt.resumeGeneration + 1;
        void this.resumeVisible(attempt).finally(() => {
            if (attempt.resumeGeneration === generation) attempt.restoring = false;
        });
    }

    back(): void {
        this.cancelCompletion();
        this.nextStart = undefined;
        if (this.shownError !== undefined) {
            this.dismissError();
            return;
        }
        const attempt = this.attempt;
        if (attempt !== undefined) {
            this.leave(attempt, "stop");
        }
        this.attempt = undefined;
        this.show({ phase: "closed" });
        this.deps.exits.onBack();
    }

    selectAudio(trackId: string): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || trackId === plan.selectedTracks.audio?.id) {
            return;
        }
        if (!audioChoices(attempt, plan).some((choice) => choice.id === trackId)) {
            return;
        }
        this.stillWatching.recordViewerAction();
        requestSwitch(attempt, "audio");
        // Omitting a subtitle from a track_change turns it off, so the shown one is named again.
        const subtitle = attempt.subtitles.chosenTracks(plan).subtitle;
        this.changeTracks(attempt, plan, { audio: { id: trackId }, ...(subtitle === undefined ? {} : { subtitle }) });
    }

    selectSubtitle(trackId: string | undefined): void {
        this.stillWatching.recordViewerAction();
        this.active()?.subtitles.selectSubtitle(trackId);
    }

    retryTrackInfo(): void {
        const attempt = this.active();
        if (attempt !== undefined && attempt.tracks?.state === "failed") {
            this.readTracks(attempt);
        }
    }

    startSubtitleAI(language: string): void {
        this.active()?.subtitles.startSubtitleAI(language);
    }

    subtitleAIAction(action: "open" | "cancel" | "dismiss" | "discard"): void {
        this.active()?.subtitles.subtitleAIAction(action);
    }

    syncSubtitle(key: string): void {
        this.active()?.subtitles.syncSubtitle(key);
    }

    resetSubtitleTiming(key: string): void {
        this.active()?.subtitles.resetSubtitleTiming(key);
    }

    selectAIResult(id: string): void {
        this.active()?.subtitles.selectAIResult(id);
    }

    subtitleTool(action: SubtitleToolAction): void {
        this.active()?.subtitles.applyTool(action);
    }

    selectSecondarySubtitle(trackId: string | undefined): void {
        const attempt = this.active();
        if (attempt === undefined || attempt.plan === undefined || attempt.hidden || attempt.restoring) return;
        this.stillWatching.recordViewerAction();
        attempt.subtitles.selectSecondarySubtitle(trackId);
    }

    selectBufferingPrimary(): void {
        this.attempt?.bufferingQuality.selectPrimary();
    }

    selectBufferingKeep(): void {
        this.attempt?.bufferingQuality.selectKeep();
    }

    dismissBufferingPill(): boolean {
        return this.active()?.bufferingQuality.back() ?? false;
    }

    setSkipPillShown(shown: boolean): void {
        const attempt = this.active();
        if (attempt === undefined || attempt.skipPillShown === shown) return;
        attempt.skipPillShown = shown;
        this.syncBuffering(attempt);
    }

    selectQuality(preference: string): void {
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || preference === attempt.qualityPreference || !qualityChoices(plan).some((choice) => choice.id === preference)) {
            return;
        }
        attempt.attemptedKeys.length = 0;
        attempt.recoveries = 0;
        attempt.busy = true;
        attempt.subtitles.onTransportChangeStarted();
        this.clearThumbnails(attempt);
        attempt.change = { state: "changing", kind: "quality" };
        this.showPlayback(attempt);
        const selected = attempt.subtitles.chosenTracks(plan);
        const offered = plan.availableQualities.find((quality) => quality.label === preference);
        const cap = preference === "auto" ? attempt.autoBandwidthCapKbps
            : offered !== undefined && !offered.preservesSource && offered.bitrateKbps !== undefined && offered.bitrateKbps > 0 ? offered.bitrateKbps : undefined;
        attempt.bufferingQuality.pickSent();
        void this.replan(attempt, plan, "quality_change", attempt.sourceSeconds, undefined, selected, { qualityPreference: preference, bandwidthCapKbps: cap });
    }

    dismissError(): void {
        const error = this.shownError;
        if (error === undefined) {
            return;
        }
        const attempt = this.attempt;
        this.shownError = undefined;
        if (attempt !== undefined && attempt.live) {
            this.leave(attempt, "stop");
        }
        this.attempt = undefined;
        this.show({ phase: "closed" });
        this.deps.exits.onError(error);
    }

    /** Stops playback without an exit callback, for a parent that is tearing the screen down. */
    destroy(): void {
        this.cancelCompletion();
        const attempt = this.attempt;
        if (attempt !== undefined) {
            this.leave(attempt, "stop");
        }
        this.attempt = undefined;
        this.stopFlusherCommit();
        if (this.ownsFlusher) this.flusher.destroy();
        this.stopAuthority();
        globalThis.removeEventListener?.("online", this.onConnectivity);
        globalThis.removeEventListener?.("offline", this.onConnectivity);
        this.listeners.length = 0;
    }

    // --- planning ---

    private async readSeekIntervals(attempt: Attempt): Promise<boolean> {
        const call = <T>(spec: RequestSpec<T>): Promise<T> => this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
        let optionalOnly = false;
        try {
            let capability;
            try {
                capability = await call(operations.settingsCapabilities());
            } catch (error) {
                if (error instanceof ApiError && [403, 404, 501].includes(error.status ?? 0)) return attempt.live;
                throw error;
            }
            if (!attempt.live) return false;
            attempt.batchedSettings = capability.supportsBatchedEffective;
            if (capability.apiVersion !== 1 || capability.state !== "available" || !capability.allowed || !capability.scopes.includes("profile")) return true;
            optionalOnly = capability.manifestRevision < 9;
            const contract = await call(operations.settingsContract());
            if (!attempt.live) return false;
            if (contract.apiVersion !== 1 || contract.revision < capability.manifestRevision) throw new Error("Settings contract changed");
            const definitions = profileSettings(contract, capability);
            attempt.promptSupported = definitions.some(def => def.key === NEXT_UP_KEY);
            if (attempt.promptSupported) {
                try {
                    const values = await call(operations.effectiveSettings([NEXT_UP_KEY]));
                    const seconds = values.get(NEXT_UP_KEY)?.value;
                    if (typeof seconds === "number") attempt.promptSeconds = seconds;
                } catch { /* Apple's default remains usable offline. */ }
            }
            for (const key of [INTRO_SKIP_KEY, CREDITS_SKIP_KEY] as const) {
                if (!definitions.some(def => def.key === key)) continue;
                try {
                    const values = await call(operations.effectiveSettings([key]));
                    if (!attempt.live) return false;
                    const value = values.get(key)?.value;
                    if (key === INTRO_SKIP_KEY && (value === "never" || value === "ask" || value === "always")) attempt.introMode = value;
                    if (key === CREDITS_SKIP_KEY) attempt.skipCredits = value === true;
                } catch { /* Unavailable optional preferences retain manual skipping. */ }
            }
            if (definitions.some(def => def.key === BUFFERING_MODE_KEY)) {
                try {
                    const mode = (await call(operations.effectiveSettings([BUFFERING_MODE_KEY]))).get(BUFFERING_MODE_KEY)?.value;
                    if (mode === "never" || mode === "ask" || mode === "always") {
                        attempt.bufferingMode = mode;
                        this.lastBufferingMode = mode;
                    }
                } catch { /* The last mode read, else Apple's default (always), stands where the mode cannot be read. */ }
                if (!attempt.live) return false;
            }
            if (definitions.some(def => def.key === AUTO_NEXT_KEY)) {
                attempt.autoNextSupported = true;
                const unsettled = this.flusher.unsettledValue(AUTO_NEXT_KEY);
                if (typeof unsettled === "boolean") attempt.autoNext = unsettled;
                const epoch = attempt.settingsEpoch;
                try {
                    const values = await call(operations.effectiveSettings([AUTO_NEXT_KEY]));
                    if (attempt.live) this.applyAutoNextRead(attempt, epoch, values.get(AUTO_NEXT_KEY)?.value === true);
                } catch { /* Unavailable autoplay preferences leave Play next manual unless an unsettled local choice stands. */ }
            }
            if (definitions.some(def => def.key === HDR_KEY)) {
                try {
                    const values = await call(operations.effectiveSettings([HDR_KEY]));
                    if (!attempt.live) return false;
                    attempt.hdrEnabled = values.get(HDR_KEY)?.value === true;
                } catch {
                    if (!attempt.live) return false;
                    attempt.hdrEnabled = false;
                }
            }
            if (!SEEK_KEYS.every(key => definitions.some(def => def.key === key))) return true;
            const values = await Promise.all((capability.supportsBatchedEffective ? [SEEK_KEYS] : SEEK_KEYS.map(key => [key])).map(keys => call(operations.effectiveSettings(keys))));
            if (!attempt.live) return false;
            const effective = new Map(values.flatMap(values => [...values]));
            const backward = effective.get(SEEK_BACK_KEY)?.value;
            const forward = effective.get(SEEK_FORWARD_KEY)?.value;
            if (typeof backward !== "number" || typeof forward !== "number") throw new Error("Missing seek intervals");
            attempt.seekIntervals = { backward, forward };
            return true;
        } catch {
            if (optionalOnly) return attempt.live;
            if (attempt.live) this.fail(attempt, { kind: "settings" }, false);
            return false;
        }
    }

    /**
     * The highest stored reading still current on this server and network, as Apple's start sends it.
     * Never a probe or a read: with no reading, on a metered link or on a server without a speed test it is absent.
     */
    private features(attempt: Attempt): readonly string[] {
        return clientFeatures(attempt.renditionsAll, attempt.bufferingAdvertised);
    }

    /** `ignore` keeps a limit another profile on this TV learned from lowering plans while the viewer has the feature off. */
    private learnedLimit(attempt: Attempt): { readonly learned_limit: "ignore" } | Record<string, never> {
        return attempt.bufferingAdvertised && attempt.bufferingMode === "never" ? { learned_limit: "ignore" } : {};
    }

    /** As Apple's start: the probe estimate names its source, and only to a server that takes sources. */
    private startBufferingMembers(attempt: Attempt, hasEstimate: boolean): Pick<StartPlaybackBody, "bandwidth_estimate_source" | "learned_limit"> {
        return { ...(attempt.bufferingAdvertised && hasEstimate ? { bandwidth_estimate_source: "probe" as const } : {}), ...this.learnedLimit(attempt) };
    }

    /**
     * The buffering members of a replan. The controller's own replan carries its estimate, source,
     * learned limit and observed throughput; the player's other replans repeat a kept estimate so a
     * lowering holds. Source and limit go only to a server that advertises the feature.
     */
    private replanBufferingMembers(attempt: Attempt, operation: ReplanOperation, request: ReplanRequest | undefined): Pick<ReplanPlaybackBody, "bandwidth_estimate_kbps" | "bandwidth_estimate_source" | "learned_limit" | "observed_throughput_kbps"> {
        const estimate = request !== undefined ? request.bandwidthEstimateKbps : operation === "quality_change" ? undefined : attempt.bufferingQuality.clientReplan(operation)?.bandwidthEstimateKbps;
        const limit = request?.learnedLimit ?? this.learnedLimit(attempt).learned_limit;
        const advertised = attempt.bufferingAdvertised;
        const source = advertised && estimate !== undefined ? request?.bandwidthEstimateSource : undefined;
        return {
            ...(estimate === undefined ? {} : { bandwidth_estimate_kbps: estimate }),
            ...(source === undefined ? {} : { bandwidth_estimate_source: source }),
            ...(advertised && limit !== undefined ? { learned_limit: limit } : {}),
            ...(source !== undefined && request?.observedThroughputKbps !== undefined ? { observed_throughput_kbps: request.observedThroughputKbps } : {}),
        };
    }

    /** The buffering controller's `quality_change`, sent like the viewer's switch but recorded as nobody's pick. */
    private issueBufferingReplan(bridge: BufferingBridge, request: ReplanRequest, restore: boolean): boolean {
        const live = this.active();
        if (live === undefined || live.bufferingQuality !== bridge) return false;
        const attempt = this.changeable();
        const plan = attempt?.plan;
        if (attempt === undefined || plan === undefined || attempt.recovery?.active === true || attempt.hidden || attempt.restoring) {
            // Restore quality is the viewer's answer: it goes out once the replan or reload in flight settles.
            if (restore) {
                live.bufferingRestore = request;
                return true;
            }
            return false;
        }
        const offered = plan.availableQualities.find((quality) => quality.label === request.qualityPreference);
        const cap = request.qualityPreference === AUTO_QUALITY ? attempt.autoBandwidthCapKbps
            : offered !== undefined && !offered.preservesSource && offered.bitrateKbps !== undefined && offered.bitrateKbps > 0 ? offered.bitrateKbps : undefined;
        attempt.attemptedKeys.length = 0;
        attempt.recoveries = 0;
        attempt.busy = true;
        this.clearThumbnails(attempt);
        attempt.change = { state: "changing", kind: "quality" };
        this.showPlayback(attempt);
        attempt.subtitles.onTransportChangeStarted();
        void this.replan(attempt, plan, "quality_change", attempt.sourceSeconds, undefined, attempt.subtitles.chosenTracks(plan), { qualityPreference: request.qualityPreference, bandwidthCapKbps: cap }, request);
        return true;
    }

    private bufferingChanged(bridge: BufferingBridge): void {
        const attempt = this.attempt;
        if (attempt === undefined || !attempt.live || attempt.bufferingQuality !== bridge) return;
        if (this.base.phase === "loading") this.show(this.base);
        else if ((this.base.phase === "playing" || this.base.phase === "paused") && !attempt.hidden && !attempt.restoring && !this.suppressBufferingPlayback) {
            this.showPlayback(attempt);
        }
    }

    /** Hands the buffering controller whatever the playback facts changed. */
    private syncBuffering(attempt: Attempt): void {
        const online = currentNetwork().online;
        const snapshot: BufferingSnapshot = {
            hasActiveLoad: attempt.plan !== undefined,
            wantsToPlay: !attempt.paused,
            // A suspended transport that has not been resumed is a reload, whatever AVPlay reports meanwhile.
            started: attempt.started && !attempt.suspended && !attempt.suspendedReady,
            buffering: attempt.buffering,
            // A replan that reloads the stream is a reload; any other busy time is a seek, local or re-anchored.
            seekInFlight: attempt.busy && !changeHoldsBusy(attempt),
            reloadInProgress: attempt.restoring || attempt.suspended || attempt.suspendedReady || attempt.resuming || attempt.recovery?.active === true || (attempt.busy && changeHoldsBusy(attempt)),
            reachedEnd: this.completion !== undefined || attempt.endedDuringChange,
            playheadMs: Math.round(attempt.sourceSeconds * 1000),
            suspended: attempt.hidden,
            connectionTrouble: !online || attempt.recovery?.active === true,
        };
        attempt.bufferingQuality.setCompetingPill(attempt.prompt !== undefined || attempt.hidden || attempt.skipPillShown);
        attempt.bufferingQuality.sync(snapshot);
        const restore = attempt.bufferingRestore;
        if (restore !== undefined && this.changeable() === attempt && attempt.recovery?.active !== true) {
            attempt.bufferingRestore = undefined;
            this.issueBufferingReplan(attempt.bufferingQuality, restore, true);
        }
    }

    /** The estimate a start may send, and the newest stored reading as diagnostics evidence. */
    private storedEstimate(capabilities: PlaybackCapabilities): { readonly kbps: number | undefined; readonly speed: SpeedEvidence } {
        if (!capabilities.features.includes(CONNECTION_SPEED_FEATURE) || capabilities.bandwidthProbeUrl === undefined) return { kbps: undefined, speed: "unsupported" };
        const network = currentNetwork();
        if (!network.online || network.metered) return { kbps: undefined, speed: network.online ? "metered" : "offline" };
        const key = readingsKey(this.deps.session.http.base.baseUrl, this.deps.session.account?.id, network.transport);
        const now = this.deps.clock.now();
        const maxAgeSeconds = capabilities.bandwidthProbeMaxAgeSeconds ?? FALLBACK_MAX_AGE_SECONDS;
        return { kbps: bandwidthReadings.freshEstimateKbps(key, now, maxAgeSeconds), speed: storedSpeed(bandwidthReadings.newest(key), now, maxAgeSeconds) };
    }

    private reportedPlayback(attempt: Attempt): Pick<StartPlaybackBody, "client_capabilities" | "client_playback_context"> {
        const report = { panel: attempt.hdrPanel, preference: { hdrEnabled: attempt.hdrEnabled } };
        return {
            client_capabilities: clientCapabilities(report, attempt.panelResolution),
            client_playback_context: playbackContext(this.deps.device.model, this.deps.device.appVersion, report),
        };
    }

    private async begin(attempt: Attempt): Promise<void> {
        attempt.trace.hdrProbe = probeHdr(this.deps.device.probeScope);
        attempt.hdrPanel = hdrPanelFor(attempt.trace.hdrProbe);
        attempt.panelResolution = resolutionFor(probeUhd(this.deps.device.probeScope));
        const session = this.deps.session;
        let decision: PlaybackDecision;
        const trace = attempt.trace;
        try {
            enterStage(trace, "capabilities");
            const capabilities = await session.call({ ...operations.playbackCapabilities(), profileScoped: true, signal: attempt.signal });
            const profile = session.activeProfile;
            if (!attempt.live) {
                return;
            }
            const installationId = capabilities.installationId;
            if (
                capabilities.state !== "available" ||
                !capabilities.allowed ||
                capabilities.protocolVersions.indexOf(3) === -1 ||
                installationId === undefined ||
                profile === undefined
            ) {
                this.fail(attempt, { kind: "unavailable" }, false);
                return;
            }
            attempt.installationId = installationId;
            attempt.profileId = profile.id;
            attempt.trickplayEnabled = capabilities.features.includes("trickplay_v1");
            attempt.renditionsAll = capabilities.features.includes(HLS_SUBTITLE_RENDITIONS_ALL_FEATURE);
            attempt.bufferingAdvertised = capabilities.features.includes(BUFFERING_QUALITY_FEATURE);
            reachedStage(trace, "capabilities");
            enterStage(trace, "settings");
            if (!await this.readSeekIntervals(attempt)) return;
            const defaults = attempt.batchedSettings
                ? await session.call({ ...operations.playbackDefaults(), profileScoped: true, signal: attempt.signal })
                : await Promise.all([
                    session.call({ ...operations.playbackDefaults([QUALITY_KEY]), profileScoped: true, signal: attempt.signal }),
                    session.call({ ...operations.playbackDefaults([BITRATE_KEY]), profileScoped: true, signal: attempt.signal }),
                ]).then(([quality, cap]) => ({ qualityPreference: quality.qualityPreference, bandwidthCapKbps: cap.bandwidthCapKbps }));
            if (!attempt.live) {
                return;
            }
            attempt.qualityPreference = defaults.qualityPreference;
            attempt.bandwidthCapKbps = defaults.bandwidthCapKbps;
            attempt.autoBandwidthCapKbps = defaults.bandwidthCapKbps;
            trace.settingsRead = true;
            reachedStage(trace, "settings");
            enterStage(trace, "start");
            const stored = this.storedEstimate(capabilities);
            const estimateKbps = stored.kbps;
            attempt.bufferingQuality.evidence.startRead(stored.speed, estimateKbps);
            const start = operations.startPlayback({
                installation_id: installationId,
                protocol_version: 3,
                client_features: this.features(attempt),
                file_id: attempt.request.fileId,
                profile_id: profile.id,
                playback_attempt_id: attempt.playbackAttemptId,
                quality_preference: attempt.qualityPreference,
                ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
                ...(estimateKbps === undefined ? {} : { bandwidth_estimate_kbps: estimateKbps }),
                ...this.startBufferingMembers(attempt, estimateKbps !== undefined),
                subtitle_fidelity_preference: "compatible",
                ...(attempt.request.startSeconds === undefined ? {} : { start_position: attempt.request.startSeconds }),
                ...(attempt.request.audioTrackId === undefined ? {} : { audio_track_id: attempt.request.audioTrackId }),
                ...subtitleStart(attempt.request),
                ...(attempt.request.allowAlternateVersions === undefined ? {} : { allow_alternate_versions: attempt.request.allowAlternateVersions }),
                ...this.reportedPlayback(attempt),
            });
            // Back does not abort the start: its answer names the session that must then be stopped.
            decision = await this.resend(attempt, () => session.call({ ...start, profileScoped: true, signal: attempt.signal }));
        } catch (error) {
            noteApiError(trace, error);
            if (attempt.live) {
                this.fail(attempt, startFailure(error), false);
            }
            return;
        }
        if (decision.outcome !== "playable") {
            if (attempt.live) {
                this.fail(attempt, traceDecision(attempt.trace, decision), false);
            }
            return;
        }
        attempt.sessionId = decision.sessionId;
        if (!attempt.live) {
            void this.stopSession(attempt).catch(() => undefined);
            return;
        }
        this.scheduleProgress(attempt);
        reachedStage(trace, "start");
        enterStage(trace, "subtitles");
        attempt.trace.received = decision.plan;
        attempt.sourceSeconds = decision.plan.timeline.sourceStartSeconds;
        if (attempt.request.allowAlternateVersions === false && decision.plan.effectiveMediaFileId !== attempt.request.fileId) {
            this.fail(attempt, { kind: "terminal", reason: "version_unavailable", message: "The selected version is no longer available. Choose another version in Details.", retryable: false }, true);
            return;
        }
        await attempt.subtitles.resolveInitialSubtitles(decision.plan, decision.serverFeatures);
    }

    private createSubtitleHost(attemptRef: { current?: Attempt }): SubtitleHost {
        const avplay = this.deps.avplay;
        const nativeText: NativeTextPort = {
            get canSelectInStream(): boolean {
                return avplay.getTotalTrackInfo !== undefined && avplay.setSelectTrack !== undefined && avplay.setSilentSubtitle !== undefined;
            },
            listTextTracks: () => {
                if (avplay.getTotalTrackInfo === undefined) return undefined;
                try { return parseAVPlayTextTracks(avplay.getTotalTrackInfo()); }
                catch { return undefined; }
            },
            selectTextTrack: (index) => {
                if (avplay.setSelectTrack === undefined) return false;
                try { avplay.setSelectTrack("TEXT", index); return true; }
                catch { return false; }
            },
            setSilentSubtitle: (hidden) => {
                if (avplay.setSilentSubtitle === undefined) return false;
                try { avplay.setSilentSubtitle(hidden); return true; }
                catch { return false; }
            },
        };

        const currentAttempt = (): Attempt | undefined => {
            const attempt = attemptRef.current;
            return attempt !== undefined && attempt.live && this.attempt === attempt ? attempt : undefined;
        };

        return {
            nativeText,
            snapshot: () => {
                const attempt = attemptRef.current;
                if (attempt === undefined) {
                    return { live: false, plan: undefined, started: false, presented: false, busy: false, hidden: false, restoring: false, recoveryActive: false, sourceSeconds: 0, audioVersions: undefined };
                }
                return {
                    live: attempt.live && this.attempt === attempt,
                    plan: attempt.plan,
                    started: attempt.started,
                    presented: attempt.presented,
                    busy: attempt.busy,
                    hidden: attempt.hidden,
                    restoring: attempt.restoring,
                    recoveryActive: attempt.recovery?.active === true,
                    sourceSeconds: attempt.sourceSeconds,
                    audioVersions: attempt.tracks,
                };
            },
            readPlayerTimeMs: () => {
                const attempt = currentAttempt();
                if (attempt === undefined || !attempt.started) return undefined;
                try {
                    const milliseconds = this.deps.avplay.getCurrentTime();
                    return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
                } catch {
                    return undefined;
                }
            },
            prepareTrackReplan: (plan, selected, positionSeconds) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return undefined;
                const sessionId = attempt.sessionId;
                const installationId = attempt.installationId;
                if (sessionId === undefined || installationId === undefined) return undefined;
                const transport = this.transport;
                enterStage(attempt.trace, REPLAN_STAGES.track_change);
                attempt.trace.buffering = false;
                const spec = this.buildReplanSpec(attempt, sessionId, installationId, plan, "track_change", positionSeconds, undefined, selected, attempt, undefined);
                const isCurrent = (): boolean => attempt.live && this.attempt === attempt && attempt.sessionId === sessionId && this.transport === transport;
                return {
                    sessionId,
                    isCurrent,
                    send: async () => {
                        if (!isCurrent()) throw abortedError();
                        const decision = await this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
                        if (isCurrent() && decision.outcome === "playable" && decision.sessionId === sessionId) {
                            attempt.trace.received = decision.plan;
                        }
                        return decision;
                    },
                };
            },
            waitForPendingSeeks: async (bounded) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                const transport = this.transport;
                const giveUp = bounded ? this.deps.clock.now() + STARTUP_TIMEOUT_MS : Number.POSITIVE_INFINITY;
                for (let seek = this.pending.seek; seek !== undefined; seek = this.pending.seek) {
                    if (!bounded) {
                        await seek.catch(() => undefined);
                    } else {
                        const left = giveUp - this.deps.clock.now();
                        if (left <= 0) { this.pending.seek = undefined; break; }
                        await Promise.race([seek.catch(() => undefined), sleep(this.deps.clock, left, attempt.signal, abortedError).catch(() => undefined)]);
                    }
                    if (!attempt.live || this.transport !== transport) return;
                }
            },
            changed: () => {
                const attempt = currentAttempt();
                if (attempt !== undefined) this.showPlayback(attempt);
            },
            beginSwitch: (mode) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                attempt.change = { state: "idle" };
                if (mode !== "reporting") this.clearThumbnails(attempt);
                if (mode !== "non_blocking") attempt.busy = true;
                this.showPlayback(attempt);
            },
            keepPlan: (plan, serverFeatures) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                const seconds = attempt.sourceSeconds;
                const started = attempt.started;
                const presented = attempt.presented;
                attempt.trace.received = plan;
                attempt.plan = plan;
                attempt.hud.read(this.deps.session, attempt.request.contentId, plan.effectiveMediaFileId, attempt.signal, () => this.showPlayback(attempt));
                attempt.serverFeatures = serverFeatures;
                attempt.planAttemptId = this.newId();
                attempt.sourceSeconds = seconds;
                attempt.started = started;
                attempt.presented = presented;
            },
            adoptPlan: (plan, serverFeatures, alignToPlayhead) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                attempt.trace.received = plan;
                if (alignToPlayhead) {
                    const target = attempt.queuedReanchorSeconds ?? attempt.sourceSeconds;
                    const start = startAt(plan, target);
                    this.adopt(attempt, start ?? plan, serverFeatures);
                    if (start === undefined && plan.delivery === "original_http" && target !== plan.timeline.sourceStartSeconds) {
                        attempt.queuedReanchorSeconds = target;
                    }
                    return;
                }
                this.adopt(attempt, plan, serverFeatures);
            },
            recordSwitch: (result, code, error) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                if (result === "pending") requestSwitch(attempt, "subtitle");
                else {
                    const failureCode = cleanIncidentCode(code) ?? httpCode(error) ?? (code === undefined && result !== "refused" ? undefined : "adaptation_unavailable");
                    this.settleSwitch(attempt, result, failureCode, error, code === "no_answer");
                }
            },
            recordCaption: (load, cause) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                if (load === "failed" || load === "fallback") {
                    captionLoadFailed(attempt, load, { http: cause?.http, network: cause?.network ?? false });
                } else attempt.trace.media.load = load;
            },
            settleSwitch: (keepBusyIfSeeking, postSettle: SubtitlePostSettle) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                if (!keepBusyIfSeeking || this.pending.seek === undefined) attempt.busy = false;
                if (postSettle.kind === "complete_stream") {
                    this.beginCompletion(attempt);
                    return;
                }
                if (attempt.started && (attempt.trace.stage === "track_change" || attempt.trace.stage === "quality_change")) {
                    enterStage(attempt.trace, "playing");
                }
                this.showPlayback(attempt);
                if (postSettle.kind === "recover_route") {
                    this.routeFailed(attempt, postSettle.classification);
                }
            },
            releaseBusyForReselect: () => {
                const attempt = currentAttempt();
                if (attempt !== undefined) attempt.busy = false;
            },
            flushQueuedReanchor: () => {
                const attempt = currentAttempt();
                if (attempt !== undefined) this.runQueuedReanchor(attempt);
            },
            closeForReplan: () => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                this.closeTransport();
                attempt.started = false;
                this.showLoading(attempt, undefined);
            },
            recoverConnection: () => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                attempt.busy = false;
                this.recoverConnection(attempt);
            },
            fail: (error, stopSession) => {
                const attempt = currentAttempt();
                if (attempt !== undefined) this.fail(attempt, error, stopSession);
            },
            failFromStartError: (error, stopSession) => {
                const attempt = currentAttempt();
                if (attempt === undefined) return;
                noteApiError(attempt.trace, error);
                this.fail(attempt, startFailure(error), stopSession);
            },
            failFromDecision: (decision, stopSession) => {
                const attempt = currentAttempt();
                if (attempt !== undefined) this.fail(attempt, traceDecision(attempt.trace, decision), stopSession);
            },
            sessionFailure: (error) => {
                const attempt = currentAttempt();
                if (attempt !== undefined) this.sessionFailure(attempt, error);
            },
        };
    }

    private buildReplanSpec(
        attempt: Attempt,
        sessionId: string,
        installationId: string,
        plan: PlaybackPlan,
        operation: ReplanOperation,
        positionSeconds: number,
        classification: string | undefined,
        selected: SelectedTracks,
        quality: PlaybackDefaults,
        buffering: ReplanRequest | undefined,
    ) {
        return operations.replanPlayback(sessionId, {
            installation_id: installationId,
            protocol_version: 3,
            client_features: this.features(attempt),
            operation,
            playback_attempt_id: attempt.playbackAttemptId,
            replan_request_id: this.newId(),
            failed_plan_id: plan.planId,
            plan_attempt_id: attempt.planAttemptId,
            plan_attempt_key: plan.planAttemptKey,
            attempted_plan_keys: attempt.attemptedKeys.slice(),
            attempt_count: Math.max(1, attempt.recoveries),
            quality_preference: quality.qualityPreference,
            ...(quality.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: quality.bandwidthCapKbps }),
            ...this.replanBufferingMembers(attempt, operation, buffering),
            position_seconds: positionSeconds,
            selected_tracks: selected,
            ...(classification === undefined ? {} : { failure: { classification } }),
            ...this.reportedPlayback(attempt),
        });
    }

    private async replan(
        attempt: Attempt,
        plan: PlaybackPlan,
        operation: ReplanOperation,
        positionSeconds: number,
        classification: string | undefined,
        selected: SelectedTracks = attempt.subtitles.chosenTracks(plan),
        quality: PlaybackDefaults = attempt,
        buffering?: ReplanRequest,
    ): Promise<void> {
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined) {
            return;
        }
        const transport = this.transport;
        const current = (): boolean => attempt.live && attempt.sessionId === sessionId && this.transport === transport;
        enterStage(attempt.trace, REPLAN_STAGES[operation]);
        attempt.trace.buffering = buffering !== undefined;
        const replan = this.buildReplanSpec(attempt, sessionId, installationId, plan, operation, positionSeconds, classification, selected, quality, buffering);
        let decision: PlaybackDecision;
        try {
            const send = (): Promise<PlaybackDecision> => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...replan, profileScoped: true, signal: attempt.signal });
            };
            decision = await this.resend(attempt, send);
        } catch (error) {
            this.qualityUnsettled(attempt, buffering);
            if (!current()) {
                return;
            }
            if (buffering !== undefined && !sessionGone(error)) {
                // Apple keeps the current plan only when the server answered with a refusal.
                if (rejectedReplan(error)) {
                    traceStep(attempt.trace, "refused", httpCode(error));
                    this.keepPlaying(attempt);
                    return;
                }
                noteApiError(attempt.trace, error);
                traceFailure(attempt.trace, "fail", httpCode(error) ?? "no_answer");
                // A lost or unusable answer cannot prove the server kept the old plan, so reconnect and play the one it holds, as Apple does.
                if (attempt.presented) {
                    attempt.change = { state: "idle" };
                    this.recoverConnection(attempt);
                    return;
                }
            }
            if ((operation === "track_change" || operation === "quality_change") && unanswered(error) && attempt.presented
                && (attempt.recovery?.active === true || (error instanceof ApiError && error.transient))) {
                if (operation === "track_change") this.settleSwitch(attempt, "failed", "no_answer", error, true);
                attempt.change = { state: "failed" };
                attempt.busy = false;
                this.recoverConnection(attempt);
                return;
            }
            // A missing or unusable answer cannot prove that the server rolled the change back.
            if (operation === "track_change" && error instanceof ApiError && !error.transient && error.failure.kind !== "invalid_response" && !sessionGone(error)) {
                this.settleSwitch(attempt, "failed", httpCode(error), error);
                this.changeSettled(attempt, { state: "failed" });
                return;
            }
            if (operation === "failure_recovery" && unanswered(error) && attempt.presented && this.shownError === undefined) {
                this.releaseFailedRoute(attempt);
                if (attempt.recovery?.active === true) this.noteTransportUnanswered(attempt, error);
                else this.recoverConnection(attempt);
                return;
            }
            this.sessionFailure(attempt, error);
            return;
        }
        if (!current()) {
            return;
        }
        if ((operation === "track_change" || operation === "quality_change") && decision.outcome === "adaptation_unavailable") {
            this.qualityUnsettled(attempt, buffering);
            if (buffering !== undefined) {
                this.keepPlaying(attempt);
                return;
            }
            if (operation === "track_change") this.settleSwitch(attempt, "refused", cleanIncidentCode(decision.terminal.reason) ?? "adaptation_unavailable");
            this.changeSettled(attempt, { state: "refused", message: decision.terminal.message });
            return;
        }
        attempt.busy = false;
        if (decision.outcome === "playable") {
            if (decision.sessionId !== sessionId) {
                this.fail(attempt, { kind: "server" }, true);
                return;
            }
            attempt.trace.received = decision.plan;
            if (operation === "quality_change") {
                attempt.qualityPreference = quality.qualityPreference;
                attempt.bandwidthCapKbps = quality.bandwidthCapKbps;
                // The buffering controller's lowering is nobody's pick; a viewer's pick resets what it decided.
                if (buffering === undefined) {
                    attempt.qualityPicked = true;
                    attempt.bufferingQuality.qualityChanged();
                }
            }
            this.adopt(attempt, decision.plan, decision.serverFeatures, buffering);
        } else {
            this.qualityUnsettled(attempt, buffering);
            if (buffering !== undefined) {
                this.keepPlaying(attempt);
                return;
            }
            this.fail(attempt, traceDecision(attempt.trace, decision), true);
        }
    }

    /** The buffering controller's replan did not become a plan: the transport that was playing keeps playing. */
    private keepPlaying(attempt: Attempt): void {
        // The kept transport is playing again, so a later failure is not this replan's.
        enterStage(attempt.trace, "playing");
        attempt.trace.buffering = false;
        attempt.busy = false;
        attempt.change = { state: "idle" };
        if (attempt.endedDuringChange) {
            this.beginCompletion(attempt);
            return;
        }
        this.showPlayback(attempt);
    }

    /** A quality change did not become a plan: the controller hears that its own replan failed, or that the viewer's pick did. */
    private qualityUnsettled(attempt: Attempt, buffering: ReplanRequest | undefined): void {
        if (buffering === undefined) attempt.bufferingQuality.pickRefused();
        else attempt.bufferingQuality.replanFailed(buffering);
    }

    /** A codec or route failure on this TV: the server picks the next route, a bounded number of times. */
    private routeFailed(attempt: Attempt, classification: string): void {
        attempt.queuedSeekSeconds = undefined;
        attempt.queuedSkips = undefined;
        attempt.pendingSkipUndo = undefined;
        const plan = attempt.plan;
        if (!attempt.live || plan === undefined) {
            return;
        }
        if (attempt.busy) {
            if (attempt.subtitles.onRouteFailed(classification, true) === "absorbed_by_blocking_change") {
                return;
            }
            if (attempt.change.state === "changing") {
                attempt.changeFailure = attempt.changeFailure ?? classification;
            } else if (this.pending.seek !== undefined && attempt.seekFailure === undefined) {
                attempt.seekFailure = classification;
                this.show({ phase: "loading", title: attempt.request.title });
            }
            return;
        }
        // An unresolved switch may have replaced the plan this recovery would name: resolve it now, and recover from its answer (#750).
        // The failed transport stays open until then, as the switch's replay belongs to it; the recovery closes it.
        if (attempt.subtitles.onRouteFailed(classification, false) === "absorbed_by_direct_switch") {
            attempt.busy = true;
            this.show({ phase: "loading", title: attempt.request.title });
            return;
        }
        this.closeTransport();
        attempt.started = false;
        traceFailure(attempt.trace, attempt.recoveries >= MAX_RECOVERY_REPLANS ? "fail" : "fallback", attempt.trace.lastAvplay ?? classification);
        if (attempt.recoveries >= MAX_RECOVERY_REPLANS) {
            attempt.trace.exhausted = true;
            this.fail(attempt, { kind: "playback_failed" }, true);
            return;
        }
        attempt.recoveries++;
        attempt.trace.fallbacks++;
        if (attempt.attemptedKeys.indexOf(plan.planAttemptKey) === -1) {
            attempt.attemptedKeys.push(plan.planAttemptKey);
        }
        attempt.busy = true;
        this.show({ phase: "loading", title: attempt.request.title });
        this.clearThumbnails(attempt);
        void this.replan(attempt, plan, "failure_recovery", attempt.sourceSeconds, classification);
    }

    // --- tracks ---

    /** The attempt, when nothing else is in flight: a pending seek or change makes a choice wait. */
    private changeable(): Attempt | undefined {
        const attempt = this.active();
        // A subtitle switch whose answer is unknown leaves the plan uncertain, so no other change is sent over it until it is answered.
        return attempt !== undefined && attempt.started && !attempt.busy && !attempt.subtitles.subtitleSwitchOut ? attempt : undefined;
    }

    /**
     * client_selected_audio_track_v1: the plan's audio index is an ordinal in the server's audio_tracks,
     * the source's probed order, so it is the nth AUDIO row of the original file. Call right after play():
     * AVPlay switches AUDIO only in PLAYING. False, a failed route, whenever the stream cannot show
     * or play that row: the claim promises the ordinal, so the server must be told to package instead.
     */
    private selectPlanAudio(plan: PlaybackPlan): boolean {
        const ordinal = plan.selectedTracks.audio?.index;
        const avplay = this.deps.avplay;
        if (plan.delivery !== "original_http" || plan.selectedTracks.audio === undefined) return true;
        // The id alone is opaque: without the ordinal this client cannot honor the selection.
        if (ordinal === undefined || avplay.getTotalTrackInfo === undefined || avplay.setSelectTrack === undefined) return false;
        try {
            const target = avplay.getTotalTrackInfo().filter((track) => track.type === "AUDIO")[ordinal];
            if (target === undefined) return false;
            const playing = avplay.getCurrentStreamInfo?.().find((track) => track.type === "AUDIO");
            if (playing?.index !== target.index) avplay.setSelectTrack("AUDIO", target.index);
            return true;
        } catch {
            return false;
        }
    }

    private changeTracks(attempt: Attempt, plan: PlaybackPlan, selected: SelectedTracks): void {
        this.clearThumbnails(attempt);
        attempt.subtitles.onTransportChangeStarted();
        attempt.busy = true;
        attempt.change = { state: "changing" };
        this.showPlayback(attempt);
        void this.replan(attempt, plan, "track_change", attempt.sourceSeconds, undefined, selected);
    }

    /** Settles the viewer's pending switch once; anything but success also becomes the attempt's media failure. */
    private settleSwitch(attempt: Attempt, result: Exclude<MediaSwitchResult, "pending">, code?: string, error?: unknown, network = false): void {
        const pending = attempt.trace.media.switch;
        if (pending?.result !== "pending") return;
        const failureCode = result === "ok" ? undefined : code ?? (pending.kind === "audio" ? "audio_track_switch_failed" : "subtitle_track_switch_failed");
        attempt.trace.media.switch = { kind: pending.kind, result, ...(failureCode === undefined ? {} : { code: failureCode }) };
        if (result !== "ok") mediaFailed(attempt, pending.kind === "audio" ? "audio_switch" : "subtitle_switch", result, failureCode, error instanceof ApiError ? error.status : undefined, network);
    }

    private changeSettled(attempt: Attempt, change: TrackChange): void {
        // Paths with a known cause settle the switch first; this records the rest.
        if (change.state === "idle") this.settleSwitch(attempt, "ok");
        else if (change.state === "failed" || change.state === "refused") this.settleSwitch(attempt, change.state);
        attempt.busy = false;
        attempt.change = change;
        if (attempt.endedDuringChange) {
            this.beginCompletion(attempt);
            return;
        }
        if (attempt.started && (attempt.trace.stage === "track_change" || attempt.trace.stage === "quality_change")) {
            enterStage(attempt.trace, "playing");
        }
        this.showPlayback(attempt);
        const failure = attempt.changeFailure;
        attempt.changeFailure = undefined;
        if (failure !== undefined) {
            this.routeFailed(attempt, failure);
        }
    }

    private readTracks(attempt: Attempt): void {
        const read = ++attempt.trackRead;
        attempt.tracks = { state: "loading" };
        const spec = operations.catalogItemVersions(attempt.request.contentId);
        this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal }).then(
            (versions) => {
                if (attempt.trackRead === read) {
                    attempt.tracks = { state: "ready", versions };
                    this.showPlayback(attempt);
                }
            },
            () => {
                if (attempt.trackRead === read) {
                    attempt.tracks = { state: "failed" };
                    this.showPlayback(attempt);
                }
            },
        );
    }

    // --- transport ---

    private adopt(attempt: Attempt, plan: PlaybackPlan, serverFeatures: readonly string[], bufferingReplan?: ReplanRequest): void {
        reachedStage(attempt.trace, attempt.trace.stage);
        this.clearThumbnails(attempt);
        attempt.plan = plan;
        // The new stream has not started: what the old one reported must not reach the buffering controller while this adoption redraws.
        attempt.started = false;
        attempt.buffering = false;
        attempt.hud.read(this.deps.session, attempt.request.contentId, plan.effectiveMediaFileId, attempt.signal, () => this.showPlayback(attempt));
        attempt.subtitles.onPlanAdopted(plan, attempt.profileId);
        this.readMarkers(attempt, plan.effectiveMediaFileId);
        attempt.serverFeatures = serverFeatures;
        attempt.recoverySpec = undefined;
        attempt.recoveryRetryAt = 0;
        attempt.change = { state: "idle" };
        attempt.busy = false;
        attempt.seekFailure = undefined;
        attempt.changeFailure = undefined;
        attempt.endedDuringChange = false;
        if (attempt.tracks === undefined) {
            this.readTracks(attempt);
        }
        attempt.planAttemptId = this.newId();
        attempt.previewKey = this.newId();
        attempt.sourceSeconds = plan.timeline.sourceStartSeconds;
        attempt.started = false;
        attempt.bufferingAdvertised = serverFeatures.includes(BUFFERING_QUALITY_FEATURE);
        attempt.bufferingQuality.advertised = attempt.bufferingAdvertised;
        attempt.bufferingQuality.mode = attempt.bufferingMode;
        attempt.bufferingQuality.planAdopted(plan, serverFeatures, attempt.qualityPreference, bufferingReplan);
        this.showLoading(attempt, attempt.resuming ? "reconnecting" : undefined);
        void this.open(attempt, plan);
    }

    private async open(attempt: Attempt, plan: PlaybackPlan): Promise<void> {
        this.closeTransport();
        const transport = this.transport;
        while (this.pending.closing !== undefined || this.pending.seek !== undefined || this.pending.restore !== undefined) {
            await (this.pending.closing ?? this.pending.seek ?? this.pending.restore);
        }
        if (transport !== this.transport || !attempt.live) {
            return;
        }
        if (attempt.hidden || attempt.restoring) {
            attempt.deferredOpen = true;
            return;
        }
        const base = this.deps.session.http.base;
        // Root-relative URLs are on the API origin, below any path prefix the server sits behind.
        const published = plan.streamUrl.charAt(0) === "/" ? base.baseUrl + plan.streamUrl : plan.streamUrl;
        let media: URL;
        try {
            media = new URL(published);
            if (!isPermittedUrl(media, base.baseUrl)) {
                this.fail(attempt, { kind: "server" }, true);
                return;
            }
        } catch {
            this.fail(attempt, { kind: "server" }, true);
            return;
        }
        let url = published;
        if (media.origin === base.origin) {
            // Gate C candidate (playback-api.md, Delivery): the signed `st` the plan carries plus the
            // account bearer as `token`, because AVPlay cannot send headers. Never sent to another origin.
            let token: string;
            enterStage(attempt.trace, "media_token");
            try {
                token = await this.deps.session.mediaToken(attempt.signal);
            } catch (error) {
                if (transport === this.transport && attempt.live) {
                    noteApiError(attempt.trace, error);
                    this.fail(attempt, startFailure(error), true);
                }
                return;
            }
            if (transport !== this.transport || !attempt.live) return;
            reachedStage(attempt.trace, "media_token");
            url = withMediaToken(published, token);
        }
        if (attempt.hidden || attempt.restoring) {
            attempt.deferredOpen = true;
            return;
        }
        enterStage(attempt.trace, "playlist_check");
        const unreadable = await this.playlistUnreadable(attempt, plan, url);
        if (transport !== this.transport || !attempt.live) return;
        if (unreadable) {
            traceFailure(attempt.trace, "fail", "hls_playlist_unreadable");
            this.fail(attempt, { kind: "playback_failed" }, true);
            return;
        }
        reachedStage(attempt.trace, "playlist_check");
        if (attempt.hidden || attempt.restoring) {
            attempt.deferredOpen = true;
            return;
        }
        const avplay = this.deps.avplay;
        try {
            enterStage(attempt.trace, "avplay_open");
            avplay.open(url);
            attempt.trace.opened = true;
            reachedStage(attempt.trace, "avplay_open");
            enterStage(attempt.trace, "avplay_prepare");
            avplay.setListener(this.listen(attempt, transport));
            attempt.appliedRect = undefined;
            this.paintRect(attempt);
            this.armStartup(attempt, transport);
            avplay.prepareAsync(
                () => {
                    if (transport === this.transport && attempt.live) {
                        this.prepared(attempt, plan, transport);
                    }
                },
                (error) => {
                    if (transport !== this.transport || !attempt.live) {
                        return;
                    }
                    noteAvplay(attempt, `prepareAsync:${error.name || "error"}`);
                    if (error.name === "InvalidAccessError") {
                        // An unplayed replacement may be unreachable even when the previous transport played.
                        if (attempt.presented) this.routeFailed(attempt, "avplay_prepare_failed");
                        else this.fail(attempt, { kind: "network" }, true);
                    } else {
                        this.routeFailed(attempt, "avplay_prepare_failed");
                    }
                },
            );
        } catch (error) {
            const name = error instanceof Error && error.name ? error.name : "error";
            noteAvplay(attempt, `open:${name}`);
            this.routeFailed(attempt, "avplay_open_failed");
        }
    }

    private prepared(attempt: Attempt, plan: PlaybackPlan, transport: number): void {
        reachedStage(attempt.trace, "avplay_prepare");
        const play = (): void => {
            if (transport !== this.transport || !attempt.live) {
                return;
            }
            this.cancelStartup?.();
            this.cancelStartup = undefined;
            this.startupDue = undefined;
            if (attempt.hidden || attempt.restoring) {
                try {
                    this.deps.avplay.suspend?.();
                    attempt.suspendedReady = true;
                } catch {
                    attempt.suspendedReady = false;
                }
                return;
            }
            let audioSelected: boolean;
            if (attempt.trace.stage === "avplay_seek") reachedStage(attempt.trace, "avplay_seek");
            enterStage(attempt.trace, "avplay_play");
            try {
                this.deps.avplay.play();
                audioSelected = this.selectPlanAudio(plan);
                attempt.hud.restore(this.deps.avplay, plan);
                if (attempt.paused) {
                    this.deps.avplay.pause();
                }
                if (attempt.rectPending) {
                    this.setDisplayRect(attempt);
                    attempt.rectPending = false;
                }
            } catch (error) {
                const name = error instanceof Error && error.name ? error.name : "error";
                noteAvplay(attempt, `play:${name}`);
                this.routeFailed(attempt, "avplay_play_failed");
                return;
            }
            if (!audioSelected) {
                this.routeFailed(attempt, AUDIO_TRACK_SWITCH_FAILED);
                return;
            }
            // The plan carrying the viewer's track plays; a route failure before this belongs to playback recovery.
            // A subtitle switch still out over this stream is settled by its own answer.
            if (!attempt.subtitles.subtitleSwitchOut) this.settleSwitch(attempt, "ok");
            attempt.started = true;
            attempt.presented = true;
            attempt.resuming = false;
            reachedStage(attempt.trace, "avplay_play");
            enterStage(attempt.trace, "playing");
            attempt.trace.buffering = false;
            this.finishSkipSeek(attempt, true);
            if (attempt.recovery?.active === true) attempt.recovery.recovered(this.deps.clock.now());
            if (attempt.cancelTimer === undefined) {
                this.scheduleProgress(attempt);
            }
            if (attempt.subtitles.alignOpenStream(plan) !== "aligned") return;
            // Apple reads the next episode and On Deck once the item loads (PlayerViewModel.swift:6604-6607), so Show Up Next is offered from the start.
            this.beginDiscovery(attempt);
            this.updatePrompt(attempt);
            this.showPlayback(attempt);
            attempt.subtitles.consumePreparedChoices(plan);
            this.runQueuedReanchor(attempt);
        };
        const startMs = Math.round(plan.timeline.playerStartSeconds * 1000);
        if (startMs <= 0) {
            play();
            return;
        }
        enterStage(attempt.trace, "avplay_seek");
        try {
            this.seekTo(startMs, play, () => {
                if (transport === this.transport && attempt.live) {
                    noteAvplay(attempt, "seekTo:failed");
                    this.routeFailed(attempt, "avplay_resume_seek_failed");
                }
            });
        } catch (error) {
            const name = error instanceof Error && error.name ? error.name : "error";
            noteAvplay(attempt, `seekTo:${name}`);
            this.routeFailed(attempt, "avplay_resume_seek_failed");
        }
    }

    /** A seek queued behind a switch whose answer replaced the transport runs once the new stream plays (#756). */
    private runQueuedReanchor(attempt: Attempt): void {
        const reanchor = attempt.queuedReanchorSeconds;
        if (reanchor === undefined || attempt.subtitles.subtitleSwitchOut || attempt.busy) return;
        attempt.queuedReanchorSeconds = undefined;
        this.seekAbsolute(reanchor);
    }

    private listen(attempt: Attempt, transport: number): AVPlayListener {
        let advanced = false;
        const current = (): boolean => transport === this.transport && attempt.live;
        return {
            onbufferingstart: () => {
                if (current()) {
                    attempt.buffering = true;
                    this.showPlayback(attempt);
                }
            },
            onbufferingprogress: () => undefined,
            onbufferingcomplete: () => {
                if (current()) {
                    attempt.buffering = false;
                    this.showPlayback(attempt);
                }
            },
            oncurrentplaytime: (milliseconds) => {
                const plan = attempt.plan;
                if (current() && attempt.started && (!attempt.busy || changeHoldsBusy(attempt)) && plan !== undefined) {
                    const previousSeconds = attempt.sourceSeconds;
                    attempt.sourceSeconds = milliseconds / 1000 + plan.timeline.timelineOffsetSeconds;
                    if (!advanced && !attempt.paused && this.pending.seek === undefined && attempt.trace.stage === "playing" && attempt.sourceSeconds > previousSeconds) {
                        advanced = true;
                        if (tracePlaying(attempt.trace)) {
                            attempt.trace.frozen = this.traceOf(attempt);
                            attempt.trace.steps.length = 0;
                        }
                    }
                    const marker = markerAt(attempt.markers?.segments ?? [], attempt.sourceSeconds);
                    if (!attempt.busy && marker !== undefined && !attempt.skippedMarkers.has(marker) && ((marker.kind === "intro" && attempt.introMode === "always") || (marker.kind === "credits" && attempt.skipCredits))) {
                        attempt.skippedMarkers.add(marker);
                        attempt.undoSkip = undefined;
                        // Apple offers Watch Intro after an automatic intro skip and nothing after a credits skip.
                        attempt.pendingSkipUndo = marker.kind === "intro" ? marker.startSeconds : undefined;
                        if (marker.kind === "credits") {
                            this.performCreditsSkip(attempt, marker.endSeconds);
                            return;
                        }
                        this.seekAbsolute(marker.endSeconds);
                        // Apple arms Watch Intro's five seconds as it issues the skip, so the seek counts against them.
                        this.showPlayback(attempt);
                        return;
                    }
                    this.updatePrompt(attempt);
                    this.showPlayback(attempt);
                }
            },
            onstreamcompleted: () => {
                if (!current() || !attempt.started) return;
                if (attempt.busy) {
                    if (attempt.subtitles.onStreamCompleted() === "deferred" || attempt.change.state === "changing") {
                        attempt.endedDuringChange = true;
                        this.showPlayback(attempt);
                    }
                    return;
                }
                this.beginCompletion(attempt);
            },
            onevent: () => undefined,
            onerror: (eventType) => {
                // Before the first frame, prepareAsync's own callbacks decide.
                if (!current() || !attempt.started) {
                    return;
                }
                noteAvplay(attempt, eventType);
                if (eventType === "PLAYER_ERROR_CONNECTION_FAILED") {
                    attempt.bufferingQuality.noteMediaRequestFailed();
                    this.recoverConnection(attempt, eventType);
                } else {
                    this.routeFailed(attempt, "avplay_playback_error");
                }
            },
        };
    }

    private finishSkipSeek(attempt: Attempt, moved: boolean): void {
        const seconds = attempt.pendingSkipUndo;
        attempt.pendingSkipUndo = undefined;
        if (moved && seconds !== undefined) {
            attempt.undoSkip = seconds;
        }
    }

    private beginCompletion(attempt: Attempt): void {
        attempt.endedDuringChange = false;
        this.leave(attempt, "abandon");
        this.nextStart = undefined;
        this.nextStartUnattended = false;
        this.completion = { attempt, abort: new AbortController(), pending: false, autoplays: false, pickingAnother: false, advancingShuffle: false, shuffleScopeLabel: attempt.request.shuffleScopeLabel };
        this.runCompletion();
    }

    private closeTransport(): void {
        const attempt = this.attempt;
        // A playing scrub pauses the stream and queues Play. The seek callback
        // drops that intent once this transport is gone, so keep it for the replacement.
        if (attempt?.pauseAfterSeek !== undefined) {
            attempt.paused = attempt.pauseAfterSeek;
            attempt.pauseAfterSeek = undefined;
        }
        this.transport++;
        if (attempt !== undefined) {
            attempt.suspended = false;
            attempt.suspendedReady = false;
            attempt.deferredOpen = false;
            attempt.restoreOpen = undefined;
        }
        this.startupDue = undefined;
        this.cancelStartup?.();
        this.cancelStartup = undefined;
        const pending = [this.pending.seek, this.pending.restore].filter((op): op is Promise<void> => op !== undefined);
        if (pending.length > 0) {
            const closing = Promise.all(pending).then(() => this.closeAVPlay());
            this.pending.closing = closing;
            void closing.then(() => {
                if (this.pending.closing === closing) {
                    this.pending.closing = undefined;
                }
            });
        } else {
            this.closeAVPlay();
        }
    }

    private closeAVPlay(): void {
        try {
            this.deps.avplay.close();
        } catch {
            // The pending seek has settled; a platform failure cannot be repaired here.
        }
    }

    private seekTo(milliseconds: number, success: () => void, error: () => void): void {
        let release: () => void = () => undefined;
        const seek = new Promise<void>((resolve) => { release = resolve; });
        this.pending.seek = seek;
        const settled = (callback: () => void): void => {
            if (this.pending.seek === seek) {
                this.pending.seek = undefined;
            }
            release();
            callback();
        };
        try {
            this.deps.avplay.seekTo(milliseconds, () => settled(success), () => settled(error));
        } catch {
            settled(error);
        }
    }

    // --- progress and stop ---

    private scheduleProgress(attempt: Attempt): void {
        attempt.cancelTimer?.();
        const due = this.deps.clock.now() + PROGRESS_INTERVAL_MS;
        attempt.progressDue = due;
        attempt.cancelTimer = this.deps.clock.schedule(() => {
            attempt.cancelTimer = undefined;
            attempt.progressDue = undefined;
            if (!attempt.live || attempt.hidden || attempt.recovery?.active === true) {
                return;
            }
            this.sendProgress(attempt);
            this.scheduleProgress(attempt);
        }, PROGRESS_INTERVAL_MS);
    }

    private sendProgress(attempt: Attempt): void {
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined || attempt.progress !== undefined) {
            return;
        }
        const spec = operations.updatePlaybackProgress(sessionId, {
            installation_id: installationId,
            sequence: ++attempt.sequence,
            position: this.reportPosition(attempt),
            is_paused: samplePaused(attempt),
        });
        attempt.progress = this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal }).then(
            () => {
                if (attempt.sessionId !== sessionId) return;
                attempt.progress = undefined;
            },
            (error: unknown) => {
                if (attempt.sessionId !== sessionId) return;
                attempt.progress = undefined;
                if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 410 || error.problemId === "installation_changed")) attempt.progressRefusal = error;
                if (!attempt.live || !(error instanceof ApiError)) {
                    return;
                }
                const status = error.status;
                // Other answers (stale, conflict, transient) leave playback alone; the next sample is newer.
                if (status === 410 || status === 404 || error.problemId === "installation_changed") {
                    enterStage(attempt.trace, "progress");
                    this.sessionFailure(attempt, error);
                }
            },
        );
    }

    /** `once` sends the STOP a single time instead of retrying a failure that may clear; `sent` counts the sends already made. */
    private async stopSession(attempt: Attempt, once = false, sent = 0): Promise<void> {
        if (attempt.stopped) return;
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (sessionId === undefined || installationId === undefined) {
            return;
        }
        // Stop is the last word: it waits for the sample in flight and carries the next sequence.
        await attempt.progress;
        if (attempt.progressRefusal !== undefined) throw attempt.progressRefusal;
        const spec = attempt.stopSpec ?? operations.stopPlayback(sessionId, {
            installation_id: installationId,
            stop_id: this.newId(),
            sequence: ++attempt.sequence,
            position: this.reportPosition(attempt),
            is_paused: samplePaused(attempt),
        });
        attempt.stopSpec = spec;
        if (attempt.stopRetryAt > this.deps.clock.now()) await sleep(this.deps.clock, attempt.stopRetryAt - this.deps.clock.now(), attempt.signal, abortedError);
        const send = async () => {
            try {
                return await this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
            } catch (error) {
                if (error instanceof ApiError) attempt.stopRetryAt = this.deps.clock.now() + (error.retryAfterSeconds ?? 0) * 1000;
                throw error;
            }
        };
        const receipt = once ? await send() : await this.resend(attempt, send, sent);
        if ((receipt.outcome !== "stopped" && receipt.outcome !== "replayed") || (receipt.stopId !== undefined && receipt.stopId !== spec.body?.stop_id)) {
            throw new ApiError({ kind: "invalid_response", path: "playback_stop.receipt" });
        }
        attempt.stopped = true;
        attempt.ended = true;
    }

    retryCompletion(): void {
        this.stillWatching.recordViewerAction();
        this.runCompletion();
    }

    private runCompletion(): void {
        const completion = this.completion;
        if (completion === undefined) {
            const attempt = this.attempt;
            if (attempt?.live === true && attempt.presented && this.shownError?.kind === "network") {
                this.shownError = undefined;
                const step = attempt.recovery?.step ?? "replan";
                attempt.resuming = true;
                this.showLoading(attempt, "reconnecting");
                this.arm(attempt, true, step);
                return;
            }
            if (this.shownError !== undefined && (retryableStart(this.shownError) || this.shownError.kind === "playback_failed")) {
                const replay = this.shownError.kind === "playback_failed" || (!attempt?.started && this.shownError.kind !== "settings");
                const next = attempt !== undefined && replay ? sameStart(attempt) : this.nextStart;
                if (next !== undefined) this.play(next);
            }
            return;
        }
        const view = this.current;
        if (view.phase === "completion" && view.state === "failed" && !view.retryable) return;
        if (completion.pending || completion.abort.signal.aborted || completion.attempt.signal.aborted) return;
        completion.pending = true;
        void this.finishCompletion(completion);
    }

    showUpNext(): void {
        const attempt = this.active();
        if (attempt?.started !== true || attempt.plan === undefined || !this.canApplyDisplayRect(attempt) || attempt.request.shuffleId !== undefined) return;
        // A hidden button opens nothing: a film with nothing to offer stays closed.
        if (!this.episodesVisible(attempt)) return;
        this.stillWatching.recordViewerAction();
        attempt.offer.manual = true;
        if (!attempt.offer.started) this.beginDiscovery(attempt);
        else {
            const offer = attempt.offer;
            if (offer.episodeFailed && !offer.episodeLoading && !offer.episodeManualRetried) { offer.episodeManualRetried = true; this.retryEpisode(attempt); }
            if (offer.deckFailed && !offer.deckLoading && !offer.deckManualRetried) { offer.deckManualRetried = true; this.retryDeck(attempt); }
        }
        this.publishOffer(attempt);
    }

    /** The screen may pass a synopsis copy. Play the offer it came from. */
    private liveNext(attempt: Attempt, selected: PlayRequest | undefined): PlayRequest | undefined {
        const prompt = attempt.prompt;
        if (prompt === undefined) return undefined;
        if (selected === undefined) return prompt.next;
        if (selected === prompt.next || prompt.deck.includes(selected)) return selected;
        if (prompt.next !== undefined && prompt.next.contentId === selected.contentId && prompt.next.fileId === selected.fileId) return prompt.next;
        return prompt.deck.find(item => item.contentId === selected.contentId && item.fileId === selected.fileId);
    }

    playNext(selected?: PlayRequest): void {
        this.advanceNext(selected, false);
    }

    private advanceNext(selected: PlayRequest | undefined, unattended: boolean): void {
        if (!unattended) this.stillWatching.recordViewerAction();
        const view = this.current;
        const attempt = this.active();
        if ((view.phase === "playing" || view.phase === "paused") && attempt?.prompt !== undefined) {
            const request = this.liveNext(attempt, selected);
            if (request === undefined) return;
            if (unattended) this.stillWatching.recordAutoAdvance();
            this.beginCompletion(attempt);
            this.nextStart = request;
            this.nextStartUnattended = unattended;
            return;
        }
        if (view.phase !== "completion" || view.state !== "ready" || view.next === undefined || this.completion?.attempt.ended !== true) return;
        const completion = this.completion;
        const request = selected ?? view.next;
        if (request !== view.next && !view.deck?.includes(request)) return;
        const shuffleId = completion.attempt.request.shuffleId;
        if (shuffleId !== undefined && request === view.next) {
            if (completion.advancingShuffle || completion.pickingAnother) return;
            if (unattended) this.stillWatching.recordAutoAdvance();
            this.cancelAutoplayTimer?.();
            this.cancelAutoplayTimer = undefined;
            completion.advancingShuffle = true;
            this.show({ ...view, countdown: undefined, shuffleActionError: undefined });
            const fromContentId = completion.attempt.request.contentId;
            void this.pickQuality(completion.abort.signal).then(quality => advanceShufflePick(spec => {
                if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted) throw abortedError();
                return this.deps.session.call({ ...spec, profileScoped: true, signal: completion.abort.signal });
            }, shuffleId, fromContentId, quality)).then(result => {
                if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted) return;
                completion.advancingShuffle = false;
                const currentView = this.current;
                if (result.kind === "lookup_failed") {
                    completion.advancedShuffle = result.shuffle;
                    completion.advancedShuffleUnattended = unattended;
                    completion.autoplays = false;
                    if (currentView.phase === "completion") {
                        const retryable = !(result.cause instanceof ApiError && (result.cause.status === 401 || result.cause.status === 403 || result.cause.status === 410 || result.cause.problemId === "installation_changed"));
                        this.show({ ...currentView, state: "failed", status: "upNext.headingFinished", next: undefined, retryable, countdown: undefined, shuffleActionError: undefined });
                    }
                    return;
                }
                const picked = result.next;
                if (picked === undefined) {
                    completion.autoplays = false;
                    if (currentView.phase === "completion") {
                        this.show({ ...currentView, status: "upNext.headingFinished", next: undefined, countdown: undefined, shuffleActionError: undefined });
                    }
                    return;
                }
                this.cancelCompletion();
                this.nextStart = picked;
                this.startPlay(picked, unattended);
            }, (error: unknown) => {
                if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted) return;
                completion.advancingShuffle = false;
                completion.attempt.promptDismissed = true;
                const currentView = this.current;
                if (currentView.phase !== "completion") return;
                if (error instanceof ApiError && error.status === 409) {
                    completion.autoplays = false;
                    this.show({ ...currentView, status: "upNext.headingFinished", next: undefined, countdown: undefined, shuffleActionError: undefined });
                    return;
                }
                this.show({ ...currentView, countdown: undefined, shuffleActionError: "upNext.shuffleContinueFailed" });
            });
            return;
        }
        if (unattended) this.stillWatching.recordAutoAdvance();
        this.cancelCompletion();
        this.nextStart = request;
        this.startPlay(request, unattended);
    }

    pickAnother(): void {
        const completion = this.completion;
        const view = this.current;
        if (completion === undefined || view.phase !== "completion" || view.state !== "ready" || view.shuffle !== true || view.next === undefined || completion.pickingAnother || completion.advancingShuffle || completion.advancedShuffle !== undefined) return;
        const shuffleId = completion.attempt.request.shuffleId;
        if (shuffleId === undefined) return;
        this.stillWatching.recordViewerAction();
        this.cancelAutoplayTimer?.();
        this.cancelAutoplayTimer = undefined;
        completion.pickingAnother = true;
        const skippedContentId = view.next.contentId;
        this.show({ ...view, countdown: undefined, shuffleActionError: undefined });
        void this.pickQuality(completion.abort.signal).then(quality => skipShuffle(spec => {
            if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted) throw abortedError();
            return this.deps.session.call({ ...spec, profileScoped: true, signal: completion.abort.signal });
        }, shuffleId, skippedContentId, quality)).then(result => {
            if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted) return;
            completion.pickingAnother = false;
            if (result.scopeLabel !== undefined) completion.shuffleScopeLabel = result.scopeLabel;
            const currentView = this.current;
            if (currentView.phase !== "completion") return;
            const scope = completion.shuffleScopeLabel;
            if (result.kind === "lookup_failed") {
                completion.autoplays = false;
                const retryable = !(result.cause instanceof ApiError && (result.cause.status === 401 || result.cause.status === 403 || result.cause.status === 410 || result.cause.problemId === "installation_changed"));
                this.show({ ...currentView, state: "failed", status: "upNext.headingFinished", next: undefined, retryable, countdown: undefined, shuffleActionError: undefined, ...(scope === undefined ? {} : { shuffleScopeLabel: scope }) });
                return;
            }
            if (result.next === undefined) {
                completion.autoplays = false;
                this.show({ ...currentView, status: "upNext.headingFinished", next: undefined, countdown: undefined, shuffleActionError: undefined, ...(scope === undefined ? {} : { shuffleScopeLabel: scope }) });
                return;
            }
            this.show({ ...currentView, status: "upNext.headingShuffle", next: this.shownNext(result.next), countdown: undefined, shuffleActionError: undefined, ...(scope === undefined ? {} : { shuffleScopeLabel: scope }) });
            if (completion.attempt.autoNext && !this.stillWatchingGated()) this.startAutoplay(completion);
        }, (error: unknown) => {
            if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted) return;
            completion.pickingAnother = false;
            const currentView = this.current;
            if (currentView.phase !== "completion") return;
            if (error instanceof ApiError && error.status === 409) {
                completion.autoplays = false;
                this.show({ ...currentView, status: "upNext.headingFinished", next: undefined, countdown: undefined, shuffleActionError: undefined });
                return;
            }
            this.show({ ...currentView, countdown: undefined, shuffleActionError: "upNext.pickAnotherFailed" });
            if (completion.attempt.autoNext && !this.stillWatchingGated()) this.startAutoplay(completion);
        });
    }

    private cancelCompletion(): void {
        this.cancelAutoplayTimer?.();
        this.cancelAutoplayTimer = undefined;
        this.completion?.abort.abort();
        this.completion = undefined;
    }

    cancelAutoplay(): void {
        const attempt = this.active();
        if (attempt !== undefined) {
            this.cancelCreditsCountdown(attempt);
            attempt.promptDismissed = true;
            attempt.offer.manual = false;
            attempt.offer.credits = false;
            attempt.prompt = undefined;
            this.paintRect(attempt);
            this.showPlayback(attempt);
        }
        this.cancelAutoplayTimer?.();
        this.cancelAutoplayTimer = undefined;
        if (this.current.phase === "completion" && this.current.countdown !== undefined) this.show({ ...this.current, countdown: undefined });
    }

    stopShuffling(): void {
        const attempt = this.completion?.attempt ?? this.attempt;
        const shuffleId = attempt?.request.shuffleId;
        if (shuffleId === undefined) return;
        this.cancelAutoplay();
        const signal = this.deps.session.authoritySignal;
        // PlayerViewModel.stopShuffling: do not await delete; a failed delete leaves a shuffle the server cleans up.
        void this.deps.session.call({ ...operations.deleteShuffle(shuffleId), profileScoped: true, signal }).catch(() => undefined);
        this.back();
    }

    keepWatching(): void {
        this.stillWatching.recordViewerAction();
        const attempt = this.attempt;
        if (attempt?.live === true) {
            this.cancelAutoplay();
            this.setPaused(false);
        } else if (attempt?.ended === true && this.completion !== undefined) {
            const request = { ...attempt.request, startSeconds: Math.max(0, (attempt.plan?.durationSeconds ?? attempt.sourceSeconds) - 10) };
            this.cancelCompletion();
            this.play(request);
            if (this.attempt !== undefined) this.attempt.promptDismissed = true;
        } else this.back();
    }

    /** PlayerViewModel.setNextUpAutoPlayEnabled: Off cancels the finished card's countdown, On starts it again for a pick that counts down. */
    private completionAutoNextChanged(attempt: Attempt): void {
        const completion = this.completion;
        const view = this.current;
        if (completion?.attempt !== attempt || view.phase !== "completion") return;
        if (!attempt.autoNext) {
            this.cancelAutoplayTimer?.();
            this.cancelAutoplayTimer = undefined;
            this.show({ ...view, autoNext: false, countdown: undefined });
            return;
        }
        this.show({ ...view, autoNext: true });
        if (completion.autoplays && view.state === "ready" && view.next !== undefined && !completion.pickingAnother && !completion.advancingShuffle && this.cancelAutoplayTimer === undefined) {
            attempt.promptDismissed = false;
            this.startAutoplay(completion);
        }
    }

    private startAutoplay(completion: NonNullable<PlaybackController["completion"]>, seconds = AUTOPLAY_COUNTDOWN_SECONDS): void {
        if (this.stillWatchingGated()) return;
        const deadline = this.deps.clock.now() + seconds * 1000;
        const tick = (): void => {
            const view = this.current;
            if (this.completion !== completion || completion.abort.signal.aborted || completion.attempt.signal.aborted || completion.attempt.signal !== this.deps.session.authoritySignal || !completion.attempt.ended || view.phase !== "completion" || view.state !== "ready" || view.next === undefined || completion.pickingAnother || completion.advancingShuffle || this.stillWatchingGated()) return;
            const remaining = Math.max(0, Math.ceil((deadline - this.deps.clock.now()) / 1000));
            if (remaining === 0) { this.advanceNext(undefined, true); return; }
            this.show({ ...view, countdown: remaining });
            this.cancelAutoplayTimer = this.deps.clock.schedule(tick, 1000);
        };
        tick();
    }

    private async finishCompletion(completion: NonNullable<PlaybackController["completion"]>): Promise<void> {
        const { attempt, abort } = completion;
        const current = (): boolean => this.completion === completion && this.attempt === attempt && !abort.signal.aborted && !attempt.signal.aborted && attempt.signal === this.deps.session.authoritySignal;
        const shuffle = attempt.request.shuffleId !== undefined;
        // PlayerView.statusLabel: while the next item is worked out, an ended video reads Playing Next (Up Next at Random in a Shuffle);
        // with nothing to follow it reads Finished. Apple has no separate stage for ending the session.
        const working: MessageKey = shuffle ? "upNext.headingShuffle" : "upNext.headingEnded";
        // A failure while the session ends (the final progress or STOP) is not a failed lookup: nothing was looked up yet.
        let stage: "session" | "lookup" = "session";
        const autoNext = (): { autoNext?: boolean } => attempt.autoNextSupported ? { autoNext: attempt.autoNext } : {};
        const refused = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 410 || error.problemId === "installation_changed");
        const show = (state: "finalizing" | "resolving" | "ready" | "failed", next?: PlayRequest, retryable = false, status: MessageKey = state === "finalizing" || state === "resolving" ? working : "upNext.headingFinished", deck?: readonly PlayRequest[]): void => {
            const scope = completion.shuffleScopeLabel ?? attempt.request.shuffleScopeLabel;
            if (current()) this.show({ phase: "completion", status, state, next: this.shownNext(next), retryable, ...(deck === undefined ? {} : { deck: deck.map(item => this.shownNext(item) ?? item) }), ...(shuffle ? { shuffle: true } : {}), ...(scope === undefined ? {} : { shuffleScopeLabel: scope }), ...(state === "failed" && stage === "session" ? { failure: "session" } : {}), ...autoNext() });
        };
        // Apple's playShufflePart loads the next part with a plain loading state, not the end screen.
        if (attempt.request.shuffleId === undefined) show("finalizing");
        else if (current()) this.show({ phase: "loading", title: attempt.request.title, nextPart: true });
        try {
            // PlaybackSessionBridge.stopSession: one STOP, and a failure that may clear is logged and the advance goes on, the server timing
            // the old session out. The identical STOP keeps trying in the background, so the session still ends when the server can answer.
            // A refusal or an expired session still ends the advance: no successor starts without the session's authority.
            // A Retry after a failed lookup finds the session ended already, and sends no STOP of its own.
            if (!attempt.ended) try {
                await this.stopSession(attempt, true);
            } catch (error) {
                if (!(error instanceof ApiError && error.transient)) throw error;
                // Not at once: the first resend waits the first retry delay, or longer when the server asked (Retry-After). With the
                // first send counted, the STOP goes out as many times in all as a resent STOP does elsewhere.
                attempt.stopRetryAt = Math.max(attempt.stopRetryAt, this.deps.clock.now() + (RESEND_DELAYS_MS[0] ?? 0));
                attempt.ended = true;
                void this.stopSession(attempt, false, 1).catch((failure: unknown) => {
                    if (failure instanceof ApiError && failure.aborted) return;
                    // A resend refused like a first send ends the advance while it is still on screen. A 404 after a failure that may
                    // clear most likely means the first STOP landed, so it is only logged, as Apple logs a failed stop and goes on.
                    if (refused(failure) && current()) {
                        // As after a refused first send, the session never ended: Keep Watching and Back leave instead of replaying.
                        attempt.ended = false;
                        this.cancelAutoplay();
                        stage = "session";
                        show("failed");
                        abort.abort();
                        return;
                    }
                    console.warn("Auger playback: the session did not stop; the server will time it out", failure);
                });
            }
            if (!current()) return;
            stage = "lookup";
            if (this.nextStart !== undefined) {
                const request = this.nextStart;
                const unattended = this.nextStartUnattended;
                this.nextStartUnattended = false;
                this.cancelCompletion();
                this.startPlay(request, unattended);
                return;
            }
            if (attempt.request.shuffleId !== undefined) {
                // Apple plays every part of a pick before the shuffle moves on, with no countdown.
                const part = await nextShufflePart(spec => {
                    if (!current()) throw abortedError();
                    return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
                }, attempt.request, attempt.plan?.effectiveMediaFileId ?? attempt.request.fileId).catch((error: unknown) => {
                    // A next part that no longer exists cannot be retried: the Shuffle moves on.
                    if (error instanceof ApiError && error.status === 404) return undefined;
                    throw error;
                });
                if (!current()) return;
                if (part !== undefined) {
                    this.cancelCompletion();
                    this.nextStart = part;
                    this.startPlay(part, true);
                    return;
                }
            }
            const capRead = this.pickQuality(abort.signal);
            if (attempt.autoNextSupported) {
                const epoch = attempt.settingsEpoch;
                try {
                    const values = await this.deps.session.call({ ...operations.effectiveSettings([AUTO_NEXT_KEY]), profileScoped: true, signal: abort.signal });
                    if (current()) this.applyAutoNextRead(attempt, epoch, values.get(AUTO_NEXT_KEY)?.value === true);
                } catch { if (current()) this.applyAutoNextRead(attempt, epoch, false); }
                if (!current()) return;
            }
            show("resolving");
            const quality = await capRead;
            if (!current()) return;
            if (attempt.request.shuffleId !== undefined) {
                if (completion.advancedShuffle !== undefined) {
                    const promoted = completion.advancedShuffle;
                    const picked = await shufflePick(spec => {
                        if (!current()) throw abortedError();
                        return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
                    }, promoted, quality);
                    if (!current()) return;
                    if (picked === undefined) {
                        completion.autoplays = false;
                        show("ready", undefined, false, "upNext.headingFinished");
                        return;
                    }
                    const unattended = completion.advancedShuffleUnattended === true;
                    this.cancelCompletion();
                    this.nextStart = picked;
                    this.startPlay(picked, unattended);
                    return;
                }
                const refreshed = await refreshShuffle(spec => {
                    if (!current()) throw abortedError();
                    return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
                }, attempt.request.shuffleId, quality).catch((error: unknown) => {
                    if (error instanceof ApiError && error.status === 409) return { next: undefined, scopeLabel: attempt.request.shuffleScopeLabel };
                    throw error;
                });
                if (!current()) return;
                if (refreshed.scopeLabel !== undefined) completion.shuffleScopeLabel = refreshed.scopeLabel;
                const next = refreshed.next;
                completion.autoplays = next !== undefined;
                show("ready", next, false, next === undefined ? "upNext.headingFinished" : "upNext.headingShuffle");
                if (current() && next !== undefined && attempt.autoNext && !this.stillWatchingGated()) this.startAutoplay(completion);
                return;
            }
            const fileId = attempt.plan?.effectiveMediaFileId;
            if (fileId === undefined) throw new ApiError({ kind: "invalid_response", path: "playback_plan.effective_media_file_id" });
            const next = attempt.request.episode === true ? await nextEpisode(spec => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
            }, attempt.request.contentId, fileId, attempt.request.seriesTitle, quality) : undefined;
            if (next !== undefined) {
                completion.autoplays = true;
                show("ready", next, false, "upNext.headingEnded");
                this.loadPresentation(next, abort.signal, enriched => {
                    if (current() && this.current.phase === "completion" && this.current.next === next) this.show({ ...this.current, next: enriched });
                });
                void onDeckPlays(spec => {
                    if (!current()) throw abortedError();
                    return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
                }, attempt.request.contentId, undefined, quality).then(deck => {
                    if (current() && this.current.phase === "completion" && this.current.state === "ready") this.show({ ...this.current, deck });
                }, () => undefined);
                if (current() && attempt.autoNext && !attempt.promptDismissed && !this.stillWatchingGated()) {
                    if (attempt.offer.credits && attempt.offer.creditsDeadline !== undefined) {
                        const remaining = Math.max(0, Math.ceil((attempt.offer.creditsDeadline - this.deps.clock.now()) / 1000));
                        if (remaining > 0) this.startAutoplay(completion, remaining);
                        else this.advanceNext(undefined, true);
                    } else if (attempt.prompt !== undefined) this.advanceNext(undefined, true);
                    else this.startAutoplay(completion);
                }
                return;
            }
            const deck = await onDeckPlays(spec => {
                if (!current()) throw abortedError();
                return this.deps.session.call({ ...spec, profileScoped: true, signal: abort.signal });
            }, attempt.request.contentId, items => {
                show("ready", items[0], false, "upNext.heading", items);
            }, quality);
            if (!current()) return;
            this.show({ phase: "completion", status: deck.length === 0 ? "upNext.headingFinished" : "upNext.heading", state: "ready", next: deck[0], deck, retryable: false, ...autoNext() });
        } catch (error) {
            // Only the session's own end can find the session missing; a 404 after that is a lookup that Retry may yet answer.
            const missingSession = error instanceof ApiError && error.status === 404 && stage === "session";
            const forbidden = missingSession || refused(error);
            show("failed", undefined, !forbidden);
        } finally {
            completion.pending = false;
        }
    }

    // --- endings ---

    /** Leaves an attempt: no callback of it acts again. `stop` also ends its server session. */
    private leave(attempt: Attempt, how: "stop" | "abandon"): void {
        attempt.subtitles.destroy();
        if (!attempt.live) {
            return;
        }
        attempt.live = false;
        this.cancelCreditsCountdown(attempt, false);
        attempt.bufferingQuality.destroy();
        this.clearThumbnails(attempt);
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        attempt.cancelRecovery?.();
        attempt.cancelRecovery = undefined;
        attempt.recovery?.end(false, this.deps.clock.now());
        if (this.attempt === attempt) {
            this.closeTransport();
        }
        if (how === "stop") {
            void this.stopSession(attempt).catch(() => undefined);
        }
    }

    private fail(attempt: Attempt, error: PlaybackError, stopSession: boolean): void {
        traceFailure(attempt.trace, "end", error.kind);
        this.leave(attempt, stopSession ? "stop" : "abandon");
        if (this.attempt !== attempt) {
            return;
        }
        this.shownError = error;
        const exhausted = error.kind === "playback_failed";
        const retryable = exhausted || (!attempt.started && retryableStart(error) && (error.kind !== "settings" || this.nextStart !== undefined));
        this.show({ phase: "error", title: attempt.request.title, error, retryable });
    }

    /** A failed progress or replan for the session. */
    private sessionFailure(attempt: Attempt, error: unknown): void {
        if (error instanceof ApiError && error.aborted) {
            return;
        }
        if (error instanceof ApiError && error.status === 404 && attempt.presented && attempt.live && this.shownError === undefined) {
            // The missing session is this chain's cause; its status lives in the step code, not as the final HTTP.
            traceFailure(attempt.trace, "fallback", httpCode(error));
            // Counted after the failure opens its chain, which starts from zero.
            if (attempt.recovery?.active !== true) attempt.trace.reconnects++;
            this.sessionMissing(attempt);
            return;
        }
        noteApiError(attempt.trace, error);
        if (error instanceof ApiError && error.status === 410) {
            // Ended by an administrator: leave, and never start a fresh session at this position.
            this.leave(attempt, "abandon");
            this.attempt = undefined;
            this.show({ phase: "closed" });
            this.deps.exits.onEnd("ended_by_server");
            return;
        }
        if (error instanceof ApiError && error.status === 404) {
            this.fail(attempt, { kind: "session_expired" }, false);
            return;
        }
        const failure = startFailure(error);
        this.fail(attempt, failure, failure.kind !== "installation_changed");
    }

    // --- reconnect and visibility ---

    private capturePosition(attempt: Attempt): void {
        const plan = attempt.plan;
        if (plan === undefined || !attempt.started || attempt.busy) {
            return;
        }
        try {
            const ms = this.deps.avplay.getCurrentTime();
            if (Number.isFinite(ms) && ms >= 0) {
                attempt.sourceSeconds = ms / 1000 + plan.timeline.timelineOffsetSeconds;
            }
        } catch {
            // Keep the last position the stream reported.
        }
    }

    private holdTimers(attempt: Attempt): void {
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        attempt.cancelRecovery?.();
        attempt.cancelRecovery = undefined;
        this.cancelStartup?.();
        this.cancelStartup = undefined;
    }

    /**
     * True when an HLS playlist, or the first video variant of a master, is written with `#EXT-X-DEFINE` variables (or leaves one in a
     * segment address). The master is version 3 and clean; the define is in the variant (S95C, #650). Rendition playlists are not read. AVPlay
     * cannot read those, and handing it such a stream stops the page's JavaScript until the TV closes Silo (#650, #314),
     * so no timer could catch it. A playlist that cannot be read here is no verdict: AVPlay gets it as before.
     */
    private async playlistUnreadable(attempt: Attempt, plan: PlaybackPlan, url: string): Promise<boolean> {
        if (plan.delivery !== "server_remux_hls" && plan.delivery !== "server_transcode_hls") return false;
        let heads: string[];
        try {
            heads = await this.deps.session.http.playlistHeads(url, attempt.signal);
        } catch {
            return false;
        }
        if (!heads.some(head => /#EXT-X-DEFINE|\{\$/.test(head))) return false;
        console.warn(`Auger playback: the HLS playlist uses #EXT-X-DEFINE, which AVPlay cannot read (delivery ${plan.delivery})`);
        return true;
    }

    private armStartup(attempt: Attempt, transport: number, deadline = this.deps.clock.now() + STARTUP_TIMEOUT_MS): void {
        this.startupDue = deadline;
        this.cancelStartup?.();
        this.cancelStartup = this.deps.clock.schedule(() => {
            this.startupDue = undefined;
            if (transport === this.transport && !attempt.started && !attempt.hidden && attempt.live) {
                noteAvplay(attempt, "startup_timeout");
                this.routeFailed(attempt, "avplay_startup_timeout");
            }
        }, Math.max(0, deadline - this.deps.clock.now()));
    }

    private showLoading(attempt: Attempt, detail: "reconnecting" | "restoring" | undefined): void {
        this.show({ phase: "loading", title: attempt.request.title, ...(detail === undefined ? {} : { detail }) });
    }

    private recoverConnection(attempt: Attempt, failureCode = "connection_lost"): void {
        attempt.subtitles.onConnectionRecoveryStarted();
        if (!attempt.live || !attempt.presented) {
            this.fail(attempt, { kind: "network" }, true);
            return;
        }
        if (attempt.recovery?.active === true) {
            return;
        }
        this.capturePosition(attempt);
        traceFailure(attempt.trace, "fallback", failureCode);
        attempt.trace.reconnects++;
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        this.closeTransport();
        attempt.started = false;
        attempt.busy = false;
        attempt.buffering = false;
        attempt.resuming = true;
        this.showLoading(attempt, "reconnecting");
        this.arm(attempt, false, attempt.replacementBody === undefined ? "replan" : "start");
    }

    private releaseFailedRoute(attempt: Attempt): void {
        const plan = attempt.plan;
        if (plan !== undefined && attempt.attemptedKeys[attempt.attemptedKeys.length - 1] === plan.planAttemptKey) {
            attempt.attemptedKeys.pop();
        }
        if (attempt.recoveries > 0) {
            attempt.recoveries -= 1;
        }
        attempt.busy = false;
    }

    private noteTransportUnanswered(attempt: Attempt, error: unknown): void {
        const recovery = attempt.recovery;
        if (recovery === undefined || !recovery.active || !attempt.live) {
            this.fail(attempt, { kind: "network" }, true);
            return;
        }
        this.closeTransport();
        attempt.started = false;
        const action = recovery.retryLater(this.deps.clock.now());
        if (action.kind === "give_up") {
            enterStage(attempt.trace, "reconnect");
            noteApiError(attempt.trace, error);
            this.giveUp(attempt);
            return;
        }
        if (action.kind === "wait") {
            this.scheduleRecovery(attempt, action.delayMs);
        }
        this.showLoading(attempt, "reconnecting");
    }

    private sessionMissing(attempt: Attempt): void {
        if (!attempt.live) {
            return;
        }
        const recovery = attempt.recovery;
        if (recovery?.active === true) {
            recovery.step = "start";
            if (attempt.recoveryPending) {
                return;
            }
            this.showLoading(attempt, "reconnecting");
            this.scheduleRecovery(attempt, 0);
            return;
        }
        this.capturePosition(attempt);
        attempt.cancelTimer?.();
        attempt.cancelTimer = undefined;
        this.closeTransport();
        attempt.started = false;
        attempt.resuming = true;
        this.showLoading(attempt, "reconnecting");
        this.arm(attempt, false, "start", true);
    }

    private arm(attempt: Attempt, fresh: boolean, step: RecoveryStep, immediate = false): void {
        const recovery = attempt.recovery ?? (attempt.recovery = new PlaybackRecovery());
        const action = recovery.begin(this.deps.clock.now(), fresh, step);
        switch (action.kind) {
            case "join":
                return;
            case "give_up":
                this.giveUp(attempt);
                return;
            case "wait":
                this.scheduleRecovery(attempt, immediate ? 0 : action.delayMs);
                return;
            default: {
                const unreachable: never = action;
                return unreachable;
            }
        }
    }

    private scheduleRecovery(attempt: Attempt, delayMs: number): void {
        const recovery = attempt.recovery;
        if (recovery === undefined) {
            return;
        }
        const due = Math.max(this.deps.clock.now() + delayMs, attempt.recoveryRetryAt);
        recovery.dueAt = due;
        attempt.cancelRecovery?.();
        attempt.cancelRecovery = undefined;
        if (attempt.hidden) {
            return;
        }
        const generation = recovery.generation;
        attempt.cancelRecovery = this.deps.clock.schedule(() => {
            if (recovery.generation === generation && attempt.live && !attempt.hidden) {
                void this.runRecovery(attempt);
            }
        }, Math.max(0, due - this.deps.clock.now()));
    }

    private async runRecovery(attempt: Attempt): Promise<void> {
        const recovery = attempt.recovery;
        if (recovery === undefined || !recovery.active || !attempt.live || attempt.hidden || attempt.restoring || attempt.recoveryPending) {
            return;
        }
        const generation = recovery.generation;
        const sessionId = attempt.sessionId;
        const step = recovery.step;
        const current = (): boolean => this.attempt === attempt && attempt.live && recovery.active && recovery.generation === generation && attempt.sessionId === sessionId;
        attempt.recoveryPending = true;
        recovery.beginAttempt();
        try {
            if (step === "start") {
                await this.recoveryStart(attempt, current);
                return;
            }
            beginReconnectAttempt(attempt.trace);
            const decision = await this.recoveryReplan(attempt);
            attempt.recoverySpec = undefined;
            if (!current()) {
                return;
            }
            if (decision.outcome === "playable") {
                if (decision.sessionId !== attempt.sessionId) {
                    recovery.end(false, this.deps.clock.now());
                    this.fail(attempt, { kind: "server" }, true);
                    return;
                }
                attempt.busy = false;
                attempt.resuming = true;
                this.adopt(attempt, decision.plan, decision.serverFeatures);
                return;
            }
            attempt.retirePredecessor = true;
            recovery.step = "start";
            await this.applyVerdict(attempt, { kind: "start_new_session" });
        } catch (error) {
            if (!current()) {
                return;
            }
            if (error instanceof ApiError && error.aborted) {
                return;
            }
            if (!unanswered(error)) attempt.recoverySpec = undefined;
            const verdict = recoveryVerdict(error, step);
            if (verdict.kind === "start_new_session") {
                attempt.retirePredecessor = !(error instanceof ApiError && error.status === 404);
                traceFailure(attempt.trace, "fallback", httpCode(error));
            } else {
                recordReconnectError(attempt.trace, error, verdict);
            }
            await this.applyVerdict(attempt, verdict);
        } finally {
            attempt.recoveryPending = false;
        }
    }

    private recoveryReplan(attempt: Attempt): Promise<PlaybackDecision> {
        const plan = attempt.plan;
        const sessionId = attempt.sessionId;
        const installationId = attempt.installationId;
        if (plan === undefined || sessionId === undefined || installationId === undefined) {
            return Promise.reject(new ApiError({ kind: "invalid_response", path: "playback_recovery" }));
        }
        const replan = attempt.recoverySpec ?? operations.replanPlayback(sessionId, {
            installation_id: installationId,
            protocol_version: 3,
            client_features: this.features(attempt),
            operation: "track_change",
            playback_attempt_id: attempt.playbackAttemptId,
            replan_request_id: this.newId(),
            failed_plan_id: plan.planId,
            plan_attempt_id: attempt.planAttemptId,
            plan_attempt_key: plan.planAttemptKey,
            attempted_plan_keys: attempt.attemptedKeys.slice(),
            attempt_count: Math.max(1, attempt.recoveries),
            quality_preference: attempt.qualityPreference,
            ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
            ...this.replanBufferingMembers(attempt, "track_change", undefined),
            position_seconds: attempt.sourceSeconds,
            selected_tracks: attempt.subtitles.chosenTracks(plan),
            ...this.reportedPlayback(attempt),
        });
        attempt.recoverySpec = replan;
        return this.deps.session.call({ ...replan, profileScoped: true, signal: attempt.signal });
    }

    private replacementBody(attempt: Attempt): StartPlaybackBody {
        const plan = attempt.plan;
        const profile = this.deps.session.activeProfile;
        const installationId = attempt.installationId;
        if (plan === undefined || profile === undefined || installationId === undefined) {
            throw new ApiError({ kind: "invalid_response", path: "playback_recovery.start" });
        }
        const audio = plan.selectedTracks.audio?.id;
        const subtitle = attempt.subtitles.recoveryStartTrackId(plan);
        return {
            installation_id: installationId,
            protocol_version: 3,
            client_features: this.features(attempt),
            file_id: plan.effectiveMediaFileId,
            profile_id: profile.id,
            playback_attempt_id: this.newId(),
            quality_preference: attempt.qualityPreference,
            ...(attempt.bandwidthCapKbps === undefined ? {} : { bandwidth_cap_kbps: attempt.bandwidthCapKbps }),
            ...this.startBufferingMembers(attempt, false),
            subtitle_fidelity_preference: "compatible",
            start_position: attempt.sourceSeconds,
            ...(audio === undefined ? {} : { audio_track_id: audio }),
            ...(subtitle === undefined ? {} : { subtitle_track_id: subtitle }),
            ...(attempt.request.allowAlternateVersions === undefined ? {} : { allow_alternate_versions: attempt.request.allowAlternateVersions }),
            ...this.reportedPlayback(attempt),
        };
    }

    private async recoveryStart(attempt: Attempt, current: () => boolean): Promise<void> {
        const recovery = attempt.recovery;
        if (recovery === undefined) {
            return;
        }
        beginReconnectAttempt(attempt.trace);
        try {
            const body = attempt.replacementBody ?? this.replacementBody(attempt);
            attempt.replacementBody = body;
            const decision = await this.deps.session.call({ ...operations.startPlayback(body), profileScoped: true, signal: attempt.signal });
            if (!attempt.live && decision.outcome === "playable") {
                // A late replacement owns a separate session and cannot reuse the retired STOP.
                const retired: Attempt = { ...attempt, playbackAttemptId: body.playback_attempt_id, sessionId: decision.sessionId, sequence: 0, stopped: false, ended: false, stopSpec: undefined, stopRetryAt: 0, progress: undefined, progressRefusal: undefined };
                void this.stopSession(retired).catch(() => undefined);
                return;
            }
            if (!current()) {
                return;
            }
            if (decision.outcome !== "playable") {
                recovery.end(false, this.deps.clock.now());
                attempt.replacementBody = undefined;
                this.fail(attempt, traceDecision(attempt.trace, decision), attempt.retirePredecessor);
                return;
            }
            if (attempt.retirePredecessor) {
                // A stale plan does not prove the predecessor session has ended.
                void this.stopSession({ ...attempt }).catch(() => undefined);
                attempt.retirePredecessor = false;
            }
            attempt.playbackAttemptId = body.playback_attempt_id;
            attempt.sessionId = decision.sessionId;
            attempt.sequence = 0;
            attempt.stopped = false;
            attempt.ended = false;
            attempt.stopSpec = undefined;
            attempt.progress = undefined;
            attempt.progressRefusal = undefined;
            attempt.replacementBody = undefined;
            attempt.resuming = true;
            attempt.bufferingQuality.newAttempt();
            this.adopt(attempt, decision.plan, decision.serverFeatures);
        } catch (error) {
            if (!current()) {
                return;
            }
            if (error instanceof ApiError && error.aborted) {
                return;
            }
            const verdict = recoveryVerdict(error, "start");
            recordReconnectError(attempt.trace, error, verdict);
            await this.applyVerdict(attempt, verdict);
        }
    }

    private async applyVerdict(attempt: Attempt, verdict: RecoveryVerdict): Promise<void> {
        const recovery = attempt.recovery;
        switch (verdict.kind) {
            case "retry": {
                if (recovery === undefined) {
                    return;
                }
                if (verdict.retryAfterMs !== undefined) attempt.recoveryRetryAt = Math.max(attempt.recoveryRetryAt, this.deps.clock.now() + verdict.retryAfterMs);
                const action = recovery.retryLater(this.deps.clock.now());
                if (action.kind === "give_up") {
                    this.giveUp(attempt);
                } else if (action.kind === "wait") {
                    this.scheduleRecovery(attempt, action.delayMs);
                }
                return;
            }
            case "start_new_session":
                if (recovery !== undefined) {
                    const generation = recovery.generation;
                    recovery.step = "start";
                    if (attempt.hidden || attempt.restoring) {
                        this.scheduleRecovery(attempt, 0);
                    } else {
                        const sessionId = attempt.sessionId;
                        await this.recoveryStart(attempt, () => this.attempt === attempt && attempt.live && recovery.active && recovery.generation === generation && attempt.sessionId === sessionId);
                    }
                }
                return;
            case "give_up":
                this.giveUp(attempt);
                return;
            case "installation_changed":
                recovery?.end(false, this.deps.clock.now());
                this.fail(attempt, { kind: "installation_changed" }, false);
                return;
            case "ended":
                recovery?.end(false, this.deps.clock.now());
                this.leave(attempt, "abandon");
                if (this.attempt !== attempt) {
                    return;
                }
                this.attempt = undefined;
                this.show({ phase: "closed" });
                this.deps.exits.onEnd("ended_by_server");
                return;
            case "revoked":
                recovery?.end(false, this.deps.clock.now());
                this.fail(attempt, { kind: "revoked" }, false);
                return;
            default: {
                const unreachable: never = verdict;
                return unreachable;
            }
        }
    }

    private giveUp(attempt: Attempt): void {
        attempt.recovery?.end(false, this.deps.clock.now());
        attempt.resuming = false;
        if (this.attempt !== attempt || !attempt.live) {
            return;
        }
        enterStage(attempt.trace, "reconnect");
        const error: PlaybackError = { kind: "network" };
        traceFailure(attempt.trace, "end", error.kind);
        attempt.trace.exhausted = true;
        this.shownError = error;
        this.show({ phase: "error", title: attempt.request.title, error, retryable: true });
    }

    private async resumeVisible(attempt: Attempt): Promise<void> {
        const generation = ++attempt.resumeGeneration;
        if (attempt.installationId === undefined) return;
        const current = (): boolean => attempt.live && attempt.resumeGeneration === generation && this.attempt === attempt;
        const gate = await this.revalidate(attempt);
        if (!current() || this.shownError !== undefined) {
            return;
        }
        attempt.hidden = false;
        if (!gate.ok) {
            if ("ignored" in gate) {
                return;
            }
            if (gate.error.kind === "network" && attempt.presented) {
                if (attempt.recovery?.active === true) {
                    this.closeTransport();
                    attempt.started = false;
                    const due = attempt.recovery.dueAt ?? this.deps.clock.now();
                    this.scheduleRecovery(attempt, Math.max(0, due - this.deps.clock.now()));
                    this.showLoading(attempt, "reconnecting");
                } else {
                    this.recoverConnection(attempt);
                }
                return;
            }
            const stop = gate.error.kind !== "installation_changed" && gate.error.kind !== "revoked" && gate.error.kind !== "unavailable";
            this.fail(attempt, gate.error, stop);
            return;
        }
        attempt.restoring = false;
        if (!attempt.started && this.startupDue !== undefined) {
            this.armStartup(attempt, this.transport, this.startupDue);
            return;
        }
        if (attempt.suspended && attempt.plan !== undefined) {
            const transport = this.transport;
            const restored = await this.warmRestore(attempt, gate.token);
            if (!current() || transport !== this.transport) {
                return;
            }
            if (restored) {
                attempt.subtitles.onWarmRestored();
                this.restartProgress(attempt);
                return;
            }
            this.recoverConnection(attempt);
            return;
        }
        if (attempt.suspendedReady) {
            attempt.suspendedReady = false;
            try {
                this.deps.avplay.play();
                if (attempt.plan !== undefined && !this.selectPlanAudio(attempt.plan)) {
                    this.routeFailed(attempt, AUDIO_TRACK_SWITCH_FAILED);
                    return;
                }
                if (attempt.plan !== undefined) attempt.hud.restore(this.deps.avplay, attempt.plan);
                if (attempt.paused) {
                    this.deps.avplay.pause();
                }
                if (!attempt.subtitles.subtitleSwitchOut) this.settleSwitch(attempt, "ok");
                attempt.started = true;
                attempt.presented = true;
                attempt.resuming = false;
                if (attempt.recovery?.active === true) attempt.recovery.recovered(this.deps.clock.now());
                if (attempt.plan !== undefined && attempt.subtitles.alignOpenStream(attempt.plan) !== "aligned") return;
                attempt.appliedRect = undefined;
                this.updatePrompt(attempt);
                this.paintRect(attempt);
                this.showPlayback(attempt);
                if (attempt.plan !== undefined) attempt.subtitles.consumePreparedChoices(attempt.plan);
            } catch {
                this.recoverConnection(attempt);
                return;
            }
            this.restartProgress(attempt);
            // A replacement that prepared while hidden starts here, so its queued seek runs here too.
            this.runQueuedReanchor(attempt);
            return;
        }
        if (attempt.deferredOpen && attempt.plan !== undefined) {
            attempt.deferredOpen = false;
            await this.open(attempt, attempt.plan);
            return;
        }
        if (attempt.recovery?.active === true) {
            if (attempt.recoveryPending) return;
            const due = attempt.recovery.dueAt ?? this.deps.clock.now();
            this.scheduleRecovery(attempt, Math.max(0, due - this.deps.clock.now()));
            this.showLoading(attempt, "reconnecting");
            return;
        }
        this.restartProgress(attempt);
    }

    private async revalidate(attempt: Attempt): Promise<{ ok: true; token: string } | { ok: false; ignored: true } | { ok: false; error: PlaybackError }> {
        try {
            const capabilities = await this.deps.session.call({ ...operations.playbackCapabilities(), profileScoped: true, signal: attempt.signal });
            if (!attempt.live || attempt.signal.aborted) {
                return { ok: false, ignored: true };
            }
            const profile = this.deps.session.activeProfile;
            const installationId = capabilities.installationId;
            if (capabilities.state !== "available" || !capabilities.allowed || capabilities.protocolVersions.indexOf(3) === -1 || installationId === undefined || profile === undefined) {
                return { ok: false, error: { kind: "unavailable" } };
            }
            if (installationId !== attempt.installationId) {
                return { ok: false, error: { kind: "installation_changed" } };
            }
            if (profile.id !== attempt.profileId) {
                return { ok: false, error: { kind: "revoked" } };
            }
            const token = await this.deps.session.mediaToken(attempt.signal);
            if (!attempt.live) {
                return { ok: false, ignored: true };
            }
            return { ok: true, token };
        } catch (error) {
            if (error instanceof ApiError && error.aborted) {
                return { ok: false, ignored: true };
            }
            if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
                return { ok: false, error: { kind: "revoked" } };
            }
            if (error instanceof ApiError && error.problemId === "installation_changed") {
                return { ok: false, error: { kind: "installation_changed" } };
            }
            if (unanswered(error)) {
                return { ok: false, error: { kind: "network" } };
            }
            return { ok: false, error: startFailure(error) };
        }
    }

    private warmRestore(attempt: Attempt, token: string): Promise<boolean> {
        const plan = attempt.plan;
        const restore = this.deps.avplay.restoreAsync;
        if (plan === undefined || restore === undefined) {
            return Promise.resolve(false);
        }
        const url = this.urlWithToken(plan, token);
        if (url === undefined) {
            return Promise.resolve(false);
        }
        const resumeMs = Math.max(0, Math.round((attempt.sourceSeconds - plan.timeline.timelineOffsetSeconds) * 1000));
        const generation = attempt.resumeGeneration;
        const transport = this.transport;
        this.showLoading(attempt, "restoring");
        const open = {};
        attempt.restoreOpen = open;
        const close = (): void => {
            if (attempt.restoreOpen === open) attempt.restoreOpen = undefined;
        };
        return new Promise<boolean>((resolve) => {
            try {
                restore.call(this.deps.avplay, url, resumeMs, false, () => {
                    close();
                    if (transport !== this.transport) {
                        resolve(false);
                        return;
                    }
                    if (!attempt.live || this.attempt !== attempt || attempt.hidden || attempt.resumeGeneration !== generation) {
                        if (attempt.live && this.attempt === attempt && (attempt.hidden || attempt.restoring)) {
                            try {
                                this.deps.avplay.suspend?.();
                            } catch {
                                this.closeTransport();
                                attempt.suspended = false;
                            }
                        }
                        resolve(false);
                        return;
                    }
                    attempt.suspended = false;
                    attempt.started = true;
                    attempt.presented = true;
                    attempt.resuming = false;
                    try {
                        attempt.hud.restore(this.deps.avplay, plan);
                        if (attempt.paused) {
                            if (this.deps.avplay.getState() === "PLAYING") {
                                this.deps.avplay.pause();
                            }
                        } else if (this.deps.avplay.getState() === "PAUSED") {
                            this.deps.avplay.play();
                        }
                    } catch {
                        // The next key tries again.
                    }
                    attempt.appliedRect = undefined;
                    this.updatePrompt(attempt);
                    this.paintRect(attempt);
                    this.showPlayback(attempt);
                    resolve(true);
                }, () => resolve(false));
            } catch {
                resolve(false);
            }
        }).finally(close);
    }

    private urlWithToken(plan: PlaybackPlan, token: string): string | undefined {
        const base = this.deps.session.http.base;
        const published = plan.streamUrl.charAt(0) === "/" ? base.baseUrl + plan.streamUrl : plan.streamUrl;
        let media: URL;
        try {
            media = new URL(published);
        } catch {
            return undefined;
        }
        if (!isPermittedUrl(media, base.baseUrl)) {
            return undefined;
        }
        if (media.origin !== base.origin) {
            return published;
        }
        return withMediaToken(published, token);
    }

    private restartProgress(attempt: Attempt): void {
        if (!attempt.live || attempt.hidden || attempt.recovery?.active === true || !attempt.presented || !attempt.started) {
            return;
        }
        if (attempt.cancelTimer !== undefined) {
            return;
        }
        const remaining = attempt.progressDue === undefined ? PROGRESS_INTERVAL_MS : Math.max(0, attempt.progressDue - this.deps.clock.now());
        if (remaining === 0) {
            attempt.progressDue = undefined;
            this.sendProgress(attempt);
            this.scheduleProgress(attempt);
            return;
        }
        attempt.progressDue = this.deps.clock.now() + remaining;
        attempt.cancelTimer = this.deps.clock.schedule(() => {
            attempt.cancelTimer = undefined;
            attempt.progressDue = undefined;
            if (!attempt.live || attempt.hidden || attempt.recovery?.active === true) {
                return;
            }
            this.sendProgress(attempt);
            this.scheduleProgress(attempt);
        }, remaining);
    }

    // --- helpers ---

    private readMarkers(attempt: Attempt, fileId: string): void {
        if (attempt.markers?.fileId === fileId) return;
        const markers = { fileId, segments: [] as readonly TimelineMarker[] };
        attempt.markers = markers;
        void this.deps.session.call({ ...operations.fileMarkers(fileId), profileScoped: true, signal: attempt.signal }).then(
            segments => {
                if (!attempt.live || attempt.markers !== markers) return;
                markers.segments = segments;
                this.showPlayback(attempt);
            },
            () => { /* Optional markers never interrupt playback. */ },
        );
    }

    /** Resends the identical request after no answer or a transient refusal; the contract replays it. */
    private async resend<T>(attempt: Attempt, send: () => Promise<T>, sent = 0): Promise<T> {
        for (let index = sent; ; index++) {
            try {
                return await send();
            } catch (error) {
                const delay = RESEND_DELAYS_MS[index];
                if (!(error instanceof ApiError) || !error.transient) throw error;
                if (delay === undefined) {
                    if (attempt.trace.stage === "start") attempt.trace.exhausted = true;
                    throw error;
                }
                if (attempt.trace.stage === "start") traceFailure(attempt.trace, "retry", httpCode(error) ?? "no_response");
                else traceStep(attempt.trace, "retry", httpCode(error));
                attempt.trace.resends++;
                await sleep(this.deps.clock, Math.max(delay, (error.retryAfterSeconds ?? 0) * 1000), attempt.signal, abortedError);
            }
        }
    }

    private active(): Attempt | undefined {
        const attempt = this.attempt;
        return attempt !== undefined && attempt.live ? attempt : undefined;
    }

    private showPlayback(attempt: Attempt): void {
        const plan = attempt.plan;
        // A late read must not draw over the Restoring overlay; the restore itself draws the view when it ends.
        if (this.attempt !== attempt || !attempt.live || !attempt.started || plan === undefined || attempt.restoring || attempt.restoreOpen !== undefined) {
            return;
        }
        const frozen = attempt.busy && !attempt.subtitles.isReporting;
        this.show({
            phase: attempt.paused ? "paused" : "playing",
            title: attempt.request.title,
            positionSeconds: attempt.sourceSeconds,
            seriesTitle: attempt.request.seriesTitle,
            seasonNumber: attempt.request.seasonNumber,
            episodeNumber: attempt.request.episodeNumber,
            durationSeconds: plan.durationSeconds,
            buffering: attempt.buffering,
            ...(this.episodesVisible(attempt) ? { episodes: true as const } : {}),
            ...(attempt.prompt === undefined ? {} : { upNext: {
                next: this.shownNext(attempt.prompt.next), deck: attempt.prompt.deck.map(item => this.shownNext(item) ?? item),
                countdown: this.promptCountdown(attempt, plan),
                // Apple's nextUpCountdownTotalSeconds: fixed 10 s over credits, HUD threshold when opened by hand, else the prompt's length.
                countdownTotal: attempt.offer.credits ? AUTOPLAY_COUNTDOWN_SECONDS : attempt.offer.manual ? MANUAL_COUNTDOWN_THRESHOLD_SECONDS : Math.max(1, attempt.promptSeconds),
                status: attempt.prompt.loading === true || attempt.prompt.next !== undefined ? translate("upNext.heading") : translate("upNext.headingNothing"),
                ...(attempt.prompt.loading === true ? { loading: true as const } : {}),
                ...(attempt.prompt.failed === true ? { failed: true as const } : {}),
            } }),
            resumePending: attempt.paused && attempt.pauseAfterSeek === false,
            transportCommandCount: attempt.transportCommandCount,
            tracks: trackView(attempt, plan),
            hud: {
                chapters: attempt.hud.chapters, chapterState: attempt.hud.chapterState,
                overview: attempt.hud.metadata?.overview ?? attempt.request.overview,
                metadata: attempt.hud.metadata, metadataFailed: attempt.hud.metadataFailed,
                stats: planStats(plan, liveStats(attempt, plan, this.deps.session.http.base.baseUrl, playbackStatus({
                    ended: this.completion !== undefined || attempt.endedDuringChange,
                    reconnecting: attempt.recovery?.active === true || (!currentNetwork().online && (attempt.buffering || attempt.bufferingQuality.stalled)),
                    loading: !attempt.started || attempt.restoring || attempt.suspended || attempt.suspendedReady || attempt.resuming || (attempt.busy && changeHoldsBusy(attempt) && !attempt.subtitles.isReporting),
                    seeking: this.pending.seek !== undefined || (attempt.busy && !changeHoldsBusy(attempt)),
                    paused: attempt.paused,
                    stalled: attempt.bufferingQuality.stalled,
                    rebuffering: attempt.buffering,
                }), attempt.started && !attempt.hidden && !attempt.restoring && !attempt.suspended && this.pending.seek === undefined ? currentBandwidthBps(this.deps.avplay) : undefined)),
                ...videoOptions(this.deps.avplay.setSpeed !== undefined, this.deps.avplay.setDisplayMethod !== undefined, plan.streamProtocol),
                speed: attempt.hud.speed, aspect: attempt.hud.aspect,
                autoNext: attempt.autoNextSupported ? attempt.autoNext : undefined,
                busy: attempt.hud.autoBusy || attempt.busy,
                message: attempt.hud.message,
            },
            seekIntervals: attempt.seekIntervals,
            previewKey: frozen ? undefined : attempt.previewKey,
            captions: attempt.subtitles.captionsView(plan, attempt.hidden || attempt.restoring || frozen),
            skipMarker: frozen ? undefined : markerAt((attempt.markers?.segments ?? []).filter(marker => marker.kind !== "intro" || attempt.introMode === "ask"), attempt.sourceSeconds),
            markers: attempt.markers?.segments,
            undoSkipSeconds: attempt.undoSkip ?? attempt.pendingSkipUndo,
        });
        if (attempt.offer.credits && attempt.offer.creditsDeadline !== undefined && attempt.offer.cancelCreditsTimer === undefined && attempt.offer.creditsDeadline <= this.deps.clock.now()) {
            this.startCreditsCountdownIfNeeded(attempt);
        }
    }

    private inPromptWindow(attempt: Attempt): boolean {
        const duration = attempt.plan?.durationSeconds;
        if (duration === undefined || attempt.promptSeconds === 0) return false;
        const remaining = duration - attempt.sourceSeconds;
        return remaining >= 0 && remaining <= attempt.promptSeconds;
    }

    private episodesVisible(attempt: Attempt): boolean {
        const offer = attempt.offer;
        if (attempt.request.shuffleId !== undefined) return false;
        // A film offers only On Deck. Apple's canShowNextUpScreen (PlayerViewModel.swift:1598-1603) has no failure term, so once a retry has
        // failed too the button hides; after the first failure it stays, so the window or Up Next can read again.
        const deckRetryable = offer.deckFailed && (attempt.request.episode === true || !offer.deckRetried);
        if (attempt.request.episode !== true && offer.deckFailed && offer.deckRetried && !offer.deckLoading) return false;
        return attempt.request.episode === true || offer.manual || offer.episodeLoading || offer.deckLoading || offer.episode !== undefined || offer.deck.length > 0 || offer.episodeFailed || deckRetryable;
    }

    private promptCountdown(attempt: Attempt, plan: { durationSeconds: number | undefined }): number | undefined {
        const prompt = attempt.prompt;
        if (prompt === undefined || prompt.loading === true || prompt.failed === true || prompt.fromDeck || prompt.next === undefined || !attempt.autoNext || this.stillWatchingGated()) return undefined;
        if (attempt.offer.credits) return attempt.offer.creditsCountdown;
        const remaining = (plan.durationSeconds ?? Infinity) - attempt.sourceSeconds;
        if (attempt.offer.manual && remaining >= MANUAL_COUNTDOWN_THRESHOLD_SECONDS) return undefined;
        return Math.max(0, Math.ceil(remaining));
    }

    private flushPendingRect(attempt: Attempt): void {
        if (attempt.rectPending && !attempt.busy && this.canApplyDisplayRect(attempt)) {
            this.paintRect(attempt);
        }
    }

    private updatePrompt(attempt: Attempt): void {
        if (attempt.request.shuffleId !== undefined) {
            this.flushPendingRect(attempt);
            return;
        }
        if (!this.inPromptWindow(attempt)) {
            attempt.promptDismissed = false;
            if (!attempt.offer.manual && !attempt.offer.credits) this.clearPrompt(attempt);
            else if (attempt.prompt === undefined) this.publishOffer(attempt);
            else this.paintRect(attempt);
            return;
        }
        if (attempt.promptDismissed || attempt.hidden || attempt.busy) {
            this.flushPendingRect(attempt);
            return;
        }
        if (!attempt.offer.started) {
            this.flushPendingRect(attempt);
            this.beginDiscovery(attempt);
        } else {
            // Discovery starts at the first frame (#698), so a read that failed then is read once more when the window opens.
            // Each read is retried once on its own: one may still be out when the other's retry starts.
            const offer = attempt.offer;
            if (!offer.episodeWindowRetried && offer.episodeFailed && !offer.episodeLoading) {
                offer.episodeWindowRetried = true;
                this.retryEpisode(attempt);
            }
            if (!offer.deckWindowRetried && offer.deckFailed && !offer.deckLoading) {
                offer.deckWindowRetried = true;
                this.retryDeck(attempt);
            }
            this.publishOffer(attempt);
        }
    }

    private beginDiscovery(attempt: Attempt): void {
        if (attempt.offer.started || attempt.request.shuffleId !== undefined) return;
        attempt.offer.started = true;
        attempt.offer.episodeLoading = attempt.request.episode === true;
        attempt.offer.deckLoading = true;
        void this.discover(attempt);
    }

    private retryEpisode(attempt: Attempt): void {
        attempt.offer.episodeLoading = true;
        attempt.offer.episodeFailed = false;
        void this.discover(attempt, "episode");
    }

    private retryDeck(attempt: Attempt): void {
        attempt.offer.deckRetried = true;
        attempt.offer.deckLoading = true;
        attempt.offer.deckFailed = false;
        void this.discover(attempt, "deck");
    }

    private reportPosition(attempt: Attempt): number {
        const duration = attempt.plan?.durationSeconds;
        return attempt.prompt !== undefined && duration !== undefined && (attempt.offer.credits || (attempt.promptSeconds > 0 && duration - attempt.sourceSeconds >= 0 && duration - attempt.sourceSeconds <= attempt.promptSeconds)) ? duration : attempt.sourceSeconds;
    }

    /** The Resolution cap that ranks the next pick. A cap read still in flight is waited for; a failed one reads as no cap. */
    private async pickQuality(signal: AbortSignal): Promise<string | undefined> {
        const cap = this.deps.resolutionCap;
        if (cap === undefined) return undefined;
        await cap.ready(signal);
        return cap.quality;
    }

    /** A seek does not cancel this read. Only a new attempt or an aborted session does. */
    private async discover(attempt: Attempt, part: "all" | "episode" | "deck" = "all"): Promise<void> {
        const read = <T>(spec: RequestSpec<T>): Promise<T> => this.deps.session.call({ ...spec, profileScoped: true, signal: attempt.signal });
        const live = (): boolean => this.active() === attempt && !attempt.signal.aborted;
        const capRead = this.pickQuality(attempt.signal);
        if (part !== "deck") {
            try {
                if (attempt.autoNextSupported) {
                    const epoch = attempt.settingsEpoch;
                    try {
                        const values = await read(operations.effectiveSettings([AUTO_NEXT_KEY]));
                        if (live()) this.applyAutoNextRead(attempt, epoch, values.get(AUTO_NEXT_KEY)?.value === true);
                    } catch { if (live()) this.applyAutoNextRead(attempt, epoch, false); }
                }
                if (attempt.request.episode === true) {
                    const fileId = attempt.plan?.effectiveMediaFileId;
                    if (fileId === undefined) throw new ApiError({ kind: "invalid_response", path: "playback_plan.effective_media_file_id" });
                    const next = await nextEpisode(read, attempt.request.contentId, fileId, attempt.request.seriesTitle, await capRead);
                    if (!live()) return;
                    attempt.offer.episode = next;
                    attempt.offer.episodeSettled = true;
                    attempt.offer.episodeFailed = false;
                } else if (live()) {
                    attempt.offer.episode = undefined;
                    attempt.offer.episodeSettled = true;
                    attempt.offer.episodeFailed = false;
                }
            } catch (error) {
                if (!live() || (error instanceof ApiError && error.aborted)) return;
                attempt.offer.episode = undefined;
                attempt.offer.episodeSettled = false;
                attempt.offer.episodeFailed = true;
            } finally {
                if (live()) {
                    attempt.offer.episodeLoading = false;
                    this.publishOffer(attempt);
                }
            }
        }
        if (part === "episode" || !live()) return;
        try {
            const quality = await capRead;
            const deck = await readOnDeck(read, attempt.request.contentId, items => {
                if (!live()) return;
                attempt.offer.deck = items.slice();
                this.publishOffer(attempt);
            }, quality);
            if (!live()) return;
            attempt.offer.deck = deck.slice();
            attempt.offer.deckSettled = true;
            attempt.offer.deckFailed = false;
        } catch (error) {
            if (!live() || (error instanceof ApiError && error.aborted)) return;
            attempt.offer.deckFailed = true;
            // A film has nothing else to offer: once a retry fails too, its Up Next panel closes with the button (canShowNextUpScreen).
            // The window retry is spent too, so the button cannot come back while a read loads.
            if (attempt.request.episode !== true && attempt.offer.deckRetried) { attempt.offer.manual = false; attempt.offer.deckWindowRetried = true; }
            attempt.offer.deckSettled = false;
        } finally {
            if (live()) {
                attempt.offer.deckLoading = false;
                this.publishOffer(attempt);
            }
        }
    }

    private publishOffer(attempt: Attempt): void {
        if (this.active() !== attempt) return;
        const offer = attempt.offer;
        const canShow = this.canApplyDisplayRect(attempt);
        const showManual = offer.manual && canShow;
        const showCredits = offer.credits && !attempt.promptDismissed && canShow;
        const showAuto = !offer.manual && !offer.credits && this.inPromptWindow(attempt) && !attempt.promptDismissed && canShow && !attempt.busy;
        if (!showManual && !showCredits && !showAuto) {
            this.clearPrompt(attempt);
            this.showPlayback(attempt);
            return;
        }
        const episodeReady = offer.episodeSettled && !offer.episodeFailed;
        const episode = episodeReady ? offer.episode : undefined;
        const fromDeck = episode === undefined && episodeReady && !offer.episodeLoading && !offer.deckFailed && offer.deck.length > 0;
        const displayed = fromDeck ? offer.deck[0] : episode;
        const loading = displayed === undefined && (offer.episodeLoading || (offer.deckLoading && !offer.episodeFailed));
        // A failed On Deck read is no lookup error (PlayerViewModel.loadNextUpOnDeckItems empties the deck), so Up Next reads
        // upNext.noNext. Only a failed next-episode lookup shows the failure line: the series may still have a next episode.
        const failed = displayed === undefined && !loading && offer.episodeFailed;
        // An automatic prompt waits for a real choice. A loading or empty read must not shrink the video or move the reported position.
        if (!showManual && !showCredits && displayed === undefined && offer.deck.length === 0) {
            this.clearPrompt(attempt);
            this.showPlayback(attempt);
            return;
        }
        attempt.prompt = { next: displayed, deck: offer.deckFailed ? [] : offer.deck, fromDeck, ...(loading ? { loading: true } : {}), ...(failed ? { failed: true } : {}) };
        this.paintRect(attempt);
        if (offer.credits) this.startCreditsCountdownIfNeeded(attempt);
        this.showPlayback(attempt);
        if (displayed !== undefined && !fromDeck && attempt.offer.presentationFor !== displayed.contentId) {
            attempt.offer.presentationFor = displayed.contentId;
            this.loadPresentation(displayed, attempt.signal, enriched => {
                if (this.active() !== attempt || attempt.offer.episode?.contentId !== displayed.contentId || attempt.prompt?.next?.contentId !== displayed.contentId) return;
                attempt.offer.episode = enriched;
                attempt.prompt = { ...attempt.prompt, next: enriched };
                this.showPlayback(attempt);
            });
        }
    }

    private clearPrompt(attempt: Attempt): void {
        if (attempt.offer.manual || attempt.offer.credits) return;
        if (attempt.prompt === undefined && !attempt.rectPending) return;
        attempt.prompt = undefined;
        this.paintRect(attempt);
    }

    private canApplyDisplayRect(attempt: Attempt): boolean {
        return !attempt.hidden && !attempt.restoring && !attempt.suspended && !attempt.suspendedReady && attempt.restoreOpen === undefined;
    }

    private paintRect(attempt: Attempt): void {
        if (!this.canApplyDisplayRect(attempt)) {
            attempt.appliedRect = undefined;
            attempt.rectPending = true;
            return;
        }
        try {
            this.setDisplayRect(attempt);
            attempt.rectPending = false;
        } catch {
            attempt.appliedRect = undefined;
            attempt.rectPending = true;
        }
    }

    private displayRect(attempt: Attempt): readonly [number, number, number, number] {
        // tvOS standard-card column: 4 × 360 + 3 × 40; preview spans two cards.
        return attempt.prompt !== undefined
            ? [upNextPreviewLeft(SCREEN.width, textIsRightToLeft()), UP_NEXT_PREVIEW.top, UP_NEXT_PREVIEW.width, UP_NEXT_PREVIEW.height]
            : [0, 0, SCREEN.width, SCREEN.height];
    }

    private setDisplayRect(attempt: Attempt): void {
        const next = this.displayRect(attempt);
        const current = attempt.appliedRect;
        if (current !== undefined && current[0] === next[0] && current[1] === next[1] && current[2] === next[2] && current[3] === next[3]) return;
        this.deps.avplay.setDisplayRect(next[0], next[1], next[2], next[3]);
        attempt.appliedRect = next;
    }

    private loadPresentation(request: PlayRequest, signal: AbortSignal, accept: (request: PlayRequest) => void): void {
        void this.deps.session.call({ ...operations.getCatalogItem(request.contentId), profileScoped: true, signal }).then(detail => {
            if (!signal.aborted && detail.id === request.contentId) {
                const watch = playbackWatch(detail.watch);
                // Apple's backgroundArtwork (PlayerView.swift) takes the episode still first. On the S95C a next season's first episode's item
                // carried no backdrop, or the series backdrop, where its season row had the still, so the item's backdrop wins only when it is a still or the row has none.
                const rowStill = request.episode === true && present(request.backdropUrl) && request.backdropIsEpisodeStill !== false;
                const itemWins = present(detail.backdropUrl) && (detail.backdropIsEpisodeStill === true || !rowStill);
                const still = itemWins ? { backdropUrl: detail.backdropUrl, backdropIsEpisodeStill: detail.backdropIsEpisodeStill } : { backdropUrl: request.backdropUrl, backdropIsEpisodeStill: request.backdropIsEpisodeStill };
                accept({ ...request, overview: detail.overview ?? request.overview, ...still, ...(watch === undefined ? {} : { watch }) });
            }
        }, () => undefined);
    }

    /** Apple TV hides an unstarted episode synopsis when the profile asks (`PlayerView.swift` metadata). */
    private shownNext(request: PlayRequest | undefined): PlayRequest | undefined {
        if (request?.episode !== true) return request;
        const settings = this.deps.spoilers?.() ?? { hidesImages: false, hidesOverviews: false };
        const presentation = episodeDetailPresentation({
            type: "episode",
            overview: request.overview,
            watch: request.watch,
            played: request.watch?.played,
            backdropUrl: request.backdropUrl,
            backdropIsEpisodeStill: request.backdropIsEpisodeStill,
        }, settings);
        const overview = presentation.overview;
        const hideBackdrop = presentation.hideBackdrop ? true as const : undefined;
        if (overview === request.overview && hideBackdrop === undefined) return request;
        return { ...request, ...(overview === request.overview ? {} : { overview }), ...(hideBackdrop === undefined ? {} : { hideBackdrop }) };
    }

    private show(view: PlaybackView): void {
        this.base = view;
        const attempt = this.attempt;
        if (attempt !== undefined && attempt.live) {
            const serial = ++this.shown;
            this.syncBuffering(attempt);
            // The sync can draw a newer view of its own (a pill, a restore that began a change): this one is stale.
            if (this.shown !== serial) return;
            if (view.phase === "loading" || view.phase === "playing" || view.phase === "paused") {
                const { pill, notice } = attempt.bufferingQuality;
                if (pill !== undefined || notice !== undefined) view = { ...view, ...(pill === undefined ? {} : { bufferingPill: pill }), ...(notice === undefined ? {} : { bufferingNotice: notice }) };
            }
        }
        this.current = view;
        for (const listener of this.listeners.slice()) {
            listener(view);
        }
    }

    /** RFC 4122 version 4 UUID: a valid playback_attempt_id, replan_request_id, plan_attempt_id and stop_id. */
    private newId(): string {
        const bytes = new Uint8Array(16);
        this.deps.randomBytes(bytes);
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        let hex = "";
        bytes.forEach((byte) => {
            hex += (byte + 0x100).toString(16).slice(1);
        });
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
}

function samplePaused(attempt: Attempt): boolean {
    return attempt.presented ? attempt.paused : true;
}

function retryableStart(error: PlaybackError): boolean {
    return error.kind === "network" || error.kind === "server" || error.kind === "settings" || (error.kind === "terminal" && error.retryable);
}

/** The failed start again. A plan that already chose a position keeps that position. */
function sameStart(attempt: Attempt): PlayRequest {
    const request = attempt.request;
    if (attempt.plan === undefined || request.startSeconds === attempt.sourceSeconds) return request;
    return { ...request, startSeconds: attempt.sourceSeconds };
}

export interface PlaybackStatusState {
    readonly error?: boolean;
    readonly ended?: boolean;
    readonly reconnecting?: boolean;
    readonly loading?: boolean;
    readonly seeking?: boolean;
    readonly paused?: boolean;
    readonly stalled?: boolean;
    readonly rebuffering?: boolean;
}

/** Apple's PlaybackPhase precedence for Stats' Playback status row. */
export function playbackStatus(state: PlaybackStatusState): PlaybackStatus {
    if (state.error) return "Error";
    if (state.ended) return "Ended";
    if (state.reconnecting) return "Reconnecting";
    if (state.loading) return "Loading";
    if (state.seeking) return "Seeking";
    if (state.paused) return "Paused";
    if (state.stalled) return "Stalled";
    if (state.rebuffering) return "Rebuffering";
    return "Playing";
}

function currentBandwidthBps(avplay: AVPlay): number | undefined {
    if (avplay.getStreamingProperty === undefined) return undefined;
    try {
        const raw = avplay.getStreamingProperty("CURRENT_BANDWIDTH").trim();
        if (raw === "") return undefined;
        const bps = Number(raw);
        return Number.isFinite(bps) && bps > 0 ? bps : undefined;
    } catch {
        return undefined;
    }
}

/** The selected tracks, speed, phase, AVPlay bandwidth and media host the Stats and Info rows need beside the plan. */
function liveStats(attempt: Attempt, plan: PlaybackPlan, baseUrl: string, status: PlaybackStatus, networkThroughputBps: number | undefined): LiveStats {
    const fileId = plan.effectiveMediaFileId;
    const version = attempt.tracks?.state === "ready" ? attempt.tracks.versions.find(candidate => candidate.fileId === fileId) : undefined;
    const ordinal = version?.audio.findIndex((_, index) => `file:${fileId}:audio:${index}` === plan.selectedTracks.audio?.id) ?? -1;
    const track = version?.audio[ordinal];
    let host: string | undefined;
    try { host = new URL(plan.streamUrl, baseUrl).hostname || undefined; } catch { host = undefined; }
    return {
        audio: track === undefined ? undefined : { track, ordinal },
        subtitle: attempt.subtitles.liveStatsSubtitle(plan),
        speed: attempt.hud.speed,
        status,
        host,
        networkThroughputBps,
    };
}

function trackView(attempt: Attempt, plan: PlaybackPlan): TrackView {
    const tracks = attempt.tracks;
    const notices: string[] = [];
    for (const warning of plan.warnings) {
        const notice = WARNING_NOTICES[warning.code];
        if (notice !== undefined && notices.indexOf(notice) === -1) {
            notices.push(notice);
        }
    }
    const sub = attempt.subtitles.trackViewSlice(plan);
    notices.push(...sub.notices);
    return {
        ...sub,
        quality: {
            choices: qualityChoices(plan),
            selectedId: attempt.qualityPreference === "auto" ? "auto" : attempt.serverFeatures.includes("plan_active_quality_v1")
                ? qualityChoices(plan).find((quality) => quality.id === plan.activeQuality && quality.id !== "auto")?.id
                : attempt.qualityPicked ? plan.availableQualities.find((quality) => quality.label === attempt.qualityPreference)?.label : undefined,
        },
        audio: tracks === undefined || tracks.state !== "ready" ? { state: tracks?.state ?? "loading" } : { state: "ready", choices: audioChoices(attempt, plan) },
        selectedAudioId: plan.selectedTracks.audio?.id,
        change: attempt.change.state !== "idle" ? attempt.change : sub.change,
        notices,
    };
}

function qualityChoices(plan: PlaybackPlan): TrackChoice[] {
    const offered = plan.availableQualities.filter((quality) => quality.label !== "original" && quality.label !== "auto");
    return offered.length === 0 ? [] : [{ id: "auto", label: translate("options.auto") }, ...offered.map((quality) => ({ id: quality.label, label: qualityMenuLabel(quality) }))];
}

/** The effective edition's audio tracks; empty until the versions read answers. */
function audioChoices(attempt: Attempt, plan: PlaybackPlan): TrackChoice[] {
    const tracks = attempt.tracks;
    const fileId = plan.effectiveMediaFileId;
    const version = tracks?.state === "ready" ? tracks.versions.find((candidate) => candidate.fileId === fileId) : undefined;
    return (version?.audio ?? []).map((track, ordinal) => ({ id: `file:${fileId}:audio:${ordinal}`, ...audioRow(track, ordinal) }));
}

/** A track change or subtitle report holds `busy` while its replan is out; a Direct Play embedded switch never does, so a seek may hold it instead. */
function changeHoldsBusy(attempt: Attempt): boolean {
    return attempt.change.state === "changing" || attempt.subtitles.holdsTransportBusy;
}

/** Whether the plan's timeline lets AVPlay seek to `seconds` locally, without the server reanchoring. */
function seekableAt(plan: PlaybackPlan, seconds: number): boolean {
    const timeline = plan.timeline;
    return timeline.canSeekAnywhere &&
        seconds >= timeline.timelineOffsetSeconds &&
        (timeline.seekWindowStartSeconds === undefined || seconds >= timeline.seekWindowStartSeconds) &&
        (timeline.seekWindowEndSeconds === undefined || seconds <= timeline.seekWindowEndSeconds);
}

/**
 * A direct-play plan opened at source `seconds` instead of where it was asked, when its timeline can start there; the player
 * position is the source position less the timeline offset (#792). Undefined when it cannot.
 */
function startAt(plan: PlaybackPlan, seconds: number): PlaybackPlan | undefined {
    const timeline = plan.timeline;
    const duration = plan.durationSeconds;
    if (plan.delivery !== "original_http" || seconds < 0 || (duration !== undefined && seconds > duration) || !seekableAt(plan, seconds)) return undefined;
    const playerStartSeconds = Math.max(0, seconds - timeline.timelineOffsetSeconds);
    if (seconds === timeline.sourceStartSeconds && playerStartSeconds === timeline.playerStartSeconds) return plan;
    return { ...plan, timeline: { ...timeline, sourceStartSeconds: seconds, playerStartSeconds } };
}

/**
 * Adds the media credential to the query, before any fragment, so the HTTP request carries it.
 * The published URL stays byte-for-byte otherwise: reserializing would re-encode the signed `st`.
 */
function withMediaToken(published: string, token: string): string {
    const hash = published.indexOf("#");
    const head = hash === -1 ? published : published.slice(0, hash);
    const fragment = hash === -1 ? "" : published.slice(hash);
    return `${head}${head.indexOf("?") === -1 ? "?" : "&"}token=${encodeURIComponent(token)}${fragment}`;
}

function playbackWatch(watch: { readonly played: boolean; readonly isInProgress?: boolean; readonly positionSeconds?: number | undefined } | undefined): PlayRequest["watch"] {
    if (watch === undefined) return undefined;
    return {
        played: watch.played,
        ...(watch.isInProgress === undefined ? {} : { isInProgress: watch.isInProgress }),
        ...(watch.positionSeconds === undefined ? {} : { positionSeconds: watch.positionSeconds }),
    };
}

/** The session itself is gone or the request was abandoned: not a track change the viewer can retry. */
/** The server answered and refused the replan, so it holds the plan it had. A missing or unusable answer proves nothing. */
function rejectedReplan(error: unknown): boolean {
    return error instanceof ApiError && !unanswered(error) && error.failure.kind !== "invalid_response";
}

function sessionGone(error: unknown): boolean {
    return error instanceof ApiError && (error.aborted || error.status === 404 || error.status === 410 || error.problemId === "installation_changed");
}

/** Mutable per-attempt trace; `incidentTrace()` publishes a read-only copy. */
interface AttemptTrace {
    readonly seq: number;
    chain: number;
    /** The recovered chain as published at recovery; cleared when the next failure opens a chain. */
    frozen: PlaybackAttemptTrace | undefined;
    stage: PlaybackStage;
    done: PlaybackStage | undefined;
    first: PlaybackTraceFailure | undefined;
    http: number | undefined;
    decision: "adaptation_unavailable" | "unknown" | undefined;
    firstAvplay: string | undefined;
    lastAvplay: string | undefined;
    resends: number;
    fallbacks: number;
    reconnects: number;
    opened: boolean;
    shown: boolean;
    recovered: boolean;
    exhausted: boolean;
    timedOut: boolean;
    settingsRead: boolean;
    hdrProbe: HdrProbe;
    /** The latest plan this attempt received, recorded before any check can refuse it. */
    received: PlaybackPlan | undefined;
    /** A buffering-quality replan is in flight. */
    buffering: boolean;
    readonly steps: string[];
    /** Audio and subtitle evidence (#874); a recovered chain's freeze never holds it. */
    readonly media: MediaTrace;
}

interface MediaTrace {
    load: CaptionLoadState;
    switch: MediaSwitchEvidence | undefined;
    failure: MediaFailure | undefined;
    failures: number;
    observed: AudioFormatEvidence | undefined;
    /** The transport `observed` was read from. */
    observedFor: string | undefined;
}

const MAX_TRACE_STEPS = 24;

const REPLAN_STAGES: Readonly<Record<ReplanOperation, PlaybackStage>> = {
    failure_recovery: "recovery",
    seek_reanchor: "seek_reanchor",
    track_change: "track_change",
    quality_change: "quality_change",
};

function newTrace(seq: number): AttemptTrace {
    return {
        seq, chain: 0, frozen: undefined, stage: "capabilities", done: undefined, first: undefined, http: undefined, decision: undefined,
        firstAvplay: undefined, lastAvplay: undefined, resends: 0, fallbacks: 0, reconnects: 0, opened: false, shown: false, recovered: false,
        exhausted: false, timedOut: false, settingsRead: false, hdrProbe: "unavailable", received: undefined, buffering: false, steps: [],
        media: { load: "not_needed", switch: undefined, failure: undefined, failures: 0, observed: undefined, observedFor: undefined },
    };
}

function requestSwitch(attempt: Attempt, kind: "audio" | "subtitle"): void {
    attempt.trace.media.switch = { kind, result: "pending" };
}

/** Numbers a definite audio/subtitle failure and adds its step, leaving the playback stage and first failure alone. */
function mediaFailed(attempt: Attempt, stage: MediaFailureStage, out: MediaFailure["out"], code: string | undefined, http: number | undefined, network: boolean): void {
    const trace = attempt.trace;
    trace.media.failures++;
    trace.media.failure = { n: trace.media.failures, stage, out, code, http, network };
    const result: TraceStepResult = out === "failed" ? "fail" : out === "refused" ? "refused" : "fallback";
    trace.steps.push(code === undefined ? `${stage}:${result}` : `${stage}:${result}:${code}`);
    if (trace.steps.length > MAX_TRACE_STEPS) trace.steps.splice(0, trace.steps.length - MAX_TRACE_STEPS);
}

/** `fallback`: the sidecar failed and AVPlay draws the embedded track instead. */
function captionLoadFailed(attempt: Attempt, load: "failed" | "fallback", cause: Pick<MediaFailure, "http" | "network">): void {
    attempt.trace.media.load = load;
    mediaFailed(attempt, "caption_load", load === "failed" ? "failed" : "recovered", "caption_load_failed", cause.http, cause.network);
}

/** A failure after a recovery is independent of it: it opens the next chain, leaving the recovered one as published. */
function nextChain(trace: AttemptTrace): void {
    if (!trace.recovered) return;
    trace.chain++;
    trace.frozen = undefined;
    trace.recovered = false;
    trace.exhausted = false;
    trace.timedOut = false;
    trace.first = undefined;
    trace.http = undefined;
    trace.decision = undefined;
    trace.firstAvplay = undefined;
    trace.lastAvplay = undefined;
    trace.resends = 0;
    trace.fallbacks = 0;
    trace.reconnects = 0;
}

function traceStep(trace: AttemptTrace, result: TraceStepResult, code?: string): void {
    trace.steps.push(code === undefined ? `${trace.stage}:${result}` : `${trace.stage}:${result}:${code}`);
    if (trace.steps.length > MAX_TRACE_STEPS) trace.steps.splice(0, trace.steps.length - MAX_TRACE_STEPS);
}

function enterStage(trace: AttemptTrace, stage: PlaybackStage): void {
    trace.stage = stage;
}

function reachedStage(trace: AttemptTrace, stage: PlaybackStage): void {
    trace.done = stage;
    traceStep(trace, "ok");
}

/** Records the step and, once per chain, the first causally relevant failure. A recovery attempt clears the HTTP status, so only the ending failure's own status is final. */
function traceFailure(trace: AttemptTrace, result: TraceStepResult, code?: string): void {
    nextChain(trace);
    // A playable start response settled its retries. A later stage owns its own failure.
    if (trace.first?.stage === "start" && trace.stage !== "start" && trace.resends > 0) {
        trace.first = undefined;
        trace.resends = 0;
        trace.steps.length = 0;
    }
    if (result === "fallback") clearRecoveryError(trace);
    if (trace.first === undefined) trace.first = { stage: trace.stage, ...(result === "end" ? {} : { code }), buffering: trace.buffering };
    traceStep(trace, result, code);
}

/** Returns true when this playing state recovers the chain's failure. */
function tracePlaying(trace: AttemptTrace): boolean {
    trace.shown = true;
    trace.buffering = false;
    enterStage(trace, "playing");
    if (trace.first !== undefined && !trace.recovered) {
        trace.recovered = true;
        traceStep(trace, "recovered");
        return true;
    }
    reachedStage(trace, "playing");
    return false;
}

function noteAvplay(attempt: Attempt, code: string): void {
    attempt.lastAvplayError = code;
    nextChain(attempt.trace);
    attempt.trace.firstAvplay ??= code;
    attempt.trace.lastAvplay = code;
}

function clearRecoveryError(trace: AttemptTrace): void {
    trace.http = undefined;
    trace.timedOut = false;
}

function beginReconnectAttempt(trace: AttemptTrace): void {
    enterStage(trace, "reconnect");
    clearRecoveryError(trace);
}

function traceUniqueStep(trace: AttemptTrace, result: TraceStepResult, code?: string): void {
    const step = code === undefined ? `${trace.stage}:${result}` : `${trace.stage}:${result}:${code}`;
    if (trace.steps[trace.steps.length - 1] !== step) traceStep(trace, result, code);
}

function recordReconnectError(trace: AttemptTrace, error: unknown, verdict: RecoveryVerdict): void {
    noteApiError(trace, error);
    if (verdict.kind === "retry") {
        const code = httpCode(error) ?? (error instanceof ApiError && error.failure.kind === "timeout" ? "no_response" : undefined);
        if (code !== undefined) traceUniqueStep(trace, "retry", code);
    }
}

/** Keeps only an HTTP status or timeout observed on the failing request; clears stale failure state from earlier attempts. */
function noteApiError(trace: AttemptTrace, error: unknown): void {
    nextChain(trace);
    trace.http = error instanceof ApiError ? error.status : undefined;
    trace.timedOut = error instanceof ApiError && error.failure.kind === "timeout";
}

function httpCode(error: unknown): string | undefined {
    return error instanceof ApiError && error.status !== undefined ? `http_${error.status}` : undefined;
}

function traceDecision(trace: AttemptTrace, decision: PlaybackDecision): PlaybackError {
    nextChain(trace);
    if (decision.outcome !== "playable") trace.decision = decision.outcome;
    return decisionFailure(decision);
}

function decisionFailure(decision: PlaybackDecision): PlaybackError {
    return decision.outcome === "adaptation_unavailable" ? { kind: "terminal", ...decision.terminal } : { kind: "server" };
}

function startFailure(error: unknown): PlaybackError {
    if (error instanceof ApiError) {
        const failure = error.failure;
        // PlayerViewModel's startSessionTimeout reads player.error.serverNoResponse.
        if (failure.kind === "timeout") return { kind: "network", noResponse: true };
        if (failure.kind === "network") {
            return { kind: "network" };
        }
        if (error.problemId === "installation_changed") {
            return { kind: "installation_changed" };
        }
        // A start failure keeps its status, problem type and field code for the error page; never the server's free text.
        if (failure.kind === "http") return { kind: "server", reason: { status: failure.status } };
        if (failure.kind === "problem") {
            const { status, id, errors } = failure.problem;
            if (status === 410 && id === "client_upgrade_required") return { kind: "server", reason: { update: true } };
            const fieldCode = errors[0]?.code;
            return { kind: "server", reason: fieldCode === undefined ? { status, problemId: id } : { status, problemId: id, fieldCode } };
        }
    }
    return { kind: "server" };
}
