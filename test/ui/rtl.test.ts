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
import { openChangeAccount, withSignedInTv } from "./support/accounts.ts";
import { selectLibraryMode } from "./support/library.ts";
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
    /** Gives every title a backdrop, so Home's marquee draws artwork. */
    readonly backdrops?: boolean;
}

async function withHome(options: HomeOptions, body: (tv: Tv, releaseLanguage: () => void) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    if (options.backdrops === true) for (const [id, title] of [...catalog.titles]) catalog.titles.set(id, { ...title, backdrop: `/art/bd-${encodeURIComponent(id)}.svg` });
    tv.fake.catalog = catalog;
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
        // Hold the language read by key: holding the first eight effective reads held whichever came first, and the language answer could slip through.
        if (options.holdLanguage === true) held = Array.from({ length: 4 }, () => tv.fake.hold(`/settings/values/effective?keys=${APP_LANGUAGE_KEY}`, true));
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
        assert.equal(await tv.page.evaluate(() => document.documentElement.getAttribute("lang")), "ar");
        await tv.page.evaluate(() => window.browseHarness.destroy());
        assert.equal(await direction(tv), null);
        assert.equal(await tv.page.evaluate(() => document.documentElement.getAttribute("lang")), "en", "torn down: the default lang");
    });
});

/** The category list is on the side the layout reads from. Polled: the panes settle a frame after the repaint that mirrors them. */
const categoriesLead = (tv: Tv, side: "left" | "right"): Promise<void> => tv.eventually(async () => {
    const categories = await left(tv, ".settings-categories"), rows = await left(tv, ".settings-pane.settings-controls");
    return side === "left" ? categories < rows : categories > rows;
}, `the categories lead on the ${side}`);

/** The first forward chevron's transform once the repaint has drawn it (a node read mid-repaint has none). */
const chevronTransform = (tv: Tv, expected: string): Promise<void> => tv.eventually(async () => await tv.page.locator(".settings .settings-chevron").first().evaluate(node => getComputedStyle(node).transform) === expected, `chevron transform ${expected}`);

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
        await chevronTransform(tv, "matrix(-1, 0, 0, 1, 0, 0)");

        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "English", exact: true }).click();
        await waitForDirection(tv, null);
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() === "Settings", "Settings in English");
        await categoriesLead(tv, "left");
        await chevronTransform(tv, "none");
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
        // The library tabs come from their own answer; without them Right from Home reaches For You.
        await tv.page.locator('[data-focus="movies"]').waitFor();
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

/** How far the focused card sits inside the screen's `edge` side, after a step that had to scroll. */
const insetAfterScroll = (tv: Tv, edge: "left" | "right"): Promise<number> => tv.page.evaluate(edgeName => {
    const card = document.activeElement?.getBoundingClientRect();
    if (card === undefined) return Number.NaN;
    return edgeName === "left" ? card.left : 1920 - card.right;
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

/** Arabic Details for the series with `seasons` seasons of `episodes` episodes each, on the first season's page. */
async function withArabicSeries(seasons: number, episodes: number, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
    const details = new FakeDetails();
    tv.fake.catalog = details;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        const listed = details.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
        const first = details.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: Array.from({ length: seasons }, (_, index) => ({ ...listed.items[0], content_id: `season:${index + 1}`, season_number: index + 1, title: `Season ${index + 1}` })), next_cursor: null } }));
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**", route => {
            const number = Number(/seasons\/(\d+)\/episodes/.exec(route.request().url())?.[1]);
            return route.fulfill({ json: { items: Array.from({ length: episodes }, (_, index) => ({ ...first.items[0], content_id: `episode:rail:${number}:${index}`, season_number: number, episode_number: index + 1 })), next_cursor: null } });
        });
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
        await tv.page.locator('[data-focus="episode:rail:1:0"]').waitFor();
        await body(tv);
    } finally { await tv.page.context().close(); }
}

const onScreen = (tv: Tv): Promise<{ left: number; right: number } | undefined> => tv.page.evaluate(() => { const rect = document.activeElement?.getBoundingClientRect(); return rect === undefined ? undefined : { left: rect.left, right: rect.right }; });

test("in Arabic Left walks a Details episode rail to its last episode and keeps each card on screen", async () => {
    await withArabicSeries(1, 12, async tv => {
        await tv.page.locator('[data-focus="episode:rail:1:0"]').focus();
        for (let step = 1; step < 12; step++) {
            await tv.remote(LEFT);
            const card = await onScreen(tv);
            assert.equal(await tv.focused(), `episode:rail:1:${step}`);
            const row = await tv.page.locator(".details-episodes").evaluate(node => { const style = getComputedStyle(node); return { sl: node.scrollLeft, sw: node.scrollWidth, cw: node.clientWidth, pl: style.paddingLeft, pr: style.paddingRight, ml: style.marginLeft, mr: style.marginRight, rect: node.getBoundingClientRect().left + ".." + node.getBoundingClientRect().right }; });
            assert.ok(row.sl <= 0, `Arabic episode rail scrollLeft ${row.sl} should stay non-positive at step ${step}`);
            if (step === 11) assert.ok(row.sl < 0, `Arabic episode rail scrolled negatively (${row.sl})`);
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `episode ${step} at ${card?.left}..${card?.right}`);
        }
        for (let step = 0; step < 11; step++) await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "episode:rail:1:0");
        const back = await onScreen(tv);
        assert.ok(back !== undefined && back.left >= 0 && back.right <= 1920, `episode 0 back at ${back?.left}..${back?.right}`);
    });
});

test("in Arabic the selected season pill is brought on screen when it is picked, with 16 seasons", async () => {
    await withArabicSeries(16, 3, async tv => {
        const pills = tv.page.locator(".details-season-chips .browse-button");
        assert.equal(await pills.count(), 16);
        await pills.first().focus();
        for (let step = 1; step < 16; step++) await tv.remote(LEFT);
        const last = await onScreen(tv);
        assert.ok(last !== undefined && last.left >= 0 && last.right <= 1920, `pill 16 at ${last?.left}..${last?.right}`);
        // Select it: the picked pill is the one the rail centres (TVSeriesDetailView).
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.locator('.details-season-chips .browse-button[aria-pressed="true"]').innerText() === "Season 16", "Season 16 picked");
        await tv.page.locator('[data-focus="episode:rail:16:0"]').waitFor();
        const picked = await tv.page.locator('.details-season-chips .browse-button[aria-pressed="true"]').evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
        assert.ok(picked.left >= 0 && picked.right <= 1920, `picked pill at ${picked.left}..${picked.right}`);
    });
});

test("a screen opened over Arabic browse (Add Profile, Switch Server) keeps the mirrored page, as on Apple TV", async () => {
    await withHome({ stored: "ar", switchServer: true }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(DOWN);
        await tv.page.locator('.skyline-selector [data-focus="switch-server"]').click();
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.coverBack !== undefined), "the covering screen opened");
        assert.equal(await direction(tv), "rtl", "browse covered: the page stays right to left");
        await tv.page.evaluate(() => window.browseHarness.coverBack?.());
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await direction(tv), "rtl");
    });
});

test("in Arabic Search is mirrored under the top bar, as Home is, and reads the remote that way", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const directions = (): Promise<{ view: string | null; bar: string; content: string[] }> => tv.page.evaluate(() => ({
            view: document.querySelector("[data-view]")?.getAttribute("data-view") ?? null,
            bar: getComputedStyle(document.querySelector(".browse-nav") ?? document.documentElement).direction,
            content: Array.from(document.querySelectorAll("[data-view] > :not(.browse-nav, .skyline-selector, .skyline-dropdown-scrim, .skyline-leaving, .skyline-marquee)")).map(node => getComputedStyle(node).direction),
        }));
        const home = await directions();
        assert.equal(home.view, "home");
        assert.ok(home.content.length > 0 && home.content.every(direction => direction === "rtl"), `Home ${home.content}`);
        await tv.page.locator('[data-focus="search"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="search"]').waitFor();
        const search = await directions();
        assert.equal(search.bar, "rtl", "the top bar stays mirrored");
        assert.ok(search.content.length > 0 && search.content.every(direction => direction === "rtl"), `Search ${search.content}`);
        // A key pressed in Search is read right to left: the field's layout is the page's.
        assert.equal(await tv.page.evaluate(() => {
            const field = document.querySelector('[data-view="search"] input') as HTMLElement;
            return field.parentElement?.closest("[dir]")?.getAttribute("dir");
        }), "rtl");
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.ok((await directions()).content.every(direction => direction === "rtl"), "Home is still mirrored");
    });
});

for (const [language, options, step] of [["ar", { stored: "ar" }, LEFT], ["en", {}, RIGHT]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} a library's Browse grid reads ${language === "ar" ? "right to left, with its letter rail on the left" : "left to right, with its letter rail on the right"}, and ${language === "ar" ? "Left" : "Right"} at the last column enters the rail (TVLibraryGridView.swift:100-108)`, async () => {
        await withHome(options, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            await tv.page.locator('[data-focus="movies"]').click();
            await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
            await selectLibraryMode(tv, "Browse");
            const cards = tv.page.locator(".browse-grid [data-focus]");
            await cards.first().waitFor();
            const columns = await cards.evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().top === nodes[0]?.getBoundingClientRect().top).length);
            assert.ok(columns > 1, `${columns} columns`);
            const rail = await box(tv, ".browse-letters");
            const first = await box(tv, ".browse-grid [data-focus] >> nth=0");
            if (language === "ar") {
                assert.ok(rail.right < 960, `the rail is on the left (${rail.left}..${rail.right})`);
                assert.ok(first.left > 960, `the first card is on the right (${first.left})`);
                assert.ok(Math.abs(first.right - (1920 - 55)) <= 2, `the grid mirrors English's 55 px edge: first card ends at ${first.right}`);
            } else {
                assert.ok(rail.left > 960, `the rail is on the right (${rail.left}..${rail.right})`);
                assert.ok(first.right < 960, `the first card is on the left (${first.right})`);
                assert.ok(Math.abs(first.left - 55) <= 2, `the first card starts at ${first.left}`);
            }
            await cards.first().focus();
            for (let move = 0; move < columns - 1; move++) await tv.remote(step);
            assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".browse-grid") !== null), true, "the move walks the row to its last column");
            await tv.remote(step);
            assert.match(await tv.focused() ?? "", /^letter:/, "one more enters the letter rail");
            // The top bar is part of this view's content but is not the library's: it stays mirrored above the grid.
            const bar = await tv.page.evaluate(() => getComputedStyle(document.querySelector(".browse-nav") as Element).direction);
            assert.equal(bar, language === "ar" ? "rtl" : "ltr");
            if (language === "ar") {
                await tv.page.locator('[data-focus="home"]').focus();
                await tv.remote(LEFT);
                assert.equal(await tv.focused(), "movies", "Left in the mirrored top bar moves to the tab on its left");
            }
        });
    });
}

test("Change Account, opened from the profile menu in Arabic, is mirrored as on Apple TV", async () => {
    await withSignedInTv(browser, async tv => {
        await tv.eventually(async () => await tv.page.evaluate(() => document.documentElement.getAttribute("dir")) === "rtl", "dir rtl");
        await openChangeAccount(tv);
        const screen = await tv.page.evaluate(() => ({
            direction: getComputedStyle(document.querySelector('[data-view="change-account"] .accounts-screen') ?? document.body).direction,
            rail: document.querySelector(".accounts-rail")?.getBoundingClientRect().left ?? Number.NaN,
            pane: document.querySelector(".accounts-pane")?.getBoundingClientRect().left ?? Number.NaN,
        }));
        assert.equal(screen.direction, "rtl");
        assert.ok(screen.rail > screen.pane, `the server rail leads on the right (${screen.rail} vs ${screen.pane})`);
    }, "ar");
});

for (const [language, options] of [["ar", { stored: "ar" }], ["en", {}]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} Details' compressed text title keeps its edge on the column's leading side`, async () => {
        await withHome(options, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            await tv.page.locator('[data-section="recent/12"] [data-focus]').nth(1).focus();
            await tv.page.keyboard.press("Enter");
            await tv.page.locator(".details-editorial .requests-title-primary").waitFor();
            const edges = await tv.page.evaluate(() => {
                const title = document.querySelector(".details-editorial .requests-title-primary")?.getBoundingClientRect();
                const column = document.querySelector(".details-editorial")?.getBoundingClientRect();
                return title === undefined || column === undefined ? undefined : { title: { left: title.left, right: title.right }, column: { left: column.left, right: column.right } };
            });
            assert.ok(edges !== undefined);
            if (language === "ar") assert.ok(Math.abs(edges.title.right - edges.column.right) <= 2, `title right ${edges.title.right}, column right ${edges.column.right}`);
            else assert.ok(Math.abs(edges.title.left - edges.column.left) <= 2, `title left ${edges.title.left}, column left ${edges.column.left}`);
        });
    });
}

test("a language answer that turns the page right to left redraws the backdrop already shown, so its placeholder fades toward the text", async () => {
    await withHome({ cached: "en", stored: "ar", holdLanguage: true, backdrops: true }, async (tv, releaseLanguage) => {
        const art = ".skyline-marquee-art:not(.skyline-outgoing)";
        await tv.eventually(async () => await tv.page.locator(`${art} .skyline-art-frame`).getAttribute("data-art") === "loaded", "the backdrop shown while the language answer is out");
        // The placeholder bitmap is opaque on the text side.
        const textSide = (): Promise<string> => tv.page.locator(`${art} canvas.hero-art-bitmap`).evaluate(node => {
            const canvas = node as HTMLCanvasElement;
            const copy = document.createElement("canvas");
            copy.width = canvas.width;
            copy.height = canvas.height;
            const reader = copy.getContext("2d", { willReadFrequently: true });
            reader?.drawImage(canvas, 0, 0);
            const alpha = (x: number): number => reader?.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data[3] ?? -1;
            return alpha(2) > 235 ? "left" : alpha(canvas.width - 3) > 235 ? "right" : "none";
        });
        assert.equal(await textSide(), "right");
        releaseLanguage();
        await waitForDirection(tv, "rtl");
        await tv.eventually(async () => await textSide() === "left", "the backdrop's placeholder is drawn again for the mirrored page");
    });
});

test("in Arabic every layer of the hero artwork fades toward the text, which is on the right, and in English toward the left", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        // The artwork layers Details draws (heroBackdrop.ts), built bare so the page's own stylesheet decides their masks.
        const masks = (): Promise<{ name: string; mask: string }[]> => tv.page.evaluate(() => {
            const hero = document.createElement("div");
            hero.className = "details-hero";
            hero.innerHTML = '<div class="skyline-art-frame hero-art-surface"><canvas class="hero-art-thumbhash"></canvas><img class="skyline-backdrop" alt=""><div class="hero-art-missing"></div></div>';
            document.body.append(hero);
            const frame = hero.querySelector(".hero-art-surface") as Element;
            const layers: [string, CSSStyleDeclaration][] = [["frame backing", getComputedStyle(frame, "::before")]];
            for (const [name, selector] of [["preview", ".hero-art-thumbhash"], ["image", ".skyline-backdrop"], ["missing", ".hero-art-missing"]] as const) layers.push([name, getComputedStyle(frame.querySelector(selector) as Element)]);
            const result = layers.map(([name, style]) => ({ name, mask: style.maskImage }));
            hero.remove();
            return result;
        });
        for (const layer of await masks()) assert.match(layer.mask, /to right/, `${layer.name}: ${layer.mask}`);
        await tv.page.evaluate(() => document.documentElement.removeAttribute("dir"));
        for (const layer of await masks()) assert.match(layer.mask, /to left/, `${layer.name}: ${layer.mask}`);
    });
});

test("the document's lang follows the shown language: ar for Arabic, and the default again for Match Device", async () => {
    await withHome({}, async tv => {
        const lang = (): Promise<string | null> => tv.page.evaluate(() => document.documentElement.getAttribute("lang"));
        assert.equal(await lang(), "en");
        await openSettings(tv);
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "العربية", exact: true }).click();
        await tv.eventually(async () => await lang() === "ar", "lang ar");
        await waitForDirection(tv, "rtl");
        // Match Device is the picker's first row; the TV's language here is English.
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio").first().click();
        await tv.eventually(async () => await lang() === "en", "lang back to en");
        await waitForDirection(tv, null);
    });
});

test("in Arabic Left from season 1's first episode to season 2's last (Big Mood's S02E06) keeps every card on screen and shows season 2", async () => {
    await withArabicSeries(2, 6, async tv => {
        await tv.page.locator('[data-focus="episode:rail:1:0"]').focus();
        const trail: string[] = [];
        for (let step = 1; step < 12; step++) {
            await tv.remote(LEFT);
            await tv.eventually(async () => (await tv.focused())?.startsWith("episode:rail:") === true, "an episode has focus");
            const card = await onScreen(tv);
            trail.push(`${await tv.focused()} ${Math.round(card?.left ?? NaN)}..${Math.round(card?.right ?? NaN)}`);
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, trail.join(" | "));
        }
        assert.equal(await tv.focused(), "episode:rail:2:5", "the last episode, S02E06");
        const pressed = await tv.page.locator('.details-season-chips .browse-button[aria-pressed="true"]').innerText();
        assert.equal(pressed, "Season 2", "the season pills follow the focused episode");
    });
});

test("Change Account, over Arabic browse, follows the shown language on its own root: lang=ar, not lang=en", async () => {
    await withSignedInTv(browser, async tv => {
        await tv.eventually(async () => await tv.page.evaluate(() => document.documentElement.getAttribute("dir")) === "rtl", "dir rtl");
        await openChangeAccount(tv);
        const langs = await tv.page.evaluate(() => ({
            document: document.documentElement.getAttribute("lang"),
            screen: document.querySelector('[data-view="change-account"]')?.getAttribute("lang") ?? null,
            direction: getComputedStyle(document.querySelector('[data-view="change-account"]') as Element).direction,
        }));
        assert.deepEqual(langs, { document: "ar", screen: "ar", direction: "rtl" }, "Arabic text, mirrored layout");
    }, "ar");
});

test("the sign-in and profile screens (Add Profile among them) are marked lang=en while the document says ar", async () => {
    const tv = await openTv(browser);
    try {
        await tv.page.evaluate(() => { document.documentElement.setAttribute("lang", "ar"); document.documentElement.setAttribute("dir", "rtl"); });
        await tv.page.locator("section.signin-screen").first().waitFor();
        const langs = await tv.page.evaluate(() => Array.from(document.querySelectorAll("section.signin-screen")).map(node => node.getAttribute("lang")));
        assert.ok(langs.length > 0 && langs.every(lang => lang === "en"), JSON.stringify(langs));
    } finally { await tv.page.context().close(); }
});

test("in Arabic Home's artwork placeholder layers fade toward the text, like its loaded image", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const masks = await tv.page.evaluate(() => {
            const home = document.querySelector(".skyline-home") as Element;
            const frame = document.createElement("div");
            frame.className = "skyline-art-frame hero-art-surface";
            frame.innerHTML = '<canvas class="hero-art-thumbhash"></canvas><img class="skyline-backdrop" alt=""><div class="hero-art-missing"></div>';
            home.append(frame);
            const layers: [string, CSSStyleDeclaration][] = [["frame backing", getComputedStyle(frame, "::before")]];
            for (const [name, selector] of [["preview", ".hero-art-thumbhash"], ["image", ".skyline-backdrop"], ["missing", ".hero-art-missing"]] as const) layers.push([name, getComputedStyle(frame.querySelector(selector) as Element)]);
            const result = layers.map(([name, style]) => ({ name, mask: style.maskImage }));
            frame.remove();
            return result;
        });
        for (const layer of masks) assert.match(layer.mask, /to right/, `${layer.name}: ${layer.mask}`);
    });
});

test("in Arabic an aspect-fitted title logo sits against the mirrored marquee's right edge", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        const position = await tv.page.evaluate(() => {
            const logo = document.createElement("img");
            logo.className = "skyline-logo";
            document.querySelector(".skyline-marquee")?.append(logo);
            const value = getComputedStyle(logo).objectPosition;
            logo.remove();
            return value;
        });
        assert.match(position, /^(100%|right)/, position);
    });
});

test("a Home shelf scrolled in Arabic keeps its card on screen when the server's English overrules the kept language", async () => {
    await withHome({ cached: "ar", stored: "en", holdLanguage: true }, async (tv, releaseLanguage) => {
        await waitForDirection(tv, "rtl");
        const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
        await cards.first().focus();
        for (let step = 0; step < 9; step++) await tv.remote(LEFT);
        const before = await tv.focused();
        releaseLanguage();
        await waitForDirection(tv, null);
        await tv.eventually(async () => await tv.focused() === before, "focus stays on the viewer's card");
        const card = await onScreen(tv);
        assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `${before} at ${card?.left}..${card?.right}`);
    });
});

/** True when the words of `text` read in the order written: the leading number is left of the first word, as on Apple TV. */
const readsAsWritten = (tv: Tv, selector: string, number: string, word: string): Promise<{ text: string; unicodeBidi: string; textAlign: string; asWritten: boolean } | undefined> => tv.page.evaluate(([css, first, second]) => {
    // Details draws its title in capitals, so the words are matched without case.
    const has = (node: Node): boolean => node.textContent?.toLowerCase().includes((second as string).toLowerCase()) === true;
    // The element that holds the words itself, not one of its ancestors in the list.
    const owner = (node: Element): ChildNode | undefined => Array.from(node.childNodes).find(child => child.nodeType === Node.TEXT_NODE && has(child));
    const element = Array.from(document.querySelectorAll(css as string)).find(node => owner(node) !== undefined);
    const text = element === undefined ? undefined : owner(element);
    if (element === undefined || text === undefined) return undefined;
    const content = (text.textContent ?? "").toLowerCase();
    const rect = (from: number, length: number): DOMRect => { const range = document.createRange(); range.setStart(text, from); range.setEnd(text, from + length); return range.getBoundingClientRect(); };
    const numberAt = content.indexOf(first as string), wordAt = content.indexOf((second as string).toLowerCase());
    return { text: text.textContent ?? "", unicodeBidi: getComputedStyle(element).unicodeBidi, textAlign: getComputedStyle(element).textAlign, asWritten: rect(numberAt, (first as string).length).left < rect(wordAt, (second as string).length).left };
}, [selector, number, word] as const);

test("in Arabic a server title that starts with a number keeps its words in the order written, on Home, Details and Search", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    const movie = catalog.titles.get("movie:m0004");
    assert.ok(movie);
    catalog.titles.set(movie.id, { ...movie, title: "10 Cloverfield Lane" });
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await waitForDirection(tv, "rtl");

        const check = async (where: string, selector: string): Promise<void> => {
            let found: Awaited<ReturnType<typeof readsAsWritten>>;
            await tv.eventually(async () => { found = await readsAsWritten(tv, selector, "10", "Cloverfield"); return found !== undefined; }, `${where}: the title is drawn`);
            assert.ok(found?.asWritten, `${where}: "${found?.text}" reads reordered`);
            assert.match(found?.unicodeBidi ?? "", /plaintext/, `${where}: the title takes its direction from its own first letter`);
            // Apple aligns by the layout, not by the letters: a Latin title in Arabic sits on the right or is centred, never pushed to the left.
            assert.match(found?.textAlign ?? "", /^(right|center)$/, `${where}: the line is aligned by the layout, not by its letters`);
        };
        await check("Home card", '[data-section="recent/12"] .browse-card-title');
        await check("Home hero", ".skyline-title");

        await tv.page.locator('[data-section="recent/12"] [data-focus="movie:m0004"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view^="item:"]').waitFor();
        await check("Details", ".details-editorial .requests-title-primary, .details-editorial .browse-title");
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();

        await tv.page.locator('[data-focus="search"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator("#browse-search").waitFor();
        await tv.page.fill("#browse-search", "Cloverfield");
        await tv.remote(65376);
        await check("Search", '[data-view="search"] .browse-card-title');
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
        await selectLibraryMode(tv, "Browse");
        await check("Browse", ".browse-grid .browse-card-title");
    } finally { await tv.page.context().close(); }
});

test("in Arabic a library, profile or person name that starts with a number keeps its words in order in the menus and on Settings", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    const library = catalog.households.get("p-owner")?.libraries.find(item => item.id === "12");
    assert.ok(library);
    library.name = "4K Movies";
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.remote(DOWN);
        await tv.eventually(async () => await readsAsWritten(tv, ".skyline-menu-label", "4k", "Movies") !== undefined, "the library menu is drawn");
        const menu = await readsAsWritten(tv, ".skyline-menu-label", "4k", "Movies");
        assert.ok(menu?.asWritten, `"${menu?.text}" reads reordered in the library menu`);
        assert.match(menu?.unicodeBidi ?? "", /plaintext/);
        // Profile, Settings and person names share the same rule: their classes take the same isolation.
        const isolated = await tv.page.evaluate(() => [".skyline-profile-title", ".settings-profile-name", ".collection-detail-title", ".details-person-hero .browse-title"].map(selector => {
            const holder = document.createElement("div");
            holder.innerHTML = selector.includes("details-person-hero") ? '<div class="details-person-hero"><h1 class="browse-title">2 Fast</h1></div>' : `<span class="${selector.slice(1)}">2 Fast</span>`;
            document.body.append(holder);
            const style = getComputedStyle(holder.querySelector(selector) as Element);
            const result = { selector, bidi: style.unicodeBidi, align: style.textAlign };
            holder.remove();
            return result;
        }));
        for (const item of isolated) assert.match(item.bidi, /plaintext/, `${item.selector}: ${item.bidi}`);
    } finally { await tv.page.context().close(); }
});

const PEOPLE_ROUTE = "**/api/v2/catalog/people**";
const peopleFor = (route: { fulfill(options: { json: unknown }): Promise<void> }): Promise<void> => route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ id: `edge-${index}`, name: `Person ${index + 1}` })) } });

async function searchFor(tv: Tv, query: string): Promise<void> {
    await tv.page.route(PEOPLE_ROUTE, peopleFor);
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", query);
    await tv.remote(65376);
    await tv.page.locator('.browse-grid [data-focus="movie:m0002"]').waitFor();
}

for (const [language, options] of [["ar", { stored: "ar" }], ["en", {}]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} Search puts its field, People and results on the ${language === "ar" ? "right and reads them right to left" : "left and reads them left to right"} (SearchView.swift)`, async () => {
        await withHome(options, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            await searchFor(tv, "Movie 000");
            const rightward = language === "ar";
            const centre = async (selector: string): Promise<number> => { const rect = await box(tv, selector); return (rect.left + rect.right) / 2; };
            const field = await centre(".search-field-icon");
            assert.equal(field > 960, rightward, `the field's icon is on the ${rightward ? "right" : "left"} (${field})`);
            const [first, second] = [await centre('.browse-grid [data-focus="movie:m0001"]'), await centre('.browse-grid [data-focus="movie:m0002"]')];
            assert.equal(first > second, rightward, `the first result is on the ${rightward ? "right" : "left"} of the second (${first}, ${second})`);
            const [firstPerson, secondPerson] = [await centre('[data-focus="person:edge-0"]'), await centre('[data-focus="person:edge-1"]')];
            assert.equal(firstPerson > secondPerson, rightward, `the first person is on the ${rightward ? "right" : "left"} (${firstPerson}, ${secondPerson})`);
            // The count line starts on the layout's start side: the scene's 76 px and the line's 162 px in.
            const count = await tv.page.locator(".search-count").evaluate(node => { const range = document.createRange(); range.selectNodeContents(node); const rect = range.getBoundingClientRect(); return { left: rect.left, right: rect.right }; });
            if (rightward) assert.ok(Math.abs(count.right - (1920 - 238)) <= 2, `the count line ends at ${count.right}`);
            else assert.ok(Math.abs(count.left - 238) <= 2, `the count line starts at ${count.left}`);
            // Left and Right walk the results toward their end: right to left, Left is the next result.
            await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').focus();
            await tv.remote(rightward ? LEFT : RIGHT);
            assert.equal(await tv.focused(), "movie:m0002", "the next key reaches the next result");
            await tv.remote(rightward ? RIGHT : LEFT);
            assert.equal(await tv.focused(), "movie:m0001", "the opposite key returns");
        });
    });
}

for (const [language, options] of [["ar", { stored: "ar" }], ["en", {}]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} Search's box set badges, requests heading mark and full-row offsets sit on the layout's start and end sides (BoxSetCardBadges.swift, RequestSearchSectionView.swift)`, async () => {
        await withHome(options, async tv => {
            if (language === "ar") await waitForDirection(tv, "rtl");
            // The pieces Search builds only for some answers, built bare so the page's own stylesheet places them.
            const placed = await tv.page.evaluate(() => {
                const scene = document.createElement("div");
                scene.className = "browse search-scene";
                scene.style.cssText = "position:fixed;top:0;left:0;width:1920px;visibility:hidden";
                scene.innerHTML = '<div class="box-set-card" style="width:220px;height:330px"><span class="box-set-label">Box set</span><span class="box-set-count">3 films</span></div>'
                    + '<h2 class="search-requests-heading"><span class="search-requests-symbol"></span>Available</h2>'
                    + '<p class="browse-text search-count">3 results</p>'
                    + '<div class="browse-grid" data-full-row="true" style="--search-columns:8"><button class="browse-card"></button><button class="browse-card search-last-row"></button></div>';
                document.body.append(scene);
                const rect = (selector: string): DOMRect => (scene.querySelector(selector) as HTMLElement).getBoundingClientRect();
                const style = (selector: string): CSSStyleDeclaration => getComputedStyle(scene.querySelector(selector) as HTMLElement);
                const card = rect(".box-set-card"), label = rect(".box-set-label"), count = rect(".box-set-count"), heading = rect(".search-requests-heading"), symbol = rect(".search-requests-symbol");
                const result = {
                    labelStart: document.dir === "rtl" ? card.right - label.right : label.left - card.left,
                    countEnd: document.dir === "rtl" ? count.left - card.left : card.right - count.right,
                    symbolStart: document.dir === "rtl" ? heading.right - symbol.right : symbol.left - heading.left,
                    textMargins: { left: style(".search-count").marginLeft, right: style(".search-count").marginRight },
                    gridMargins: { left: style(".browse-grid").marginLeft, right: style(".browse-grid").marginRight },
                    lastRow: { left: style(".search-last-row").left, right: style(".search-last-row").right },
                };
                scene.remove();
                return result;
            });
            const rightToLeft = language === "ar";
            assert.equal(placed.labelStart, 12, "the BOX SET label is 12 px in from the top-leading corner");
            assert.equal(placed.countEnd, 12, "the film count is 12 px in from the bottom-trailing corner");
            assert.equal(placed.symbolStart, -27, "the requests mark sits 27 px before the heading's start");
            // 8 columns are 298 px wider than the 1444 px column, so a full row starts 298 px sooner than its 153 px edge, and its short last row steps back.
            assert.deepEqual(placed.gridMargins, rightToLeft ? { left: "153px", right: "-145px" } : { left: "-145px", right: "153px" });
            assert.deepEqual(placed.lastRow, rightToLeft ? { left: "-298px", right: "298px" } : { left: "298px", right: "-298px" });
            assert.deepEqual(placed.textMargins, { left: "162px", right: "162px" }, "the count line keeps 162 px on both sides");
        });
    });
}

test("in Arabic the Search field aligns by what is typed, as Apple TV's field does: Latin text such as Aladdin reads left to right, Arabic and an empty field follow the layout", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="search"]').click();
        const field = tv.page.locator("#browse-search");
        const read = (): Promise<{ direction: string; textAlign: string }> => field.evaluate(node => { const computed = getComputedStyle(node); return { direction: computed.direction, textAlign: computed.textAlign }; });
        assert.deepEqual(await read(), { direction: "rtl", textAlign: "start" }, "empty: the layout's direction, so the Arabic prompt sits on the right");
        // textAlign start resolves against the direction: left for ltr, right for rtl.
        await field.fill("Aladdin");
        assert.deepEqual(await read(), { direction: "ltr", textAlign: "start" });
        await field.fill("10 Cloverfield Lane");
        assert.equal((await read()).direction, "ltr", "a Latin query that starts with a number is not reordered");
        await field.fill("علاء الدين");
        assert.equal((await read()).direction, "rtl");
        await field.fill("");
        assert.equal((await read()).direction, "rtl", "emptied again: back to the layout's direction");
    });
});

test("in Arabic typed Latin text is drawn at the left end of the Search field and typed Arabic text at the right end (the drawn pixels, not just the computed direction)", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="search"]').click();
        const field = tv.page.locator("#browse-search");
        await field.evaluate(node => (node as HTMLInputElement).blur());
        const clip = await field.evaluate(node => { const rect = node.getBoundingClientRect(); return { x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height) }; });
        /** The left and right edges of the text drawn in the field, as distances in from the field's own edges. */
        const inkInset = async (): Promise<{ fromLeft: number; fromRight: number }> => {
            const png = (await tv.page.screenshot({ clip })).toString("base64");
            return tv.page.evaluate(async ([data, width]) => {
                const image = new Image();
                image.src = `data:image/png;base64,${data}`;
                await image.decode();
                const canvas = document.createElement("canvas");
                canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext("2d") as CanvasRenderingContext2D;
                context.drawImage(image, 0, 0);
                const pixels = context.getImageData(0, 0, image.width, image.height).data;
                let first = image.width, last = -1;
                for (let x = 0; x < image.width; x++) for (let y = 0; y < image.height; y++) if ((pixels[(y * image.width + x) * 4] ?? 0) > 60) { first = Math.min(first, x); last = Math.max(last, x); }
                return { fromLeft: first, fromRight: width - 1 - last };
            }, [png, clip.width] as const);
        };
        await field.fill("Aladdin");
        const latin = await inkInset();
        assert.ok(latin.fromLeft < 60 && latin.fromRight > clip.width / 2, `Aladdin sits at the left end: ${JSON.stringify(latin)} in a ${clip.width}px field`);
        await field.fill("علاء الدين");
        const arabic = await inkInset();
        assert.ok(arabic.fromRight < 60 && arabic.fromLeft > clip.width / 2, `Arabic sits at the right end: ${JSON.stringify(arabic)} in a ${clip.width}px field`);
    });
});

test("in Arabic Left walks Search's People rail to its last person and keeps each person on screen", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await searchFor(tv, "Movie 000");
        await tv.page.locator('[data-focus="person:edge-0"]').focus();
        for (let person = 1; person < 20; person++) {
            await tv.remote(LEFT);
            assert.equal(await tv.focused(), `person:edge-${person}`);
            const rect = await box(tv, `[data-focus="person:edge-${person}"]`);
            assert.ok(rect.left >= 0 && rect.right <= 1920, `person ${person + 1} is on screen (${rect.left}..${rect.right})`);
        }
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "person:edge-18", "Right steps back toward the first person");
    });
});

test("in Arabic Search's People rail still lands Down on the title column at or past that person (the second person on the third poster)", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        // People for the query, as browse.test.ts's Search fixtures serve them.
        await tv.page.route("**/api/v2/catalog/people**", route => route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ id: `edge-${index}`, name: `Person ${index + 1}` })) } }));
        await tv.page.locator('[data-focus="search"]').click();
        await tv.page.fill("#browse-search", "Movie 000");
        await tv.remote(65376);
        await tv.page.locator('.browse-grid [data-focus="movie:m0002"]').waitFor();
        await tv.page.locator('[data-focus="person:edge-1"]').focus();
        await tv.remote(DOWN);
        assert.equal(await tv.focused(), "movie:m0003", "the second person lands on the third poster, as in English");
    });
});

test("in Arabic on a library's Recommended page, both the top bar and content mirror right to left with swapped card keys", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
        const view = await tv.page.evaluate(() => ({
            bar: getComputedStyle(document.querySelector(".browse-nav") as Element).direction,
            content: getComputedStyle(document.querySelector(".skyline-content") as Element).direction,
            barPinned: document.querySelector(".browse-nav")?.hasAttribute("dir") ?? true,
            contentPinned: document.querySelector(".skyline-content")?.hasAttribute("dir") ?? true,
        }));
        assert.deepEqual(view, { bar: "rtl", content: "rtl", barPinned: false, contentPinned: false });
        // Left in the mirrored bar moves to the tab on its left.
        await tv.page.locator('[data-focus="home"]').focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "movies", "Left in the mirrored top bar moves to the tab on its left");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "home");

        const cards = tv.page.locator('[data-view="library:12"] .home-section .browse-card');
        const firstCard = await cards.nth(0).evaluate(node => ({ key: node.getAttribute("data-focus"), left: node.getBoundingClientRect().left, mr: getComputedStyle(node).marginRight, ml: getComputedStyle(node).marginLeft }));
        const secondCard = await cards.nth(1).evaluate(node => ({ key: node.getAttribute("data-focus"), left: node.getBoundingClientRect().left }));
        assert.ok(firstCard.left > secondCard.left, `first card (${firstCard.left}) sits right of second (${secondCard.left})`);
        assert.equal(firstCard.mr, "0px");
        assert.equal(firstCard.ml, "40px");
        await cards.nth(0).focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), secondCard.key, "Left advances toward the end of the mirrored row");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), firstCard.key, "Right returns to the first card");
    });
});

test("in Arabic For You mirrors right to left and Left/Right step across its cards", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.route("**/api/v2/recommendations/discover**", route => route.fulfill({
            json: {
                items: [{
                    type: "popular",
                    title: "For You Picks",
                    kind: "popular",
                    items: ["m0001", "m0002", "m0003"].map((id, index) => ({
                        content_id: `movie:${id}`, type: "movie", title: `Movie 000${index + 1}`, poster_url: `/art/${id}.svg`,
                    })),
                }],
            },
        }));
        await tv.page.locator('[data-focus="for_you"]').click();
        await tv.page.locator('[data-view="for_you"] .home-section .browse-card').first().waitFor();
        const layout = await tv.page.evaluate(() => ({
            contentDir: getComputedStyle(document.querySelector(".skyline-content") as Element).direction,
            contentPinned: document.querySelector(".skyline-content")?.hasAttribute("dir") ?? true,
        }));
        assert.deepEqual(layout, { contentDir: "rtl", contentPinned: false });
        const cards = tv.page.locator('[data-view="for_you"] .home-section .browse-card');
        const firstBox = await cards.nth(0).evaluate(node => ({ key: node.getAttribute("data-focus"), left: node.getBoundingClientRect().left, mr: getComputedStyle(node).marginRight, ml: getComputedStyle(node).marginLeft }));
        const secondBox = await cards.nth(1).evaluate(node => ({ key: node.getAttribute("data-focus"), left: node.getBoundingClientRect().left }));
        assert.ok(firstBox.left > secondBox.left, `first card (${firstBox.left}) sits right of second (${secondBox.left})`);
        assert.equal(firstBox.mr, "0px");
        assert.equal(firstBox.ml, "40px");
        await cards.nth(0).focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), secondBox.key);
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), firstBox.key);
    });
});

test("in Arabic Collections and collection detail mirror right to left with Left/Right grid navigation", async () => {
    await withHome({ stored: "ar" }, async tv => {
        await waitForDirection(tv, "rtl");
        await tv.page.route("**/api/v2/library/12/collections**", route => route.fulfill({
            json: {
                library_id: "12",
                collections: [
                    { id: "highlights", library_id: "12", library_ids: ["12"], group_id: "curated", title: "Library Highlights", poster_url: "", item_count: 6, poster_is_collage: false },
                    { id: "favorites", library_id: "12", library_ids: ["12"], group_id: "curated", title: "Viewer Favorites", poster_url: "", item_count: 4, poster_is_collage: false },
                ],
                groups: [{
                    id: "curated", name: "Curated", kind: "admin", sort_mode: "name_asc", sort_order: 0,
                    collections: [
                        { id: "highlights", library_id: "12", library_ids: ["12"], group_id: "curated", title: "Library Highlights", poster_url: "", item_count: 6, poster_is_collage: false },
                        { id: "favorites", library_id: "12", library_ids: ["12"], group_id: "curated", title: "Viewer Favorites", poster_url: "", item_count: 4, poster_is_collage: false },
                    ],
                }],
                ungrouped: { sort_order: 1, collections: [] },
            },
        }));
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
        await selectLibraryMode(tv, "Collections");
        await tv.page.locator('[data-focus="collection:highlights"]').waitFor();
        const collectionsDir = await tv.page.evaluate(() => ({
            dir: getComputedStyle(document.querySelector(".discovery-collection-grid") as Element).direction,
            pinned: document.querySelector(".discovery-collection-grid")?.hasAttribute("dir") ?? true,
            cardAlign: getComputedStyle(document.querySelector(".discovery-collection-grid .browse-card-title") as Element).textAlign,
        }));
        assert.deepEqual(collectionsDir, { dir: "rtl", pinned: false, cardAlign: "center" });
        const firstCol = await box(tv, '[data-focus="collection:highlights"]');
        const secondCol = await box(tv, '[data-focus="collection:favorites"]');
        assert.ok(firstCol.left > secondCol.left, `first collection (${firstCol.left}) sits right of second (${secondCol.left})`);
        await tv.page.locator('[data-focus="collection:highlights"]').focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "collection:favorites");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "collection:highlights");

        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view^="results:"] .collection-detail-grid .browse-card').first().waitFor();
        const detailAlign = await tv.page.evaluate(() => ({
            dir: getComputedStyle(document.querySelector('[data-view^="results:"]') as Element).direction,
            headingAlign: getComputedStyle(document.querySelector(".collection-detail-title") as Element).textAlign,
            cardAlign: getComputedStyle(document.querySelector(".collection-detail-grid .browse-card-title") as Element).textAlign,
        }));
        assert.deepEqual(detailAlign, { dir: "rtl", headingAlign: "center", cardAlign: "right" });
        const titles = tv.page.locator('[data-view^="results:"] .collection-detail-grid .browse-card');
        const t0 = await titles.nth(0).evaluate(node => ({ key: node.getAttribute("data-focus"), left: node.getBoundingClientRect().left }));
        const t1 = await titles.nth(1).evaluate(node => ({ key: node.getAttribute("data-focus"), left: node.getBoundingClientRect().left }));
        assert.ok(t0.left > t1.left, `first title (${t0.left}) sits right of second (${t1.left})`);
        await titles.nth(0).focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), t1.key);
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), t0.key);
    });
});

test("in Arabic Details rails use logical RTL spacing, clip paths, and Left/Right navigation across cast and related rows", async () => {
    await withArabicSeries(2, 6, async tv => {
        await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
        await tv.page.locator(".details-facts > .browse-section-title").first().waitFor();
        const metrics = await tv.page.evaluate(() => {
            const season = getComputedStyle(document.querySelector(".details-season-chips .browse-button") as Element);
            const episode = getComputedStyle(document.querySelector(".details-series-rail .browse-card") as Element);
            const episodesRow = getComputedStyle(document.querySelector(".details-series-rail .details-episodes") as Element);
            const related = getComputedStyle(document.querySelector('[data-detail-section="related"] .browse-card') as Element);
            const factsHeading = getComputedStyle(document.querySelector(".details-facts > .browse-section-title") as Element);
            return {
                season: { mr: season.marginRight, ml: season.marginLeft },
                episode: { mr: episode.marginRight, ml: episode.marginLeft },
                episodesClip: episodesRow.clipPath.replace(/px/g, ""),
                related: { mr: related.marginRight, ml: related.marginLeft },
                factsHeading: { mr: factsHeading.marginRight, ml: factsHeading.marginLeft },
            };
        });
        assert.deepEqual(metrics, {
            season: { mr: "0px", ml: "12px" },
            episode: { mr: "0px", ml: "40px" },
            episodesClip: "inset(0 100 0 0)",
            related: { mr: "0px", ml: "44px" },
            factsHeading: { mr: "12px", ml: "0px" },
        });

        const seasonPair = await tv.page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll(".details-season-chips .browse-button"));
            return {
                s0: { key: buttons[0]?.getAttribute("data-focus"), left: buttons[0]?.getBoundingClientRect().left ?? 0 },
                s1: { key: buttons[1]?.getAttribute("data-focus"), left: buttons[1]?.getBoundingClientRect().left ?? 0 },
            };
        });
        assert.ok(seasonPair.s0.left > seasonPair.s1.left, `season 1 (${seasonPair.s0.left}) sits right of season 2 (${seasonPair.s1.left})`);
        await tv.page.locator(".details-season-chips .browse-button").nth(0).focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), seasonPair.s1.key);
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), seasonPair.s0.key);

        const relPair = await tv.page.evaluate(() => {
            const cards = Array.from(document.querySelectorAll('[data-detail-section="related"] .browse-card'));
            return {
                r0: { key: cards[0]?.getAttribute("data-focus"), left: cards[0]?.getBoundingClientRect().left ?? 0 },
                r1: { key: cards[1]?.getAttribute("data-focus"), left: cards[1]?.getBoundingClientRect().left ?? 0 },
            };
        });
        assert.ok(relPair.r0.left > relPair.r1.left, `related 0 (${relPair.r0.left}) sits right of related 1 (${relPair.r1.left})`);
        await tv.page.locator('[data-detail-section="related"] .browse-card').nth(0).focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), relPair.r1.key);
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), relPair.r0.key);

        await tv.remote(BACK);
        const movieCard = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first();
        await movieCard.waitFor();
        await movieCard.click();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.page.locator('[data-view="item:movie:m0001"] [data-detail-section="related"] .browse-card').first().waitFor();
        await tv.page.locator('[data-view="item:movie:m0001"] .details-people .details-person').nth(1).waitFor();
        await tv.page.locator('[data-view="item:movie:m0001"] .details-facts-table').first().waitFor();
        const movieMetrics = await tv.page.evaluate(() => {
            const person = getComputedStyle(document.querySelector(".details-people .details-person") as Element);
            const factsTable = getComputedStyle(document.querySelector(".details-facts-table") as Element);
            const castTitle = getComputedStyle(document.querySelector(".details-people .browse-card-title") as Element);
            const people = Array.from(document.querySelectorAll(".details-people .details-person"));
            return {
                person: { mr: person.marginRight, ml: person.marginLeft },
                factsTable: { mr: factsTable.marginRight, ml: factsTable.marginLeft },
                castTitleAlign: castTitle.textAlign,
                p0: { key: people[0]?.getAttribute("data-focus"), left: people[0]?.getBoundingClientRect().left ?? 0 },
                p1: { key: people[1]?.getAttribute("data-focus"), left: people[1]?.getBoundingClientRect().left ?? 0 },
            };
        });
        assert.deepEqual(
            { person: movieMetrics.person, factsTable: movieMetrics.factsTable, castTitleAlign: movieMetrics.castTitleAlign },
            { person: { mr: "0px", ml: "60px" }, factsTable: { mr: "12px", ml: "0px" }, castTitleAlign: "center" },
        );
        assert.ok(movieMetrics.p0.left > movieMetrics.p1.left, `cast 0 (${movieMetrics.p0.left}) sits right of cast 1 (${movieMetrics.p1.left})`);
        await tv.page.locator(".details-people .details-person").nth(0).focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), movieMetrics.p1.key);
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), movieMetrics.p0.key);
    });
});

for (const cardNumber of [4, 10] as const) {
    test(`a late Arabic answer after a launch kept in English leaves Home's focused card (number ${cardNumber}) on screen`, async () => {
        await withHome({ cached: "en", stored: "ar", holdLanguage: true }, async (tv, releaseLanguage) => {
            assert.equal(await direction(tv), null, "launched left to right from the kept English");
            const cards = tv.page.locator('[data-section="recent/12"] [data-focus]');
            await cards.first().focus();
            for (let step = 1; step < cardNumber; step++) await tv.remote(RIGHT);
            const before = await tv.focused();
            assert.equal(before, await cards.nth(cardNumber - 1).getAttribute("data-focus"));
            releaseLanguage();
            await waitForDirection(tv, "rtl");
            await tv.eventually(async () => await tv.focused() === before, "focus stays on the viewer's card");
            const card = await onScreen(tv);
            assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `${before} at ${card?.left}..${card?.right}`);
        });
    });
}

test("reusing a cached Details episode row after a live LTR-to-RTL switch clears stale inline padding and sets RTL inset and scroll", async () => {
    const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
    const details = new FakeDetails();
    tv.fake.catalog = details;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    let held: { release(): void }[] = [];
    try {
        const listed = details.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
        const first = details.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({ json: { items: [listed.items[0]], next_cursor: null } }));
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", route => route.fulfill({ json: { items: Array.from({ length: 12 }, (_, index) => ({ ...first.items[0], content_id: `episode:rail:1:${index}`, season_number: 1, episode_number: index + 1 })), next_cursor: null } }));
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.seedAppLanguage("en"));
        held = Array.from({ length: 4 }, () => tv.fake.hold(`/settings/values/effective?keys=${APP_LANGUAGE_KEY}`, true));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        assert.equal(await direction(tv), null, "launched left to right from kept English");

        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:rail:1:0"]').waitFor();
        await tv.page.locator('[data-focus="episode:rail:1:0"]').focus();
        for (let step = 1; step < 12; step++) await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "episode:rail:1:11");
        const ltr = await tv.page.locator(".details-episodes").evaluate(node => {
            (window as unknown as { __cachedEpisodeRow?: Element }).__cachedEpisodeRow = node;
            const style = getComputedStyle(node);
            return {
                dir: style.direction,
                pl: style.paddingLeft,
                inlinePr: node.style.paddingRight,
                sl: node.scrollLeft,
            };
        });
        assert.equal(ltr.dir, "ltr");
        assert.notEqual(ltr.inlinePr, "", "LTR prepareEpisodeRow set inline paddingRight");
        assert.ok(ltr.sl > 0, `LTR episode rail scrolled positively (${ltr.sl})`);

        held.forEach(hold => hold.release());
        held = [];
        await waitForDirection(tv, "rtl");
        await tv.eventually(async () => await tv.focused() === "episode:rail:1:11", "focus stays on episode 12");
        const rtl = await tv.page.locator(".details-episodes").evaluate(node => {
            const style = getComputedStyle(node);
            return {
                reused: node === (window as unknown as { __cachedEpisodeRow?: Element }).__cachedEpisodeRow,
                dir: style.direction,
                pr: style.paddingRight,
                inlinePr: node.style.paddingRight,
                sl: node.scrollLeft,
            };
        });
        assert.equal(rtl.reused, true, "reused the cached episode row across direction switch");
        assert.equal(rtl.dir, "rtl");
        assert.equal(rtl.inlinePr, "", "stale LTR inline paddingRight cleared");
        assert.equal(rtl.pr, ltr.pl, `RTL leading paddingRight (${rtl.pr}) matches LTR leading paddingLeft (${ltr.pl})`);
        assert.ok(rtl.sl < 0, `RTL episode rail scrolled negatively (${rtl.sl})`);
        const card = await onScreen(tv);
        assert.ok(card !== undefined && card.left >= 0 && card.right <= 1920, `episode 12 on screen at ${card?.left}..${card?.right}`);
    } finally {
        held.forEach(hold => hold.release());
        await tv.page.context().close();
    }
});
