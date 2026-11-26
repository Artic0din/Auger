// Requests in German and Arabic (silo-apple tvOS/Screens/Requests/TVRequestsPage.swift and Screens/Requests/*): the hub, a record's
// detail and the record menu read from the catalog, and in Arabic the page mirrors as SwiftUI's `.leading` alignments do.
// Server text (a discover row's title, a title's name) stays as the server sent it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeRequests } from "../native/support/fakeRequests.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import type { Reply } from "../native/support/fakeSilo.ts";
import { afterPaint, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37;
const RIGHT = 39;
const BACK = 10009;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);

/** A discover row of three titles, so a rail has an order to walk. */
class ThreeTitles extends FakeRequests {
    constructor() {
        super();
        Object.assign(this.record, { backdrop_path: "https://silo.example.test/art/heat.svg", year: 2023, created_at: "2025-11-05T12:00:00Z" });
    }
    override title(): Record<string, unknown> { return { ...super.title(), backdrop_path: "https://silo.example.test/art/heat.svg" }; }
    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const reply = super.route(method, path, profileId, body);
        if (new URL(path, "https://fake.invalid").pathname !== "/requests/discover" || reply?.body === undefined) return reply;
        const first = this.title();
        const results = [first, { ...first, tmdb_id: 950, title: "Mid" }, { ...first, tmdb_id: 951, title: "Last" }];
        const section = { key: "trending_movies", title: "Trending Movies", page: 1, total_pages: 1, total_results: 3, results };
        return { status: 200, body: { items: [section], row_order: [{ key: section.key, title: section.title, type: "tmdb_chart" }] } };
    }
}

const button = (tv: Tv, key: string) => tv.page.locator(`[data-focus="${key}"]`).last();

async function inLanguage(language: string, body: (tv: Tv, fake: FakeRequests) => Promise<void>, requested = true, createFake: () => FakeRequests = () => new ThreeTitles()): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const fake = createFake();
    fake.created = requested;
    tv.fake.catalog = fake;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, language);
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", `${language} top bar`);
        await afterPaint(tv);
        await button(tv, "profiles").click();
        await button(tv, "requests").click();
        await tv.page.locator('.browse[data-view="requests:hub"]').waitFor();
        await button(tv, requested ? "request-one" : "movie:949").waitFor();
        await body(tv, fake);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("the Requests hub and a request's detail read in German", async () => {
    await inLanguage("de", async tv => {
        assert.deepEqual(await tv.page.locator(".requests-heading").allInnerTexts(), [text("requests.yourRequests", "de"), "Trending Movies"], "the server's row title stays as sent");
        assert.equal(await tv.page.locator(".requests-discover").innerText(), text("requests.hub.discover", "de").toUpperCase());
        assert.equal(await button(tv, "request-one").getAttribute("aria-label"), `Heat, 2023, ${text("requests.short.pending", "de")}`);
        assert.equal(await tv.page.locator(".requests-progress .requests-status-label").innerText(), text("requests.long.pending", "de"));
        assert.equal(await tv.page.locator(".requests-progress .requests-track").getAttribute("aria-label"), text("requests.long.pending", "de"));

        await button(tv, "request-one").click();
        await tv.page.locator('.browse[data-view="requests:request"]').waitFor();
        assert.equal(await tv.page.locator(".requests-eyebrow").innerText(), text("requests.detail.eyebrowRequested", "de"));
        assert.deepEqual(await tv.page.locator(".requests-summary-label").allInnerTexts(), [text("requests.strip.status", "de"), text("requests.strip.requested", "de")]);
        assert.deepEqual(await tv.page.locator(".requests-track-labels .requests-step").allInnerTexts(),
            [text("requests.stage.requested", "de"), text("requests.stage.approved", "de"), text("requests.stage.downloading", "de"), text("requests.stage.library", "de")]);
        assert.equal(await button(tv, "status").innerText(), text("requests.long.pending", "de"));
        assert.equal(await button(tv, "cancel").innerText(), text("requests.action.cancel", "de"));
    });
});

test("Notify Me, Stop Notifying Me, and Request Again read in German", async () => {
    await inLanguage("de", async (tv, fake) => {
        const origTitle = fake.title.bind(fake);
        fake.title = () => ({ ...origTitle(), request: { requestable: true, following: false, requested_by_viewer: false } });
        Object.assign(fake.record, { state: "failed", status: "approved", outcome: "failed" });
        await button(tv, "request-one").click();
        await button(tv, "create").waitFor();
        assert.equal(await button(tv, "create").innerText(), text("requests.action.requestAgain", "de"));
    });

    await inLanguage("de", async (tv, fake) => {
        fake.requestedByOther = true;
        await button(tv, "movie:949").click();
        await button(tv, "follow").waitFor();
        assert.equal(await button(tv, "follow").innerText(), text("requests.action.notify", "de"));
        await button(tv, "follow").click();
        await tv.eventually(async () => await button(tv, "follow").innerText() === text("requests.action.stopNotify", "de"), "Stop Notifying Me in German");
    }, false);
});

test("a title nobody has requested reads Request, and its detail names it Not in your library, in German", async () => {
    await inLanguage("de", async tv => {
        await button(tv, "movie:949").click();
        await tv.page.locator('.browse[data-view="requests:media"]').waitFor();
        assert.equal(await tv.page.locator(".requests-eyebrow").innerText(), text("requests.detail.eyebrowNotInLibrary", "de"));
        assert.equal(await button(tv, "create").innerText(), text("requests.action.request", "de"));
    }, false);
});

test("the record menu offers Cancel Request in German", async () => {
    await inLanguage("de", async tv => {
        await button(tv, "request-one").focus();
        await tv.down(13);
        await tv.jump(650);
        await tv.up(13);
        assert.equal(await button(tv, "cancel-request").innerText(), text("requests.action.cancel", "de"));
    });
});

test("in Arabic the hub is mirrored: its rail reads from the right and Left walks it", async () => {
    await inLanguage("ar", async tv => {
        await tv.eventually(async () => await tv.page.evaluate(() => document.documentElement.getAttribute("dir")) === "rtl", "dir rtl");
        assert.equal(await tv.page.locator(".requests-heading").first().innerText(), text("requests.yourRequests", "ar"));
        const edges = await tv.page.evaluate(() => {
            const rail = document.querySelector('[data-section="row:trending_movies"] .requests-rail')?.getBoundingClientRect();
            const cards = Array.from(document.querySelectorAll('[data-section="row:trending_movies"] .requests-card')).map(card => card.getBoundingClientRect().left);
            return { rail: rail === undefined ? Number.NaN : rail.right, cards, direction: getComputedStyle(document.querySelector(".requests-hub") as Element).direction };
        });
        assert.equal(edges.direction, "rtl");
        assert.ok(edges.cards.length === 3 && edges.cards[0]! > edges.cards[1]! && edges.cards[1]! > edges.cards[2]!, `the first card is rightmost: ${JSON.stringify(edges.cards)}`);
        await button(tv, "movie:949").focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "movie:950", "Left steps toward the card on the left");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), "movie:949", "Right returns");
        const copy = await tv.page.evaluate(() => document.querySelector(".requests-preview .requests-hero-copy")?.getBoundingClientRect());
        assert.ok(copy !== undefined && copy.left > 1920 - copy.right - 1, `the preview's text sits on the right: ${JSON.stringify(copy)}`);
        const art = await tv.page.locator(".requests-preview .skyline-art-frame").evaluate(frame => { const box = frame.getBoundingClientRect(); return { left: box.left, right: box.right }; });
        assert.ok(art.left < 1920 - art.right, `the artwork leans to the left edge: ${JSON.stringify(art)}`);
    });
});

test("in Arabic a request's detail is mirrored and reads from the catalog", async () => {
    await inLanguage("ar", async tv => {
        await tv.eventually(async () => await tv.page.evaluate(() => document.documentElement.getAttribute("dir")) === "rtl", "dir rtl");
        await button(tv, "request-one").click();
        await tv.page.locator('.browse[data-view="requests:request"]').waitFor();
        assert.equal(await tv.page.locator(".requests-eyebrow").innerText(), text("requests.detail.eyebrowRequested", "ar"));
        assert.deepEqual(await tv.page.locator(".requests-track-labels .requests-step").allInnerTexts(),
            [text("requests.stage.requested", "ar"), text("requests.stage.approved", "ar"), text("requests.stage.downloading", "ar"), text("requests.stage.library", "ar")]);
        const sides = await tv.page.evaluate(() => {
            const copy = document.querySelector(".requests-detail-hero .requests-hero-copy")?.getBoundingClientRect();
            return { copyRight: copy?.right ?? Number.NaN, direction: getComputedStyle(document.querySelector(".requests-detail-hero") as Element).direction };
        });
        assert.equal(sides.direction, "rtl");
        assert.ok(Math.abs(sides.copyRight - (1920 - 100)) <= 2, `the copy hangs from the right edge: ${JSON.stringify(sides)}`);
        const frame = await tv.page.locator(".requests-detail-hero .skyline-art-frame").evaluate(node => { const box = node.getBoundingClientRect(); return { left: box.left, right: box.right }; });
        assert.ok(frame.left <= 1 && frame.right < 1920 - 100, `the artwork sits at the left edge: ${JSON.stringify(frame)}`);
        await tv.remote(BACK);
        await tv.page.locator('.browse[data-view="requests:hub"]').waitFor();
    });
});

test("in Arabic the hero line is one text, laid out as Core Text lays out Apple's: the first strong letter, Movie, sets a left-to-right line", async () => {
    await inLanguage("ar", async tv => {
        await tv.eventually(async () => await tv.page.evaluate(() => document.documentElement.getAttribute("dir")) === "rtl", "dir rtl");
        assert.equal(await button(tv, "request-one").getAttribute("aria-label"), `Heat, ٢٠٢٣, ${text("requests.short.pending", "ar")}`);
        const line = await tv.page.locator(".requests-preview .requests-metadata").evaluate(row => {
            const span = row.querySelector("span");
            const node = span?.firstChild;
            if (span === null || span === undefined || node === null || node === undefined) return undefined;
            const text = node.textContent ?? "";
            const left = (word: string): number => { const at = text.indexOf(word); const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + word.length); return range.getBoundingClientRect().left; };
            return { text, year: left("٢٠٢٣"), kind: left("Movie"), requested: left(text.split(" · ")[2] ?? "?"), bidi: getComputedStyle(span).unicodeBidi, spans: row.querySelectorAll("span:not(.requests-tmdb span)").length };
        });
        assert.ok(line !== undefined);
        assert.ok(line.text.startsWith("٢٠٢٣ · Movie · "), line.text);
        assert.ok(line.text.split(" · ")[2]?.startsWith(text("requests.requestedOn", "ar", { date: "\u0001" }).split("\u0001")[0] ?? "?"), line.text);
        assert.equal(line.bidi, "plaintext", "the base direction comes from the text's first strong letter, as Apple's Text does");
        assert.ok(line.year < line.kind && line.kind < line.requested, `Apple reads year, Movie, requested from the left: ${JSON.stringify(line)}`);
    });
});

test("merged discover headings and own-request failure reasons read in German on the hub", async () => {
    await inLanguage("de", async tv => {
        assert.deepEqual(await tv.page.locator(".requests-heading").allInnerTexts(), [
            text("requests.yourRequests", "de"),
            text("requests.discover.trendingNow", "de"),
            text("requests.discover.crowdFavorites", "de"),
        ]);
        assert.equal(
            await tv.page.locator(".requests-preview .requests-status-label").innerText(),
            `${text("requests.long.failed", "de")} · ${text("requests.reason.quota_exceeded", "de")}`,
        );
    }, true, () => {
        const fake = new ThreeTitles();
        Object.assign(fake.record, { state: "failed", status: "approved", outcome: "failed", last_error: "quota_exceeded" });
        const origRoute = fake.route.bind(fake);
        fake.route = (method, path, profileId, body) => {
            if (new URL(path, "https://fake.invalid").pathname === "/requests/discover") {
                const first = fake.title();
                return {
                    status: 200,
                    body: {
                        items: [
                            { key: "trending_movies", title: "Trending Movies", page: 1, total_pages: 1, results: [first] },
                            { key: "popular_series", title: "Popular Series", page: 1, total_pages: 1, results: [{ ...first, media_type: "series", tmdb_id: 952, title: "Show" }] },
                        ],
                    },
                };
            }
            return origRoute(method, path, profileId, body);
        };
        return fake;
    });
});
