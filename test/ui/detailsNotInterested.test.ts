// Not interested on a title page (silo-apple 29c0dd43 TVMovieDetailView and TVSeriesDetailView More menu, ItemDetailViewModel.toggleNotInterested):
// a movie or series page from a server that sends the mark offers it in More after Find Trailers, a new mark leaves Home's
// recommendation rows and lands focus on the card that took its place when Back returns, a clear keeps everything, and a
// refused write leaves the page and Home as they were and shows the update-failed alert.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { problem } from "../native/support/fakeSilo.ts";
import { afterPaint, launchBrowser, type Tv } from "./support/tv.ts";
import { card, hold, ids, menu, RECOMMENDED, rows, runTv, startHome } from "./support/notInterestedFake.ts";

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

test("a write the page is covered during still finishes: Home drops the card, and the page offers the clear when it is shown again", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0002");
    await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
    const answer = tv.fake.hold("/not-interested/movie%3Am0002", true);
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the write is out");
    // Another title opens over the page before the answer arrives, and the answer lands while it covers.
    const related = tv.page.locator('[data-detail-section="related"] .browse-card:not([data-focus="movie:m0002"])').first();
    await related.focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-view^="item:"]:not([data-view="item:movie:m0002"])').waitFor();
    answer.release();
    // A hold's count drops a moment after the release, so wait for nothing to be on its way, then for the page to take the answer in.
    await tv.eventually(async () => tv.pendingReplies === 0, "the answer delivered");
    await afterPaint(tv);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="item:movie:m0002"] [data-focus="more"]').waitFor();
    // The page re-reads when it is shown again; a late answer redraws it and would close the menu.
    await tv.eventually(async () => tv.pendingReplies === 0, "the page's re-read delivered");
    await afterPaint(tv);
    await tv.page.locator('[data-focus="more"]').click();
    const item = tv.page.locator('.details-more-popover [data-focus="not-interested"]');
    assert.equal((await item.innerText()).trim(), "Show in Recommendations");
    assert.notEqual(await item.getAttribute("aria-disabled"), "true", "the action is not left disabled by the interrupted write");
    await item.click();
    await tv.eventually(async () => catalog.marks.length === 2, "the clear is sent");
    assert.equal(catalog.marks[1], "DELETE /not-interested/movie%3Am0002");
}));

test("Home's retained cards read the new mark after a change from the page, so the card menu offers the other action", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0002");
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the mark");
    await tv.remote(BACK);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "the write's answer delivered");
    const reread = tv.fake.hold("/home/sections", true);
    await card(tv, "recently_added", "movie:m0002").focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
    await tv.page.getByRole("menu").waitFor();
    const rows = await tv.page.getByRole("menu").getByRole("menuitem").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""));
    assert.equal(rows.at(-1), "Show in Recommendations", "the retained card offers the clear, not a second mark");
    reread.release();
}));

test("clearing a mark from the page leaves Home's retained card offering Not Interested again", () => run(async tv => {
    const catalog = await start(tv);
    catalog.marked.add("movie:m0005");
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0005"]').click();
    await tv.page.locator('[data-view="item:movie:m0005"] [data-focus="more"]').waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "the page's reads answered");
    await choose(tv, "Show in Recommendations");
    await tv.eventually(async () => catalog.marks.length === 1, "the clear");
    await tv.eventually(async () => tv.pendingReplies === 0, "answers delivered");
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "the write's answer delivered");
    const reread = tv.fake.hold("/home/sections", true);
    await card(tv, "recently_added", "movie:m0005").focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
    await tv.page.getByRole("menu").waitFor();
    const rows = await tv.page.getByRole("menu").getByRole("menuitem").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""));
    assert.equal(rows.at(-1), "Not Interested", "the retained card reads the cleared state");
    reread.release();
}));

test("a mark whose answer is delayed is still pending when the title is reopened, so no clear is sent over it", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0002");
    const answer = tv.fake.hold("/not-interested/movie%3Am0002", true);
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the write reaches the server");
    // Back to Home and the same title again: a new owner for the page, while the first answer is still out.
    await tv.remote(BACK);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    await card(tv, "recently_added", "movie:m0002").click();
    await tv.page.locator('[data-view="item:movie:m0002"] [data-focus="more"]').waitFor();
    await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "the page's reads answered");
    await tv.page.locator('[data-focus="more"]').click();
    const item = tv.page.locator('.details-more-popover [data-focus="not-interested"]');
    assert.equal(await item.getAttribute("aria-disabled"), "true", "the action waits for the write that is still out");
    assert.equal((await item.innerText()).trim(), "Show in Recommendations", "and reads the state that write will leave");
    await item.click({ force: true });
    assert.deepEqual(catalog.marks, ["PUT /not-interested/movie%3Am0002"], "no clear is sent over it");
    answer.release();
    await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "the answer delivered");
    // The write has settled: the page offers the clear, and sending it now is allowed.
    await tv.page.locator('[data-focus="more"]').click();
    const settled = tv.page.locator('.details-more-popover [data-focus="not-interested"]');
    await tv.eventually(async () => (await settled.getAttribute("aria-disabled")) !== "true", "the action is free once the write settles");
    assert.equal((await settled.innerText()).trim(), "Show in Recommendations");
}));

// One per-title store serves the card menu and the page: the write out, the last confirmed value, and what a later read says.
const settle = (tv: Tv): Promise<void> => tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "answers delivered");
async function homeAgain(tv: Tv): Promise<void> {
    await tv.remote(BACK);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    await settle(tv);
}
async function openMovieMore(tv: Tv, section: string, id: string): Promise<string> {
    await card(tv, section, id).click();
    await tv.page.locator(`[data-view="item:${id}"] [data-focus="more"]`).waitFor();
    await settle(tv);
    await tv.page.locator('[data-focus="more"]').click();
    return (await tv.page.locator('.details-more-popover [data-focus="not-interested"]').innerText()).trim();
}

test("a mark made on the page and cleared in the card menu reads as cleared when the page is opened again", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0002");
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the mark");
    await settle(tv);
    await homeAgain(tv);
    // Home may still be drawing again from the stale read the return started; open the menu again until its row is live.
    for (let attempt = 0; attempt < 6 && catalog.marks.length < 2; attempt++) {
        await settle(tv);
        await hold(tv, "recently_added", "movie:m0002");
        const row = menu(tv).getByRole("menuitem", { name: "Show in Recommendations" });
        if (await row.count() === 1 && (await row.getAttribute("aria-disabled")) !== "true") await row.click({ timeout: 2000 }).catch(() => undefined);
        if (catalog.marks.length < 2 && await menu(tv).count() > 0) await tv.remote(BACK);
    }
    await tv.eventually(async () => catalog.marks.length === 2, "the clear from the card menu");
    assert.equal(catalog.marks[1], "DELETE /not-interested/movie%3Am0002");
    await settle(tv);
    assert.equal(await openMovieMore(tv, "recently_added", "movie:m0002"), "Not Interested", "a fresh read of the cleared title wins over the page's earlier mark");
}));

test("a mark from the page still out blocks the card menu's change for that title, and the menu offers the clear once it is answered", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0002");
    const answer = tv.fake.hold("/not-interested/movie%3Am0002", true);
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the write is out");
    await homeAgain(tv);
    await hold(tv, "recently_added", "movie:m0002");
    const item = menu(tv).getByRole("menuitem").last();
    assert.equal((await item.innerText()).trim(), "Show in Recommendations", "the menu reads the state the write will leave");
    await item.click({ force: true });
    await tv.page.waitForTimeout(100);
    assert.deepEqual(catalog.marks, ["PUT /not-interested/movie%3Am0002"], "no clear is sent over the write still out");
    if (await menu(tv).count() > 0) await tv.remote(BACK);
    answer.release();
    await settle(tv);
    await hold(tv, "recently_added", "movie:m0002");
    assert.equal((await rows(tv)).at(-1), "Show in Recommendations");
    await menu(tv).getByRole("menuitem", { name: "Show in Recommendations" }).click();
    await tv.eventually(async () => catalog.marks.length === 2, "the clear is sent once the mark is answered");
}));

test("a mark from the card menu still out is the page's pending write too: the page reads the state it will leave, waits, and sends nothing", () => run(async tv => {
    const catalog = await start(tv);
    const answer = tv.fake.hold("/not-interested/movie%3Am0002", true);
    await hold(tv, "recently_added", "movie:m0002");
    await menu(tv).getByRole("menuitem", { name: "Not Interested" }).click();
    await tv.eventually(async () => catalog.marks.length === 1, "the write is out");
    await card(tv, "recently_added", "movie:m0002").click();
    await tv.page.locator('[data-view="item:movie:m0002"] [data-focus="more"]').waitFor();
    await settle(tv);
    await tv.page.locator('[data-focus="more"]').click();
    const item = tv.page.locator('.details-more-popover [data-focus="not-interested"]');
    assert.equal((await item.innerText()).trim(), "Show in Recommendations");
    assert.equal(await item.getAttribute("aria-disabled"), "true", "the page waits for the card menu's write");
    await item.click({ force: true });
    assert.deepEqual(catalog.marks, ["PUT /not-interested/movie%3Am0002"], "nothing is sent over it");
    answer.release();
    await settle(tv);
}));

test("a card menu open while the page's write settles is redrawn: its row is enabled again and reads the state the write left", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0002");
    const answer = tv.fake.hold("/not-interested/movie%3Am0002", true);
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the write is out");
    await homeAgain(tv);
    await hold(tv, "recently_added", "movie:m0002");
    const row = menu(tv).getByRole("menuitem", { name: "Show in Recommendations" });
    assert.equal(await row.getAttribute("aria-disabled"), "true", "the row waits while the write is out");
    answer.release();
    await tv.eventually(async () => (await menu(tv).getByRole("menuitem").last().getAttribute("aria-disabled")) !== "true", "the open menu is redrawn when the write settles");
    assert.equal((await menu(tv).getByRole("menuitem").last().innerText()).trim(), "Show in Recommendations");
}));

test("a card menu open while the page's write fails shows the state before it and is enabled again", () => run(async tv => {
    const catalog = await start(tv);
    await openPage(tv, "movie:m0004");
    const answer = tv.fake.hold("/not-interested/movie%3Am0004", true);
    catalog.markFailure = problem(500, "internal", "Server error");
    await choose(tv, "Not Interested");
    await tv.eventually(async () => catalog.marks.length === 1, "the write is out");
    await homeAgain(tv);
    await hold(tv, RECOMMENDED, "movie:m0004");
    assert.equal((await menu(tv).getByRole("menuitem").last().innerText()).trim(), "Show in Recommendations", "optimistic while out");
    answer.release();
    await tv.eventually(async () => (await menu(tv).getByRole("menuitem").last().innerText()).trim() === "Not Interested", "the refused write puts the label back");
    assert.notEqual(await menu(tv).getByRole("menuitem").last().getAttribute("aria-disabled"), "true");
}));
