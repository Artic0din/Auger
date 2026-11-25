// scripts/sync-translations.ts keeps the silo-translations keys a TV can show: the Apple scope,
// because tvOS is the parity target and Apple's keys use the shared ICU subset.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIPPED_LANGUAGES } from "../../src/i18n/language.ts";
import { APP_NAME_KEYS, brandCatalog, buildCatalogs, languagesToSync, main, PLATFORM_EXCEPTIONS, scopeCatalog, type SyncFetch, usedKeys } from "../../scripts/sync-translations.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** The 18 keys whose text names the TV app, written out so the list in the script is checked, not echoed. */
const APP_NAMING_KEYS = [
    "player.aiTranslate.explainerShort", "player.error.connectionLost", "player.error.couldNotStart", "player.error.couldNotStartRetry",
    "player.subtitleSync.failureNoAudio", "profiles.error.rememberFailed",
    "profiles.rememberOffer.bodyAppleTv", "search.initial", "settings.about.trademarkNotice", "settings.appLanguage.footer",
    "settings.appLanguage.unshippedFooter", "settings.bufferingQuality.description", "settings.general.pairingShared",
    "settings.general.pairingSharedAskEveryTime", "settings.profileLaunch.afterOneHour.detail", "settings.profileLaunch.afterTwelveHours.detail",
    "settings.profileLaunch.askEveryLaunch.detail", "update.appRequired",
];
/** An English catalog with every app-name key, each naming Silo once. */
const englishNames = (): Record<string, string> => Object.fromEntries(APP_NAMING_KEYS.map(key => [key, `${key} by Silo`]));

// silo-translations names Silo's own app Silo. The sync substitutes Auger in the keys that name the app, and leaves text about the
// server alone (#802).
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

// No listed message in any language at 857d5235 uses Silo for the server ("the server", "this server" instead), so a plain swap is safe.
// An English one that starts to is held for review rather than renamed to "Auger server".
test("an English app-name message that names the Silo server or account stops the sync for review (#802)", () => {
    assert.throws(() => brandCatalog({ ...englishNames(), "update.appRequired": "Update Silo to keep using this Silo server." }, true), /update\.appRequired/);
    assert.throws(() => brandCatalog({ ...englishNames(), "update.appRequired": "Silo needs your Silo account." }, true), /update\.appRequired/);
});

test("Silo as a verb (\"Silo accounts for\") is the app, not an account, and is renamed (#802)", () => {
    const text = "Silo accounts for buffering. Silo servers its own cache.";
    assert.equal(brandCatalog({ ...englishNames(), "settings.bufferingQuality.description": text }, true)["settings.bufferingQuality.description"], "Auger accounts for buffering. Auger servers its own cache.");
});

test("building English catalogs holds a missing app-name key, or one naming the Silo server or account, for review (#802)", () => {
    const { "search.initial": _dropped, ...missing } = englishNames();
    assert.throws(() => buildCatalogs(missing, new Map(), [], ["en"]), /search\.initial/);
    for (const text of ["Update Silo to keep using this Silo server.", "Sign in with your Silo account."]) {
        assert.throws(() => buildCatalogs({ ...englishNames(), "update.appRequired": text }, new Map(), [], ["en"]), /update\.appRequired/, text);
    }
});

test("the sync builds each catalog with the app renamed: English, a translation scoped to the keys in use, and server text untouched (#802)", () => {
    const english = { ...Object.fromEntries(APP_NAMING_KEYS.map(key => [key, `${key} by Silo`])), "server.unreachable": "The Silo server can't be reached", "unused.key": "Silo elsewhere" };
    const german = { "search.initial": "Silo durchsuchen", "update.appRequired": "Aktualisiere Silo", "server.unreachable": "Der Silo-Server ist nicht erreichbar", "unused.key": "Silo" };
    const catalogs = buildCatalogs(english, new Map([["de", german]]), ['translate("search.initial")', 'translate("update.appRequired")', 'translate("server.unreachable")'], ["en", "de"]);
    assert.equal(catalogs.get("en")?.["search.initial"], "search.initial by Auger");
    assert.equal(catalogs.get("en")?.["server.unreachable"], "The Silo server can't be reached");
    assert.deepEqual(catalogs.get("de"), { "search.initial": "Auger durchsuchen", "server.unreachable": "Der Silo-Server ist nicht erreichbar", "update.appRequired": "Aktualisiere Auger" });
});

test("every vendored language already has the rename the sync applies, so a fresh sync changes nothing (#802)", () => {
    assert.deepEqual([...APP_NAME_KEYS].sort(), [...APP_NAMING_KEYS].sort(), "exactly the keys that name the app");
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

const FAKE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function jsonResponse(body: unknown, status = 200): Pick<Response, "ok" | "status" | "json"> {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeSyncFetch(routes: Readonly<Record<string, Pick<Response, "ok" | "status" | "json">>>): SyncFetch {
    return async (url: string) => routes[url] ?? jsonResponse({ error: "not found" }, 404);
}

test("main downloads catalogs, renames app strings through buildCatalogs, writes SOURCE, and clears stale JSON (#804)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auger-sync-translations-"));
    try {
        writeFileSync(join(dir, "stale.json"), "{\"old\":\"value\"}\n");
        const englishArb = {
            "@@locale": "en",
            ...englishNames(),
            "search.initial": "Search Silo",
            "@search.initial": { description: "Search prompt" },
            "error.server_unavailable": "The Silo server can't be reached",
            "@error.server_unavailable": { description: "Server error" },
            "unused.key": "Silo elsewhere",
            "@unused.key": { description: "Unused key in English" },
        };
        const germanArb = {
            "@@locale": "de",
            "search.initial": "Silo durchsuchen",
            "error.server_unavailable": "Der Silo-Server ist nicht erreichbar",
            "unused.key": "Silo",
        };
        const fakeFetch = fakeSyncFetch({
            "https://api.github.com/repos/Silo-Server/silo-translations/commits/v1.0.0": jsonResponse({ sha: FAKE_COMMIT }),
            [`https://raw.githubusercontent.com/Silo-Server/silo-translations/${FAKE_COMMIT}/catalog/en.arb`]: jsonResponse(englishArb),
            [`https://raw.githubusercontent.com/Silo-Server/silo-translations/${FAKE_COMMIT}/catalog/de.arb`]: jsonResponse(germanArb),
        });
        await main({ argv: ["v1.0.0", "--languages", "en,de"], fetch: fakeFetch, destination: dir });
        const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8")) as Record<string, string>;
        const de = JSON.parse(readFileSync(join(dir, "de.json"), "utf8")) as Record<string, string>;
        assert.equal(en["search.initial"], "Search Auger");
        assert.equal(en["error.server_unavailable"], "The Silo server can't be reached");
        assert.equal(en["unused.key"], "Silo elsewhere", "English keeps Apple-scoped keys");
        assert.equal(de["search.initial"], "Auger durchsuchen");
        assert.equal(de["error.server_unavailable"], "Der Silo-Server ist nicht erreichbar");
        assert.equal("unused.key" in de, false, "unused English-backed keys stay out of translations");
        assert.equal(readFileSync(join(dir, "SOURCE"), "utf8"), `${FAKE_COMMIT}\n`);
        assert.equal(existsSync(join(dir, "stale.json")), false, "stale catalog JSON is removed");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("main leaves the output directory untouched when any download fails (#804)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auger-sync-translations-"));
    try {
        writeFileSync(join(dir, "en.json"), "{\"kept\":\"yes\"}\n");
        writeFileSync(join(dir, "stale.json"), "{\"keep\":\"me\"}\n");
        writeFileSync(join(dir, "SOURCE"), "previous-sha\n");
        const fakeFetch = fakeSyncFetch({
            "https://api.github.com/repos/Silo-Server/silo-translations/commits/v1.0.0": jsonResponse({ sha: FAKE_COMMIT }),
            [`https://raw.githubusercontent.com/Silo-Server/silo-translations/${FAKE_COMMIT}/catalog/en.arb`]: jsonResponse(englishNames()),
            [`https://raw.githubusercontent.com/Silo-Server/silo-translations/${FAKE_COMMIT}/catalog/de.arb`]: jsonResponse({}, 500),
        });
        await assert.rejects(() => main({ argv: ["v1.0.0", "--languages", "en,de"], fetch: fakeFetch, destination: dir }), /catalog\/de\.arb.*HTTP 500/);
        assert.equal(readFileSync(join(dir, "en.json"), "utf8"), "{\"kept\":\"yes\"}\n");
        assert.equal(readFileSync(join(dir, "stale.json"), "utf8"), "{\"keep\":\"me\"}\n");
        assert.equal(readFileSync(join(dir, "SOURCE"), "utf8"), "previous-sha\n");
        assert.equal(existsSync(join(dir, "de.json")), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("main preserves CLI usage errors before touching the network (#804)", async () => {
    let called = false;
    const fakeFetch: SyncFetch = async () => { called = true; return jsonResponse({}); };
    await assert.rejects(() => main({ argv: [], fetch: fakeFetch }), /usage/);
    await assert.rejects(() => main({ argv: ["--languages", "en"], fetch: fakeFetch }), /usage/);
    assert.equal(called, false);
});

test("main defaults to process.argv and global fetch when omitted (#804)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auger-sync-translations-"));
    const savedArgv = process.argv;
    const savedFetch = globalThis.fetch;
    try {
        process.argv = [savedArgv[0] ?? "node", savedArgv[1] ?? "scripts/sync-translations.ts", "v1.0.0", "--languages", "en"];
        const fakeFetch = fakeSyncFetch({
            "https://api.github.com/repos/Silo-Server/silo-translations/commits/v1.0.0": jsonResponse({ sha: FAKE_COMMIT }),
            [`https://raw.githubusercontent.com/Silo-Server/silo-translations/${FAKE_COMMIT}/catalog/en.arb`]: jsonResponse({
                ...englishNames(),
                "search.initial": "Search Silo",
            }),
        });
        globalThis.fetch = fakeFetch as unknown as typeof fetch;
        await main({ destination: dir });
        const en = JSON.parse(readFileSync(join(dir, "en.json"), "utf8")) as Record<string, string>;
        assert.equal(en["search.initial"], "Search Auger");
        assert.equal(readFileSync(join(dir, "SOURCE"), "utf8"), `${FAKE_COMMIT}\n`);
    } finally {
        process.argv = savedArgv;
        globalThis.fetch = savedFetch;
        rmSync(dir, { recursive: true, force: true });
    }
});
