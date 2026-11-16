// A card's hero line and caption in the chosen language (silo-apple tvOS/Components/TVFocusMarquee.swift,
// Components/EpisodeCardCaption.swift, Shared/LocaleFormat.swift): the time left, the season and episode, the episode code and a length.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Card } from "../../src/contracts/v2/catalog.ts";
import { durationText } from "../../src/i18n/format.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { resolveMessage, type Catalogs, type MessageKey } from "../../src/i18n/translate.ts";
import { homeCaption, marqueeMeta, runtimeText } from "../../src/ui/cardPresentation.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const file = (tag: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
/** What Foundation's `Duration.UnitsFormatStyle` printed for 5, 45, 60, 102 and 135 minutes in each shipped language (Swift 6, macOS). */
const foundation = JSON.parse(readFileSync(new URL("support/foundationDurations.json", import.meta.url), "utf8")) as Record<string, Record<string, string>>;

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

const episode: Card = { id: "episode:e", type: "episode", title: "Fire Drill", year: 2026, posterUrl: undefined, seriesId: "series:s", seriesTitle: "Abbott", seasonNumber: 1, episodeNumber: 25, durationSeconds: 14400, positionSeconds: 2520 };

test("a length reads as Foundation writes it in every shipped language", () => {
    for (const language of SHIPPED_LANGUAGES) {
        const expected = foundation[language];
        assert.ok(expected, `${language} has a Foundation fixture`);
        for (const minutes of [5, 45, 60, 102, 135]) assert.equal(durationText(minutes, language, language), expected[String(minutes)], `${language} ${minutes} min`);
    }
    assert.equal(durationText(0), undefined);
    assert.equal(inLanguage("de", () => runtimeText(198)), "3h 18min");
    assert.equal(inLanguage("ar", () => runtimeText(102)), "١س ٤٢د", "Arabic reads in its own digits");
    assert.equal(inLanguage("da", () => runtimeText(5)), "5 m.", "Danish keeps its full stop");
    assert.equal(inLanguage(null, () => runtimeText(198)), "3h 18m");
});

test("the hero line's time left and season and episode, and the caption's episode code, read in German", () => {
    inLanguage("de", () => {
        // 14400 s long, 2520 s in: 3 h 18 min left.
        assert.deepEqual(marqueeMeta(episode, true), { lead: ["S1 F25", "Fire Drill", "4h 0min"], trailing: ["Noch 3h 18min"] });
        assert.deepEqual(marqueeMeta({ ...episode, episodeNumber: undefined }, false).lead.slice(0, 1), ["Staffel 1"]);
        assert.deepEqual(homeCaption(episode, false), { title: "Abbott", line: "S01F25 · Fire Drill" });
        assert.deepEqual(homeCaption({ ...episode, title: "abbott" }, false), { title: "Abbott", line: "S01F25" });
    });
    assert.deepEqual(marqueeMeta(episode, true), { lead: ["S1 E25", "Fire Drill", "4h 0m"], trailing: ["3h 18m left"] });
    assert.deepEqual(homeCaption(episode, false), { title: "Abbott", line: "S01E25 · Fire Drill" });
});

/** Every key these lines read, held to every shipped language and to the source text. */
const KEYS: readonly MessageKey[] = ["home.timeLeft", "home.seasonEpisode", "home.seasonOnly", "home.episodeOnly", "catalog.episodeTag", "detail.episodeCard.title"];
const ARGS = { season: "1", episode: "25", time: "3h 18m", code: "S01E25", title: "Pilot" };

test("each language holds these keys, and a language that lacks one shows the source text", () => {
    const english = file("en");
    for (const key of KEYS) {
        assert.ok(english[key] !== undefined, `${key} is in the English catalog`);
        for (const language of SHIPPED_LANGUAGES.filter(tag => tag !== "en")) assert.ok(file(language)[key] !== undefined, `${language} holds ${key}; run npm run sync:translations`);
        const catalogs: Catalogs = { en: english, xx: {} };
        assert.equal(resolveMessage(catalogs, key, "xx", ARGS), resolveMessage(catalogs, key, "en", ARGS), `${key} falls back to English`);
    }
});
