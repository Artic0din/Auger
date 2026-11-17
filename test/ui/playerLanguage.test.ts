// The player in German and Arabic (silo-apple tvOS Screens/Player: TVPlayerInfoHUD.swift, TVPlayerTransportCluster.swift,
// TVIntroSkipPill.swift, upNext.* keys): the transport, the Info, Stats, Video, Audio and Subtitles panes, Up Next, the skip
// pill and the error wall read from the catalog under Apple's keys. Text Apple has no key for stays English, and the server's
// titles and track names are never translated. The player keeps its left-to-right layout and physical keys.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import type { PlaybackView, TrackView } from "../../src/player/controller.ts";
import { translate, translateTv } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";

registerSourceCatalogs();

const ORIGIN = "https://tv.example.test";
const CSS = ["theme.css", "app.css", "player/player.css"].map(name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8")).join("\n");
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Silo</title>
<link rel="stylesheet" href="player.css">
<style>#sibling { position: absolute; inset: 0; background: #000; }</style></head>
<body><main id="root"></main><script src="harness.js"></script></body></html>`;
const ENTER = 13;
const RIGHT = 39;
const UP = 38;
const DOWN = 40;

const catalog = (tag: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);
const upper = (value: string, language: string): string => value.toLocaleUpperCase(language);

const TRACKS: TrackView = {
    audio: { state: "ready", choices: [{ id: "a0", label: "English · 5.1 · EAC3" }] },
    selectedAudioId: "a0",
    subtitles: [{ id: "s0", label: "English" }],
    selectedSubtitleId: undefined,
    subtitleMode: "off",
    change: { state: "idle" },
    notices: [],
    subtitleTools: {
        overlay: true,
        search: { offered: true, unavailableReason: "", phase: "closed", suggested: [], other: [], language: undefined, status: "", message: "", warnings: [], canRetry: false, results: [], downloadingKey: undefined },
        display: { delay: true, styling: true, deviceScope: true, textOpacity: true, delayMs: 0, appearance: DEFAULT_APPEARANCE, deviceOverride: false, busy: false, message: "" },
    },
};
const HUD = { chapters: [{ title: "Opening", seconds: 0 }], chapterState: "ready" as const, stats: [["Engine", "AVPlay"], ["Delivery", "remux"], ["Video codec", "h264"]] as const, speeds: [1, 2], aspects: ["Fit", "Stretch"] as const, speed: 1, aspect: "Fit" as const, autoNext: true, busy: false, metadata: { genres: [], seriesTitle: "Die Serie", year: 1999 } as never };
const playing = (extra: Partial<Extract<PlaybackView, { phase: "playing" | "paused" }>> = {}): Extract<PlaybackView, { phase: "playing" | "paused" }> => ({
    phase: "playing", title: "The Movie", positionSeconds: 754, durationSeconds: 7200, buffering: false, seekIntervals: { backward: 10, forward: 10 }, tracks: TRACKS, hud: HUD, ...extra,
});

let browser: Browser;
let script: string;
before(async () => {
    const result = await build({ entryPoints: [new URL("./playerHarness.ts", import.meta.url).pathname], bundle: true, format: "iife", target: "chrome108", write: false, logLevel: "silent" });
    script = result.outputFiles[0]?.text ?? "";
    browser = await chromium.launch();
});
after(async () => { await browser.close(); });

async function open(language: string | undefined): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.route("**/*", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/fonts/InterVariable.woff2") { await route.fulfill({ status: 200, contentType: "font/woff2", body: readFileSync(new URL("../../app/fonts/InterVariable.woff2", import.meta.url)) }); return; }
        const body = path === "/index.html" ? HTML : path === "/harness.js" ? script : path === "/player.css" ? CSS : undefined;
        if (body === undefined) { await route.abort("internetdisconnected"); return; }
        await route.fulfill({ status: 200, contentType: path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html", body });
    });
    await page.clock.install({ time: new Date("2026-11-05T00:00:00Z") });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.goto(`${ORIGIN}/index.html`);
    if (language !== undefined) await page.evaluate(([tag, strings]) => window.player.setLanguage(tag as string, strings as Record<string, string>), [language, catalog(language)] as const);
    return page;
}
const remote = (page: Page, keyCode: number): Promise<void> => page.evaluate(code => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { keyCode: code, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { keyCode: code, bubbles: true, cancelable: true }));
}, keyCode);
const show = (page: Page, view: PlaybackView): Promise<void> => page.evaluate(next => window.player.show(next), view);
/** Up to the tabs, Right `steps` tabs along, Down into that pane. */
async function nextTab(page: Page, steps: number): Promise<void> {
    await remote(page, UP);
    for (let step = 0; step < steps; step++) await remote(page, RIGHT);
    await remote(page, DOWN);
}
/** Down, then Right twice and Enter opens the panel on Info; `tab` more tabs along. */
async function openPanel(page: Page, tab = 0): Promise<void> {
    await remote(page, DOWN); await remote(page, RIGHT); await remote(page, RIGHT); await remote(page, ENTER); await remote(page, DOWN);
    if (tab > 0) await nextTab(page, tab);
}
const texts = (page: Page, selector: string): Promise<string[]> => page.locator(selector).allTextContents();
const label = (page: Page, key: string): Promise<string | null> => page.locator(`[data-focus="${key}"]`).first().getAttribute("aria-label");

for (const language of ["de", "ar"]) {
    test(`the transport and its labels read in ${language}`, async () => {
        const page = await open(language);
        try {
            await show(page, playing({ episodes: true }));
            assert.equal(await label(page, "pause"), text("player.audio.pause", language));
            assert.equal(await label(page, "backward"), text("player.skip.back", language, { seconds: 10 }));
            assert.equal(await label(page, "forward"), text("player.skip.forward", language, { seconds: 10 }));
            assert.equal(await label(page, "up-next"), text("player.controls.showUpNext", language));
            assert.equal(await label(page, "tracks"), text("player.audio.options", language));
            assert.equal(await label(page, "close"), text("player.audio.close", language));
            assert.equal(await page.getByRole("slider").getAttribute("aria-label"), text("player.controls.scrubber", language));
            await show(page, { phase: "loading", title: "The Movie" });
            assert.equal(await page.locator(".player-spinner").getAttribute("aria-label"), text("common.loading", language));
            await show(page, { phase: "loading", title: "The Movie", detail: "restoring" });
            assert.equal(await page.locator(".player-status").textContent(), "Restoring", "no Apple key: English");
        } finally { await page.close(); }
    });

    test(`the tabs and the Info pane read in ${language}, the server's title and an unkeyed note stay as sent`, async () => {
        const page = await open(language);
        try {
            await show(page, playing({ hud: { ...HUD, chapterState: "failed" } }));
            await openPanel(page);
            assert.deepEqual(await texts(page, ".player-tab:not([hidden])"), (["options.tabInfo", "options.tabStats", "options.tabVideo", "options.tabAudio", "options.tabSubtitles", "options.tabChapters"] as const).map(key => text(key, language)));
            assert.deepEqual(await texts(page, ".player-menu-info .player-menu-heading"), [upper(text("player.hud.title", language), language), upper(text("player.hud.stream", language), language)]);
            const labels = await texts(page, ".player-menu-info .player-info-label");
            assert.ok(labels.includes(text("player.hud.audio", language)) && labels.includes(text("player.hud.subtitles", language)), labels.join(" | "));
            assert.ok(labels.includes("Series") && labels.includes("Year"), "rows Apple's tvOS Info does not have stay English");
            assert.ok((await texts(page, ".player-menu-info .player-info-value")).includes(text("player.tracks.subtitlesOff", language)));
            assert.equal(await page.locator(".player-menu-info .player-info-title").textContent(), "The Movie");
            assert.ok((await texts(page, ".player-menu-info .player-menu-note")).includes("Couldn't load chapters."));
            assert.equal(await page.locator('.player-menu-info [data-focus="chapters-retry"]').first().textContent(), "Retry chapters");
        } finally { await page.close(); }
    });

    test(`the Stats, Video and Audio panes read in ${language}`, async () => {
        const page = await open(language);
        try {
            await show(page, playing());
            await openPanel(page, 1);
            assert.deepEqual(await texts(page, ".player-menu-stats .player-menu-heading"), [upper(text("player.stats.title", language), language)]);
            const rows = await texts(page, ".player-menu-stats .player-info-row");
            assert.deepEqual(rows, [`${text("player.stats.sectionEngine", language)}: AVPlay`, `${text("player.stats.delivery", language)}: remux`, "Video codec: h264"]);
            await nextTab(page, 1);
            assert.deepEqual(await texts(page, ".player-menu-quality .player-menu-column > .player-menu-heading"), [upper(text("player.hud.playback", language), language), upper(text("player.hud.sync", language), language)]);
            const names = await texts(page, ".player-menu-quality .player-setting-label");
            assert.ok(names.includes(text("player.hud.aspect", language)) && names.includes(text("player.settings.speed", language)) && names.includes(text("options.autoplayNext", language)), names.join(" | "));
            assert.ok((await texts(page, ".player-menu-quality .player-setting-value")).includes(text("options.on", language)));
            await nextTab(page, 1);
            assert.deepEqual(await texts(page, ".player-menu-audio .player-menu-heading"), [upper(text("player.hud.tracks", language), language)]);
        } finally { await page.close(); }
    });

    test(`the Subtitles pane reads in ${language}`, async () => {
        const page = await open(language);
        try {
            await show(page, playing());
            await openPanel(page, 4);
            assert.deepEqual(await texts(page, ".player-menu-subtitles .player-menu-heading"), (["player.hud.tracks", "player.hud.options", "player.tracks.timing", "player.hud.style"] as const).map(key => upper(text(key, language), language)));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitles-off"]').textContent(), text("player.tracks.subtitlesOff", language));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-search"] .player-setting-label').textContent(), text("options.searchSubtitles", language));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-delay"] .player-setting-label').textContent(), text("player.hud.delay", language));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-appearance"] .player-setting-label').textContent(), text("player.hud.subtitleAppearance", language));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-device"] .player-setting-label').textContent(), translateTv("player.hud.onlyOnThisAppleTv", undefined, language));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-appearance"] .player-choice-detail').textContent(), [text("player.subtitles.size.large", language), text("player.subtitles.background.box", language), text("player.subtitles.position.bottom", language)].join(" · "));
        } finally { await page.close(); }
    });

    test(`Up Next, Keep Watching and the skip pill read in ${language}`, async () => {
        const page = await open(language);
        try {
            const next = { contentId: "next", fileId: "43", title: "Nächste Folge", startSeconds: 0, episode: true as const };
            await show(page, playing({ upNext: { next, deck: [next], countdown: 30, status: text("upNext.heading", language) } }));
            assert.equal(await page.locator('[data-focus="keep-watching"]').textContent(), text("upNext.keepWatching", language));
            assert.equal(await page.locator('[data-focus="play-next"]').textContent(), text("upNext.playNow", language));
            assert.equal(await page.locator('[data-focus="back"]').textContent(), text("common.back", language));
            assert.equal(await page.locator(".player-next-up .player-menu-heading").first().textContent(), text("upNext.onDeck", language));
            assert.equal(await page.locator('[data-focus="cancel-autoplay"]').textContent(), "Cancel autoplay", "no Apple key: English");
            await show(page, playing({ skipMarker: { kind: "intro", startSeconds: 20, endSeconds: 60 }, positionSeconds: 25 }));
            assert.equal(await page.locator(".player-skip-label").textContent(), text("introSkip.pill.skip", language));
            await show(page, playing({ skipMarker: { kind: "credits", startSeconds: 7000, endSeconds: 7200 }, positionSeconds: 7010 }));
            assert.equal(await page.locator(".player-skip-label").textContent(), text("marker.skipCredits", language));
            await show(page, playing({ undoSkipSeconds: 25, positionSeconds: 61 }));
            assert.equal(await page.locator(".player-skip-label").textContent(), text("introSkip.pill.undo", language));
            assert.equal(await page.locator(".player-skip").getAttribute("aria-label"), text("player.introSkip.undoAccessibility", language));
            assert.equal(await page.locator(".player-skip-caption").textContent(), text("introSkip.pill.undoCaption", language));
        } finally { await page.close(); }
    });

    test(`the error wall's buttons read in ${language}; a message Apple has no key for stays English`, async () => {
        const page = await open(language);
        try {
            await show(page, { phase: "error", title: "The Movie", error: { kind: "network" }, retryable: true });
            assert.equal(await page.locator(".player-error-text").textContent(), "Can't reach the server. Check the TV's connection, then try again.");
            assert.equal(await page.locator('[data-focus="back"]').textContent(), text("player.goBack", language));
            assert.equal(await page.locator('[data-focus="settings-retry"]').textContent(), text("common.retry", language));
        } finally { await page.close(); }
    });
}

test("the player stays left to right in Arabic, server text takes its own direction, and the keys stay physical", async () => {
    const page = await open("ar");
    try {
        await show(page, playing({ seriesTitle: "مسلسل" }));
        assert.equal(await page.locator("section.player").getAttribute("dir"), "ltr");
        for (const selector of [".player-title", ".player-series"]) assert.equal(await page.locator(selector).first().evaluate(node => getComputedStyle(node).unicodeBidi), "plaintext", selector);
        await openPanel(page);
        await nextTab(page, 1);
        assert.equal(await page.locator(".player-tab[aria-selected=true]").textContent(), text("options.tabStats", "ar"), "Right is the next tab, as on the screen");
        await nextTab(page, 2);
        assert.equal(await page.locator(".player-menu-audio .player-choice-label").first().evaluate(node => getComputedStyle(node).unicodeBidi), "plaintext", "a track name");
    } finally { await page.close(); }
});

test("English is unchanged", async () => {
    const page = await open(undefined);
    try {
        await show(page, playing());
        assert.equal(await page.locator('[data-focus="pause"]').getAttribute("aria-label"), "Pause");
        await openPanel(page);
        assert.deepEqual(await texts(page, ".player-tab:not([hidden])"), ["Info", "Stats", "Video", "Audio", "Subtitles", "Chapters"]);
    } finally { await page.close(); }
});

test("a German catalog that lands while the player is up redraws it in German", async () => {
    const page = await open(undefined);
    try {
        await show(page, playing());
        assert.equal(await label(page, "backward"), "Back 10 seconds");
        await page.evaluate(strings => window.player.setLanguage("de", strings), catalog("de"));
        await page.waitForFunction(expected => document.querySelector('[data-focus="backward"]')?.getAttribute("aria-label") === expected, text("player.skip.back", "de", { seconds: 10 }));
        await openPanel(page);
        assert.equal(await page.locator(".player-tab").nth(1).textContent(), text("options.tabStats", "de"));
    } finally { await page.close(); }
});

test("a catalog that lands while Select is held on a panel choice waits for the release, so the press is not cut off", async () => {
    const page = await open(undefined);
    try {
        await show(page, playing());
        await openPanel(page, 3);
        assert.equal(await page.locator(".player-menu-audio .player-menu-heading").textContent(), "TRACKS");
        await page.evaluate(() => document.activeElement?.setAttribute("data-mark", "held"));
        await page.keyboard.down("Enter");
        await page.evaluate(strings => window.player.setLanguage("de", strings), catalog("de"));
        await page.clock.runFor(50);
        assert.equal(await page.locator('[data-mark="held"]').count(), 1, "the pressed choice is still on screen while Select is down");
        assert.equal(await page.locator(".player-menu-audio .player-menu-heading").textContent(), "TRACKS", "still English while Select is held");
        await page.keyboard.up("Enter");
        await page.clock.runFor(50);
        assert.equal(await page.locator(".player-menu-audio .player-menu-heading").textContent(), upper(text("player.hud.tracks", "de"), "de"), "German once it is released");
        assert.deepEqual(await page.evaluate(() => window.player.commands.filter(command => command.startsWith("selectAudio"))), ["selectAudio a0"], "the press still acted on release");
    } finally { await page.close(); }
});
