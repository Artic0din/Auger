// Details facts' dates follow the language the app shows, not the TV's own locale (#592).
// silo-apple DetailDateFormatting.longDate: `.long` date style in AppLanguage.formattingLocale.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { afterPaint, homeDetailsRead, launchBrowser, openTv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function releasedFact(language: string | null): Promise<string> {
    const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const catalog = new FakeDetails();
        catalog.releaseDate = "2024-01-02";
        tv.fake.catalog = catalog;
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        if (language !== null) settings.profile().set(APP_LANGUAGE_KEY, language);
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(false));
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
        await homeDetailsRead(tv);
        const shown = language ?? "en";
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(translate("topBar.forYou", undefined, shown)), `${shown} top bar`);
        await afterPaint(tv);
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
        await tv.page.keyboard.press("Enter");
        const label = translate("detail.released", undefined, shown).toLocaleUpperCase(shown);
        const row = tv.page.locator(".details-fact-row").filter({ has: tv.page.locator("dt", { hasText: label }) });
        await row.waitFor();
        const value = await row.locator("dd").innerText();
        assert.deepEqual(tv.console, []);
        return value;
    } finally { await tv.page.context().close(); }
}

test("Details' Released date reads in German on an English TV", async () => {
    assert.equal(await releasedFact("de"), "2. Januar 2024");
});

test("Details' Released date keeps the English TV's long form in English", async () => {
    assert.equal(await releasedFact(null), "2 January 2024");
});
