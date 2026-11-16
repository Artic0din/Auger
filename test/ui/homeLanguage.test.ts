// Home and the top navigation in the language the profile chose (silo-apple tvOS/Navigation/TVTopMenuBar.swift,
// Screens/Home/HomeView.swift): the bar, its menus, the profile menu, Home's row titles and its empty and loading
// states. German is the shown language; English is what an untranslated or unkeyed text keeps.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

// The expected German text is read here, in the test process; the page loads the same file the way the app does.
registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const BACK = 10009;
const de = (key: Parameters<typeof translate>[0], args?: Parameters<typeof translate>[1]): string => translate(key, args, "de");

/** Home with one keyed row, one keyed row with an argument, and one the server wrote without a key. */
class KeyedHome extends FakeHome {
    constructor() {
        super();
        const rows = this.households.get("p-owner")?.sections;
        assert.ok(rows);
        for (const row of rows) {
            if (row.id === "resume/opaque") row.titleKey = "home.section.continueWatching";
            if (row.id === "recent/12") { row.titleKey = "home.section.recentlyAddedIn"; row.titleArgs = { library: "Movies" }; }
        }
    }
}

async function withHome(body: (tv: Tv, settings: FakeSettings, catalog: KeyedHome, releaseLanguage: () => void, holds: readonly { release(): void }[]) => Promise<void>, options: { readonly cached?: string; readonly stored?: string; readonly empty?: boolean; readonly holdLanguage?: boolean } = {}): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new KeyedHome();
    if (options.empty === true) {
        const home = catalog.households.get("p-owner");
        assert.ok(home);
        home.sections = [];
    }
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
        // The profile's language answers late: Home draws in English first.
        // A hold answers one read, and Browse makes several effective reads at launch; hold the first few.
        if (options.holdLanguage === true) held = Array.from({ length: 8 }, () => tv.fake.hold("/settings/values/effective", true));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, settings, catalog, () => held.forEach(hold => hold.release()), held);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

const rootTitles = (tv: Tv): Promise<string[]> => tv.page.locator(".skyline-roots [data-focus]").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""));
const sectionTitles = (tv: Tv): Promise<string[]> => tv.page.locator('[data-view="home"] .browse-section-title').allInnerTexts();

test("the top bar and Home's row titles read in German, and a row the server wrote without a key keeps its text", async () => {
    await withHome(async tv => {
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.forYou")), "German top bar");
        assert.deepEqual(await rootTitles(tv), ["topBar.home", "topBar.movies", "topBar.series", "topBar.forYou", "topBar.calendar"].map(key => de(key as Parameters<typeof de>[0])));
        assert.equal(await tv.page.locator('[data-focus="search"]').getAttribute("aria-label"), de("topBar.search"));
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-label"), de("topBar.profileButton"));
        assert.equal(await tv.page.locator('[data-focus="for_you"]').getAttribute("aria-description"), de("topBar.hint.forYou"));
        await tv.eventually(async () => (await sectionTitles(tv)).includes(de("home.section.continueWatching")), "German row titles");
        const titles = await sectionTitles(tv);
        assert.ok(titles.includes(de("home.section.continueWatching")), titles.join(" | "));
        assert.ok(titles.includes(de("home.section.recentlyAddedIn", { library: "Movies" })), titles.join(" | "));
        assert.ok(titles.includes("Server Picks"), "an unkeyed title is the server's text");
        assert.ok(!titles.includes("Continue Watching") && !titles.includes("Recently Added in Movies"), "no English left on keyed rows");
        const explore = tv.page.locator('[data-section="resume/opaque"] .skyline-explore');
        assert.equal(await explore.locator(".skyline-explore-label").innerText(), de("rows.exploreAll"));
        assert.equal(await explore.getAttribute("aria-label"), `${de("rows.exploreAll")}, ${de("home.section.continueWatching")}`);
    }, { stored: "de" });
});

test("in English the rows show the server's text as sent, even for a row that carries a key", async () => {
    await withHome(async tv => {
        assert.deepEqual(await rootTitles(tv), ["Home", "Movies", "Series", "For You", "Calendar"]);
        const titles = await sectionTitles(tv);
        assert.ok(titles.includes("Continue Watching") && titles.includes("Recently Added in Movies") && titles.includes("Server Picks"), titles.join(" | "));
        assert.equal(await tv.page.locator('[data-focus="profiles"]').getAttribute("aria-label"), "Profile");
    });
});

test("the For You, library and profile menus read in German", async () => {
    await withHome(async tv => {
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.forYou")), "German top bar");
        const panel = tv.page.locator(".skyline-selector:not(.skyline-flyout)");

        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.remote(40);
        assert.equal(await panel.getAttribute("aria-label"), de("menu.forYou.spoken"));
        assert.equal(await panel.locator(".skyline-menu-header").innerText(), de("menu.forYou.header"));
        assert.deepEqual(await panel.locator(".skyline-menu-label").allInnerTexts(), [de("menu.watchlist"), de("menu.favorites"), de("forYou.recommendations")]);
        await tv.remote(BACK);

        // Two Movies libraries are listed by type; Shows has one, so its menu lists the library's sections.
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.remote(40);
        assert.equal(await panel.getAttribute("aria-label"), de("menu.libraries.moviesSpoken"));
        assert.equal(await panel.locator(".skyline-menu-header").innerText(), de("menu.libraries.movies"));
        await tv.remote(BACK);

        await tv.page.locator('[data-focus="series"]').focus();
        await tv.remote(40);
        assert.equal(await panel.getAttribute("aria-label"), de("menu.cascade.sectionsSpoken", { library: "Shows" }));
        assert.deepEqual(await panel.locator(".skyline-menu-label").allInnerTexts(), [de("library.recommended"), de("library.collections"), de("library.browse")]);
        await tv.remote(BACK);

        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(40);
        assert.equal(await panel.getAttribute("aria-label"), de("menu.profileMenu.label"));
        const labels = await panel.locator(".skyline-menu-label").allInnerTexts();
        for (const key of ["menu.history", "menu.settings", "menu.switchProfile", "menu.signOut"] as const) assert.ok(labels.includes(de(key)), `${de(key)} in ${labels.join(" | ")}`);
        assert.ok(!labels.some(label => ["History", "Settings", "Switch Profile", "Sign Out"].includes(label)), `English left in ${labels.join(" | ")}`);

        await panel.locator('[data-focus="signout"]').click();
        const dialog = tv.page.getByRole("alertdialog");
        await dialog.waitFor();
        assert.equal(await dialog.getAttribute("aria-label"), de("menu.signOut"));
        assert.deepEqual(await dialog.getByRole("button").allInnerTexts(), [de("common.cancel"), de("shell.signOut.confirm")]);
        const title = await dialog.locator(".skyline-confirm-title").innerText();
        assert.match(title, /abmelden\?$/);
        assert.doesNotMatch(await dialog.innerText(), /Sign out|apple tv/i);
    }, { stored: "de" });
});

test("an empty Home and a Home still loading read in German", async () => {
    await withHome(async tv => {
        const empty = tv.page.locator(".home-empty");
        await empty.waitFor();
        await tv.eventually(async () => await empty.locator(".search-state-title").innerText() === de("home.empty"), "German empty state");
        assert.equal(await empty.locator(".search-state-description").innerText(), de("home.emptyBody"));
    }, { stored: "de", empty: true });

    const tv = await openTv(browser, { app: "browse" });
    try {
        tv.fake.catalog = new KeyedHome();
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        settings.profile().set(APP_LANGUAGE_KEY, "de");
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        const held = tv.fake.hold("/home/sections", true);
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home:loading"]').waitFor();
        await tv.eventually(async () => await tv.page.locator(`[aria-label="${de("home.loading")}"]`).count() === 1, "German loading label");
        held.release();
    } finally { await tv.page.context().close(); }
});

test("picking German in Settings relabels the top bar and Home when Settings closes", async () => {
    await withHome(async tv => {
        assert.deepEqual(await rootTitles(tv), ["Home", "Movies", "Series", "For You", "Calendar"]);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="app-language"]').waitFor();
        await tv.page.locator('[data-focus="app-language"]').click();
        await tv.page.getByRole("radio", { name: "Deutsch", exact: true }).click();
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() === de("settings.title"), "Settings in German");
        for (let presses = 0; presses < 4 && !await tv.page.locator('[data-view="home"]').isVisible(); presses++) await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.forYou")), "German top bar after Settings");
        assert.deepEqual(await rootTitles(tv), ["topBar.home", "topBar.movies", "topBar.series", "topBar.forYou", "topBar.calendar"].map(key => de(key as Parameters<typeof de>[0])));
        await tv.eventually(async () => (await sectionTitles(tv)).includes(de("home.section.continueWatching")), "German row titles after Settings");
    });
});

test("a language that arrives while a top-bar button has focus keeps focus on that button", async () => {
    await withHome(async (tv, _settings, _catalog, releaseLanguage) => {
        assert.ok((await rootTitles(tv)).includes("Calendar"), "English until the language answers");
        await tv.page.locator('[data-focus="calendar"]').focus();
        assert.equal(await tv.focused(), "calendar");
        releaseLanguage();
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.calendar")), "German top bar");
        assert.equal(await tv.focused(), "calendar", "the viewer's button keeps focus when the bar is rebuilt");
    }, { stored: "de", holdLanguage: true });
});

test("a language that arrives during playback shows on the top bar when browse resumes", async () => {
    await withHome(async (tv, _settings, _catalog, releaseLanguage) => {
        await tv.page.locator('[data-section="recent/12"] .browse-card:not(.skyline-explore)').first().click();
        await tv.page.locator('[data-focus="play"][aria-disabled="false"]').click();
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.plays.length === 1), "playback entered");
        releaseLanguage();
        await tv.jump(500);
        await tv.page.evaluate(() => window.browseHarness.resume());
        // Resuming lands on the title's page; the bar is on Home.
        await tv.page.locator('[data-focus="play"]').waitFor();
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor({ state: "visible" });
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.forYou")), "German top bar after playback");
        const titles = await rootTitles(tv);
        for (const key of ["topBar.home", "topBar.forYou", "topBar.calendar"] as const) assert.ok(titles.includes(de(key)), `${de(key)} in ${titles.join(" | ")}`);
        assert.ok(!titles.includes("Calendar") && !titles.includes("For You"), "no English left on the bar");
    }, { stored: "de", holdLanguage: true });
});

test("a Select held on a top-bar button while the language arrives still runs on release, and the bar relabels after it", async () => {
    await withHome(async (tv, _settings, _catalog, _releaseLanguage, holds) => {
        // Release every held read but the language's, so the bar is complete and only the language is late.
        const reads = tv.fake.paths().filter(path => path.startsWith("GET /settings/values/effective"));
        const language = reads.findIndex(path => path.includes(APP_LANGUAGE_KEY));
        assert.ok(language >= 0 && language < holds.length, `language read among ${reads.length} effective reads`);
        holds.forEach((hold, index) => { if (index !== language) hold.release(); });
        await tv.eventually(async () => (await rootTitles(tv)).includes("Movies"), "library tabs without the language");
        await tv.page.locator('[data-focus="calendar"]').focus();
        await tv.page.keyboard.down("Enter");
        holds[language]?.release();
        // The answer waits for the release: nothing under the finger is replaced.
        await tv.jump(500);
        assert.ok((await rootTitles(tv)).includes("Calendar"), "the bar is still English while Select is held");
        assert.equal(await tv.page.locator('[data-focus="calendar"][data-pressed]').count(), 1, "the held button stays pressed");
        await tv.page.keyboard.up("Enter");
        await tv.page.locator('.browse[data-view="calendar"]').waitFor({ state: "visible" });
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.calendar")), "German top bar after the release");
    }, { stored: "de", holdLanguage: true });
});

test("a language that arrives while a card menu is open leaves the menu working and relabels when it closes", async () => {
    await withHome(async (tv, _settings, _catalog, releaseLanguage) => {
        const card = tv.page.locator('[data-section="resume/opaque"] [data-focus="movie:m0001"]');
        await card.focus();
        await tv.down(13);
        await tv.jump(650);
        await tv.up(13);
        const menu = tv.page.getByRole("menu");
        await menu.waitFor();
        const first = await tv.focused();
        releaseLanguage();
        await tv.jump(500);
        assert.ok((await rootTitles(tv)).includes("Calendar"), "the bar waits while the menu is open");
        await menu.waitFor();
        await tv.page.keyboard.press("ArrowDown");
        assert.notEqual(await tv.focused(), first, "the menu still takes the remote");
        await tv.remote(10009);
        await menu.waitFor({ state: "detached" });
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.calendar")), "German top bar after the menu closes");
    }, { stored: "de", holdLanguage: true });
});

test("a language kept from the last answer shows on the first draw, before the server answers", async () => {
    await withHome(async tv => {
        // The language read is still held: only the kept choice can have made this German, once its file has landed.
        // The libraries wait on the same held reads, so the bar has only its fixed tabs.
        await tv.eventually(async () => (await rootTitles(tv)).includes(de("topBar.forYou")), "German from the kept choice");
        assert.deepEqual(await rootTitles(tv), ["topBar.home", "topBar.forYou", "topBar.calendar"].map(key => de(key as Parameters<typeof de>[0])));
        const titles = await sectionTitles(tv);
        assert.ok(titles.includes(de("home.section.continueWatching")) && titles.includes(de("home.section.recentlyAddedIn", { library: "Movies" })), titles.join(" | "));
    }, { stored: "de", cached: "de", holdLanguage: true });
});

test("a late answer that differs from the kept language redraws the screen once and keeps focus on the same card", async () => {
    await withHome(async (tv, _settings, _catalog, releaseLanguage) => {
        assert.ok((await rootTitles(tv)).includes("Calendar"), "the kept choice was Match Device, so the first draw is English");
        const card = tv.page.locator('[data-section="recent/12"] .browse-card:not(.skyline-explore)').first();
        const key = await card.getAttribute("data-focus");
        assert.ok(key);
        await card.focus();
        assert.equal(await tv.focused(), key);
        releaseLanguage();
        await tv.eventually(async () => (await sectionTitles(tv)).includes(de("home.section.recentlyAddedIn", { library: "Movies" })), "German rows");
        assert.deepEqual(await rootTitles(tv), ["topBar.home", "topBar.movies", "topBar.series", "topBar.forYou", "topBar.calendar"].map(key => de(key as Parameters<typeof de>[0])));
        assert.equal(await tv.focused(), key, "focus is restored by section and item id");
    }, { stored: "de", cached: "", holdLanguage: true });
});
