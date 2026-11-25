import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import {
    AUTO_REPORT_COOLDOWN_MS,
    buildDiagnosticsReportUrl,
    buildGitHubBugReportUrl,
    decodeDiagnosticsReportHash,
    DIAGNOSTICS_RELAY_URL,
    DIAGNOSTICS_REPORT_URL,
    DiagnosticsCollector,
    diagnosticsFingerprint,
    formatDiscordDiagnostics,
    readRuntimeEnvironment,
    redactDiagnosticText,
    sendDiagnosticsReport,
} from "../../src/diagnostics.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";
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

    const updatedResult = await sendDiagnosticsReport(collector.snapshot(), async () =>
        new Response(JSON.stringify({ ok: true, status: "updated", issueNumber: 901, reportId: "AUG-901" }), { status: 200 }),
    { category: "buffering" });
    assert.deepEqual(updatedResult, { ok: true, status: "updated", reportId: "AUG-901", issueNumber: 901 });

    const limited = await sendDiagnosticsReport(collector.snapshot(), async () => new Response("", { status: 429 }));
    assert.equal(limited.ok, false);
    assert.match(limited.message, /wait a minute/i);

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
    const posted: { method: string; url: string; body: Record<string, unknown> }[] = [];
    const openIssues: { number: number; body: string; comments: number }[] = [];
    const issueComments = new Map<number, { body: string }[]>();
    let nextIssueNumber = 888;
    let failLookupOnce = false;
    let invalidLookupJsonOnce = false;
    let paginatePageTwo = false;
    const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && url.includes("/issues?state=open&labels=diagnostics")) {
            if (failLookupOnce) {
                failLookupOnce = false;
                return new Response("upstream error", { status: 503 });
            }
            if (invalidLookupJsonOnce) {
                invalidLookupJsonOnce = false;
                return new Response("not-json{", { status: 200 });
            }
            if (paginatePageTwo && !url.includes("page=2")) {
                return new Response(JSON.stringify([{ number: 700, body: "unrelated", comments: 0 }]), {
                    status: 200,
                    headers: { Link: `<https://api.github.com/repos/Artic0din/Auger-Tizen/issues?state=open&labels=diagnostics&per_page=100&page=2>; rel="next"` },
                });
            }
            return new Response(JSON.stringify(openIssues), { status: 200 });
        }
        if (method === "GET" && url.includes("/comments?per_page=10")) {
            const match = /\/issues\/(\d+)\/comments/.exec(url);
            const num = match?.[1] ? Number(match[1]) : 0;
            return new Response(JSON.stringify(issueComments.get(num) ?? []), { status: 200 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posted.push({ method, url, body });
        if (method === "POST" && url.endsWith("/issues")) {
            const num = nextIssueNumber++;
            openIssues.push({ number: num, body: String(body.body ?? ""), comments: 0 });
            return new Response(JSON.stringify({ number: num }), { status: 201 });
        }
        if (method === "POST" && url.endsWith("/comments")) {
            const target = openIssues.find(entry => url.endsWith(`/issues/${entry.number}/comments`));
            if (target) {
                target.comments++;
                const list = issueComments.get(target.number) ?? [];
                list.push({ body: String(body.body ?? "") });
                issueComments.set(target.number, list);
            }
            return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        }
        return new Response("not found", { status: 404 });
    };
    const env = { GITHUB_TOKEN: "test-secret-not-real", GITHUB_REPO: "Artic0din/Auger-Tizen", DIAGNOSTICS_RATE_LIMITER: atomicLimiter };

    const bad = await handleRequest(new Request("https://auger-diagnostics.plaintextlab.com/report", { method: "POST", body: "{}" }), env, { fetch: fakeFetch });
    assert.equal(bad.status, 400);

    // Oversized streaming request cancels early and still returns JSON 413 even if stream cancellation throws.
    let chunksPulled = 0;
    let cancelled = false;
    const hugeStream = new ReadableStream<Uint8Array>({
        pull(controller) {
            chunksPulled++;
            controller.enqueue(new Uint8Array(4096).fill(65));
        },
        cancel() {
            cancelled = true;
            throw new Error("socket closed");
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
    assert.deepEqual(await oversized.json(), { ok: false, error: "payload_too_large" });
    assert.equal(cancelled, true, "oversized stream must be cancelled as soon as it exceeds 8 KiB");
    assert.equal(chunksPulled, 3, "only the 3 chunks needed to cross 8 KiB should be pulled before cancellation");

    const payload = {
        v: 1,
        app: "0.3.0",
        tv: "UE50CU7095",
        cat: "playback",
        fw: "1650",
        os: "Tizen 8.0",
        hdr: true,
        mem: "64 / 128 MB (limit 512 MB)",
        ram: "4 GB",
        scr: "1920x1080",
        up: 12,
        play: {
            m: "Remuxed · MKV",
            d: "Server Remux HLS",
            tr: "HLS · MP4 · 1080p",
            src: "MKV · HEVC 3840x2160 23.98fps · DV P7 · 24.0 Mbps · 2:00:00 (~21.6 GB)",
            sub: "burn_in · embedded ASS (burn_in_only)",
            pos: "12:34 / 2:00:00",
            rb: 2,
            e: "Failed https://private.lan/video?token=secret999",
        },
        log: ["01:02:03 [playback] error 192.168.1.10"],
    };

    // 1. First report creates a new `diagnostics` + `needs-triage` issue with fingerprint + state markers.
    const first = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
            body: JSON.stringify(payload),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { ok: true, status: "created", issueNumber: 888, reportId: "AUG-888" });
    assert.equal(posted.length, 1);
    assert.equal(posted[0]?.url, "https://api.github.com/repos/Artic0din/Auger-Tizen/issues");
    assert.deepEqual(posted[0]?.body.labels, ["diagnostics", "needs-triage"]);
    const issueBody = String(posted[0]?.body.body ?? "");
    assert.ok(!issueBody.includes("private.lan"));
    assert.ok(!issueBody.includes("secret999"));
    assert.ok(!issueBody.includes("192.168.1.10"));
    assert.ok(issueBody.includes("UE50CU7095"));
    assert.ok(issueBody.includes("64 / 128 MB (limit 512 MB)"));
    assert.ok(issueBody.includes("burn_in · embedded ASS (burn_in_only)"));
    assert.ok(issueBody.includes("<!-- auger-fp:"));

    // 2. Identical follow-up (even with different uptime/memory/position) returns `duplicate` with ZERO new issues or comments.
    const dup = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.11" },
            body: JSON.stringify({ ...payload, up: 45, mem: "80 / 128 MB (limit 512 MB)", play: { ...payload.play, pos: "15:00 / 2:00:00" } }),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(dup.status, 200);
    assert.deepEqual(await dup.json(), { ok: true, status: "duplicate", issueNumber: 888, reportId: "AUG-888" });
    assert.equal(posted.length, 1, "identical retry must not open an issue or post a comment");

    // 3. Same fingerprint with new firmware + new log line posts a single compact diff comment on #888 instead of opening a second issue.
    const updatedPayload = {
        ...payload,
        fw: "1661",
        log: [...payload.log, "01:05:00 [playback] rebuffer #3"],
    };
    const diff = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.12" },
            body: JSON.stringify(updatedPayload),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(diff.status, 200);
    assert.deepEqual(await diff.json(), { ok: true, status: "updated", issueNumber: 888, reportId: "AUG-888" });
    assert.equal(posted.length, 2);
    assert.equal(posted[1]?.url, "https://api.github.com/repos/Artic0din/Auger-Tizen/issues/888/comments");
    const commentBody = String(posted[1]?.body.body ?? "");
    assert.ok(commentBody.includes("**Firmware:** `1650` → `1661`"));
    assert.ok(commentBody.includes("rebuffer #3"));

    // 3b. Retrying the exact same updated follow-up (firmware 1 -> 2 -> 2) detects the prior comment hash and returns `duplicate`.
    const diffRetry = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.13" },
            body: JSON.stringify(updatedPayload),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(diffRetry.status, 200);
    assert.deepEqual(await diffRetry.json(), { ok: true, status: "duplicate", issueNumber: 888, reportId: "AUG-888" });
    assert.equal(posted.length, 2, "retrying an already-posted diff comment must not post a second comment");

    // 3c. Pagination follows Link rel="next" to find an open match on page 2, and lookup failure returns retryable 502 instead of opening a duplicate.
    paginatePageTwo = true;
    const pagedMatch = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.14" },
            body: JSON.stringify(payload),
        }),
        env,
        { fetch: fakeFetch },
    );
    paginatePageTwo = false;
    assert.equal(pagedMatch.status, 200);
    assert.deepEqual(await pagedMatch.json(), { ok: true, status: "duplicate", issueNumber: 888, reportId: "AUG-888" });

    failLookupOnce = true;
    const lookupFailed = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.15" },
            body: JSON.stringify(payload),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(lookupFailed.status, 502);
    invalidLookupJsonOnce = true;
    const malformedLookup = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.16" },
            body: JSON.stringify(payload),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(malformedLookup.status, 502);
    assert.equal(posted.length, 2, "failed or malformed GitHub issue lookup must return retryable 502 without creating a duplicate issue");

    // 3d. Allowlisted err passes through; unrecognized token-like or Markdown err values are dropped at the Worker boundary.
    const unsafeErr = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.17" },
            body: JSON.stringify({ v: 1, app: "0.3.0", tv: "QE65S95C", err: "SecretToken12345678901234567890" }),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(unsafeErr.status, 201);
    const unsafeBody = String(posted[posted.length - 1]?.body.body ?? "");
    assert.ok(!unsafeBody.includes("SecretToken12345678901234567890"), "unrecognized token-like err must be dropped");
    assert.ok(!unsafeBody.includes("| App error |"), "dropped err must not render an App error row");

    // 3e. Concurrent first reports for the same new fingerprint serialize cleanly into 1 created + 1 duplicate.
    const burstPayload = { v: 1, app: "0.3.0", tv: "QE65S95C", err: "RangeError", auto: true };
    const [burstA, burstB] = await Promise.all([
        handleRequest(new Request("https://auger-diagnostics.plaintextlab.com/report", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.20" }, body: JSON.stringify(burstPayload) }), env, { fetch: fakeFetch }),
        handleRequest(new Request("https://auger-diagnostics.plaintextlab.com/report", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.21" }, body: JSON.stringify(burstPayload) }), env, { fetch: fakeFetch }),
    ]);
    const burstStatuses = [await burstA.json(), await burstB.json()].map((item: { status: string }) => item.status).sort();
    assert.deepEqual(burstStatuses, ["created", "duplicate"]);

    // 4. Concurrent requests against the same IP respect the atomic quota and advertise the 60 s binding Retry-After.
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
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
    for (const denied of responses.filter(res => res.status === 429)) {
        assert.equal(denied.headers.get("Retry-After"), "60");
    }
});

test("DiagnosticsCollector captures runtime memory, source/subtitle telemetry, duplicate-send guard, and opt-in auto-report cooldown", () => {
    const clock = fakeClock(Date.UTC(2026, 10, 25, 2, 0, 0));
    const storage = new MemoryPublicStorage();
    const collector = new DiagnosticsCollector(
        { appVersion: "0.3.0", tvModel: "QE65S95C", firmware: "1650" },
        clock,
        storage,
        () => ({ memory: "48 / 96 MB (limit 512 MB)", deviceRam: "4 GB", screen: "3840x2160" }),
    );
    assert.equal(collector.autoReportEnabled, false, "auto-reporting must be off by default");
    assert.equal(collector.hasReportableData(), false);
    assert.equal(collector.canAutoReport(), false);

    clock.set(clock.now() + 5 * 60 * 1000);
    collector.recordPlaybackStats(
        {
            nowPlaying: [],
            playback: [{ label: "Playback", value: "Transcoded · MKV" }],
            stream: [{ label: "Playback status", value: "Playing" }],
            engine: [{ label: "Delivery", value: "Server Transcode HLS" }],
        },
        {
            source: { container: "mkv", videoCodec: "hevc", width: 3840, height: 2160, frameRate: 23.976, dynamicRange: "dolby_vision", dolbyVisionProfile: 7 },
            sourceBitrateKbps: 24000,
            durationSeconds: 7200,
            streamProtocol: "hls",
            streamContainer: "mpegts",
            activeQuality: "1080p",
            subtitleMode: "burn_in",
            subtitleSource: "embedded",
            subtitleCodec: "ass",
            subtitleDelivery: "burn_in_only",
            positionSeconds: 754,
        },
    );
    collector.recordRebuffer();

    const snap = collector.snapshot();
    assert.equal(snap.device.memory, "48 / 96 MB (limit 512 MB)");
    assert.equal(snap.device.deviceRam, "4 GB");
    assert.equal(snap.device.screen, "3840x2160");
    assert.equal(snap.device.uptimeMinutes, 5);
    assert.match(snap.lastPlayback?.source ?? "", /MKV · HEVC 3840x2160 23\.98fps · DV P7 · 24\.0 Mbps · 2:00:00 \(~21\.1 GB\)/);
    assert.equal(snap.lastPlayback?.stream, "HLS · MPEGTS · 1080p");
    assert.equal(snap.lastPlayback?.subtitleDetail, "burn_in · embedded ASS (burn_in_only)");
    assert.equal(snap.lastPlayback?.position, "12:34 / 2:00:00");
    assert.equal(snap.lastPlayback?.rebuffers, 1);

    // Mid-playback subtitle/track changes preserve accumulated rebuffers; only beginPlaybackSession resets them.
    collector.recordPlaybackStats(
        {
            nowPlaying: [],
            playback: [{ label: "Playback", value: "Transcoded · MKV" }, { label: "Subtitles", value: "Off" }],
            stream: [{ label: "Playback status", value: "Playing" }],
            engine: [{ label: "Delivery", value: "Server Transcode HLS" }],
        },
    );
    assert.equal(collector.snapshot().lastPlayback?.rebuffers, 1, "track changes within the same playback must preserve rebuffer count");
    collector.beginPlaybackSession();
    collector.recordPlaybackStats({
        nowPlaying: [],
        playback: [{ label: "Playback", value: "Transcoded · MKV" }],
        stream: [{ label: "Playback status", value: "Playing" }],
        engine: [{ label: "Delivery", value: "Server Transcode HLS" }],
    });
    assert.equal(collector.snapshot().lastPlayback?.rebuffers, undefined, "new playback session resets rebuffer count");

    // Local unchanged-snapshot guard catches duplicate manual sends in 0ms, and honours explicit submittedHash.
    assert.equal(collector.duplicateSendReportId("playback"), undefined);
    const submittedHash = collector.stableSnapshotHash("playback");
    collector.recordEvent("app", "new event arriving while POST is in flight");
    collector.markManualSent("playback", "AUG-901", submittedHash);
    assert.equal(collector.duplicateSendReportId("playback"), undefined, "events arriving during in-flight send must not be marked already sent");
    collector.markManualSent("playback", "AUG-902");
    assert.equal(collector.duplicateSendReportId("playback"), "AUG-902");
    assert.equal(collector.duplicateSendReportId("buffering"), undefined, "switching category allows sending with new context");

    // Opt-in auto-reporting persists delivered fingerprints only after success and distinguishes distinct app errors.
    collector.setAutoReportEnabled(true);
    assert.equal(storage.getItem("auger.diagnostics.autoReport"), "1");
    collector.recordPlaybackError("terminal", "source_unreadable", { positionSeconds: 754, durationSeconds: 7200 });
    const playbackFp = diagnosticsFingerprint(collector.snapshot(), undefined, "playback");
    assert.equal(collector.canAutoReport(playbackFp), true);
    // Failed attempt triggers cooldown without permanently suppressing the fingerprint.
    collector.markAutoAttempt();
    assert.equal(collector.canAutoReport(playbackFp), false, "15-minute cooldown throttles retries after failed attempt");
    clock.set(clock.now() + AUTO_REPORT_COOLDOWN_MS + 1000);
    assert.equal(collector.canAutoReport(playbackFp), true, "failed attempt does not permanently suppress fingerprint");
    collector.markAutoDelivered(playbackFp);
    clock.set(clock.now() + AUTO_REPORT_COOLDOWN_MS + 1000);
    assert.equal(collector.canAutoReport(playbackFp), false, "delivered fingerprint stays suppressed for this app version");

    // Distinct app errors receive distinct fingerprints even after playback errors.
    collector.recordAppError("TypeError");
    const typeErrFp = diagnosticsFingerprint(collector.snapshot(), undefined, "app");
    collector.recordAppError("RangeError");
    const rangeErrFp = diagnosticsFingerprint(collector.snapshot(), undefined, "app");
    assert.notEqual(typeErrFp, playbackFp);
    assert.notEqual(typeErrFp, rangeErrFp);
    assert.equal(collector.canAutoReport(rangeErrFp), true);

    // A fresh collector backed by the same storage restores opt-in and remembers previously delivered fingerprints.
    const reloaded = new DiagnosticsCollector({ appVersion: "0.3.0", tvModel: "QE65S95C", firmware: "1650" }, clock, storage);
    assert.equal(reloaded.autoReportEnabled, true);
    reloaded.recordPlaybackError("terminal", "source_unreadable", { positionSeconds: 754, durationSeconds: 7200 });
    assert.equal(reloaded.canAutoReport(diagnosticsFingerprint(reloaded.snapshot(), undefined, "playback")), false, "persisted fingerprint dedup survives app restarts");
});

test("playback failure diagnostics capture AVPlay error codes, route fallbacks, HDR setting, distinct fingerprints, and strict Worker allowlisting", async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 25, 3, 0, 0));
    const collector = new DiagnosticsCollector({ appVersion: "0.4.0", tvModel: "QE65S95C", firmware: "1650" }, clock);
    collector.recordPlaybackStats(
        {
            nowPlaying: [],
            playback: [{ label: "Playback", value: "Direct play · MKV" }],
            stream: [{ label: "Playback status", value: "Playing" }],
            engine: [{ label: "Delivery", value: "Original HTTP" }],
        },
        {
            source: { container: "mkv", videoCodec: "hevc", width: 3840, height: 2160, frameRate: 23.976, dynamicRange: "hdr10", dolbyVisionProfile: undefined },
            hdrEnabled: true,
            avplayError: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT",
            routeFallbacks: 1,
        },
    );
    collector.recordPlaybackError("playback_failed", "", {
        hdrEnabled: true,
        avplayError: "prepareAsync:NotSupportedError",
        routeFallbacks: 2,
        positionSeconds: 15,
        durationSeconds: 3600,
    });

    const snap = collector.snapshot();
    assert.equal(snap.lastPlayback?.hdrEnabled, true);
    assert.equal(snap.lastPlayback?.routeFallbacks, 2);
    assert.equal(snap.lastPlayback?.avplayError, "prepareAsync:NotSupportedError");
    assert.ok(snap.events.some(event => event.text.includes("error playback_failed (prepareAsync:NotSupportedError)")));

    const url = buildDiagnosticsReportUrl(snap);
    const decoded = decodeDiagnosticsReportHash(url.slice(url.indexOf("#")));
    assert.equal(decoded?.play?.hdr, true);
    assert.equal(decoded?.play?.fb, 2);
    assert.equal(decoded?.play?.av, "prepareAsync:NotSupportedError");
    const discord = formatDiscordDiagnostics(decoded!);
    assert.ok(discord.includes("HDR setting: On"));
    assert.ok(discord.includes("Route fallbacks: 2"));
    assert.ok(discord.includes("AVPlay error: prepareAsync:NotSupportedError"));
    const github = new URL(buildGitHubBugReportUrl(decoded!));
    assert.ok(github.searchParams.get("playback-details")?.includes("AVPlay error: prepareAsync:NotSupportedError"));

    // Distinct AVPlay error codes under playback_failed produce distinct fingerprints.
    const fpNotSupported = diagnosticsFingerprint(snap, "playback", "playback");
    collector.recordPlaybackError("playback_failed", "", { avplayError: "startup_timeout", routeFallbacks: 2, hdrEnabled: true });
    const fpTimeout = diagnosticsFingerprint(collector.snapshot(), "playback", "playback");
    assert.notEqual(fpNotSupported, fpTimeout, "different AVPlay failure codes must not collapse into the same fingerprint");

    // Starting a new playback session prevents a pre-stats failure from inheriting the previous session's AVPlay error or fallbacks.
    collector.beginPlaybackSession();
    collector.recordPlaybackError("playback_failed", "");
    assert.equal(collector.snapshot().lastPlayback?.avplayError, undefined, "new playback session must not inherit previous AVPlay error");
    assert.equal(collector.snapshot().lastPlayback?.routeFallbacks, undefined, "new playback session must not inherit previous fallback count");
    assert.equal(collector.snapshot().lastPlayback?.playback, undefined, "new playback session must not inherit previous playback summary");

    // Generic redactor keeps LONG_TOKEN_PATTERN unconditional (even for PLAYER_ERROR_-prefixed strings),
    // while trusted recordAvplayEvent preserves only explicitly allowlisted Samsung AVPlayError constants.
    const genericRedacted = redactDiagnosticText("secret PLAYER_ERROR_SECRET_TOKEN_1234567890 and PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
    assert.ok(!genericRedacted.includes("PLAYER_ERROR_SECRET_TOKEN_1234567890"), genericRedacted);
    assert.ok(!genericRedacted.includes("PLAYER_ERROR_NOT_SUPPORTED_FORMAT"), genericRedacted);
    collector.recordAvplayEvent("PLAYER_ERROR_NOT_SUPPORTED_FORMAT", 1);
    collector.recordAvplayEvent("PLAYER_ERROR_SECRET_TOKEN_1234567890", 2);
    const avEvents = collector.snapshot().events.map(event => event.text);
    assert.ok(avEvents.includes("avplay PLAYER_ERROR_NOT_SUPPORTED_FORMAT (fallback #1)"), JSON.stringify(avEvents));
    assert.ok(!avEvents.some(text => text.includes("PLAYER_ERROR_SECRET_TOKEN")), JSON.stringify(avEvents));
    collector.recordPlaybackError("playback_failed", "", { avplayError: "open:SecretToken12345678901234567890" });
    assert.equal(collector.snapshot().lastPlayback?.avplayError, "open:error");

    const posted: { url: string; body: Record<string, unknown> }[] = [];
    const openIssues: { number: number; body: string; comments: number }[] = [];
    let nextIssue = 910;
    const fakeFetch = async (target: string, init?: RequestInit): Promise<Response> => {
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && target.includes("/issues?state=open&labels=diagnostics")) {
            return new Response(JSON.stringify(openIssues), { status: 200 });
        }
        if (method === "GET" && target.includes("/comments?per_page=10")) {
            return new Response(JSON.stringify([]), { status: 200 });
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posted.push({ url: target, body });
        if (method === "POST" && target.endsWith("/issues")) {
            const num = nextIssue++;
            openIssues.push({ number: num, body: String(body.body ?? ""), comments: 0 });
            return new Response(JSON.stringify({ number: num }), { status: 201 });
        }
        return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    };
    const env = { GITHUB_TOKEN: "test-secret-not-real", GITHUB_REPO: "Artic0din/Auger-Tizen" };

    const first = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.1" },
            body: JSON.stringify({
                v: 1,
                app: "0.4.0",
                tv: "QE65S95C",
                cat: "playback",
                play: { e: "playback_failed", hdr: true, fb: 2, av: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT" },
                log: [
                    "03:00:00 [playback] avplay PLAYER_ERROR_NOT_SUPPORTED_FORMAT (fallback #1)",
                    "03:00:01 [app] leak PLAYER_ERROR_SECRET_TOKEN_1234567890",
                ],
            }),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(first.status, 201);
    const firstBody = String(posted[0]?.body.body ?? "");
    assert.ok(firstBody.includes("| HDR setting | On |"));
    assert.ok(firstBody.includes("| Route fallbacks | 2 |"));
    assert.ok(firstBody.includes("| AVPlay error | PLAYER_ERROR_NOT_SUPPORTED_FORMAT |"));
    assert.ok(firstBody.includes("03:00:00 [playback] avplay PLAYER_ERROR_NOT_SUPPORTED_FORMAT (fallback #1)"));
    assert.ok(!firstBody.includes("PLAYER_ERROR_SECRET_TOKEN_1234567890"));

    // Same AVPlay code with HDR toggled Off posts a diff comment on #910 showing HDR setting change.
    const hdrDiff = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.2" },
            body: JSON.stringify({
                v: 1,
                app: "0.4.0",
                tv: "QE65S95C",
                cat: "playback",
                play: { e: "playback_failed", hdr: false, fb: 2, av: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT" },
            }),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(hdrDiff.status, 200);
    assert.deepEqual(await hdrDiff.json(), { ok: true, status: "updated", issueNumber: 910, reportId: "AUG-910" });
    assert.ok(String(posted[1]?.body.body ?? "").includes("**HDR setting:** `On` → `Off`"));

    // A second valid AVPlay code (startup_timeout) opens a separate issue (#911) distinct from PLAYER_ERROR_NOT_SUPPORTED_FORMAT (#910).
    const secondValid = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.3" },
            body: JSON.stringify({
                v: 1,
                app: "0.4.0",
                tv: "QE65S95C",
                cat: "playback",
                play: { e: "playback_failed", hdr: true, fb: 3, av: "startup_timeout" },
            }),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(secondValid.status, 201);
    assert.deepEqual(await secondValid.json(), { ok: true, status: "created", issueNumber: 911, reportId: "AUG-911" });
    const secondValidBody = String(posted[2]?.body.body ?? "");
    assert.ok(secondValidBody.includes("| AVPlay error | startup_timeout |"));

    // Unrecognized PLAYER_ERROR_-prefixed or token-like raw av values are dropped at the Worker boundary (#912).
    const droppedToken = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.4" },
            body: JSON.stringify({
                v: 1,
                app: "0.4.0",
                tv: "QE65S95C",
                cat: "playback",
                play: { e: "playback_failed", av: "PLAYER_ERROR_SECRET_TOKEN_1234567890" },
            }),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(droppedToken.status, 201);
    assert.deepEqual(await droppedToken.json(), { ok: true, status: "created", issueNumber: 912, reportId: "AUG-912" });
    const droppedBody = String(posted[3]?.body.body ?? "");
    assert.ok(!droppedBody.includes("PLAYER_ERROR_SECRET_TOKEN_1234567890"), "unrecognized PLAYER_ERROR_* token must be dropped");
    assert.ok(!droppedBody.includes("| AVPlay error |"));

    const stageFallback = await handleRequest(
        new Request("https://auger-diagnostics.plaintextlab.com/report", {
            method: "POST",
            headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.5" },
            body: JSON.stringify({
                v: 1,
                app: "0.4.0",
                tv: "QE65S95C",
                cat: "playback",
                play: { e: "playback_failed", av: "open:SecretToken12345678901234567890" },
            }),
        }),
        env,
        { fetch: fakeFetch },
    );
    assert.equal(stageFallback.status, 201);
    const stageBody = String(posted[4]?.body.body ?? "");
    assert.ok(!stageBody.includes("SecretToken12345678901234567890"));
    assert.ok(stageBody.includes("| AVPlay error | open:error |"));
});

test("readRuntimeEnvironment formats Chromium memory, device RAM, and screen when present and omits missing metrics", () => {
    const origPerf = Object.getOwnPropertyDescriptor(globalThis, "performance");
    const origNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const origScreen = Object.getOwnPropertyDescriptor(globalThis, "screen");
    try {
        Object.defineProperty(globalThis, "performance", { configurable: true, value: { memory: { usedJSHeapSize: 64 * 1024 * 1024, totalJSHeapSize: 128 * 1024 * 1024, jsHeapSizeLimit: 512 * 1024 * 1024 } } });
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: { deviceMemory: 4 } });
        Object.defineProperty(globalThis, "screen", { configurable: true, value: { width: 1920, height: 1080 } });
        assert.deepEqual(readRuntimeEnvironment(), {
            memory: "64 / 128 MB (limit 512 MB)",
            deviceRam: "4 GB",
            screen: "1920x1080",
        });

        Object.defineProperty(globalThis, "performance", { configurable: true, value: {} });
        Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
        Object.defineProperty(globalThis, "screen", { configurable: true, value: undefined });
        assert.deepEqual(readRuntimeEnvironment(), {});
    } finally {
        if (origPerf) Object.defineProperty(globalThis, "performance", origPerf);
        if (origNav) Object.defineProperty(globalThis, "navigator", origNav);
        if (origScreen) Object.defineProperty(globalThis, "screen", origScreen);
        else delete (globalThis as Record<string, unknown>).screen;
    }
});
