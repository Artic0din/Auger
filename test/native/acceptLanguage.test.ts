// Every Silo request names the language the app shows, as silo-apple's AppLanguage.applyHeader does:
// `Accept-Language: <shipped tag>`, a bare tag with no weights.
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverServer } from "../../src/api/discovery.ts";
import { NativeHttp, type RequestSpec } from "../../src/api/http.ts";
import { operations } from "../../src/api/operations.ts";
import { subtitleOperations } from "../../src/api/subtitleOperations.ts";
import { parseServerUrl } from "../../src/api/serverUrl.ts";
import { setAppLanguage } from "../../src/i18n/language.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSilo } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

const device = { id: "abababab", name: "Living room TV", platform: "tizen" };

function setup(): { clock: ManualClock; fake: FakeSilo; http: NativeHttp } {
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const parsed = parseServerUrl(fake.origin);
    assert.ok(parsed.ok);
    return { clock, fake, http: new NativeHttp(parsed.base, device, fake.fetch, clock) };
}

function languages(fake: FakeSilo): (string | undefined)[] {
    return fake.requests.map(request => request.headers["accept-language"]);
}

test("every request the adapter sends carries the shown language: operations, resources, subtitle downloads and discovery", async () => {
    setAppLanguage("es", ["en", "es"], ["en-AU"]);
    try {
        const { clock, fake, http } = setup();
        await http.send(operations.logout()).catch(() => undefined);
        fake.script("/stream/s/subtitles/9.vtt", { status: 200, text: "WEBVTT" });
        await http.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal);
        await http.fetchResource(`${http.base.baseUrl}/api/v2/stream/s/segment`, { bearer: "token" }).catch(() => undefined);
        await discoverServer(fake.origin, device, fake.fetch, clock);
        assert.ok(fake.requests.length >= 5, `${fake.requests.length} requests`);
        assert.deepEqual(languages(fake), fake.requests.map(() => "es"));
    } finally { setAppLanguage(null); }
});

test("a language change reaches the next request on a connection already open", async () => {
    try {
        setAppLanguage("en", ["en", "es"], ["en-AU"]);
        const { fake, http } = setup();
        await http.send(operations.logout()).catch(() => undefined);
        setAppLanguage("es", ["en", "es"], ["en-AU"]);
        await http.send(operations.logout()).catch(() => undefined);
        assert.deepEqual(languages(fake), ["en", "es"]);
    } finally { setAppLanguage(null); }
});

test("a build that ships only English sends the matched device language, never an unshipped one", async () => {
    try {
        setAppLanguage("es", ["en"], ["es-AR"]);
        const { fake, http } = setup();
        await http.send(operations.logout()).catch(() => undefined);
        assert.deepEqual(languages(fake), ["en"]);
    } finally { setAppLanguage(null); }
});

test("sign-in and the profile list through the session carry it too", async () => {
    setAppLanguage(null);
    const h = await connected();
    await signIn(h);
    await h.core.profiles.list();
    assert.ok(h.fake.requests.length > 0);
    assert.deepEqual(languages(h.fake), h.fake.requests.map(() => "en"));
});

test("subtitle sync reads and writes, and a fresh subtitle download, carry it beside their own headers", async () => {
    setAppLanguage("es", ["en", "es"], ["en-AU"]);
    try {
        const { fake, http } = setup();
        const specs: readonly RequestSpec<unknown>[] = [subtitleOperations.subtitleSyncStatus(), subtitleOperations.subtitleSyncRead("f1", "k1"), subtitleOperations.subtitleSyncStart("f1", "k1"), subtitleOperations.subtitleTimingReset("f1", "k1", "etag-1")];
        for (const spec of specs) await http.send(spec).catch(() => undefined);
        fake.script("/stream/s/subtitles/9.vtt", { status: 200, text: "WEBVTT" });
        await http.subtitleText(`${http.base.baseUrl}/api/v2/stream/s/subtitles/9.vtt`, new AbortController().signal, true);
        assert.equal(fake.requests.length, 5);
        assert.deepEqual(languages(fake), fake.requests.map(() => "es"));
        assert.equal(fake.requests[3]?.headers["if-match"], "etag-1", "the write keeps its validator");
    } finally { setAppLanguage(null); }
});
