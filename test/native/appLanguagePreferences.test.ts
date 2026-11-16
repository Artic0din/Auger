// Settings > General's App Language row (`ui.app_language`), following silo-apple
// Networking/AppLanguagePreferences.swift against the fake server's settings routes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_LANGUAGE_KEY, type SettingsCapabilities } from "../../src/contracts/v2/settings.ts";
import { setAppLanguage, shownLanguage } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import { APP_LANGUAGE_INTRODUCED_IN, AppLanguagePreferences, appLanguageSettingsSupported } from "../../src/ui/appLanguagePreferences.ts";
import { settle } from "./support/clock.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { problem } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

/** silo-apple `AppLanguage.shipped` (the development language, then the rest sorted by tag) with `AppLanguage.endonym`'s name for each, as Foundation prints them. */
const APPLE_LANGUAGES: readonly (readonly [string, string])[] = [
    ["en", "English"], ["ar", "العربية"], ["cs", "Čeština"], ["da", "Dansk"], ["de", "Deutsch"], ["es", "Español"], ["fi", "Suomi"], ["fr", "Français"],
    ["hr", "Hrvatski"], ["it", "Italiano"], ["ja", "日本語"], ["ko", "한국어"], ["nb", "Norsk bokmål"], ["nl", "Nederlands"], ["pl", "Polski"],
    ["pt-BR", "Português (Brasil)"], ["ru", "Русский"], ["sv", "Svenska"], ["tr", "Türkçe"], ["uk", "Українська"], ["zh-Hans", "简体中文"], ["zh-Hant", "繁體中文"],
];

function capability(revision: number, extras: Partial<SettingsCapabilities> = {}): SettingsCapabilities {
    return { apiVersion: 1, revision: "opaque", manifestRevision: revision, state: "available", allowed: true, scopes: ["profile", "profile_device"], supportsBatchedEffective: true, supportsAtomicShortcuts: true, clientFamilies: ["tv"], ...extras };
}

test("the row is offered only from manifest revision 28 on a server that is available, allowed and batches effective reads", () => {
    assert.equal(APP_LANGUAGE_INTRODUCED_IN, 28);
    assert.equal(appLanguageSettingsSupported(capability(28)), true);
    assert.equal(appLanguageSettingsSupported(capability(27)), false);
    assert.equal(appLanguageSettingsSupported(capability(28, { supportsBatchedEffective: false })), false);
    assert.equal(appLanguageSettingsSupported(capability(28, { allowed: false })), false);
    assert.equal(appLanguageSettingsSupported(capability(28, { state: "unavailable" })), false);
    assert.equal(appLanguageSettingsSupported(undefined), false);
});

const effectivePath = `/settings/values/effective?keys=${APP_LANGUAGE_KEY}`;
const profilePath = `/settings/values/${APP_LANGUAGE_KEY}?scope=profile`;
const devicePath = `/settings/values/${APP_LANGUAGE_KEY}?scope=profile_device`;

async function preferences(revision = 28) {
    setAppLanguage(null);
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    const settings = new FakeSettings(h.fake);
    settings.revision = revision;
    const store = new AppLanguagePreferences(h.core.session);
    await store.refresh();
    return { ...h, settings, store };
}

test("a profile with no language shows Match Device, with Match Device and English to pick from", async () => {
    const h = await preferences();
    try {
        assert.equal(h.store.isOffered, true);
        assert.deepEqual(h.store.currentChoice, { tag: null, isDeviceValue: false });
        assert.equal(h.store.selectedLabel, "Match Device");
        assert.deepEqual(h.store.options, [{ tag: null, label: "Match Device" }, ...APPLE_LANGUAGES.map(([tag, label]) => ({ tag, label }))]);
        assert.equal(h.store.footer, "The language of Silo’s menus and buttons on this profile. Audio and subtitle languages are set in Playback.");
    } finally { h.store.stop(); }
});

test("a server older than revision 28 hides the row and never writes", async () => {
    const h = await preferences(27);
    try {
        assert.equal(h.store.isOffered, false);
        await h.store.select("en");
        assert.equal(h.fake.paths().some(path => path.startsWith("PUT ")), false);
    } finally { h.store.stop(); }
});

test("picking a language writes the profile's value and shows what the server then resolves", async () => {
    const h = await preferences();
    try {
        await h.store.select("en");
        assert.equal(h.fake.paths().includes(`PUT ${profilePath}`), true);
        assert.equal(h.settings.profile().get(APP_LANGUAGE_KEY), "en");
        assert.deepEqual(h.store.currentChoice, { tag: "en", isDeviceValue: false });
        assert.equal(h.store.selectedLabel, "English");
        await h.store.select(null);
        assert.equal(h.settings.profile().get(APP_LANGUAGE_KEY), null, "Match Device is stored as null");
        assert.equal(h.store.selectedLabel, "Match Device");
    } finally { h.store.stop(); }
});

test("choosing the language already stored does nothing", async () => {
    const h = await preferences();
    try {
        await h.store.select(null);
        assert.equal(h.fake.paths().some(path => path.startsWith("PUT ")), false);
    } finally { h.store.stop(); }
});

test("this TV's own value shows, and picking a language replaces it with the profile's", async () => {
    const h = await preferences();
    try {
        h.settings.device("p-owner", h.core.session.http.deviceId).set(APP_LANGUAGE_KEY, "en");
        await h.store.refresh();
        assert.deepEqual(h.store.currentChoice, { tag: "en", isDeviceValue: true });
        await h.store.select("en");
        assert.equal(h.fake.paths().includes(`PUT ${profilePath}`), true, "the shown language over a device row still saves");
        assert.equal(h.fake.paths().includes(`DELETE ${devicePath}`), true);
        assert.equal(h.settings.device("p-owner", h.core.session.http.deviceId).has(APP_LANGUAGE_KEY), false);
        assert.deepEqual(h.store.currentChoice, { tag: "en", isDeviceValue: false });
    } finally { h.store.stop(); }
});

test("a language another client stored that this build lacks shows as itself, with Apple's footer", async () => {
    const h = await preferences();
    try {
        h.settings.profile().set(APP_LANGUAGE_KEY, "is");
        await h.store.refresh();
        assert.equal(h.store.selectedLabel, "Íslenska");
        assert.deepEqual(h.store.options.map(option => option.tag), [null, ...APPLE_LANGUAGES.map(([tag]) => tag), "is"], "re-saving never clears it");
        assert.equal(h.store.footer, "Silo isn’t available in Íslenska yet, so it uses the device language.");
    } finally { h.store.stop(); }
});

test("a shipped language shows by Apple's name for it, and a regional tag counts as shipped", async () => {
    const h = await preferences();
    try {
        h.settings.profile().set(APP_LANGUAGE_KEY, "de");
        await h.store.refresh();
        assert.equal(h.store.selectedLabel, "Deutsch");
        assert.equal(h.store.footer, translate("settings.appLanguage.footer", undefined, "de"), "the row reads in the language it picked");
        assert.notEqual(h.store.footer, translate("settings.appLanguage.footer", undefined, "en"));
        h.settings.profile().set(APP_LANGUAGE_KEY, "en-GB");
        await h.store.refresh();
        assert.equal(h.store.footer, translate("settings.appLanguage.footer", undefined, "en"));
        assert.deepEqual(h.store.options.map(option => option.tag), [null, ...APPLE_LANGUAGES.map(([tag]) => tag), "en-GB"], "kept as stored, as Apple lists it");
    } finally { h.store.stop(); }
});

test("a failed save restores the stored language and says why", async () => {
    const cases: [ReturnType<typeof problem>, string][] = [
        [problem(500, "internal", "Unavailable"), "The server didn't save the app language. Try again."],
        [problem(422, "unknown_setting", "Unknown"), "This server can't save the app language."],
    ];
    for (const [reply, message] of cases) {
        const h = await preferences();
        try {
            h.fake.script(profilePath, reply);
            await h.store.select("en");
            assert.equal(h.store.error, message);
            assert.deepEqual(h.store.currentChoice, { tag: null, isDeviceValue: false });
            assert.equal(h.store.isBusy, false);
        } finally { h.store.stop(); }
    }
});

test("a save that never arrives names the connection", async () => {
    const h = await preferences();
    try {
        h.fake.dropNextAnswer(`${profilePath}`);
        await h.store.select("en");
        assert.equal(h.store.error, "Couldn't save the app language. Check the connection and try again.");
    } finally { h.store.stop(); }
});

test("a save in flight holds the picker, and a second pick waits for it", async () => {
    const h = await preferences();
    try {
        const write = h.fake.hold(profilePath);
        const first = h.store.select("en");
        await settle();
        assert.equal(h.store.isBusy, true);
        assert.equal(h.store.currentChoice?.tag, "en", "the choice shows at once");
        await h.store.select(null);
        assert.equal(h.fake.paths().filter(path => path === `PUT ${profilePath}`).length, 1);
        write.release();
        await first;
        assert.equal(h.store.isBusy, false);
        assert.equal(h.store.currentChoice?.tag, "en");
    } finally { h.store.stop(); }
});

test("a stale read cannot overwrite a completed save", async () => {
    const h = await preferences();
    try {
        const read = h.fake.hold(effectivePath);
        const refresh = h.store.refresh();
        await settle();
        await h.store.select("en");
        read.release();
        await refresh;
        await settle();
        assert.equal(h.store.currentChoice?.tag, "en");
    } finally { h.store.stop(); }
});

test("subscribers hear every change, and none after stop", async () => {
    const h = await preferences();
    let heard = 0;
    h.store.subscribe(() => heard++);
    await h.store.select("en");
    assert.ok(heard > 0);
    h.store.stop();
    const before = heard;
    await h.store.refresh();
    assert.equal(heard, before);
});

async function shownBy(shown: (tag: string | null) => void) {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    const settings = new FakeSettings(h.fake);
    settings.revision = 28;
    const store = new AppLanguagePreferences(h.core.session, shown);
    return { ...h, settings, store };
}

test("the stored choice sets the language the app shows; Match Device and an unsupported server show the device's", async () => {
    const shown: (string | null)[] = [];
    const h = await shownBy(tag => shown.push(tag));
    try {
        h.settings.profile().set(APP_LANGUAGE_KEY, "en");
        await h.store.refresh();
        assert.equal(shown.at(-1), "en");
        h.settings.profile().set(APP_LANGUAGE_KEY, null);
        await h.store.refresh();
        assert.equal(shown.at(-1), null);
        h.settings.profile().set(APP_LANGUAGE_KEY, "en");
        await h.store.refresh();
        h.settings.revision = 27;
        await h.store.refresh();
        assert.equal(shown.at(-1), null, "a server that cannot store it has no choice to show");
    } finally { h.store.stop(); }
});

test("picking a language shows it at once, and a failed save puts the previous one back", async () => {
    const shown: (string | null)[] = [];
    const h = await shownBy(tag => shown.push(tag));
    try {
        await h.store.refresh();
        assert.equal(shown.at(-1), null);
        const write = h.fake.hold(profilePath);
        const saving = h.store.select("en");
        await settle();
        assert.equal(shown.at(-1), "en");
        write.release();
        await saving;
        assert.equal(shown.at(-1), "en");
        h.fake.script(profilePath, problem(500, "internal", "Unavailable"));
        await h.store.select(null);
        assert.equal(shown.at(-1), "en", "the failed save leaves the stored language showing");
    } finally { h.store.stop(); }
});

test("with the real setter, the stored English choice is what every later request names", async () => {
    setAppLanguage(null);
    const h = await shownBy(setAppLanguage);
    try {
        h.settings.profile().set(APP_LANGUAGE_KEY, "en");
        await h.store.refresh();
        assert.equal(shownLanguage(), "en");
        assert.equal(h.fake.requests.at(-1)?.headers["accept-language"], "en");
    } finally { h.store.stop(); setAppLanguage(null); }
});
