// Generic words on Tizen-only screens (silo-apple d49d7bd): Retry, Back, Try again, Cancel and the buttons whose Apple key reads the same
// word for the same control now read the catalog, so a German or Arabic viewer does not see an English button under a translated page.
// A word with no Apple key, or several that disagree (Continue, Delete, Search), stays English and is on #592.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** [file, the Apple key it reads, the English word it showed, the call that held the literal]. */
const SITES = [
    ["src/app.ts", "common.retry", "Retry", 'button("retry", "Retry"'],
    ["src/app.ts", "signIn.backToProfiles", "Back to profiles", '"Back to profiles"'],
    ["src/app.ts", "common.back", "Back", 'button("back", "Back"'],
    ["src/bootstrap.ts", "common.tryAgain", "Try again", 'button("retry", "Try again"'],
    ["src/ui/boxSetView.ts", "common.back", "Back", 'actionButton("back", "Back"'],
    ["src/ui/exitDialog.ts", "common.cancel", "Cancel", 'button("cancel-exit", "Cancel"'],
    ["src/ui/browseDetails.ts", "rowPage.close", "Close", 'actionButton("close-more", "Close"'],
    ["src/ui/profiles.ts", "account.signInAgain", "Sign in again", 'button("signin", "Sign in again"'],
    ["src/ui/browseRoutes.ts", "account.profiles", "Profiles", 'actionButton("profiles", "Profiles"'],
    ["src/ui/browseViews.ts", "library.browse", "Browse", 'actionButton("browse", "Browse"'],
] as const;

test("each generic word reads its Apple key, and the key's English is the word it showed", () => {
    for (const [file, key, word, literal] of SITES) {
        assert.equal(english[key], word, `${key} is "${word}" in English`);
        const source = read(file);
        assert.ok(source.includes(`"${key}"`), `${file} reads ${key}`);
        assert.ok(!source.includes(literal), `${file} no longer draws the English literal ${literal}`);
    }
});

test("every key is in the German and Arabic files, and each reads differently from English", () => {
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        for (const [, key, word] of SITES) {
            assert.ok(Object.hasOwn(catalog, key), `${tag} has ${key}`);
            if (tag === "ar" || word !== "Browse") assert.notEqual(catalog[key], word, `${tag} ${key} is translated`);
        }
    }
});

test("English reads exactly as before and German and Arabic read the catalog", () => {
    for (const [, key, word] of SITES) {
        assert.equal(translate(key), word);
        for (const tag of ["de", "ar"]) {
            setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
            try { assert.equal(translate(key), translate(key, undefined, tag)); } finally { setAppLanguage(null); }
        }
    }
});

test("words with no common Apple key stay English: Continue, Delete, Search, Discard Held Change", () => {
    assert.ok(read("src/ui/signIn.ts").includes('marqueeButton("continue", "Continue"'));
    assert.ok(read("src/ui/pinScreen.ts").includes('"Delete"'));
    assert.ok(read("src/ui/requests.ts").includes('actionButton("submit", "Search"'));
    assert.ok(read("src/ui/browseDetails.ts").includes('"Discard Held Change"'));
});
