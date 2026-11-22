// The player in German and Arabic (silo-apple tvOS Screens/Player: TVPlayerInfoHUD.swift, TVPlayerTransportCluster.swift,
// TVIntroSkipPill.swift, upNext.* keys): the transport, the Info, Stats, Video, Audio and Subtitles panes, Up Next, the skip
// pill and the error wall read from the catalog under Apple's keys. Text Apple has no key for stays English, and the server's
// titles and track names are never translated. In Arabic the panel, Up Next, the buffering card and the error page mirror, as in
// Apple's player; only the transport, the scrubber and its time row stay left to right (`.mediaLayoutDirection()`,
// TVPlayerControls.swift lines 325, 555, 557 and 575), with the remote's physical keys.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import { type Browser, chromium, type Page } from "playwright";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import type { PlaybackView, TrackView } from "../../src/player/controller.ts";
import { UP_NEXT_PREVIEW, upNextPreviewLeft } from "../../src/player/upNextPreview.ts";
import { type MessageKey, translate, translateTv } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";

registerSourceCatalogs();

const ORIGIN = "https://tv.example.test";
const CSS = ["theme.css", "app.css", "player/player.css"].map(name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8")).join("\n");
const HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Silo</title>
<link rel="stylesheet" href="player.css">
<style>#sibling { position: absolute; inset: 0; background: #000; }</style></head>
<body><main id="root"></main><script src="harness.js"></script></body></html>`;
const ENTER = 13;
const LEFT = 37;
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
const rows = (pairs: readonly (readonly [string, string])[]): { label: string; value: string }[] => pairs.map(([label, value]) => ({ label, value }));
const STATS = {
    nowPlaying: rows([["Video", "1080p"], ["Audio", "English · EAC3 5.1"], ["Subtitles", "Off"], ["Playback", "Direct play"]]),
    playback: rows([["Playback", "Direct play · MKV"], ["Dynamic range", "SDR"]]),
    stream: rows([["Playback status", "Playing"]]),
    engine: rows([["Delivery", "Original HTTP"], ["Source", "media.example"]]),
};
const HUD = { chapters: [{ title: "Opening", seconds: 0 }], chapterState: "ready" as const, stats: STATS, speeds: [1, 2], aspects: ["Fit", "Stretch"] as const, speed: 1, aspect: "Fit" as const, autoNext: true, busy: false, metadata: { genres: [], seriesTitle: "Die Serie", year: 1999 } as never };
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

const shown = new WeakMap<Page, string | undefined>();
/** The key that moves toward the end of a mirrored row: Left in Arabic, Right otherwise. */
const toEnd = (page: Page): number => shown.get(page) === "ar" ? LEFT : RIGHT;
/** The key that moves back toward the start of a mirrored row. */
const toStart = (page: Page): number => shown.get(page) === "ar" ? RIGHT : LEFT;

async function open(language: string | undefined): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    shown.set(page, language);
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
/** Up to the tabs, `steps` tabs along the rail (Right, or Left in Arabic), Down into that pane. */
async function nextTab(page: Page, steps: number): Promise<void> {
    await remote(page, UP);
    for (let step = 0; step < steps; step++) await remote(page, toEnd(page));
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
    // PlayerView (silo-apple main 9dabb621): loadingContent shows upNextFinding (upNextPicking in a Shuffle) with no message, and
    // finishedContent shows upNextEndOfPlayback over finishedMessage (upNextNoNext, upNextShuffleDone, a lookup failure).
    test(`the end-of-playback card reads Apple's words in ${language} in every state`, async () => {
        const page = await open(language);
        const card = async (): Promise<[string | null, string | null, string | null]> => [await page.locator(".player-next-eyebrow").textContent(), await page.locator(".player-next-up .player-title").textContent(), await page.locator(".player-next-up .player-error-text").textContent()];
        const completion = (state: "finalizing" | "resolving" | "ready" | "failed", status: MessageKey, extra: { shuffle?: true; failure?: "session" } = {}): PlaybackView => ({ phase: "completion", status, state, next: undefined, retryable: state === "failed", ...extra });
        try {
            for (const state of ["finalizing", "resolving"] as const) {
                await show(page, completion(state, "upNext.headingEnded"));
                assert.deepEqual(await card(), [text("upNext.headingEnded", language), text("upNext.finding", language), ""], `${state}: Apple's loading card, no separate ending stage`);
            }
            await show(page, completion("resolving", "upNext.headingShuffle", { shuffle: true }));
            assert.deepEqual(await card(), [text("upNext.headingShuffle", language), text("upNext.picking", language), ""]);
            await show(page, completion("failed", "upNext.headingFinished"));
            assert.deepEqual(await card(), [text("upNext.headingFinished", language), text("upNext.endOfPlayback", language), text("upNext.lookupFailedAlone", language)]);
            await show(page, completion("failed", "upNext.headingFinished", { failure: "session" }));
            assert.deepEqual(await card(), [text("upNext.headingFinished", language), text("upNext.endOfPlayback", language), text("errors.apple.playback.invalidSample", language)], "a failed STOP says the progress was not recorded, not that a lookup failed");
            await show(page, completion("ready", "upNext.headingFinished"));
            assert.deepEqual(await card(), [text("upNext.headingFinished", language), text("upNext.endOfPlayback", language), text("upNext.noNext", language)]);
            await show(page, completion("ready", "upNext.headingFinished", { shuffle: true }));
            assert.deepEqual(await card(), [text("upNext.headingFinished", language), text("upNext.endOfPlayback", language), text("upNext.shuffleDone", language)]);
            for (const key of ["upNext.finding", "upNext.picking", "upNext.endOfPlayback", "upNext.lookupFailedAlone", "upNext.noNext", "upNext.shuffleDone", "errors.apple.playback.invalidSample"] as const) {
                assert.notEqual(catalog(language)[key], undefined, `${key} ships in ${language}`);
            }
        } finally { await page.close(); }
    });

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
            assert.deepEqual(await texts(page, ".player-menu-info .player-menu-heading"), [upper(text("player.hud.title", language), language), upper(text("player.hud.nowPlayingHeading", language), language)]);
            const labels = await texts(page, ".player-menu-info .player-info-label");
            assert.deepEqual(labels.slice(0, 4), (["player.hud.video", "player.hud.audio", "player.hud.subtitles", "player.hud.playback"] as const).map(key => text(key, language)));
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
            assert.deepEqual(await texts(page, ".player-stats-heading"), (["player.hud.playback", "player.hud.stream", "player.stats.sectionEngine"] as const).map(key => text(key, language)));
            assert.deepEqual(await texts(page, ".player-stats-label"), (["player.hud.playback", "player.stats.dynamicRange", "player.stats.playbackStatus", "player.stats.delivery", "player.stats.source"] as const).map(key => text(key, language)));
            await nextTab(page, 1);
            assert.deepEqual(await texts(page, ".player-menu-quality .player-menu-column > .player-menu-heading"), [upper(text("player.hud.picture", language), language), upper(text("player.hud.playback", language), language)]);
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
            // SubtitlesPane.timingRows (TVPlayerInfoHUD.swift, silo-apple main 9dabb62): Sync to Audio, its progress and Reset Timing.
            const timing = { key: "stored-7", canSync: true, canReset: true, busy: false, inProgress: false, forbidden: undefined, progress: undefined, note: undefined };
            assert.notEqual(text("player.tracks.syncToAudioButton", language), "Sync to Audio", `the ${language} file carries the sync keys`);
            await show(page, playing({ tracks: { ...TRACKS, syncTiming: timing } }));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-sync"] .player-setting-label').textContent(), text("player.tracks.syncToAudioButton", language));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-reset-timing"] .player-setting-label').textContent(), text("player.tracks.resetTimingButton", language));
            await show(page, playing({ tracks: { ...TRACKS, syncTiming: { ...timing, inProgress: true, progress: { percent: 40, phase: "" } } } }));
            assert.equal(await page.locator('.player-menu-subtitles [data-focus="subtitle-sync"] .player-setting-label').textContent(), text("player.tracks.syncing", language));
            assert.equal(await page.locator(".player-sync-progress").getAttribute("aria-label"), text("player.subtitleSync.progressLabel", language));
        } finally { await page.close(); }
    });

    // SubtitleTranslateMenu's tvOS panel (silo-apple main 9dabb62): title, subtitle, Back, headings, hints, quota, then a job or a failure.
    test(`the AI Subtitles menu reads in ${language}`, async () => {
        const page = await open(language);
        try {
            assert.notEqual(text("player.aiTranslate.aiSubtitles", language), "AI Subtitles", `the ${language} file carries the AI keys`);
            const ai: NonNullable<TrackView["ai"]> = { available: { translate: true, transcribe: true }, languages: ["fr", "de"], preferred: "fr", quota: { limited: true, remaining: 0, period: "", used: 5, limit: 5 }, busy: false, message: "", results: [], phase: "idle", kind: undefined, progress: undefined, held: false };
            const aiMenu: NonNullable<TrackView["aiMenu"]> = {
                menu: { detected: { code: "__detected__", label: "Spoken language", hint: "player.aiTranslate.detectedFromAudio", disabled: false }, suggested: [{ code: "fr", label: "French", hint: "subtitleSearch.preferred", disabled: false }], other: [{ code: "de", label: "German", hint: undefined, disabled: false }] },
                quota: "Transcription limit reached", quotaExhausted: true,
            };
            const menu = async (state: Partial<NonNullable<TrackView["ai"]>>): Promise<void> => {
                await show(page, playing({ tracks: { ...TRACKS, ai: { ...ai, ...state }, aiMenu } }));
                if (await page.locator(".player-ai-menu").count() > 0) return;
                await page.locator('[data-focus="ai-menu"]').focus();
                await remote(page, ENTER);
            };
            await show(page, playing({ tracks: { ...TRACKS, ai, aiMenu } }));
            await openPanel(page, 4);
            assert.equal(await page.locator('[data-focus="ai-menu"] .player-setting-label').textContent(), text("player.aiTranslate.openMenu", language));
            await menu({});
            assert.equal(await page.locator(".player-ai-title").textContent(), text("player.aiTranslate.aiSubtitles", language));
            assert.equal(await page.locator(".player-ai-subtitle").textContent(), text("player.aiTranslate.explainerShort", language));
            assert.equal(await page.locator('[data-focus="ai-language-back"]').textContent(), text("player.tracks.backToSubtitles", language));
            assert.equal(await page.locator(".player-ai-quota-note").textContent(), text("player.aiTranslate.quotaExhaustedNote", language));
            assert.deepEqual(await texts(page, ".player-ai-menu .player-menu-heading"), [upper(text("player.aiTranslate.suggestedHeader", language), language), upper(text("subtitleSearch.allLanguagesHeader", language), language)]);
            assert.deepEqual(await texts(page, ".player-ai-menu .player-choice-detail"), [text("player.aiTranslate.detectedFromAudio", language), text("subtitleSearch.preferred", language)]);
            await menu({ phase: "busy", kind: "transcribe", progress: { percent: 40, message: "" } });
            assert.equal(await page.locator(".player-ai-subtitle").textContent(), text("player.aiTranslate.preparing", language));
            assert.equal(await page.locator(".player-ai-job").textContent(), text("player.aiTranslate.transcribingAudio", language));
            assert.equal(await page.locator('[data-focus="ai-cancel"]').textContent(), text("common.cancel", language));
            await menu({ phase: "failed", held: true });
            assert.equal(await page.locator(".player-ai-subtitle").textContent(), text("player.aiTranslate.failedTitle", language));
            assert.equal(await page.locator(".player-ai-failure").textContent(), text("player.aiTranslate.failed", language));
            assert.equal(await page.locator('[data-focus="ai-dismiss"]').textContent(), text("player.aiTranslate.dismiss", language));
            assert.equal(await page.locator('[data-focus="ai-discard"]').textContent(), text("player.aiTranslate.discardHeldRequest", language));
        } finally { await page.close(); }
    });

    test(`Up Next, Keep Watching and the skip pill read in ${language}`, async () => {
        const page = await open(language);
        try {
            const next = { contentId: "next", fileId: "43", title: "Nächste Folge", startSeconds: 0, episode: true as const };
            await show(page, playing({ upNext: { next, deck: [next], countdown: 30, status: text("upNext.heading", language) } }));
            assert.equal(await page.locator('[data-focus="keep-watching"]').textContent(), text("upNext.keepWatching", language));
            assert.equal(await page.locator('[data-focus="play-next"]').textContent(), text("upNext.playNow", language));
            // PlayerView.swift:1466-1477 (silo-apple b54fefb1): Up Next's dismiss button is upNext.close, its countdown upNext.playingNextIn.
            assert.equal(await page.locator('[data-focus="back"]').textContent(), text("upNext.close", language));
            assert.equal(await page.locator(".player-countdown").getAttribute("aria-label"), text("upNext.playingNextIn", language, { seconds: 30 }));
            assert.equal(await page.locator(".player-countdown-seconds").textContent(), language === "ar" ? "٣٠" : "30", "the ring writes the seconds in the language's digits");
            assert.equal(await page.locator(".player-next-up .player-menu-heading").first().textContent(), text("upNext.onDeck", language));
            assert.equal(await page.locator('[data-focus="cancel-autoplay"]').textContent(), "Cancel autoplay", "no Apple key: English");
            await show(page, { phase: "completion", status: "upNext.headingEnded", state: "ready", retryable: false, next, countdown: 1 });
            assert.equal(await page.locator(".player-countdown").getAttribute("aria-label"), text("upNext.playingNextIn", language, { seconds: 1 }));
            assert.equal(await page.locator('[data-focus="back"]').textContent(), text("upNext.close", language));
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

    test(`the error wall reads a lost connection in ${language}, as Apple's give-up does; a message Apple has no key for stays English`, async () => {
        const page = await open(language);
        try {
            await show(page, { phase: "error", title: "The Movie", error: { kind: "network" }, retryable: true });
            assert.equal(await page.locator(".player-error-text").innerText(), text("player.error.connectionLost", language));
            await show(page, { phase: "error", title: "The Movie", error: { kind: "server" }, retryable: true });
            assert.equal(await page.locator(".player-error-text").textContent(), "The server couldn't start playback. Try again.");
            assert.equal(await page.locator('[data-focus="back"]').textContent(), text("player.goBack", language));
            assert.equal(await page.locator('[data-focus="settings-retry"]').textContent(), text("common.retry", language));
        } finally { await page.close(); }
    });
}

const center = (page: Page, selector: string): Promise<number> => page.locator(selector).first().evaluate(node => { const box = node.getBoundingClientRect(); return box.left + box.width / 2; });
const direction = (page: Page, selector: string): Promise<string> => page.locator(selector).first().evaluate(node => getComputedStyle(node).direction);
const MIDDLE = 960;
const NEXT = { contentId: "next", fileId: "43", title: "Nächste Folge", startSeconds: 0, episode: true as const };
const promptView = (): Extract<PlaybackView, { phase: "playing" | "paused" }> => playing({ upNext: { next: NEXT, deck: [NEXT], countdown: 30, status: "Up Next" }, captions: { text: "A visible line", secondaryText: "", appearance: DEFAULT_APPEARANCE } });
const PROMPT = { kind: "prompt" as const, remainingMs: 15_000, totalMs: 15_000, running: true, revision: 1 };

test("in Arabic the player mirrors, and only the transport, the scrubber and its time row stay left to right", async () => {
    const page = await open("ar");
    try {
        await show(page, playing({ seriesTitle: "مسلسل", skipMarker: { kind: "intro", startSeconds: 20, endSeconds: 60 }, positionSeconds: 25, bufferingPill: PROMPT, buffering: false }));
        assert.equal(await page.locator("section.player").getAttribute("dir"), "rtl");
        assert.equal(await page.locator("section.player").getAttribute("lang"), "ar");
        assert.equal(await direction(page, "section.player"), "rtl");
        for (const selector of [".player-transport", ".player-bar", ".player-time"]) assert.equal(await direction(page, selector), "ltr", selector);
        assert.ok(await center(page, '[data-focus="backward"]') < await center(page, '[data-focus="pause"]') && await center(page, '[data-focus="pause"]') < await center(page, '[data-focus="forward"]'), "the transport reads backward, pause, forward from the left");
        assert.ok(await center(page, ".player-time-elapsed") < await center(page, ".player-time-remaining"), "elapsed on the left, remaining on the right");
        assert.ok(await center(page, ".player-skip") < MIDDLE, "the skip pill takes the bottom-leading corner, on the left");
        assert.ok(await center(page, ".player-buffering") < MIDDLE, "the buffering card takes the top-leading corner, on the left");
        for (const selector of [".player-title", ".player-series"]) assert.equal(await page.locator(selector).first().evaluate(node => getComputedStyle(node).unicodeBidi), "plaintext", selector);
    } finally { await page.close(); }
});

test("a cue takes its own direction from its text, not from an Arabic interface: English dialogue keeps its punctuation, Arabic dialogue reads right to left", async () => {
    const page = await open("ar");
    try {
        const order = async (cue: string, layer = ".player-captions"): Promise<{ first: number; last: number }> => {
            await show(page, playing({ captions: { text: layer === ".player-captions" ? cue : "Primary", secondaryText: layer === ".player-captions" ? "" : cue, appearance: DEFAULT_APPEARANCE } }));
            return page.locator(`${layer} span`).evaluate(node => {
                const text = node.firstChild as Text;
                const at = (index: number): number => { const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + 1); return range.getBoundingClientRect().left; };
                return { first: at(0), last: at(text.length - 1) };
            });
        };
        const english = await order("Hello!");
        assert.ok(english.first < english.last, "Hello! reads H first on the left, ! last on the right");
        const arabic = await order("مرحبا!");
        assert.ok(arabic.first > arabic.last, "an Arabic cue reads from the right, its ! on the left");
        const secondary = await order("Hello!", ".player-captions-secondary");
        assert.ok(secondary.first < secondary.last, "an English secondary cue reads H first too");
        const secondaryArabic = await order("مرحبا!", ".player-captions-secondary");
        assert.ok(secondaryArabic.first > secondaryArabic.last, "an Arabic secondary cue reads from the right");
    } finally { await page.close(); }
});

test("English keeps the corners: the skip pill and the buffering card on the right, the transport and the scrubber left to right", async () => {
    const page = await open(undefined);
    try {
        await show(page, playing({ skipMarker: { kind: "intro", startSeconds: 20, endSeconds: 60 }, positionSeconds: 25, bufferingPill: PROMPT, buffering: false }));
        assert.equal(await direction(page, "section.player"), "ltr");
        assert.ok(await center(page, ".player-skip") > MIDDLE);
        assert.ok(await center(page, ".player-buffering") > MIDDLE);
        assert.ok(await center(page, '[data-focus="backward"]') < await center(page, '[data-focus="forward"]'));
    } finally { await page.close(); }
});

test("the transport, the scrubber and a held seek keep the remote's physical keys in Arabic", async () => {
    const page = await open("ar");
    try {
        await show(page, playing());
        await page.locator('[data-focus="pause"]').focus();
        await remote(page, RIGHT);
        assert.equal(await focusedId(page), "forward", "Right is the next button to the right, as on the screen");
        await remote(page, LEFT);
        await remote(page, LEFT);
        assert.equal(await focusedId(page), "backward");
        await page.locator('[data-focus="position"]').focus();
        await page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { keyCode: 39, bubbles: true, cancelable: true })));
        await page.clock.fastForward(1500);
        assert.equal(await page.locator(".player-bar-preview").count(), 1, "a held Right opens the scrub preview");
        assert.ok(Number(await page.getByRole("slider").getAttribute("aria-valuenow")) > 754, "and moves it forward, left to right");
    } finally { await page.close(); }
});

test("the options panel reads from the right in Arabic: the tab rail, the rows, the chevrons and the columns", async () => {
    const page = await open("ar");
    try {
        await show(page, playing());
        await openPanel(page);
        assert.ok(await center(page, ".player-tab:nth-child(1)") > await center(page, ".player-tab:nth-child(2)"), "Info is the right-most tab");
        const info = await page.locator(".player-menu-info .player-info-row").first().evaluate(row => {
            const label = row.querySelector(".player-info-label")?.getBoundingClientRect();
            const value = row.querySelector(".player-info-value")?.getBoundingClientRect();
            return { label: (label?.left ?? 0) + (label?.width ?? 0) / 2, value: (value?.left ?? 0) + (value?.width ?? 0) / 2 };
        });
        assert.ok(info.label > info.value, "the label starts on the right, the value on the left");
        await remote(page, UP);
        assert.equal(await page.locator(".player-tab[aria-selected=true]").textContent(), text("options.tabInfo", "ar"));
        await remote(page, RIGHT);
        assert.equal(await page.locator(".player-tab[aria-selected=true]").textContent(), text("options.tabInfo", "ar"), "Right is toward the start of the rail: nothing before Info");
        await remote(page, LEFT);
        assert.equal(await page.locator(".player-tab[aria-selected=true]").textContent(), text("options.tabStats", "ar"), "Left is the next tab, as on the screen");
        await remote(page, LEFT);
        await remote(page, DOWN);
        assert.equal(await page.locator(".player-tab[aria-selected=true]").textContent(), text("options.tabVideo", "ar"));
        const chevron = page.locator('[data-focus="video-aspect"] .player-setting-chevron svg');
        assert.equal(await chevron.evaluate(node => getComputedStyle(node).transform), "matrix(-1, 0, 0, 1, 0, 0)", "chevron.forward points left");
        const row = await page.locator('[data-focus="video-aspect"]').evaluate(node => {
            const value = node.querySelector(".player-setting-value")?.getBoundingClientRect();
            const mark = node.querySelector(".player-setting-chevron")?.getBoundingClientRect();
            return { value: value?.left ?? 0, chevron: mark?.left ?? 0 };
        });
        assert.ok(row.chevron < row.value, "the chevron ends the row on the left");
    } finally { await page.close(); }
});

for (const language of [undefined, "ar"]) {
    test(`Left and Right cross a pane's columns by the layout (${language ?? "en"})`, async () => {
        const page = await open(language);
        try {
            await show(page, playing());
            await openPanel(page, 4);
            const columns = page.locator(".player-menu-subtitles .player-menu-column");
            assert.ok(await columns.count() >= 2, "Subtitles has two columns");
            const first = await columns.nth(0).evaluate(node => node.getBoundingClientRect().left);
            const second = await columns.nth(1).evaluate(node => node.getBoundingClientRect().left);
            assert.equal(first < second, language === undefined, "the first column is on the left in English, on the right in Arabic");
            assert.equal(await columns.nth(0).locator(":focus").count(), 1, "the pane opens in its first column");
            await remote(page, toEnd(page));
            assert.equal(await columns.nth(1).locator(":focus").count(), 1, "toward the end of the row is the second column");
            await remote(page, toStart(page));
            assert.equal(await columns.nth(0).locator(":focus").count(), 1);
        } finally { await page.close(); }
    });

    test(`Up Next reads from its leading side and Left and Right step its buttons by the layout (${language ?? "en"})`, async () => {
        const page = await open(language);
        try {
            await show(page, promptView());
            const next = await center(page, '[data-focus="play-next"]');
            const keep = await center(page, '[data-focus="keep-watching"]');
            assert.equal(next < keep, language === undefined, "Play Now leads the row");
            assert.equal(await center(page, ".player-next-up .player-title") > MIDDLE, language === undefined, "the panel is on the right in English, on the left in Arabic");
            const captions = await page.locator(".player-captions").evaluate(node => (node.parentElement as HTMLElement).style.transform);
            assert.ok(captions.startsWith(`translate(${language === undefined ? 180 : 980}px, 112px)`), `the caption box follows the preview: ${captions}`);
            // PlayerView.actionRow's two rows, then On Deck: Left and Right stay in a row (by the layout), Up and Down move between rows (#721).
            await page.locator('[data-focus="play-next"]').focus();
            await remote(page, toEnd(page));
            assert.equal(await focusedId(page), "play-next", "the ring takes no focus, so Play Now ends its row");
            await remote(page, DOWN);
            assert.equal(await focusedId(page), "keep-watching", "Down goes to the second row");
            await remote(page, toEnd(page));
            assert.equal(await focusedId(page), "back", "Close follows Keep Watching in its row");
            await remote(page, toStart(page));
            assert.equal(await focusedId(page), "keep-watching");
            await remote(page, toEnd(page));
            await remote(page, UP);
            assert.equal(await focusedId(page), "play-next", "Up from Close goes to the first row, not back along the second");
            await remote(page, DOWN);
            await remote(page, DOWN);
            // PlayerView.focusBelowActions and focusAboveOnDeck (silo-apple 449ba47 PlayerView.swift:1640-1652): the Auto-play toggle sits between (#759).
            assert.equal(await focusedId(page), "auto-play", "Down from the second row goes to the Auto-play toggle");
            await remote(page, DOWN);
            assert.equal(await focusedId(page), "deck:next", "then On Deck");
            await remote(page, UP);
            assert.equal(await focusedId(page), "auto-play", "and Up comes back to the toggle");
        } finally { await page.close(); }
    });

    test(`the buffering card's two buttons mirror and Left and Right choose by the layout (${language ?? "en"})`, async () => {
        const page = await open(language);
        try {
            await show(page, playing({ bufferingPill: PROMPT, buffering: false }));
            const primary = await center(page, '[data-focus="buffering-primary"]');
            const keep = await center(page, '[data-focus="buffering-keep"]');
            assert.equal(primary < keep, language === undefined, "Lower quality leads");
            assert.equal(await focusedId(page), "buffering-primary");
            await remote(page, toEnd(page));
            assert.equal(await focusedId(page), "buffering-keep", "toward the end of the row");
            await remote(page, toStart(page));
            assert.equal(await focusedId(page), "buffering-primary");
            await show(page, playing({ bufferingPill: PROMPT, buffering: false }));
            await page.clock.runFor(6000);
            assert.equal(await page.locator(".player-overlay-hidden").count(), 1, "the controls are hidden");
            await remote(page, toEnd(page));
            assert.equal(await page.locator(".player-buffering-lit").innerText(), text("bufferingQuality.prompt.keep", language ?? "en"), "with the controls hidden, the button the press moves toward is lit");
            await remote(page, toStart(page));
            assert.equal(await page.locator(".player-buffering-lit").innerText(), text("bufferingQuality.prompt.lower", language ?? "en"));
        } finally { await page.close(); }
    });

    test(`the error page's two buttons mirror (${language ?? "en"})`, async () => {
        const page = await open(language);
        try {
            await show(page, { phase: "error", title: "The Movie", error: { kind: "network" }, retryable: true });
            const retry = await center(page, '[data-focus="settings-retry"]');
            const goBack = await center(page, '[data-focus="back"]');
            assert.equal(retry < goBack, language === undefined, "Retry leads the row");
            assert.equal(await direction(page, ".player-error"), language === undefined ? "ltr" : "rtl");
            // An English message keeps its own direction on the mirrored page: it reads from the left, its full stop last.
            await show(page, { phase: "error", title: "The Movie", error: { kind: "server" }, retryable: true });
            const [first, stop] = await page.locator(".player-error-text").evaluate(node => [0, (node.textContent ?? "").length - 1].map(at => {
                const range = document.createRange();
                range.setStart(node.firstChild!, at);
                range.setEnd(node.firstChild!, at + 1);
                return range.getBoundingClientRect().left;
            }));
            assert.ok((first ?? 0) < (stop ?? 0), `the first letter (${first}) sits left of the full stop (${stop})`);
        } finally { await page.close(); }
    });
}

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

test("a German catalog that lands while the end-of-playback card is up redraws its status line too", async () => {
    // The view carries the status line's key, not English text, so the card's late redraw reads it in the new language.
    const page = await open(undefined);
    try {
        await show(page, { phase: "completion", status: "upNext.headingFinished", state: "ready", next: undefined, retryable: false });
        assert.equal(await page.locator(".player-next-eyebrow").textContent(), "Finished");
        await page.evaluate(strings => window.player.setLanguage("de", strings), catalog("de"));
        await page.waitForFunction(expected => document.querySelector(".player-next-up .player-title")?.textContent === expected, text("upNext.endOfPlayback", "de"));
        assert.equal(await page.locator(".player-next-eyebrow").textContent(), text("upNext.headingFinished", "de"));
    } finally { await page.close(); }
});

// The background still leaves the video preview clear, and the preview sits on the right in Arabic (Apple's HStack mirrors), so the cut-out does too.
test("in Arabic the background still's cut-out follows the preview to the right", async () => {
    const page = await open("ar");
    try {
        await show(page, playing({ upNext: { next: { ...NEXT, backdropUrl: "/images/next.jpg" }, deck: [], countdown: 30, status: "Up Next" } }));
        const clip = await page.locator(".player-next-backdrop").evaluate(node => getComputedStyle(node).clipPath);
        assert.ok(clip.includes("980px 112px") && !clip.includes("180px 112px"), `the cut-out starts at x = 980: ${clip}`);
    } finally { await page.close(); }
});

test("an Arabic catalog that lands while Up Next is up mirrors the panel and moves the caption box with it", async () => {
    const page = await open(undefined);
    const box = (): Promise<string> => page.locator(".player-captions").evaluate(node => (node.parentElement as HTMLElement).style.transform);
    // The caption line must be drawn, with an area, inside the scaled preview (UP_NEXT_PREVIEW at upNextPreviewLeft), not merely start
    // with the right translate: a trailing scale(0) or an empty line would leave nothing to read.
    const insidePreview = async (rightToLeft: boolean): Promise<void> => {
        const line = await page.locator(".player-captions span").first().evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, text: node.textContent }; });
        const left = upNextPreviewLeft(1920, rightToLeft);
        const preview = { left, top: UP_NEXT_PREVIEW.top, right: left + UP_NEXT_PREVIEW.width, bottom: UP_NEXT_PREVIEW.top + UP_NEXT_PREVIEW.height };
        assert.equal(line.text, "A visible line");
        assert.ok(line.right - line.left > 0 && line.bottom - line.top > 0, `the line has an area: ${JSON.stringify(line)}`);
        assert.ok(line.left >= preview.left && line.right <= preview.right && line.top >= preview.top && line.bottom <= preview.bottom, `the line sits inside the preview ${JSON.stringify(preview)}: ${JSON.stringify(line)}`);
    };
    try {
        await show(page, promptView());
        assert.equal(await direction(page, "section.player"), "ltr");
        assert.ok(await center(page, ".player-next-up .player-title") > MIDDLE, "English: the panel is on the right");
        assert.ok((await box()).startsWith("translate(180px, 112px)"), "English: the caption box sits over the preview on the left");
        await insidePreview(false);
        await page.evaluate(strings => window.player.setLanguage("ar", strings), catalog("ar"));
        await page.waitForFunction(() => document.querySelector("section.player")?.getAttribute("dir") === "rtl");
        assert.equal(await direction(page, ".player-next-up"), "rtl");
        assert.ok(await center(page, ".player-next-up .player-title") < MIDDLE, "Arabic: the panel moves to the left");
        assert.ok((await box()).startsWith("translate(980px, 112px)"), `Arabic: the caption box moves with the preview to the right: ${await box()}`);
        await insidePreview(true);
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
        assert.equal(await page.evaluate(() => window.player.refreshes), 0, "the controller is not asked to send its view again while Select is held");
        await page.keyboard.up("Enter");
        await page.clock.runFor(50);
        assert.equal(await page.locator(".player-menu-audio .player-menu-heading").textContent(), upper(text("player.hud.tracks", "de"), "de"), "German once it is released");
        assert.deepEqual(await page.evaluate(() => window.player.commands.filter(command => command.startsWith("selectAudio"))), ["selectAudio a0"], "the press still acted on release");
        assert.equal(await page.evaluate(() => window.player.refreshes), 1, "and it is asked once after the release");
    } finally { await page.close(); }
});

const press = async (page: Page, focusId: string): Promise<void> => {
    await page.locator(`[data-focus="${focusId}"]`).focus();
    await remote(page, ENTER);
};
const picker = (page: Page) => page.locator(".player-menu-picker");
const landGerman = (page: Page): Promise<void> => page.evaluate(strings => window.player.setLanguage("de", strings), catalog("de"));
const focusedId = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute("data-focus") ?? null);

test("an Aspect picker that is open when German lands is drawn again in German, with the focus on its option", async () => {
    const page = await open(undefined);
    try {
        await show(page, playing({ hud: { ...HUD, speeds: [1, 2] } }));
        await openPanel(page, 2);
        await press(page, "video-aspect");
        assert.equal(await picker(page).getAttribute("aria-label"), "Aspect");
        assert.deepEqual(await texts(page, ".player-menu-picker .player-choice-label"), ["Fit", "Stretch"]);
        assert.equal(await focusedId(page), "subtitle-picker:Fit");
        await landGerman(page);
        await page.waitForFunction(title => document.querySelector(".player-menu-picker")?.getAttribute("aria-label") === title, text("player.hud.aspect", "de"));
        assert.equal(await picker(page).locator(".player-menu-picker-title").textContent(), text("player.hud.aspect", "de"));
        assert.deepEqual(await texts(page, ".player-menu-picker .player-choice-label"), [text("player.aspect.fit", "de"), text("player.aspect.stretch", "de")]);
        assert.equal(await focusedId(page), "subtitle-picker:Fit", "the focus stays on the option it was on");
    } finally { await page.close(); }
});

test("a Subtitle Delay picker opened from the Subtitles tab is drawn again in German", async () => {
    const page = await open(undefined);
    try {
        await show(page, playing());
        await openPanel(page, 4);
        await press(page, "subtitle-delay");
        assert.equal(await picker(page).getAttribute("aria-label"), "Subtitle Delay");
        await landGerman(page);
        await page.waitForFunction(title => document.querySelector(".player-menu-picker")?.getAttribute("aria-label") === title, text("player.settings.subtitleDelayTitle", "de"));
        assert.equal(await focusedId(page), "subtitle-picker:0");
    } finally { await page.close(); }
});

test("a subtitle Appearance picker that is open when German lands is drawn again in German, and Back still closes it", async () => {
    const page = await open(undefined);
    try {
        await show(page, playing());
        await openPanel(page, 4);
        await press(page, "subtitle-appearance");
        await press(page, "subtitle-appearance:fontSize");
        assert.equal(await picker(page).getAttribute("aria-label"), "Subtitle Size");
        assert.deepEqual((await texts(page, ".player-menu-picker .player-choice-label")).slice(0, 2), ["Small", "Medium"]);
        assert.equal(await focusedId(page), "subtitle-picker:large", "the current size");
        await landGerman(page);
        await page.waitForFunction(title => document.querySelector(".player-menu-picker")?.getAttribute("aria-label") === title, text("player.hud.pickerSubtitleSize", "de"));
        assert.deepEqual((await texts(page, ".player-menu-picker .player-choice-label")).slice(0, 2), [text("player.subtitles.size.small", "de"), text("player.subtitles.size.medium", "de")]);
        assert.equal(await focusedId(page), "subtitle-picker:large", "the focus stays on the current size");
        await remote(page, 10009);
        assert.equal(await picker(page).count(), 0, "Back closes the picker");
        assert.equal(await page.locator('[data-focus="subtitle-appearance:fontSize"]').count(), 1, "and returns to the Appearance rows");
    } finally { await page.close(); }
});
