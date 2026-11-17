// A year shows in the shown language's digits, never grouped, as silo-apple's `LocaleFormat.integer` prints it
// (tvOS/Screens/Detail/TVDetailHero.swift, TVItemDetailLoadingView.swift, Overlays/OverlayRegistry.swift).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeAudiobooks } from "../native/support/fakeAudiobooks.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
let overlayBundle: string;
let requestsBundle: string;
before(async () => {
    browser = await launchBrowser();
    const built = await build({
        stdin: { contents: `import { overlayLayer, parseOverlayPrefs } from "./src/ui/cardOverlays.ts"; import { setAppLanguage, SHIPPED_LANGUAGES } from "./src/i18n/language.ts"; Object.assign(window, { overlayLayer, parseOverlayPrefs, setAppLanguage, SHIPPED_LANGUAGES });`, resolveDir: new URL("../..", import.meta.url).pathname, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    overlayBundle = built.outputFiles[0]?.text ?? "";
    const requests = await build({
        stdin: { contents: `import { requestCard } from "./src/ui/requests.ts"; import { requestHero } from "./src/ui/requestsScene.ts"; import { setAppLanguage, SHIPPED_LANGUAGES } from "./src/i18n/language.ts"; Object.assign(window, { requestCard, requestHero, setAppLanguage, SHIPPED_LANGUAGES });`, resolveDir: new URL("../..", import.meta.url).pathname, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    requestsBundle = requests.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

const MOVIE = '[data-section="recently_added"] [data-focus="movie:m0001"]';
const ARABIC_YEAR = /^[٠-٩]{4}$/;
const ASCII_YEAR = /^[0-9]{4}$/;

async function withDetails(language: "ar" | undefined, body: (tv: Tv, year: number) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    if (language !== undefined) {
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        settings.profile().set(APP_LANGUAGE_KEY, language);
    }
    const detail = catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as { year?: number } | undefined;
    assert.ok(detail?.year !== undefined && detail.year > 0, "the fixture movie has a year");
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, detail.year);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

for (const [language, shape] of [["ar", ARABIC_YEAR], [undefined, ASCII_YEAR]] as const) {
    const where = language === undefined ? "in English" : "in Arabic";
    test(`${where} a movie's Details facts line shows its year in ${language === undefined ? "ASCII" : "Arabic-Indic"} digits`, async () => {
        await withDetails(language, async (tv, year) => {
            await tv.page.locator(MOVIE).first().click();
            const first = tv.page.locator(".details-fact").first();
            await first.waitFor();
            const text = (await first.textContent()) ?? "";
            assert.match(text, shape, `the first fact is the year: ${text}`);
            if (language === undefined) assert.equal(text, String(year));
        });
    });

    test(`${where} Details' loading page shows the card's year in ${language === undefined ? "ASCII" : "Arabic-Indic"} digits`, async () => {
        await withDetails(language, async tv => {
            await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", () => undefined);
            await tv.page.locator(MOVIE).first().click();
            const first = tv.page.locator(".details-loading-meta > span:not(.details-loading-bar)").first();
            await first.waitFor();
            // The loading line is one span: year, genre, runtime.
            assert.match((await first.textContent()) ?? "", new RegExp(`${shape.source.replace("$", "")}\\s`));
        });
    });
}

for (const [language, expected] of [["ar", "٢٠٢٣"], [null, "2023"]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} the year badge on a card reads ${expected}`, async () => {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        try {
            await page.setContent(`<!doctype html><main><div id="art" style="position:relative;width:220px;height:330px"></div></main>`);
            await page.addScriptTag({ content: overlayBundle });
            const text = await page.evaluate(tag => {
                const api = window as unknown as { overlayLayer: (card: unknown, prefs: unknown, variant: string, width: number, baseUrl: string) => HTMLElement | undefined; parseOverlayPrefs: (raw: unknown) => object; setAppLanguage: (tag: string | null, shipped: readonly string[], device: readonly string[]) => void; SHIPPED_LANGUAGES: readonly string[] };
                api.setAppLanguage(tag, api.SHIPPED_LANGUAGES, ["en-AU"]);
                const prefs = { ...api.parseOverlayPrefs({ year: { enabled: true, position: "top-right" } }), images: new Map() };
                const layer = api.overlayLayer({ id: "movie:1", type: "movie", title: "Film", year: 2023 }, prefs, "poster", 220, "https://silo.invalid");
                return layer?.querySelector(".card-overlay")?.textContent ?? null;
            }, language);
            assert.equal(text, expected);
        } finally { await page.close(); }
    });
}

for (const [language, expected] of [["ar", "١٩٩٥"], [null, "1995"]] as const) {
    test(`${language === "ar" ? "in Arabic" : "in English"} a request's card caption and detail line read its year as ${expected}`, async () => {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        try {
            await page.setContent("<!doctype html><main></main>");
            await page.addScriptTag({ content: requestsBundle });
            const read = await page.evaluate(tag => {
                const api = window as unknown as { requestCard: (title: unknown, baseUrl: string, open: () => void) => { element: HTMLElement }; requestHero: (title: unknown, baseUrl: string, metadata: undefined, detail: boolean) => HTMLElement; setAppLanguage: (tag: string | null, shipped: readonly string[], device: readonly string[]) => void; SHIPPED_LANGUAGES: readonly string[] };
                api.setAppLanguage(tag, api.SHIPPED_LANGUAGES, ["en-AU"]);
                const title = { mediaType: "movie", tmdbId: 949, title: "Heat", overview: "A detective.", availability: "missing", year: 1995, request: { requestable: true, following: false, requestedByViewer: false, id: undefined, state: undefined, reason: undefined } };
                return {
                    caption: api.requestCard(title, "https://silo.invalid", () => undefined).element.querySelector(".browse-card-subtitle")?.textContent ?? null,
                    detail: api.requestHero(title, "https://silo.invalid", undefined, true).querySelector(".requests-detail-metadata")?.textContent ?? null,
                };
            }, language);
            assert.equal(read.caption, expected);
            assert.ok(read.detail?.startsWith(expected), `the detail line starts with the year: ${read.detail}`);
        } finally { await page.close(); }
    });
}

test("in Arabic an audiobook's credits line and its narration rows read their years in Arabic-Indic digits", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeAudiobooks();
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "ar");
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
        await tv.page.locator('[data-view="audiobook:audiobook:tide"]').waitFor();
        assert.match(await tv.page.locator(".audiobook-static-credits").innerText(), / ٢٠٢٤$/, "the credits line ends with the book's year");
        assert.equal(await tv.page.locator('[data-focus="narration:audiobook:fresh"] .audiobook-row-detail').innerText(), "٢٠٢٥");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
