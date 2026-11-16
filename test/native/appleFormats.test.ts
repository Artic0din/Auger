// Runtimes and track language names in the shown language, against what Apple's own formatters print
// (silo-apple dce56e3c: LocaleFormat.duration through MediaTextFormatting.runtime, TrackLabels.languageName).
// The fixtures are Foundation's output, written by scripts/duration-patterns.swift and scripts/language-names.swift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { durationText } from "../../src/i18n/duration.ts";
import { formattingLocale, SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { audioTitle, languageName } from "../../src/player/trackLabels.ts";
import { runtimeText } from "../../src/ui/cardPresentation.ts";
import { episodeRuntime } from "../../src/ui/episodeCaption.ts";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as T;
const durations = fixture<Record<string, Record<string, string>>>("appleDurations");
const names = fixture<Record<string, { track: Record<string, string> }>>("appleLanguageNames");
const locale = (language: string): string => formattingLocale(language, "en-AU");

function inLanguage<T>(tag: string, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

test("a runtime reads as Apple's duration formatter writes it, in every shipped language", () => {
    assert.deepEqual(Object.keys(durations).sort(), [...SHIPPED_LANGUAGES].sort());
    for (const [language, samples] of Object.entries(durations)) {
        assert.equal(durationText(45, true, language, locale(language)), samples["45"], `${language} 45 min`);
        assert.equal(durationText(60, true, language, locale(language)), samples["60"], `${language} 1 h`);
        assert.equal(durationText(128, true, language, locale(language)), samples["128"], `${language} 2 h 8 min`);
        assert.equal(durationText(120, false, language, locale(language)), samples["120hidden"], `${language} 2 h, zero minutes hidden`);
    }
});

test("English runtimes are the ones the screens already show", () => {
    assert.deepEqual([45, 60, 135].map(minutes => durationText(minutes, true, "en", "en-AU")), ["45m", "1h 0m", "2h 15m"]);
    assert.deepEqual([0, 45, 60, 135].map(runtimeText), [undefined, "45m", "1h 0m", "2h 15m"]);
    assert.deepEqual([0, 52, 92].map(episodeRuntime), [undefined, "52m", "1h 32m"]);
});

test("Details and episode runtimes follow the shown language: 2h 8min in German", () => {
    inLanguage("de", () => {
        assert.equal(runtimeText(128), "2h 8min");
        assert.equal(episodeRuntime(128), "2h 8min");
        assert.equal(runtimeText(45), "45min");
    });
    inLanguage("ja", () => assert.equal(runtimeText(128), "2時間8分"));
});

test("a track's language is named in the shown language, as Apple names it", () => {
    for (const [language, { track }] of Object.entries(names)) {
        for (const [code, name] of Object.entries(track)) assert.equal(languageName(code, language), name, `${code} in ${language}`);
    }
    inLanguage("de", () => {
        assert.equal(languageName("pt"), "Portugiesisch");
        assert.equal(languageName("por"), "Portugiesisch", "a three-letter code folds to the same language");
        assert.equal(languageName("pt-BR"), "Portugiesisch", "Apple names the track's language, not its region");
    });
    assert.equal(languageName("pt"), "Portuguese");
});

test("a language Apple cannot name keeps its code, and free text stays as written", () => {
    inLanguage("de", () => {
        assert.equal(languageName("zz"), "ZZ");
        assert.equal(languageName("und"), undefined);
        assert.equal(languageName("commentary track"), "Commentary Track");
    });
});

test("a track title that repeats the language drops it in the shown language and in English", () => {
    inLanguage("de", () => {
        assert.equal(audioTitle("Portugiesisch Director's Commentary", "pt"), "Director's Commentary");
        assert.equal(audioTitle("Portuguese Director's Commentary", "pt"), "Director's Commentary");
    });
});
