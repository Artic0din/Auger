import { PROTOCOLS, CONTAINERS, VIDEO_CODECS, DYNAMIC_RANGES, AUDIO_CODECS, SUBTITLE_CODECS, LANGUAGE_PATTERN } from "../../shared/diagnostics-media.js";
export { PROTOCOLS, CONTAINERS, VIDEO_CODECS, DYNAMIC_RANGES, AUDIO_CODECS, SUBTITLE_CODECS, LANGUAGE_PATTERN };

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
  "caption_load", "audio_switch", "subtitle_switch",
];

/** Client PlaybackOperation. */
export const PLAYBACK_OPERATIONS = [
  "playback_capabilities", "playback_defaults", "start_playback", "subtitle_preferences", "media_token",
  "hls_playlist", "avplay", "replan_playback", "progress_report", "subtitle_download",
];

export const STEP_RESULTS = ["ok", "fail", "retry", "fallback", "recovered", "refused", "end"];
export const INCIDENT_OUTCOMES = ["failed", "refused", "interrupted", "recovered"];
export const INCIDENT_CATEGORIES = ["playback", "buffering", "audio_subtitles"];
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
  // Audio and subtitle failures (client mediaIncident).
  "caption_load_failed", "audio_track_switch_failed", "subtitle_track_switch_failed",
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

export const BUFFERING_MODES = ["never", "ask", "always"];
export const LEARNED_LIMIT_STATES = ["unsupported", "ignored", "server", "cleared"];
export const NETWORK_TYPES = ["wifi", "ethernet", "cellular", "other", "unavailable"];
export const CONNECTION_CLASSES = ["slow-2g", "2g", "3g", "4g", "unavailable"];
export const SPEED_STATES = ["unsupported", "offline", "metered", "none"];
export const STEP_DOWN_REASONS = ["auto", "prompt", "restore"];
export const STEP_DOWN_OUTCOMES = ["pending", "adopted", "not_adopted", "not_sent"];
const KBPS = int(1, 1_000_000);
const STALL_MS = int(0, 600_000);
const QUALITY = { kind: "pattern", re: QUALITY_PATTERN };
const list = (of, max) => ({ kind: "list", of, max });

/** The declared `bq` (bv 1) Buffering / Quality evidence, mirroring the client's src/diagnosticsBuffering.ts. */
export const BUFFERING_CONTRACT = Object.freeze({
  bv: required(literal(1)),
  md: required(enumOf(BUFFERING_MODES)),
  adv: bool,
  q: QUALITY,
  mc: either(KBPS, literal("none")),
  ll: enumOf(LEARNED_LIMIT_STATES),
  pq: QUALITY,
  pk: KBPS,
  sk: KBPS,
  ok: KBPS,
  est: KBPS,
  net: object({ t: required(enumOf(NETWORK_TYPES)), ec: enumOf(CONNECTION_CLASSES), on: bool }),
  spd: either(enumOf(SPEED_STATES), object({ kbps: required(KBPS), src: required(enumOf(["probe", "sample"])), age: required(int(0, 2_592_000)), fresh: required(bool) })),
  st: object({ n: required(COUNT), d: list(STALL_MS, 8), lg: STALL_MS }),
  sd: list(object({ r: required(enumOf(STEP_DOWN_REASONS)), fq: QUALITY, fk: KBPS, tq: QUALITY, tk: KBPS, est: KBPS, thr: KBPS, o: required(enumOf(STEP_DOWN_OUTCOMES)) }), 4),
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
    case "list":
      return Array.isArray(raw) ? raw.slice(-spec.max).map((item) => validateValue(spec.of, item)).filter((item) => item !== undefined) : undefined;
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

// Declared audio/subtitle record (`md`, mv 1), mirroring the client's publicMediaEvidence. Never carries a track name,
// label or cue text: tracks are described only by language code, codec, channels, enumerated flags, source and delivery.
export const SUBTITLE_MODES = ["off", "render", "convert", "burn_in", "unknown"];
export const SUBTITLE_SOURCES = ["external", "embedded", "downloaded", "unknown"];
export const SUBTITLE_DELIVERIES = ["sidecar", "burn_in_only", "unknown"];
export const SUBTITLE_DRAWERS = ["overlay", "avplay", "burn_in", "none"];
export const CAPTION_LOAD_STATES = ["not_needed", "loading", "loaded", "failed", "fallback"];
export const SWITCH_RESULTS = ["pending", "ok", "refused", "failed", "recovered"];
const LANGUAGE = { kind: "pattern", re: LANGUAGE_PATTERN };
const AUDIO_FORMAT = either(literal("unavailable"), object({ c: enumOf(AUDIO_CODECS), ch: int(1, 16) }));

export const MEDIA_CONTRACT = Object.freeze({
  mv: required(literal(1)),
  a: object({ lang: LANGUAGE, src: AUDIO_FORMAT, pl: AUDIO_FORMAT, obs: AUDIO_FORMAT }),
  s: object({
    mode: required(enumOf(SUBTITLE_MODES)),
    src: enumOf(SUBTITLE_SOURCES),
    c: enumOf(SUBTITLE_CODECS),
    dl: enumOf(SUBTITLE_DELIVERIES),
    lang: LANGUAGE,
    f: bool,
    hi: bool,
    via: required(enumOf(SUBTITLE_DRAWERS)),
    ld: required(enumOf(CAPTION_LOAD_STATES)),
    cues: int(0, 100_000),
    sync: int(-600_000, 600_000),
    sec: bool,
  }),
  sw: object({ k: required(enumOf(["audio", "subtitle"])), r: required(enumOf(SWITCH_RESULTS)), code: { kind: "code" } }),
});

/** Validates `md`; undefined when absent, malformed or carrying neither audio nor subtitle evidence. */
export function validateMedia(raw) {
  if (!isPlainObject(raw)) return undefined;
  const checked = validateFields(MEDIA_CONTRACT, raw);
  if (checked.missing.length > 0 || (checked.value.a === undefined && checked.value.s === undefined)) return undefined;
  return checked.value;
}

/** Validates `inc`, returning `{ incident }` or `{ error, missing }`. */
export function validateIncident(raw) {
  if (!isPlainObject(raw)) return { error: "invalid_payload", missing: ["inc"] };
  const checked = validateFields(INCIDENT_CONTRACT, raw);
  if (checked.missing.length > 0) return { error: "invalid_payload", missing: checked.missing.map((key) => `inc.${key}`) };
  return { incident: checked.value };
}

/** Validated `bq`, or undefined when absent or invalid: the evidence is optional and never rejects a report. */
export function validateBuffering(raw) {
  if (!isPlainObject(raw)) return undefined;
  const checked = validateFields(BUFFERING_CONTRACT, raw);
  return checked.missing.length > 0 ? undefined : checked.value;
}

/** Client incidentAutoEligible: only a technical failure that ended playback after recovery files automatically. */
export function incidentAutoEligible(incident) {
  return incident.out === "failed" && (incident.kind !== "network" || (incident.rec?.r === "exhausted" && incident.http !== undefined));
}
