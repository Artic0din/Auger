// The profile picker's and launch choice's catalog keys (silo-apple Screens/Profiles at d49d7bd): every key the two screens read is in
// the German and Arabic files, "Apple TV" reads "TV" where Apple wrote it for this device, and English is the text it always was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { translate, translateTv } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
const source = (name: string): string => readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), "utf8");
const PREFIX = /^(profiles|launch|common|shell\.errorView|shell\.signOut|firstRun\.tour\.continueWithoutSaving)/;

test("every catalog key the picker and the launch choice read is in the German and Arabic files", () => {
    const keys = new Set<string>();
    for (const name of ["profilePicker.ts", "profiles.ts"]) {
        for (const [, key] of source(name).matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)"/g)) if (key !== undefined && Object.hasOwn(english, key) && PREFIX.test(key)) keys.add(key);
    }
    assert.ok(keys.size >= 18, `the screens read ${keys.size} keys`);
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        assert.deepEqual([...keys].filter(key => !Object.hasOwn(catalog, key)), [], `${tag} lacks keys the screens read`);
    }
});

test("English reads exactly as before, and this TV stands in for Apple TV in the tile and the offer", () => {
    assert.equal(translate("profiles.headline"), "Who's watching?");
    assert.equal(translate("profiles.signedInAs", { name: "Laura" }), "Signed in as Laura");
    assert.equal(translateTv("profiles.tile.appleTvUser"), "TV user");
    assert.equal(translateTv("profiles.tile.pairedAppleTvUser"), "Paired with this TV user");
    assert.equal(translateTv("profiles.rememberOffer.bodyAppleTv"), "Auger can skip Who's Watching and open this profile when it starts on this TV. You can change this later in Settings > General > Profile Selection.");
    assert.equal(translate("launch.offer.title", { name: "Laura" }), "Open Laura automatically?");
    assert.equal(translate("shell.signOut.confirm"), "Sign Out");
});

test("in German the tile, the offer and the footer read the catalog's words", () => {
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    try {
        assert.notEqual(translateTv("profiles.tile.appleTvUser"), "TV user");
        assert.notEqual(translate("profiles.headline"), "Who's watching?");
        assert.ok(!translateTv("profiles.tile.pairedAppleTvUser").includes("Apple TV"));
    } finally { setAppLanguage(null); }
});
