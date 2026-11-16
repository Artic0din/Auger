// Details and Search in German, the language a profile stores in ui.app_language: the text comes from the
// vendored catalog (silo-translations a0142c1a), and a key German lacks shows English.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
registerSourceCatalogs();
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const IME_DONE = 65376;
const german = (key: Parameters<typeof translate>[0], args?: Parameters<typeof translate>[1]): string => translate(key, args, "de");

async function inGerman(body: (tv: Tv, details: FakeDetails) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const details = new FakeDetails();
    tv.fake.catalog = details;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "de");
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, details);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("a movie's Details and its More menu read in German", async () => {
    await inGerman(async tv => {
        assert.equal(german("detail.more.addFavorite"), "Zu Favoriten hinzufügen", "the catalog holds German for this key");
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
        assert.equal(await tv.page.locator(".details-playback-summary strong").first().textContent(), german("detail.readout.version"));
        assert.match(await tv.page.locator('[data-focus="resume"]').textContent() ?? "", /^Ab \d+:\d\d fortsetzen$/, "Resume carries its time");
        assert.equal(await tv.page.locator('[data-focus="play"]').textContent(), german("detail.startOver"));
        assert.equal(await tv.page.locator('[data-focus="more"] .details-action-label').textContent(), german("detail.more"));
        await tv.page.locator('[data-focus="more"]').click();
        const panel = tv.page.getByRole("dialog", { name: german("detail.more") });
        await panel.waitFor();
        const rows = await panel.locator("button").allInnerTexts();
        assert.ok(rows.includes(german("detail.more.addFavorite")), `More lists "${german("detail.more.addFavorite")}": ${rows.join(" | ")}`);
        assert.ok(rows.includes(german("detail.more.markWatched")), "More lists Mark as Watched in German");
        assert.equal(rows.includes("Add to Favorites"), false, "no English row beside the German one");
    });
});

test("Search reads in German: field, filters, result count and the empty state", async () => {
    await inGerman(async tv => {
        assert.deepEqual([german("search.filter.movies"), german("search.initial"), german("search.emptyBody")], ["Filme", "Silo durchsuchen", "Versuche es mit einem anderen Suchbegriff"], "the catalog holds German for these keys");
        await tv.page.locator('[data-focus="search"]').click();
        assert.equal(await tv.page.locator("#browse-search").getAttribute("placeholder"), german("search.fieldPrompt.video"));
        await tv.page.getByText(german("search.initial"), { exact: true }).waitFor();
        await tv.page.fill("#browse-search", "Movie 0001"); await tv.remote(IME_DONE);
        await tv.page.locator('.browse-grid [data-focus="movie:m0001"]').waitFor();
        assert.deepEqual(await tv.page.locator(".search-filters button").allInnerTexts(), [german("search.filter.all"), german("search.filter.movies"), german("search.filter.series")]);
        assert.equal(await tv.page.locator(".search-count").innerText(), german("search.resultCount", { count: 1, count_text: "1" }));
        await tv.page.locator('[data-focus="search-filter:series"]').focus();
        await tv.page.getByText(german("search.emptyBody"), { exact: true }).waitFor();
    });
});

test("a movie's runtime and its audio track's language read as Apple TV writes them in German", async () => {
    await inGerman(async (tv, details) => {
        assert.equal(german("detail.more.addFavorite"), "Zu Favoriten hinzufügen", "the catalog holds German");
        const body = details.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as { versions: Record<string, unknown>[] };
        await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: {
            ...body, versions: body.versions.map(version => ({ ...version, effective_audio_track_index: 0, audio_tracks: [{ default: true, language: "pt", codec: "eac3", channels: 6 }] })),
        } }));
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
        assert.ok((await tv.page.locator(".browse-meta .details-fact").allInnerTexts()).includes("1h 30min"), "the 90-minute file reads 1h 30min");
        const audio = tv.page.locator('[data-track-summary="audio"] span');
        await tv.eventually(async () => (await audio.innerText()).includes("Portugiesisch"), "the audio readout names the track's language in German");
        assert.match(await audio.innerText(), /^Auto · Portugiesisch · EAC3/, "German's own Auto · {value}, then the track");
    });
});
