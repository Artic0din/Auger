// A subtitle download that ends early keeps its cues on screen and is fetched again on Apple's
// schedule (AetherEngine `decodeSidecarRetryingTruncation`, `sidecarTruncationRetryDelaysSeconds`).

import assert from "node:assert/strict";
import { test } from "node:test";
import { SubtitleTruncated } from "../../src/api/http.ts";
import { downloadSubtitle, SUBTITLE_REFETCH_DELAYS_MS } from "../../src/player/subtitleRefetch.ts";
import { ManualClock } from "./support/clock.ts";

const cuesOf = (text: string): readonly string[] => text === "" ? [] : text.split(",");

function rig(attempts: (() => string)[]): { clock: ManualClock; shown: (readonly string[])[]; fetched: () => number; abort: AbortController; run: Promise<readonly string[]> } {
    const clock = new ManualClock();
    const shown: (readonly string[])[] = [];
    const abort = new AbortController();
    let fetched = 0;
    const run = downloadSubtitle(clock, abort.signal, async () => attempts[Math.min(fetched++, attempts.length - 1)]!(), cuesOf, cues => { shown.push(cues); });
    return { clock, shown, fetched: () => fetched, abort, run };
}

const cut = (text: string) => (): string => { throw new SubtitleTruncated(text); };
const whole = (text: string) => (): string => text;
const failed = (): string => { throw new Error("Subtitle download failed"); };

test("Apple's refetch delays are 2, 5, 10, 10 and 10 seconds", () => {
    assert.deepEqual(SUBTITLE_REFETCH_DELAYS_MS, [2000, 5000, 10000, 10000, 10000]);
});

test("a download that ends early shows its cues at once and refetches after 2 s", async () => {
    const r = rig([cut("a,b"), whole("a,b,c,d")]);
    await r.clock.advance(0);
    assert.deepEqual(r.shown, [["a", "b"]], "the cues that arrived are on screen while it waits");
    assert.equal(r.fetched(), 1);
    await r.clock.advance(1999);
    assert.equal(r.fetched(), 1, "not before 2 s");
    await r.clock.advance(1);
    assert.deepEqual(await r.run, ["a", "b", "c", "d"]);
    assert.equal(r.fetched(), 2);
});

test("every cut waits its own delay and only a longer partial replaces the one on screen", async () => {
    const r = rig([cut("a,b,c"), cut("a"), cut("a,b,c,d"), cut("a,b,c,d"), cut("a,b,c,d,e"), whole("a,b,c,d,e,f")]);
    for (const [index, delay] of SUBTITLE_REFETCH_DELAYS_MS.entries()) {
        await r.clock.advance(delay - 1);
        assert.equal(r.fetched(), index + 1, `still waiting ${delay} ms`);
        await r.clock.advance(1);
    }
    assert.deepEqual(await r.run, ["a", "b", "c", "d", "e", "f"]);
    assert.equal(r.fetched(), 6);
    assert.deepEqual(r.shown.map(cues => cues.length), [3, 4, 5], "a smaller or equal partial never replaces the larger one");
});

test("after five refetches that all end early the largest partial is kept", async () => {
    const r = rig([cut("a,b,c"), cut("a"), cut("a,b"), cut("a"), cut("a"), cut("a")]);
    for (const delay of SUBTITLE_REFETCH_DELAYS_MS) await r.clock.advance(delay);
    assert.deepEqual(await r.run, ["a", "b", "c"]);
    assert.equal(r.fetched(), 6, "the first fetch and five refetches");
    await r.clock.advance(60000);
    assert.equal(r.fetched(), 6, "no seventh fetch");
});

test("a cut that delivered nothing still ends as a track, not a failure", async () => {
    const r = rig([cut("")]);
    for (const delay of SUBTITLE_REFETCH_DELAYS_MS) await r.clock.advance(delay);
    assert.deepEqual(await r.run, []);
    assert.deepEqual(r.shown, [[]]);
});

test("a first fetch that never got going fails as before, without a refetch", async () => {
    const r = rig([failed, whole("a")]);
    await assert.rejects(r.run, /Subtitle download failed/);
    await r.clock.advance(60000);
    assert.equal(r.fetched(), 1);
});

test("a refetch that fails outright after a cut is retried", async () => {
    const r = rig([cut("a"), failed, whole("a,b")]);
    await r.clock.advance(2000);
    await r.clock.advance(5000);
    assert.deepEqual(await r.run, ["a", "b"]);
    assert.equal(r.fetched(), 3);
});

test("leaving while waiting for a refetch stops it", async () => {
    const r = rig([cut("a"), whole("a,b")]);
    await r.clock.advance(1000);
    r.abort.abort();
    await assert.rejects(r.run);
    await r.clock.advance(60000);
    assert.equal(r.fetched(), 1);
});
