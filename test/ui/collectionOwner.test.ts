// The hero's meta line for a focused collection (silo-apple 6eea7cf7 TVSkylineSectionFeed.marqueeContent, CollectionOwnerName):
// its item count, then "by Name" for another profile's shared collection, named from the login's profile list. A server
// collection, the profile's own collection and an owner missing from the list have no by line; the hero has no synopsis.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const CARDS = [
    { id: "c1", source: "library", title: "Franchises", poster_url: "", item_count: 6, library_id: "12" },
    { id: "own", source: "user", title: "Mine", poster_url: "", item_count: 1, creator_profile_id: "p-owner" },
    { id: "kid", source: "user", title: "Kid's picks", poster_url: "", item_count: 3, creator_profile_id: "p-kid" },
    { id: "gone", source: "user", title: "Left the login", poster_url: "", item_count: 2, creator_profile_id: "p-gone" },
];

async function open(body: (tv: Tv) => Promise<void>, language?: string): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const catalog = new FakeHome();
        catalog.households.get("p-owner")?.sections.push({ id: "picks", sectionType: "collection_posters", title: "Picks", items: [], collections: CARDS });
        tv.fake.catalog = catalog;
        if (language !== undefined) {
            const settings = new FakeSettings(tv.fake);
            settings.revision = 28;
            settings.profile().set(APP_LANGUAGE_KEY, language);
        }
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-view="home"] [data-section="picks"]').waitFor();
        await homeDetailsRead(tv);
        await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "Home answers delivered");
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

const meta = (tv: Tv) => tv.page.locator(".skyline-marquee-layer .skyline-meta").first();
const focusCard = async (tv: Tv, key: string, title: string): Promise<void> => {
    await tv.page.locator(`[data-focus="collection:${key}"]`).focus();
    await tv.eventually(async () => (await tv.page.locator(".skyline-title").first().innerText()) === title, `the hero names ${title}`);
};
const profileReads = (tv: Tv): number => tv.fake.requests.filter(request => request.path.startsWith("/profiles")).length;

test("the hero's meta line reads a collection's item count and no synopsis, and another profile's shared collection adds by Name", () => open(async tv => {
    await focusCard(tv, "library:c1", "Franchises");
    assert.equal(await meta(tv).innerText(), "6 items");
    assert.equal(await tv.page.locator(".skyline-marquee-layer .skyline-synopsis").count(), 0, "Apple's collection preview has no synopsis");
    await focusCard(tv, "user:own", "Mine");
    assert.equal(await meta(tv).innerText(), "1 item", "the profile's own collection has no by line");
    await focusCard(tv, "user:kid", "Kid's picks");
    await tv.eventually(async () => (await meta(tv).innerText()) === "3 items · by Kid", "the by line names the owner once the profile list lands");
    const reads = profileReads(tv);
    await focusCard(tv, "user:gone", "Left the login");
    assert.equal(await meta(tv).innerText(), "2 items", "an owner missing from the list has no by line");
    await focusCard(tv, "user:kid", "Kid's picks");
    await focusCard(tv, "library:c1", "Franchises");
    assert.equal(profileReads(tv), reads, "the profile list is read once, not on each focus");
}));

test("the by line reads Apple's German string", () => open(async tv => {
    await focusCard(tv, "user:kid", "Kid's picks");
    await tv.eventually(async () => (await meta(tv).innerText()).includes(translate("collections.card.byOwner", { owner: "Kid" }, "de")), "German by line");
}, "de"));

test("a failed profile list leaves the by line off and the hero's item count in place", () => open(async tv => {
    await tv.page.route("**/api/v2/profiles**", route => route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Server error", status: 500 }) }));
    await tv.page.evaluate(() => { window.browseHarness.destroy(); window.browseHarness.mount(); });
    await tv.page.locator('[data-view="home"] [data-section="picks"]').waitFor();
    await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "Home answers delivered");
    await focusCard(tv, "user:kid", "Kid's picks");
    await tv.jump(5000);
    assert.ok(profileReads(tv) >= 1, "the list was tried");
    assert.equal(await meta(tv).innerText(), "3 items");
}));
