// Card menus, For You and the library Browse page in the language the profile chose (silo-apple Components/MediaCard.swift,
// Screens/Home/HomeView.swift, Screens/Recommendations/RecommendationsView.swift and tvOS/Screens/Libraries/*). German is
// the shown language. Apple builds the card menu's Play, Mark as and Add to rows as plain strings, so they stay English.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { afterPaint, homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { selectLibraryMode } from "./support/library.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const de = (key: Parameters<typeof translate>[0], args?: Parameters<typeof translate>[1]): string => translate(key, args, "de");

async function signIn(tv: Tv, catalog: FakeCatalog): Promise<void> {
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "de");
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount(false));
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    await homeDetailsRead(tv);
    await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(de("topBar.forYou")), "German top bar");
    await afterPaint(tv);
}

async function inGerman(body: (tv: Tv) => Promise<void>, catalog: FakeCatalog = new FakeCatalog()): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signIn(tv, catalog);
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("the library Browse page, its sort panel and its filter panel read in German", async () => {
    await inGerman(async tv => {
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('[data-view="library:12"]').waitFor();
        await selectLibraryMode(tv, "Browse");
        await tv.page.locator(".catalog-grid .browse-card").first().waitFor();
        const sort = tv.page.locator('.browse-controls [data-focus="sort"]');
        assert.equal(await sort.textContent(), `${de("library.sortPill", { name: de("catalog.sort.title") })}${de("library.direction.az")}`);
        assert.equal(await tv.page.locator('.browse-controls [data-focus="filter"]').textContent(), de("library.filterPill"));
        assert.equal(await tv.page.locator('[data-focus="letter:All"]').textContent(), de("catalog.letters.all"));
        assert.equal(await tv.page.locator('[data-focus="letter:All"]').getAttribute("aria-label"), de("catalog.letters.all"));
        assert.equal(await tv.page.locator('[data-focus="letter:#"]').getAttribute("aria-label"), de("library.startsWithSymbol"));
        assert.equal(await tv.page.locator('[data-focus="letter:B"]').getAttribute("aria-label"), de("library.startsWithLetter", { letter: "B" }));

        await sort.click();
        const sortPanel = tv.page.locator(".browse-sort-panel");
        await sortPanel.waitFor();
        assert.equal(await sortPanel.locator(".browse-panel-eyebrow").innerText(), de("library.sortBy").toLocaleUpperCase("de"));
        const names = await sortPanel.locator('[data-focus^="sort:"]').evaluateAll(rows => rows.map(row => row.querySelector(".browse-panel-text")?.textContent ?? row.textContent ?? ""));
        assert.deepEqual(names.map(name => name.trim()), ["catalog.sort.title", "catalog.sort.added", "catalog.sort.released", "catalog.sort.year", "catalog.sort.imdbRating", "catalog.sort.duration", "catalog.sort.resolution"].map(key => de(key as Parameters<typeof de>[0])));
        await tv.remote(10009);

        await tv.page.locator('.browse-controls [data-focus="filter"]').click();
        const panel = tv.page.locator(".browse-filter-panel");
        await panel.waitFor();
        assert.equal(await panel.locator(".browse-panel-title").innerText(), de("filters.title"));
        assert.equal(await panel.locator(".browse-panel-eyebrow").innerText(), de("filters.eyebrowList").toLocaleUpperCase("de"));
        assert.deepEqual(await panel.locator(".browse-panel-section").allInnerTexts(), [de("filters.match").toLocaleUpperCase("de"), de("filters.options").toLocaleUpperCase("de")]);
        const text = await panel.innerText();
        for (const key of ["filters.matchAll", "filters.matchAny", "filters.preserve", "filters.reset", "filters.done", "filters.any"] as const) assert.ok(text.includes(de(key)), `${de(key)} in ${text}`);
        assert.ok(text.includes(de("filters.facet.watchStatus")), "facet titles are German");
        assert.ok(!/All selected filters|Preserve sort|Reset filters/.test(text), "no English left in the panel");
        await panel.locator('[data-focus="facet:watchStatus"]').click();
        assert.equal(await panel.locator(".browse-panel-title").innerText(), de("filters.facet.watchStatus"));
        assert.equal(await panel.locator(".browse-panel-eyebrow").innerText(), de("filters.eyebrowValues").toLocaleUpperCase("de"));
        const values = await panel.locator('[data-focus^="value:"]').allInnerTexts();
        assert.deepEqual(values.map(value => value.trim()), ["unwatched", "inProgress", "watched", "favorited", "watchlist"].map(value => de(`filters.value.${value}` as Parameters<typeof de>[0])));
    });
});

test("For You with nothing to show reads in German, and so does its loading page", async () => {
    await inGerman(async tv => {
        let release: (() => void) | undefined;
        const held = new Promise<void>(resolve => { release = resolve; });
        await tv.page.route("**/api/v2/recommendations/discover*", async route => {
            await held;
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
        });
        await tv.page.locator('[data-focus="for_you"]').click();
        const loading = tv.page.locator('[data-view="for_you"]');
        await loading.waitFor({ state: "attached" });
        assert.equal(await tv.page.locator('[aria-label="' + de("home.forYou.loading") + '"]').count(), 1, "the loading page is named in German");
        release?.();
        const empty = tv.page.locator(".for-you-empty");
        await empty.waitFor();
        assert.equal(await empty.locator(".search-state-title").innerText(), de("forYou.empty"));
        assert.equal(await empty.locator(".search-state-description").innerText(), de("forYou.emptyBody"));
    });
});

test("a Continue Watching card's menu names Remove in German, keeps Apple's plain-string rows, and its alert reads in German", async () => {
    const catalog = new FakeDetails();
    catalog.cardUserState = true;
    await inGerman(async tv => {
        const origin = tv.page.locator('[data-section="continue_watching"] [data-focus="movie:m0001"]');
        await origin.focus();
        await tv.down(13);
        await tv.jump(650);
        await tv.up(13);
        const menu = tv.page.getByRole("menu");
        await menu.waitFor();
        assert.deepEqual(await menu.locator(".card-menu-label").allInnerTexts(), ["Resume", "Mark as Watched", "Add to Favorites", "Add to Watchlist", de("cardMenu.removeContinueWatching")]);
        catalog.mutationFailure = problem(400, "validation_failed", "Not applied");
        await menu.getByRole("menuitem", { name: "Add to Favorites", exact: true }).click();
        const alert = tv.page.getByRole("alertdialog", { name: de("home.updateFailed.title") });
        await alert.waitFor({ timeout: 35000 });
        assert.equal(await alert.locator(".signin-alert-text").innerText(), de("home.updateFailed.message"));
        assert.deepEqual(await alert.getByRole("button").allInnerTexts(), [de("home.updateFailed.ok")]);
    }, catalog);
});

test("Collections and its empty state read in German, with the count in capitals", async () => {
    const catalog = new FakeCatalog();
    await inGerman(async tv => {
        await tv.page.locator('[data-focus="movies"]').click();
        await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
        await selectLibraryMode(tv, "Collections");
        const card = tv.page.locator('[data-focus="collection:highlights"]');
        await card.waitFor();
        const count = Number.parseInt(await card.locator(".browse-card-subtitle").innerText(), 10);
        assert.ok(count > 0);
        assert.equal(await card.locator(".browse-card-subtitle").innerText(), de("collections.itemCount", { count, count_text: String(count) }).toLocaleUpperCase("de"));
        assert.equal(await card.getAttribute("aria-label"), de("library.collectionCard.spokenCount", { count, count_text: String(count), name: "Library Highlights" }));
        catalog.failNext("/library/12/collections", { status: 200, body: { library_id: "12", collections: [], groups: [], ungrouped: { sort_order: 1, collections: [] } } });
        await selectLibraryMode(tv, "Recommended");
        await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
        await selectLibraryMode(tv, "Collections");
        await tv.page.locator(".library-empty").waitFor();
        assert.equal(await tv.page.locator(".library-empty-title").innerText(), de("collections.empty"));
        assert.equal(await tv.page.locator(".library-empty-body").innerText(), de("collections.emptyBody"));
    }, catalog);
});
