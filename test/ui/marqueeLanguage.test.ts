// The Home marquee keeps its card's runtime in the language the app shows when the profile's language lands
// after the marquee settled, while a top-bar button has focus (silo-apple tvOS/Components/TVFocusMarquee.swift).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

test("a language that arrives while a top-bar button has focus repaints the marquee's runtime", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new FakeHome();
        catalog.progress.set("movie:m0001", 1200);
        tv.fake.catalog = catalog;
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        settings.profile().set(APP_LANGUAGE_KEY, "de");
        // The profile's language answers late; Browse makes several effective reads at launch, so hold the first few.
        const held = Array.from({ length: 8 }, () => tv.fake.hold("/settings/values/effective", true));
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();

        await tv.page.locator('[data-section="resume/opaque"] [data-focus="movie:m0001"]').focus();
        const marquee = tv.page.locator(".skyline-meta-line").first();
        await tv.eventually(async () => (await marquee.innerText()).endsWith("1h 30m"), "English runtime on the marquee");
        await tv.page.locator('[data-focus="calendar"]').focus();
        held.forEach(hold => hold.release());
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes("Kalender"), "German top bar");
        assert.equal(await tv.focused(), "calendar");
        await tv.eventually(async () => (await marquee.innerText()).endsWith("1h 30min"), "German runtime on the retained marquee");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
