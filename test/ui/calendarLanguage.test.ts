// Calendar in German and Arabic (silo-apple Screens/Calendar/*): the filters, week strip, cards and empty state read from the
// catalog and the shown language's dates and clock; in Arabic the page mirrors as SwiftUI's leading and trailing alignments do.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, CDPSession } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { formattingLocale } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeCalendar } from "../native/support/fakeCalendar.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { afterPaint, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37;
const RIGHT = 39;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);

async function inLanguage(language: string, body: (tv: Tv, catalog: FakeCalendar) => Promise<void>, catalog = new FakeCalendar(), device?: string): Promise<void> {
    const tv = await openTv(browser, { app: "browse", ...(device === undefined ? {} : { locale: device }) });
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, language);
    try {
        const cdp: CDPSession = await tv.page.context().newCDPSession(tv.page);
        await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Australia/Melbourne" });
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", `${language} top bar`);
        await afterPaint(tv);
        await tv.page.locator('[data-focus="calendar"]').click();
        await tv.page.locator('.browse[data-view="calendar"]').waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-calendar-busy="false"]').count() === 1 && await tv.page.locator(".calendar-loading").count() === 0, "calendar read");
        await body(tv, catalog);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("Calendar's filters, week strip and finale card read in German", async () => {
    await inLanguage("de", async tv => {
        assert.deepEqual(await tv.page.locator('.calendar-filters [data-focus^="filter:"]').allInnerTexts(), [text("calendar.filter.following", "de"), text("calendar.filter.trending", "de"), text("calendar.filter.all", "de")]);
        assert.equal(await tv.page.locator('[data-focus="previous-week"]').getAttribute("aria-label"), text("calendar.previousWeek", "de"));
        assert.equal(await tv.page.locator('[data-focus="next-week"]').getAttribute("aria-label"), text("calendar.nextWeek", "de"));
        assert.deepEqual(await tv.page.locator(".calendar-weekday").allInnerTexts(), ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"], "Apple's stand-alone abbreviations, without the period");
        const month = await tv.page.locator(".calendar-month").innerText();
        assert.match(month, /^Januar 2026$/, "the month is German");
        await tv.page.locator('[data-focus="filter:everything"]').click();
        const card = tv.page.locator('.calendar-event[data-content-id="episode:s1e22"]');
        await card.waitFor();
        // Apple's clock follows the device's region (en_AU or en_US here: 12-hour), not the language: German reads "8:00 AM", not "08:00".
        assert.equal(await card.locator(".calendar-time").textContent(), "8:00 AM");
        assert.equal(await card.locator(".calendar-release").textContent(), text("calendar.badge.finale", "de"));
        assert.equal(await card.locator(".browse-card-subtitle").textContent(), `${text("catalog.episodeCaption", "de", { season: "2", episode: "2" })} · The Crossing`);
    });
});

test("Calendar's empty state and its other filters read in German", async () => {
    const catalog = new FakeCalendar();
    catalog.events = [];
    await inLanguage("de", async tv => {
        assert.equal(await tv.page.locator(".calendar-empty .search-state-title").innerText(), text("calendar.empty.following", "de"));
        assert.equal(await tv.page.locator(".calendar-empty .search-state-description").innerText(), text("calendar.empty.followingBody", "de"));
        assert.deepEqual(await tv.page.locator(".calendar-empty-links [data-focus]").allInnerTexts(), [text("calendar.filter.trending", "de"), text("calendar.filter.all", "de")]);
    }, catalog);
});

test("in Arabic the week strip, shelves and card corners are mirrored", async () => {
    const catalog = new FakeCalendar();
    catalog.watchedEpisodes.add("episode:s1e22");
    await inLanguage("ar", async tv => {
        await tv.eventually(async () => await tv.page.evaluate(() => document.documentElement.getAttribute("dir")) === "rtl", "dir rtl");
        assert.deepEqual(await tv.page.locator('.calendar-filters [data-focus^="filter:"]').allInnerTexts(), [text("calendar.filter.following", "ar"), text("calendar.filter.trending", "ar"), text("calendar.filter.all", "ar")]);
        const strip = await tv.page.evaluate(() => {
            const left = (key: string): number => document.querySelector(`[data-focus="${key}"]`)?.getBoundingClientRect().left ?? Number.NaN;
            const days = Array.from(document.querySelectorAll(".calendar-day")).map(day => day.getBoundingClientRect().left);
            return { previous: left("previous-week"), next: left("next-week"), days, direction: getComputedStyle(document.querySelector(".calendar-week") as Element).direction };
        });
        assert.equal(strip.direction, "rtl");
        assert.ok(strip.previous > strip.next, `Previous week leads on the right: ${JSON.stringify(strip)}`);
        assert.ok(strip.days[0]! > strip.days[6]!, `Monday is the rightmost day: ${JSON.stringify(strip)}`);
        assert.deepEqual((await tv.page.locator(".calendar-weekday").allInnerTexts()).slice(0, 2), ["اثنين", "ثلاثاء"], "without the article Chromium adds");
        await tv.page.locator('[data-focus="filter:everything"]').click();
        const card = tv.page.locator('.calendar-event[data-content-id="episode:s1e22"]');
        await card.waitFor();
        assert.equal(await card.locator(".calendar-time").textContent(), "٨:٠٠ ص");
        const corners = await card.evaluate(node => {
            const art = node.querySelector(".browse-art")!.getBoundingClientRect();
            const near = (selector: string): { start: number; end: number } => { const box = node.querySelector(selector)!.getBoundingClientRect(); return { start: box.left - art.left, end: art.right - box.right }; };
            return { release: near(".calendar-release"), watched: near(".calendar-watched"), time: near(".calendar-time") };
        });
        assert.ok(corners.release.end < corners.release.start, `the release badge is top-leading, on the right: ${JSON.stringify(corners)}`);
        assert.ok(corners.watched.start < corners.watched.end, `the watched mark is top-trailing, on the left: ${JSON.stringify(corners)}`);
        assert.ok(corners.time.start < corners.time.end, `the time is bottom-trailing, on the left: ${JSON.stringify(corners)}`);
        await tv.page.locator('[data-focus="day:2026-01-02"]').focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "day:2026-01-03", "Left steps to the next day, which lies on the left");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "day:2026-01-02");
    }, catalog);
});

test("German air times follow the device's region: 12-hour for an Australian or US TV, 24-hour for a German one", async () => {
    for (const [device, expected] of [["en-AU", "8:00 AM"], ["de-DE", "08:00"]] as const) {
        await inLanguage("de", async tv => {
            await tv.page.locator('[data-focus="filter:everything"]').click();
            const card = tv.page.locator('.calendar-event[data-content-id="episode:s1e22"]');
            await card.waitFor();
            assert.equal(await card.locator(".calendar-time").textContent(), expected, device);
        }, new FakeCalendar(), device);
    }
});
