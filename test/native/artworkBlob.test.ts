import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeHttp } from "../../src/api/http.ts";
import { parseServerUrl } from "../../src/api/serverUrl.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeSilo } from "./support/fakeSilo.ts";

const device = { id: "abababab", name: "Living room TV", platform: "tizen" };

function setup(): { clock: ManualClock; fake: FakeSilo; http: NativeHttp; inits: RequestInit[] } {
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const parsed = parseServerUrl(fake.origin);
    assert.ok(parsed.ok);
    const inits: RequestInit[] = [];
    const fetch = (url: string, init: RequestInit): Promise<Response> => { inits.push(init); return fake.fetch(url, init); };
    return { clock, fake, inits, http: new NativeHttp(parsed.base, device, fetch, clock) };
}

test("artwork bytes come back for the adapter-built URL, sent without credentials", async () => {
    const { fake, http, inits } = setup();
    fake.script("/art/backdrop.webp", { status: 200, text: "RIFFbytes" });
    const blob = await http.artworkBlob(`${http.base.baseUrl}/api/v2/art/backdrop.webp`, new AbortController().signal);
    assert.equal(await blob.text(), "RIFFbytes");
    assert.equal(inits[0]?.credentials, "omit");
    assert.equal(inits[0]?.mode, "cors");
});

test("artwork bytes are refused for a URL outside the server and for embedded credentials", async () => {
    const { fake, http } = setup();
    await assert.rejects(http.artworkBlob("http://other.example.test/art/backdrop.webp", new AbortController().signal), /Invalid artwork URL/);
    await assert.rejects(http.artworkBlob(`${http.base.baseUrl.replace("://", "://user:pw@")}/api/v2/art/backdrop.webp`, new AbortController().signal), /Invalid artwork URL/);
    await assert.rejects(http.artworkBlob("not a url", new AbortController().signal));
    assert.equal(fake.requests.length, 0, "nothing was sent");
});

test("artwork bytes fail on an error status or an oversized answer", async () => {
    const { fake, http } = setup();
    fake.script("/art/missing.webp", { status: 404, text: "no" });
    await assert.rejects(http.artworkBlob(`${http.base.baseUrl}/api/v2/art/missing.webp`, new AbortController().signal), /Artwork download failed/);
    fake.script("/art/huge.webp", { status: 200, text: "x", headers: { "Content-Length": String(64 * 1024 * 1024) } });
    await assert.rejects(http.artworkBlob(`${http.base.baseUrl}/api/v2/art/huge.webp`, new AbortController().signal), /Artwork download failed/);
});

test("artwork bytes stop when the caller leaves, and after the request deadline", async () => {
    const { clock, fake, http } = setup();
    const leave = new AbortController();
    leave.abort();
    await assert.rejects(http.artworkBlob(`${http.base.baseUrl}/api/v2/art/a.webp`, leave.signal));
    fake.hold("/art/slow.webp");
    let failure: unknown;
    const pending = http.artworkBlob(`${http.base.baseUrl}/api/v2/art/slow.webp`, new AbortController().signal).catch((error: unknown) => { failure = error; });
    await clock.advance(15000);
    await pending;
    assert.ok(failure instanceof Error, "a request with no answer fails at the 15 s deadline");
});
