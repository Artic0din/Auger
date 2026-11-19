import assert from "node:assert/strict";
import { test } from "node:test";
import { aiMenu, aiRoute, DETECTED_LANGUAGE, hasActionableSource, quotaText, relyOnTranscription, type AIInputs } from "../../src/player/subtitleAIRoute.ts";

// SubtitleTranslateMenu (silo-apple main): one language choice picks translate, transcribe or transcribe and translate.
const base: AIInputs = {
    translateEnabled: true,
    transcribeEnabled: true,
    sources: [],
    audio: [{ index: 0, language: "ja", selected: true, isDefault: true }],
    quotaKnown: true,
    quotaExhausted: false,
};
const source = (index: number, language: string | undefined, extra: Partial<AIInputs["sources"][number]> = {}) => ({ index, language, selected: false, isDefault: false, ...extra });

test("the entry row needs a text track to translate or audio to transcribe, each with its capability", () => {
    assert.equal(hasActionableSource(base), true, "transcribe with audio");
    assert.equal(hasActionableSource({ ...base, transcribeEnabled: false }), false, "translation has no text track");
    assert.equal(hasActionableSource({ ...base, transcribeEnabled: false, sources: [source(1, "en")] }), true);
    assert.equal(hasActionableSource({ ...base, translateEnabled: false, transcribeEnabled: false, sources: [source(1, "en")] }), false);
    assert.equal(hasActionableSource({ ...base, audio: [] }), false);
    assert.equal(hasActionableSource({ ...base, audio: [], sources: [source(1, "en")] }), true);
});

test("a language with a text track in another language translates it, English first", () => {
    const inputs = { ...base, sources: [source(3, "fr", { selected: true }), source(2, "eng"), source(4, "de")] };
    assert.deepEqual(aiRoute(inputs, "es"), { kind: "translate", sourceIndex: 2, sourceLanguage: "eng", targetLanguage: "es" });
    const noEnglish = { ...base, sources: [source(3, "fr"), source(4, "de", { selected: true })] };
    assert.equal(aiRoute(noEnglish, "es")?.sourceIndex, 4, "the selected track next");
    assert.equal(aiRoute({ ...base, sources: [source(3, "fr"), source(4, "de", { isDefault: true })] }, "es")?.sourceIndex, 4, "then the default");
    assert.equal(aiRoute({ ...base, sources: [source(3, "fr"), source(4, "de")] }, "es")?.sourceIndex, 3, "then the first");
});

test("a track already in the target language is never the source, and one with no language is kept", () => {
    const inputs = { ...base, sources: [source(2, "eng")] };
    assert.equal(aiRoute(inputs, "en-US")?.kind, "transcribe_translate", "the same language is no source: the Japanese audio is transcribed and translated");
    const unknown = { ...base, sources: [source(2, undefined)] };
    assert.deepEqual(aiRoute(unknown, "en"), { kind: "translate", sourceIndex: 2, sourceLanguage: "", targetLanguage: "en" });
    assert.equal(aiRoute({ ...base, sources: [source(2, "und")] }, "en")?.kind, "translate");
});

test("with no text source the audio is transcribed, and translated unless the target is the spoken language", () => {
    assert.deepEqual(aiRoute(base, "ja"), { kind: "transcribe", sourceIndex: 0, sourceLanguage: "", targetLanguage: "" });
    assert.deepEqual(aiRoute(base, "en"), { kind: "transcribe_translate", sourceIndex: 0, sourceLanguage: "", targetLanguage: "en" });
    const spoken = { ...base, audio: [{ index: 0, language: "en", selected: false, isDefault: true }, { index: 1, language: "ja", selected: true, isDefault: false }] };
    assert.equal(aiRoute(spoken, "ja")?.kind, "transcribe", "the selected audio is the spoken one");
    assert.equal(aiRoute(spoken, "ja")?.sourceIndex, 1);
    assert.equal(aiRoute({ ...base, audio: [{ index: 5, language: "ja", selected: false, isDefault: false }, { index: 6, language: "en", selected: false, isDefault: true }] }, "ja")?.sourceIndex, 6, "else the default, else the first");
});

test("with translation off, a spoken language the catalog does not list is still suggested as the original language", () => {
    const transcribeOnly = { ...base, translateEnabled: false };
    const menu = aiMenu(transcribeOnly, ["en", "fr"], undefined);
    assert.deepEqual(menu.suggested.map(row => [row.code, row.hint, row.disabled]), [["ja", "Original language", false]], "transcription needs no catalog language");
    assert.deepEqual(aiRoute(transcribeOnly, "ja"), { kind: "transcribe", sourceIndex: 0, sourceLanguage: "", targetLanguage: "" });
    assert.deepEqual(aiMenu(base, ["en", "fr"], undefined).suggested, [], "with translation on, the server's list still decides: the row could translate to a target it cannot serve");
    assert.deepEqual(aiMenu(transcribeOnly, ["en", "ja"], undefined).suggested.map(row => row.code), ["ja"], "a listed one is not added twice");
    assert.equal(relyOnTranscription(transcribeOnly, []), true, "its row spends quota, so the quota line shows, even with an empty catalog");
});

test("transcription refuses what the server cannot serve", () => {
    assert.equal(aiRoute({ ...base, quotaExhausted: true }, "en"), undefined, "no quota left");
    assert.equal(aiRoute({ ...base, transcribeEnabled: false }, "en"), undefined);
    assert.equal(aiRoute({ ...base, audio: [] }, "en"), undefined);
    assert.equal(aiRoute({ ...base, translateEnabled: false }, "en"), undefined, "translating a transcript needs translation");
    assert.equal(aiRoute({ ...base, translateEnabled: false }, "ja")?.kind, "transcribe", "the spoken language needs only transcription");
    assert.equal(aiRoute({ ...base, quotaExhausted: true, sources: [source(1, "fr")] }, "en")?.kind, "translate", "an existing track still translates");
});

test("an unknown spoken language offers one Spoken language row when translation is off", () => {
    const off = { ...base, translateEnabled: false, audio: [{ index: 2, language: undefined, selected: true, isDefault: true }] };
    assert.deepEqual(aiRoute(off, DETECTED_LANGUAGE), { kind: "transcribe", sourceIndex: 2, sourceLanguage: "", targetLanguage: "" });
    assert.equal(aiRoute({ ...off, audio: [{ index: 2, language: "und", selected: true, isDefault: true }] }, DETECTED_LANGUAGE)?.kind, "transcribe");
    assert.equal(aiRoute(base, DETECTED_LANGUAGE), undefined, "a known language has no such row");
    assert.equal(aiRoute({ ...off, translateEnabled: true }, DETECTED_LANGUAGE), undefined, "with translation on it is not offered");
    assert.equal(aiRoute({ ...off, audio: [{ index: -1, language: undefined, selected: false, isDefault: false }] }, "fr"), undefined);
});

test("the menu lists Spoken language, the preferred and original languages first, then every language by name", () => {
    const menu = aiMenu(base, ["fr", "ja", "en", "de"], "fr");
    assert.deepEqual(menu.suggested.map(row => [row.code, row.label, row.hint, row.disabled]), [["fr", "French", "Preferred", false], ["ja", "Japanese", "Original language", false]]);
    assert.deepEqual(menu.other.map(row => row.label), ["English", "German"]);
    assert.equal(menu.detected, undefined);
    const unknown = aiMenu({ ...base, translateEnabled: false, audio: [{ index: 0, language: undefined, selected: true, isDefault: true }] }, ["fr", "en"], undefined);
    assert.deepEqual(unknown.detected, { code: DETECTED_LANGUAGE, label: "Spoken language", hint: "Detected from the audio", disabled: false });
    assert.deepEqual(aiMenu(base, ["fr"], "pt").suggested, [], "a preferred or spoken language the server does not list is not offered");
});

test("rows the server cannot serve now are disabled", () => {
    const menu = aiMenu({ ...base, quotaExhausted: true }, ["fr", "ja"], undefined);
    assert.deepEqual(menu.suggested.concat(menu.other).map(row => [row.code, row.disabled]), [["ja", true], ["fr", true]]);
    const translatable = aiMenu({ ...base, quotaExhausted: true, sources: [source(1, "ja")] }, ["fr", "ja"], undefined);
    assert.deepEqual(translatable.suggested.concat(translatable.other).map(row => [row.code, row.disabled]), [["ja", true], ["fr", false]], "a track in the language itself is no source for it");
});

test("the quota line reads as Apple's", () => {
    assert.equal(quotaText({ limited: true, remaining: 0, period: "month", used: 5, limit: 5 }), "Transcription limit reached");
    assert.equal(quotaText({ limited: true, remaining: 2, period: "month", used: 3, limit: 5 }), "3 of 5 used / month");
    assert.equal(quotaText({ limited: true, remaining: 2, period: "", used: 3, limit: 5 }), "3 of 5 used");
    assert.equal(quotaText({ limited: true, remaining: 2, period: "month", used: undefined, limit: undefined }), "2 remaining");
    assert.equal(quotaText({ limited: false, remaining: 0, period: "month", used: undefined, limit: undefined }), undefined);
    assert.equal(quotaText(undefined), undefined);
});

test("a quota that cannot be read blocks transcription like an exhausted one, and text translation still goes", () => {
    const unknown = { ...base, quotaKnown: false };
    assert.equal(aiRoute(unknown, "en"), undefined);
    assert.equal(aiRoute(unknown, "ja"), undefined);
    assert.equal(aiRoute({ ...unknown, sources: [source(1, "fr")] }, "en")?.kind, "translate");
    assert.equal(aiMenu(unknown, ["en"], undefined).other[0]?.disabled, true);
});
