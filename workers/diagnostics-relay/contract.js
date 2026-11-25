// Declared incident contract (`inc`, iv 1) carried inside the v1 payload, mirroring the client's
// src/diagnosticsIncident.ts. Every public value is an enum, bounded integer, boolean, allowlisted code or
// anchored pattern. Unknown keys are discarded, invalid optional values dropped, invalid required values reject.

export const CATEGORY_IDS = ["playback", "audio_subtitles", "buffering", "app_ui"];

export const CATEGORY_LABELS = {
  playback: "Playback failed",
  audio_subtitles: "Audio / Subtitles",
  buffering: "Buffering / Quality",
  app_ui: "App / Navigation",
};

/** Documented Samsung Tizen AVPlayError enum names (explicit allowlist; no wildcard regex). */
export const AVPLAY_ERROR_CODES = [
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
];

export const APP_ERROR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "NotAllowedError",
  "NotSupportedError",
  "QuotaExceededError",
  "SecurityError",
  "NetworkError",
  "TimeoutError",
  "DataCloneError",
  "InvalidStateError",
  "UncaughtError",
  "UnhandledRejection",
];

const AVPLAY_STAGES = new Set(["prepareAsync", "open", "play", "seekTo"]);
const AVPLAY_EXCEPTIONS = new Set([
  ...APP_ERROR_NAMES,
  "WebAPIException",
  "InvalidAccessError",
  "InvalidValuesError",
  "NotFoundError",
  "UnknownError",
  "OperationNotSupportedError",
  "failed",
  "error",
]);
const AVPLAY_CODE_SET = new Set(AVPLAY_ERROR_CODES);

/** `PLAYER_ERROR_*`, `startup_timeout`, or `<stage>:<ExceptionName>`; unknown exception names collapse to `<stage>:error`. */
export function sanitizeAvplayError(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "startup_timeout" || AVPLAY_CODE_SET.has(trimmed)) return trimmed;
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return undefined;
  const stage = trimmed.slice(0, colon);
  if (!AVPLAY_STAGES.has(stage)) return undefined;
  const name = trimmed.slice(colon + 1);
  return AVPLAY_EXCEPTIONS.has(name) ? `${stage}:${name}` : `${stage}:error`;
}

/** Client PLAYBACK_STAGES, in order. */
export const PLAYBACK_STAGES = [
  "capabilities", "settings", "start", "subtitles", "media_token", "playlist_check",
  "avplay_open", "avplay_prepare", "avplay_seek", "avplay_play", "playing",
  "recovery", "reconnect", "track_change", "quality_change", "seek_reanchor", "progress",
];

/** Client PlaybackOperation. */
export const PLAYBACK_OPERATIONS = [
  "playback_capabilities", "playback_defaults", "start_playback", "subtitle_preferences", "media_token",
  "hls_playlist", "avplay", "replan_playback", "progress_report",
];

export const STEP_RESULTS = ["ok", "fail", "retry", "fallback", "recovered", "refused", "end"];
export const INCIDENT_OUTCOMES = ["failed", "refused", "interrupted", "recovered"];
export const INCIDENT_CATEGORIES = ["playback", "buffering"];
export const RECOVERY_STATES = ["none", "recovered", "attempted", "exhausted"];
/** Client PlaybackError["kind"]. */
export const ERROR_KINDS = [
  "settings", "unavailable", "terminal", "playback_failed", "network", "session_expired",
  "installation_changed", "revoked", "backgrounded", "server",
];
/** Known route before Settings opened, for user-observed reports. */
export const PRECEDING_SCREENS = ["home", "details", "library", "search", "person", "calendar", "requests", "audiobook", "personal", "watchParty", "for_you"];
export const DELIVERIES = ["original_http", "server_remux_progressive", "server_remux_hls", "server_transcode_hls", "unknown"];

/**
 * Codes the relay publishes verbatim. Any other lowercase snake_case code the client allows still groups (the client
 * hashes it too), but renders as "unlisted code": server-defined reasons are not trusted to be free of user text.
 */
export const PUBLISHED_CODES = [
  // Client-derived ending codes (playbackErrorCode) and trace failure codes (controller).
  "terminal_error", "client_upgrade_required", "server_error", "session_missing", "routes_exhausted", "no_response",
  "network_unreachable", "no_answer", "hls_playlist_unreadable", "connection_lost", "avplay_prepare_failed",
  "avplay_open_failed", "avplay_play_failed", "avplay_resume_seek_failed", "avplay_playback_error", "avplay_startup_timeout",
  ...ERROR_KINDS,
  // Server terminal reasons seen by Auger.
  "session_expired", "adaptation_unavailable", "version_unavailable", "subtitle_selection_unavailable",
];
const PUBLISHED_CODE_SET = new Set(PUBLISHED_CODES);
const CLIENT_CODE = /^[a-z0-9_]{1,48}$/;
const HTTP_CODE = /^http_[1-5]\d\d$/;

/** Client cleanIncidentCode: an AVPlay code or lowercase snake_case; anything else is dropped. */
export function incidentCode(raw) {
  if (typeof raw !== "string") return undefined;
  return sanitizeAvplayError(raw) ?? (CLIENT_CODE.test(raw) ? raw : undefined);
}

/** Whether a validated code may appear in public text. */
export function isPublishedCode(code) {
  return typeof code === "string" && (PUBLISHED_CODE_SET.has(code) || HTTP_CODE.test(code) || sanitizeAvplayError(code) === code);
}

const STAGE_SET = new Set(PLAYBACK_STAGES);
const RESULT_SET = new Set(STEP_RESULTS);

/** Client cleanTraceStep: `stage:result[:code]`, dropping an invalid code and an invalid step. */
export function traceStep(raw) {
  if (typeof raw !== "string" || raw.length > 80) return undefined;
  const first = raw.indexOf(":");
  if (first <= 0) return undefined;
  const second = raw.indexOf(":", first + 1);
  const stage = raw.slice(0, first);
  const result = second === -1 ? raw.slice(first + 1) : raw.slice(first + 1, second);
  if (!STAGE_SET.has(stage) || !RESULT_SET.has(result)) return undefined;
  const code = second === -1 ? undefined : incidentCode(raw.slice(second + 1));
  return code === undefined ? `${stage}:${result}` : `${stage}:${result}:${code}`;
}

// Plan and settings tokens: the client accepts any short lowercase token; the relay publishes known values only.
export const PROTOCOLS = ["http", "http_progressive", "hls", "dash"];
export const CONTAINERS = ["mkv", "matroska", "mp4", "m4v", "mov", "quicktime", "ts", "mpegts", "mpeg-ts", "m2ts", "avi", "webm", "fmp4", "hls"];
export const VIDEO_CODECS = ["h264", "avc", "avc1", "hevc", "h265", "hvc1", "hev1", "av1", "av01", "vp9", "vp09", "vp8", "mpeg2", "mpeg2video", "mpeg4", "vc1"];
export const DYNAMIC_RANGES = ["sdr", "hdr10", "hdr10_plus", "hdr10+", "hlg", "dolby_vision"];
const QUALITY_PATTERN = /^(?:\d{3,4}p|[48]k|original|auto|source|unknown)$/;

export const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[0-9A-Za-z]{1,12}(?:\.[0-9A-Za-z]{1,12}){0,2})?$/;
// Consumer model codes start with a product/market prefix and panel size.
export const MODEL_PATTERN = /^(?:[QUGKLP][A-Z]\d{2,3}[A-Z][A-Z0-9]{2,14}|S\d{2}[A-Z]|[A-Z]{1,2}\d{4})$/;
// Firmware/software version, e.g. 1650 or T-KTSUDEUC-1650.1; a separator is required so a serial number cannot pass.
export const FIRMWARE_PATTERN = /^(?:\d{1,8}(?:\.\d{1,4}){0,3}|[A-Z0-9]{1,4}-[A-Z0-9]{2,12}-\d{1,6}(?:\.\d{1,4}){0,2})$/;
// Silo build, e.g. 412, 0.9.3 or "412 · 1a2b3c4d". A leading digit blocks hostnames; IPv4 is rejected separately.
export const SERVER_VERSION_PATTERN = /^v?\d{1,6}(?:\.\d{1,6}){0,2}(?:-[0-9A-Za-z]{1,12})?(?: · [0-9a-f]{7,12})?$/;
const IPV4_LIKE = /^v?\d{1,3}(?:\.\d{1,3}){3}$/;

export function matchServerVersion(raw) {
  return typeof raw === "string" && SERVER_VERSION_PATTERN.test(raw) && !IPV4_LIKE.test(raw.split(" ")[0] ?? "") ? raw : undefined;
}

const enumOf = (values) => ({ kind: "enum", values });
const int = (min, max) => ({ kind: "int", min, max });
const bool = { kind: "bool" };
const literal = (value) => ({ kind: "literal", value });
const either = (...options) => ({ kind: "either", options });
const object = (fields) => ({ kind: "object", fields });
const required = (spec) => ({ ...spec, required: true });
const SECONDS = int(0, 360000);
const COUNT = int(0, 99);

/**
 * The declared `inc` contract. Parent integration reconciles the client serializer against this object;
 * `required` keys reject the report when absent or invalid.
 */
export const INCIDENT_CONTRACT = Object.freeze({
  iv: required(literal(1)),
  cat: required(enumOf(INCIDENT_CATEGORIES)),
  src: enumOf(["manual", "auto"]),
  out: required(enumOf(INCIDENT_OUTCOMES)),
  kind: enumOf(ERROR_KINDS),
  op: enumOf(PLAYBACK_OPERATIONS),
  stage: enumOf(PLAYBACK_STAGES),
  code: { kind: "code" },
  fs: enumOf(PLAYBACK_STAGES),
  fc: { kind: "code" },
  done: either(enumOf(PLAYBACK_STAGES), literal("none")),
  dec: enumOf(["adaptation_unavailable", "unknown"]),
  http: int(100, 599),
  rt: bool,
  av: object({ f: { kind: "avplay" }, l: { kind: "avplay" } }),
  open: bool,
  shown: bool,
  rs: COUNT,
  rec: object({ n: COUNT, c: COUNT, r: enumOf(RECOVERY_STATES) }),
  pl: either(literal("not_reached"), object({
    dl: required(enumOf(DELIVERIES)),
    pr: enumOf(PROTOCOLS),
    ct: enumOf(CONTAINERS),
    q: { kind: "pattern", re: QUALITY_PATTERN },
    kbps: int(1, 1_000_000),
    vc: enumOf(VIDEO_CODECS),
    res: { kind: "pattern", re: /^\d{1,5}x\d{1,5}$/ },
    dr: enumOf(DYNAMIC_RANGES),
    pos: SECONDS,
    at: SECONDS,
  })),
  set: either(literal("not_reached"), object({ q: { kind: "pattern", re: QUALITY_PATTERN }, cap: either(int(1, 1_000_000), literal("none")), hdr: bool })),
  // Panel capability may be omitted or unknown on TVs without the API; never inferred from the HDR setting.
  hp: either(enumOf(["unknown", "unavailable"]), object({ h10: bool, hlg: bool, dv: bool })),
  req: object({ pos: either(SECONDS, literal("none")), sub: enumOf(["auto", "off", "track"]), aud: enumOf(["default", "track"]) }),
  t: { kind: "steps", max: 16 },
});

function validateValue(spec, raw) {
  switch (spec.kind) {
    case "enum":
      return typeof raw === "string" && spec.values.includes(raw) ? raw : undefined;
    case "int":
      return typeof raw === "number" && Number.isInteger(raw) && raw >= spec.min && raw <= spec.max ? raw : undefined;
    case "bool":
      return typeof raw === "boolean" ? raw : undefined;
    case "literal":
      return raw === spec.value ? raw : undefined;
    case "pattern":
      return typeof raw === "string" && spec.re.test(raw) ? raw : undefined;
    case "code":
      return incidentCode(raw);
    case "avplay":
      return sanitizeAvplayError(raw);
    case "either":
      for (const option of spec.options) {
        const value = validateValue(option, raw);
        if (value !== undefined) return value;
      }
      return undefined;
    case "object": {
      if (!isPlainObject(raw)) return undefined;
      const checked = validateFields(spec.fields, raw);
      return checked.missing.length > 0 || Object.keys(checked.value).length === 0 ? undefined : checked.value;
    }
    case "steps":
      return Array.isArray(raw) ? raw.slice(-spec.max).map(traceStep).filter((step) => step !== undefined) : undefined;
    default:
      return undefined;
  }
}

export function isPlainObject(raw) {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** Copies only declared keys; `missing` lists required keys that were absent or invalid. */
export function validateFields(fields, raw) {
  const value = {};
  const missing = [];
  for (const [key, spec] of Object.entries(fields)) {
    const next = validateValue(spec, raw[key]);
    if (next === undefined) {
      if (spec.required) missing.push(key);
    } else {
      value[key] = next;
    }
  }
  return { value, missing };
}

/** Validates `inc`, returning `{ incident }` or `{ error, missing }`. */
export function validateIncident(raw) {
  if (!isPlainObject(raw)) return { error: "invalid_payload", missing: ["inc"] };
  const checked = validateFields(INCIDENT_CONTRACT, raw);
  if (checked.missing.length > 0) return { error: "invalid_payload", missing: checked.missing.map((key) => `inc.${key}`) };
  return { incident: checked.value };
}

/** Client incidentAutoEligible: only a technical failure that ended playback after recovery files automatically. */
export function incidentAutoEligible(incident) {
  return incident.out === "failed" && (incident.kind !== "network" || incident.rec?.r === "exhausted");
}
