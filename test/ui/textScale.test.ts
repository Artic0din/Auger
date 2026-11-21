// Every text size on a screen is Apple's tvOS point size times --silo-sf-cap-scale (#749, after Details #399 and Person #418).
// Screens join this file as they are matched; Details and Person keep their own files.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import type { CatalogRoutes } from "../native/support/fakeSilo.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

/**
 * Rendered text under `root` whose size is not a whole Apple point times the cap scale, as "classes size".
 * Left out: text hidden from sight (`.silo-sr-only`), and avatar initials, which Apple sizes from the avatar
 * (`ProfileAvatarView.swift:51`, `size * 0.34`), not from a point size, and the Settings subtitle preview, which Apple
 * draws at the player's subtitle size times 0.5 (`SubtitleAppearancePreview.swift:21,75`).
 */
function unscaledText(root: string): string[] {
    const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
    const found = new Set<string>();
    for (const node of document.querySelectorAll(`${root}, ${root} *`)) {
        if (node.getClientRects().length === 0 || node.closest(".silo-sr-only, .navigation-avatar-fallback, .settings-subtitle-preview") !== null) continue;
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

async function signedIn(tv: Tv, catalog: CatalogRoutes = new FakeDetails()): Promise<void> {
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
        assert.deepEqual(await tv.page.evaluate(unscaledText, "body"), [], "home");
        for (const tab of ["movies", "series", "for_you"]) {
            await tv.page.locator(`[data-focus="${tab}"]`).first().click();
            await tv.jump(3000);
            assert.deepEqual(await tv.page.evaluate(unscaledText, "body"), [], tab);
        }
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
