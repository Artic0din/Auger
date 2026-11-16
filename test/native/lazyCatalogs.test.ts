// Language text on demand: English is bundled, every other language is its own packaged file that the app
// loads for the shown language, and until it lands the screens read English.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import english from "../../src/i18n/catalog/en.json" with { type: "json" };
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { loadCatalog } from "../../src/i18n/load.ts";
import { onCatalogLoaded, registerCatalog, textLanguage, translate } from "../../src/i18n/translate.ts";
import { catalogScript, packagedLanguages } from "../../scripts/catalog-files.ts";

const PACKAGED = new URL("../../dist/wgt/", import.meta.url);
const sourceFile = (tag: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
/** What the packaged `catalog/<tag>.js` hands the page, read the way a browser runs it. */
function packagedCatalog(tag: string): Record<string, string> | undefined {
    const page: { siloCatalogs?: Record<string, Record<string, string>> } = {};
    runInNewContext(readFileSync(new URL(`catalog/${tag}.js`, PACKAGED), "utf8"), page);
    // A script run in another realm hands over objects with that realm's prototypes.
    return page.siloCatalogs === undefined ? undefined : (JSON.parse(JSON.stringify(page.siloCatalogs)) as Record<string, Record<string, string>>)[tag];
}

test("until a language's file lands the screens read English, then its text shows", () => {
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    assert.equal(textLanguage(), "en", "German is chosen but not loaded");
    assert.equal(translate("settings.title"), english["settings.title"]);
    registerCatalog("de", { "settings.title": "Einstellungen" });
    assert.equal(textLanguage(), "de");
    assert.equal(translate("settings.title"), "Einstellungen");
    assert.equal(translate("settings.general"), english["settings.general"], "a key the file lacks shows English");
});

test("a landed catalog tells its listeners which language arrived, and a stopped listener hears nothing", () => {
    const heard: string[] = [];
    const stop = onCatalogLoaded(tag => heard.push(tag));
    registerCatalog("fr", { "settings.title": "Paramètres" });
    stop();
    registerCatalog("es", { "settings.title": "Ajustes" });
    assert.deepEqual(heard, ["fr"]);
});

test("without a page the loader changes nothing and English still shows", async () => {
    setAppLanguage("ja", SHIPPED_LANGUAGES, ["en-AU"]);
    assert.equal(await loadCatalog("ja"), false);
    assert.equal(textLanguage(), "en");
    assert.equal(translate("settings.title"), english["settings.title"]);
});

test("the packaging script wraps a catalog so a classic script registers it under its tag", () => {
    const page: { siloCatalogs?: Record<string, Record<string, string>> } = {};
    runInNewContext(catalogScript("pt-BR", { "a.b": "Olá \"{nome}\"" }), page);
    assert.deepEqual(JSON.parse(JSON.stringify(page.siloCatalogs)), { "pt-BR": { "a.b": "Olá \"{nome}\"" } });
});

test("every shipped language is its own packaged file holding exactly its vendored text", () => {
    const others = SHIPPED_LANGUAGES.filter(tag => tag !== "en");
    assert.deepEqual(packagedLanguages(), others);
    assert.deepEqual(readdirSync(new URL("catalog/", PACKAGED)).sort(), others.map(tag => `${tag}.js`).sort());
    for (const tag of others) assert.deepEqual(packagedCatalog(tag), sourceFile(tag), `${tag} packaged as vendored`);
});

test("main.js carries English only: no other language's text is in the script", () => {
    const main = readFileSync(new URL("js/main.js", PACKAGED), "utf8");
    assert.ok(main.includes(english["settings.title"]), "English is bundled");
    for (const [tag, text] of [["de", "Einstellungen"], ["fr", "Paramètres"], ["ja", "設定"], ["ru", "Настройки"]] as const) {
        assert.equal(sourceFile(tag)["settings.title"], text, `${tag} fixture`);
        assert.equal(main.includes(`"${text}"`), false, `${tag} text is not in main.js`);
    }
});
