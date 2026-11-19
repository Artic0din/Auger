// Settings › Playback's skip intervals on Apple's catalog keys, as silo-apple's TVPlaybackSettingsView draws them: each interval reads
// `player.seekInterval.choice` ("10 Sekunden", in the language's plural and digits), the Video group's help line is
// `settings.skipIntervals.footerVideo` (Android TV's key: a Samsung remote has arrow keys and no Siri Remote) and the Audiobooks group's `settings.skipIntervals.footerAudiobook`. The strings are literal here so a key a
// language lacks cannot pass by falling back to English. A picker opens focused on the stored option, or on the first when it is not offered, as
// TVSettingsPickerSheet.focusSelection does (silo-apple 648091a7, TVSettingsComponents.swift lines 837-839).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY, AUDIOBOOK_SEEK_BACK_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LANGUAGES = {
    en: {
        settings: "Settings", back: "10 seconds", forward: "30 seconds", rewind45: "45 seconds",
        videoFooter: "Used by left and right presses on the remote and the on-screen skip buttons. Applies to every device signed in to this profile.",
        audiobookFooter: "Used by the audiobook player's skip buttons. Applies to every device signed in to this profile.",
    },
    de: {
        settings: "Einstellungen", back: "10 Sekunden", forward: "30 Sekunden", rewind45: "45 Sekunden",
        videoFooter: "Betrifft Links und Rechts auf der Fernbedienung sowie die Sprungtasten auf dem Bildschirm. Gilt für alle Geräte, die mit diesem Profil angemeldet sind.",
        audiobookFooter: "Betrifft die Sprungtasten des Hörbuch-Players. Gilt für alle Geräte, die mit diesem Profil angemeldet sind.",
    },
    // 3 to 10 take Arabic's "few" form and 11 to 99 its "many" form, each with Arabic-Indic digits.
    ar: {
        settings: "الإعدادات", back: "١٠ ثوانٍ", forward: "٣٠ ثانية", rewind45: "٤٥ ثانية",
        videoFooter: "تستخدمها ضغطات اليسار واليمين على جهاز التحكم عن بُعد وأزرار التخطي على الشاشة. تنطبق على كل جهاز مسجّل الدخول إلى هذا الملف الشخصي.",
        audiobookFooter: "تستخدمها أزرار التخطي في مشغّل الكتب الصوتية. تنطبق على كل جهاز مسجّل الدخول إلى هذا الملف الشخصي.",
    },
} as const;

async function withPlayback(language: keyof typeof LANGUAGES, prepare: (settings: FakeSettings) => void, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    if (language !== "en") settings.profile().set(APP_LANGUAGE_KEY, language);
    prepare(settings);
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        // The profile menu opens in the language the top bar shows, so wait for the language's file to land.
        if (language !== "en") await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(translate("topBar.forYou", undefined, language)), `the ${language} top bar`);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: LANGUAGES[language].settings, exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="seek-back"]').waitFor();
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

const rowValue = (tv: Tv, row: string): Promise<string | null> => tv.page.locator(`[data-focus="${row}"] .settings-row-value`).textContent();

for (const language of ["en", "de", "ar"] as const) {
    test(`the skip intervals and their help lines read from Apple's keys in ${language}`, async () => {
        const text = LANGUAGES[language];
        await withPlayback(language, () => undefined, async tv => {
            for (const row of ["seek-back", "audiobook-seek-back"]) assert.equal(await rowValue(tv, row), text.back, row);
            for (const row of ["seek-forward", "audiobook-seek-forward"]) assert.equal(await rowValue(tv, row), text.forward, row);
            const lines = await tv.page.locator(".settings-pane .settings-value").allTextContents();
            assert.ok(lines.includes(text.videoFooter), `the Video help line is Apple TV's key, in ${language}`);
            assert.ok(lines.includes(text.audiobookFooter), `the Audiobooks help line is Apple's key, in ${language}`);
            await tv.page.locator('[data-focus="seek-back"]').click();
            await tv.page.getByRole("radio", { name: text.back, exact: true }).waitFor();
            await tv.page.getByRole("radio", { name: text.rewind45, exact: true }).waitFor();
            assert.equal(await tv.page.getByRole("radio").count(), 7, "all seven choices");
        });
    });
}

test("a skip picker opens on the stored choice, as Apple's picker sheet does, and on the default when nothing is stored", async () => {
    await withPlayback("de", settings => settings.profile().set(AUDIOBOOK_SEEK_BACK_KEY, 45), async tv => {
        await tv.page.locator('[data-focus="audiobook-seek-back"]').click();
        await tv.page.locator('[data-focus="audiobook-seek-back:45"]').waitFor();
        assert.equal(await tv.focused(), "audiobook-seek-back:45", "the stored choice, not the first");
        await tv.remote(10009);
        await tv.page.getByRole("dialog").waitFor({ state: "detached" });
        await tv.page.locator('[data-focus="seek-forward"]').click();
        await tv.page.locator('[data-focus="seek-forward:30"]').waitFor();
        assert.equal(await tv.focused(), "seek-forward:30", "the inherited default when no choice is stored");
    });
});
