// Settings › Playback's skip-interval pickers are titled by media kind, as silo-apple TVPlaybackSettingsView.skipIntervalPickerTitle
// does ("Video Skip Back", "Audiobook Skip Back"), in English, German and Arabic. The rows keep the short "Skip Back" and "Skip Forward".
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/** The title each picker opens with, from silo-translations a0142c1 (`settings.skipIntervals.picker.*`). */
const TITLES = {
    en: { settings: "Settings", video: ["Video Skip Back", "Video Skip Forward"], audiobook: ["Audiobook Skip Back", "Audiobook Skip Forward"] },
    de: { settings: "Einstellungen", video: ["Video-Sprung zurück", "Video-Sprung vorwärts"], audiobook: undefined },
    ar: { settings: "الإعدادات", video: ["التخطي للخلف في الفيديو", "التخطي للأمام في الفيديو"], audiobook: undefined },
} as const;

async function withPlayback(language: keyof typeof TITLES, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    if (language !== "en") settings.profile().set(APP_LANGUAGE_KEY, language);
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: TITLES[language].settings, exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="seek-back"]').waitFor();
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

for (const language of ["en", "de", "ar"] as const) {
    test(`the video skip pickers open as Apple titles them in ${language}, apart from the audiobook ones`, async () => {
        await withPlayback(language, async tv => {
            const [back, forward] = TITLES[language].video;
            for (const [row, title] of [["seek-back", back], ["seek-forward", forward]] as const) {
                await tv.page.locator(`[data-focus="${row}"]`).click();
                await tv.page.getByRole("heading", { name: title, exact: true }).waitFor();
                // The picker is the only dialog; Back returns to the row that opened it.
                await tv.remote(10009);
                await tv.page.getByRole("dialog").waitFor({ state: "detached" });
                assert.equal(await tv.focused(), row, "Back returns to the row");
            }
            const audiobook = TITLES[language].audiobook;
            if (audiobook !== undefined) {
                await tv.page.locator('[data-focus="audiobook-seek-back"]').click();
                await tv.page.getByRole("heading", { name: audiobook[0], exact: true }).waitFor();
            }
        });
    });
}
