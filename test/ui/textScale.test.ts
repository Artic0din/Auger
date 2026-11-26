// Every text size on a screen is Apple's tvOS point size times --silo-sf-cap-scale (#749, after Details #399 and Person #418).
// Screens join this file as they are matched; Details and Person keep their own files.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCalendar } from "../native/support/fakeCalendar.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeRequests } from "../native/support/fakeRequests.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { problem, type CatalogRoutes, type Reply } from "../native/support/fakeSilo.ts";
import { selectLibraryMode } from "./support/library.ts";
import { ACTIVE, openChangeAccount, openSettingsAccounts, seedAccounts, withSignedInTv } from "./support/accounts.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const IME_DONE = 65376;
let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/**
 * Rendered text under `root` whose size is not a whole Apple point times the cap scale, as "classes size".
 * Left out: text hidden from sight (`.silo-sr-only`); avatar initials, which Apple sizes from the avatar
 * (`ProfileAvatarView.swift:51`, `size * 0.34`); and card badges, which Apple scales with the card's width
 * (`CardOverlays.swift:279`, the preset's points times width / 185); and the Settings subtitle preview, which Apple
 * draws at the player's subtitle size times 0.5 (`SubtitleAppearancePreview.swift:21,75`). None is a whole point. Text
 * clipped into a 1 px box is hidden from sight too, as Search hides its screen-reader title and label.
 */
function unscaledText(arg: string | readonly [root: string, roles?: readonly Role[]]): string[] {
    const [root, roles = []] = typeof arg === "string" ? [arg, [] as readonly Role[]] : arg;
    const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
    // A missing or broken scale would make every size look whole or none of them.
    if (!Number.isFinite(cap) || cap <= 0) throw new Error(`--silo-sf-cap-scale is not a positive number: ${String(cap)}`);
    const fractional = roles.filter(([, points]) => Math.abs(points - Math.round(points)) > 0.002);
    const found = new Set<string>();
    for (const node of document.querySelectorAll(`${root}, ${root} *`)) {
        if (node.getClientRects().length === 0 || node.closest(".silo-sr-only, .navigation-avatar-fallback, .card-overlay, .settings-subtitle-preview") !== null) continue;
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
        const matchedFractional = fractional.some(([selector, expected]) => node.matches(selector) && Math.abs(points - expected) <= 0.002);
        if (!matchedFractional && Math.abs(points - Math.round(points)) > 0.002) found.add(`${node.tagName.toLowerCase()}.${[...node.classList].join(".")} ${style.fontSize}`);
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

test("the profile menu uses Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        await signedIn(tv);
        await tv.page.locator('[data-focus="profiles"]').first().click();
        await tv.page.locator(".skyline-selector:not([hidden]) .skyline-profile-title").waitFor();
        assert.deepEqual(await tv.page.evaluate(unscaledText, ".skyline-selector"), []);
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
        await collect();
        await tv.page.locator('[data-focus="next-week"]').click();
        await tv.page.locator(".calendar-empty").waitFor();
        // Today shows only off the current week, so the next week measures it.
        await tv.page.locator('[data-focus="today"]').waitFor();
        await collect();
        calendar.calendarFailure = problem(503, "service_unavailable", "Unavailable");
        await tv.page.locator('[data-focus="empty:trending"]').click();
        await tv.page.locator(".calendar-failure").waitFor();
        await collect();
        assert.deepEqual([...found].sort(), []);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

/** Settings' text roles, paths under iosApp/iosApp/tvOS/Screens/Settings/ (silo-apple 449ba47). */
const SETTINGS_ROLES: readonly Role[] = [
    [".settings-categories .browse-title", 48, "700", "TVSettingsView.swift:185"],
    [".settings-version", 18, "400", "TVSettingsView.swift:202"],
    [".settings-profile-name", 27, "600", "TVSettingsView.swift:223"],
    [".settings-profile-account", 19, "400", "TVSettingsView.swift:226"],
    [".settings-category-title", 25, "500", "TVSettingsView.swift:253"],
    [".settings-category-detail", 16, "400", "TVSettingsView.swift:256"],
    [".settings-pane-header .browse-section-title", 42, "700", "TVSettingsView.swift:461"],
    [".settings-pane-header .settings-blurb", 20, "400", "TVSettingsView.swift:465"],
    [".settings-pane .settings-row-title", 26, "400", "TVSettingsComponents.swift:315"],
    [".settings-pane .browse-button:not([aria-checked=\"true\"]):not(.settings-learned-limit) .settings-row-value", 24, "400", "TVSettingsComponents.swift:319"],
    [".settings-pane .browse-button[role=\"switch\"][aria-checked=\"true\"] .settings-row-value", 24, "600", "TVSettingsComponents.swift:348"],
    [".settings-info-row", 26, "400", "TVSettingsComponents.swift:401"],
    [".settings-info-row .settings-row-value", 24, "400", "TVSettingsComponents.swift:405"],
    [".settings-section-header", 19, "600", "TVSettingsComponents.swift:436"],
    [".settings-pane .settings-value", 19, "400", "TVSettingsComponents.swift:453"],
];
// The connection-speed line (22 pt, TVPlaybackSettingsView.swift:146) shows only after a speed is measured, which this
// fixture never does; the whole-point check still covers it whenever it is drawn.

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
        const seen = new Set<string>();
        for (const pane of ["general", "playback", "subtitles", "server"]) {
            await tv.page.locator(`[data-focus="${pane}"]`).click();
            // The pane shown must be the one asked for, so every pane is really measured.
            await tv.page.locator(`.settings-pane[data-scroll-key="settings-pane:${pane}"]`).waitFor();
            await tv.jump(1000);
            assert.equal(await tv.page.locator(".settings-pane").getAttribute("data-scroll-key"), `settings-pane:${pane}`);
            for (const entry of await tv.page.evaluate(unscaledText, ".settings")) found.add(`${pane}: ${entry}`);
            const roles = await tv.page.evaluate(offRoles, SETTINGS_ROLES);
            for (const entry of roles.off) found.add(`${pane}: ${entry}`);
            for (const role of roles.seen) seen.add(role);
        }
        assert.deepEqual([...found].sort(), []);
        // Every role must be measured, so text drawn at size 0 or missing cannot pass.
        assert.deepEqual(SETTINGS_ROLES.map(([selector]) => selector).filter(selector => !seen.has(selector)), [], "every pinned role was on screen");
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


test("a Settings pane error uses Apple's warning footer size and weight", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        tv.fake.catalog = new FakeCatalog();
        new FakeSettings(tv.fake);
        const routes = tv.fake.catalog;
        assert.ok(routes !== undefined);
        await signedIn(tv, routes);
        // Home's startup settings reads must finish before the refusal is scripted, so none of them can take it
        // (the same wait as settings.test.ts's setup).
        await tv.eventually(async () => ["keys=ui.title_art", "keys=ui.card_overlays"].every(key => tv.fake.requests.some(request => request.path.startsWith("/settings/values/effective?") && request.path.includes(key))), "Home settings reads");
        // A refused contract read leaves the pane with its warning footer, as settings.test.ts raises it.
        tv.fake.script("/settings/contract/capabilities", problem(403, "permission_denied", "Denied"));
        await tv.page.locator('[data-focus="profiles"]').first().focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator(".settings-pane .browse-error.settings-warning").waitFor();
        const roles = await tv.page.evaluate(offRoles, [[".settings-pane .browse-error.settings-warning", 29, "500", "TVSettingsComponents.swift:474 (.body; HIG Body 29 pt medium)"]] as const);
        assert.deepEqual(roles, { off: [], seen: [".settings-pane .browse-error.settings-warning"] });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

/** Library Browse grid, panel, empty and failure roles, paths under iosApp/iosApp/ (silo-apple 198a3e9). */
const LIBRARY_BROWSE_ROLES: readonly Role[] = [
    [".browse-controls .browse-button", 24, "500", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:79"],
    [".library-browse .catalog-grid .browse-card-title", 24, "500", "tvOS/Screens/Components/TVMediaCard.swift:267; Theme/Typography.swift:22"],
    [".library-browse .catalog-grid .browse-card-subtitle", 20, "400", "tvOS/Screens/Components/TVMediaCard.swift:275; Theme/Typography.swift:25"],
    [".browse-sort-panel .browse-panel-row", 26, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:176"],
    [".browse-filter-panel .browse-panel-title", 34, "600", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:305"],
    [".browse-filter-panel [data-focus^=\"facet:\"]", 25, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:376"],
    [".browse-filter-panel [data-focus^=\"match:\"]", 23, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:391"],
    [".browse-filter-panel [data-focus=\"preserve\"]", 23, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:409"],
    [".browse-filter-panel [data-focus=\"reset\"]", 23, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:427"],
    [".browse-filter-panel .browse-panel-done", 25, "600", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:444"],
    [".browse-filter-panel [data-focus=\"facet-back\"]", 24, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:461"],
    [".browse-filter-panel [data-focus^=\"clear:\"]", 23, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:487"],
    [".browse-filter-panel [data-focus^=\"value:\"]", 24, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:507"],
    [".browse-empty-state .library-empty-title", 28, "600", "tvOS/Screens/Libraries/TVLibraryGridView.swift:275; Components/EmptyStateView.swift:16; Theme/Typography.swift:17"],
    [".browse-empty-actions .browse-button", 24, "500", "tvOS/Screens/Libraries/TVLibraryGridView.swift:286"],
    [".library-browse .details-failure .search-state-title", 36, "600", "tvOS/Screens/Libraries/TVLibraryGridView.swift:210; Components/ErrorView.swift:27; Theme/Typography.swift:14"],
    [".browse-filter-panel [data-focus^=\"facet:\"] .browse-panel-detail", 25, "400", "tvOS/Screens/Libraries/TVBrowseFilterUI.swift:367,376"],
    [".browse-alert .browse-alert-title", 34, "600", "Screens/Shuffle/ShuffleLauncher.swift:75"],
    [".browse-alert .browse-alert-message", 25, "400", "Screens/Shuffle/ShuffleLauncher.swift:84"],
    [".browse-alert .browse-button", 25, "600", "Screens/Shuffle/ShuffleLauncher.swift:81"],
    [".browse-empty-state .library-empty-body", 22, "400", "Components/EmptyStateView.swift:21; Theme/Typography.swift:31"],
    [".library-browse .details-failure .search-state-description", 26, "400", "tvOS/Screens/Libraries/TVLibraryGridView.swift:210; Components/ErrorView.swift:32; Theme/Typography.swift:28"],
    [".library-browse .details-failure .browse-button", 28, "600", "tvOS/Screens/Libraries/TVLibraryGridView.swift:210; Components/ErrorView.swift:40; Extensions/ViewExtensions.swift:416; Theme/Typography.swift:17"],
];

test("Library Browse grid, Sort, Filter, empty and failure states use Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new FakeCatalog();
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signedIn(tv, catalog);
        await tv.page.route("**/api/v2/shuffles/capabilities", route => route.fulfill({ json: { allowed: true, state: "available", scope_kinds: ["library"] } }));
        await tv.page.route("**/api/v2/shuffles", route => route.fulfill({ status: 404, contentType: "application/problem+json", json: problem(404, "not_found", "Missing shuffle scope").body }));
        await tv.page.locator('[data-focus="movies"]').first().click();
        await tv.page.locator('[data-view="library:12"] .home-section').first().waitFor();
        await selectLibraryMode(tv, "Browse");
        await tv.page.locator(".library-browse .catalog-grid .browse-card-title").first().waitFor();
        await tv.page.locator('.browse-controls [data-focus="shuffle"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "browse setup answered");
        await tv.page.evaluate(() => document.fonts.ready);

        const found = new Set<string>();
        const seen = new Set<string>();
        const collect = async (state: string): Promise<void> => {
            for (const entry of await tv.page.evaluate(unscaledText, "body")) found.add(`${state}: ${entry}`);
            const roles = await tv.page.evaluate(offRoles, LIBRARY_BROWSE_ROLES);
            for (const entry of roles.off) found.add(`${state}: ${entry}`);
            for (const role of roles.seen) seen.add(role);
        };

        await collect("grid");

        await tv.page.locator('.browse-controls [data-focus="shuffle"]').click();
        await tv.page.locator(".browse-alert .browse-alert-title").waitFor();
        await collect("shuffle-alert");
        await tv.remote(10009);
        await tv.page.locator(".browse-alert").waitFor({ state: "detached" });

        await tv.page.locator('[data-focus="sort"]').click();
        await tv.page.locator(".browse-sort-panel .browse-panel-row").first().waitFor();
        await collect("sort");
        await tv.remote(10009);
        await tv.page.locator(".browse-sort-panel").waitFor({ state: "detached" });

        await tv.page.locator('[data-focus="filter"]').click();
        await tv.page.locator('.browse-filter-panel [data-focus^="facet:"]').first().waitFor();
        await collect("filter-list");
        await tv.page.locator('.browse-filter-panel [data-focus^="facet:"]').first().click();
        await tv.page.locator('.browse-filter-panel [data-focus^="value:"]').first().waitFor();
        await tv.page.locator('.browse-filter-panel [data-focus^="value:"]').first().click();
        await tv.page.locator('.browse-filter-panel [data-focus^="clear:"]').waitFor();
        await collect("filter-values");
        await tv.remote(10009);
        await tv.page.locator('.browse-filter-panel [data-focus^="facet:"]').first().waitFor();
        await collect("filter-list-selected");
        await tv.remote(10009);
        await tv.page.locator(".browse-filter-panel").waitFor({ state: "detached" });
        await tv.eventually(async () => tv.pendingReplies === 0, "filter apply answered");

        const emptyPage = { status: 200, body: { window_cursor: "w", items: [], total: 0, total_exact: true, page: { has_more: false } } };
        catalog.failNext("/catalog/query", emptyPage);
        await tv.page.locator('[data-focus="letter:Q"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('.browse-empty-actions [data-focus="clear-filters"]').waitFor();
        await collect("no-filter-matches");
        await tv.eventually(async () => tv.pendingReplies === 0, "empty filter probe answered");

        catalog.failNext("/catalog/query", emptyPage);
        await tv.page.locator('.browse-empty-actions [data-focus="clear-filters"]').click();
        await tv.page.locator(".browse-empty-state .library-empty-body").waitFor();
        await collect("library-empty");
        await tv.eventually(async () => tv.pendingReplies === 0, "empty library answered");

        await tv.page.locator('[data-focus="series"]').first().click();
        await tv.page.locator('[data-view="library:13"] .home-section').first().waitFor();
        catalog.failNext("/catalog/query", problem(422, "validation_failed", "Browse unavailable"));
        await selectLibraryMode(tv, "Browse");
        await tv.page.locator(".library-browse .details-failure .search-state-title").waitFor();
        await collect("failure");

        assert.deepEqual([...found].sort(), []);
        assert.deepEqual(LIBRARY_BROWSE_ROLES.map(([selector]) => selector).filter(selector => !seen.has(selector)), [], "every pinned role was on screen");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

/** Requests hub, preview, detail, loading, empty and failure roles, paths under iosApp/iosApp/ (silo-apple 198a3e9). */
const REQUESTS_ROLES: readonly Role[] = [
    [".requests-loading-label", 20, "500", "tvOS/Screens/Requests/TVRequestsPage.swift:595"],
    [".requests-discover", 17, "700", "Screens/Requests/Components/RequestCardRail.swift:71,104"],
    [".requests-scene .requests-heading", 30, "600", "Screens/Requests/Components/RequestCardRail.swift:76,112"],
    [".requests-scene .requests-rail .browse-card-title", 28, "600", "Screens/Requests/Components/RequestMediaCard.swift:154; Theme/Typography.swift:17"],
    [".requests-scene .requests-rail .browse-card-subtitle", 22, "400", "Screens/Requests/Components/RequestMediaCard.swift:167; Screens/Requests/Components/RequestStatusViews.swift:57; Theme/Typography.swift:31"],
    [".requests-preview .requests-hero-title", 84, "800", "tvOS/Components/TVFocusMarquee.swift:1526; Theme/SiloTheme.swift:294"],
    [".requests-preview .requests-metadata", 20, "500", "tvOS/Components/TVFocusMarquee.swift:1583; Theme/SiloTheme.swift:296"],
    [".requests-preview .requests-tmdb span", 20, "700", "tvOS/Components/TVFocusMarquee.swift:1583; Theme/SiloTheme.swift:296"],
    [".requests-preview .requests-synopsis", 22, "400", "tvOS/Components/TVFocusMarquee.swift:1425; Theme/SiloTheme.swift:298"],
    [".requests-preview .requests-progress .requests-status-label", 22, "600", "tvOS/Components/TVFocusMarquee.swift:1452"],
    [".requests-list-notice", 22, "600", "tvOS/Screens/Requests/TVRequestsPage.swift:77"],
    [".requests-eyebrow", 18, "600", "tvOS/Screens/Detail/TVDetailHero.swift:678"],
    [".requests-detail-hero .requests-title-primary", 92, "900", "tvOS/Screens/Detail/TVDetailHero.swift:568"],
    [".requests-detail-hero .requests-title-secondary", 40, "800", "tvOS/Screens/Detail/TVDetailHero.swift:569"],
    [".requests-rating-chip", 18, "700", "tvOS/Screens/Detail/TVDetailHero.swift:449"],
    [".requests-detail-metadata", 24, "500", "tvOS/Screens/Detail/TVDetailHero.swift:394,475"],
    [".requests-detail-metadata .requests-tmdb span", 24, "700", "tvOS/Screens/Detail/TVDetailHero.swift:430"],
    [".requests-detail-hero .requests-synopsis", 26, "400", "tvOS/Screens/Detail/TVHeroSynopsis.swift:19"],
    [".requests-credit", 23, "400", "tvOS/Screens/Detail/TVDetailHero.swift:482"],
    [".requests-summary-label", 13, "700", "Screens/Requests/Detail/RequestDetailView.swift:362"],
    [".requests-summary-value", 22, "600", "Screens/Requests/Detail/RequestDetailView.swift:370"],
    [".requests-summary .requests-status-label", 22, "600", "Screens/Requests/Detail/RequestDetailView.swift:370"],
    [".requests-track-labels .requests-step", 18, "600", "Screens/Requests/Detail/RequestDetailView.swift:693"],
    [".requests-detail-actions .requests-primary-action", 28, "600", "Screens/Requests/Detail/RequestDetailView.swift:423"],
    [".requests-detail-actions .requests-secondary-action", 26, "600", "tvOS/Screens/Detail/TVDetailActions.swift:119"],
    [".requests-detail-actions .requests-action-message", 22, "400", "Screens/Requests/Detail/RequestDetailView.swift:317; Theme/Typography.swift:31"],
    [".requests-empty .search-state-title", 28, "600", "tvOS/Screens/Requests/TVRequestsPage.swift:130; Components/EmptyStateView.swift:16; Theme/Typography.swift:17"],
    [".requests-empty .search-state-description", 22, "400", "tvOS/Screens/Requests/TVRequestsPage.swift:130; Components/EmptyStateView.swift:21; Theme/Typography.swift:31"],
    [".requests-failure .search-state-title", 36, "600", "tvOS/Screens/Requests/TVRequestsPage.swift:124; Components/ErrorView.swift:27; Theme/Typography.swift:14"],
    [".requests-failure .search-state-description", 26, "400", "tvOS/Screens/Requests/TVRequestsPage.swift:124; Components/ErrorView.swift:32; Theme/Typography.swift:28"],
    [".requests-failure .browse-button:first-child", 28, "600", "tvOS/Screens/Requests/TVRequestsPage.swift:124; Components/ErrorView.swift:40; Extensions/ViewExtensions.swift:416; Theme/Typography.swift:17"],
    [".requests-failure .browse-button + .browse-button", 26, "400", "tvOS/Screens/Requests/TVRequestsPage.swift:124; Components/ErrorView.swift:40"],
    [".requests-card .browse-art-fallback", 22, "600", "Screens/Requests/Components/RequestMediaCard.swift:142-143; Theme/Typography.swift:31"],
    [".requests-scene > .browse-text", 22, "400", "Theme/Typography.swift:31 (Tizen detail recovery notice matches siloCaption)"],
    [".requests-scene > .browse-actions .browse-button", 28, "600", "Theme/Typography.swift:17 (Tizen detail recovery button matches siloSubheadline)"],
    [".card-actions-panel .browse-section-title", 28, "600", "Theme/Typography.swift:17 (RequestRecordMenu title matches siloSubheadline)"],
    [".card-actions-panel .browse-text", 22, "400", "Theme/Typography.swift:31 (RequestRecordMenu confirmation copy matches siloCaption)"],
    [".card-actions-buttons .browse-button", 28, "600", "Theme/Typography.swift:17 (RequestRecordMenu action button matches siloSubheadline)"],
];

test("Requests loading, hub, preview, detail, empty and failure states use Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const fake = new FakeRequests();
        fake.created = true;
        const baseTitle = fake.title.bind(fake);
        Object.assign(fake.record, { created_at: "2026-01-02T12:00:00Z", targets: [{ quality: "1080p", status: "queued" }] });
        fake.title = () => ({
            ...baseTitle(),
            title: "Dune: Part Three",
            year: 2026,
            runtime: 155,
            content_rating: "PG-13",
            vote_average: 7.5,
            genres: ["Sci-Fi", "Adventure"],
            director: "Denis Villeneuve",
            recommendations: [{ ...baseTitle(), tmdb_id: 950, title: "Related Title" }],
        });
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await signedIn(tv, fake);
        await tv.page.evaluate(() => document.fonts.ready);

        const found = new Set<string>();
        const seen = new Set<string>();
        const collect = async (state: string): Promise<void> => {
            for (const entry of await tv.page.evaluate(unscaledText, "body")) found.add(`${state}: ${entry}`);
            const roles = await tv.page.evaluate(offRoles, REQUESTS_ROLES);
            for (const entry of roles.off) found.add(`${state}: ${entry}`);
            for (const role of roles.seen) seen.add(role);
        };

        const openFromMenu = async (): Promise<void> => {
            await tv.page.locator('[data-focus="profiles"]').click();
            await tv.page.locator('[data-focus="requests"]').click();
        };
        const returnHome = async (): Promise<void> => {
            while (await tv.page.locator(".browse-nav").count() === 0) await tv.remote(10009);
            await tv.remote(10009);
            await tv.page.locator('[data-focus="home"]').click();
            await tv.page.locator('.browse[data-view="home"]').waitFor();
            await tv.eventually(async () => tv.pendingReplies === 0, "home settled");
        };

        const held = tv.fake.hold("/requests/discover", true);
        await openFromMenu();
        await tv.page.locator(".requests-loading-label").waitFor();
        await collect("loading");
        held.release();
        await tv.page.locator('[data-focus="request-one"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "requests hub settled");
        await collect("hub-own");

        await tv.page.locator('[data-focus="movie:949"]').focus();
        await tv.page.locator(".requests-preview .requests-tmdb span").waitFor();
        await collect("hub-discover");

        await tv.page.locator('[data-focus="request-one"]').click();
        await tv.page.locator(".requests-summary-label").first().waitFor();
        await tv.page.locator(".requests-credit").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "request detail settled");
        await collect("detail-request");

        fake.requestFailure = problem(422, "conflict", "Could not cancel request");
        await tv.page.locator('.requests-detail-actions [data-focus="cancel"]').click();
        await tv.page.locator(".requests-detail-actions .requests-action-message").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "action error settled");
        await collect("detail-action-error");
        fake.requestFailure = undefined;

        await tv.remote(10009);
        await tv.page.locator('[data-focus="request-one"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "hub restored");

        tv.fake.script("/requests/detail/movie/949", { status: 400, text: "bad" });
        await tv.page.locator('[data-focus="request-one"]').click();
        await tv.page.locator(".requests-scene > .browse-text").waitFor();
        await tv.page.locator('.requests-scene > .browse-actions [data-focus="refresh"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "detail metadata failure settled");
        await collect("detail-metadata-failure");

        await tv.remote(10009);
        await tv.page.locator('[data-focus="request-one"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "hub restored after metadata failure");

        fake.requestFailure = problem(422, "conflict", "Could not cancel request");
        await tv.page.locator('[data-focus="request-one"]').focus();
        await tv.down(13);
        await tv.jump(650);
        await tv.up(13);
        await tv.page.locator('[data-focus="cancel-request"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "hub menu settled");
        await collect("hub-menu");
        await tv.page.locator('[data-focus="cancel-request"]').click();
        await tv.page.locator(".requests-list-notice").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "hub cancel notice settled");
        await collect("hub-notice");
        fake.requestFailure = undefined;

        await tv.page.locator('[data-focus="request-one"]').focus();
        await tv.down(13);
        await tv.jump(650);
        await tv.up(13);
        await tv.page.locator('[data-focus="cancel-request"]').waitFor();
        await tv.page.locator('[data-focus="cancel-request"]').click();
        await tv.eventually(async () => await tv.focused() === "movie:949", "discover focused after cancel");
        await tv.eventually(async () => tv.pendingReplies === 0, "hub cancel settled");

        await tv.page.locator('[data-focus="movie:949"]').click();
        await tv.page.locator('.requests-detail-actions [data-focus="create"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "media detail settled");
        await collect("detail-media");

        await tv.remote(10009);
        await tv.page.locator(".requests-hub").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "hub restored after media");

        fake.requestFailure = problem(404, "not_found", "Hidden");
        await tv.page.locator('[data-focus="movie:949"]').click();
        await tv.page.locator(".requests-failure .browse-button + .browse-button").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "detail failure settled");
        await collect("detail-failure");
        fake.requestFailure = undefined;

        await returnHome();
        tv.fake.script("/requests/mine?limit=50", {
            status: 200,
            body: {
                items: [{
                    id: "failed-a",
                    media_type: "movie",
                    tmdb_id: 949,
                    title: "Heat",
                    overview: "A detective pursues a professional thief.",
                    requested_by_profile_id: "p-owner",
                    state: "failed",
                    status: "approved",
                    outcome: "failed",
                    targets: [{ quality: "1080p", status: "failed" }],
                }],
                page: { has_more: false },
            },
        });
        await openFromMenu();
        await tv.page.locator('[data-focus="failed-a"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "failed hub item settled");
        await tv.page.locator('[data-focus="failed-a"]').focus();
        await tv.down(13);
        await tv.jump(650);
        await tv.up(13);
        await tv.page.locator('[data-focus="remove-request"]').waitFor();
        await tv.page.locator('[data-focus="remove-request"]').click();
        await tv.page.locator(".card-actions-panel .browse-text").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "remove confirmation settled");
        await collect("hub-remove-confirm");
        await tv.page.locator('[data-focus="keep-request"]').click();
        await tv.eventually(async () => await tv.page.locator(".card-actions-panel").count() === 0, "remove confirmation dismissed");

        await returnHome();
        fake.requestsEmpty = true;
        fake.created = false;
        fake.cancelled = false;
        await openFromMenu();
        await tv.page.locator(".requests-empty .search-state-title").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "empty hub settled");
        await collect("hub-empty");

        await returnHome();
        fake.requestFailure = problem(422, "validation_failed", "Requests unavailable");
        await openFromMenu();
        await tv.page.locator(".requests-failure .search-state-title").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "failed hub settled");
        await collect("hub-failure");
        fake.requestFailure = undefined;

        assert.deepEqual([...found].sort(), []);
        assert.deepEqual(REQUESTS_ROLES.map(([selector]) => selector).filter(selector => !seen.has(selector)), [], "every pinned role was on screen");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

/** Change Account, Settings › Accounts, and their confirmation/alert dialogs, paths under iosApp/iosApp/. */
const ACCOUNTS_ROLES: readonly Role[] = [
    [".accounts-title", 88, "800", "tvOS/Screens/Auth/TVChangeAccountView.swift:110; DesignSystem/Marquee/MarqueeControls.swift:13"],
    [".accounts-screen > .signin-text", 28, "400", "tvOS/Screens/Auth/TVChangeAccountView.swift:114; DesignSystem/Marquee/MarqueeTV.swift:184,191; DesignSystem/Marquee/MarqueeControls.swift:14"],
    [".accounts-rail button", 25, "500", "tvOS/Screens/Auth/TVChangeAccountView.swift:164"],
    [".accounts-plus", 28, "400", "tvOS/Screens/Auth/TVChangeAccountView.swift:138"],
    [".account-initial", 34, "400", "tvOS/Screens/Auth/TVChangeAccountView.swift:388"],
    [".account-name", 34, "700", "tvOS/Screens/Auth/TVChangeAccountView.swift:392"],
    [".account-count", 23, "400", "tvOS/Screens/Auth/TVChangeAccountView.swift:397"],
    [".account-badge", 18, "600", "tvOS/Screens/Auth/TVChangeAccountView.swift:427"],
    [".accounts-settings h1", 42, "700", "tvOS/Screens/Settings/TVAccountsSettingsView.swift:97"],
    [".accounts-settings-header p", 20, "400", "tvOS/Screens/Settings/TVAccountsSettingsView.swift:100"],
    [".accounts-section-header", 19, "600", "tvOS/Screens/Settings/TVAccountsSettingsView.swift:119; tvOS/Screens/Settings/TVSettingsComponents.swift:436"],
    [".accounts-settings button", 26, "400", "tvOS/Screens/Settings/TVAccountsSettingsView.swift:156"],
    [".accounts-row-title", 26, "400", "tvOS/Screens/Settings/TVAccountsSettingsView.swift:156"],
    [".accounts-row-value", 24, "400", "tvOS/Screens/Settings/TVAccountsSettingsView.swift:161"],
    [".accounts-settings > p", 20, "400", "tvOS/Screens/Settings/TVAccountsSettingsView.swift:52"],
    [".skyline-confirm-title", 38, "600", "Components/AccountRemovalConfirmation.swift:31; tvOS/Screens/Settings/TVSettingsComponents.swift:508"],
    [".skyline-confirm-message", 22, "400", "Components/AccountRemovalConfirmation.swift:31; tvOS/Screens/Settings/TVSettingsComponents.swift:513"],
    [".confirm-dialog .skyline-confirm-actions button", 24, "600", "Components/AccountRemovalConfirmation.swift:31; tvOS/Screens/Settings/TVSettingsComponents.swift:524,533,546"],
    [".signin-alert-title", 32, "700", "tvOS system .alert title measured at 32pt bold"],
    [".signin-alert-text", 25, "400", "tvOS system .alert body measured at 25pt regular"],
    [".accounts-screen .signin-alert .signin-actions button", 30, "400", "tvOS system .alert action measured at 30pt regular"],
];

/** Who's watching, PIN entry, Create Profile, and profile error/loading screens, paths under iosApp/iosApp/. */
const PROFILES_ROLES: readonly Role[] = [
    [".profile-loading-message", 22, "400", "Screens/Profiles/ProfileSelectionView.swift:281; Components/LoadingView.swift:25; Theme/Typography.swift:31"],
    [".profile-picker-title", 64, "800", "Screens/Profiles/ProfileSelectionView.swift:369,716"],
    [".profile-account", 28, "400", "Screens/Profiles/ProfileSelectionView.swift:385; DesignSystem/Marquee/MarqueeControls.swift:14"],
    [".profile-picker .profile-name", 30, "600", "Screens/Profiles/ProfileTile.swift:33,101,304"],
    [".profile-remembered", 20, "400", "Screens/Profiles/ProfileTile.swift:34,108"],
    [".profile-child", 18, "800", "Screens/Profiles/ProfileTile.swift:38,202"],
    [".profile-add-circle", 66, "300", "Screens/Profiles/ProfileTile.swift:30,291"],
    [".profile-footer .signin-button", 24.65, "600", "Screens/Profiles/ProfileSelectionView.swift:427,442,450; DesignSystem/Marquee/MarqueeControls.swift:8,129-130"],
    [".signin-alert-title", 32, "700", "Screens/Profiles/ProfileSelectionView.swift tvOS .alert title measured at 32pt bold"],
    [".signin-alert-text", 25, "400", "Screens/Profiles/ProfileSelectionView.swift tvOS .alert body measured at 25pt regular"],
    [".profiles-flow .signin-alert .signin-button", 30, "600", "Screens/Profiles/ProfileSelectionView.swift tvOS .alert button"],
    [".pin-name", 38, "700", "Screens/Profiles/PINEntryView.swift:140,231"],
    [".pin-status", 26, "400", "Screens/Profiles/PINEntryView.swift:152,163,232"],
    [".pin-key-digit", 44, "400", "Screens/Profiles/PINEntryView.swift:301,329"],
    [".pin-key-letters", 12.32, "700", "Screens/Profiles/PINEntryView.swift:304,329"],
    [".profile-pin .pin-cancel:not(:focus)", 24.65, "500", "Screens/Profiles/PINEntryView.swift:115; DesignSystem/Marquee/MarqueeControls.swift:8,129-130"],
    [".profile-pin .pin-cancel:focus", 24.65, "600", "Screens/Profiles/PINEntryView.swift:115; DesignSystem/Marquee/MarqueeControls.swift:8,129-130"],
    [".profile-create-title", 48, "600", "Screens/Profiles/CreateProfileView.swift:184"],
    [".profile-create-subtitle", 20, "400", "Screens/Profiles/CreateProfileView.swift:188"],
    [".profile-create-header .signin-button", 18, "500", "Screens/Profiles/CreateProfileView.swift:197"],
    [".profile-create-preview .profile-name", 30, "600", "Screens/Profiles/ProfileTile.swift:33,101"],
    [".profile-create-preview-hint", 17, "400", "Screens/Profiles/CreateProfileView.swift:212"],
    [".profile-create-label", 13, "600", "Screens/Profiles/CreateProfileView.swift:333"],
    [".profile-create-section-heading .signin-button", 18, "500", "Screens/Profiles/CreateProfileView.swift:659"],
    [".profile-style-row .signin-button", 18, "500", "Screens/Profiles/CreateProfileView.swift:844,857"],
    [".profile-editor .signin-input", 26, "400", "Screens/Profiles/CreateProfileView.swift:267,278; Extensions/ViewExtensions.swift:575; Theme/Typography.swift:28"],
    [".profile-create-pin-hint", 16, "400", "Screens/Profiles/CreateProfileView.swift:288"],
    [".profile-create-switch .signin-button", 20, "500", "Screens/Profiles/CreateProfileView.swift:964,974"],
    [".profile-create-switch-detail", 16, "400", "Screens/Profiles/CreateProfileView.swift:965,977"],
    [".profile-create-controls > .signin-button", 20, "500", "Screens/Profiles/CreateProfileView.swift:563,964,974"],
    ['.profile-library-options .signin-button:not([data-focus="libraries-retry"])', 20, "500", "Screens/Profiles/CreateProfileView.swift:580,964,974"],
    [".profile-library-options .signin-text", 22, "400", "Screens/Profiles/CreateProfileView.swift:572; Theme/Typography.swift:31"],
    ['.profile-editor [data-focus="libraries-retry"]', 18, "500", "Screens/Profiles/CreateProfileView.swift:574"],
    [".profile-create-subheading", 22, "400", "Screens/Profiles/CreateProfileView.swift:568; Theme/Typography.swift:31"],
    [".profile-create-section > .signin-text", 15, "500", "Screens/Profiles/CreateProfileView.swift:630"],
    ['.profile-editor [data-focus="create-submit"]', 28, "600", "Screens/Profiles/CreateProfileView.swift:315; Extensions/ViewExtensions.swift:416; Theme/Typography.swift:17"],
    [".profile-error-state .search-state-title", 36, "600", "Screens/Profiles/ProfileSelectionView.swift:302; Components/ErrorView.swift:27; Theme/Typography.swift:14"],
    [".profile-error-state .search-state-description", 26, "400", "Screens/Profiles/ProfileSelectionView.swift:302; Components/ErrorView.swift:32; Theme/Typography.swift:28"],
    [".profile-error-main .signin-button:not(.profile-error-secondary)", 28, "600", "Screens/Profiles/ProfileSelectionView.swift:302; Components/ErrorView.swift:40; Extensions/ViewExtensions.swift:416; Theme/Typography.swift:17"],
    [".profile-error-main .profile-error-secondary", 26, "400", "Screens/Profiles/ProfileSelectionView.swift:302; Components/ErrorView.swift:48; Theme/Typography.swift:28"],
    [".profile-error-main .signin-title", 36, "600", "Screens/Profiles/ProfileSelectionView.swift:302; Components/ErrorView.swift:27; Theme/Typography.swift:14"],
    [".profile-error-main .signin-text", 26, "400", "Screens/Profiles/ProfileSelectionView.swift:302; Components/ErrorView.swift:32; Theme/Typography.swift:28"],
];

test("Change Account, Settings Accounts, and their dialogs use Apple's points times the cap scale", async () => {
    await withSignedInTv(browser, async tv => {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => document.fonts.ready);
        await tv.page.addStyleTag({ content: "* { font-family: SamsungOne; font-weight: 600; }" });
        await seedAccounts(tv, 9, [
            { id: "expired", baseUrl: ACTIVE, username: "expired", profileCount: 1, needsSignIn: true, lastUsedAt: 1 },
            { id: "x-other", baseUrl: "https://other.example.test", username: "other", profileCount: 2, needsSignIn: false, lastUsedAt: 5 },
        ]);

        const found = new Set<string>();
        const seen = new Set<string>();
        const collect = async (state: string): Promise<void> => {
            for (const entry of await tv.page.evaluate(unscaledText, ["body", ACCOUNTS_ROLES] as const)) found.add(`${state}: ${entry}`);
            const roles = await tv.page.evaluate(offRoles, ACCOUNTS_ROLES);
            for (const entry of roles.off) found.add(`${state}: ${entry}`);
            for (const role of roles.seen) seen.add(role);
        };

        await openChangeAccount(tv);
        await tv.page.locator('[data-focus="expired"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "change account settled");
        await collect("change-account");

        await tv.remote(10009);
        await tv.remote(10009);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "home settled");

        await openSettingsAccounts(tv);
        await tv.eventually(async () => tv.pendingReplies === 0, "accounts settings settled");
        await collect("accounts-settings");

        await tv.page.locator('[data-focus="expired"]').click();
        await tv.page.locator(".confirm-dialog").waitFor();
        await collect("accounts-expired");
        await tv.page.locator('[data-focus="cancel"]').click();

        await tv.page.locator('.accounts-settings [data-focus^="remove:"]').first().click();
        await tv.page.locator(".confirm-dialog .skyline-confirm-message").waitFor();
        await collect("accounts-confirm");

        await tv.page.evaluate(() => { window.appHarness.keyManager.failRemove = true; window.appHarness.storage.failSet = true; });
        await tv.page.locator('[data-focus="confirm"]').click();
        await tv.page.locator('[data-view="accounts-error"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "accounts error settled");
        await collect("accounts-error");
        await tv.page.locator('[data-focus="ok"]').click();
        await tv.page.evaluate(() => { window.appHarness.keyManager.failRemove = false; window.appHarness.storage.failSet = false; });

        assert.deepEqual([...found].sort(), []);
        assert.deepEqual(ACCOUNTS_ROLES.map(([selector]) => selector).filter(selector => !seen.has(selector)), [], "every pinned Accounts role was on screen");
    });
});

test("Who's watching, PIN entry, Create Profile, and profile states use Apple's points times the cap scale", async () => {
    const tv = await openTv(browser, { app: "application" });
    const catalog = new FakeCatalog();
    catalog.fileIds.set("movie:m0001", "42");
    tv.fake.catalog = catalog;
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
        await tv.page.locator('[data-screen="code"]').waitFor();
        const code = [...tv.fake.devices.keys()].pop();
        assert.ok(code !== undefined);
        tv.fake.approve(code);
        const held = tv.fake.hold("/profiles");
        await tv.jump(5000);
        await tv.page.locator('[data-screen="approved"], [data-screen="notice"], [data-screen="profiles-loading"]').waitFor();
        if (await tv.screen() === "approved") await tv.jump(1000);
        await tv.page.locator('[data-screen="notice"], [data-screen="profiles-loading"]').waitFor();
        if (await tv.screen() === "notice") await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
        await tv.page.locator(".profile-loading-message").waitFor();
        await tv.page.evaluate(() => document.fonts.ready);
        await tv.page.addStyleTag({ content: "* { font-family: SamsungOne; font-weight: 600; }" });

        const found = new Set<string>();
        const seen = new Set<string>();
        const collect = async (state: string): Promise<void> => {
            for (const entry of await tv.page.evaluate(unscaledText, ["body", PROFILES_ROLES] as const)) found.add(`${state}: ${entry}`);
            const roles = await tv.page.evaluate(offRoles, PROFILES_ROLES);
            for (const entry of roles.off) found.add(`${state}: ${entry}`);
            for (const role of roles.seen) seen.add(role);
        };

        await collect("profiles-loading");
        held.release();
        await tv.page.locator('[data-screen="profiles"] [data-focus="profile:p-owner"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "profiles picker settled");
        await collect("profiles-picker");

        await tv.page.locator('[data-focus="profile:p-owner"]').click();
        await tv.page.locator('[data-screen="remember-profile"] .signin-alert-text').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "remember offer settled");
        await collect("remember-offer");

        await tv.page.locator('[data-focus="remember"]').click();
        await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "home settled");
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="switch-profile"]').click();
        await tv.page.locator(".profile-remembered").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "remembered picker settled");
        await collect("profiles-remembered");

        await tv.page.locator('[data-focus="signout"]').click();
        await tv.page.locator('[data-screen="profiles:signout"] .confirm-dialog .skyline-confirm-message').waitFor();
        await collect("profiles-signout");
        await tv.page.locator('[data-focus="cancel-signout"]').click();
        await tv.page.locator('[data-screen="profiles"] [data-focus="profile:p-kid"]').waitFor();

        await tv.page.locator('[data-focus="profile:p-kid"]').click();
        await tv.page.locator('[data-screen="pin"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "pin entry settled");
        await collect("pin-entry");

        for (const digit of ["1", "1", "1", "1"]) await tv.page.locator(`[data-focus="${digit}"]`).click();
        await tv.page.locator(".pin-status-error").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "pin error settled");
        await collect("pin-error");
        await tv.page.locator('[data-focus="cancel"]').focus();
        await collect("pin-cancel-focus");
        await tv.page.locator('[data-focus="cancel"]').click();
        await tv.page.locator('[data-screen="profiles"] [data-focus="add-profile"]').waitFor();

        tv.fake.script("/user/libraries", { status: 500 });
        await tv.page.locator('[data-focus="add-profile"]').click();
        await tv.page.locator('[data-screen="profile-create"]').waitFor();
        await tv.page.fill("#create-profile-pin", "12");
        await tv.page.locator('[data-focus="create-child"]').click();
        await tv.page.locator('[data-focus="create-libraries"]').click();
        await tv.page.locator('[data-focus="libraries-retry"]').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "create profile failed libraries settled");
        await collect("profile-create-libraries-failed");

        await tv.page.locator('[data-focus="libraries-retry"]').click();
        await tv.page.locator(".profile-create-subheading").waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "create profile settled");
        await collect("profile-create");

        await tv.page.locator('[data-focus="style:initials"]').click();
        await tv.page.locator(".profile-create-section > .signin-text").waitFor();
        await collect("profile-create-initials");

        tv.fake.script("/profiles", { status: 500 });
        await tv.page.locator('[data-focus="create-header-cancel"]').click();
        await tv.page.locator('[data-screen="profiles-error"] .profile-error-state .search-state-title').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "profiles error settled");
        await collect("profiles-error");

        tv.fake.script("/profiles", { status: 401 }, { status: 401 });
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.locator('[data-screen="profiles-error"] .profile-error-main .profile-error-secondary').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "profiles 401 error settled");
        await collect("profiles-error-signin");

        tv.fake.script("/profiles", problem(403, "password_change_required", "Password change required"));
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.locator('[data-screen="profiles-error"] .profile-error-main .signin-title').waitFor();
        await tv.eventually(async () => tv.pendingReplies === 0, "profiles reset error settled");
        await collect("profiles-error-reset");

        assert.deepEqual([...found].sort(), []);
        assert.deepEqual(PROFILES_ROLES.map(([selector]) => selector).filter(selector => !seen.has(selector)), [], "every pinned Profiles role was on screen");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
