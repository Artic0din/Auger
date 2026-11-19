// Not interested on a Home card (silo-apple 29c0dd43 MediaStateMenuItems, NotInterestedMenuButton, HomeViewModel.removeNotInterested):
// a movie or series card from a server that sends the mark offers it after Watchlist, a mark leaves the recommendation and
// discovery rows at once, a clear keeps the card, and a refused write leaves everything as it was and shows the alert.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { card, hold, ids, menu, NotInterestedFake, RECOMMENDED, rows, runTv, startHome } from "./support/notInterestedFake.ts";
import { afterPaint, jumpUntil, launchBrowser, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const start = startHome;
const run = (body: (tv: Tv) => Promise<void>): Promise<void> => runTv(browser, body);

test("a movie or series card from a server that sends the mark offers Not Interested after Watchlist, and an episode or an older server does not", () => run(async tv => {
    const catalog = await start(tv);
    await hold(tv, RECOMMENDED, "movie:m0002");
    assert.deepEqual(await rows(tv), ["Mark as Watched", "Add to Favorites", "Add to Watchlist", "Not Interested"]);
    assert.equal(await menu(tv).locator(".card-menu-icon svg").count(), 4, "every action has its symbol");
    await tv.remote(10009);
    await hold(tv, RECOMMENDED, "series:s2");
    assert.equal((await rows(tv)).at(-1), "Not Interested");
    await tv.remote(10009);
    await hold(tv, "recently_added", "episode:s1e12");
    assert.deepEqual(await rows(tv), ["Mark as Watched", "Add to Favorites", "Add to Watchlist"], "only movies and series take the mark");
    await tv.remote(10009);
    catalog.sendsMark = false;
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await card(tv, RECOMMENDED, "movie:m0002").waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "Home reads answered");
    await afterPaint(tv);
    await hold(tv, RECOMMENDED, "movie:m0002");
    assert.deepEqual(await rows(tv), ["Mark as Watched", "Add to Favorites", "Add to Watchlist"], "a server that predates the mark cannot be offered it");
}));

test("a wide card (a still in a thumbnail row) offers no Not Interested, though the server sends the mark, while the same series on a poster card does", () => run(async tv => {
    await start(tv);
    assert.equal(await tv.page.locator('[data-section="recent_tv"] .skyline-continue:not(.skyline-explore)').count(), 2, "Recently Added TV draws wide cards");
    await hold(tv, "recent_tv", "series:s2");
    assert.deepEqual(await rows(tv), ["Mark as Watched", "Add to Favorites", "Add to Watchlist"], "EpisodeThumbCard's menu has no Not Interested row");
    await tv.remote(10009);
    await hold(tv, RECOMMENDED, "series:s2");
    assert.equal((await rows(tv)).at(-1), "Not Interested", "MediaCard's menu does");
}));

test("marking a title writes PUT /not-interested, takes it out of the recommendation row at once, keeps it in Recently Added, and lands focus on the card that took its place", () => run(async tv => {
    const catalog = await start(tv);
    await hold(tv, RECOMMENDED, "movie:m0002");
    // The reread the mark starts is held, so only the change itself can take the card out.
    const reread = tv.fake.hold("/home/sections", true);
    await menu(tv).getByRole("menuitem", { name: "Not Interested" }).click();
    assert.equal(await menu(tv).count(), 0, "a chosen row closes the menu");
    await tv.eventually(async () => !(await ids(tv, RECOMMENDED)).includes("movie:m0002"), "the marked card leaves the recommendation row before the reread answers");
    assert.deepEqual(catalog.marks, ["PUT /not-interested/movie%3Am0002"]);
    assert.deepEqual(await ids(tv, RECOMMENDED), ["movie:m0004", "series:s2", "movie:m0006"]);
    assert.ok((await ids(tv, "recently_added")).includes("movie:m0002"), "a row of what is new keeps the title");
    await tv.eventually(async () => await tv.focused() === "movie:m0004", "focus lands on the card that took its place");
    // The reread the change starts agrees: the server still leaves the title out of the recommendation row.
    reread.release();
    await jumpUntil(tv, 250, async () => tv.pendingReplies === 0, "Home reread answered");
    assert.deepEqual(await ids(tv, RECOMMENDED), ["movie:m0004", "series:s2", "movie:m0006"]);
}));

test("a marked title offers Show in Recommendations, and clearing it sends DELETE and keeps the card", () => run(async tv => {
    const catalog = await start(tv);
    catalog.marked.add("movie:m0005");
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await card(tv, "recently_added", "movie:m0005").waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "Home reads answered");
    await afterPaint(tv);
    await hold(tv, "recently_added", "movie:m0005");
    assert.equal((await rows(tv)).at(-1), "Show in Recommendations");
    await menu(tv).getByRole("menuitem", { name: "Show in Recommendations" }).click();
    await jumpUntil(tv, 250, async () => catalog.marks.length > 0, "the clear");
    assert.deepEqual(catalog.marks, ["DELETE /not-interested/movie%3Am0005"]);
    assert.ok((await ids(tv, "recently_added")).includes("movie:m0005"), "clearing removes no card");
    await tv.eventually(async () => tv.pendingReplies === 0, "Home reread answered");
    await hold(tv, "recently_added", "movie:m0005");
    assert.equal((await rows(tv)).at(-1), "Not Interested", "the menu reads the cleared state");
}));

test("a refused mark leaves the card in its row and shows the update-failed alert", () => run(async tv => {
    const catalog = await start(tv);
    catalog.markFailure = problem(500, "internal", "Server error");
    await hold(tv, RECOMMENDED, "movie:m0004");
    await menu(tv).getByRole("menuitem", { name: "Not Interested" }).click();
    await tv.page.getByRole("alertdialog").or(tv.page.getByRole("dialog")).first().waitFor();
    assert.deepEqual(await ids(tv, RECOMMENDED), ["movie:m0002", "movie:m0004", "series:s2", "movie:m0006"], "nothing changed locally");
}));

test("the menu entry reads Apple's German strings", () => run(async tv => {
    await start(tv, "de");
    await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(translate("topBar.forYou", undefined, "de")), "German top bar");
    await hold(tv, RECOMMENDED, "movie:m0002");
    assert.equal((await rows(tv)).at(-1), translate("cardMenu.notInterested", undefined, "de"));
    assert.notEqual(translate("cardMenu.notInterested", undefined, "de"), "Not Interested");
}));

test("on For You a mark takes the title out of every row at once", () => run(async tv => {
    const catalog = await start(tv);
    await tv.page.locator('[data-focus="for_you"]').click();
    await tv.page.locator('[data-view="for_you"] .browse-card').first().waitFor();
    await tv.eventually(async () => tv.pendingReplies === 0, "For You answered");
    await afterPaint(tv);
    const shown = (): Promise<(string | null)[]> => tv.page.locator('[data-view="for_you"] .browse-card:not(.skyline-explore)').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
    assert.equal((await shown()).filter(id => id === "movie:m0002").length, 2, "the title is in two rows");
    const holdCard = tv.page.locator('[data-view="for_you"] [data-focus="movie:m0002"]').first();
    await holdCard.focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
    await menu(tv).waitFor();
    assert.equal((await rows(tv)).at(-1), "Not Interested");
    const reread = tv.fake.hold("/recommendations/discover", true);
    await menu(tv).getByRole("menuitem", { name: "Not Interested" }).click();
    await tv.eventually(async () => !(await shown()).includes("movie:m0002"), "the title leaves every row before the reread answers");
    assert.deepEqual(catalog.marks, ["PUT /not-interested/movie%3Am0002"]);
    reread.release();
}));
