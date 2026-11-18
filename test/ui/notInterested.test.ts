// Not interested on a Home card (silo-apple 29c0dd43 MediaStateMenuItems, NotInterestedMenuButton, HomeViewModel.removeNotInterested):
// a movie or series card from a server that sends the mark offers it after Watchlist, a mark leaves the recommendation and
// discovery rows at once, a clear keeps the card, and a refused write leaves everything as it was and shows the alert.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { problem, type Reply } from "../native/support/fakeSilo.ts";
import { afterPaint, homeDetailsRead, jumpUntil, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const RECOMMENDED = "recommended_for_you";

/** Home rows carry `user_state.not_interested`; the server leaves a marked title out of the recommendation rows only, as it filters them. */
class NotInterestedFake extends FakeDetails {
    readonly marks: string[] = [];
    readonly marked = new Set<string>();
    sendsMark = true;
    markFailure: Reply | undefined;

    constructor() {
        super();
        const home = this.households.get("p-owner");
        assert.ok(home);
        home.sections = [
            { id: RECOMMENDED, sectionType: RECOMMENDED, title: "Recommended for You", items: ["movie:m0002", "movie:m0004", "series:s2", "movie:m0006"] },
            { id: "recently_added", sectionType: "recently_added", title: "Recently Added", items: ["movie:m0002", "movie:m0005", "episode:s1e12"] },
        ];
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://example.test");
        const mark = /^\/not-interested\/([^/]+)$/.exec(url.pathname);
        if (mark !== null && (method === "PUT" || method === "DELETE")) {
            const id = decodeURIComponent(mark[1] ?? "");
            this.marks.push(`${method} ${url.pathname}`);
            if (this.markFailure !== undefined) { const failure = this.markFailure; this.markFailure = undefined; return failure; }
            if (method === "PUT") this.marked.add(id); else this.marked.delete(id);
            return { status: 204 };
        }
        if (method === "GET" && url.pathname === "/recommendations/discover") {
            // For You's rows are all recommendation lists: the server leaves a marked title out of each.
            const home = super.route("GET", "/home/sections", profileId);
            const sections = (home?.body as { sections: { section_type: string; title: string; items: Record<string, unknown>[] }[] }).sections;
            return { status: 200, body: { items: sections.map(section => ({ type: section.section_type, title: section.title, kind: "for-you-main", items: section.items
                .filter(card => !this.marked.has(String(card.content_id)))
                .map(card => ({ ...card, user_state: { played: false, is_favorite: false, in_watchlist: false, not_interested: false } })) })) } };
        }
        const reply = super.route(method, path, profileId, body);
        if (method !== "GET" || url.pathname !== "/home/sections" || reply?.status !== 200) return reply;
        const response = reply.body as { sections: { section_type: string; items: Record<string, unknown>[] }[] };
        return { status: 200, body: { ...response, sections: response.sections.map(section => ({ ...section, items: section.items
            .filter(card => !(section.section_type === RECOMMENDED && this.marked.has(String(card.content_id))))
            .map(card => ({ ...card, user_state: { ...(card.user_state as Record<string, unknown> | undefined), played: false, is_favorite: false, in_watchlist: false, ...(this.sendsMark ? { not_interested: this.marked.has(String(card.content_id)) } : {}) } })) })) } };
    }
}

async function start(tv: Tv, language?: string): Promise<NotInterestedFake> {
    const catalog = new NotInterestedFake();
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
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator(`[data-section="${RECOMMENDED}"] .browse-card`).first().waitFor();
    await homeDetailsRead(tv);
    await tv.eventually(async () => tv.pendingReplies === 0, "Home reads answered");
    await afterPaint(tv);
    return catalog;
}

const card = (tv: Tv, section: string, id: string) => tv.page.locator(`[data-section="${section}"] [data-focus="${id}"]`);
const menu = (tv: Tv) => tv.page.getByRole("menu");
const rows = (tv: Tv) => menu(tv).getByRole("menuitem").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""));
const ids = (tv: Tv, section: string) => tv.page.locator(`[data-section="${section}"] .browse-card:not(.skyline-explore)`).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));

async function hold(tv: Tv, section: string, id: string): Promise<void> {
    await card(tv, section, id).focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
    await menu(tv).waitFor();
}

async function run(body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    try { await body(tv); assert.deepEqual(tv.console, []); } finally { await tv.page.context().close(); }
}

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
