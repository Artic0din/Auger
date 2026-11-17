// Arabic shown right to left (silo-apple iOSApp.swift `AppLanguageEnvironment`, DesignSystem/MediaLayoutDirection.swift):
// the document takes dir="rtl" with the language, at launch and on a change, and Left and Right on the remote follow
// the mirrored layout, as `MoveCommandDirection.inLayout` makes them on tvOS.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const BACK = 10009;
const LEFT = 37;
const RIGHT = 39;
const DOWN = 40;

interface HomeOptions {
    readonly stored?: string;
    readonly cached?: string;
    /** Holds the profile's language answer, so only the kept language can have set the direction. */
    readonly holdLanguage?: boolean;
    /** Offers Switch Server in the profile menu. */
    readonly switchServer?: boolean;
}

async function withHome(options: HomeOptions, body: (tv: Tv, releaseLanguage: () => void) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeHome();
    let held: { release(): void }[] = [];
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    if (options.stored !== undefined) settings.profile().set(APP_LANGUAGE_KEY, options.stored);
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        if (options.cached !== undefined) await tv.page.evaluate(choice => window.browseHarness.seedAppLanguage(choice), options.cached);
        if (options.holdLanguage === true) held = Array.from({ length: 8 }, () => tv.fake.hold("/settings/values/effective", true));
        if (options.switchServer === true) await tv.page.evaluate(() => { window.browseHarness.offerSwitchServer = true; });
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, () => held.forEach(hold => hold.release()));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

const direction = (tv: Tv): Promise<string | null> => tv.page.evaluate(() => document.documentElement.getAttribute("dir"));
const waitForDirection = (tv: Tv, expected: string | null): Promise<void> => tv.eventually(async () => await direction(tv) === expected, `dir ${expected}`);
const left = (tv: Tv, selector: string): Promise<number> => tv.page.locator(selector).evaluate(node => node.getBoundingClientRect().left);
/** The card the focus is on, as its left edge, so a test can say which way a move went. */
const focusedLeft = (tv: Tv): Promise<number> => tv.page.evaluate(() => document.activeElement?.getBoundingClientRect().left ?? Number.NaN);

test("a kept Arabic mirrors the page at launch, before the server answers", async () => {
    await withHome({ cached: "ar", stored: "ar", holdLanguage: true }, async (tv, releaseLanguage) => {
        await waitForDirection(tv, "rtl");
        assert.equal(await tv.page.evaluate(() => getComputedStyle(document.body).direction), "rtl");
        releaseLanguage();
        await tv.eventually(async () => tv.pendingReplies === 0, "answers in");
        assert.equal(await direction(tv), "rtl", "the server's answer keeps it");
    });
});

test("English and German leave the page left to right", async () => {
    await withHome({}, async tv => {
        assert.equal(await direction(tv), null);
    });
    await withHome({ stored: "de" }, async tv => {
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", "German top bar");
        assert.equal(await direction(tv), null);
    });
});

test("Arabic loses its direction when browse is torn down, so the English sign-in screens read left to right", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.evaluate(() => window.browseHarness.destroy());
        assert.equal(await direction(tv), null);
    });
});

/** The category list is on the side the layout reads from. Polled: the panes settle a frame after the repaint that mirrors them. */
const categoriesLead = (tv: Tv, side: "left" | "right"): Promise<void> => tv.eventually(async () => {
    const categories = await left(tv, ".settings-categories"), rows = await left(tv, ".settings-pane.settings-controls");
    return side === "left" ? categories < rows : categories > rows;
}, `the categories lead on the ${side}`);

async function openSettings(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('.skyline-selector [data-focus="settings"]').click();
    await tv.page.locator('[data-focus="app-language"]').waitFor();
}

test("picking Arabic in Settings mirrors the page in the repaint that changes its words, and picking English returns it", async () => {
    await withHome({}, async tv => {
        await openSettings(tv);
        assert.equal(await direction(tv), null);
        await categoriesLead(tv, "left");
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "العربية", exact: true }).click();
        await waitForDirection(tv, "rtl");
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() !== "Settings", "Settings in Arabic");
        await categoriesLead(tv, "right");
        // The row's forward chevron points the way a forward chevron does in Arabic.
        assert.equal(await tv.page.locator(".settings .settings-chevron").first().evaluate(node => getComputedStyle(node).transform), "matrix(-1, 0, 0, 1, 0, 0)");

        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "English", exact: true }).click();
        await waitForDirection(tv, null);
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() === "Settings", "Settings in English");
        await categoriesLead(tv, "left");
        assert.equal(await tv.page.locator(".settings .settings-chevron").first().evaluate(node => getComputedStyle(node).transform), "none");
    });
});

test("in Arabic the top bar's Left press moves to the tab on its left, and Right returns", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.eventually(async () => await tv.page.locator('[data-focus="movies"]').innerText() !== "Movies", "Arabic top bar");
        await tv.page.locator('[data-focus="home"]').focus();
        const home = await left(tv, '[data-focus="home"]');
        assert.ok(await left(tv, '[data-focus="movies"]') < home, "Movies follows Home to its left");
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "movies");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "home");
    });
});

test("in English the same Right press moves to the next tab, as before", async () => {
    await withHome({}, async tv => {
        await tv.page.locator('[data-focus="home"]').focus();
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "movies");
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "home");
    });
});

test("in Arabic a row steps toward the card on the left with Left and back with Right", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
        await cards.first().focus();
        const first = await focusedLeft(tv);
        await tv.remote(LEFT);
        const second = await focusedLeft(tv);
        assert.ok(second < first, `Left moved from x ${first} to ${second}`);
        assert.equal(await tv.focused(), await cards.nth(1).getAttribute("data-focus"));
        await tv.remote(RIGHT);
        assert.equal(await focusedLeft(tv), first);
        await tv.remote(RIGHT);
        assert.equal(await focusedLeft(tv), first, "Right past the first card stays on it");
    });
});

test("in Arabic a long row scrolls to keep the focused card on screen as Left walks it", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
        const total = await cards.count();
        assert.ok(total >= 12, `${total} cards`);
        await cards.first().focus();
        for (let step = 1; step < 12; step++) {
            await tv.remote(LEFT);
            const card = await tv.page.evaluate(() => { const rect = document.activeElement?.getBoundingClientRect(); return rect === undefined ? undefined : { left: rect.left, right: rect.right }; });
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `card ${step} at ${card?.left}..${card?.right}`);
        }
        assert.equal(await tv.focused(), await cards.nth(11).getAttribute("data-focus"));
        for (let step = 0; step < 11; step++) await tv.remote(RIGHT);
        assert.equal(await tv.focused(), await cards.first().getAttribute("data-focus"));
    });
});

test("in Arabic Settings, Left from the category list enters the rows that lie to its left, and Right returns", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await openSettings(tv);
        await tv.page.locator('.settings-categories [aria-selected="true"], .settings-categories [aria-current="true"], .settings-categories .browse-button').first().focus();
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".settings-categories") !== null), true);
        await tv.remote(LEFT);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".settings-pane.settings-controls") !== null), true, "Left enters the rows");
        await tv.remote(RIGHT);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".settings-categories") !== null), true, "Right returns to the categories");
        await tv.remote(DOWN);
        await tv.remote(BACK);
    });
});

const box = (tv: Tv, selector: string): Promise<{ left: number; right: number }> => tv.page.locator(selector).evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });

test("in Arabic the profile menu opens under the profile button, at the left edge", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(DOWN);
        const panel = tv.page.locator(".skyline-selector:not(.skyline-flyout)");
        await panel.waitFor();
        const button = await box(tv, '[data-focus="profiles"]');
        const menu = await box(tv, ".skyline-selector:not(.skyline-flyout)");
        assert.ok(Math.abs(menu.left - button.left) < 1, `menu at ${menu.left}, button at ${button.left}`);
    });
});

for (const [language, enter, leave] of [["ar", LEFT, RIGHT], ["en", RIGHT, LEFT]] as const) {
    test(`a library's sections open on its ${language === "ar" ? "left" : "right"} with ${language === "ar" ? "Left" : "Right"}, and the opposite key returns`, async () => {
        await withHome(language === "ar" ? { stored: "ar" } : {}, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            await tv.page.locator('[data-focus="movies"]').focus();
            await tv.remote(DOWN);
            const panel = tv.page.locator(".skyline-selector:not(.skyline-flyout)");
            await panel.waitFor();
            const library = await tv.focused();
            await tv.remote(enter);
            const flyout = await box(tv, ".skyline-flyout");
            const menu = await box(tv, ".skyline-selector:not(.skyline-flyout)");
            if (language === "ar") assert.ok(flyout.right <= menu.left, `flyout ${flyout.left}..${flyout.right} beside menu ${menu.left}..${menu.right}`);
            else assert.ok(flyout.left >= menu.right, `flyout ${flyout.left}..${flyout.right} beside menu ${menu.left}..${menu.right}`);
            assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".skyline-flyout") !== null), true, "focus is in the sections");
            await tv.remote(leave);
            assert.equal(await tv.focused(), library, "the opposite key returns to the library");
        });
    });
}

/** How far the focused card sits inside the row's `edge` side, after a step that had to scroll. */
const insetAfterScroll = (tv: Tv, edge: "left" | "right"): Promise<number> => tv.page.evaluate(edgeName => {
    const card = document.activeElement?.getBoundingClientRect();
    const row = document.activeElement?.closest(".browse-row")?.getBoundingClientRect();
    if (card === undefined || row === undefined) return Number.NaN;
    return edgeName === "left" ? card.left - row.left : row.right - card.right;
}, edge);

for (const [language, key, edge] of [["ar", LEFT, "left"], ["en", RIGHT, "right"]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} a row keeps the card Apple's 80 px inside its end edge as ${key === LEFT ? "Left" : "Right"} scrolls it`, async () => {
        await withHome(language === "ar" ? { stored: "ar" } : {}, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
            await cards.first().focus();
            // A card well inside the row, so the end of the row's scroll range does not limit the reveal.
            for (let step = 0; step < 9; step++) await tv.remote(key);
            const inset = await insetAfterScroll(tv, edge);
            assert.ok(Math.abs(inset - 80) <= 1, `card ${inset} px inside the ${edge} edge`);
        });
    });
}

test("in Arabic Left walks a Details episode rail past its first screen and keeps each card on screen", async () => {
    const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
    const details = new FakeDetails();
    tv.fake.catalog = details;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        const episodes = details.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**", route => route.fulfill({ json: { items: Array.from({ length: 12 }, (_, index) => ({ ...episodes.items[0], content_id: `episode:rail:1:${index}`, season_number: 1, episode_number: index + 1 })), next_cursor: null } }));
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:rail:1:11"]').waitFor();
        await tv.page.locator('[data-focus="episode:rail:1:0"]').focus();
        for (let step = 1; step < 12; step++) {
            await tv.remote(LEFT);
            const card = await tv.page.evaluate(() => { const rect = document.activeElement?.getBoundingClientRect(); return rect === undefined ? undefined : { left: rect.left, right: rect.right }; });
            assert.equal(await tv.focused(), `episode:rail:1:${step}`);
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `episode ${step} at ${card?.left}..${card?.right}`);
        }
    } finally { await tv.page.context().close(); }
});

test("a screen opened over Arabic browse reads left to right, and browse is mirrored again when it returns", async () => {
    await withHome({ stored: "ar", switchServer: true }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(DOWN);
        await tv.page.locator('.skyline-selector [data-focus="switch-server"]').click();
        await waitForDirection(tv, null);
        await tv.page.evaluate(() => window.browseHarness.coverBack?.());
        await waitForDirection(tv, "rtl");
        assert.equal(await tv.focused() !== null, true, "browse has focus again");
    });
});
