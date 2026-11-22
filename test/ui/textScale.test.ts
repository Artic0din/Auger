// Every text size on a screen is Apple's tvOS point size times --silo-sf-cap-scale (#749, after Details #399 and Person #418).
// Screens join this file as they are matched; Details and Person keep their own files.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCalendar } from "../native/support/fakeCalendar.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem, type CatalogRoutes, type Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const IME_DONE = 65376;
let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/**
 * Rendered text under `root` whose size is not a whole Apple point times the cap scale, as "classes size".
 * Left out: text hidden from sight (`.silo-sr-only`); avatar initials, which Apple sizes from the avatar
 * (`ProfileAvatarView.swift:51`, `size * 0.34`); and card badges, which Apple scales with the card's width
 * (`CardOverlays.swift:279`, the preset's points times width / 185), so neither is a whole point. Text clipped into a
 * 1 px box is hidden from sight too, as Search hides its screen-reader title and label.
 */
function unscaledText(root: string): string[] {
    const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
    // A missing or broken scale would make every size look whole or none of them.
    if (!Number.isFinite(cap) || cap <= 0) throw new Error(`--silo-sf-cap-scale is not a positive number: ${String(cap)}`);
    const found = new Set<string>();
    for (const node of document.querySelectorAll(`${root}, ${root} *`)) {
        if (node.getClientRects().length === 0 || node.closest(".silo-sr-only, .navigation-avatar-fallback, .card-overlay") !== null) continue;
        let clipped = false;
        for (let box: Element | null = node; box !== null && !clipped; box = box.parentElement) {
            const rect = box.getBoundingClientRect();
            clipped = rect.width <= 1 && rect.height <= 1;
        }
        if (clipped) continue;
        if (![...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() !== "")) continue;
        const style = getComputedStyle(node);
        if (style.fontFamily.includes("monospace") || style.visibility === "hidden") continue;
        const size = parseFloat(style.fontSize);
        if (size === 0) continue;
        const points = size / cap;
        if (Math.abs(points - Math.round(points)) > 0.002) found.add(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")} ${style.fontSize}`);
    }
    return [...found].sort();
}

/** A text role, the Apple point size and weight it must draw at, and where tvOS sets them (silo-apple 449ba47). */
type Role = readonly [selector: string, points: number, weight: string, source: string];

/** Visible text matching each role that is not at the role's points (times the cap scale) and weight; and the roles seen. */
function offRoles(roles: readonly Role[]): { off: string[]; seen: string[] } {
    const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
    if (!Number.isFinite(cap) || cap <= 0) throw new Error(`--silo-sf-cap-scale is not a positive number: ${String(cap)}`);
    const off: string[] = [];
    const seen: string[] = [];
    for (const [selector, points, weight] of roles) {
        for (const node of document.querySelectorAll(selector)) {
            if (node.getClientRects().length === 0) continue;
            if (!seen.includes(selector)) seen.push(selector);
            const style = getComputedStyle(node);
            const drawn = parseFloat(style.fontSize) / cap;
            if (Math.abs(drawn - points) > 0.01 || style.fontWeight !== weight) off.push(`${selector}: ${drawn.toFixed(2)} pt ${style.fontWeight}, not ${points} pt ${weight}`);
        }
    }
    return { off: [...new Set(off)].sort(), seen };
}

/** Home's and the tabs' text roles, paths under iosApp/iosApp/. */
const HOME_ROLES: readonly Role[] = [
    [".browse-nav .browse-button", 26, "600", "tvOS/Navigation/TVTopMenuBar.swift:535; Theme/SiloTheme.swift:203"],
    [".skyline-title", 84, "800", "tvOS/Components/TVFocusMarquee.swift:1521; Theme/SiloTheme.swift:294"],
    [".skyline-meta-lead", 20, "500", "tvOS/Components/TVFocusMarquee.swift:1578; Theme/SiloTheme.swift:296"],
    [".skyline-chip", 15, "600", "tvOS/Components/TVFocusMarquee.swift:1624; Theme/SiloTheme.swift:310"],
    [".skyline-synopsis", 22, "400", "tvOS/Components/TVFocusMarquee.swift:1420; Theme/SiloTheme.swift:298"],
    [".skyline-detail-text", 20, "500", "tvOS/Components/TVFocusMarquee.swift:1495; Theme/SiloTheme.swift:296"],
    [".home-section .browse-section-title", 36, "600", "Components/MediaRow.swift:438; Theme/Typography.swift:14"],
    [".home-section .browse-card-title", 24, "500", "tvOS/Screens/Components/TVMediaCard.swift:267; Theme/Typography.swift:22"],
    [".home-section .browse-card-subtitle", 20, "400", "tvOS/Screens/Components/TVMediaCard.swift:275; Theme/Typography.swift:25"],
    [".skyline-explore-label", 24, "500", "Components/SectionExploreAllCard.swift:61,97-99"],
];

/** Details' fixture with a populated For You feed, as topBar.test.ts serves it; the plain fixture answers 404. */
class ForYouCatalog extends FakeDetails {
    /** Answers the feed with no sections, for For You's empty page. */
    emptyFeed = false;
    override route(method: string, path: string, profile: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (path.startsWith("/recommendations/discover")) {
            if (this.emptyFeed) return { status: 200, body: { items: [] } };
            const card = super.route("GET", "/catalog/items/movie%3Am0001", profile)?.body;
            return { status: 200, body: { items: [
                { type: "popular", title: "Popular", kind: "popular", items: [card] },
                { type: "cluster", title: "For You", kind: "cluster", key: "0", items: [card] },
            ] } };
        }
        return super.route(method, path, profile, body);
    }
}

async function signedIn(tv: Tv, catalog: CatalogRoutes = new ForYouCatalog()): Promise<void> {
    tv.fake.catalog = catalog;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
}

test("Home and the Movies, Series and For You tabs use Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signedIn(tv);
        await tv.jump(2000);
        const seen = new Set<string>();
        const check = async (screen: string): Promise<void> => {
            assert.deepEqual(await tv.page.evaluate(unscaledText, "body"), [], screen);
            const roles = await tv.page.evaluate(offRoles, HOME_ROLES);
            assert.deepEqual(roles.off, [], screen);
            for (const role of roles.seen) seen.add(role);
        };
        await check("home");
        for (const [tab, view] of [["movies", "library:12"], ["series", "library:13"], ["for_you", "for_you"]] as const) {
            await tv.page.locator(`[data-focus="${tab}"]`).first().click();
            // Measure the tab's own content, not its loading page.
            await tv.page.locator(`.browse[data-view="${view}"] .browse-card`).first().waitFor();
            await tv.jump(3000);
            await check(tab);
        }
        assert.deepEqual(HOME_ROLES.map(([selector]) => selector).filter(selector => !seen.has(selector)), [], "every pinned role was on screen");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

/** For You's empty page is Apple's EmptyStateView (Screens/Recommendations/RecommendationsView.swift:186-190). */
const FOR_YOU_EMPTY_ROLES: readonly Role[] = [
    [".for-you-empty .search-state-title", 28, "600", "Components/EmptyStateView.swift:16; Theme/Typography.swift:17"],
    [".for-you-empty .search-state-description", 22, "400", "Components/EmptyStateView.swift:21; Theme/Typography.swift:31"],
];

test("For You's empty page uses Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new ForYouCatalog();
        catalog.emptyFeed = true;
        await signedIn(tv, catalog);
        await tv.page.locator('[data-focus="for_you"]').first().click();
        await tv.page.locator('[data-view="for_you"] .for-you-empty').waitFor();
        assert.deepEqual(await tv.page.evaluate(unscaledText, "body"), []);
        const roles = await tv.page.evaluate(offRoles, FOR_YOU_EMPTY_ROLES);
        assert.deepEqual(roles.off, []);
        assert.deepEqual(roles.seen, FOR_YOU_EMPTY_ROLES.map(([selector]) => selector));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

// The filter pills are Apple's native segmented Picker: SF UI Semibold 29 pt, measured on a 1080p tvOS 27 simulator (#749).
test("Search uses Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signedIn(tv);
        await tv.page.locator('[data-focus="search"]').first().click();
        await tv.page.fill("#browse-search", "Movie");
        // With the keyboard up the filters sit unfocused under the field; Apple keeps them at 29 pt (#749 probe).
        // The Samsung keyboard's top edge, as browse.test.ts raises it, puts Search in its keyboard-up layout.
        await tv.page.setViewportSize({ width: 1920, height: 568 });
        await tv.page.locator(".search-scene.search-keyboard-up .search-filters .browse-button").first().waitFor();
        assert.deepEqual(await tv.page.evaluate(unscaledText, ".search-filters"), [], "keyboard up");
        await tv.page.setViewportSize({ width: 1920, height: 1080 });
        await tv.page.locator(".search-scene:not(.search-keyboard-up)").waitFor();
        await tv.remote(IME_DONE);
        await tv.jump(3000);
        await tv.page.locator('[data-view="search"] .browse-card').first().waitFor();
        assert.deepEqual(await tv.page.evaluate(unscaledText, "body"), []);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Calendar's week, cards, empty week and failure use Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const calendar = new FakeCalendar();
        // The fixture's week is laid out in Melbourne time, as calendar.test.ts runs it.
        const cdp = await tv.page.context().newCDPSession(tv.page);
        await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "Australia/Melbourne" });
        await signedIn(tv, calendar);
        const found = new Set<string>();
        const collect = async (): Promise<void> => { for (const entry of await tv.page.evaluate(unscaledText, ".browse")) found.add(entry); };
        await tv.page.locator('[data-focus="calendar"]').first().click();
        await tv.page.locator(".calendar-event").first().waitFor();
        await tv.page.locator('[data-focus="today"]').waitFor().catch(() => undefined);
        await collect();
        await tv.page.locator('[data-focus="next-week"]').click();
        await tv.page.locator(".calendar-empty").waitFor();
        await collect();
        calendar.calendarFailure = problem(503, "service_unavailable", "Unavailable");
        await tv.page.locator('[data-focus="empty:trending"]').click();
        await tv.page.locator(".calendar-failure").waitFor();
        await collect();
        assert.deepEqual([...found].sort(), []);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
