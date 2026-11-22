// scripts/sync-translations.ts keeps the silo-translations keys a TV can show: the Apple scope,
// because tvOS is the parity target and Apple's keys use the shared ICU subset.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIPPED_LANGUAGES } from "../../src/i18n/language.ts";
import { APP_NAME_KEYS, brandCatalog, buildCatalogs, languagesToSync, PLATFORM_EXCEPTIONS, scopeCatalog, usedKeys } from "../../scripts/sync-translations.ts";
import { readFileSync } from "node:fs";

const arb = {
    "@@locale": "en",
    "b.second": "Second",
    "@b.second": { description: "d", "x-platforms": ["apple", "android"] },
    "a.first": "First {name}",
    "@a.first": { description: "d", placeholders: { name: { type: "String" } } },
    "c.android": "Android only",
    "@c.android": { description: "d", "x-platforms": ["android", "roku"] },
    "d.web": "Web only",
    "@d.web": { description: "d", "x-platforms": ["web"] },
    "apple.infoPlist.tvos.nsLocalNetworkUsageDescription": "Silo uses the network",
    "@apple.infoPlist.tvos.nsLocalNetworkUsageDescription": { description: "d", "x-platforms": ["apple"], "x-plistKey": "NSLocalNetworkUsageDescription" },
};

test("the scope keeps Apple's keys and shared ones, sorted, without metadata or Info.plist prompts", () => {
    const scoped = scopeCatalog(arb);
    assert.deepEqual(Object.entries(scoped), [["a.first", "First {name}"], ["b.second", "Second"]]);
});

test("a named Android-only key is kept, because a Samsung TV's remote has arrow keys and no Siri Remote; other Android keys stay out", () => {
    assert.deepEqual(PLATFORM_EXCEPTIONS, ["settings.skipIntervals.footerVideo"]);
    const scoped = scopeCatalog({
        "settings.skipIntervals.footerVideo": "Used by left and right presses on the remote.",
        "@settings.skipIntervals.footerVideo": { description: "Android TV Settings > Playback > Video", "x-platforms": ["android"] },
        "c.android": "Android only",
        "@c.android": { description: "d", "x-platforms": ["android"] },
    });
    assert.deepEqual(scoped, { "settings.skipIntervals.footerVideo": "Used by left and right presses on the remote." });
});

test("a language file has no metadata, so its keys are scoped by the English key set", () => {
    const scoped = scopeCatalog({ "a.first": "Primero {name}", "c.android": "x", "z.unknown": "y" }, new Set(["a.first", "b.second"]));
    assert.deepEqual(scoped, { "a.first": "Primero {name}" });
});

test("a scoped message outside the shared ICU subset stops the sync", () => {
    assert.throws(() => scopeCatalog({ "a.bad": "{n, select, a {x} other {y}}", "@a.bad": { description: "d" } }), /a\.bad/);
});

test("a translation keeps only the keys source files name as strings, so one script carries no dead text", () => {
    const keys = new Set(["common.cancel", "settings.title", "settingsManifest.ui.app_language.label", "never.used"]);
    const used = usedKeys([`translate("common.cancel"); const t = 'settings.title';`, "title: `settingsManifest.ui.app_language.label`, other: \"not.a.key\""], keys);
    assert.deepEqual([...used].sort(), ["common.cancel", "settings.title", "settingsManifest.ui.app_language.label"]);
    const scoped = scopeCatalog({ "common.cancel": "Abbrechen", "settings.title": "Einstellungen", "never.used": "x" }, used);
    assert.deepEqual(scoped, { "common.cancel": "Abbrechen", "settings.title": "Einstellungen" });
});

test("a translation keeps the keys the server names, Home's section titles and a problem's error lines, though no source spells them", () => {
    const keys = new Set(["home.section.forYou", "error.validation_failed", "error.field.required", "account.error.needsSignIn", "never.used"]);
    assert.deepEqual([...usedKeys([], keys)].sort(), ["error.field.required", "error.validation_failed", "home.section.forYou"]);
});

test("a refresh with no --languages keeps every shipped language, so the imports the build needs stay", () => {
    assert.deepEqual(languagesToSync([]), [...SHIPPED_LANGUAGES]);
    assert.deepEqual(languagesToSync(["--languages", "en,de"]), ["en", "de"]);
    assert.throws(() => languagesToSync(["--languages", "de"]), /usage/);
    assert.throws(() => languagesToSync(["--nope"]), /usage/);
});

/** The 16 keys #733 renamed (`git show dca21368 -- src/i18n/catalog`), written out so the list in the script is checked, not echoed. */
const RENAMED_BY_733 = [
    "player.aiTranslate.explainerShort", "player.error.connectionLost", "player.subtitleSync.failureNoAudio", "profiles.error.rememberFailed",
    "profiles.rememberOffer.bodyAppleTv", "search.initial", "settings.about.trademarkNotice", "settings.appLanguage.footer",
    "settings.appLanguage.unshippedFooter", "settings.bufferingQuality.description", "settings.general.pairingShared",
    "settings.general.pairingSharedAskEveryTime", "settings.profileLaunch.afterOneHour.detail", "settings.profileLaunch.afterTwelveHours.detail",
    "settings.profileLaunch.askEveryLaunch.detail", "update.appRequired",
];
/** An English catalog with every app-name key, each naming Silo once. */
const englishNames = (): Record<string, string> => Object.fromEntries(RENAMED_BY_733.map(key => [key, `${key} by Silo`]));

// #733 renamed the TV app to Auger by hand in the vendored files; silo-translations still says Silo. The sync reapplies the rename to the
// keys that name the app, and leaves text about the server alone (#802).
test("a sync names the app Auger where a message names the app, and keeps Silo where it names the server (#802)", () => {
    const branded = brandCatalog({ "search.initial": "Search Silo", "settings.general.pairingShared": "Silos menyer och Silo på andra", "server.address": "Your Silo server's address" });
    assert.deepEqual(branded, { "search.initial": "Search Auger", "settings.general.pairingShared": "Augers menyer och Auger på andra", "server.address": "Your Silo server's address" });
});

test("in English, Search Silo becomes Search Auger (#802)", () => {
    assert.equal(brandCatalog({ ...englishNames(), "search.initial": "Search Silo" }, true)["search.initial"], "Search Auger");
});

test("an English app-name message that is missing, or no longer says Silo, stops the sync; a translation may omit the name (#802)", () => {
    assert.throws(() => brandCatalog({ ...englishNames(), "search.initial": "Search" }, true), /search\.initial/);
    const { "update.appRequired": _missing, ...withoutOne } = englishNames();
    assert.throws(() => brandCatalog(withoutOne, true), /update\.appRequired/, "a key upstream dropped or renamed");
    assert.deepEqual(brandCatalog({ "player.error.connectionLost": "Connessione persa" }), { "player.error.connectionLost": "Connessione persa" });
});

// No listed message in any language at 857d5235 uses Silo for the server ("the server", "this server" instead), so a plain swap matches #733.
// An English one that starts to is held for review rather than renamed to "Auger server".
test("an English app-name message that names the Silo server or account stops the sync for review (#802)", () => {
    assert.throws(() => brandCatalog({ ...englishNames(), "update.appRequired": "Update Silo to keep using this Silo server." }, true), /update\.appRequired/);
    assert.throws(() => brandCatalog({ ...englishNames(), "update.appRequired": "Silo needs your Silo account." }, true), /update\.appRequired/);
});

test("the sync builds each catalog with the app renamed: English, a translation scoped to the keys in use, and server text untouched (#802)", () => {
    const english = { ...Object.fromEntries(RENAMED_BY_733.map(key => [key, `${key} by Silo`])), "server.unreachable": "The Silo server can't be reached", "unused.key": "Silo elsewhere" };
    const german = { "search.initial": "Silo durchsuchen", "update.appRequired": "Aktualisiere Silo", "server.unreachable": "Der Silo-Server ist nicht erreichbar", "unused.key": "Silo" };
    const catalogs = buildCatalogs(english, new Map([["de", german]]), ['translate("search.initial")', 'translate("update.appRequired")', 'translate("server.unreachable")'], ["en", "de"]);
    assert.equal(catalogs.get("en")?.["search.initial"], "search.initial by Auger");
    assert.equal(catalogs.get("en")?.["server.unreachable"], "The Silo server can't be reached");
    assert.deepEqual(catalogs.get("de"), { "search.initial": "Auger durchsuchen", "server.unreachable": "Der Silo-Server ist nicht erreichbar", "update.appRequired": "Aktualisiere Auger" });
});

test("every vendored language already has the rename the sync applies, so a fresh sync changes nothing (#802)", () => {
    assert.deepEqual([...APP_NAME_KEYS].sort(), [...RENAMED_BY_733].sort(), "exactly the keys #733 renamed");
    for (const tag of SHIPPED_LANGUAGES) {
        const messages = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        for (const key of APP_NAME_KEYS) {
            const text = messages[key];
            if (text === undefined) continue;
            assert.ok(!text.includes("Silo"), `${tag} ${key} still says Silo`);
            assert.equal(brandCatalog({ [key]: text.replaceAll("Auger", "Silo") })[key], text, `${tag} ${key}`);
        }
    }
});
