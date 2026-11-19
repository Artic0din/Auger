// scripts/sync-translations.ts keeps the silo-translations keys a TV can show: the Apple scope,
// because tvOS is the parity target and Apple's keys use the shared ICU subset.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIPPED_LANGUAGES } from "../../src/i18n/language.ts";
import { languagesToSync, PLATFORM_EXCEPTIONS, scopeCatalog, usedKeys } from "../../scripts/sync-translations.ts";

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

test("a refresh with no --languages keeps every shipped language, so the imports the build needs stay", () => {
    assert.deepEqual(languagesToSync([]), [...SHIPPED_LANGUAGES]);
    assert.deepEqual(languagesToSync(["--languages", "en,de"]), ["en", "de"]);
    assert.throws(() => languagesToSync(["--languages", "de"]), /usage/);
    assert.throws(() => languagesToSync(["--nope"]), /usage/);
});
