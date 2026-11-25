import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { setAppLanguage } from "../../src/i18n/language.ts";
import { registerCatalog } from "../../src/i18n/translate.ts";
import { endDate, withEndTime } from "../../src/player/endTime.ts";
import { episodeTag } from "../../src/player/playerScreen.ts";

const catalog = (tag: string): Record<string, string> =>
    JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;

afterEach(() => {
    setAppLanguage(null);
});

test("endDate computes wall-clock finish at playback speed and omits when nothing remains", () => {
    const now = new Date(2026, 10, 22, 19, 17, 34).getTime();
    assert.equal(endDate(now, 0, 1), undefined);
    assert.equal(endDate(now, -5, 1), undefined);
    assert.equal(endDate(now, Number.NaN, 1), undefined);
    assert.equal(endDate(now, 6446, 1)?.getTime(), now + 6446_000);
    assert.equal(endDate(now, 6446, 2)?.getTime(), now + 3223_000);
    assert.equal(endDate(now, 6446, 0)?.getTime(), now + 6446_000);
    assert.equal(endDate(now, 6446, -2)?.getTime(), now + 6446_000);
});

test("withEndTime appends localized Ends time and isolates RTL labels", () => {
    const now = new Date(2026, 10, 22, 19, 17, 34).getTime();
    assert.equal(withEndTime("−0:00", now, 0, 1), "−0:00");
    assert.equal(withEndTime("−1:47:26", now, 6446, 1), "−1:47:26 · Ends 9:05 PM");
    assert.equal(withEndTime("−1:47:26", now, 6446, 2), "−1:47:26 · Ends 8:11 PM");

    registerCatalog("ar", catalog("ar"));
    setAppLanguage("ar");
    const arabic = withEndTime("−1:47:26", now, 6446, 1);
    assert.ok(arabic.startsWith("−1:47:26 · \u2068") && arabic.endsWith("\u2069"), `expected isolated RTL label: ${arabic}`);
});

test("episodeTag uses catalog.episodeCaption and falls back to seasonShort or episodeShort", () => {
    assert.equal(episodeTag(1, 25), "S1 · E25");
    assert.equal(episodeTag(2, undefined), "S2");
    assert.equal(episodeTag(undefined, 7), "E7");
    assert.equal(episodeTag(undefined, undefined), undefined);

    registerCatalog("de", catalog("de"));
    setAppLanguage("de");
    assert.equal(episodeTag(1, 25), "S1 · F25");
    assert.equal(episodeTag(2, undefined), "S2");
    assert.equal(episodeTag(undefined, 7), "F7");

    registerCatalog("ar", catalog("ar"));
    setAppLanguage("ar");
    assert.equal(episodeTag(1, 25), "م1 · ح25");
});
