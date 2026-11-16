// The string resolver and language matching, following silo-apple Shared/AppLanguage.swift:
// the shown language is the stored App Language or the device's, matched to a shipped language,
// and a key a language lacks shows English.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import english from "../../src/i18n/catalog/en.json" with { type: "json" };
import { formatMessage, parseMessage } from "../../src/i18n/icu.ts";
import { formattingLocale, matchPreferences, matchShipped, SHIPPED_LANGUAGES, setAppLanguage, shippedByName, shownLanguage } from "../../src/i18n/language.ts";
import { resolveMessage, translate, type Catalogs } from "../../src/i18n/translate.ts";

const SEASONS = "{count, plural, one {# Season} other {# Seasons}}";
const catalogs: Catalogs = {
    en: { greet: "Hello {name}", seasons: SEASONS, total: "Total: {amount}", onlyEnglish: "Only in English", items: "{count, plural, one {# item} other {# items}}" },
    es: { greet: "Hola {name}", seasons: "{count, plural, one {# Temporada} other {# Temporadas}}", total: "Total: {amount}" },
    de: { total: "Gesamt: {amount}" },
    ru: { seasons: "{count, plural, one {# сезон} few {# сезона} many {# сезонов} other {# сезона}}" },
    ar: { seasons: "{count, plural, zero {لا مواسم} one {موسم} two {موسمان} few {# مواسم} many {# موسمًا} other {# موسم}}", total: "المجموع: {amount}" },
};
const at = (language: string, key: string, args?: Record<string, string | number>): string => resolveMessage(catalogs, key, language, args, "en-AU");

test("a key resolves in the shown language and takes its named arguments", () => {
    assert.equal(at("en", "greet", { name: "Ana" }), "Hello Ana");
    assert.equal(at("es", "greet", { name: "Ana" }), "Hola Ana");
});

test("a key the shown language lacks, or a language the build lacks, shows English", () => {
    assert.equal(at("es", "onlyEnglish"), "Only in English");
    assert.equal(at("is", "greet", { name: "Ana" }), "Hello Ana");
});

test("English fallback plurals follow English's rules, not the shown language's", () => {
    assert.equal(at("ru", "items", { count: 21 }), "21 items");
    assert.equal(at("ru", "items", { count: 1 }), "1 item");
});

test("a message with an argument the caller left out fails loudly", () => {
    assert.throws(() => at("en", "greet"), /name/);
});

test("English plurals pick one or other, with the number formatted", () => {
    assert.equal(at("en", "seasons", { count: 1 }), "1 Season");
    assert.equal(at("en", "seasons", { count: 0 }), "0 Seasons");
    assert.equal(at("en", "seasons", { count: 2 }), "2 Seasons");
    assert.equal(at("en", "seasons", { count: 1200 }), "1,200 Seasons");
});

test("Russian plurals pick one, few, many and other by the language's rules", () => {
    assert.equal(at("ru", "seasons", { count: 1 }), "1 сезон");
    assert.equal(at("ru", "seasons", { count: 21 }), "21 сезон");
    assert.equal(at("ru", "seasons", { count: 3 }), "3 сезона");
    assert.equal(at("ru", "seasons", { count: 5 }), "5 сезонов");
    assert.equal(at("ru", "seasons", { count: 11 }), "11 сезонов");
});

test("Arabic plurals use all six categories and Arabic-Indic digits", () => {
    assert.equal(at("ar", "seasons", { count: 0 }), "لا مواسم");
    assert.equal(at("ar", "seasons", { count: 1 }), "موسم");
    assert.equal(at("ar", "seasons", { count: 2 }), "موسمان");
    assert.equal(at("ar", "seasons", { count: 3 }), "٣ مواسم");
    assert.equal(at("ar", "seasons", { count: 11 }), "١١ موسمًا");
    assert.equal(at("ar", "seasons", { count: 1000 }), "١٬٠٠٠ موسم");
});

test("number arguments format in the shown language; string arguments are shown as given", () => {
    assert.equal(at("en", "total", { amount: 1234567 }), "Total: 1,234,567");
    assert.equal(at("de", "total", { amount: 1234567 }), "Gesamt: 1.234.567");
    assert.equal(at("ar", "total", { amount: 12 }), "المجموع: ١٢");
    assert.equal(at("en", "total", { amount: "1234567" }), "Total: 1234567");
});

test("a message may mix text, arguments and a plural, and a quote stays a quote", () => {
    const message = "Don't delete {name}: {count, plural, one {# download of {size}} other {# downloads of {size}}}";
    assert.equal(formatMessage(parseMessage(message), { name: "Mum's TV", count: 1, size: "2 GB" }, "en"), "Don't delete Mum's TV: 1 download of 2 GB");
    assert.equal(formatMessage(parseMessage(message), { name: "Mum's TV", count: 4, size: "2 GB" }, "en"), "Don't delete Mum's TV: 4 downloads of 2 GB");
});

test("a message outside the shared subset is refused, not shown half-formatted", () => {
    assert.throws(() => parseMessage("{n, select, a {x} other {y}}"), /select/);
    assert.throws(() => parseMessage("{count, plural, one {# a}"), /Unclosed/);
    assert.throws(() => parseMessage("{count, plural, =0 {none} other {#}}"), /plural/);
    assert.throws(() => parseMessage("a } b"), /Unmatched/);
});

test("shipped-language matching follows the system rules Apple relies on", () => {
    const shipped = ["en", "es", "pt-BR", "zh-Hans", "zh-Hant", "nb"];
    const expected: readonly (readonly [string, string | undefined])[] = [
        ["en", "en"], ["EN-us", "en"], ["es-MX", "es"], ["pt-PT", "pt-BR"], ["pt-BR", "pt-BR"],
        ["zh-CN", "zh-Hans"], ["zh-SG", "zh-Hans"], ["zh-Hans-CN", "zh-Hans"], ["zh-TW", "zh-Hant"], ["zh-HK", "zh-Hant"], ["zh-Hant-TW", "zh-Hant"],
        ["no", "nb"], ["nn", "nb"], ["nb-NO", "nb"], ["is", undefined], ["it", undefined], ["", undefined], ["not a tag!", undefined],
    ];
    for (const [tag, match] of expected) assert.equal(matchShipped(tag, shipped), match, tag);
});

test("the device language list picks the first language the build ships, else the first shipped", () => {
    assert.equal(matchPreferences(["is", "fr-CA", "en"], ["en", "fr"]), "fr");
    assert.equal(matchPreferences(["is", "ja"], ["en", "fr"]), "en");
    assert.equal(matchPreferences([], ["en", "fr"]), "en");
});

test("the shown language is the stored choice, or the device's for Match Device or a language this build lacks", () => {
    const shipped = ["en", "es"];
    setAppLanguage("es", shipped, ["en-AU"]);
    assert.equal(shownLanguage(), "es");
    setAppLanguage(null, shipped, ["es-AR", "en"]);
    assert.equal(shownLanguage(), "es");
    setAppLanguage(null, shipped, ["fr", "en-AU"]);
    assert.equal(shownLanguage(), "en");
    setAppLanguage("is", shipped, ["es-ES"]);
    assert.equal(shownLanguage(), "es");
    setAppLanguage("es", ["en"], ["en-AU"]);
    assert.equal(shownLanguage(), "en", "a stored language this build does not ship shows the device language");
    setAppLanguage(null);
});

test("formatting keeps the device's region and writes Arabic-Indic digits unless the device chose others", () => {
    assert.equal(formattingLocale("es", "en-AU"), "es-AU");
    assert.equal(formattingLocale("zh-Hans", "en-AU"), "zh-Hans-AU");
    assert.equal(formattingLocale("pt-BR", "en-AU"), "pt-BR");
    assert.equal(formattingLocale("ar", "en-AU"), "ar-AU-u-nu-arab");
    assert.equal(formattingLocale("ar", "ar-EG-u-nu-latn"), "ar-EG-u-nu-latn");
    assert.equal(formattingLocale("es", undefined), "es");
    assert.equal(formattingLocale("es", "not a tag!"), "es");
});

test("the real catalog's English resolves through the typed lookup", () => {
    setAppLanguage(null);
    assert.equal(translate("common.cancel"), "Cancel");
    assert.equal(translate("account.profiles.count", { count: 1 }), "1 profile");
    assert.equal(translate("account.profiles.count", { count: 3 }), "3 profiles");
    // @ts-expect-error a key that is not in the catalog does not compile
    assert.throws(() => translate("no.such.key"), /no\.such\.key/);
});

test("every vendored English message parses and formats", () => {
    const messages = Object.entries(english);
    assert.ok(messages.length > 3000, `${messages.length} messages`);
    for (const [key, message] of messages) {
        const nodes = parseMessage(message);
        const args: Record<string, string | number> = {};
        for (const [, name, plural] of message.matchAll(/\{(\w+)(,\s*plural)?/g)) if (name !== undefined) args[name] = plural === undefined ? "x" : 2;
        assert.doesNotThrow(() => formatMessage(nodes, args, "en"), key);
    }
});

test("the shipped languages are Apple's: English, then the rest sorted by tag", () => {
    assert.deepEqual(SHIPPED_LANGUAGES, ["en", "ar", "cs", "da", "de", "es", "fi", "fr", "hr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "ru", "sv", "tr", "uk", "zh-Hans", "zh-Hant"]);
});

test("the shipped languages are the catalog files, English first", () => {
    const files = readdirSync(new URL("../../src/i18n/catalog/", import.meta.url)).filter(name => name.endsWith(".json")).map(name => name.slice(0, -".json".length)).sort();
    assert.deepEqual([...SHIPPED_LANGUAGES].sort(), files);
    assert.equal(SHIPPED_LANGUAGES[0], "en");
});

test("the vendored catalog names the silo-translations commit it came from", () => {
    const source = readFileSync(new URL("../../src/i18n/catalog/SOURCE", import.meta.url), "utf8");
    assert.match(source, /^[0-9a-f]{40}\n$/);
});

test("the picker order is by each language's own name in the device's locale, not by tag", () => {
    const order = ["cs", "da", "de", "en", "es", "fr", "hr", "it", "nl", "nb", "pl", "pt-BR", "fi", "sv", "tr", "ru", "uk", "ar", "ko", "ja", "zh-Hans", "zh-Hant"];
    assert.deepEqual(shippedByName(SHIPPED_LANGUAGES, "en-AU"), order);
    assert.deepEqual(shippedByName(SHIPPED_LANGUAGES, "de"), order);
    assert.deepEqual(shippedByName(SHIPPED_LANGUAGES, undefined), order);
    // Whatever order the list arrives in, and English is not kept first: Arabic follows Cyrillic, English follows Deutsch.
    assert.deepEqual(shippedByName([...SHIPPED_LANGUAGES].reverse(), "en-AU"), order);
    assert.equal(SHIPPED_LANGUAGES[0], "en", "the shipped list itself stays Apple's, English first");
});
