// The Details action row against TVDetailActionRow (silo-apple 85679e7, TVDetailActions.swift).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { assertPressedLook } from "./support/pressed.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const LEFT = 37;
const RIGHT = 39;
const MOVIE = '[data-section="recently_added"] [data-focus="movie:m0001"]';

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

interface Control { key: string; label: string; spoken: string; disabled: boolean }

function row(tv: Tv): Promise<Control[]> {
    return tv.page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".details-editorial .browse-actions > [data-focus]")].map(node => ({
        key: node.dataset.focus ?? "",
        label: node.querySelector(".details-action-label")?.textContent ?? "",
        spoken: node.getAttribute("aria-label") ?? "",
        disabled: node.getAttribute("aria-disabled") === "true",
    })));
}

async function openMovie(setup: (catalog: FakeDetails) => void, body: (tv: Tv) => Promise<void>, beforeOpen?: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    setup(catalog);
    tv.fake.catalog = catalog;
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await beforeOpen?.(tv);
        await tv.page.locator(MOVIE).first().click();
        await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
        await tv.page.locator('[data-focus="watchlist"][aria-pressed]').waitFor();
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("a movie with no progress shows Apple's six controls, focuses Play and keeps Watchlist's label", () => openMovie(catalog => { catalog.progress.delete("movie:m0001"); }, async tv => {
    assert.deepEqual((await row(tv)).map(({ key, label, disabled }) => ({ key, label, disabled })), [
        { key: "play", label: "Play", disabled: false },
        // TVPlaybackSelectorRow's detail.version and detail.audio (silo-apple 71a3beb9, :112, :147).
        { key: "version", label: "Version", disabled: false },
        { key: "audio", label: "Audio", disabled: false },
        { key: "subtitles", label: "Subtitles", disabled: false },
        { key: "watchlist", label: "Watchlist", disabled: false },
        { key: "more", label: "More", disabled: false },
    ]);
    assert.equal(await tv.focused(), "play");
    const watchlist = tv.page.locator('[data-focus="watchlist"]');
    assert.equal(await watchlist.getAttribute("aria-label"), "Add to watchlist");
    await watchlist.focus();
    assert.equal(await watchlist.getAttribute("aria-pressed"), "false");
    await watchlist.click();
    await tv.eventually(async () => await watchlist.getAttribute("aria-label") === "Remove from watchlist", "watchlist added");
    assert.equal(await watchlist.innerText(), "Watchlist", "the focused label never changes");
    assert.equal(await watchlist.getAttribute("aria-pressed"), "true");
}));

test("a movie past 30 s offers Resume with Apple's clock label, then Start Over", () => openMovie(catalog => { catalog.progress.set("movie:m0001", 3725); }, async tv => {
    const controls = await row(tv);
    assert.deepEqual(controls.map(control => control.key), ["resume", "play", "version", "audio", "subtitles", "watchlist", "more"]);
    assert.equal(controls[0]?.label, "Resume 1:02:05");
    assert.equal(controls[1]?.label, "Start Over");
    assert.equal(await tv.focused(), "resume");
}));

test("a movie at 30 s or less plays from the start with no Resume or Start Over", () => openMovie(catalog => { catalog.progress.set("movie:m0001", 30); }, async tv => {
    assert.deepEqual((await row(tv)).map(control => control.key), ["play", "version", "audio", "subtitles", "watchlist", "more"]);
    assert.equal(await tv.focused(), "play");
}));

test("a movie with no playable file keeps Play and the selectors in place, disabled and skipped by focus", () => openMovie(catalog => { catalog.progress.delete("movie:m0001"); }, async tv => {
    const controls = await row(tv);
    assert.deepEqual(controls.map(({ key, disabled }) => ({ key, disabled })), [
        { key: "play", disabled: true },
        { key: "version", disabled: true },
        { key: "audio", disabled: true },
        { key: "subtitles", disabled: true },
        { key: "watchlist", disabled: false },
        { key: "more", disabled: false },
    ]);
    assert.equal(await tv.focused(), "watchlist", "the row enters on Watchlist when Play cannot take focus");
    await tv.remote(LEFT);
    assert.equal(await tv.focused(), "watchlist", "Left never lands on a disabled control");
    await tv.remote(RIGHT);
    assert.equal(await tv.focused(), "more");
    await tv.remote(LEFT);
    assert.equal(await tv.focused(), "watchlist");
    await tv.page.getByText("This title has no file this TV can play.").waitFor();
}, async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as Record<string, unknown>;
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: { ...body, versions: [] } }));
}));

// TVPlaybackSelectorRow.isVersionDisabled (TVPlaybackSelectorRow.swift:64-67, silo-apple main 71a3beb9) is
// DetailPlaybackFormatting.shouldEnableVersionSelector (DetailPlaybackFormatting.swift:99-104): more than one version to choose.
// A disabled Version is in disabledActions (:76), so focus passes over it.
test("a movie with one version draws Versions disabled and Right from Play skips to Audio, as Apple TV does", () => openMovie(catalog => { catalog.progress.delete("movie:m0001"); }, async tv => {
    await tv.eventually(async () => await tv.page.locator('[data-focus="audio"]').getAttribute("aria-disabled") === "false", "playback detail arrived");
    const controls = await row(tv);
    assert.deepEqual(controls.filter(control => ["play", "version", "audio"].includes(control.key)).map(({ key, disabled }) => ({ key, disabled })), [
        { key: "play", disabled: false },
        { key: "version", disabled: true },
        { key: "audio", disabled: false },
    ]);
    assert.equal(await tv.focused(), "play");
    await tv.remote(RIGHT);
    assert.equal(await tv.focused(), "audio", "Right passes over the disabled Versions");
    await tv.remote(LEFT);
    assert.equal(await tv.focused(), "play");
    await tv.page.locator('[data-focus="version"]').focus();
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.getByRole("dialog").count(), 0, "a disabled Versions opens no picker");
}, async tv => {
    const catalog = tv.fake.catalog;
    assert.ok(catalog instanceof FakeDetails);
    const body = catalog.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as Record<string, unknown>;
    const versions = Array.isArray(body.versions) ? body.versions.slice(0, 1) : [];
    await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: { ...body, versions } }));
}));

test("a movie with two versions keeps Versions enabled and reachable from Play", () => openMovie(catalog => { catalog.progress.delete("movie:m0001"); }, async tv => {
    await tv.eventually(async () => await tv.page.locator('[data-focus="version"]').getAttribute("aria-disabled") === "false", "playback detail arrived");
    await tv.remote(RIGHT);
    assert.equal(await tv.focused(), "version");
}));

test("focused controls cast Apple's black shadows, never a halo", () => openMovie(catalog => { catalog.progress.delete("movie:m0001"); }, async tv => {
    // Read from the live node: a repaint can replace the button between lookup and style read.
    const shadow = async (key: string): Promise<string> => {
        let value = "";
        await tv.eventually(async () => { value = await tv.page.evaluate(focus => { const node = document.querySelector(`[data-focus="${focus}"]`); return node?.isConnected ? getComputedStyle(node).boxShadow : ""; }, key); return value !== ""; }, `${key} style`);
        return value;
    };
    assert.equal(await shadow("play"), "rgba(0, 0, 0, 0.24) 0px 4px 10px 0px");
    assert.equal(await shadow("watchlist"), "none");
    await tv.remote(RIGHT);
    assert.equal(await tv.focused(), "version");
    assert.equal(await shadow("play"), "rgba(0, 0, 0, 0.14) 0px 2px 4px 0px");
    assert.equal(await shadow("version"), "rgba(0, 0, 0, 0.34) 0px 6px 16px 0px");
    // Layout width: the rect would include the 1.025 focus scale while it eases back.
    const play = await tv.page.locator('[data-focus="play"]').evaluate(node => ({ width: node instanceof HTMLElement ? node.offsetWidth : 0, border: getComputedStyle(node).borderTopWidth }));
    assert.deepEqual(play, { width: 340, border: "0px" });
}));

// TVPrimaryPillButton is TVPillButtonStyle(kind: .primary, focusTreatment: .compact) (TVDetailActions.swift:32-37, silo-apple main
// 71a3beb9): focused it scales to 1.025 (:774-777), and held to that focus scale times 0.98 (:769-772), easeOut(fastDuration) (:745).
for (const reduced of [false, true]) {
    test(`Details Play presses to 0.98 of its 1.025 focus scale, as Apple's pill does (reduced motion: ${reduced})`, () => openMovie(catalog => { catalog.progress.delete("movie:m0001"); }, async tv => {
        await tv.page.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
        await tv.eventually(async () => await tv.page.locator('[data-focus="version"]').getAttribute("aria-disabled") === "false", "playback detail arrived");
        await assertPressedLook(tv, tv.page.locator('[data-focus="play"]'), { focusScale: 1.025, heldScale: 1.025 * 0.98, heldOpacity: 1, animates: "scale" }, reduced);
    }));
}

test("Back from the action row leaves Details for the card that opened it", () => openMovie(catalog => { catalog.progress.delete("movie:m0001"); }, async tv => {
    assert.equal(await tv.focused(), "play");
    await tv.remote(RIGHT);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    assert.equal(await tv.focused(), "movie:m0001");
}));

test("a series reads Loading episodes… on a disabled Play, focuses Watchlist, then Play claims focus once live", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        const holds = ["/catalog/series/series%3As1/seasons/1/episodes", "/catalog/items/episode%3As1e11"].flatMap(path => [0, 1, 2].map(() => tv.fake.hold(path)));
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        const primary = tv.page.locator('[data-focus="next-episode"]');
        await primary.waitFor();
        assert.equal(await primary.getAttribute("aria-label"), "Loading episodes…");
        assert.equal(await primary.getAttribute("aria-disabled"), "true");
        assert.equal(await tv.focused(), "watchlist", "Watchlist takes opening focus while episodes load");
        for (const hold of holds) hold.release();
        await tv.eventually(async () => /^(Play|Resume) S1:E1$/.test(await primary.getAttribute("aria-label") ?? ""), "episode label");
        await tv.eventually(async () => await tv.focused() === "next-episode", "Play claims focus once it is live");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a season whose next-episode read fails keeps Play live and plays that episode", async () => {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeDetails();
    try {
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="series:s1-S1"]').waitFor();
        await tv.page.route("**/api/v2/catalog/items/episode%3A*", route => route.fulfill({ status: 500 }));
        await tv.page.locator('[data-focus="series:s1-S1"]').click();
        await tv.page.getByText("Could not load the next episode.").waitFor();
        const primary = tv.page.locator('[data-focus="next-episode"]');
        assert.equal(await primary.getAttribute("aria-disabled"), "false");
        assert.equal(await tv.page.getByRole("button", { name: "Retry episode", exact: true }).count(), 0);
        await tv.page.unroute("**/api/v2/catalog/items/episode%3A*");
        const plays = await tv.page.evaluate(() => window.browseHarness.plays.length);
        await primary.click();
        await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.plays.length) === plays + 1, "Play reaches the episode route");
    } finally { await tv.page.context().close(); }
});
