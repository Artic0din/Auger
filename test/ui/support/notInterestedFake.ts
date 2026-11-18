import assert from "node:assert/strict";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../../src/contracts/v2/settings.ts";
import { FakeDetails } from "../../native/support/fakeDetails.ts";
import { FakeSettings } from "../../native/support/fakeSettings.ts";
import type { Reply } from "../../native/support/fakeSilo.ts";
import { afterPaint, homeDetailsRead, openTv, type Tv } from "./tv.ts";

export const RECOMMENDED = "recommended_for_you";

/** Home rows carry `user_state.not_interested`; the server leaves a marked title out of the recommendation rows only, as it filters them. */
export class NotInterestedFake extends FakeDetails {
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
            // A row with an episode among TV titles draws wide cards (EpisodeThumbCard), whose menu has no Not Interested.
            { id: "recent_tv", sectionType: "recently_added", title: "Recently Added TV", items: ["series:s2", "episode:s1e12"] },
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
        const detail = /^\/catalog\/items\/([^/]+)$/.exec(url.pathname);
        if (method === "GET" && detail !== null && reply?.status === 200) {
            // A title page reads the mark from the item's own `user_state`.
            const id = decodeURIComponent(detail[1] ?? "");
            const record = reply.body as Record<string, unknown>;
            const state = { ...(record.user_state as Record<string, unknown> | undefined) };
            delete state.not_interested;
            return { status: 200, body: { ...record, user_state: { ...state, ...(this.sendsMark ? { not_interested: this.marked.has(id) } : {}) } } };
        }
        if (method !== "GET" || url.pathname !== "/home/sections" || reply?.status !== 200) return reply;
        const response = reply.body as { sections: { section_type: string; items: Record<string, unknown>[] }[] };
        return { status: 200, body: { ...response, sections: response.sections.map(section => ({ ...section, items: section.items
            .filter(card => !(section.section_type === RECOMMENDED && this.marked.has(String(card.content_id))))
            .map(card => ({ ...card, user_state: { ...(card.user_state as Record<string, unknown> | undefined), played: false, is_favorite: false, in_watchlist: false, ...(this.sendsMark ? { not_interested: this.marked.has(String(card.content_id)) } : {}) } })) })) } };
    }
}

export async function startHome(tv: Tv, language?: string): Promise<NotInterestedFake> {
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

export const card = (tv: Tv, section: string, id: string) => tv.page.locator(`[data-section="${section}"] [data-focus="${id}"]`);
export const menu = (tv: Tv) => tv.page.getByRole("menu");
export const rows = (tv: Tv) => menu(tv).getByRole("menuitem").evaluateAll(nodes => nodes.map(node => node.textContent ?? ""));
export const ids = (tv: Tv, section: string) => tv.page.locator(`[data-section="${section}"] .browse-card:not(.skyline-explore)`).evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));

export async function hold(tv: Tv, section: string, id: string): Promise<void> {
    await card(tv, section, id).focus();
    await tv.down(13);
    await tv.jump(650);
    await tv.up(13);
    await menu(tv).waitFor();
}

/** Opens the TV, runs the body, and holds that the page logged nothing. */
export async function runTv(browser: Browser, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    try { await body(tv); assert.deepEqual(tv.console, []); } finally { await tv.page.context().close(); }
}
