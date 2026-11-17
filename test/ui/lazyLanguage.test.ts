// The shown language's text arrives as its own packaged file: English reads until it lands, the screen
// relabels when it does, a missing file leaves English, and an English profile fetches no language file.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const BACK = 10009;

async function withTv(language: string | null, prepare: (page: Page) => Promise<void>, body: (tv: Tv, fileRequests: string[]) => Promise<void>): Promise<void> {
    const fileRequests: string[] = [];
    const tv = await openTv(browser, { app: "browse" });
    // After openTv, so these routes run before the harness's own (the last route added answers first).
    tv.page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/tv/catalog/")) fileRequests.push(path); });
    await prepare(tv.page);
    tv.fake.catalog = new FakeDetails();
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    if (language !== null) settings.profile().set(APP_LANGUAGE_KEY, language);
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await body(tv, fileRequests);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

async function openSettings(tv: Tv, name: string): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    await tv.page.getByRole("menuitem", { name, exact: true }).click();
    await tv.page.locator(".settings-panes h1.browse-title").waitFor();
}

/** Settings' own reads (playback capability, connection, values) have all been answered, so none of them can repaint the screen under a press. */
async function settingsSettled(tv: Tv): Promise<void> {
    await tv.eventually(async () => {
        const requests = tv.fake.requests.length;
        await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "answers delivered");
        await tv.jump(100);
        return tv.fake.requests.length === requests;
    }, "Settings' reads answered");
}

test("Settings reads English while German's file is on its way, then relabels in German with no new press", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await withTv("de", async page => { await page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); }); }, async tv => {
        await openSettings(tv, "Settings");
        assert.equal(await tv.page.locator(".settings-panes h1.browse-title").innerText(), "Settings", "English until the file lands");
        release();
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() === "Einstellungen", "Settings relabels in German");
        await tv.remote(BACK);
    });
});

test("a Select held on a Settings row while the language's file lands still runs on release, and Settings relabels after it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await withTv("de", async page => { await page.route("**/tv/catalog/de.js", async route => { await gate; await route.fallback(); }); }, async tv => {
        await openSettings(tv, "Settings");
        const row = tv.page.locator('[data-focus="app-language"]');
        await row.waitFor();
        // A read that lands under the press repaints Settings in the language already shown, so only the language file may land during it.
        await settingsSettled(tv);
        await row.focus();
        await tv.page.keyboard.down("Enter");
        const landed = tv.page.waitForResponse(response => new URL(response.url()).pathname === "/tv/catalog/de.js");
        release();
        await landed;
        // The repaint waits for the release: the held row is not replaced under the finger.
        await tv.jump(500);
        assert.equal(await tv.page.locator(".settings-panes h1.browse-title").innerText(), "Settings", "still English while Select is held");
        assert.equal(await tv.page.locator('[data-focus="app-language"][data-pressed]').count(), 1, "the held row stays pressed");
        await tv.page.keyboard.up("Enter");
        const dialog = tv.page.getByRole("dialog", { name: "App-Sprache" });
        await dialog.waitFor();
        await tv.remote(BACK);
        await dialog.waitFor({ state: "detached" });
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() === "Einstellungen", "Settings relabels in German after the release");
    });
});

test("a Select held on a Settings row survives a repaint from a read that lands under it, and runs on release", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let releaseFile: () => void = () => undefined;
    const fileGate = new Promise<void>(resolve => { releaseFile = resolve; });
    await withTv("de", async page => {
        await page.route("**/playback/capabilities", async route => { await gate; await route.fallback(); });
        await page.route("**/tv/catalog/de.js", async route => { await fileGate; await route.fallback(); });
    }, async tv => {
        await openSettings(tv, "Settings");
        const row = tv.page.locator('[data-focus="app-language"]');
        await row.waitFor();
        releaseFile();
        await tv.eventually(async () => await tv.page.locator(".settings-panes h1.browse-title").innerText() === "Einstellungen", "German has landed");
        await row.focus();
        await tv.page.keyboard.down("Enter");
        const handle = await row.elementHandle();
        const read = tv.page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/playback/capabilities"));
        release();
        await read;
        await tv.jump(500);
        assert.equal(await handle?.evaluate(node => node.isConnected), false, "the connection read repainted the row");
        assert.equal(await tv.page.locator('[data-focus="app-language"][data-pressed]').count(), 1, "the press moved to the repainted row");
        await tv.page.keyboard.up("Enter");
        const dialog = tv.page.getByRole("dialog", { name: "App-Sprache" });
        await dialog.waitFor();
        await tv.remote(BACK);
        await dialog.waitFor({ state: "detached" });
    });
});

test("a language file that is missing leaves English and breaks nothing", async () => {
    await withTv("de", async page => { await page.route("**/tv/catalog/de.js", route => route.fulfill({ status: 404, body: "" })); }, async tv => {
        await openSettings(tv, "Settings");
        await tv.eventually(async () => await tv.page.locator('[data-focus="app-language"]').count() === 1, "the language row");
        assert.equal(await tv.page.locator(".settings-panes h1.browse-title").innerText(), "Settings");
        assert.match(await tv.page.locator('[data-focus="app-language"]').innerText(), /^App Language\s*Deutsch$/, "the stored choice still shows by its own name");
    });
});

test("only the shown language's file is fetched, and an English profile fetches none", async () => {
    await withTv("de", async () => undefined, async (tv, requests) => {
        await tv.eventually(async () => requests.includes("/tv/catalog/de.js"), "German's file is asked for");
        assert.deepEqual([...new Set(requests)], ["/tv/catalog/de.js"]);
    });
    await withTv(null, async () => undefined, async (tv, requests) => {
        await openSettings(tv, "Settings");
        assert.deepEqual(requests, []);
    });
});
