import type { Clock } from "./api/clock.ts";
import { systemClock } from "./api/clock.ts";
import type { PlaybackStats } from "./player/playerHUD.ts";

export const DIAGNOSTICS_REPORT_URL = "https://artic0din.github.io/Auger-Tizen/report/";
export const DIAGNOSTICS_RELAY_URL = "https://auger-diagnostics.plaintextlab.com/report";
export const GITHUB_BUG_REPORT_URL = "https://github.com/Artic0din/Auger-Tizen/issues/new";

const MAX_EVENTS = 12;
const MAX_EVENT_TEXT = 96;
const MAX_URL_LENGTH = 960;
const SEND_TIMEOUT_MS = 15000;

export type DiagnosticsSendResult =
    | { readonly ok: true; readonly reportId: string; readonly issueNumber?: number | undefined }
    | { readonly ok: false; readonly message: string };

export type DiagnosticsFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface DiagnosticsDeviceInfo {
    readonly appVersion: string;
    readonly tvModel: string;
    readonly firmware?: string | undefined;
    readonly tizenVersion?: string | undefined;
    readonly browser?: string | undefined;
    readonly hdrSupported?: boolean | undefined;
    readonly serverVersion?: string | undefined;
}

export interface DiagnosticsPlayback {
    readonly playback?: string | undefined;
    readonly video?: string | undefined;
    readonly dynamicRange?: string | undefined;
    readonly audio?: string | undefined;
    readonly subtitles?: string | undefined;
    readonly delivery?: string | undefined;
    readonly status?: string | undefined;
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
    readonly n?: readonly string[];
    readonly e?: string;
}

export interface DiagnosticsPayloadV1 {
    readonly v: 1;
    readonly app: string;
    readonly tv: string;
    readonly fw?: string;
    readonly os?: string;
    readonly ua?: string;
    readonly hdr?: boolean;
    readonly srv?: string;
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

function payloadFromSnapshot(snapshot: DiagnosticsSnapshot, logLimit: number, noteLimit: number): DiagnosticsPayloadV1 {
    const { device, lastPlayback, events } = snapshot;
    const fw = cleanOptional(device.firmware, 48);
    const os = cleanOptional(device.tizenVersion, 32);
    const ua = cleanOptional(device.browser, 32);
    const srv = cleanOptional(device.serverVersion, 48);
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
        const e = cleanOptional(lastPlayback.error, 120);
        const candidate: DiagnosticsPayloadPlayback = {
            ...(m === undefined ? {} : { m }),
            ...(v === undefined ? {} : { v }),
            ...(dr === undefined ? {} : { dr }),
            ...(a === undefined ? {} : { a }),
            ...(s === undefined ? {} : { s }),
            ...(d === undefined ? {} : { d }),
            ...(st === undefined ? {} : { st }),
            ...(notes.length === 0 ? {} : { n: notes }),
            ...(e === undefined ? {} : { e }),
        };
        if (Object.keys(candidate).length > 0) play = candidate;
    }
    const log = logLimit <= 0
        ? []
        : events
            .slice(-logLimit)
            .map(event => `${event.at} [${event.kind}] ${redactDiagnosticText(event.text, MAX_EVENT_TEXT)}`);
    return {
        v: 1,
        app: cleanOptional(device.appVersion, 32) ?? "unknown",
        tv: cleanOptional(device.tvModel, 48) ?? "Samsung TV",
        ...(fw === undefined ? {} : { fw }),
        ...(os === undefined ? {} : { os }),
        ...(ua === undefined ? {} : { ua }),
        ...(device.hdrSupported === undefined ? {} : { hdr: device.hdrSupported }),
        ...(srv === undefined ? {} : { srv }),
        ...(play === undefined ? {} : { play }),
        ...(log.length === 0 ? {} : { log }),
    };
}

export function diagnosticsPayload(snapshot: DiagnosticsSnapshot): DiagnosticsPayloadV1 {
    return payloadFromSnapshot(snapshot, MAX_EVENTS, 4);
}

/** Sends a redacted v1 diagnostics payload to the Auger Cloudflare Worker relay, which files a GitHub issue. */
export async function sendDiagnosticsReport(
    snapshot: DiagnosticsSnapshot,
    fetchFn: DiagnosticsFetch,
    options?: { readonly relayUrl?: string; readonly signal?: AbortSignal; readonly timeoutMs?: number },
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
            body: JSON.stringify(diagnosticsPayload(snapshot)),
            signal: controller.signal,
        });
        if (response.status === 429) {
            return { ok: false, message: "Too many reports sent recently. Wait a few minutes or use Share via QR Code." };
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
        return { ok: true, reportId, ...(issueNumber === undefined ? {} : { issueNumber }) };
    } catch {
        return { ok: false, message: "Could not reach the diagnostics relay. Check the TV's internet connection or use Share via QR Code." };
    } finally {
        clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
    }
}

/**
 * Builds the zero-backend report helper URL with all redacted diagnostics strictly inside the `#d=` fragment.
 * Trims oldest log lines first so the QR code stays compact and scannable from across a room.
 */
export function buildDiagnosticsReportUrl(
    snapshot: DiagnosticsSnapshot,
    baseUrl = DIAGNOSTICS_REPORT_URL,
    maxUrlLength = MAX_URL_LENGTH,
): string {
    const format = (payload: DiagnosticsPayloadV1): string => `${baseUrl}#d=${encodeBase64Url(JSON.stringify(payload))}`;
    for (let logLimit = snapshot.events.length; logLimit >= 0; logLimit--) {
        const url = format(payloadFromSnapshot(snapshot, logLimit, 3));
        if (url.length <= maxUrlLength) return url;
    }
    for (const noteLimit of [2, 1, 0]) {
        const url = format(payloadFromSnapshot(snapshot, 0, noteLimit));
        if (url.length <= maxUrlLength) return url;
    }
    // Last-resort minimal payload: device identity + app/server version only.
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
            ...(n === undefined ? {} : { n }),
            ...(e === undefined ? {} : { e }),
        };
        if (Object.keys(candidate).length > 0) play = candidate;
    }
    const fw = readOptionalString(obj, "fw");
    const os = readOptionalString(obj, "os");
    const ua = readOptionalString(obj, "ua");
    const srv = readOptionalString(obj, "srv");
    const log = readOptionalStringArray(obj, "log");
    return {
        v: 1,
        app: obj.app,
        tv: obj.tv,
        ...(fw === undefined ? {} : { fw }),
        ...(os === undefined ? {} : { os }),
        ...(ua === undefined ? {} : { ua }),
        ...(typeof obj.hdr === "boolean" ? { hdr: obj.hdr } : {}),
        ...(srv === undefined ? {} : { srv }),
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
    ].filter((part): part is string => part !== undefined && part !== "").join(", ");
}

export function formatPlaybackDetails(payload: DiagnosticsPayloadV1): string {
    const play = payload.play;
    if (play === undefined) return "";
    const lines = [
        play.m === undefined ? undefined : `Playback: ${play.m}`,
        play.d === undefined ? undefined : `Delivery: ${play.d}`,
        play.v === undefined ? undefined : `Video: ${play.v}`,
        play.dr === undefined ? undefined : `Dynamic range: ${play.dr}`,
        play.a === undefined ? undefined : `Audio: ${play.a}`,
        play.s === undefined ? undefined : `Subtitles: ${play.s}`,
        play.st === undefined ? undefined : `Status: ${play.st}`,
        ...(play.n ?? []).map((note, index) => `${index === 0 ? "Diagnostics: " : "  "}${note}`),
        play.e === undefined ? undefined : `Last error: ${play.e}`,
    ].filter((line): line is string => line !== undefined);
    return lines.join("\n");
}

export function formatTechnicalNotes(payload: DiagnosticsPayloadV1): string {
    const lines: string[] = [];
    if (payload.hdr !== undefined) lines.push(`HDR TV support: ${payload.hdr ? "Yes" : "No"}`);
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
    private lastPlayback: DiagnosticsPlayback | undefined;
    private readonly events: DiagnosticsEvent[] = [];
    private lastPlanSignature: string | undefined;
    private readonly listeners = new Set<() => void>();

    constructor(device: DiagnosticsDeviceInfo, clock: Clock = systemClock) {
        this.device = { ...device };
        this.clock = clock;
    }

    setServerVersion(version: string | undefined): void {
        const cleaned = cleanOptional(version, 48);
        if (this.device.serverVersion === cleaned) return;
        this.device = { ...this.device, serverVersion: cleaned };
        this.emit();
    }

    recordPlaybackStats(stats: PlaybackStats): void {
        const readRow = (rows: readonly { readonly label: string; readonly value: string }[], label: string): string | undefined =>
            rows.find(row => row.label === label)?.value;
        // Collect Diagnostics + any continuation lines (empty label immediately following Diagnostics).
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
        // Deliberately omit `Source` from `stats.engine`, because it contains the user's server hostname.
        // Clear any prior playback's error once a new or active playback reports stats (the historical error stays in `events`).
        const next: DiagnosticsPlayback = {
            playback: cleanOptional(readRow(stats.playback, "Playback"), 64),
            video: cleanOptional(readRow(stats.playback, "Video"), 72),
            dynamicRange: cleanOptional(readRow(stats.playback, "Dynamic range"), 40),
            audio: cleanOptional(readRow(stats.playback, "Audio"), 64),
            subtitles: cleanOptional(readRow(stats.playback, "Subtitles"), 64),
            delivery: cleanOptional(readRow(stats.engine, "Delivery"), 48),
            status: cleanOptional(readRow(stats.stream, "Playback status"), 32),
            ...(diagnostics.length === 0 ? {} : { diagnostics }),
        };
        const signature = [next.playback, next.delivery, next.video, next.dynamicRange, next.audio, next.subtitles].join("|");
        const planChanged = signature !== this.lastPlanSignature && (next.playback !== undefined || next.delivery !== undefined);
        const unchanged = JSON.stringify(this.lastPlayback) === JSON.stringify(next);
        if (unchanged && !planChanged) return;
        this.lastPlayback = next;
        if (planChanged) {
            this.lastPlanSignature = signature;
            const summary = [next.playback, next.delivery === undefined ? undefined : `(${next.delivery})`, next.video].filter(Boolean).join(" ");
            this.pushEvent("playback", `plan ${summary}`);
        }
        this.emit();
    }

    recordPlaybackError(kind: string, message: string): void {
        const cleanedKind = redactDiagnosticText(kind, 32);
        const cleanedMessage = redactDiagnosticText(message, 120);
        const combined = cleanedMessage === "" ? cleanedKind : `${cleanedKind}: ${cleanedMessage}`;
        this.lastPlayback = { ...this.lastPlayback, status: "Failed", error: combined };
        this.pushEvent("playback", `error ${combined}`);
        this.emit();
    }

    recordEvent(kind: DiagnosticsEvent["kind"], text: string): void {
        this.pushEvent(kind, text);
        this.emit();
    }

    clear(): void {
        if (this.lastPlayback === undefined && this.events.length === 0 && this.lastPlanSignature === undefined) return;
        this.lastPlayback = undefined;
        this.events.length = 0;
        this.lastPlanSignature = undefined;
        this.emit();
    }

    snapshot(): DiagnosticsSnapshot {
        return {
            device: { ...this.device },
            ...(this.lastPlayback === undefined ? {} : { lastPlayback: { ...this.lastPlayback } }),
            events: [...this.events],
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private pushEvent(kind: DiagnosticsEvent["kind"], text: string): void {
        const cleaned = redactDiagnosticText(text, MAX_EVENT_TEXT);
        if (cleaned === "") return;
        this.events.push({ at: localTime(this.clock.now()), kind, text: cleaned });
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }

    private emit(): void {
        for (const listener of this.listeners) listener();
    }
}
