// The Person page's facts in the shown language (silo-apple Screens/People/PersonDetailView.swift at 0e17c3e3): Born, Died and a
// living age read from the catalog, a date is isolated in a right-to-left sentence, and English is the text it always was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import { episodeAirDate } from "../../src/ui/episodeCaption.ts";
import { formatPersonDate, personMetadataBadges } from "../../src/ui/personHero.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const FSI = "⁨";
const PDI = "⁩";
const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
const source = (name: string): string => readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), "utf8");
const TODAY = new Date(2026, 3, 12, 12, 0, 0);

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

test("every catalog key the Person page reads is in the German and Arabic files", () => {
    const keys = new Set<string>();
    for (const name of ["personHero.ts", "personFilmography.ts", "browseDetails.ts"]) {
        for (const [, key] of source(name).matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)"/g)) if (key !== undefined && Object.hasOwn(english, key) && key.startsWith("person.")) keys.add(key);
    }
    assert.ok(keys.size >= 8, `the page reads ${keys.size} person keys`);
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        assert.deepEqual([...keys].filter(key => !Object.hasOwn(catalog, key)), [], `${tag} lacks keys the page reads`);
    }
});

test("English facts are unchanged: Born, Died or a living age, then the birthplace", () => {
    // The date is the device region's medium date, as before; only the words around it are asserted.
    const date = (value: string): string | undefined => formatPersonDate(value);
    assert.deepEqual(personMetadataBadges({ birthDate: "1980-04-12", birthplace: "Melbourne" }, TODAY), [`Born ${date("1980-04-12")}`, "46 years old", "Melbourne"]);
    assert.deepEqual(personMetadataBadges({ birthDate: "1980-04-12", deathDate: "2020-01-02" }, TODAY), [`Born ${date("1980-04-12")}`, `Died ${date("2020-01-02")}`]);
    assert.deepEqual(personMetadataBadges({ birthDate: "2025-04-12" }, TODAY), [`Born ${date("2025-04-12")}`, "1 year old"]);
    assert.deepEqual(personMetadataBadges({ birthDate: "unknown" }, TODAY), ["Born unknown"]);
});

test("the facts read in German with its date and plural, and the birthplace stays as sent", () => {
    inLanguage("de", () => {
        const born = formatPersonDate("1980-04-12");
        assert.ok(born !== undefined);
        assert.deepEqual(personMetadataBadges({ birthDate: "1980-04-12", birthplace: "Melbourne" }, TODAY), [`Geboren am ${born}`, "46 Jahre alt", "Melbourne"]);
        assert.deepEqual(personMetadataBadges({ birthDate: "1980-04-12", deathDate: "2020-01-02" }, TODAY), [`Geboren am ${born}`, `Gestorben am ${formatPersonDate("2020-01-02")}`]);
        assert.deepEqual(personMetadataBadges({ birthDate: "2025-04-12" }, TODAY).slice(1), ["1 Jahr alt"]);
    });
});

test("in Arabic a date inside a fact is isolated, and the age takes the language's plural and digits", () => {
    inLanguage("ar", () => {
        const born = formatPersonDate("1980-04-12");
        assert.ok(born !== undefined);
        const [first, second] = personMetadataBadges({ birthDate: "1980-04-12" }, TODAY);
        assert.equal(first, `الميلاد: ${FSI}${born}${PDI}`);
        assert.equal(second, translate("person.yearsOld", { count: 46 }, "ar"));
        assert.match(second ?? "", /[٠-٩]/);
        assert.equal(personMetadataBadges({ birthDate: "2025-04-12" }, TODAY)[1], "عام واحد");
    });
});

test("a person's date reads day first without leading zeros, with the shown language's digits, as Apple TV writes it in German and Arabic", () => {
    // silo-apple `formattedPersonDate`: the device region's numeric order (a TV set to Australia reads day first), unpadded, in the language's digits.
    inLanguage("de", () => {
        assert.equal(formatPersonDate("1943-08-17", "en-AU"), "17/8/1943");
        assert.equal(formatPersonDate("1980-04-02", "en-AU"), "2/4/1980");
        assert.equal(formatPersonDate("1943-08-17", "en-US"), "8/17/1943", "a US region reads month first");
        assert.deepEqual(personMetadataBadges({ birthDate: "1943-08-17" }, TODAY, "en-AU").slice(0, 1), ["Geboren am 17/8/1943"]);
    });
    inLanguage("ar", () => {
        assert.equal(formatPersonDate("1943-08-17", "en-AU"), "١٧/٨/١٩٤٣");
        assert.equal(formatPersonDate("1980-04-02", "en-AU"), "٢/٤/١٩٨٠");
        assert.equal(personMetadataBadges({ birthDate: "1943-08-17" }, TODAY, "en-AU")[0], `الميلاد: ${FSI}١٧/٨/١٩٤٣${PDI}`);
    });
    // A value that is not an ISO date shows as sent, in every language.
    inLanguage("de", () => assert.equal(formatPersonDate("c. 1900", "en-AU"), "c. 1900"));
});

test("English person dates and episode air dates keep their medium form", () => {
    const air = episodeAirDate("1943-08-17");
    assert.ok(air !== undefined && /Aug/.test(air), `medium form: ${air}`);
    assert.equal(formatPersonDate("1943-08-17", "en-AU"), air);
    // The shared air-date formatter is not the person formatter: a German episode date stays medium.
    inLanguage("de", () => assert.equal(episodeAirDate("1943-08-17"), new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(1943, 7, 17, 12))));
});
