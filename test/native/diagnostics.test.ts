import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import {
    buildDiagnosticsReportUrl,
    buildGitHubBugReportUrl,
    decodeDiagnosticsReportHash,
    DIAGNOSTICS_RELAY_URL,
    DIAGNOSTICS_REPORT_URL,
    DiagnosticsCollector,
    formatDiscordDiagnostics,
    redactDiagnosticText,
    sendDiagnosticsReport,
} from "../../src/diagnostics.ts";
import { handleRequest } from "../../workers/diagnostics-relay/worker.js";

function fakeClock(startMs: number): Clock & { set(ms: number): void } {
    let current = startMs;
    return {
        now: () => current,
        schedule: () => () => undefined,
        set: (ms: number) => { current = ms; },
    };
}

test("redactDiagnosticText strips URLs, IPs, query strings, and token-like secrets", () => {
    const raw = "GET https://my-home.example.org:8096/api/v2/stream?token=secret123 failed from 192.168.1.42:8096 with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9_abcdef123456";
    const redacted = redactDiagnosticText(raw, 200);
    assert.ok(!redacted.includes("my-home.example.org"), redacted);
    assert.ok(!redacted.includes("secret123"), redacted);
    assert.ok(!redacted.includes("192.168.1.42"), redacted);
    assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), redacted);
    assert.ok(redacted.includes("<url>"), redacted);
    assert.ok(redacted.includes("<ip>"), redacted);
    assert.ok(redacted.includes("<redacted>"), redacted);
});

test("DiagnosticsCollector captures playback stats without leaking server host, bounds events, and clears cleanly", () => {
    const clock = fakeClock(Date.UTC(2026, 10, 25, 1, 2, 3));
    const collector = new DiagnosticsCollector({
        appVersion: "0.2.1",
        tvModel: "UE50CU7095",
        firmware: "T-KSU2EUC-1650.0",
        tizenVersion: "Tizen 8.0",
        browser: "Chrome/108.0",
        hdrSupported: true,
        serverVersion: "412 · 1a2b3c4d",
    }, clock);
    let updates = 0;
    const stop = collector.subscribe(() => { updates++; });

    collector.recordPlaybackStats({
        nowPlaying: [{ label: "Video", value: "4K · HDR10" }],
        playback: [
            { label: "Playback", value: "Remuxed · MKV" },
            { label: "Video", value: "HEVC · 3840×2160 · 23.976 fps · 22.0 Mbps" },
            { label: "Dynamic range", value: "HDR10" },
            { label: "Audio", value: "English · EAC3 5.1" },
            { label: "Subtitles", value: "English · SRT" },
            { label: "Diagnostics", value: "Audio codec incompatible" },
            { label: "", value: "DTS remuxed to EAC3" },
        ],
        stream: [{ label: "Playback status", value: "Playing" }],
        engine: [
            { label: "Delivery", value: "Server Remux HLS" },
            { label: "Source", value: "private-silo.lan:8096" },
        ],
    });
    collector.recordPlaybackError("network", "Could not reach https://private-silo.lan/stream?api_key=abc123");

    const snap = collector.snapshot();
    assert.equal(snap.lastPlayback?.playback, "Remuxed · MKV");
    assert.equal(snap.lastPlayback?.delivery, "Server Remux HLS");
    assert.deepEqual(snap.lastPlayback?.diagnostics, ["Audio codec incompatible", "DTS remuxed to EAC3"]);
    assert.equal(snap.lastPlayback?.status, "Failed");
    assert.ok(!JSON.stringify(snap).includes("private-silo.lan"), "server host must never appear in diagnostics snapshot");
    assert.ok(!JSON.stringify(snap).includes("abc123"), "query token must never appear in diagnostics snapshot");
    assert.equal(snap.events.length, 2);

    // A subsequent playback clears lastPlayback.error while preserving the earlier failure in the session event log.
    collector.recordPlaybackStats({
        nowPlaying: [],
        playback: [{ label: "Playback", value: "Direct play · MP4" }],
        stream: [{ label: "Playback status", value: "Playing" }],
        engine: [{ label: "Delivery", value: "Original HTTP" }],
    });
    assert.equal(collector.snapshot().lastPlayback?.playback, "Direct play · MP4");
    assert.equal(collector.snapshot().lastPlayback?.error, undefined);
    assert.ok(collector.snapshot().events.some(event => event.text.startsWith("error network:")), "historical error stays in session log");

    for (let index = 0; index < 20; index++) {
        clock.set(clock.now() + 1000);
        collector.recordEvent("app", `event ${index}`);
    }
    assert.equal(collector.snapshot().events.length, 12, "ring buffer keeps at most 12 events");
    assert.ok(collector.snapshot().events[0]?.text === "event 8");

    const beforeClear = updates;
    collector.clear();
    assert.equal(collector.snapshot().lastPlayback, undefined);
    assert.deepEqual(collector.snapshot().events, []);
    assert.equal(updates, beforeClear + 1);
    stop();
});

test("QR budget drops all log entries when logLimit reaches zero while preserving playback details", () => {
    const clock = fakeClock(Date.UTC(2026, 10, 25, 1, 15, 0));
    const collector = new DiagnosticsCollector({ appVersion: "0.2.1", tvModel: "UE50CU7095", serverVersion: "412" }, clock);
    collector.recordPlaybackStats({
        nowPlaying: [],
        playback: [
            { label: "Playback", value: "Remuxed · MKV" },
            { label: "Video", value: "HEVC · 3840×2160 · 23.976 fps · 24.0 Mbps" },
        ],
        stream: [{ label: "Playback status", value: "Playing" }],
        engine: [{ label: "Delivery", value: "Server Remux HLS" }],
    });
    collector.recordEvent("playback", "a long event line that pushes the encoded payload over a tight QR budget");

    // Force a tight budget where playback fits without any log lines, but even 1 log line exceeds it.
    const url = buildDiagnosticsReportUrl(collector.snapshot(), DIAGNOSTICS_REPORT_URL, 330);
    assert.ok(url.length <= 330, `expected <= 330, got ${url.length}`);
    const decoded = decodeDiagnosticsReportHash(url.slice(url.indexOf("#")));
    assert.equal(decoded?.play?.m, "Remuxed · MKV");
    assert.equal(decoded?.log, undefined, "zero log limit must omit all log lines rather than calling slice(-0)");
});

test("diagnostics hash URL round-trips, stays under the QR length budget, and formats Discord + GitHub outputs", () => {
    const clock = fakeClock(Date.UTC(2026, 10, 25, 1, 10, 0));
    const collector = new DiagnosticsCollector({
        appVersion: "0.2.1",
        tvModel: "UE50CU7095",
        firmware: "1650",
        tizenVersion: "Tizen 8.0",
        hdrSupported: true,
        serverVersion: "412 · 1a2b3c4d",
    }, clock);
    collector.recordPlaybackStats({
        nowPlaying: [],
        playback: [
            { label: "Playback", value: "Direct play · MKV" },
            { label: "Video", value: "H.264 · 1920×1080 · 23.976 fps · 8.0 Mbps" },
            { label: "Dynamic range", value: "SDR" },
            { label: "Audio", value: "English · AAC Stereo" },
            { label: "Subtitles", value: "Off" },
        ],
        stream: [{ label: "Playback status", value: "Playing" }],
        engine: [{ label: "Delivery", value: "Original HTTP" }, { label: "Source", value: "secret.internal" }],
    });
    for (let index = 0; index < 12; index++) {
        collector.recordEvent("playback", `repeated diagnostic observation number ${index} with extra technical context`);
    }

    const url = buildDiagnosticsReportUrl(collector.snapshot());
    assert.ok(url.startsWith(`${DIAGNOSTICS_REPORT_URL}#d=`));
    assert.ok(url.length <= 960, `URL length ${url.length} exceeds QR scanability budget`);

    const hash = url.slice(url.indexOf("#"));
    const decoded = decodeDiagnosticsReportHash(hash);
    assert.ok(decoded !== undefined);
    assert.equal(decoded.v, 1);
    assert.equal(decoded.app, "0.2.1");
    assert.equal(decoded.tv, "UE50CU7095");
    assert.equal(decoded.fw, "1650");
    assert.equal(decoded.os, "Tizen 8.0");
    assert.equal(decoded.srv, "412 · 1a2b3c4d");
    assert.equal(decoded.play?.m, "Direct play · MKV");
    assert.equal(decoded.play?.d, "Original HTTP");
    assert.ok(!url.includes("secret.internal"));

    const discord = formatDiscordDiagnostics(decoded);
    assert.ok(discord.includes("**Auger Bug Report**"));
    assert.ok(discord.includes("TV: UE50CU7095, Firmware 1650, Tizen 8.0"));
    assert.ok(discord.includes("Auger: 0.2.1"));
    assert.ok(discord.includes("Playback: Direct play · MKV"));

    const github = new URL(buildGitHubBugReportUrl(decoded));
    assert.equal(github.searchParams.get("template"), "bug-report.yml");
    assert.equal(github.searchParams.get("device-details"), "UE50CU7095, Firmware 1650, Tizen 8.0");
    assert.equal(github.searchParams.get("app-version"), "0.2.1");
    assert.equal(github.searchParams.get("server-version"), "412 · 1a2b3c4d");
    assert.ok(github.searchParams.get("playback-details")?.includes("Direct play · MKV"));
    assert.ok(github.searchParams.get("technical-notes")?.includes("HDR TV support: Yes"));

    assert.equal(decodeDiagnosticsReportHash(""), undefined);
    assert.equal(decodeDiagnosticsReportHash("#d=not!valid"), undefined);
    assert.equal(decodeDiagnosticsReportHash("#d=e30"), undefined);
});

test("sendDiagnosticsReport posts redacted payload to the relay and handles success, rate-limit, HTTP error, and network failure", async () => {
    const collector = new DiagnosticsCollector({ appVersion: "0.2.1", tvModel: "UE50CU7095", serverVersion: "412" });
    collector.recordEvent("network", "GET https://private.example.org/watch?token=topsecret123 from 10.0.0.42:8096 with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9_abcdef123456");
    let capturedUrl = "";
    let capturedBody = "";
    const okResult = await sendDiagnosticsReport(collector.snapshot(), async (url, init) => {
        capturedUrl = url;
        capturedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ ok: true, issueNumber: 901, reportId: "AUG-901" }), { status: 201 });
    });
    assert.equal(capturedUrl, DIAGNOSTICS_RELAY_URL);
    assert.equal(JSON.parse(capturedBody).tv, "UE50CU7095");
    assert.ok(!capturedBody.includes("private.example.org"), "posted JSON must exclude URLs");
    assert.ok(!capturedBody.includes("topsecret123"), "posted JSON must exclude query tokens");
    assert.ok(!capturedBody.includes("10.0.0.42"), "posted JSON must exclude IPv4 addresses");
    assert.ok(!capturedBody.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"), "posted JSON must exclude bearer tokens");
    assert.ok(capturedBody.includes("<url>") && capturedBody.includes("<ip>") && capturedBody.includes("<redacted>"));
    assert.deepEqual(okResult, { ok: true, reportId: "AUG-901", issueNumber: 901 });

    const limited = await sendDiagnosticsReport(collector.snapshot(), async () => new Response("", { status: 429 }));
    assert.equal(limited.ok, false);
    assert.match(limited.message, /Too many reports/);

    const failed = await sendDiagnosticsReport(collector.snapshot(), async () => new Response("", { status: 502 }));
    assert.equal(failed.ok, false);
    assert.match(failed.message, /HTTP 502/);

    const offline = await sendDiagnosticsReport(collector.snapshot(), async () => { throw new Error("network down"); });
    assert.equal(offline.ok, false);
    assert.match(offline.message, /Share via QR Code/);
});

test("Cloudflare Worker diagnostics relay validates, redacts, atomically rate-limits, streams oversized bodies safely, and opens a GitHub issue", async () => {
    const counts = new Map<string, number>();
    const atomicLimiter = {
        limit: async ({ key }: { readonly key: string }): Promise<{ readonly success: boolean }> => {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return { success: next <= 5 };
        },
    };
    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return new Response(JSON.stringify({ number: 888 }), { status: 201 });
    };
    const env = { GITHUB_TOKEN: "test-secret-not-real", GITHUB_REPO: "Artic0din/Auger-Tizen", DIAGNOSTICS_RATE_LIMITER: atomicLimiter };

    const bad = await handleRequest(new Request("https://auger-diagnostics.plaintextlab.com/report", { method: "POST", body: "{}" }), env, { fetch: fakeFetch });
    assert.equal(bad.status, 400);

    // Oversized streaming request cancels early and returns 413 without buffering the full stream.
    let chunksPulled = 0;
    let cancelled = false;
    const hugeStream = new ReadableStream<Uint8Array>({
        pull(controller) {
            chunksPulled++;
            controller.enqueue(new Uint8Array(4096).fill(65));
        },
        cancel() {
            cancelled = true;
        },
    }, { highWaterMark: 0 });
    const oversized = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" },
            body: hugeStream,
            // @ts-expect-error Node fetch requires duplex: "half" for streaming Request bodies.
            duplex: "half",
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(oversized.status, 413);
    assert.equal(cancelled, true, "oversized stream must be cancelled as soon as it exceeds 8 KiB");
    assert.equal(chunksPulled, 3, "only the 3 chunks needed to cross 8 KiB should be pulled before cancellation");

    const payload = {
        v: 1,
        app: "0.2.1",
        tv: "UE50CU7095",
        fw: "1650",
        os: "Tizen 8.0",
        hdr: true,
        play: { m: "Remuxed · MKV", e: "Failed https://private.lan/video?token=secret999" },
        log: ["01:02:03 [playback] error 192.168.1.10"],
    };

    // Concurrent requests against the same IP respect the atomic 5-request quota.
    const responses = await Promise.all(Array.from({ length: 7 }, () => handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.5" },
            body: JSON.stringify(payload),
        }),
        env,
        { fetch: fakeFetch },
    )));
    const statuses = responses.map(res => res.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429, 429]);
    assert.equal(posted.length, 5);
    assert.equal(posted[0]?.url, "https://api.github.com/repos/Artic0din/Auger-Tizen/issues");
    assert.deepEqual(posted[0]?.body.labels, ["bug", "needs-triage"]);
    const issueBody = String(posted[0]?.body.body ?? "");
    assert.ok(!issueBody.includes("private.lan"));
    assert.ok(!issueBody.includes("secret999"));
    assert.ok(!issueBody.includes("192.168.1.10"));
    assert.ok(issueBody.includes("UE50CU7095"));
});
