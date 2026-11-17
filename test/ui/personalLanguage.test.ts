// The Watchlist, Favorites and History pages in German and Arabic (silo-apple Screens/Personal/WatchlistView.swift,
// FavoritesView.swift, HistoryView.swift and HistoryViewModel.swift at 0e17c3e3): the text reads from the catalog, the pages
// follow the page's direction (in Arabic the grid reads from the right and Left steps toward the next card), and English is
// unchanged. The error page and its buttons are the shared error row's text and stay English here.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY, type SettingsKey } from "../../src/contracts/v2/settings.ts";
import { formattingLocale } from "../../src/i18n/language.ts";
import { integerText } from "../../src/i18n/numbers.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { PersonalCatalog } from "../native/support/personalCatalog.ts";
import { afterPaint, homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37;
const RIGHT = 39;
const DOWN = 40;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);

async function inLanguage(language: string | null, body: (tv: Tv, catalog: PersonalCatalog) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new PersonalCatalog();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
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
        await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
        await homeDetailsRead(tv);
        if (language !== null) await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(text("topBar.forYou", language)), `${language} top bar`);
        await afterPaint(tv);
        await body(tv, catalog);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

/** No series in the lists, so Favorites' TV Shows filter shows its empty section. */
function excludeSeries(catalog: PersonalCatalog): void {
    for (const title of catalog.titles.values()) if (title.type === "series") catalog.excluded.add(title.id);
}

async function openList(tv: Tv, source: "watchlist" | "favorites" | "history", ready = ".browse-card"): Promise<void> {
    if (source === "history") await tv.page.locator('[data-focus="profiles"]').click();
    else { await tv.page.locator('[data-focus="for_you"]').focus(); await tv.remote(DOWN); }
    await tv.page.locator(`[data-focus="${source}"]`).click({ timeout: 2000 });
    await tv.page.locator(`[data-view="personal:${source}"] ${ready}`).first().waitFor();
}

test("the Watchlist and Favorites pages read in German: titles, filters and the section's empty state", async () => {
    await inLanguage("de", async (tv, catalog) => {
        excludeSeries(catalog);
        await openList(tv, "watchlist");
        assert.equal(await tv.page.locator('[data-view="personal:watchlist"] h1').innerText(), "Merkliste");
        assert.equal(await tv.page.locator('[data-view="personal:watchlist"] h1').innerText(), text("personal.watchlist.title", "de"));
        await tv.remote(10009);
        await openList(tv, "favorites");
        assert.equal(await tv.page.locator('[data-view="personal:favorites"] h1').innerText(), text("personal.favorites.title", "de"));
        assert.equal(await tv.page.locator('[data-focus="filter:movie"]').innerText(), "Filme");
        assert.equal(await tv.page.locator('[data-focus="filter:series"]').innerText(), "Serien");
        await tv.page.locator('[data-focus="filter:series"]').click();
        await tv.page.locator(".personal-section-empty").waitFor();
        assert.equal(await tv.page.locator(".personal-section-title").innerText(), "Keine Serien in den Favoriten");
        assert.equal(await tv.page.locator(".personal-section-subtitle").innerText(), text("personal.favorites.emptyAnyBody", "de"));
    });
});

test("the empty Watchlist, Favorites and History read in German", async () => {
    await inLanguage("de", async (tv, catalog) => {
        for (const id of catalog.titles.keys()) catalog.excluded.add(id);
        await openList(tv, "watchlist", ".personal-empty");
        assert.equal(await tv.page.locator(".personal-empty-title").innerText(), "Merkliste ist leer");
        assert.equal(await tv.page.locator(".personal-empty-subtitle").innerText(), text("personal.watchlist.emptyTapHint", "de"));
        await tv.remote(10009);
        await openList(tv, "favorites", ".personal-empty");
        assert.equal(await tv.page.locator(".personal-empty-title").innerText(), "Keine Favoriten");
        assert.equal(await tv.page.locator(".personal-empty-subtitle").innerText(), text("personal.favorites.emptyTapHint", "de"));
        await tv.remote(10009);
        await openList(tv, "history", ".personal-empty");
        assert.equal(await tv.page.locator(".personal-empty-title").innerText(), "Kein Wiedergabeverlauf");
        assert.equal(await tv.page.locator(".personal-empty-subtitle").innerText(), text("personal.history.emptyBody", "de"));
        assert.equal(await tv.page.locator('[data-view="personal:history"] h1').innerText(), "Verlauf");
    });
});

test("the loading state and the unavailable page read in German", async () => {
    await inLanguage("de", async (tv, catalog) => {
        const held = tv.fake.hold("/watchlist", true);
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.remote(DOWN);
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.page.locator(".personal-loading").waitFor();
        assert.equal(await tv.page.locator(".personal-loading").getAttribute("aria-label"), "Merkliste wird geladen");
        held.release();
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').first().waitFor();
        await tv.remote(10009);
        catalog.unavailable = true;
        await openList(tv, "favorites", ".personal-status");
        assert.equal(await tv.page.locator(".personal-status").innerText(), "Favorites is unavailable.", "the unavailable sentence has no Apple key");
    });
});

test("History's count reads in German and in Arabic with that language's plural and digits", async () => {
    await inLanguage("de", async tv => {
        await openList(tv, "history");
        const shown = Number((await tv.page.locator(".personal-count").innerText()).split(" ")[0]);
        assert.ok(shown > 1);
        assert.equal(await tv.page.locator(".personal-count").innerText(), `${shown} Elemente`);
        assert.equal(await tv.page.locator(".personal-count").innerText(), text("collections.itemCount", "de", { count: shown, count_text: integerText(shown, formattingLocale("de", "en-AU")) }));
    });
    await inLanguage("ar", async tv => {
        await openList(tv, "history");
        await tv.eventually(async () => (await tv.page.locator(".personal-count").innerText()) !== "", "the count");
        const count = await tv.page.locator(".personal-count").innerText();
        assert.match(count, /[٠-٩]/, `Arabic-Indic digits: ${count}`);
        const total = Number.parseInt(count.replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/\D/g, ""), 10);
        assert.equal(count, text("collections.itemCount", "ar", { count: total, count_text: integerText(total, formattingLocale("ar", "en-AU")) }));
    });
});

test("in Arabic the three pages follow the mirrored page: the grid reads from the right and Left steps to the next card", async () => {
    await inLanguage("ar", async tv => {
        for (const source of ["watchlist", "favorites", "history"] as const) {
            if (source !== "watchlist") await tv.remote(10009);
            await openList(tv, source);
            const view = tv.page.locator(`[data-view="personal:${source}"]`);
            assert.equal(await view.getAttribute("dir"), null, `${source} follows the page's direction`);
            assert.equal(await view.locator("h1").innerText(), text(`personal.${source}.title`, "ar"));
            const cards = view.locator(".browse-card");
            const lefts = await cards.evaluateAll(nodes => nodes.slice(0, 3).map(node => node.getBoundingClientRect().left));
            assert.ok(lefts[0]! > lefts[1]! && lefts[1]! > lefts[2]!, `${source}: the first card is rightmost: ${JSON.stringify(lefts)}`);
            // SwiftUI aligns a card's text by the layout, so Latin titles hug the right edge of an Arabic page's card: the line ends where the card does.
            const align = await cards.evaluateAll(nodes => nodes.slice(0, 3).flatMap(node => [...node.querySelectorAll<HTMLElement>(".browse-card-title, .browse-card-subtitle")]).filter(label => (label.textContent ?? "") !== "").map(label => {
                const range = document.createRange();
                range.selectNodeContents(label);
                return { text: label.textContent, gap: label.getBoundingClientRect().right - range.getBoundingClientRect().right };
            }));
            assert.ok(align.length > 0 && align.every(line => line.gap < 3), `${source}: card text is right-aligned: ${JSON.stringify(align)}`);
            const first = await cards.first().getAttribute("data-focus");
            const second = await cards.nth(1).getAttribute("data-focus");
            await cards.first().focus();
            await tv.remote(LEFT);
            assert.equal(await tv.focused(), second, `${source}: Left goes to the card drawn on the left`);
            await tv.remote(RIGHT);
            assert.equal(await tv.focused(), first, `${source}: Right returns`);
        }
    });
});

test("Watchlist, Favorites and History keep their English text and left-to-right grid in English", async () => {
    await inLanguage(null, async (tv, catalog) => {
        excludeSeries(catalog);
        await openList(tv, "favorites");
        assert.equal(await tv.page.locator('[data-view="personal:favorites"] h1').innerText(), "Favorites");
        assert.equal(await tv.page.locator('[data-focus="filter:movie"]').innerText(), "Movies");
        assert.equal(await tv.page.locator('[data-focus="filter:series"]').innerText(), "TV Shows");
        await tv.page.locator('[data-focus="filter:series"]').click();
        assert.equal(await tv.page.locator(".personal-section-title").innerText(), "No favorite tv shows");
        await tv.remote(10009);
        await openList(tv, "history");
        assert.match(await tv.page.locator(".personal-count").innerText(), /^\d+ items$/);
        const lefts = await tv.page.locator('[data-view="personal:history"] .browse-card').evaluateAll(nodes => nodes.slice(0, 2).map(node => node.getBoundingClientRect().left));
        assert.ok(lefts[0]! < lefts[1]!, `English reads left to right: ${JSON.stringify(lefts)}`);
        const gap = await tv.page.locator('[data-view="personal:history"] .browse-card-title').first().evaluate(label => {
            const range = document.createRange();
            range.selectNodeContents(label);
            return range.getBoundingClientRect().left - label.getBoundingClientRect().left;
        });
        assert.ok(gap < 3, `English card text stays left-aligned: ${gap}`);
    });
});

test("a status ribbon painted before German's file lands reads in German after it, and later pages read the same", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new PersonalCatalog();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        // Routes added after the harness's own answer first: German's file waits until the grid has painted in English.
        await tv.page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); });
        for (const title of [...catalog.titles.values()]) catalog.add({ ...title, showStatus: title.id.endsWith("1") ? "ended" : "returning series" });
        tv.fake.catalog = catalog;
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        settings.profile().set(APP_LANGUAGE_KEY, "de");
        settings.profile().set("ui.card_overlays" as SettingsKey, { version: 2, items: { show_status: { enabled: true, position: "top-right" } } });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(false));
        await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.remote(DOWN);
        await tv.page.locator('[data-focus="watchlist"]').click();
        // The ribbons among the card's badges (a resolution badge is not one), as the page draws them: capitals by style, so compare in lower case.
        const englishWords = ["returning", "ended"];
        const germanWords = [text("overlays.returning", "de"), text("overlays.ended", "de")].map(word => word.toLowerCase());
        const ribbons = (): Promise<string[]> => tv.page.locator('[data-view="personal:watchlist"] .card-overlay').allInnerTexts()
            .then(texts => texts.map(label => label.toLowerCase()).filter(label => englishWords.includes(label) || germanWords.includes(label)));
        await tv.eventually(async () => (await ribbons()).length > 0, "ribbons painted");
        assert.ok((await ribbons()).every(label => englishWords.includes(label)), `English until the file lands: ${JSON.stringify(await ribbons())}`);
        release();
        await tv.eventually(async () => { const shown = await ribbons(); return shown.length > 0 && shown.every(label => germanWords.includes(label)); }, "the painted ribbons read in German");
        // A page that arrives later builds its cards in German too, so one grid never mixes the two.
        await tv.page.locator('[data-view="personal:watchlist"] .browse-card').last().evaluate(node => node.scrollIntoView());
        await tv.jump(500);
        assert.ok((await ribbons()).every(label => germanWords.includes(label)), `one grid, one language: ${JSON.stringify(await ribbons())}`);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
