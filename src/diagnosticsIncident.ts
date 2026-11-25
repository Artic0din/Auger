import { PROTOCOLS, CONTAINERS, VIDEO_CODECS, DYNAMIC_RANGES } from "../shared/diagnostics-media.js";
import type { PlaybackError } from "./player/controller.ts";
import type { BufferingEvidenceTrace } from "./player/bufferingEvidence.ts";

/** Ordered playback stages a single attempt passes through; recovery stages follow a failure. */
export const PLAYBACK_STAGES = [
    "capabilities", "settings", "start", "subtitles", "media_token", "playlist_check",
    "avplay_open", "avplay_prepare", "avplay_seek", "avplay_play", "playing",
    "recovery", "reconnect", "track_change", "quality_change", "seek_reanchor", "progress",
] as const;
export type PlaybackStage = (typeof PLAYBACK_STAGES)[number];

export type PlaybackOperation =
    | "playback_capabilities" | "playback_defaults" | "start_playback" | "subtitle_preferences" | "media_token"
    | "hls_playlist" | "avplay" | "replan_playback" | "progress_report";

const STAGE_OPERATION: Readonly<Record<PlaybackStage, PlaybackOperation>> = {
    capabilities: "playback_capabilities", settings: "playback_defaults", start: "start_playback", subtitles: "subtitle_preferences",
    media_token: "media_token", playlist_check: "hls_playlist", avplay_open: "avplay", avplay_prepare: "avplay", avplay_seek: "avplay",
    avplay_play: "avplay", playing: "avplay", recovery: "replan_playback", reconnect: "start_playback", track_change: "replan_playback",
    quality_change: "replan_playback", seek_reanchor: "replan_playback", progress: "progress_report",
};

export type TraceStepResult = "ok" | "fail" | "retry" | "fallback" | "recovered" | "refused" | "end";
const STEP_RESULTS = new Set<string>(["ok", "fail", "retry", "fallback", "recovered", "refused", "end"]);
const STAGE_SET = new Set<string>(PLAYBACK_STAGES);

/** First causally relevant failure of an attempt; `code` is raw and validated when serialized. */
export interface PlaybackTraceFailure {
    readonly stage: PlaybackStage;
    readonly code?: string | undefined;
    /** The failure happened during a buffering-quality replan, so Buffering / Quality owns the incident. */
    readonly buffering: boolean;
}

/** One attempt's structured trace, produced by the player controller. Carries no URLs, titles or identifiers. */
export interface PlaybackAttemptTrace {
    /** Local attempt sequence; never serialized. */
    readonly seq: number;
    /** Causal chain within the attempt: a failure after a recovery opens the next one, and the recovered chain stays frozen. Never serialized. */
    readonly chain: number;
    readonly stage: PlaybackStage;
    readonly done: PlaybackStage | undefined;
    readonly first: PlaybackTraceFailure | undefined;
    readonly http: number | undefined;
    readonly decision: "adaptation_unavailable" | "unknown" | undefined;
    readonly firstAvplay: string | undefined;
    readonly lastAvplay: string | undefined;
    readonly resends: number;
    readonly fallbacks: number;
    readonly reconnects: number;
    readonly opened: boolean;
    readonly shown: boolean;
    readonly recovered: boolean;
    /** The reconnect loop gave up: applicable recovery ran out, so the failure is not ordinary connectivity. */
    readonly exhausted: boolean;
    readonly steps: readonly string[];
    /** Undefined until the playback defaults were read for this attempt. */
    readonly settings: { readonly quality: string; readonly capKbps: number | undefined; readonly hdr: boolean } | undefined;
    /** "unavailable" when the probe gave no usable answer; an object only for an observed answer. */
    readonly hdrPanel: { readonly hdr10: boolean; readonly hlg: boolean; readonly dolbyVision: boolean } | "unavailable";
    readonly request: { readonly startSeconds: number | undefined; readonly subtitle: "auto" | "off" | "track"; readonly audio: "default" | "track" };
    /** Buffering and quality evidence; published only for a Buffering / Quality report. */
    readonly quality?: BufferingEvidenceTrace | undefined;
    /** Undefined until this attempt received a plan; never an earlier attempt's plan. */
    readonly plan: {
        readonly delivery: string;
        readonly protocol: string | undefined;
        readonly container: string | undefined;
        readonly quality: string | undefined;
        readonly sourceKbps: number | undefined;
        readonly videoCodec: string | undefined;
        readonly width: number | undefined;
        readonly height: number | undefined;
        readonly dynamicRange: string | undefined;
        readonly startSeconds: number;
        readonly atSeconds: number;
    } | undefined;
}

export type IncidentOutcome = "failed" | "refused" | "interrupted" | "recovered";
export type IncidentSource = "manual" | "auto";
export type IncidentCategory = "playback" | "buffering";
export type IncidentRecovery = "none" | "recovered" | "attempted" | "exhausted";

export interface DiagnosticsIncidentPlan {
    readonly dl: string;
    readonly pr?: string;
    readonly ct?: string;
    readonly q?: string;
    readonly kbps?: number;
    readonly vc?: string;
    readonly res?: string;
    readonly dr?: string;
    readonly pos: number;
    readonly at: number;
}

/** Public incident record (`inc`) carried inside the v1 payload. Every value is an enum, bounded integer, boolean or allowlisted code. */
export interface DiagnosticsIncidentPayload {
    readonly iv: 1;
    readonly cat: IncidentCategory;
    readonly src?: IncidentSource;
    readonly out: IncidentOutcome;
    readonly kind?: PlaybackError["kind"];
    /** First causally relevant failed operation, stage and code: the grouping key. */
    readonly op: PlaybackOperation;
    readonly stage: PlaybackStage;
    readonly code?: string;
    /** Final stage and code when the attempt ended. */
    readonly fs?: PlaybackStage;
    readonly fc?: string;
    readonly done: PlaybackStage | "none";
    readonly dec?: "adaptation_unavailable" | "unknown";
    /** Only an HTTP status that was actually observed. */
    readonly http?: number;
    readonly rt?: boolean;
    readonly av?: { readonly f?: string; readonly l?: string };
    readonly open: boolean;
    readonly shown: boolean;
    readonly rs: number;
    readonly rec: { readonly n: number; readonly c: number; readonly r: IncidentRecovery };
    readonly pl: DiagnosticsIncidentPlan | "not_reached";
    readonly set: { readonly q: string; readonly cap: number | "none"; readonly hdr: boolean } | "not_reached";
    readonly hp: { readonly h10: boolean; readonly hlg: boolean; readonly dv: boolean } | "unavailable";
    readonly req: { readonly pos: number | "none"; readonly sub: "auto" | "off" | "track"; readonly aud: "default" | "track" };
    readonly t: readonly string[];
}

/** Documented Samsung Tizen AVPlayError enum names (explicit allowlist; no wildcard regex). */
export const ALLOWED_AVPLAY_ERROR_CODES: ReadonlySet<string> = new Set([
    "PLAYER_ERROR_NONE",
    "PLAYER_ERROR_INVALID_PARAMETER",
    "PLAYER_ERROR_NO_SUCH_FILE",
    "PLAYER_ERROR_INVALID_OPERATION",
    "PLAYER_ERROR_SEEK_FAILED",
    "PLAYER_ERROR_INVALID_STATE",
    "PLAYER_ERROR_NOT_SUPPORTED_FILE",
    "PLAYER_ERROR_NOT_SUPPORTED_FORMAT",
    "PLAYER_ERROR_INVALID_URI",
    "PLAYER_ERROR_CONNECTION_FAILED",
    "PLAYER_ERROR_GENEREIC",
    "PLAYER_ERROR_GENERIC",
    "PLAYER_ERROR_DRM_INFO_ERROR",
    "PLAYER_ERROR_INVALID_BUFFER",
    "PLAYER_ERROR_NOT_SUPPORTED_SUBTITLE",
    "PLAYER_ERROR_OUT_OF_MEMORY",
]);
const ALLOWED_AVPLAY_STAGES = new Set(["prepareAsync", "open", "play", "seekTo"]);
const ALLOWED_AVPLAY_EXCEPTIONS = new Set([
    "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError",
    "DOMException", "WebAPIException", "AbortError", "NotAllowedError", "NotSupportedError", "QuotaExceededError",
    "SecurityError", "NetworkError", "TimeoutError", "DataCloneError", "InvalidAccessError", "InvalidStateError",
    "InvalidValuesError", "NotFoundError", "UnknownError", "OperationNotSupportedError", "failed", "error",
]);

export function cleanAvplayError(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    if (trimmed === "startup_timeout" || ALLOWED_AVPLAY_ERROR_CODES.has(trimmed)) return trimmed;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) return undefined;
    const stage = trimmed.slice(0, colon);
    if (!ALLOWED_AVPLAY_STAGES.has(stage)) return undefined;
    const name = trimmed.slice(colon + 1);
    return ALLOWED_AVPLAY_EXCEPTIONS.has(name) ? `${stage}:${name}` : `${stage}:error`;
}

const FAILURE_CODES = new Set([
    "settings", "unavailable", "terminal", "terminal_error", "session_expired", "session_missing",
    "installation_changed", "revoked", "backgrounded", "network", "server", "server_error",
    "no_answer", "no_response", "network_unreachable", "connection_lost", "playback_failed",
    "client_upgrade_required", "routes_exhausted", "hls_playlist_unreadable", "audio_track_switch_failed",
    "avplay_prepare_failed", "avplay_open_failed", "avplay_play_failed", "avplay_resume_seek_failed",
    "avplay_playback_error", "avplay_startup_timeout", "version_unavailable", "subtitle_selection_unavailable",
]);
export const QUALITIES = ["auto", "original", "2160p", "1080p", "720p", "480p", "360p"];
const MAX_STEPS = 16;
const MAX_COUNT = 99;
const DELIVERIES = new Set(["original_http", "server_remux_progressive", "server_remux_hls", "server_transcode_hls", "unknown"]);
const EXPECTED_REFUSALS = new Set(["version_unavailable", "subtitle_selection_unavailable"]);

/** An allowlisted AVPlay code or a recognized technical code; anything else is dropped. */
export function cleanIncidentCode(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    const avplay = cleanAvplayError(raw);
    if (avplay !== undefined) return avplay;
    return FAILURE_CODES.has(raw) || /^http_[1-5]\d{2}$/.test(raw) ? raw : undefined;
}

export function publicMediaToken(raw: string | undefined, allowed: readonly string[]): string | undefined {
    if (raw === undefined) return undefined;
    const lowered = raw.trim().toLowerCase();
    return allowed.includes(lowered) ? lowered : undefined;
}

function count(value: number): number {
    return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_COUNT) : 0;
}

function seconds(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), 360000) : undefined;
}

function httpStatus(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/** Validates `stage:result[:code]`, dropping the code when it is not allowlisted and the step when its stage or result is unknown. */
export function cleanTraceStep(step: string): string | undefined {
    const first = step.indexOf(":");
    if (first <= 0) return undefined;
    const second = step.indexOf(":", first + 1);
    const stage = step.slice(0, first);
    const result = second === -1 ? step.slice(first + 1) : step.slice(first + 1, second);
    if (!STAGE_SET.has(stage) || !STEP_RESULTS.has(result)) return undefined;
    const code = second === -1 ? undefined : cleanIncidentCode(step.slice(second + 1));
    return code === undefined ? `${stage}:${result}` : `${stage}:${result}:${code}`;
}

/** Stable code for how the attempt ended. HTTP statuses appear only when observed; a terminal reason never implies one. */
export function playbackErrorCode(error: PlaybackError, trace: PlaybackAttemptTrace): string {
    const http = httpStatus(trace.http);
    switch (error.kind) {
        case "terminal": return FAILURE_CODES.has(error.reason) ? error.reason : "terminal_error";
        case "server": {
            const reason = error.reason;
            if (reason !== undefined && "update" in reason) return "client_upgrade_required";
            if (reason !== undefined && "status" in reason && httpStatus(reason.status) !== undefined) return `http_${reason.status}`;
            return http === undefined ? "server_error" : `http_${http}`;
        }
        case "session_expired": return http === undefined ? "session_missing" : `http_${http}`;
        case "playback_failed": return cleanAvplayError(trace.lastAvplay) ?? cleanIncidentCode(trace.first?.code) ?? "routes_exhausted";
        case "network": return error.noResponse === true ? "no_response" : "network_unreachable";
        default: return error.kind;
    }
}

export function playbackOutcome(error: PlaybackError | undefined): IncidentOutcome {
    if (error === undefined) return "recovered";
    switch (error.kind) {
        case "terminal": return EXPECTED_REFUSALS.has(error.reason) ? "refused" : "failed";
        case "server": return error.reason !== undefined && "update" in error.reason ? "refused" : "failed";
        case "unavailable":
        case "settings": return "refused";
        case "backgrounded":
        case "revoked":
        case "installation_changed": return "interrupted";
        default: return "failed";
    }
}

/**
 * Opt-in filing applies only to a technical failure that ended the requested playback after applicable recovery.
 * A connectivity failure files only when the reconnect loop ran out; ordinary loss of network stays manual.
 */
export function incidentAutoEligible(incident: DiagnosticsIncidentPayload): boolean {
    return incident.out === "failed" && (incident.kind !== "network" || incident.rec.r === "exhausted");
}

/**
 * Builds the public incident from one attempt's trace at capture time. Returns undefined when nothing
 * failed. `error` undefined with a recorded failure means the attempt recovered.
 */
export function playbackIncident(trace: PlaybackAttemptTrace, error?: PlaybackError): DiagnosticsIncidentPayload | undefined {
    if (error === undefined && (trace.first === undefined || !trace.recovered)) return undefined;
    const out = playbackOutcome(error);
    const finalCode = error === undefined ? undefined : playbackErrorCode(error, trace);
    const firstStage = trace.first?.stage ?? trace.stage;
    // The first failure carries its own code; when it is the ending failure, the ending code names it.
    const firstCode = cleanIncidentCode(trace.first?.code) ?? (firstStage === trace.stage ? finalCode : undefined);
    const http = httpStatus(trace.http);
    const firstAv = cleanAvplayError(trace.firstAvplay);
    const lastAv = cleanAvplayError(trace.lastAvplay);
    const fallbacks = count(trace.fallbacks);
    const reconnects = count(trace.reconnects);
    // The route budget and the reconnect loop are per attempt, so either can be spent before this chain's first fallback.
    const recovery: IncidentRecovery = error === undefined
        ? "recovered"
        : trace.exhausted
            ? "exhausted"
            : fallbacks + reconnects + trace.resends === 0 ? "none" : "attempted";
    const plan = trace.plan;
    const dl = plan === undefined ? undefined : DELIVERIES.has(plan.delivery) ? plan.delivery : "unknown";
    const pr = publicMediaToken(plan?.protocol, PROTOCOLS);
    const ct = publicMediaToken(plan?.container, CONTAINERS);
    const q = publicMediaToken(plan?.quality, QUALITIES);
    const kbps = plan?.sourceKbps !== undefined && Number.isFinite(plan.sourceKbps) && plan.sourceKbps > 0 ? Math.min(Math.round(plan.sourceKbps), 1_000_000) : undefined;
    const vc = publicMediaToken(plan?.videoCodec, VIDEO_CODECS);
    const res = plan?.width !== undefined && plan.height !== undefined && Number.isInteger(plan.width) && Number.isInteger(plan.height) && plan.width > 0 && plan.height > 0 && plan.width <= 16384 && plan.height <= 16384
        ? `${plan.width}x${plan.height}`
        : undefined;
    const dr = publicMediaToken(plan?.dynamicRange, DYNAMIC_RANGES);
    const settings = trace.settings;
    const settingQuality = settings === undefined ? undefined : publicMediaToken(settings.quality, QUALITIES) ?? "unknown";
    const cap = settings?.capKbps !== undefined && Number.isFinite(settings.capKbps) && settings.capKbps > 0 ? Math.min(Math.round(settings.capKbps), 1_000_000) : "none";
    const requestPos = seconds(trace.request.startSeconds);
    const steps = trace.steps.map(cleanTraceStep).filter((step): step is string => step !== undefined).slice(-MAX_STEPS);
    return {
        iv: 1,
        cat: trace.first?.buffering === true ? "buffering" : "playback",
        out,
        ...(error === undefined ? {} : { kind: error.kind }),
        op: STAGE_OPERATION[firstStage],
        stage: firstStage,
        ...(firstCode === undefined ? {} : { code: firstCode }),
        ...(error === undefined ? {} : { fs: trace.stage }),
        ...(finalCode === undefined ? {} : { fc: finalCode }),
        done: trace.done ?? "none",
        ...(trace.decision === undefined ? {} : { dec: trace.decision }),
        ...(http === undefined ? {} : { http }),
        ...(error?.kind === "terminal" ? { rt: error.retryable } : {}),
        ...(firstAv === undefined && lastAv === undefined ? {} : { av: { ...(firstAv === undefined ? {} : { f: firstAv }), ...(lastAv === undefined ? {} : { l: lastAv }) } }),
        open: trace.opened,
        shown: trace.shown,
        rs: count(trace.resends),
        rec: { n: fallbacks, c: reconnects, r: recovery },
        pl: plan === undefined || dl === undefined ? "not_reached" : {
            dl,
            ...(pr === undefined ? {} : { pr }),
            ...(ct === undefined ? {} : { ct }),
            ...(q === undefined ? {} : { q }),
            ...(kbps === undefined ? {} : { kbps }),
            ...(vc === undefined ? {} : { vc }),
            ...(res === undefined ? {} : { res }),
            ...(dr === undefined ? {} : { dr }),
            pos: seconds(plan.startSeconds) ?? 0,
            at: seconds(plan.atSeconds) ?? 0,
        },
        set: settings === undefined || settingQuality === undefined ? "not_reached" : { q: settingQuality, cap, hdr: settings.hdr },
        hp: trace.hdrPanel === "unavailable" ? "unavailable" : { h10: trace.hdrPanel.hdr10, hlg: trace.hdrPanel.hlg, dv: trace.hdrPanel.dolbyVision },
        req: { pos: requestPos ?? "none", sub: trace.request.subtitle, aud: trace.request.audio },
        t: steps,
    };
}

/** Canonical grouping input shared with the relay: no counters, positions or submission source. */
export function incidentGroupKey(appVersion: string, tvModel: string, incident: DiagnosticsIncidentPayload): string {
    return ["inc1", appVersion, tvModel, incident.cat, incident.op, incident.stage, incident.code ?? ""].join("\n");
}
