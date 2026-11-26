import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { afterPaint, jumpUntil, launchBrowser, openTv, pauseTvClock, type Tv } from "./support/tv.ts";

const IME_DONE = 65376;
const ENTER = 13;

function owner(tv: Tv): Promise<{ tag: string | null; key: string | null; play: boolean; body: boolean }> {
    return tv.page.evaluate(() => ({
        tag: document.activeElement?.tagName ?? null,
        key: document.activeElement?.getAttribute("data-focus") ?? null,
        play: document.activeElement?.classList.contains("details-play") === true,
        body: document.activeElement === document.body,
    }));
}

async function signedIn(tv: Tv): Promise<void> {
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
}

async function searchFor(tv: Tv, query: string, key: string): Promise<void> {
    await tv.page.locator('[data-focus="search"]').click();
    await tv.page.fill("#browse-search", query);
    await tv.remote(IME_DONE);
    const card = tv.page.locator(`.browse-grid [data-focus="${key}"]`);
    await card.waitFor();
    await card.focus();
}

declare global { interface Window { seasonAnswers: string[]; detailsEntryFocus: (string | null)[]; episodeReadPainted: boolean[]; heroDraws: number; readsInFlight: number } }

/** Records each season whose episode list the app has read off the network, in the order it read them. */
async function recordSeasonAnswers(page: Page): Promise<void> {
    await page.addInitScript(() => {
        window.seasonAnswers = [];
        const fetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            const response = await fetch(input, init);
            const season = /\/seasons\/(\d+)\/episodes/.exec(String(input))?.[1];
            if (season !== undefined) {
                const text = response.text.bind(response);
                response.text = async () => { const body = await text(); window.seasonAnswers.push(season); return body; };
            }
            return response;
        };
    });
}

let browser: Browser;

before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

test("opening a movie from Search leaves Play focused when the opening claim does not stick", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    catalog.progress.delete("movie:m0001");
    tv.fake.catalog = catalog;
    try {
        await signedIn(tv);
        await searchFor(tv, "Movie 0001", "movie:m0001");
        const holds = [
            "/recommendations/similar/movie%3Am0001",
            "/watchlist/movie%3Am0001/membership",
            "/favorites/movie%3Am0001/membership",
            "/catalog/items/movie%3Am0001/box-set",
            "/capabilities/personal-lists",
            "/settings/contract/capabilities",
            "/settings/contract",
            "/settings/values/effective",
        ].map(path => tv.fake.hold(path));
        // The TV can drop the Play claim made while the search card is removed.
        // Reject every claim in that opening turn. The page clock otherwise keeps
        // running across the round trip, and the 50ms retry restores Play before
        // a later read. Hold the clock so this read is still that rejected claim,
        // then advance the window Apple retries inside (three attempts, 50ms apart).
        // That later read is the Play focus the viewer sees, with no remote key
        // and no follow-up repaint.
        await pauseTvClock(tv);
        await tv.page.evaluate(() => {
            document.documentElement.dataset.blockPlay = "1";
            document.addEventListener("focusin", event => {
                const target = event.target;
                if (document.documentElement.dataset.blockPlay !== "1" || !(target instanceof HTMLElement) || !target.classList.contains("details-play")) return;
                target.blur();
            }, true);
        });
        await tv.remote(ENTER);
        await tv.page.locator(".details-play").waitFor();
        await tv.page.evaluate(() => undefined);
        const dropped = await tv.page.evaluate(() => {
            const active = document.activeElement;
            const snapshot = {
                tag: active?.tagName ?? null,
                key: active?.getAttribute("data-focus") ?? null,
                play: active?.classList.contains("details-play") === true,
                body: active === document.body,
            };
            delete document.documentElement.dataset.blockPlay;
            return snapshot;
        });
        await tv.jump(200);
        const settled = await owner(tv);
        assert.equal(dropped.body, true, `opening claim stayed on ${dropped.key ?? dropped.tag}`);
        assert.equal(settled.body, false, JSON.stringify(settled));
        assert.equal(settled.play, true, JSON.stringify(settled));
        assert.equal(settled.key, "play", JSON.stringify(settled));
        for (const hold of holds) hold.release();
        await tv.eventually(async () => await tv.page.locator('[data-focus="watchlist"]').count() === 1, "personal actions settled");
        const repainted = await owner(tv);
        assert.equal(repainted.key, "play", `a supporting repaint left ${JSON.stringify(repainted)}`);
        assert.equal(repainted.play, true);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a card-actions dialog keeps focus while the Play claim is still retrying", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    try {
        await signedIn(tv);
        await searchFor(tv, "Movie 0001", "movie:m0001");
        await pauseTvClock(tv);
        await tv.remote(ENTER);
        const primary = tv.page.locator(".details-play");
        await primary.waitFor();
        await tv.eventually(async () => await primary.getAttribute("aria-disabled") !== "true", "movie Play ready");
        const related = tv.page.locator('[data-detail-section="related"] [data-focus]').first();
        // Answers paint on the next frame; step frames only once the answer is out, so the 50 ms claim retry stays pending.
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.includes("/recommendations/similar/")), "related read");
        await jumpUntil(tv, 16, async () => await related.count() > 0, "related rail");
        await related.click({ button: "right" });
        await tv.page.locator(".card-menu").waitFor();
        const dialog = await owner(tv);
        await tv.jump(200);
        const settled = await owner(tv);
        assert.equal(dialog.body, false, `dialog never took focus: ${JSON.stringify(dialog)}`);
        assert.equal(settled.key, dialog.key, `retry left ${JSON.stringify(settled)}`);
        assert.equal(settled.play, false, `retry focused Play behind the dialog: ${JSON.stringify(settled)}`);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

async function hideSeriesPlayTarget(tv: Tv): Promise<void> {
    const catalog = tv.fake.catalog;
    if (!(catalog instanceof FakeDetails)) throw new Error("expected details catalog");
    await tv.page.route("**/api/v2/catalog/items/series%3As1?**", route => {
        const reply = catalog.route("GET", "/catalog/items/series%3As1", "p-owner");
        const body = reply?.body;
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("series detail missing");
        const detail: Record<string, unknown> = { ...body };
        delete detail.play_content_id;
        return route.fulfill({ json: detail });
    });
}

test("a series without a play target focuses Watchlist while episodes load until episodes arrive", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    await hideSeriesPlayTarget(tv);
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes");
        await tv.remote(ENTER);
        await tv.page.locator('[data-view="item:series:s1"] [data-focus="season:1"]').waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').count() === 0, "series opened before its primary existed");
        const before = await owner(tv);
        assert.equal(before.body, false, `opening focus was lost: ${JSON.stringify(before)}`);
        assert.equal(before.play, false, `primary was already present: ${JSON.stringify(before)}`);
        assert.equal(before.key, "watchlist", `opening entry must land on Watchlist: ${JSON.stringify(before)}`);
        episodes.release();
        await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').count() === 1, "late primary rendered");
        await tv.eventually(async () => await tv.focused() === "next-episode", "late primary claims focus");
        const settled = await owner(tv);
        assert.equal(settled.key, "next-episode", JSON.stringify(settled));
        assert.equal(settled.play, true, JSON.stringify(settled));
        assert.deepEqual(catalog.mutations, []);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reduced of [false, true]) test(`opening series Details from Home focuses Watchlist while episodes load${reduced ? " with reduced motion" : ""}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    try {
        if (reduced) await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signedIn(tv);
        const card = tv.page.locator('[data-view="home"] [data-focus="series:s1"]').first();
        await card.waitFor();
        await card.focus();
        const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes");
        const playback = tv.fake.hold("/catalog/items/episode%3As1e11");
        await tv.page.evaluate(() => {
            window.detailsEntryFocus = [];
            document.addEventListener("focusin", () => window.detailsEntryFocus.push(document.activeElement?.getAttribute("data-focus") ?? null));
        });
        await tv.remote(ENTER);
        const primary = tv.page.locator('[data-view="item:series:s1"] [data-focus="next-episode"]');
        await primary.waitFor();
        await tv.eventually(async () => ["/catalog/series/series%3As1/seasons/1/episodes", "/catalog/items/episode%3As1e11"].every(path => tv.fake.requests.some(request => request.path.split("?")[0] === path)), "episode and playback reads held");
        assert.equal(await primary.textContent(), "Loading episodes…");
        assert.equal(await primary.getAttribute("aria-disabled"), "true");
        assert.equal(await tv.focused(), "watchlist");
        await tv.jump(200);
        assert.deepEqual(catalog.mutations, []);
        assert.deepEqual(await tv.page.evaluate(() => window.browseHarness.plays), []);
        assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["loading", "watchlist"]);
        playback.release();
        await tv.eventually(async () => await primary.getAttribute("aria-disabled") === "false", "playback detail arrived first");
        assert.equal(await tv.focused(), "watchlist");
        assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["loading", "watchlist"]);
        episodes.release();
        await tv.eventually(async () => await tv.focused() === "next-episode", "loaded series entry claims Play");
        assert.equal(await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').count(), 1);
        assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["loading", "watchlist", "next-episode"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

for (const reduced of [false, true]) test(`Home series entry focuses Watchlist across delayed hierarchy responses${reduced ? " with reduced motion" : ""}`, async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    for (const title of catalog.titles.values()) if (title.seriesId === "series:s1") catalog.titles.delete(title.id);
    for (let episode = 1; episode <= 7; episode++) catalog.add({ id: `episode:s1e1${episode}`, type: "episode", title: `Chapter ${episode}`, libraryId: "13", seriesId: "series:s1", season: 1, episode });
    catalog.watchedEpisodes.clear();
    catalog.progress.clear();
    tv.fake.catalog = catalog;
    const paths = ["/catalog/items/series%3As1", "/catalog/series/series%3As1/seasons", "/catalog/series/series%3As1/seasons/1/episodes", "/catalog/items/episode%3As1e11"];
    const holds = paths.map(path => tv.fake.hold(path));
    try {
        if (reduced) await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signedIn(tv);
        const card = tv.page.locator('[data-view="home"] [data-focus="series:s1"]').first();
        await card.focus();
        await tv.jump(200);
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === paths[0]), "Home marquee detail request");
        const detail = tv.page.waitForResponse(response => new URL(response.url()).pathname.endsWith(paths[0] ?? ""));
        holds[0]?.release();
        await (await detail).finished();
        // Real elapsed time separates the item response from season discovery.
        await new Promise(resolve => setTimeout(resolve, 200));
        await tv.remote(ENTER);
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === paths[1]), "season discovery pending");
        await new Promise(resolve => setTimeout(resolve, 200));
        // Reopen the detail cached by the first entry before seasons have answered.
        // Its first paint precedes DetailsState.start(), so no loading flag is set.
        await tv.remote(10009);
        await card.waitFor();
        await card.focus();
        const seasons = tv.fake.hold(paths[1] ?? "");
        holds.push(seasons, tv.fake.hold(paths[3] ?? ""));
        await tv.page.evaluate(() => {
            window.detailsEntryFocus = [];
            document.addEventListener("focusin", () => window.detailsEntryFocus.push(document.activeElement?.getAttribute("data-focus") ?? null));
        });
        await tv.remote(ENTER);
        const primary = tv.page.locator('[data-view="item:series:s1"] [data-focus="next-episode"]');
        await primary.waitFor();
        for (const stage of [1, 2]) {
            await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === paths[stage]), `pending ${paths[stage]}`);
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.equal(await primary.textContent(), "Loading episodes…");
            assert.equal(await primary.getAttribute("aria-disabled"), "true");
            assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["watchlist"], `unexpected focus before ${paths[stage]}`);
            assert.equal(await tv.focused(), "watchlist");
            holds[stage]?.release();
            if (stage === 1) seasons.release();
        }
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.split("?")[0] === paths[3]), "pending playback detail");
        await tv.eventually(async () => await tv.focused() === "next-episode", "episode summary enables Play");
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await primary.textContent(), "Play S1:E1");
        assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["watchlist", "next-episode"]);
        for (const hold of holds.filter(hold => hold.path === paths[3])) hold.release();
        // Subtitles enables once the playback choices land; a single-version episode keeps Versions disabled (#720).
        await tv.eventually(async () => await tv.page.locator('[data-focus="subtitles"]').getAttribute("aria-disabled") !== "true", "playback detail arrived");
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.equal(await tv.focused(), "next-episode");
        assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["watchlist", "next-episode"]);
        assert.deepEqual(catalog.mutations, []);
        assert.deepEqual(tv.console, []);
    } finally { for (const hold of holds) hold.release(); await tv.page.context().close(); }
});

test("an empty episode response focuses Watchlist until playback detail resolves", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    const playback = tv.fake.hold("/catalog/items/episode%3As1e11");
    // Home's prefetch reads answer after Home has drawn; each answer repaints a Home section and Home restores focus to the card by id.
    const prefetch = [tv.fake.hold("/catalog/items/movie%3Am0001"), tv.fake.hold("/catalog/items/episode%3As1e12")];
    try {
        await signedIn(tv);
        await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/*/episodes?**", route => route.fulfill({ json: { items: [] } }));
        await tv.page.locator('[data-view="home"] [data-focus="series:s1"]').first().focus();
        for (const hold of prefetch) hold.release();
        // The recorder below must see only the entry into Details, so let that repaint and its focus restore finish first.
        // Nothing else is held yet (the playback read is made on entry), and a just-released hold still counts as held until its promise settles.
        await tv.eventually(async () => tv.pendingReplies === 0, "Home prefetch answers delivered");
        await afterPaint(tv);
        await tv.eventually(async () => await tv.focused() === "series:s1", "Home card focused after the repaint");
        await tv.page.evaluate(() => {
            window.detailsEntryFocus = [];
            document.addEventListener("focusin", () => window.detailsEntryFocus.push(document.activeElement?.getAttribute("data-focus") ?? null));
        });
        await tv.remote(ENTER);
        await tv.page.locator(".details-episodes-empty").waitFor();
        const primary = tv.page.locator('[data-focus="next-episode"]');
        assert.equal(await primary.textContent(), "Loading episodes…");
        assert.equal(await primary.getAttribute("aria-disabled"), "true");
        assert.equal(await tv.focused(), "watchlist");
        assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["loading", "watchlist"]);
        playback.release();
        await tv.eventually(async () => await tv.focused() === "next-episode", "resolved Play claims empty-rail entry");
        assert.equal(await primary.textContent(), "Play S1:E1");
        assert.deepEqual(await tv.page.evaluate(() => [...new Set(window.detailsEntryFocus)]), ["loading", "watchlist", "next-episode"]);
        assert.deepEqual(catalog.mutations, []);
        assert.deepEqual(tv.console, []);
    } finally { playback.release(); for (const hold of prefetch) hold.release(); await tv.page.context().close(); }
});

test("selecting Watchlist while episodes load keeps Watchlist focused after Play resolves", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    tv.fake.catalog = catalog;
    try {
        await signedIn(tv);
        const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes");
        await tv.page.locator('[data-view="home"] [data-focus="series:s1"]').first().focus();
        await tv.remote(ENTER);
        const primary = tv.page.locator('[data-view="item:series:s1"] [data-focus="next-episode"]');
        await primary.waitFor();
        await tv.page.locator('[data-view="item:series:s1"] [data-focus="watchlist"][aria-pressed]').waitFor();
        assert.equal(await tv.focused(), "watchlist");
        // Hold Select while episodes finish loading; Play must not steal focus before keyup.
        await tv.page.keyboard.down("Enter");
        episodes.release();
        await tv.eventually(async () => await primary.getAttribute("aria-disabled") === "false", "Play enabled while Select is held");
        await tv.jump(200);
        assert.equal(await tv.focused(), "watchlist", "holding Select on Watchlist cancels the pending Play claim");
        await tv.page.keyboard.up("Enter");
        await tv.eventually(async () => catalog.mutations.length === 1, "Watchlist toggle sent");
        assert.equal(await tv.focused(), "watchlist", "releasing Select completes Watchlist and keeps focus");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a primary action that appears after the viewer moves leaves that control focused", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    await hideSeriesPlayTarget(tv);
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        const episodes = tv.fake.hold("/catalog/series/series%3As1/seasons/1/episodes");
        await tv.remote(ENTER);
        await tv.page.locator('[data-view="item:series:s1"] [data-focus="season:1"]').waitFor();
        await tv.eventually(async () => await tv.page.locator('[data-focus="next-episode"]').count() === 0, "series opened before its primary existed");
        await tv.page.locator('[data-focus="season:1"]').focus();
        await tv.remote(39);
        const moved = await owner(tv);
        episodes.release();
        await tv.page.locator('[data-focus="next-episode"]').waitFor();
        await tv.jump(200);
        const settled = await owner(tv);
        assert.notEqual(moved.key, "next-episode");
        assert.equal(settled.key, moved.key, `late primary replaced ${JSON.stringify(moved)} with ${JSON.stringify(settled)}`);
        assert.equal(settled.play, false);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("opening a series keeps its primary action when focus has moved", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        await tv.remote(ENTER);
        await tv.eventually(async () => await tv.focused() === "next-episode", "series primary action");
        await tv.page.locator('[data-focus="season:1"]').focus();
        await tv.jump(200);
        assert.equal(await tv.focused(), "season:1", "a later Play claim must not steal the season the viewer moved to");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Left through a loaded previous season after a fast chip walk sends no season read", async () => {
    const tv = await openTv(browser, { app: "browse", prepare: recordSeasonAnswers });
    const catalog = new FakeDetails();
    for (let season = 3; season <= 25; season++) for (let episode = 1; episode <= (season === 25 ? 13 : 22); episode++) catalog.add({ id: `episode:s1e${season}x${episode}`, type: "episode", title: `Harbor chapter ${season}.${episode}`, libraryId: "13", seriesId: "series:s1", season, episode });
    tv.fake.catalog = catalog;
    const seasonReads = (): string[] => tv.fake.requests.filter(request => /\/seasons\/\d+\/episodes/.test(request.path)).map(request => /\/seasons\/(\d+)\//.exec(request.path)?.[1] ?? "");
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        await tv.remote(ENTER);
        await tv.page.locator('[data-focus="season:1"]').waitFor();
        await tv.jump(500);
        await tv.page.locator('[data-focus="season:1"]').focus();
        // Each held read is aborted by the next chip, as in a fast walk.
        const holds = Array.from({ length: 22 }, (_, index) => tv.fake.hold(`/catalog/series/series%3As1/seasons/${index + 3}/episodes`));
        for (let press = 0; press < 24; press++) {
            // Season 25 is the one read the walk does not hold. Selecting it once its page has loaded restarts the prefetch,
            // which aborts season 24's read and reads it again; selecting it while its own read is in flight keeps the
            // prefetch. On a slow runner the 70 ms dwell can fire before that answer, so wait for the page to load.
            if (press === 23) await tv.eventually(() => tv.page.evaluate(() => window.seasonAnswers.includes("25")), "season 25's episodes loaded");
            const reads = seasonReads().length;
            await tv.remote(39); await tv.jump(80);
            // Every chip after season 2 reads the season beside it. The fake records a read only once Playwright
            // intercepts it, and on a slow runner the next chip can abort the read before that, so wait for it.
            if (press > 0) await tv.eventually(async () => seasonReads().length > reads, `season ${press + 2}'s neighbour read reached the fake`);
        }
        for (const hold of holds) hold.release();
        await tv.jump(300);
        await tv.remote(ENTER); await tv.jump(500);
        await tv.page.locator('[data-focus="episode:s1e25x1"]').waitFor();
        await tv.remote(40); await tv.jump(500);
        assert.equal(await tv.focused(), "episode:s1e25x1");
        // Left reaches season 24 only once its re-read, started by season 25's selection, has been answered.
        await tv.eventually(() => tv.page.evaluate(() => window.seasonAnswers.includes("24")), "season 24's episodes loaded");
        const beforeLeft = seasonReads().length;
        await tv.remote(37); await tv.jump(1500);
        // The season read answers over the routed network, after the fake clock has passed the dwell.
        await tv.eventually(async () => await tv.focused() === "episode:s1e24x22", "Left reaches the aborted previous season");
        assert.equal(await tv.focused(), "episode:s1e24x22", "Left at the first loaded card reaches the previous season");
        const reads = seasonReads().length;
        assert.equal(reads, beforeLeft, "Left sends no season read: each selection of the walk already read the season beside it");
        assert.equal(seasonReads().filter(number => number === "24").length, 2, "the walk aborted one read of season 24 and season 25's selection read it again as its previous neighbour");
        for (let press = 0; press < 14; press++) { await tv.remote(37); await tv.jump(1500); }
        assert.equal(await tv.focused(), "episode:s1e24x8");
        assert.deepEqual(seasonReads().slice(reads), [], "moves inside the loaded season never read a season list");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("answers that land before the next frame redraw opening series Details once", async () => {
    // On the S95C one Details redraw takes 130-180 ms; one per answer kept the TV busy for about 2 s after opening.
    const tv = await openTv(browser, { app: "browse", prepare: async page => { await page.addInitScript(() => {
        window.heroDraws = 0;
        window.readsInFlight = 0;
        const fetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
            window.readsInFlight++;
            try { const response = await fetch(input, init); await response.clone().text(); return response; } finally { window.readsInFlight--; }
        };
        new MutationObserver(records => {
            for (const record of records) for (const node of record.addedNodes) {
                if (node instanceof Element && (node.matches(".details-hero") || node.querySelector(".details-hero") !== null)) window.heroDraws++;
            }
        }).observe(document, { childList: true, subtree: true });
    }); } });
    tv.fake.catalog = new FakeDetails();
    const settled = async (): Promise<void> => {
        let idle = 0;
        await tv.eventually(async () => { idle = await tv.page.evaluate(() => window.readsInFlight) === 0 ? idle + 1 : 0; return idle >= 10; }, "Details answers");
    };
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        await pauseTvClock(tv);
        await tv.page.evaluate(() => { window.heroDraws = 0; });
        await tv.remote(ENTER);
        await tv.page.locator(".details-hero").waitFor();
        await settled();
        const routeDraws = await tv.page.evaluate(() => window.heroDraws);
        assert.ok(routeDraws <= 2, `the answers redrew Details ${routeDraws} times before the next frame`);
        await tv.jump(16);
        assert.equal(await tv.page.evaluate(() => window.heroDraws), routeDraws + 1, "one redraw for the burst");
        await tv.page.locator('.details-episodes [data-focus="episode:s1e11"]').waitFor();
        assert.notEqual(await tv.focused(), null);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a focused episode's read leaves before the dwell repaints Details", async () => {
    // On the S95C a Details repaint takes 140-180 ms; the 120 ms dwell's read must not wait behind it.
    const tv = await openTv(browser, { app: "browse", prepare: async page => { await page.addInitScript(() => {
        window.episodeReadPainted = [];
        const fetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
            if (/\/catalog\/items\/episode%3As1e1[1-7]/.test(String(input))) window.episodeReadPainted.push(document.querySelector("[data-before-dwell]") === null);
            return fetch(input, init);
        };
    }); } });
    const catalog = new FakeDetails();
    for (const title of catalog.titles.values()) if (title.seriesId === "series:s1") catalog.titles.delete(title.id);
    for (let episode = 1; episode <= 7; episode++) catalog.add({ id: `episode:s1e1${episode}`, type: "episode", title: `Chapter ${episode}`, libraryId: "13", seriesId: "series:s1", season: 1, episode });
    tv.fake.catalog = catalog;
    try {
        await signedIn(tv);
        await searchFor(tv, "Harbor Lights", "series:s1");
        await tv.remote(ENTER);
        await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').waitFor();
        await tv.jump(2000);
        await tv.page.locator('.details-episodes [data-focus="episode:s1e12"]').focus();
        await tv.jump(2000);
        // The focused episode's own read answers late and repaints Details, which would drop the marker set below.
        await tv.eventually(async () => tv.pendingReplies === 0, "the focused episode's answer delivered");
        await afterPaint(tv);
        await tv.page.evaluate(() => { window.episodeReadPainted = []; });
        await pauseTvClock(tv);
        // pauseAt runs the timers due in its margin, and the reads they start answer late; none may repaint Details inside the window below.
        await tv.eventually(async () => tv.pendingReplies === 0, "the timers' reads answered");
        await tv.remote(39);
        assert.equal(await tv.focused(), "episode:s1e13");
        // Marks the screen the focus move painted; the dwell's repaint replaces it.
        await tv.page.evaluate(() => document.querySelector(".details-hero")?.setAttribute("data-before-dwell", ""));
        await tv.jump(119);
        assert.deepEqual(await tv.page.evaluate(() => window.episodeReadPainted), [], "no read before the dwell");
        await tv.jump(1);
        await tv.eventually(() => tv.page.evaluate(() => window.episodeReadPainted.length === 1), "the focused episode's read");
        assert.deepEqual(await tv.page.evaluate(() => window.episodeReadPainted), [false], "the read left before the dwell's repaint");
        // The repaint waits for the next animation frame, which the paused clock holds until it moves.
        await jumpUntil(tv, 16, async () => await tv.page.locator("[data-before-dwell]").count() === 0, "the dwell's repaint");
        assert.equal(await tv.focused(), "episode:s1e13");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
