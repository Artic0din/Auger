import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverServer } from "../../src/api/discovery.ts";
import { ApiError } from "../../src/api/errors.ts";
import { NativeHttp, SubtitleTruncated } from "../../src/api/http.ts";
import { operations } from "../../src/api/operations.ts";
import { isPermittedUrl, parseServerUrl, plainHttpFallbacks } from "../../src/api/serverUrl.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSilo, fixture } from "./support/fakeSilo.ts";

const device = { id: "abababab", name: "Living room TV", platform: "tizen" };

for (const abort of [false, true]) test(`connection verification respects request ${abort ? "cancellation" : "deadline"}`, async () => {
    const { clock, fake, http } = setup();
    let release = (): void => {};
    const checking = new Promise<void>(resolve => { release = resolve; });
    const guarded = new NativeHttp(http.base, device, fake.fetch, clock, () => checking);
    const controller = new AbortController();
    let failure: string | undefined;
    const pending = guarded.send({ ...operations.logout(), retry: "never", timeoutMs: 5000, signal: controller.signal }).catch((error: unknown) => {
        assert.ok(error instanceof ApiError);
        failure = error.failure.kind;
    });
    await clock.advance(0);
    if (abort) controller.abort();
    await clock.advance(abort ? 0 : 5000);
    const observed = failure;
    release();
    await pending;
    assert.equal(observed, abort ? "aborted" : "timeout");
    assert.equal(fake.requests.length, 0, "a late verification never dispatches the abandoned request");
});

function setup(): { clock: ManualClock; fake: FakeSilo; http: NativeHttp } {
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const parsed = parseServerUrl(fake.origin);
    assert.ok(parsed.ok);
    return { clock, fake, http: new NativeHttp(parsed.base, device, fake.fetch, clock) };
}

test("server addresses: HTTPS by default, typed HTTP kept, path prefix kept, no credentials, query or API path", () => {
    assert.deepEqual(parseServerUrl(" silo.example.test/media/ "), {
        ok: true,
        base: { origin: "https://silo.example.test", baseUrl: "https://silo.example.test/media", apiRoot: "https://silo.example.test/media/api/v2" },
    });
    assert.deepEqual(parseServerUrl("HTTP://192.168.1.20:8091/"), {
        ok: true,
        base: { origin: "http://192.168.1.20:8091", baseUrl: "http://192.168.1.20:8091", apiRoot: "http://192.168.1.20:8091/api/v2" },
    });
    assert.deepEqual(parseServerUrl("ftp://silo.example.test"), { ok: false, problem: "unsupported_scheme" });
    assert.deepEqual(parseServerUrl("https://user:pw@silo.example.test"), { ok: false, problem: "has_credentials" });
    assert.deepEqual(parseServerUrl("https://silo.example.test/?a=1"), { ok: false, problem: "has_query_or_fragment" });
    assert.deepEqual(parseServerUrl("https://silo.example.test/api/v2"), { ok: false, problem: "has_api_path" });
    assert.deepEqual(parseServerUrl(""), { ok: false, problem: "empty" });
});

test("a scheme-less address falls back to plain HTTP like the Apple TV app: same port, then 8090", () => {
    assert.deepEqual(plainHttpFallbacks("silo.example.test/media/"), ["http://silo.example.test/media", "http://silo.example.test:8090/media"]);
    assert.deepEqual(plainHttpFallbacks(" 192.168.1.20:8091 "), ["http://192.168.1.20:8091"]);
    assert.deepEqual(plainHttpFallbacks("192.168.1.20:443"), ["http://192.168.1.20:443"]);
    assert.deepEqual(plainHttpFallbacks("https://silo.example.test"), [], "a typed scheme is never changed");
    assert.deepEqual(plainHttpFallbacks("http://silo.example.test"), []);
    assert.deepEqual(plainHttpFallbacks("silo.example.test/api"), []);
});

test("cleartext is allowed only from a plain-HTTP server, never as a downgrade from HTTPS", () => {
    const secure = parseServerUrl("https://silo.example.test");
    const plain = parseServerUrl("http://192.168.1.20:8091");
    assert.ok(secure.ok && plain.ok);
    assert.equal(isPermittedUrl(new URL("https://cdn.example.test/a.jpg"), secure.base.baseUrl), true);
    assert.equal(isPermittedUrl(new URL("http://silo.example.test/a.jpg"), secure.base.baseUrl), false);
    assert.equal(isPermittedUrl(new URL("http://192.168.1.20:8091/a.jpg"), plain.base.baseUrl), true);
    assert.equal(isPermittedUrl(new URL("https://cdn.example.test/a.jpg"), plain.base.baseUrl), true);
    assert.equal(isPermittedUrl(new URL("data:text/plain,x"), plain.base.baseUrl), false);
});

test("subtitle downloads may use cleartext only from a plain-HTTP server", async () => {
    const clock = new ManualClock();
    const plain = new FakeSilo(clock, undefined, "http://192.168.1.20:8091");
    const plainBase = parseServerUrl(plain.origin);
    assert.ok(plainBase.ok);
    plain.script("/captions", { status: 200, text: "WEBVTT" });
    const text = await new NativeHttp(plainBase.base, device, plain.fetch, clock).subtitleText(`${plain.origin}/api/v2/captions`, new AbortController().signal);
    assert.equal(text, "WEBVTT");
    const { http } = setup();
    await assert.rejects(http.subtitleText(`${plain.origin}/api/v2/captions`, new AbortController().signal), /Invalid subtitle URL/);
});

test("discovery checks api_major before any credential is sent and accepts differing request_origin", async () => {
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const ok = await discoverServer(fake.origin, device, fake.fetch, clock);
    assert.equal(ok.status, "connected");
    if (ok.status === "connected") {
        assert.equal(ok.server.serverId, fake.serverId);
    }
    assert.deepEqual(fake.paths(), ["GET /system/info", "GET /system/identity"]);
    assert.ok(fake.requests.every((request) => request.headers.authorization === undefined));

    const info = fixture("get_system_info_ok");
    const { request_origin: _omitted, ...withoutOrigin } = info;
    const httpOrigin = fake.origin.replace(/^https:/, "http:");
    for (const body of [{ ...info, request_origin: httpOrigin }, { ...info, request_origin: "https://elsewhere.example.test:8090" }, withoutOrigin]) {
        fake.script("/system/info", { status: 200, body });
        assert.equal((await discoverServer(fake.origin, device, fake.fetch, clock)).status, "connected");
    }

    fake.script("/system/info", { status: 200, body: { ...info, api_major: 1 } });
    assert.deepEqual(await discoverServer(fake.origin, device, fake.fetch, clock), { status: "not_silo_v2" });

    fake.script("/system/info", { status: 404, body: "not found", headers: { "Content-Type": "text/plain" } });
    assert.deepEqual(await discoverServer(fake.origin, device, fake.fetch, clock), { status: "not_silo_v2" });
});

test("every request carries device headers, refuses redirects, and sends JSON bodies", async () => {
    const { fake, http } = setup();
    await http.send(operations.startDeviceLogin("Living room TV", "tizen"));
    const request = fake.requests[0];
    assert.ok(request !== undefined);
    assert.equal(request.headers["x-silo-device-id"], "abababab");
    assert.equal(request.headers["x-silo-device-name"], "Living room TV");
    assert.equal(request.headers["x-silo-device-platform"], "tizen");
    assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.redirect, "error");
    assert.deepEqual(request.body, { device_name: "Living room TV", device_platform: "tizen" });
});

test("problem responses become typed errors with Retry-After", async () => {
    const { fake, http } = setup();
    fake.script("/auth/device/poll", { status: 429, headers: { "Content-Type": "application/problem+json", "Retry-After": "7" }, body: { type: "https://siloserver.org/docs/api/v2/problems/rate_limited", title: "Rate limited", status: 429, detail: "", instance: "urn:silo:request:1" } });
    await assert.rejects(http.send(operations.pollDeviceLogin("dev-x")), (error: unknown) => {
        return error instanceof ApiError && error.problemId === "rate_limited" && error.retryAfterSeconds === 7 && error.transient;
    });
});

test("safe reads retry once after a gateway failure; non-retryable operations never do", async () => {
    const { clock, fake, http } = setup();
    fake.script("/system/info", { status: 503, headers: { "Retry-After": "1" } });
    const read = http.send(operations.systemInfo());
    await clock.advance(1000);
    assert.equal((await read).apiMajor, 2);
    assert.equal(fake.paths().filter((path) => path === "GET /system/info").length, 2);

    const nonRetryable: [string, () => Promise<unknown>][] = [
        ["/auth/device/start", () => http.send(operations.startDeviceLogin("tv", "tizen"))],
        ["/auth/device/poll", () => http.send(operations.pollDeviceLogin("dev-x"))],
        ["/auth/refresh", () => http.send(operations.refreshSession("ref-x"))],
        ["/profiles/p-kid/verify-pin", () => http.send(operations.verifyProfilePin("p-kid", "1111"))],
    ];
    for (const [path, send] of nonRetryable) {
        fake.script(path, { status: 503 });
        const before = fake.requests.length;
        const sent = assert.rejects(send(), (error: unknown) => error instanceof ApiError && error.status === 503);
        await clock.advance(5000);
        await sent;
        assert.equal(fake.requests.length - before, 1, `${path} was sent once`);
    }
});

test("a request that outlives its timeout fails as timeout; a caller abort fails as aborted", async () => {
    const { clock, fake, http } = setup();
    fake.hold("/auth/device/poll");
    const timed = assert.rejects(
        http.send({ ...operations.pollDeviceLogin("dev-x"), timeoutMs: 2000 }),
        (error: unknown) => error instanceof ApiError && error.failure.kind === "timeout",
    );
    await clock.advance(2000);
    await timed;

    fake.hold("/auth/device/poll");
    const controller = new AbortController();
    const aborted = http.send({ ...operations.pollDeviceLogin("dev-x"), signal: controller.signal });
    controller.abort();
    await assert.rejects(aborted, (error: unknown) => error instanceof ApiError && error.aborted);
});

/** A sidecar whose body the test writes chunk by chunk, erroring like a real fetch when its request aborts. */
function streamedSubtitle(): { fetch: (url: string, init: RequestInit) => Promise<Response>; push: (text: string) => void; end: () => void; cut: () => void; cancelled: () => boolean } {
    let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { sink = controller; }, cancel() { cancelled = true; } });
    return {
        fetch: async (_url, init) => {
            init.signal?.addEventListener("abort", () => { cancelled = true; sink?.error(new DOMException("aborted", "AbortError")); }, { once: true });
            return new Response(body, { status: 200 });
        },
        push: text => sink?.enqueue(new TextEncoder().encode(text)),
        end: () => sink?.close(),
        cut: () => sink?.error(new TypeError("network error")),
        cancelled: () => cancelled,
    };
}

test("an embedded-track extract that keeps streaming past the old 15 s cap still loads", async () => {
    const { clock, http } = setup();
    const extract = streamedSubtitle();
    const streaming = new NativeHttp(http.base, device, extract.fetch, clock);
    let text: string | undefined;
    const pending = streaming.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal).then(value => { text = value; });
    extract.push("WEBVTT\n\n");
    for (let cue = 1; cue <= 6; cue++) {
        await clock.advance(50000);
        extract.push(`00:0${cue}.000 --> 00:0${cue}.500\nCue ${cue}\n\n`);
    }
    extract.end();
    await pending;
    assert.equal(text?.split("Cue ").length, 7, "every cue that arrived over five minutes is kept");
});

test("a subtitle download fails only after 60 s with no bytes", async () => {
    const { clock, http } = setup();
    const extract = streamedSubtitle();
    const streaming = new NativeHttp(http.base, device, extract.fetch, clock);
    let settled = false;
    const pending = streaming.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal).then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
    extract.push("WEBVTT\n\n");
    await clock.advance(59999);
    assert.equal(settled, false, "a quiet stretch under a minute is still waiting");
    assert.equal(extract.cancelled(), false);
    await clock.advance(1);
    assert.ok(await pending instanceof Error);
    assert.equal(extract.cancelled(), true);
});

test("leaving the subtitle cancels its download at once", async () => {
    const { clock, http } = setup();
    const extract = streamedSubtitle();
    const streaming = new NativeHttp(http.base, device, extract.fetch, clock);
    const leave = new AbortController();
    let failure: unknown;
    const pending = streaming.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, leave.signal).catch((error: unknown) => { failure = error; });
    extract.push("WEBVTT\n\n");
    await clock.advance(1000);
    leave.abort();
    await pending;
    assert.ok(failure instanceof Error);
    assert.equal(extract.cancelled(), true);
});

test("a streamed subtitle stops at 4 MiB", async () => {
    const { clock, http } = setup();
    const extract = streamedSubtitle();
    const streaming = new NativeHttp(http.base, device, extract.fetch, clock);
    let settled = false;
    const pending = streaming.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal).then(() => undefined, (error: unknown) => error).finally(() => { settled = true; });
    extract.push("x".repeat(4 * 1024 * 1024));
    await clock.advance(0);
    assert.equal(settled, false, "exactly 4 MiB is allowed");
    extract.push("x");
    const failure = await pending;
    assert.ok(failure instanceof Error && /too large/.test(failure.message));
    assert.equal(extract.cancelled(), true);
});

test("a download the origin breaks off hands back what arrived", async () => {
    const { clock, http } = setup();
    const extract = streamedSubtitle();
    const streaming = new NativeHttp(http.base, device, extract.fetch, clock);
    const pending = streaming.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal).then(() => undefined, (error: unknown) => error);
    extract.push("WEBVTT\n\n00:01.000 --> 00:02.000\nOne\n\n");
    await clock.advance(10);
    extract.cut();
    const failure = await pending;
    assert.ok(failure instanceof SubtitleTruncated);
    assert.equal(failure.text, "WEBVTT\n\n00:01.000 --> 00:02.000\nOne\n\n");
});

test("a download that goes quiet for 60 s after its first bytes counts as cut", async () => {
    const { clock, http } = setup();
    const extract = streamedSubtitle();
    const streaming = new NativeHttp(http.base, device, extract.fetch, clock);
    const pending = streaming.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal).then(() => undefined, (error: unknown) => error);
    extract.push("WEBVTT\n\n");
    await clock.advance(60000);
    const failure = await pending;
    assert.ok(failure instanceof SubtitleTruncated);
    assert.equal(failure.text, "WEBVTT\n\n");
});

test("leaving, the size limit and a refused answer are not cuts", async () => {
    const { clock, http } = setup();
    const leaving = streamedSubtitle();
    const leave = new AbortController();
    const gone = new NativeHttp(http.base, device, leaving.fetch, clock).subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, leave.signal).then(() => undefined, (error: unknown) => error);
    leaving.push("WEBVTT\n\n");
    await clock.advance(10);
    leave.abort();
    assert.ok(!((await gone) instanceof SubtitleTruncated));
    const large = streamedSubtitle();
    const big = new NativeHttp(http.base, device, large.fetch, clock).subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal).then(() => undefined, (error: unknown) => error);
    large.push("x".repeat(4 * 1024 * 1024 + 1));
    assert.ok(!((await big) instanceof SubtitleTruncated));
    const refused = new NativeHttp(http.base, device, async () => new Response("", { status: 502 }), clock).subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal).then(() => undefined, (error: unknown) => error);
    assert.ok(!((await refused) instanceof SubtitleTruncated));
});

test("a playlist check reads only the head, stays on permitted origins and sends no headers (#650)", async () => {
    const { clock, http } = setup();
    let pulled = 0;
    const big = (_url: string, init: RequestInit): Promise<Response> => {
        assert.equal(init.headers, undefined, "AVPlay sends none, so the check sends none");
        assert.equal(init.redirect, "error");
        const line = new TextEncoder().encode(`#EXT-X-DEFINE:NAME="silo_query",VALUE="x"\n${"#EXTINF:2.0,\nsegment/seg.ts?{$silo_query}\n".repeat(1000)}`);
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull(stream) { pulled++; stream.enqueue(line); } }), { status: 200 }));
    };
    const reader = new NativeHttp(http.base, device, big, clock);
    const [head] = await reader.playlistHeads(`${http.base.baseUrl}/api/v2/stream/s?st=1`, new AbortController().signal);
    assert.match(head ?? "", /^#EXT-X-DEFINE/);
    assert.ok(pulled <= 3, `a long playlist is not read to its end (${pulled} reads)`);
    await assert.rejects(reader.playlistHeads("http://silo.example.test/api/v2/stream/s", new AbortController().signal), /Invalid playlist URL/);
});
