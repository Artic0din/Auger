// Every text size on a screen is Apple's tvOS point size times --silo-sf-cap-scale (#749, after Details #399 and Person #418).
// Screens join this file as they are matched; Details and Person keep their own files.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import type { CatalogRoutes, Reply } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/**
 * Rendered text under `root` whose size is not a whole Apple point times the cap scale, as "classes size".
 * Left out: text hidden from sight (`.silo-sr-only`); avatar initials, which Apple sizes from the avatar
 * (`ProfileAvatarView.swift:51`, `size * 0.34`); and card badges, which Apple scales with the card's width
 * (`CardOverlays.swift:279`, the preset's points times width / 185); and the Settings subtitle preview, which Apple
 * draws at the player's subtitle size times 0.5 (`SubtitleAppearancePreview.swift:21,75`). None is a whole point.
 */
function unscaledText(root: string): string[] {
    const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
    // A missing or broken scale would make every size look whole or none of them.
    if (!Number.isFinite(cap) || cap <= 0) throw new Error(`--silo-sf-cap-scale is not a positive number: ${String(cap)}`);
    const found = new Set<string>();
    for (const node of document.querySelectorAll(`${root}, ${root} *`)) {
        if (node.getClientRects().length === 0 || node.closest(".silo-sr-only, .navigation-avatar-fallback, .card-overlay, .settings-subtitle-preview") !== null) continue;
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

test("Settings' rail and General, Playback, Subtitles and Server panes use Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        // As settings.test.ts does: the settings contract wraps the plain catalog before sign-in.
        tv.fake.catalog = new FakeCatalog();
        const settings = new FakeSettings(tv.fake);
        // Every row the client can show, so no pane falls back to its empty message.
        settings.profileSubtitles = true;
        settings.remainingRows = true;
        settings.bufferingRows = true;
        const routes = tv.fake.catalog;
        assert.ok(routes !== undefined);
        await signedIn(tv, routes);
        await tv.page.locator('[data-focus="profiles"]').first().focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
        const found = new Set<string>();
        for (const pane of ["general", "playback", "subtitles", "server"]) {
            await tv.page.locator(`[data-focus="${pane}"]`).click();
            await tv.jump(1000);
            for (const entry of await tv.page.evaluate(unscaledText, ".settings")) found.add(`${pane}: ${entry}`);
        }
        assert.deepEqual([...found].sort(), []);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Settings' empty category message takes the pane footer's size", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        // Without the subtitle rows the fixture leaves out, the Subtitles pane shows the Tizen-only empty message.
        tv.fake.catalog = new FakeCatalog();
        new FakeSettings(tv.fake);
        const routes = tv.fake.catalog;
        assert.ok(routes !== undefined);
        await signedIn(tv, routes);
        await tv.page.locator('[data-focus="profiles"]').first().focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.locator(".settings-pane .settings-empty").waitFor();
        assert.deepEqual(await tv.page.evaluate(unscaledText, ".settings"), []);
        const roles = await tv.page.evaluate(offRoles, [[".settings-pane .settings-empty", 19, "400", "tvOS/Screens/Settings/TVSettingsComponents.swift:453 (nearest Apple style)"]] as const);
        assert.deepEqual(roles, { off: [], seen: [".settings-pane .settings-empty"] });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
