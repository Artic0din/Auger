// The audiobook detail and its chapter picker in the shown language (silo-apple Screens/Detail/AudiobookDetailFormatting.swift and
// tvOS/Screens/Detail/TVAudiobook*.swift at d49d7bd): each line reads Apple's key, runtimes and clock times use the language's
// words and digits, names inside a sentence are isolated for right-to-left text, and English is the text it always was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Audiobook, AudiobookDetail } from "../../src/contracts/v2/audiobooks.ts";
import { durationText } from "../../src/i18n/duration.ts";
import { localizeNumerals, percentText } from "../../src/i18n/format.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { integerText } from "../../src/i18n/numbers.ts";
import { translate } from "../../src/i18n/translate.ts";
import { audiobookPage, formatHMS, formatRuntime, peopleSummary, seriesLine } from "../../src/ui/audiobookDetail.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const FSI = "⁨";
const PDI = "⁩";
const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
const person = (name: string) => ({ name, personId: undefined, photoUrl: undefined });
const DETAIL: AudiobookDetail = {
    authors: [person("Brandon Sanderson")], narrators: [person("Michael Kramer"), person("Kate Reading")], publisher: undefined, totalDurationSeconds: undefined,
    series: { name: "The Stormlight Archive", entries: [] }, otherNarrations: [], alsoByAuthor: [], similar: [],
};
const book = (overrides: Partial<Audiobook> = {}): Audiobook => ({
    id: "audiobook:tide", title: "Stormlight Archive 5 - The Tide Owes (5 of 5)", overview: undefined, year: undefined, genres: ["Fantasy"], posterUrl: undefined, position: 4112, played: false, duration: 10800,
    parts: [{ fileId: "1", duration: 10800, offset: 0 }],
    chapters: [{ title: "Opening", start: 0, end: 3600, partIndex: 0 }, { title: "What the Tide Owes", start: 3600, end: 7200, partIndex: 0 }, { title: "", start: 7200, end: 10800, partIndex: 0 }],
    detail: DETAIL, ...overrides,
});
const t = (key: Parameters<typeof translate>[0], tag: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, tag);
const iso = (name: string, tag: string): string => tag === "ar" ? `${FSI}${name}${PDI}` : name;

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

test("every catalog key the audiobook detail reads is in the German and Arabic files", () => {
    const keys = new Set<string>();
    for (const name of ["audiobookDetail.ts", "audiobookView.ts", "detailsActions.ts"]) {
        const source = readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), "utf8");
        for (const [, key] of source.matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)"/g)) {
            if (key !== undefined && Object.hasOwn(english, key) && /^(detail\.(audiobook|facts|resume|playAgain|startOver|released|overviewMore|favorite|more\.)|common\.play)/.test(key)) keys.add(key);
        }
    }
    assert.ok(keys.size >= 30, `the page reads ${keys.size} keys`);
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        assert.deepEqual([...keys].filter(key => !Object.hasOwn(catalog, key)), [], `${tag} lacks keys the page reads`);
    }
});

test("English reads exactly as before", () => {
    const page = audiobookPage(book());
    assert.equal(page.eyebrow, "AUDIOBOOK · FANTASY");
    assert.equal(page.seriesLine, "The Stormlight Archive · Book 5 of 5");
    assert.deepEqual(page.state, { kind: "inProgress", fraction: 4112 / 10800, percent: 38, line1: "Chapter 2 · What the Tide Owes", line2: "8:32 into the chapter · 1h 51m left in the book" });
    assert.equal(page.picker.subline, "38% · Chapter 2 of 3 · 1h 51m left");
    assert.equal(page.picker.rows[2]?.title, "Chapter 3");
    assert.equal(peopleSummary(["A", "B", "C", "D", "E"], 2), "A, B & 3 more");
    assert.equal(formatRuntime(5 * 3600 + 28 * 60), "5h 28m");
});

for (const tag of ["de", "ar"]) {
    test(`the page reads ${tag}: eyebrow, series line, state, primary action and chapter picker`, () => inLanguage(tag, () => {
        const page = audiobookPage(book());
        assert.equal(page.eyebrow, t("detail.audiobook.labelWithGenre", tag, { genre: "FANTASY" }));
        assert.equal(page.seriesLine, t("detail.audiobook.seriesLineOf", tag, { series: iso("The Stormlight Archive", tag), number: integerText(5), total: integerText(5) }));
        const left = durationText(111, false, tag);
        assert.deepEqual(page.state, {
            kind: "inProgress", fraction: 4112 / 10800, percent: 38,
            line1: t("detail.audiobook.currentChapter", tag, { number: integerText(2), title: iso("What the Tide Owes", tag) }),
            line2: `${t("detail.audiobook.intoChapter", tag, { time: localizeNumerals("8:32") })} · ${t("detail.audiobook.leftInBook", tag, { time: left })}`,
        });
        assert.equal(page.primary.label, t("detail.resume", tag));
        assert.equal(page.picker.subline, [percentText(38), t("detail.audiobook.chapterOf", tag, { number: integerText(2), total: integerText(3) }), t("detail.audiobook.timeLeft", tag, { time: left })].join(" · "));
        assert.equal(page.picker.rows[2]?.title, t("detail.audiobook.chapter", tag, { number: integerText(3) }), "a chapter with no title is named by its number");
        assert.notEqual(page.state.line1, "Chapter 2 · What the Tide Owes");
    }));

    test(`the not-started, finished and part lines read ${tag}`, () => inLanguage(tag, () => {
        const fresh = audiobookPage(book({ position: 0 }));
        assert.equal(fresh.state.line1, t("detail.audiobook.notStarted", tag));
        assert.equal(fresh.state.line2, [durationText(180, false, tag), t("detail.audiobook.chapterCount", tag, { count: 3, count_text: integerText(3) })].join(" · "));
        assert.equal(fresh.primary.label, t("common.play", tag));
        const done = audiobookPage(book({ played: true, position: 0 }));
        assert.equal(done.state.line1, t("detail.audiobook.finished", tag));
        assert.equal(done.primary.label, t("detail.playAgain", tag));
        const parts = audiobookPage(book({ position: 0, chapters: [], parts: [{ fileId: "1", duration: 5400, offset: 0 }, { fileId: "2", duration: 5400, offset: 5400 }] }));
        assert.equal(parts.picker.rows[1]?.title, t("detail.audiobook.part", tag, { number: integerText(2) }));
        assert.equal(parts.picker.subline, [t("detail.audiobook.partCount", tag, { count: 2, count_text: integerText(2) }), durationText(180, false, tag)].join(" · "));
    }));
}

test("in Arabic the digits of a clock time and a count are Arabic-Indic, and a list's overflow reads the catalog's words", () => inLanguage("ar", () => {
    assert.match(formatHMS(512), /^[٠-٩]+:[٠-٩]+$/);
    assert.match(formatRuntime(5 * 3600 + 28 * 60), /[٠-٩]/);
    assert.equal(peopleSummary(["A", "B", "C", "D", "E"], 2), t("detail.audiobook.peopleMore", "ar", { count: 3, names: iso("A, B", "ar") }));
    assert.equal(seriesLine("Mistborn", 2, undefined), t("detail.audiobook.seriesLine", "ar", { series: iso("Mistborn", "ar"), number: integerText(2) }));
}));
