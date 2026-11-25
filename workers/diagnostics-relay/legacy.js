// v1 (installed-client) report intake. Old clients send redacted free text; the relay republishes only
// values it recognizes field by field. Unrecognized text is discarded, never truncated into the issue.
// The legacy grouping fingerprint is still computed exactly as before so old clients keep matching their open issues.

import {
  APP_ERROR_NAMES,
  CATEGORY_IDS,
  FIRMWARE_PATTERN,
  incidentAutoEligible,
  isPlainObject,
  isPublishedCode,
  matchServerVersion,
  MODEL_PATTERN,
  PRECEDING_SCREENS,
  sanitizeAvplayError,
  validateIncident,
  VERSION_PATTERN,
} from "./contract.js";
import { legacyEquivalent } from "./grouping.js";
import { fnv1aHex } from "./hash.js";

export { fnv1aHex };

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const QUERY_PATTERN = /\?[^\s"'<>]+/g;
const SECRET_ASSIGN_PATTERN = /\b(?:bearer|token|api[_-]?key|password|passwd|secret|authorization|cookie)\s*[:=]\s*\S+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{28,}\b/g;

/** The deployed relay's redactor. Kept only so legacy fingerprints stay byte-identical; its output is never published. */
export function sanitize(raw, maxLength = 140) {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(URL_PATTERN, "<url>")
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SECRET_ASSIGN_PATTERN, "<redacted>")
    .replace(IPV4_PATTERN, "<ip>")
    .replace(QUERY_PATTERN, "")
    .replace(LONG_TOKEN_PATTERN, "<redacted>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

const APP_ERROR_SET = new Set(APP_ERROR_NAMES);
const nonNegInt = (raw, max) => (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= max ? raw : undefined);
const oneOf = (values) => {
  const set = new Set(values);
  return (raw) => (typeof raw === "string" && set.has(raw) ? raw : undefined);
};
const anchored = (re) => (raw) => (typeof raw === "string" && re.test(raw) ? raw : undefined);
const tokens = (tests) => (raw) => {
  if (typeof raw !== "string" || raw.length > 140) return undefined;
  const parts = raw.split(" · ");
  return parts.every((part) => tests.some((check) => check(part))) ? raw : undefined;
};

const CONTAINER_TOKENS = ["MKV", "MATROSKA", "MP4", "M4V", "MOV", "QUICKTIME", "TS", "MPEGTS", "MPEG-TS", "M2TS", "AVI", "WEBM", "FMP4"];
const CODEC_TOKENS = ["HEVC", "H265", "H.265", "HVC1", "HEV1", "H264", "H.264", "AVC", "AVC1", "AVC3", "AV1", "AV01", "VP9", "VP09", "VP8", "MPEG2", "MPEG-2", "MPEG2VIDEO", "MPEG4", "MPEG-4", "VC1", "VC-1"];
const RANGE_TOKENS = ["SDR", "HDR10", "HDR10+", "HDR10_PLUS", "HDR10PLUS", "HLG", "DOLBY_VISION", "Dolby Vision"];
const containerToken = oneOf(CONTAINER_TOKENS);
const codecToken = oneOf(CODEC_TOKENS);
const rangeToken = (part) => oneOf(RANGE_TOKENS)(part) ?? anchored(/^(?:DV P\d{1,2}|Dolby Vision Profile \d{1,2})$/)(part);
const bitrateToken = anchored(/^\d{1,6}(?:\.\d)? (?:Mbps|Kbps)$/);
const clock = String.raw`\d{1,3}(?::\d{2}){1,2}`;
const durationToken = anchored(new RegExp(String.raw`^(?:${clock}(?: \(~\d{1,5}(?:\.\d)? (?:GB|MB)\))?|~\d{1,5}(?:\.\d)? (?:GB|MB))$`));
const sourceVideoToken = (part) => {
  const [codec, ...rest] = part.split(" ");
  if (!codecToken(codec)) return false;
  return rest.every((piece) => /^\d{2,5}x\d{2,5}$/.test(piece) || /^\d{1,3}(?:\.\d{1,2})?fps$/.test(piece));
};
const hudVideoToken = (part) => codecToken(part) || /^\d{2,5}[×x]\d{2,5}$/.test(part) || /^\d{1,3}(?:\.\d{1,3})? fps$/.test(part) || Boolean(bitrateToken(part));

const RANGE_LABEL = String.raw`(?:SDR|HDR10\+?|HLG|Dolby Vision(?: Profile \d{1,2}(?:\.\d)?)?)`;

/** Field-by-field allowlist for v1 values, shared by intake and by rendering values read back from older issues. */
export const LEGACY_FIELD_CHECKS = {
  fw: anchored(FIRMWARE_PATTERN),
  os: anchored(/^Tizen \d{1,2}(?:\.\d{1,2}){0,2}$/),
  ua: anchored(/^Chrome\/\d{2,3}(?:\.\d{1,5}){0,3}$/),
  srv: matchServerVersion,
  mem: anchored(/^\d{1,6} \/ \d{1,6} MB(?: \(limit \d{1,6} MB\))?$/),
  ram: anchored(/^\d{1,4}(?:\.\d{1,2})? (?:GB|MB)$/),
  scr: anchored(/^\d{3,5}x\d{3,5}$/),
  cat: oneOf(CATEGORY_IDS),
  err: oneOf(APP_ERROR_NAMES),
  m: anchored(/^(?:Direct play|Direct Play|Direct stream|Remuxed|Remuxed by the server|Transcoded|Transcoded by the server)(?: · (?:MKV|MP4|M4V|MOV|MPEG-TS|TS|AVI|WEBM))?$/),
  d: oneOf(["Original", "Original HTTP", "Server Remux", "Server Remux HLS", "Server Transcode HLS"]),
  st: oneOf(["Playing", "Paused", "Rebuffering", "Reconnecting", "Seeking", "Stalled", "Ended", "Error", "Failed"]),
  dr: anchored(new RegExp(String.raw`^${RANGE_LABEL}(?: → (?:${RANGE_LABEL}|Profile 8\.1))?(?: \(unconfirmed\))?$`)),
  v: tokens([hudVideoToken]),
  src: tokens([containerToken, sourceVideoToken, rangeToken, bitrateToken, durationToken]),
  tr: tokens([oneOf(["HTTP", "HLS", "DASH"]), containerToken, anchored(/^(?:\d{3,4}p|4K|Original|Auto)$/)]),
  sub: (raw) => {
    if (raw === "off") return raw;
    if (typeof raw !== "string") return undefined;
    const [mode, rest, extra] = raw.split(" · ");
    if (extra !== undefined || !/^(?:render|convert|burn_in)$/.test(mode ?? "")) return undefined;
    if (rest === undefined) return raw;
    return /^(?:(?:embedded|external|downloaded|unknown)(?: (?:SRT|SUBRIP|ASS|SSA|VTT|WEBVTT|PGS|SUP|HDMV_PGS_SUBTITLE|VOBSUB|DVD_SUBTITLE|TX3G|MOV_TEXT))?)?(?: ?\((?:sidecar|burn_in_only|unknown)\))?$/.test(rest) && rest !== "" ? raw : undefined;
  },
  pos: anchored(new RegExp(String.raw`^${clock}(?: \/ ${clock})?$`)),
  rb: (raw) => nonNegInt(raw, 10000),
  fb: (raw) => nonNegInt(raw, 20),
  hdr: (raw) => (typeof raw === "boolean" ? raw : undefined),
  av: sanitizeAvplayError,
  e: parseLegacyError,
};

const LEGACY_KINDS = new Set([
  "settings",
  "unavailable",
  "terminal",
  "playback_failed",
  "network",
  "session_expired",
  "installation_changed",
  "revoked",
  "backgrounded",
  "server",
]);
const REASON_CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,6}$/;

/** Recognizes `<kind>` or `<kind>: <structured detail>` exactly as installed clients build it; anything else is dropped. */
export function parseLegacyError(raw) {
  if (typeof raw !== "string") return undefined;
  const match = /^([a-z_]{3,24})(?:: (.{1,48}))?$/.exec(raw.trim());
  if (!match || !LEGACY_KINDS.has(match[1])) return undefined;
  const kind = match[1];
  const detail = match[2];
  if (detail === undefined) return kind;
  // Server reasons print only when allowlisted; the deployed fingerprint still hashes the original text.
  if (kind === "terminal" && REASON_CODE.test(detail) && isPublishedCode(detail)) return `${kind}: ${detail}`;
  if (kind === "server" && /^(?:server_error|app_update_required|HTTP [1-5]\d\d)$/.test(detail)) return `${kind}: ${detail}`;
  return kind;
}

const LOG_LINE = /^(\d{2}:\d{2}:\d{2}) \[(playback|network|app)\] (.+)$/;

/** Rebuilds only recognized event lines: AVPlay codes, playback errors, rebuffers, plan summaries and app error names. */
export function parseLegacyLogLine(raw) {
  if (typeof raw !== "string" || raw.length > 200) return undefined;
  const match = LOG_LINE.exec(raw.trim());
  if (!match) return undefined;
  const [, at, kind, text] = match;
  const recognized = kind === "app" ? appEvent(text) : kind === "playback" ? playbackEvent(text) : undefined;
  return recognized === undefined ? undefined : `${at} [${kind}] ${recognized}`;
}

function appEvent(text) {
  const match = /^error ([A-Za-z]{2,32})$/.exec(text);
  return match && APP_ERROR_SET.has(match[1]) ? `error ${match[1]}` : undefined;
}

function playbackEvent(text) {
  const avplay = /^avplay (\S+)(?: \(fallback #(\d{1,2})\))?$/.exec(text);
  if (avplay) {
    const code = sanitizeAvplayError(avplay[1]);
    if (code === undefined || code !== avplay[1]) return undefined;
    if (avplay[2] === undefined) return `avplay ${code}`;
    const count = Number(avplay[2]);
    return count >= 1 && count <= 20 ? `avplay ${code} (fallback #${count})` : undefined;
  }
  const rebuffer = /^rebuffer #(\d{1,5})$/.exec(text);
  if (rebuffer) return `rebuffer #${Number(rebuffer[1])}`;
  const error = /^error (.+?)(?: \(([^()\s]+)\))?$/.exec(text);
  if (error) {
    const parsed = parseLegacyError(error[1]);
    if (parsed === undefined || parsed !== error[1]) return undefined;
    if (error[2] === undefined) return `error ${parsed}`;
    const code = sanitizeAvplayError(error[2]);
    return code === undefined || code !== error[2] ? undefined : `error ${parsed} (${code})`;
  }
  if (text.startsWith("plan ")) return planEvent(text.slice(5));
  return undefined;
}

function planEvent(summary) {
  const open = summary.indexOf(" (");
  if (open < 0) return LEGACY_FIELD_CHECKS.m(summary) ? `plan ${summary}` : undefined;
  const close = summary.indexOf(")", open);
  if (close < 0) return undefined;
  const method = summary.slice(0, open);
  const delivery = summary.slice(open + 2, close);
  const video = summary.slice(close + 1).trim();
  if (!LEGACY_FIELD_CHECKS.m(method) || !LEGACY_FIELD_CHECKS.d(delivery)) return undefined;
  if (video !== "" && !LEGACY_FIELD_CHECKS.v(video)) return undefined;
  return `plan ${summary}`;
}

const PLAY_KEYS = ["m", "v", "dr", "d", "st", "src", "tr", "sub", "pos", "rb", "hdr", "av", "fb", "e"];

/**
 * The deployed fingerprint over the deployed redactor's output, so old clients find the issues they already opened.
 * Hash input is never published; only the 32-bit digest appears in the marker.
 */
function legacyFingerprint(raw) {
  const play = isPlainObject(raw.play) ? raw.play : undefined;
  const e = sanitize(play?.e, 120);
  const av = sanitizeAvplayError(play?.av);
  const err = typeof raw.err === "string" && APP_ERROR_SET.has(raw.err) ? raw.err : undefined;
  const cat = typeof raw.cat === "string" && CATEGORY_IDS.includes(raw.cat) ? raw.cat : undefined;
  const playErr = e === undefined ? undefined : av && e === "playback_failed" ? `${e}:${av}` : e;
  const sig = err
    ? `app:${err}`
    : playErr ?? [cat ?? "", sanitize(play?.m, 64) ?? "", sanitize(play?.d, 48) ?? "", sanitize(play?.src, 110) ?? "", sanitize(play?.sub, 80) ?? ""].join("|");
  return { fingerprint: fnv1aHex([sanitize(raw.app, 32), sanitize(raw.tv, 48), sig].join("\n")), signatureDigest: fnv1aHex(sig) };
}

/**
 * Adds the validated incident and its grouping digests. Key text derived from raw app/model strings is hashed,
 * never stored, so it cannot reach public output.
 */
function attachIncident(record, raw) {
  const checked = validateIncident(raw.inc);
  if (checked.error) return checked;
  const inc = checked.incident;
  if ((raw.auto === true || inc.src === "auto") && !incidentAutoEligible(inc)) return { error: "not_auto_reportable" };
  const app = sanitize(raw.app, 32);
  const tv = sanitize(raw.tv, 48);
  // Client incidentGroupKey: first failed operation, stage and code; no counters, positions or source.
  const key = [inc.cat, inc.op ?? "", inc.stage ?? "", inc.code ?? ""];
  record.inc = inc;
  record.groupId = fnv1aHex(["inc1", app, tv, ...key].join("\n"));
  record.groupGuard = fnv1aHex(["guard", app, tv, ...key].join("\n"));
  const equivalent = legacyEquivalent(inc);
  if (equivalent !== undefined) {
    record.equivalent = {
      family: equivalent.family,
      signature: equivalent.signature,
      digest: fnv1aHex(equivalent.signature),
      fingerprint: fnv1aHex([app, tv, equivalent.signature].join("\n")),
    };
  }
  return undefined;
}

/** Validates a v1 report (with optional `inc`) into the internal record, or returns `{ error, missing? }`. */
export function validateV1(raw) {
  if (!isPlainObject(raw) || raw.v !== 1) return { error: "invalid_payload" };
  if (sanitize(raw.app, 32) === undefined || sanitize(raw.tv, 48) === undefined) return { error: "invalid_payload" };
  const record = {
    v: 1,
    app: raw.app === "unknown" || VERSION_PATTERN.test(raw.app) ? raw.app : "unknown",
    tv: MODEL_PATTERN.test(raw.tv) ? raw.tv : "Unknown model",
  };
  const legacy = legacyFingerprint(raw);
  record.legacyFingerprint = legacy.fingerprint;
  record.legacySignatureDigest = legacy.signatureDigest;
  if (raw.auto === true) record.auto = true;
  for (const key of ["cat", "err", "fw", "os", "ua", "srv", "mem", "ram", "scr"]) {
    const value = LEGACY_FIELD_CHECKS[key](raw[key]);
    if (value !== undefined) record[key] = value;
  }
  if (typeof raw.hdr === "boolean") record.hdr = raw.hdr;
  const up = nonNegInt(raw.up, 525600);
  if (up !== undefined) record.up = up;
  if (isPlainObject(raw.play)) {
    const play = {};
    for (const key of PLAY_KEYS) {
      const value = LEGACY_FIELD_CHECKS[key](raw.play[key]);
      if (value !== undefined) play[key] = value;
    }
    if (Object.keys(play).length > 0) record.play = play;
  }
  // Installed clients localize plan descriptions. The event prefix alone proves a plan was logged.
  if (Array.isArray(raw.log) && raw.log.some((line) => typeof line === "string" && /^\d{2}:\d{2}:\d{2} \[playback\] plan\b/.test(line))) {
    record.hadPlanEvent = true;
  }
  const log = Array.isArray(raw.log) ? raw.log.slice(0, 32).map(parseLegacyLogLine).filter(Boolean).slice(0, 12) : [];
  if (log.length > 0) record.log = log;
  const screen = oneOf(PRECEDING_SCREENS)(raw.precedingScreen);
  if (screen !== undefined) record.screen = screen;
  if (raw.inc !== undefined) {
    const failure = attachIncident(record, raw);
    if (failure) return failure;
  } else if (screen !== undefined && record.err === undefined && record.play?.e === undefined) {
    // A viewer-observed report from a known screen groups by category and screen, never by player free text.
    const key = [sanitize(raw.app, 32), sanitize(raw.tv, 48), record.cat ?? "", screen];
    record.observedGroupId = fnv1aHex(["obs1", ...key].join("\n"));
    record.observedGuard = fnv1aHex(["guard", ...key].join("\n"));
  }
  return { record };
}
