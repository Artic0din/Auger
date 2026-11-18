// A Home or library row of collections (silo-apple 6eea7cf7 TVCollectionsRow, TVSkylineSectionFeed): the row is drawn with the
// collection poster card at the title rows' poster size, has no Explore all card, keeps the focus handling of a title row,
// and opens a server collection in its library and a personal collection on its own page.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeHome } from "../native/support/fakeHome.ts";
import { afterPaint, homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const BACK = 10009;
const SERVER = { id: "c1", source: "library", title: "Franchises", poster_url: "", item_count: 6, library_id: "12" };
const PERSONAL = { id: "u1", source: "user", title: "Rainy day", poster_url: "", item_count: 1, creator_profile_id: "p-owner" };
const ROW = { id: "franchises", sectionType: "collection_posters", title: "Pick a franchise", items: [] as string[], collections: [SERVER, PERSONAL] };

async function open(catalog: FakeHome, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        tv.fake.catalog = catalog;
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
        await homeDetailsRead(tv);
        await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "Home answers delivered");
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

function withRow(libraryRows = false): FakeHome {
    const catalog = new FakeHome();
    const household = catalog.households.get("p-owner");
    assert.ok(household);
    household.sections.push({ ...ROW, collections: [...ROW.collections] });
    if (libraryRows) household.librarySections = [{ ...ROW, collections: [...ROW.collections] }, { id: "library-picks", sectionType: "recently_added", title: "Library Picks", items: ["movie:m0001", "movie:m0002"] }];
    return catalog;
}

test("Home draws a row of collections as poster cards with no Explore all card", () => open(withRow(), async tv => {
    const row = tv.page.locator('[data-view="home"] [data-section="franchises"]');
    await row.waitFor();
    assert.equal(await row.locator(".browse-section-title").innerText(), "Pick a franchise");
    assert.deepEqual(await row.locator(".browse-card").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["collection:library:c1", "collection:user:u1"]);
    assert.equal(await row.locator('[data-focus^="expand:"]').count(), 0, "a row of collections has no Explore all");
    assert.match(await row.locator('[data-focus="collection:library:c1"]').innerText(), /Franchises/);
    // Poster cards, the size of the title posters in the rows around them.
    const poster = await row.locator('[data-focus="collection:library:c1"] .browse-art').evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
    const title = await tv.page.locator('[data-section="recent/12"] .browse-art').first().evaluate(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
    assert.deepEqual(poster, title);
    // The card around the poster is the title card's footprint too, not the landscape collection tile (430 x 234 with padding).
    const box = (selector: string) => tv.page.locator(selector).first().evaluate(node => { const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height, padding: getComputedStyle(node).padding }; });
    const card = await box('[data-section="franchises"] [data-focus="collection:library:c1"]');
    const titleCard = await box('[data-section="recent/12"] .browse-card');
    assert.equal(card.width, titleCard.width, "the same card width as a title poster");
    assert.equal(card.padding, titleCard.padding, "the same card padding");
    assert.ok(card.height >= poster.height, `the card (${card.height}) holds its poster (${poster.height})`);
    // No poster: the stacked-cards symbol fills the poster, not a corner of it.
    const symbol = await tv.page.locator('[data-section="franchises"] [data-focus="collection:library:c1"] .collection-stack').evaluate(node => { const rect = node.getBoundingClientRect(); return { width: rect.width, height: rect.height }; });
    assert.deepEqual(symbol, poster);
}));

test("Home keeps the rows around a row of collections, and a row of collections the server left empty is not drawn", () => {
    const catalog = withRow();
    catalog.households.get("p-owner")?.sections.push({ id: "none", sectionType: "collection_posters", title: "Nothing here", items: [], collections: [] });
    return open(catalog, async tv => {
        assert.equal(await tv.page.locator('[data-view="home"] [data-section="none"]').count(), 0);
        assert.equal(await tv.page.locator('[data-view="home"] [data-section="recent/12"]').count(), 1);
    });
});

test("a server collection opens in its library and a personal collection opens on its own page, and Back returns to the card", () => open(withRow(), async tv => {
    await tv.page.locator('[data-focus="collection:library:c1"]').click();
    await tv.page.locator('[data-view^="results:12:"]').waitFor();
    assert.equal(await tv.page.locator(".browse-title").innerText(), "Franchises");
    const server = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).at(-1)?.body as Record<string, unknown>;
    assert.equal(server.source, "library_collection");
    assert.equal(server.collection_id, "c1");
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "collection:library:c1", "Back keeps the card");
    await tv.page.locator('[data-focus="collection:user:u1"]').click();
    await tv.page.locator(".browse-title", { hasText: "Rainy day" }).waitFor();
    const personal = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query")).at(-1)?.body as Record<string, unknown>;
    assert.equal(personal.source, "user_collection");
    assert.equal(personal.collection_id, "u1");
    assert.equal(personal.library_id, undefined, "a personal collection is read without a library");
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "collection:user:u1");
}));

test("a focused collection card previews itself in the Home hero and reads no title detail", () => open(withRow(), async tv => {
    const detailReads = (since: number): string[] => tv.fake.requests.slice(since).map(request => request.path).filter(path => path.startsWith("/catalog/items/"));
    const before = tv.fake.requests.length;
    await tv.page.locator('[data-focus="collection:library:c1"]').focus();
    await tv.eventually(async () => (await tv.page.locator(".skyline-title").first().innerText()) === "Franchises", "the hero names the focused collection");
    // A collection is no title: the hero reads no title detail for it (Apple builds its preview with no content id).
    await tv.jump(2000);
    await afterPaint(tv);
    await tv.eventually(async () => tv.pendingReplies === 0, "answers delivered");
    assert.deepEqual(detailReads(before), []);
    // The same wait does read a title's detail, so the check above can fail.
    const control = tv.fake.requests.length;
    await tv.page.locator('[data-section="recent/12"] .browse-card').nth(6).focus();
    await tv.jump(2000);
    await afterPaint(tv);
    await tv.eventually(async () => tv.pendingReplies === 0, "answers delivered");
    assert.equal(detailReads(control).length, 1, "a focused title reads its detail");
}));

test("a library page's Recommended shelves include a row of collections, in the server's order, with no Explore all card", () => open(withRow(true), async tv => {
    await tv.page.locator('[data-focus="movies"]').click();
    await tv.page.locator('[data-view="library:12"]').waitFor();
    await tv.page.locator('[data-section="library-picks"] .browse-card').first().waitFor();
    assert.deepEqual(await tv.page.locator(".skyline-content [data-section]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-section"))), ["franchises", "library-picks"]);
    assert.equal(await tv.page.locator('[data-section="franchises"] [data-focus^="expand:"]').count(), 0);
    await tv.page.locator('[data-focus="collection:library:c1"]').click();
    await tv.page.locator('[data-view^="results:12:"]').waitFor();
    await tv.remote(BACK);
    assert.equal(await tv.focused(), "collection:library:c1");
}));
