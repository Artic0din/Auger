import type { Clock } from "./api/clock.ts";
import { systemClock } from "./api/clock.ts";
import type { PlanSource } from "./contracts/v2/playback.ts";
import type { PlaybackStats } from "./player/playerHUD.ts";
import type { PublicStorage } from "./session/deviceIdentity.ts";

export const DIAGNOSTICS_REPORT_URL = "https://artic0din.github.io/Auger-Tizen/report/";
export const DIAGNOSTICS_RELAY_URL = "https://auger-diagnostics.plaintextlab.com/report";
export const GITHUB_BUG_REPORT_URL = "https://github.com/Artic0din/Auger-Tizen/issues/new";

const MAX_EVENTS = 12;
const MAX_EVENT_TEXT = 96;
const MAX_URL_LENGTH = 960;
const SEND_TIMEOUT_MS = 15000;
const AUTO_REPORT_KEY = "auger.diagnostics.autoReport";
const AUTO_SENT_KEY = "auger.diagnostics.autoSent";
const MAX_AUTO_SENT_ENTRIES = 24;
export const AUTO_REPORT_COOLDOWN_MS = 15 * 60 * 1000;

export type DiagnosticsCategory = "playback" | "audio_subtitles" | "buffering" | "app_ui";

export const DIAGNOSTICS_CATEGORIES: readonly { readonly id: DiagnosticsCategory; readonly label: string }[] = [
    { id: "playback", label: "Playback failed" },
    { id: "audio_subtitles", label: "Audio / Subtitles" },
    { id: "buffering", label: "Buffering / Quality" },
    { id: "app_ui", label: "App / Navigation" },
];

export function diagnosticsCategoryLabel(category: DiagnosticsCategory): string {
    return DIAGNOSTICS_CATEGORIES.find(entry => entry.id === category)?.label ?? category;
}

export type DiagnosticsSendStatus = "created" | "updated" | "duplicate";

export type DiagnosticsSendResult =
    | { readonly ok: true; readonly reportId: string; readonly issueNumber?: number | undefined; readonly status?: DiagnosticsSendStatus | undefined }
    | { readonly ok: false; readonly message: string };

export type DiagnosticsFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface DiagnosticsRuntimeEnvironment {
    readonly memory?: string | undefined;
    readonly deviceRam?: string | undefined;
    readonly screen?: string | undefined;
}

export interface DiagnosticsDeviceInfo {
    readonly appVersion: string;
    readonly tvModel: string;
    readonly firmware?: string | undefined;
    readonly tizenVersion?: string | undefined;
    readonly browser?: string | undefined;
    readonly hdrSupported?: boolean | undefined;
    readonly serverVersion?: string | undefined;
    readonly memory?: string | undefined;
    readonly deviceRam?: string | undefined;
    readonly screen?: string | undefined;
    readonly uptimeMinutes?: number | undefined;
}

export interface DiagnosticsPlanDetails {
    readonly source?: PlanSource | undefined;
    readonly sourceBitrateKbps?: number | undefined;
    readonly durationSeconds?: number | undefined;
    readonly streamProtocol?: string | undefined;
    readonly streamContainer?: string | undefined;
    readonly activeQuality?: string | undefined;
    readonly subtitleMode?: string | undefined;
    readonly subtitleSource?: string | undefined;
    readonly subtitleCodec?: string | undefined;
    readonly subtitleDelivery?: string | undefined;
    readonly positionSeconds?: number | undefined;
    readonly hdrEnabled?: boolean | undefined;
    readonly avplayError?: string | undefined;
    readonly routeFallbacks?: number | undefined;
}

export interface DiagnosticsPlayback {
    readonly playback?: string | undefined;
    readonly video?: string | undefined;
    readonly dynamicRange?: string | undefined;
    readonly audio?: string | undefined;
    readonly subtitles?: string | undefined;
    readonly delivery?: string | undefined;
    readonly status?: string | undefined;
    readonly source?: string | undefined;
    readonly stream?: string | undefined;
    readonly subtitleDetail?: string | undefined;
    readonly position?: string | undefined;
    readonly rebuffers?: number | undefined;
    readonly hdrEnabled?: boolean | undefined;
    readonly avplayError?: string | undefined;
    readonly routeFallbacks?: number | undefined;
    readonly diagnostics?: readonly string[] | undefined;
    readonly error?: string | undefined;
}

export interface DiagnosticsEvent {
    readonly at: string;
    readonly kind: "playback" | "network" | "app";
    readonly text: string;
}

export interface DiagnosticsSnapshot {
    readonly device: DiagnosticsDeviceInfo;
    readonly lastPlayback?: DiagnosticsPlayback | undefined;
    readonly lastAppError?: string | undefined;
    readonly events: readonly DiagnosticsEvent[];
}

export interface DiagnosticsPayloadPlayback {
    readonly m?: string;
    readonly v?: string;
    readonly dr?: string;
    readonly a?: string;
    readonly s?: string;
    readonly d?: string;
    readonly st?: string;
    readonly src?: string;
    readonly tr?: string;
    readonly sub?: string;
    readonly pos?: string;
    readonly rb?: number;
    readonly hdr?: boolean;
    readonly av?: string;
    readonly fb?: number;
    readonly n?: readonly string[];
    readonly e?: string;
}

export interface DiagnosticsPayloadV1 {
    readonly v: 1;
    readonly app: string;
    readonly tv: string;
    readonly cat?: DiagnosticsCategory;
    readonly auto?: true;
    readonly err?: string;
    readonly fw?: string;
    readonly os?: string;
    readonly ua?: string;
    readonly hdr?: boolean;
    readonly srv?: string;
    readonly mem?: string;
    readonly ram?: string;
    readonly scr?: string;
    readonly up?: number;
    readonly play?: DiagnosticsPayloadPlayback;
    readonly log?: readonly string[];
}

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const QUERY_PATTERN = /\?[^\s"'<>]+/g;
const SECRET_ASSIGN_PATTERN = /\b(?:bearer|token|api[_-]?key|password|passwd|secret|authorization|cookie)\s*[:=]\s*\S+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{28,}\b/g;

/** Removes URLs, IP addresses, query strings, and token-like secrets before any diagnostic text is stored or shared. */
export function redactDiagnosticText(raw: string, maxLength = 160): string {
    const cleaned = raw
        .replace(URL_PATTERN, "<url>")
        .replace(BEARER_PATTERN, "Bearer <redacted>")
        .replace(SECRET_ASSIGN_PATTERN, "<redacted>")
        .replace(IPV4_PATTERN, "<ip>")
        .replace(QUERY_PATTERN, "")
        .replace(LONG_TOKEN_PATTERN, "<redacted>")
        .replace(/\s+/g, " ")
        .trim();
    return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

/** Documented Samsung Tizen AVPlayError enum names (explicit allowlist; no wildcard regex). */
const ALLOWED_AVPLAY_ERROR_CODES = new Set([
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
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "AggregateError",
    "DOMException",
    "WebAPIException",
    "AbortError",
    "NotAllowedError",
    "NotSupportedError",
    "QuotaExceededError",
    "SecurityError",
    "NetworkError",
    "TimeoutError",
    "DataCloneError",
    "InvalidAccessError",
    "InvalidStateError",
    "InvalidValuesError",
    "NotFoundError",
    "UnknownError",
    "OperationNotSupportedError",
    "failed",
    "error",
]);

function cleanAvplayError(value: string | undefined): string | undefined {
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

const TRUSTED_AVPLAY_EVENT_PATTERN = /^(avplay |error [A-Za-z0-9_.: -]+ \()(PLAYER_ERROR_[A-Z_]+)(?:(\))| \(fallback #(\d{1,2})\))?$/;

function formatEventText(text: string, maxLength: number): string {
    const match = TRUSTED_AVPLAY_EVENT_PATTERN.exec(text);
    const code = match?.[2];
    if (match !== null && code !== undefined && ALLOWED_AVPLAY_ERROR_CODES.has(code)) {
        const prefix = match[1] ?? "";
        const closeParen = match[3] ?? "";
        const fallbackDigits = match[4];
        let suffix = closeParen;
        if (fallbackDigits !== undefined) {
            const count = Number(fallbackDigits);
            if (!Number.isInteger(count) || count < 1 || count > 20) return redactDiagnosticText(text, maxLength);
            suffix = ` (fallback #${count})`;
        }
        const safePrefix = redactDiagnosticText(prefix.trimEnd(), maxLength);
        const spacer = prefix.endsWith(" ") ? " " : "";
        const rebuilt = `${safePrefix}${spacer}${code}${suffix}`;
        return rebuilt.length <= maxLength ? rebuilt : `${rebuilt.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    }
    return redactDiagnosticText(text, maxLength);
}

function cleanOptional(value: string | undefined, maxLength = 80): string | undefined {
    if (value === undefined) return undefined;
    const redacted = redactDiagnosticText(value, maxLength);
    return redacted === "" ? undefined : redacted;
}

function localTime(nowMs: number): string {
    const date = new Date(nowMs);
    const pad = (value: number): string => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Deterministic 8-hex FNV-1a digest for local snapshot dedup and failure fingerprinting (non-cryptographic). */
export function fnv1aHex(input: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function encodeBase64Url(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(encoded: string): string | undefined {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
    try {
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return undefined;
    }
}

function readObjectProperty(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function formatMb(bytes: number): number {
    return Math.max(0, Math.round(bytes / (1024 * 1024)));
}

/** Reads zero-privilege runtime memory and display metrics exposed by Chromium on Tizen. */
export function readRuntimeEnvironment(): DiagnosticsRuntimeEnvironment {
    let memory: string | undefined;
    try {
        const perf = readObjectProperty(globalThis, "performance");
        const mem = readObjectProperty(perf, "memory");
        const used = readObjectProperty(mem, "usedJSHeapSize");
        const total = readObjectProperty(mem, "totalJSHeapSize");
        const limit = readObjectProperty(mem, "jsHeapSizeLimit");
        if (typeof used === "number" && Number.isFinite(used) && typeof total === "number" && Number.isFinite(total)) {
            const limitPart = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? ` (limit ${formatMb(limit)} MB)` : "";
            memory = `${formatMb(used)} / ${formatMb(total)} MB${limitPart}`;
        }
    } catch {
        // Optional browser metric.
    }
    let deviceRam: string | undefined;
    try {
        const nav = readObjectProperty(globalThis, "navigator");
        const ram = readObjectProperty(nav, "deviceMemory");
        if (typeof ram === "number" && Number.isFinite(ram) && ram > 0) {
            deviceRam = `${ram} GB`;
        }
    } catch {
        // Optional browser metric.
    }
    let screen: string | undefined;
    try {
        const scr = readObjectProperty(globalThis, "screen");
        const width = readObjectProperty(scr, "width");
        const height = readObjectProperty(scr, "height");
        if (typeof width === "number" && Number.isFinite(width) && width > 0 && typeof height === "number" && Number.isFinite(height) && height > 0) {
            screen = `${Math.round(width)}x${Math.round(height)}`;
        }
    } catch {
        // Optional browser metric.
    }
    return {
        ...(memory === undefined ? {} : { memory }),
        ...(deviceRam === undefined ? {} : { deviceRam }),
        ...(screen === undefined ? {} : { screen }),
    };
}

function formatClockTime(seconds: number): string {
    const clamped = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(clamped / 3600);
    const minutes = Math.floor((clamped % 3600) / 60);
    const secs = clamped % 60;
    const pad = (value: number): string => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

function formatBitrate(kbps: number): string {
    return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${Math.round(kbps)} Kbps`;
}

function formatApproxSize(durationSeconds: number, bitrateKbps: number): string | undefined {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(bitrateKbps) || bitrateKbps <= 0) return undefined;
    const megabytes = (durationSeconds * bitrateKbps) / 8000;
    if (megabytes >= 1024) return `~${(megabytes / 1024).toFixed(1)} GB`;
    if (megabytes >= 1) return `~${Math.round(megabytes)} MB`;
    return undefined;
}

function formatSourceSummary(details: DiagnosticsPlanDetails): string | undefined {
    const src = details.source;
    if (src === undefined) return undefined;
    const container = src.container?.trim().toUpperCase();
    const codec = src.videoCodec?.trim().toUpperCase();
    const res = src.width !== undefined && src.width > 0 && src.height !== undefined && src.height > 0 ? `${src.width}x${src.height}` : undefined;
    const fps = src.frameRate !== undefined && Number.isFinite(src.frameRate) && src.frameRate > 0 ? `${src.frameRate.toFixed(2).replace(/\.?0+$/, "")}fps` : undefined;
    const dr = src.dolbyVisionProfile !== undefined
        ? `DV P${src.dolbyVisionProfile}`
        : src.dynamicRange !== undefined && src.dynamicRange.trim() !== ""
            ? src.dynamicRange.trim().toUpperCase()
            : undefined;
    const bitrate = details.sourceBitrateKbps !== undefined && details.sourceBitrateKbps > 0 ? formatBitrate(details.sourceBitrateKbps) : undefined;
    const duration = details.durationSeconds !== undefined && details.durationSeconds > 0 ? formatClockTime(details.durationSeconds) : undefined;
    const approxSize = details.durationSeconds !== undefined && details.sourceBitrateKbps !== undefined
        ? formatApproxSize(details.durationSeconds, details.sourceBitrateKbps)
        : undefined;
    const parts = [
        container,
        [codec, res, fps].filter(Boolean).join(" "),
        dr,
        bitrate,
        duration === undefined ? approxSize : approxSize === undefined ? duration : `${duration} (${approxSize})`,
    ].filter((part): part is string => part !== undefined && part !== "");
    return parts.length === 0 ? undefined : cleanOptional(parts.join(" · "), 110);
}

function formatStreamSummary(details: DiagnosticsPlanDetails): string | undefined {
    const protocol = details.streamProtocol === "http_progressive"
        ? "HTTP"
        : details.streamProtocol === "hls"
            ? "HLS"
            : details.streamProtocol?.toUpperCase();
    const container = details.streamContainer?.trim().toUpperCase();
    const quality = details.activeQuality?.trim();
    const parts = [protocol, container, quality].filter((part): part is string => part !== undefined && part !== "");
    return parts.length === 0 ? undefined : cleanOptional(parts.join(" · "), 64);
}

function formatSubtitleDetail(details: DiagnosticsPlanDetails): string | undefined {
    const mode = details.subtitleMode?.trim();
    if (mode === undefined || mode === "") return undefined;
    if (mode === "off") return "off";
    const track = [details.subtitleSource, details.subtitleCodec?.toUpperCase()].filter(Boolean).join(" ");
    const delivery = details.subtitleDelivery === undefined ? undefined : `(${details.subtitleDelivery})`;
    const parts = [mode, [track, delivery].filter(Boolean).join(" ")].filter(Boolean);
    return cleanOptional(parts.join(" · "), 80);
}

function formatPosition(positionSeconds: number | undefined, durationSeconds: number | undefined): string | undefined {
    if (positionSeconds === undefined || !Number.isFinite(positionSeconds) || positionSeconds < 0) return undefined;
    const pos = formatClockTime(positionSeconds);
    if (durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return pos;
    return `${pos} / ${formatClockTime(durationSeconds)}`;
}

export interface DiagnosticsPayloadOptions {
    readonly category?: DiagnosticsCategory | undefined;
    readonly auto?: boolean | undefined;
}

function payloadFromSnapshot(
    snapshot: DiagnosticsSnapshot,
    logLimit: number,
    noteLimit: number,
    includeExtended: boolean,
    options?: DiagnosticsPayloadOptions,
): DiagnosticsPayloadV1 {
    const { device, lastPlayback, events } = snapshot;
    const fw = cleanOptional(device.firmware, 48);
    const os = cleanOptional(device.tizenVersion, 32);
    const ua = cleanOptional(device.browser, 32);
    const srv = cleanOptional(device.serverVersion, 48);
    const mem = includeExtended ? cleanOptional(device.memory, 48) : undefined;
    const ram = includeExtended ? cleanOptional(device.deviceRam, 16) : undefined;
    const scr = includeExtended ? cleanOptional(device.screen, 20) : undefined;
    const up = includeExtended && typeof device.uptimeMinutes === "number" && Number.isFinite(device.uptimeMinutes) && device.uptimeMinutes >= 0
        ? Math.floor(device.uptimeMinutes)
        : undefined;

    let play: DiagnosticsPayloadPlayback | undefined;
    if (lastPlayback !== undefined) {
        const notes = (lastPlayback.diagnostics ?? [])
            .map(line => cleanOptional(line, 96))
            .filter((line): line is string => line !== undefined)
            .slice(0, noteLimit);
        const m = cleanOptional(lastPlayback.playback, 64);
        const v = cleanOptional(lastPlayback.video, 72);
        const dr = cleanOptional(lastPlayback.dynamicRange, 40);
        const a = cleanOptional(lastPlayback.audio, 64);
        const s = cleanOptional(lastPlayback.subtitles, 64);
        const d = cleanOptional(lastPlayback.delivery, 48);
        const st = cleanOptional(lastPlayback.status, 32);
        const src = includeExtended ? cleanOptional(lastPlayback.source, 110) : undefined;
        const tr = includeExtended ? cleanOptional(lastPlayback.stream, 64) : undefined;
        const sub = includeExtended ? cleanOptional(lastPlayback.subtitleDetail, 80) : undefined;
        const pos = includeExtended ? cleanOptional(lastPlayback.position, 24) : undefined;
        const rb = includeExtended && typeof lastPlayback.rebuffers === "number" && Number.isInteger(lastPlayback.rebuffers) && lastPlayback.rebuffers > 0
            ? lastPlayback.rebuffers
            : undefined;
        const hdr = includeExtended && typeof lastPlayback.hdrEnabled === "boolean" ? lastPlayback.hdrEnabled : undefined;
        const av = cleanAvplayError(lastPlayback.avplayError);
        const fb = includeExtended && typeof lastPlayback.routeFallbacks === "number" && Number.isInteger(lastPlayback.routeFallbacks) && lastPlayback.routeFallbacks > 0
            ? lastPlayback.routeFallbacks
            : undefined;
        const e = cleanOptional(lastPlayback.error, 120);
        const candidate: DiagnosticsPayloadPlayback = {
            ...(m === undefined ? {} : { m }),
            ...(v === undefined ? {} : { v }),
            ...(dr === undefined ? {} : { dr }),
            ...(a === undefined ? {} : { a }),
            ...(s === undefined ? {} : { s }),
            ...(d === undefined ? {} : { d }),
            ...(st === undefined ? {} : { st }),
            ...(src === undefined ? {} : { src }),
            ...(tr === undefined ? {} : { tr }),
            ...(sub === undefined ? {} : { sub }),
            ...(pos === undefined ? {} : { pos }),
            ...(rb === undefined ? {} : { rb }),
            ...(hdr === undefined ? {} : { hdr }),
            ...(av === undefined ? {} : { av }),
            ...(fb === undefined ? {} : { fb }),
            ...(notes.length === 0 ? {} : { n: notes }),
            ...(e === undefined ? {} : { e }),
        };
        if (Object.keys(candidate).length > 0) play = candidate;
    }
    const log = logLimit <= 0
        ? []
        : events
            .slice(-logLimit)
            .map(event => `${event.at} [${event.kind}] ${formatEventText(event.text, MAX_EVENT_TEXT)}`);
    const err = cleanOptional(snapshot.lastAppError, 64);
    return {
        v: 1,
        app: cleanOptional(device.appVersion, 32) ?? "unknown",
        tv: cleanOptional(device.tvModel, 48) ?? "Samsung TV",
        ...(options?.category === undefined ? {} : { cat: options.category }),
        ...(options?.auto === true ? { auto: true as const } : {}),
        ...(err === undefined ? {} : { err }),
        ...(fw === undefined ? {} : { fw }),
        ...(os === undefined ? {} : { os }),
        ...(ua === undefined ? {} : { ua }),
        ...(device.hdrSupported === undefined ? {} : { hdr: device.hdrSupported }),
        ...(srv === undefined ? {} : { srv }),
        ...(mem === undefined ? {} : { mem }),
        ...(ram === undefined ? {} : { ram }),
        ...(scr === undefined ? {} : { scr }),
        ...(up === undefined ? {} : { up }),
        ...(play === undefined ? {} : { play }),
        ...(log.length === 0 ? {} : { log }),
    };
}

export function diagnosticsPayload(snapshot: DiagnosticsSnapshot, options?: DiagnosticsPayloadOptions): DiagnosticsPayloadV1 {
    return payloadFromSnapshot(snapshot, MAX_EVENTS, 4, true, options);
}

/** Stable failure fingerprint matching the Cloudflare Worker's grouping key. */
export function diagnosticsFingerprint(snapshot: DiagnosticsSnapshot, category?: DiagnosticsCategory, source?: "playback" | "app"): string {
    const play = snapshot.lastPlayback;
    const appErr = cleanOptional(snapshot.lastAppError, 64);
    const av = cleanAvplayError(play?.avplayError);
    const playErr = play?.error === undefined ? undefined : av !== undefined && play.error === "playback_failed" ? `${play.error}:${av}` : play.error;
    const sig = source === "playback" && playErr !== undefined
        ? playErr
        : appErr !== undefined
            ? `app:${appErr}`
            : playErr ?? [category ?? "", play?.playback ?? "", play?.delivery ?? "", play?.source ?? "", play?.subtitleDetail ?? ""].join("|");
    const key = [
        cleanOptional(snapshot.device.appVersion, 32) ?? "unknown",
        cleanOptional(snapshot.device.tvModel, 48) ?? "Samsung TV",
        sig,
    ].join("\n");
    return fnv1aHex(key);
}

/** Sends a redacted v1 diagnostics payload to the Auger Cloudflare Worker relay, which deduplicates and files a GitHub issue. */
export async function sendDiagnosticsReport(
    snapshot: DiagnosticsSnapshot,
    fetchFn: DiagnosticsFetch,
    options?: {
        readonly relayUrl?: string;
        readonly signal?: AbortSignal;
        readonly timeoutMs?: number;
        readonly category?: DiagnosticsCategory | undefined;
        readonly auto?: boolean | undefined;
    },
): Promise<DiagnosticsSendResult> {
    const controller = new AbortController();
    const relayUrl = options?.relayUrl ?? DIAGNOSTICS_RELAY_URL;
    const timeoutMs = options?.timeoutMs ?? SEND_TIMEOUT_MS;
    const onAbort = (): void => controller.abort();
    if (options?.signal !== undefined) {
        if (options.signal.aborted) return { ok: false, message: "Cancelled." };
        options.signal.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchFn(relayUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(diagnosticsPayload(snapshot, { category: options?.category, auto: options?.auto })),
            signal: controller.signal,
        });
        if (response.status === 429) {
            return { ok: false, message: "Please wait a minute before sending another report, or use Share via QR Code." };
        }
        if (!response.ok) {
            return { ok: false, message: `Could not send report (HTTP ${response.status}). Try again or use Share via QR Code.` };
        }
        let body: unknown;
        try { body = await response.json(); } catch { body = undefined; }
        const obj = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
        const issueNumber = typeof obj?.issueNumber === "number" && Number.isInteger(obj.issueNumber) && obj.issueNumber > 0 ? obj.issueNumber : undefined;
        const reportId = typeof obj?.reportId === "string" && obj.reportId.trim() !== ""
            ? obj.reportId.trim()
            : issueNumber !== undefined ? `#${issueNumber}` : "sent";
        const rawStatus = obj?.status;
        const status: DiagnosticsSendStatus | undefined = rawStatus === "created" || rawStatus === "updated" || rawStatus === "duplicate" ? rawStatus : undefined;
        return {
            ok: true,
            reportId,
            ...(issueNumber === undefined ? {} : { issueNumber }),
            ...(status === undefined ? {} : { status }),
        };
    } catch {
        return { ok: false, message: "Could not reach the diagnostics relay. Check the TV's internet connection or use Share via QR Code." };
    } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
    }
}

/**
 * Builds the zero-backend report helper URL with all redacted diagnostics strictly inside the `#d=` fragment.
 * Trims oldest log lines first, then optional extended metrics, so the QR code stays scannable from across a room.
 */
export function buildDiagnosticsReportUrl(
    snapshot: DiagnosticsSnapshot,
    baseUrl = DIAGNOSTICS_REPORT_URL,
    maxUrlLength = MAX_URL_LENGTH,
): string {
    const format = (payload: DiagnosticsPayloadV1): string => `${baseUrl}#d=${encodeBase64Url(JSON.stringify(payload))}`;
    for (const includeExtended of [true, false]) {
        for (let logLimit = snapshot.events.length; logLimit >= 0; logLimit--) {
            const url = format(payloadFromSnapshot(snapshot, logLimit, 3, includeExtended));
            if (url.length <= maxUrlLength) return url;
        }
        for (const noteLimit of [2, 1, 0]) {
            const url = format(payloadFromSnapshot(snapshot, 0, noteLimit, includeExtended));
            if (url.length <= maxUrlLength) return url;
        }
    }
    const fw = cleanOptional(snapshot.device.firmware, 48);
    const os = cleanOptional(snapshot.device.tizenVersion, 32);
    const srv = cleanOptional(snapshot.device.serverVersion, 48);
    const minimal: DiagnosticsPayloadV1 = {
        v: 1,
        app: cleanOptional(snapshot.device.appVersion, 32) ?? "unknown",
        tv: cleanOptional(snapshot.device.tvModel, 48) ?? "Samsung TV",
        ...(fw === undefined ? {} : { fw }),
        ...(os === undefined ? {} : { os }),
        ...(srv === undefined ? {} : { srv }),
    };
    return format(minimal);
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string): readonly string[] | undefined {
    const value = record[key];
    if (!Array.isArray(value)) return undefined;
    const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
    return items.length === 0 ? undefined : items;
}

function readOptionalNonNegInt(record: Record<string, unknown>, key: string): number | undefined {
    const value = record[key];
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readOptionalCategory(record: Record<string, unknown>, key: string): DiagnosticsCategory | undefined {
    const value = record[key];
    return value === "playback" || value === "audio_subtitles" || value === "buffering" || value === "app_ui" ? value : undefined;
}

/** Decodes a `#d=<base64url>` hash fragment back into a validated v1 diagnostics payload. */
export function decodeDiagnosticsReportHash(hash: string): DiagnosticsPayloadV1 | undefined {
    const trimmed = hash.startsWith("#") ? hash.slice(1) : hash;
    const match = /(?:^|&)d=([^&]+)/.exec(trimmed);
    const rawEncoded = match?.[1];
    if (rawEncoded === undefined) return undefined;
    const jsonText = decodeBase64Url(rawEncoded);
    if (jsonText === undefined) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (obj.v !== 1 || typeof obj.app !== "string" || typeof obj.tv !== "string") return undefined;
    const rawPlay = obj.play;
    let play: DiagnosticsPayloadPlayback | undefined;
    if (typeof rawPlay === "object" && rawPlay !== null && !Array.isArray(rawPlay)) {
        const playObj = rawPlay as Record<string, unknown>;
        const m = readOptionalString(playObj, "m");
        const v = readOptionalString(playObj, "v");
        const dr = readOptionalString(playObj, "dr");
        const a = readOptionalString(playObj, "a");
        const s = readOptionalString(playObj, "s");
        const d = readOptionalString(playObj, "d");
        const st = readOptionalString(playObj, "st");
        const src = readOptionalString(playObj, "src");
        const tr = readOptionalString(playObj, "tr");
        const sub = readOptionalString(playObj, "sub");
        const pos = readOptionalString(playObj, "pos");
        const rb = readOptionalNonNegInt(playObj, "rb");
        const hdr = typeof playObj.hdr === "boolean" ? playObj.hdr : undefined;
        const av = cleanAvplayError(readOptionalString(playObj, "av"));
        const fb = readOptionalNonNegInt(playObj, "fb");
        const n = readOptionalStringArray(playObj, "n");
        const e = readOptionalString(playObj, "e");
        const candidate: DiagnosticsPayloadPlayback = {
            ...(m === undefined ? {} : { m }),
            ...(v === undefined ? {} : { v }),
            ...(dr === undefined ? {} : { dr }),
            ...(a === undefined ? {} : { a }),
            ...(s === undefined ? {} : { s }),
            ...(d === undefined ? {} : { d }),
            ...(st === undefined ? {} : { st }),
            ...(src === undefined ? {} : { src }),
            ...(tr === undefined ? {} : { tr }),
            ...(sub === undefined ? {} : { sub }),
            ...(pos === undefined ? {} : { pos }),
            ...(rb === undefined ? {} : { rb }),
            ...(hdr === undefined ? {} : { hdr }),
            ...(av === undefined ? {} : { av }),
            ...(fb === undefined ? {} : { fb }),
            ...(n === undefined ? {} : { n }),
            ...(e === undefined ? {} : { e }),
        };
        if (Object.keys(candidate).length > 0) play = candidate;
    }
    const cat = readOptionalCategory(obj, "cat");
    const err = readOptionalString(obj, "err");
    const fw = readOptionalString(obj, "fw");
    const os = readOptionalString(obj, "os");
    const ua = readOptionalString(obj, "ua");
    const srv = readOptionalString(obj, "srv");
    const mem = readOptionalString(obj, "mem");
    const ram = readOptionalString(obj, "ram");
    const scr = readOptionalString(obj, "scr");
    const up = readOptionalNonNegInt(obj, "up");
    const log = readOptionalStringArray(obj, "log");
    return {
        v: 1,
        app: obj.app,
        tv: obj.tv,
        ...(cat === undefined ? {} : { cat }),
        ...(obj.auto === true ? { auto: true as const } : {}),
        ...(err === undefined ? {} : { err }),
        ...(fw === undefined ? {} : { fw }),
        ...(os === undefined ? {} : { os }),
        ...(ua === undefined ? {} : { ua }),
        ...(typeof obj.hdr === "boolean" ? { hdr: obj.hdr } : {}),
        ...(srv === undefined ? {} : { srv }),
        ...(mem === undefined ? {} : { mem }),
        ...(ram === undefined ? {} : { ram }),
        ...(scr === undefined ? {} : { scr }),
        ...(up === undefined ? {} : { up }),
        ...(play === undefined ? {} : { play }),
        ...(log === undefined ? {} : { log }),
    };
}

export function formatDeviceDetails(payload: DiagnosticsPayloadV1): string {
    return [
        payload.tv,
        payload.fw === undefined ? undefined : `Firmware ${payload.fw}`,
        payload.os,
        payload.ua,
        payload.scr,
    ].filter((part): part is string => part !== undefined && part !== "").join(", ");
}

export function formatPlaybackDetails(payload: DiagnosticsPayloadV1): string {
    const play = payload.play;
    if (play === undefined) return "";
    const lines = [
        play.m === undefined ? undefined : `Playback: ${play.m}`,
        play.d === undefined ? undefined : `Delivery: ${play.d}`,
        play.tr === undefined ? undefined : `Stream: ${play.tr}`,
        play.src === undefined ? undefined : `Source file: ${play.src}`,
        play.v === undefined ? undefined : `Video: ${play.v}`,
        play.dr === undefined ? undefined : `Dynamic range: ${play.dr}`,
        play.a === undefined ? undefined : `Audio: ${play.a}`,
        play.s === undefined ? undefined : `Subtitles: ${play.s}`,
        play.sub === undefined ? undefined : `Subtitle mode: ${play.sub}`,
        play.pos === undefined ? undefined : `Position: ${play.pos}`,
        play.rb === undefined ? undefined : `Rebuffers: ${play.rb}`,
        play.hdr === undefined ? undefined : `HDR setting: ${play.hdr ? "On" : "Off"}`,
        play.fb === undefined ? undefined : `Route fallbacks: ${play.fb}`,
        play.av === undefined ? undefined : `AVPlay error: ${play.av}`,
        play.st === undefined ? undefined : `Status: ${play.st}`,
        ...(play.n ?? []).map((note, index) => `${index === 0 ? "Diagnostics: " : "  "}${note}`),
        play.e === undefined ? undefined : `Last error: ${play.e}`,
    ].filter((line): line is string => line !== undefined);
    return lines.join("\n");
}

export function formatTechnicalNotes(payload: DiagnosticsPayloadV1): string {
    const lines: string[] = [];
    if (payload.cat !== undefined) lines.push(`Category: ${diagnosticsCategoryLabel(payload.cat)}`);
    if (payload.hdr !== undefined) lines.push(`HDR TV support: ${payload.hdr ? "Yes" : "No"}`);
    if (payload.mem !== undefined) lines.push(`JS heap: ${payload.mem}`);
    if (payload.ram !== undefined) lines.push(`Device RAM: ${payload.ram}`);
    if (payload.up !== undefined) lines.push(`App uptime: ${payload.up}m`);
    if (payload.log !== undefined && payload.log.length > 0) {
        lines.push("Recent events (redacted):");
        for (const entry of payload.log) lines.push(`- ${entry}`);
    }
    return lines.join("\n");
}

/** Builds a copy-and-paste report formatted for Discord users without a GitHub account. */
export function formatDiscordDiagnostics(payload: DiagnosticsPayloadV1): string {
    const playback = formatPlaybackDetails(payload);
    const notes = formatTechnicalNotes(payload);
    const lines = [
        "**Auger Bug Report**",
        "What happened: ",
        "Steps to reproduce: ",
        "",
        `TV: ${formatDeviceDetails(payload)}`,
        `Auger: ${payload.app}`,
        ...(payload.srv === undefined ? [] : [`Silo Server: ${payload.srv}`]),
        ...(playback === "" ? [] : ["", "**Last Playback**", playback]),
        ...(notes === "" ? [] : ["", "**Diagnostics**", notes]),
    ];
    return lines.join("\n");
}

/** Builds a GitHub Issue Form URL matching `.github/ISSUE_TEMPLATE/bug-report.yml` field IDs. */
export function buildGitHubBugReportUrl(payload: DiagnosticsPayloadV1, issueBaseUrl = GITHUB_BUG_REPORT_URL): string {
    const params = new URLSearchParams();
    params.set("template", "bug-report.yml");
    params.set("device-details", formatDeviceDetails(payload));
    params.set("app-version", payload.app);
    if (payload.srv !== undefined) params.set("server-version", payload.srv);
    const playback = formatPlaybackDetails(payload);
    if (playback !== "") params.set("playback-details", playback);
    const notes = formatTechnicalNotes(payload);
    if (notes !== "") params.set("technical-notes", notes);
    return `${issueBaseUrl}?${params.toString()}`;
}

export class DiagnosticsCollector {
    private device: DiagnosticsDeviceInfo;
    private readonly clock: Clock;
    private readonly startedAt: number;
    private readonly storage: PublicStorage | undefined;
    private readonly runtimeProbe: () => DiagnosticsRuntimeEnvironment;
    private lastPlayback: DiagnosticsPlayback | undefined;
    private lastAppError: string | undefined;
    private readonly events: DiagnosticsEvent[] = [];
    private lastPlanSignature: string | undefined;
    private sessionHasPlayback = false;
    private rebufferCount = 0;
    private lastSentHash: string | undefined;
    private lastSentReportId: string | undefined;
    private autoReport: boolean;
    private lastAutoSendAt = -Infinity;
    private readonly autoSentKeys = new Set<string>();
    private readonly listeners = new Set<() => void>();

    constructor(
        device: DiagnosticsDeviceInfo,
        clock: Clock = systemClock,
        storage?: PublicStorage,
        runtimeProbe: () => DiagnosticsRuntimeEnvironment = readRuntimeEnvironment,
    ) {
        this.device = { ...device };
        this.clock = clock;
        this.startedAt = clock.now();
        this.storage = storage;
        this.runtimeProbe = runtimeProbe;
        this.autoReport = this.readStoredFlag(AUTO_REPORT_KEY);
        for (const key of this.readStoredKeys(AUTO_SENT_KEY)) this.autoSentKeys.add(key);
    }

    get autoReportEnabled(): boolean {
        return this.autoReport;
    }

    setAutoReportEnabled(enabled: boolean): void {
        if (this.autoReport === enabled) return;
        this.autoReport = enabled;
        try {
            if (enabled) this.storage?.setItem(AUTO_REPORT_KEY, "1");
            else this.storage?.removeItem(AUTO_REPORT_KEY);
        } catch {
            // Storage failure still keeps the setting for this session.
        }
        this.emit();
    }

    hasReportableData(): boolean {
        return this.lastPlayback !== undefined || this.lastAppError !== undefined || this.events.length > 0;
    }

    /** Stable content hash ignoring volatile runtime counters (memory, uptime, playback position) for instant duplicate-click detection. */
    stableSnapshotHash(category?: DiagnosticsCategory): string {
        const play = this.lastPlayback;
        return fnv1aHex(JSON.stringify({
            app: this.device.appVersion,
            tv: this.device.tvModel,
            fw: this.device.firmware,
            srv: this.device.serverVersion,
            cat: category,
            err: this.lastAppError,
            play: play === undefined ? undefined : {
                m: play.playback,
                d: play.delivery,
                v: play.video,
                dr: play.dynamicRange,
                a: play.audio,
                s: play.subtitles,
                src: play.source,
                tr: play.stream,
                sub: play.subtitleDetail,
                rb: play.rebuffers,
                hdr: play.hdrEnabled,
                av: play.avplayError,
                fb: play.routeFallbacks,
                n: play.diagnostics,
                e: play.error,
            },
            events: this.events.map(event => `${event.kind}:${event.text}`),
        }));
    }

    duplicateSendReportId(category?: DiagnosticsCategory): string | undefined {
        if (this.lastSentHash === undefined || this.lastSentReportId === undefined) return undefined;
        return this.stableSnapshotHash(category) === this.lastSentHash ? this.lastSentReportId : undefined;
    }

    markManualSent(category: DiagnosticsCategory | undefined, reportId: string, submittedHash?: string): void {
        this.lastSentHash = submittedHash ?? this.stableSnapshotHash(category);
        this.lastSentReportId = reportId;
    }

    canAutoReport(fingerprint?: string): boolean {
        if (!this.autoReport || !this.hasReportableData()) return false;
        const now = this.clock.now();
        if (now - this.lastAutoSendAt < AUTO_REPORT_COOLDOWN_MS) return false;
        const fp = fingerprint ?? diagnosticsFingerprint(this.snapshot());
        const key = `${this.device.appVersion}:${fp}`;
        return !this.autoSentKeys.has(key);
    }

    markAutoAttempt(): void {
        this.lastAutoSendAt = this.clock.now();
    }

    markAutoDelivered(fingerprint?: string): void {
        const fp = fingerprint ?? diagnosticsFingerprint(this.snapshot());
        const key = `${this.device.appVersion}:${fp}`;
        this.lastAutoSendAt = this.clock.now();
        this.autoSentKeys.add(key);
        while (this.autoSentKeys.size > MAX_AUTO_SENT_ENTRIES) {
            const oldest = this.autoSentKeys.values().next().value;
            if (oldest === undefined) break;
            this.autoSentKeys.delete(oldest);
        }
        try {
            this.storage?.setItem(AUTO_SENT_KEY, JSON.stringify([...this.autoSentKeys]));
        } catch {
            // In-memory dedup still guards the current session.
        }
    }

    beginPlaybackSession(): void {
        this.rebufferCount = 0;
        this.lastPlanSignature = undefined;
        this.sessionHasPlayback = false;
    }

    recordAvplayEvent(avplayError: string, routeFallbacks?: number): void {
        const cleaned = cleanAvplayError(avplayError);
        if (cleaned === undefined) return;
        const fbText = routeFallbacks !== undefined && Number.isInteger(routeFallbacks) && routeFallbacks > 0 ? ` (fallback #${routeFallbacks})` : "";
        this.pushTrustedEvent("playback", `avplay ${cleaned}${fbText}`);
        this.emit();
    }

    recordAppError(code: string): void {
        const cleaned = /^[A-Za-z][A-Za-z0-9_.:-]{0,47}$/.test(code) ? code : "Error";
        this.lastAppError = cleaned;
        this.pushEvent("app", `error ${cleaned}`);
        this.emit();
    }

    setServerVersion(version: string | undefined): void {
        const cleaned = cleanOptional(version, 48);
        if (this.device.serverVersion === cleaned) return;
        this.device = { ...this.device, serverVersion: cleaned };
        this.emit();
    }

    recordRebuffer(): void {
        this.rebufferCount++;
        if (this.lastPlayback !== undefined) {
            this.lastPlayback = { ...this.lastPlayback, rebuffers: this.rebufferCount };
        }
        this.pushEvent("playback", `rebuffer #${this.rebufferCount}`);
        this.emit();
    }

    recordPlaybackStats(stats: PlaybackStats, details?: DiagnosticsPlanDetails): void {
        const readRow = (rows: readonly { readonly label: string; readonly value: string }[], label: string): string | undefined =>
            rows.find(row => row.label === label)?.value;
        const diagnostics: string[] = [];
        let collectingDiagnostics = false;
        for (const row of stats.playback) {
            if (row.label === "Diagnostics") {
                collectingDiagnostics = true;
                diagnostics.push(redactDiagnosticText(row.value, 96));
            } else if (collectingDiagnostics && row.label === "") {
                diagnostics.push(redactDiagnosticText(row.value, 96));
            } else {
                collectingDiagnostics = false;
            }
        }
        const source = details === undefined ? this.lastPlayback?.source : formatSourceSummary(details);
        const stream = details === undefined ? this.lastPlayback?.stream : formatStreamSummary(details);
        const subtitleDetail = details === undefined ? this.lastPlayback?.subtitleDetail : formatSubtitleDetail(details);
        const position = details === undefined ? this.lastPlayback?.position : formatPosition(details.positionSeconds, details.durationSeconds);
        const hdrEnabled = details?.hdrEnabled ?? this.lastPlayback?.hdrEnabled;
        const avplayError = cleanAvplayError(details?.avplayError);
        const routeFallbacks = details?.routeFallbacks !== undefined && details.routeFallbacks > 0 ? details.routeFallbacks : undefined;

        const nextBase: DiagnosticsPlayback = {
            playback: cleanOptional(readRow(stats.playback, "Playback"), 64),
            video: cleanOptional(readRow(stats.playback, "Video"), 72),
            dynamicRange: cleanOptional(readRow(stats.playback, "Dynamic range"), 40),
            audio: cleanOptional(readRow(stats.playback, "Audio"), 64),
            subtitles: cleanOptional(readRow(stats.playback, "Subtitles"), 64),
            delivery: cleanOptional(readRow(stats.engine, "Delivery"), 48),
            status: cleanOptional(readRow(stats.stream, "Playback status"), 32),
            ...(source === undefined ? {} : { source }),
            ...(stream === undefined ? {} : { stream }),
            ...(subtitleDetail === undefined ? {} : { subtitleDetail }),
            ...(position === undefined ? {} : { position }),
            ...(hdrEnabled === undefined ? {} : { hdrEnabled }),
            ...(avplayError === undefined ? {} : { avplayError }),
            ...(routeFallbacks === undefined ? {} : { routeFallbacks }),
            ...(diagnostics.length === 0 ? {} : { diagnostics }),
        };
        const signature = [nextBase.playback, nextBase.delivery, nextBase.video, nextBase.dynamicRange, nextBase.audio, nextBase.subtitles, nextBase.source, nextBase.subtitleDetail].join("|");
        const planChanged = signature !== this.lastPlanSignature && (nextBase.playback !== undefined || nextBase.delivery !== undefined);
        const next: DiagnosticsPlayback = {
            ...nextBase,
            ...(this.rebufferCount > 0 ? { rebuffers: this.rebufferCount } : {}),
        };
        const unchanged = JSON.stringify(this.lastPlayback) === JSON.stringify(next);
        if (unchanged && !planChanged) return;
        // Deliberately omit `Source` from `stats.engine`, because it contains the user's server hostname.
        // Clear any prior playback's error once a new or active playback reports stats (the historical error stays in `events`).
        this.lastPlayback = next;
        this.sessionHasPlayback = true;
        if (planChanged) {
            this.lastPlanSignature = signature;
            const summary = [next.playback, next.delivery === undefined ? undefined : `(${next.delivery})`, next.video].filter(Boolean).join(" ");
            this.pushEvent("playback", `plan ${summary}`);
        }
        this.emit();
    }

    recordPlaybackError(kind: string, message: string, details?: DiagnosticsPlanDetails): void {
        this.lastAppError = undefined;
        const cleanedKind = redactDiagnosticText(kind, 32);
        const cleanedMessage = redactDiagnosticText(message, 120);
        const combined = cleanedMessage === "" ? cleanedKind : `${cleanedKind}: ${cleanedMessage}`;
        const prior = this.sessionHasPlayback ? this.lastPlayback : undefined;
        const source = details === undefined ? prior?.source : formatSourceSummary(details) ?? prior?.source;
        const stream = details === undefined ? prior?.stream : formatStreamSummary(details) ?? prior?.stream;
        const subtitleDetail = details === undefined ? prior?.subtitleDetail : formatSubtitleDetail(details) ?? prior?.subtitleDetail;
        const position = formatPosition(details?.positionSeconds, details?.durationSeconds) ?? prior?.position;
        const hdrEnabled = details?.hdrEnabled ?? prior?.hdrEnabled;
        const avplayError = cleanAvplayError(details?.avplayError) ?? prior?.avplayError;
        const routeFallbacks = details?.routeFallbacks !== undefined && details.routeFallbacks > 0 ? details.routeFallbacks : prior?.routeFallbacks;
        this.lastPlayback = {
            ...prior,
            status: "Failed",
            error: combined,
            ...(source === undefined ? {} : { source }),
            ...(stream === undefined ? {} : { stream }),
            ...(subtitleDetail === undefined ? {} : { subtitleDetail }),
            ...(position === undefined ? {} : { position }),
            ...(hdrEnabled === undefined ? {} : { hdrEnabled }),
            ...(avplayError === undefined ? {} : { avplayError }),
            ...(routeFallbacks === undefined ? {} : { routeFallbacks }),
        };
        this.sessionHasPlayback = true;
        const suffix = avplayError === undefined ? "" : ` (${avplayError})`;
        this.pushTrustedEvent("playback", `error ${combined}${suffix}`);
        this.emit();
    }

    recordEvent(kind: DiagnosticsEvent["kind"], text: string): void {
        this.pushEvent(kind, text);
        this.emit();
    }

    clear(): void {
        if (this.lastPlayback === undefined && this.lastAppError === undefined && this.events.length === 0 && this.lastPlanSignature === undefined && this.lastSentHash === undefined) return;
        this.lastPlayback = undefined;
        this.lastAppError = undefined;
        this.events.length = 0;
        this.lastPlanSignature = undefined;
        this.sessionHasPlayback = false;
        this.rebufferCount = 0;
        this.lastSentHash = undefined;
        this.lastSentReportId = undefined;
        this.emit();
    }

    snapshot(): DiagnosticsSnapshot {
        const runtime = this.runtimeProbe();
        const uptimeMinutes = Math.max(0, Math.floor((this.clock.now() - this.startedAt) / 60000));
        return {
            device: {
                ...this.device,
                ...(runtime.memory === undefined ? {} : { memory: runtime.memory }),
                ...(runtime.deviceRam === undefined ? {} : { deviceRam: runtime.deviceRam }),
                ...(runtime.screen === undefined ? {} : { screen: runtime.screen }),
                uptimeMinutes,
            },
            ...(this.lastPlayback === undefined ? {} : { lastPlayback: { ...this.lastPlayback } }),
            ...(this.lastAppError === undefined ? {} : { lastAppError: this.lastAppError }),
            events: [...this.events],
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private readStoredFlag(key: string): boolean {
        try { return this.storage?.getItem(key) === "1"; } catch { return false; }
    }

    private readStoredKeys(key: string): readonly string[] {
        try {
            const raw = this.storage?.getItem(key);
            if (raw === null || raw === undefined) return [];
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
        } catch {
            return [];
        }
    }

    private pushEvent(kind: DiagnosticsEvent["kind"], text: string): void {
        const cleaned = redactDiagnosticText(text, MAX_EVENT_TEXT);
        if (cleaned === "") return;
        this.events.push({ at: localTime(this.clock.now()), kind, text: cleaned });
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }

    private pushTrustedEvent(kind: DiagnosticsEvent["kind"], text: string): void {
        const cleaned = formatEventText(text, MAX_EVENT_TEXT);
        if (cleaned === "") return;
        this.events.push({ at: localTime(this.clock.now()), kind, text: cleaned });
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }

    private emit(): void {
        for (const listener of this.listeners) listener();
    }
}
