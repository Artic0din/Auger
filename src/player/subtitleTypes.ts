import type { Clock } from "../api/clock.ts";
import type { FileVersionTracks, PlaybackDecision, PlaybackPlan, SelectedTracks } from "../contracts/v2/playback.ts";
import type { CatalogSubtitleTrack, SubtitleIntent } from "../contracts/v2/preplaySubtitles.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import type { SubtitleAIView } from "./subtitleAI.ts";
import type { AIMenu } from "./subtitleAIRoute.ts";
import type { AppearanceMember } from "./subtitleAppearance.ts";
import type { SubtitleDisplayView } from "./subtitleDisplay.ts";
import type { SubtitleSearchView } from "./subtitleSearch.ts";
import type { SyncTimingView } from "./subtitleSync.ts";
import type { NativeTextTrack } from "./subtitleTransportRules.ts";

export interface TrackChoice {
    readonly id: string;
    readonly label: string;
    /** Codec, layout and flags. Absent when the name already says everything. */
    readonly detail?: string;
    /** Shown but not choosable: the server has no route to show this track. */
    readonly unavailable?: boolean;
}

export type TrackChange =
    | { readonly state: "idle" }
    /** `subtitle`: a direct-play switch to an embedded subtitle's file (#538), during which the subtitle rows stay choosable. */
    | { readonly state: "changing"; readonly kind?: "quality" | "subtitle" }
    /** The server refused the choice; the current plan keeps playing. */
    | { readonly state: "refused"; readonly message: string }
    | { readonly state: "failed" };

export type SubtitleToolAction =
    | { readonly kind: "search-open" }
    | { readonly kind: "search-language"; readonly code: string }
    | { readonly kind: "search-back" }
    | { readonly kind: "search-close" }
    | { readonly kind: "search-download"; readonly key: string }
    | { readonly kind: "search-retry" }
    | { readonly kind: "delay"; readonly milliseconds: number }
    | { readonly kind: "size"; readonly size: SubtitleAppearance["fontSize"] }
    | { readonly kind: "position"; readonly position: SubtitleAppearance["position"] }
    | { readonly kind: "device"; readonly enabled: boolean }
    | { readonly kind: "appearance"; readonly member: AppearanceMember; readonly value: string | number | boolean };

export type AudioVersionSnapshot =
    | { readonly state: "loading" | "failed" }
    | { readonly state: "ready"; readonly versions: readonly FileVersionTracks[] }
    | undefined;

/** Narrow AVPlay text-only capability port. Never exposes open, close, seek, play, or pause. */
export interface NativeTextPort {
    /** True when AVPlay supports full in-stream text switching (`getTotalTrackInfo` + `setSelectTrack` + `setSilentSubtitle`). */
    readonly canSelectInStream: boolean;
    listTextTracks(): readonly NativeTextTrack[] | undefined;
    selectTextTrack(index: number): boolean;
    setSilentSubtitle(hidden: boolean): boolean;
}

/** Read-only transport facts owned by PlaybackController. */
export interface SubtitleTransportSnapshot {
    readonly live: boolean;
    readonly plan: PlaybackPlan | undefined;
    readonly started: boolean;
    readonly presented: boolean;
    readonly busy: boolean;
    readonly hidden: boolean;
    readonly restoring: boolean;
    readonly recoveryActive: boolean;
    readonly sourceSeconds: number;
    readonly audioVersions: AudioVersionSnapshot;
}

/** Single-attempt `track_change` replan handle bound to one stable `replan_request_id`. */
export interface PreparedTrackReplan {
    readonly sessionId: string;
    isCurrent(): boolean;
    send(): Promise<PlaybackDecision>;
}

export type SubtitlePostSettle =
    | { readonly kind: "none" }
    | { readonly kind: "complete_stream" }
    | { readonly kind: "recover_route"; readonly classification: string };

export type SubtitleFailure =
    | { readonly kind: "server" }
    | { readonly kind: "playback_failed" }
    | { readonly kind: "terminal"; readonly reason: string; readonly message: string; readonly retryable: boolean };

/** Narrow two-adapter host seam: implemented by PlaybackController in production and FakeSubtitleHost in tests. */
export interface SubtitleHost {
    readonly nativeText: NativeTextPort;
    snapshot(): SubtitleTransportSnapshot;
    /** Live AVPlay media clock in ms, or undefined when unavailable/not started. */
    readPlayerTimeMs(): number | undefined;
    /** Builds a bound `track_change` replan sender for `plan`, `selected`, and `positionSeconds`. */
    prepareTrackReplan(plan: PlaybackPlan, selected: SelectedTracks, positionSeconds: number): PreparedTrackReplan | undefined;
    /** Waits until all in-flight and chained local AVPlay seeks settle (`bounded` caps the wait at startup's deadline). */
    waitForPendingSeeks(bounded: boolean): Promise<void>;
    /** Redraws the current playback view. */
    changed(): void;
    /** Marks a subtitle switch started; clears thumbnails unless `mode === "reporting"` and sets busy when blocking/reporting. */
    beginSwitch(mode: "blocking" | "non_blocking" | "reporting"): void;
    /** Updates active plan metadata without reopening AVPlay. */
    keepPlan(plan: PlaybackPlan, serverFeatures: readonly string[]): void;
    /** Adopts a replacement transport plan. `alignToPlayhead` applies `startAt` + queued reanchor semantics for Direct Play switches. */
    adoptPlan(plan: PlaybackPlan, serverFeatures: readonly string[], alignToPlayhead: boolean): void;
    /** Clears busy (preserving an active seek only when `keepBusyIfSeeking` is true), runs post-settle completion or route recovery, and redraws. */
    settleSwitch(keepBusyIfSeeking: boolean, postSettle: SubtitlePostSettle): void;
    /** Clears busy right before re-selecting an unapplied pending HLS pick on a kept stream. */
    releaseBusyForReselect(): void;
    /** Executes any queued out-of-window reanchor after a kept-stream switch settles. */
    flushQueuedReanchor(): void;
    /** Closes AVPlay and shows loading before a first-frame native-unavailable fallback replan. */
    closeForReplan(): void;
    /** Hands a lost-answer switch back to connection recovery. */
    recoverConnection(): void;
    /** Terminates playback with a known error. */
    fail(error: SubtitleFailure, stopSession: boolean): void;
    /** Terminates playback with a start-time request error (`startFailure`). */
    failFromStartError(error: unknown, stopSession: boolean): void;
    /** Terminates playback from a non-playable Server decision (`decisionFailure`). */
    failFromDecision(decision: Exclude<PlaybackDecision, { readonly outcome: "playable" }>, stopSession: boolean): void;
    /** Delegates session-level errors (`404`/`410`/`installation_changed`) to PlaybackController. */
    sessionFailure(error: unknown): void;
}

export interface SubtitleSessionDeps {
    readonly session: NativeSession;
    readonly clock: Clock;
    readonly publicStorage?: PublicStorage | undefined;
    readonly host: SubtitleHost;
}

export interface SubtitleSessionRequest {
    readonly contentId: string;
    readonly fileId: string;
    readonly episode?: true;
    readonly subtitle?: SubtitleIntent;
    readonly subtitleTracks?: readonly CatalogSubtitleTrack[];
}

export type StreamAlignmentResult = "aligned" | "replan_unavailable_native" | "failed";
export type RouteFailureDisposition = "not_owned" | "absorbed_by_blocking_change" | "absorbed_by_direct_switch";
export type StreamCompletedDisposition = "not_owned" | "deferred";

export type PendingStoredTrack = { readonly kind: "ai" | "download"; readonly id: string };

export interface SubtitleTrackViewSlice {
    readonly ai?: SubtitleAIView | undefined;
    readonly aiMenu?: { readonly menu: AIMenu; readonly quota: string | undefined; readonly quotaExhausted: boolean } | undefined;
    readonly seriesSubtitle?: { readonly busy: boolean; readonly message: string } | undefined;
    readonly subtitles: readonly TrackChoice[];
    readonly selectedSubtitleId: string | undefined;
    readonly subtitleMode: string;
    readonly change: TrackChange;
    readonly reporting?: boolean;
    readonly notices: readonly string[];
    readonly subtitleTools?: { readonly search: SubtitleSearchView; readonly display?: SubtitleDisplayView; readonly overlay: boolean };
    readonly syncTiming?: SyncTimingView | undefined;
    readonly secondary?: { readonly choices: readonly TrackChoice[]; readonly selectedId: string | undefined } | undefined;
}
