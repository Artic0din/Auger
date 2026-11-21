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

const DATE_FACTS = [["release_date", "detail.released"], ["air_date", "detail.aired"], ["first_air_date", "detail.firstAired"], ["last_air_date", "detail.lastAired"]] as const;

/** Each date fact's shown value, by its `item_detail` field. */
async function dateFacts(language: string | null): Promise<Record<string, string>> {
    const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const catalog = new FakeDetails();
        Object.assign(catalog.factDates, { release_date: "2024-01-02", air_date: "2023-11-30", first_air_date: "2021-08-06", last_air_date: "2026-07-13" });
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
        await tv.page.locator(".details-fact-row").first().waitFor();
        const values: Record<string, string> = {};
        for (const [field, key] of DATE_FACTS) {
            const label = translate(key, undefined, shown).toLocaleUpperCase(shown);
            // Exact label: German's "Ausstrahlung" labels contain each other.
            values[field] = await tv.page.locator(".details-fact-row").filter({ has: tv.page.locator("dt", { hasText: new RegExp(`^${label}$`) }) }).locator("dd").innerText();
        }
        assert.deepEqual(tv.console, []);
        return values;
    } finally { await tv.page.context().close(); }
}

test("Details' date facts read in German on an English TV", async () => {
    // The Pro's S95C capture of Spidey: "ERSTAUSSTRAHLUNG 6. August 2021", "LETZTE AUSSTRAHLUNG 13. Juli 2026".
    assert.deepEqual(await dateFacts("de"), { release_date: "2. Januar 2024", air_date: "30. November 2023", first_air_date: "6. August 2021", last_air_date: "13. Juli 2026" });
});

test("Details' date facts keep the English TV's long form in English", async () => {
    assert.deepEqual(await dateFacts(null), { release_date: "2 January 2024", air_date: "30 November 2023", first_air_date: "6 August 2021", last_air_date: "13 July 2026" });
});
