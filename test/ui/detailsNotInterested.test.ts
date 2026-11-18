// Not interested on a title page (silo-apple 29c0dd43 TVMovieDetailView and TVSeriesDetailView More menu, ItemDetailViewModel.toggleNotInterested):
// a movie or series page from a server that sends the mark offers it in More after Find Trailers, a new mark leaves Home's
// recommendation rows and lands focus on the card that took its place when Back returns, a clear keeps everything, and a
// refused write leaves the page and Home as they were and shows the update-failed alert.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { problem } from "../native/support/fakeSilo.ts";
import { afterPaint, launchBrowser, type Tv } from "./support/tv.ts";
import { card, ids, RECOMMENDED, runTv, startHome } from "./support/notInterestedFake.ts";

const start = startHome;

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const BACK = 10009;
const run = (body: (tv: Tv) => Promise<void>): Promise<void> => runTv(browser, body);

const shownItems = (tv: Tv) => tv.page.locator('.details-more-popover .browse-button').evaluateAll(nodes => nodes.map(node => (node.textContent ?? "").trim()));

test("a movie and a series page from a server that sends the mark offer Not Interested in More, an episode page and an older server do not", () => run(async tv => {
    const catalog = await start(tv);
    await card(tv, RECOMMENDED, "movie:m0002").click();
    await tv.page.locator('[data-view="item:movie:m0002"] [data-focus="more"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    assert.equal((await shownItems(tv)).at(-1), "Not Interested", "a movie's More ends with it, after Find Trailers");
    assert.ok((await shownItems(tv)).includes("Find Trailers"));
    await tv.remote(BACK);
    await tv.remote(BACK);
    await card(tv, RECOMMENDED, "series:s2").click();
    await tv.page.locator('[data-view="item:series:s2"] [data-focus="more"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    assert.equal((await shownItems(tv)).at(-1), "Not Interested", "a series' More offers it too");
    await tv.remote(BACK);
    await tv.remote(BACK);
    catalog.sendsMark = false;
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await card(tv, RECOMMENDED, "movie:m0002").waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "Home reads answered");
    await afterPaint(tv);
    await card(tv, RECOMMENDED, "movie:m0002").click();
    await tv.page.locator('[data-view="item:movie:m0002"] [data-focus="more"]').waitFor();
    await tv.page.locator('[data-focus="more"]').click();
    assert.ok(!(await shownItems(tv)).includes("Not Interested"), "a server that predates the mark cannot be offered it");
}));

async function openPage(tv: Tv, id: string): Promise<void> {
    await card(tv, RECOMMENDED, id).click();
    await tv.page.locator(`[data-view="item:${id}"] [data-focus="more"]`).waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "the page's reads answered");
}
const choose = async (tv: Tv, label: string): Promise<void> => {
    await tv.page.locator('[data-focus="more"]').click();
    await tv.page.locator(".details-more-popover .browse-button", { hasText: label }).click();
};

test("marking from the page writes PUT, closes More, reads Show in Recommendations next, and Home drops the card and lands focus on the one that took its place", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0002");
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the write");
    assert.deepEqual(catalog.marks, ["PUT /not-interested/movie%3Am0002"]);
    assert.equal(await tv.page.locator(".details-more-popover").count(), 0, "More closes");
    assert.equal(await tv.page.locator('[data-focus="alert-ok"]').count(), 0, "no alert");
    await tv.eventually(async () => tv.pendingReplies === 0, "answers delivered");
    await tv.page.locator('[data-focus="more"]').click();
    assert.equal((await shownItems(tv)).at(-1), "Show in Recommendations", "the page now offers to clear it");
    await tv.remote(BACK);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.deepEqual(await ids(tv, RECOMMENDED), ["movie:m0004", "series:s2", "movie:m0006"], "the marked card left the recommendation row");
    assert.ok((await ids(tv, "recently_added")).includes("movie:m0002"), "a row of what is new keeps the title");
    await tv.eventually(async () => await tv.focused() === "movie:m0004", "Back lands on the card that took the removed one's place");
}));

test("clearing the mark from the page writes DELETE and removes nothing from Home", () => run(async tv => {
    const catalog = await start(tv);
    catalog.marked.add("movie:m0005");
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0005"]').click();
    await tv.page.locator('[data-view="item:movie:m0005"] [data-focus="more"]').waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "the page's reads answered");
    await choose(tv, "Show in Recommendations");
    await tv.eventually(async () => catalog.marks.length === 1, "the clear");
    assert.deepEqual(catalog.marks, ["DELETE /not-interested/movie%3Am0005"]);
    await tv.eventually(async () => tv.pendingReplies === 0, "answers delivered");
    await tv.page.locator('[data-focus="more"]').click();
    assert.equal((await shownItems(tv)).at(-1), "Not Interested", "the page reads the cleared state");
}));

test("a refused mark leaves the page offering Not Interested and Home's row whole, and shows the update-failed alert", () => run(async tv => {
    const catalog = await start(tv);
    catalog.markFailure = problem(500, "internal", "Server error");
    await openPage(tv, "movie:m0004");
    await choose(tv, "Not Interested");
    await tv.page.locator('[data-focus="alert-ok"]').waitFor();
    assert.match(await tv.page.locator("body").innerText(), /Couldn't Update Item/);
    await tv.page.locator('[data-focus="alert-ok"]').click();
    await tv.page.locator('[data-focus="more"]').click();
    assert.equal((await shownItems(tv)).at(-1), "Not Interested", "nothing changed on the page");
    await tv.remote(BACK);
    await tv.remote(BACK);
    assert.deepEqual(await ids(tv, RECOMMENDED), ["movie:m0002", "movie:m0004", "series:s2", "movie:m0006"], "Home's row is whole");
}));
