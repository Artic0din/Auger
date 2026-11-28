import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY, AUDIOBOOK_SEEK_BACK_KEY, AUDIOBOOK_SEEK_FORWARD_KEY, THEME_MUSIC_ENABLED_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeAudiobooks } from "../native/support/fakeAudiobooks.ts";
import { FakePlayback } from "../native/support/fakePlayback.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { FakeThemes } from "../native/support/fakeThemes.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { openTv, pauseTvClock, type Tv } from "./support/tv.ts";

const ENTER = 13;
const BACK = 10009;
const LEFT = 37;
const UP = 38;
const RIGHT = 39;
const DOWN = 40;
const PLAY_PAUSE = 10252;
const REWIND = 412;
const STOP = 413;
const FAST_FORWARD = 417;

let browser: Browser;
before(async () => {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
});
after(async () => { await browser.close(); });

interface Rig {
    readonly tv: Tv;
    readonly catalog: FakeAudiobooks;
    readonly playback: FakePlayback;
    readonly settings: FakeSettings;
}

async function setupApp(setup?: (rig: Rig) => void): Promise<Rig> {
    const tv = await openTv(browser, { app: "application" });
    const catalog = new FakeAudiobooks();
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    const playback = new FakePlayback(tv.fake);
    catalog.registerAudiobookMediaFiles(playback);
    const rig: Rig = { tv, catalog, playback, settings };
    setup?.(rig);

    await tv.page.emulateMedia({ reducedMotion: "reduce" });
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: "Connect", exact: true }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop() ?? "";
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.page.locator('[data-screen="approved"], [data-screen="notice"], [data-screen="profiles"]').first().waitFor();
    if (await tv.screen() === "approved") await tv.jump(1000);
    await tv.page.locator('[data-screen="notice"], [data-screen="profiles"]').first().waitFor();
    if (await tv.screen() === "notice") await tv.page.getByRole("button", { name: "Continue", exact: true }).click();
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-focus="ask-every-launch"]').click();
    await tv.page.locator('[data-view="home"] [data-section="shelf"] [data-focus="audiobook:tide"]').waitFor();
    return rig;
}

async function prepareAudio(tv: Tv, withSetSpeed = true): Promise<void> {
    await tv.page.evaluate((enableSpeed) => {
        const avplay = window.appHarness.avplay as unknown as Record<string, unknown>;
        if (enableSpeed && typeof avplay.setSpeed !== "function") {
            avplay.setSpeed = (value: number) => {
                (avplay.calls as string[]).push(`setSpeed ${value}`);
            };
        }
    }, withSetSpeed);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "AVPlay audiobook prepare");
    await tv.page.evaluate(() => {
        const avplay = window.appHarness.avplay;
        avplay.finishPrepare();
        if (avplay.calls[avplay.calls.length - 1]?.startsWith("seekTo") === true) {
            avplay.finishSeek();
        }
    });
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PLAYING"), "audio PLAYING");
}

function playerTest(name: string, body: (r: Rig) => Promise<void>, setup?: (r: Rig) => void): void {
    test(name, async () => {
        const r = await setupApp(setup);
        try {
            await body(r);
            assert.deepEqual(r.tv.console, []);
        } finally {
            await r.tv.page.context().close();
        }
    });
}

playerTest("audiobook player renders cover, metadata, scrubber ticks, transport, and refreshes detail on Stop Listening", async ({ tv, catalog }) => {
    assert.equal(await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count(), 0);
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");

    await tv.page.locator('[data-screen="audiobook-player"]').waitFor();
    await prepareAudio(tv, true);
    assert.equal(await tv.page.locator('.audio-avplay-surface object[type="application/avplayer"]').count(), 1);

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await screen.locator(".audio-player-scrubber").waitFor();
    assert.equal(await screen.locator(".audio-player-eyebrow").textContent(), "Audiobook");
    assert.equal(await screen.locator(".audio-player-title").innerText(), "Stormlight Archive 5 - The Tide Owes (5 of 5)");
    assert.equal(await screen.locator(".audio-player-author").innerText(), "Brandon Sanderson");
    assert.equal(await screen.locator(".audio-player-chapter").innerText(), "Chapter 2 of 3 · What the Tide Owes");
    assert.equal(await screen.locator(".audio-player-scrubber-tick").count(), 2);
    assert.deepEqual(
        await screen.locator(".audio-player-scrubber").evaluate(el => [...el.children].map(c => c.className)),
        ["audio-player-scrubber-fill", "audio-player-scrubber-ticks", "audio-player-scrubber-pending"],
    );
    assert.equal(await screen.locator(".audio-player-elapsed").innerText(), "1:08:32");
    assert.equal(await screen.locator(".audio-player-remaining").innerText(), "-1:51:28");

    const artBox = await screen.locator(".audio-player-art-frame").boundingBox();
    assert.ok(artBox !== null && Math.round(artBox.width) === 620 && Math.round(artBox.height) === 620);
    assert.equal(await screen.locator(".audio-player-art").evaluate(el => getComputedStyle(el).display !== "none"), true);
    assert.equal(await screen.locator(".audio-player-art-fallback").evaluate(el => getComputedStyle(el).display), "none");

    // Focused control starts on play-pause. Toggle pause -> play via Enter and MediaPlayPause.
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "play-pause");
    await tv.remote(ENTER);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PAUSED"), "paused via Enter");
    await tv.remote(PLAY_PAUSE);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PLAYING"), "resumed via MediaPlayPause");

    // Advance playhead slightly then move to Stop Listening in options row ([speed, sleep, chapters, stop]).
    await tv.page.evaluate(() => window.appHarness.avplay.tick(4500 * 1000));
    await tv.eventually(async () => await screen.locator(".audio-player-elapsed").innerText() === "1:15:00", "updated elapsed");
    await tv.remote(DOWN);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "speed");
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "stop");
    await tv.remote(ENTER);

    await tv.page.locator('[data-view="audiobook:audiobook:tide"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="audiobook-player"]').count(), 0);
    assert.equal(await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count(), 0);
    assert.equal(catalog.progressWrites.at(-1)?.positionMs, 4_500_000);
});

playerTest("audiobook skip intervals use profile settings, scrubber skips, Speed menu honors AVPlay limits, and Sleep timer pauses at expiry", async ({ tv, playback }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await screen.locator(".audio-player-scrubber").waitFor();

    // Profile settings configured 15 s back / 45 s forward in setup hook below.
    assert.equal(await screen.locator('[data-key="skip-back"]').getAttribute("aria-label"), "Back 15 seconds");
    assert.equal(await screen.locator('[data-key="skip-forward"]').getAttribute("aria-label"), "Forward 45 seconds");

    // Scrubber Left/Right jumps using profile skip intervals.
    await tv.remote(UP);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "scrubber");
    await tv.remote(RIGHT);
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(async () => await screen.locator(".audio-player-elapsed").innerText() === "1:09:17", "4112 + 45 = 4157");
    await tv.remote(FAST_FORWARD);
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(async () => await screen.locator(".audio-player-elapsed").innerText() === "1:10:02", "+45 = 4202");
    await tv.remote(REWIND);
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(async () => await screen.locator(".audio-player-elapsed").innerText() === "1:09:47", "-15 = 4187");

    // Speed menu offers [1, 2] on http_progressive with setSpeed; picking 2x calls avplay.setSpeed(2).
    await tv.remote(DOWN);
    await tv.remote(DOWN);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "speed");
    await tv.remote(ENTER);
    await screen.locator('[role="dialog"]').waitFor();
    assert.deepEqual(await screen.locator('[role="dialog"] [data-rate]').allInnerTexts(), ["1×", "2×"]);
    assert.equal(await screen.locator(".audio-player-shell").evaluate(el => (el as HTMLElement).inert), true);
    await tv.page.keyboard.press("Tab");
    assert.equal(await screen.locator('[role="dialog"] :focus').getAttribute("data-rate"), "2");
    await tv.page.keyboard.press("Shift+Tab");
    assert.equal(await screen.locator('[role="dialog"] :focus').getAttribute("data-rate"), "1");
    await tv.remote(DOWN);
    await tv.remote(ENTER);
    assert.equal(await screen.locator(".audio-player-shell").evaluate(el => (el as HTMLElement).inert), false);
    await tv.eventually(async () => await screen.locator('[data-key="speed"]').innerText() === "2×", "2x badge");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.includes("setSpeed 2")), true);

    // Sleep timer menu offers Off / 15 / 30 / 60 min, remembers active preset on reopen, ticks down, and pauses playback on expiry.
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "sleep");
    await tv.remote(ENTER);
    await screen.locator('[role="dialog"]').waitFor();
    assert.deepEqual(await screen.locator('[role="dialog"] [data-sleep-minutes]').evaluateAll(els => els.map(e => e.getAttribute("data-sleep-minutes"))), ["0", "15", "30", "60"]);
    await tv.remote(DOWN);
    await tv.remote(ENTER);
    await tv.eventually(async () => await screen.locator('[data-key="sleep"]').innerText() === "15:00", "sleep timer active");

    await tv.jump(60_000);
    await tv.eventually(async () => await screen.locator('[data-key="sleep"]').innerText() === "14:00", "sleep timer counted down");
    await tv.remote(ENTER);
    await screen.locator('[role="dialog"]').waitFor();
    assert.equal(await screen.locator('[role="dialog"] :focus').getAttribute("data-sleep-minutes"), "15");
    assert.equal(await screen.locator('[data-sleep-minutes="15"]').getAttribute("aria-checked"), "true");
    assert.equal(await screen.locator('[data-sleep-minutes="0"]').getAttribute("aria-checked"), "false");
    assert.equal(await screen.locator('[data-sleep-minutes="15"] .audio-player-modal-row-check svg').count(), 1);
    await tv.remote(BACK);

    await tv.jump(14 * 60 * 1000);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PAUSED"), "sleep timer paused playback");
    assert.equal(await screen.locator('[data-key="sleep"]').innerText(), "Sleep");

    // Stop cleanly and verify HLS restricts speed options to [1].
    playback.next.push({ protocol: "hls", delivery: "server_transcode_hls", url: sessionId => `/api/v2/stream/${sessionId}.m3u8?st=signed` });
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "stop");
    await tv.remote(ENTER);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);
    await tv.remote(DOWN);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "speed");
    await tv.remote(ENTER);
    await screen.locator('[role="dialog"]').waitFor();
    assert.deepEqual(await screen.locator('[role="dialog"] [data-rate]').allInnerTexts(), ["1×"]);
    await tv.remote(BACK);
    assert.equal(await screen.locator('[role="dialog"]').count(), 0);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "speed");
}, ({ settings }) => {
    settings.profile().set(AUDIOBOOK_SEEK_BACK_KEY, 15);
    settings.profile().set(AUDIOBOOK_SEEK_FORWARD_KEY, 45);
});

playerTest("Chapters sheet focuses active NOW chapter, localizes untitled chapters, and jumps on selection; Next Chapter crosses chapter boundary", async ({ tv }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await screen.locator(".audio-player-scrubber").waitFor();

    // Open Chapters sheet from options row; Chapter 2 should be focused with NOW badge, Chapter 3 localized.
    await tv.remote(DOWN);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "chapters");
    await tv.remote(ENTER);
    await screen.locator('[role="dialog"]').waitFor();
    assert.equal(await screen.locator('[role="dialog"] :focus').getAttribute("data-chapter-index"), "1");
    assert.equal(await screen.locator('[role="dialog"] .audio-player-now-badge').count(), 1);
    assert.match(await screen.locator('[data-chapter-index="2"]').innerText(), /Chapter 3/);

    // Select Chapter 1 -> closes sheet, seeks to 0, restores focus to Chapters button.
    await tv.remote(UP);
    await tv.remote(ENTER);
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(async () => await screen.locator(".audio-player-elapsed").innerText() === "0:00", "jumped to chapter 1");
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "chapters");

    // Navigate up to Next Chapter transport button -> jumps to Chapter 2 (1:00:00).
    await tv.remote(UP);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "next-chapter");
    await tv.remote(ENTER);
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(async () => await screen.locator(".audio-player-elapsed").innerText() === "1:00:00", "jumped to chapter 2");
});

playerTest("chapterless audiobook disables chapter buttons, hides missing cover, and Back exits cleanly from error state with Retry support", async ({ tv, playback }) => {
    // Failure & Retry on first start
    playback.next.push({ terminal: "no_route", retryable: true });
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:fresh"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:fresh"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await screen.locator('[data-key="retry"]').waitFor();
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "retry");
    await tv.remote(ENTER);
    await prepareAudio(tv, false);

    // Retry succeeded without setSpeed -> [1] rate only.
    await tv.remote(DOWN);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "speed");
    await tv.remote(ENTER);
    assert.deepEqual(await screen.locator('[role="dialog"] [data-rate]').allInnerTexts(), ["1×"]);
    await tv.remote(BACK);
    await tv.remote(STOP);
    await tv.page.locator('[data-view="audiobook:audiobook:fresh"] [data-focus="play"]').waitFor();

    // Open chapterless book without poster_url via scripted responses.
    const plainBookReply = {
        status: 200,
        body: {
            content_id: "audiobook:fresh", type: "audiobook", title: "Short Story", genres: ["Fantasy"],
            cast: [], crew: [], ratings: [], subtitles: [], keywords: [], status: "matched",
            user_data: { played: false, position_seconds: 0 },
            versions: [{ file_id: "af-p1", presentation_kind: "audiobook_part", presentation_part_index: 1, duration: 600, codec_audio: "mp3", container: "mp3", chapters: [] }],
            audiobook: { authors: [{ name: "Susanna Clarke" }], narrators: [], total_duration_seconds: 600 },
        },
    };
    tv.fake.scripted.set("/catalog/items/audiobook%3Afresh?image_size=large", [plainBookReply, plainBookReply, plainBookReply]);
    tv.fake.scripted.set("/playback/start", [problem(503, "unavailable", "Busy")]);
    await tv.page.keyboard.press("Enter");
    await screen.locator('[data-key="done"]').waitFor();
    assert.equal(await screen.locator('[data-key="retry"]').getAttribute("data-key"), "retry");
    tv.fake.scripted.delete("/playback/start");
    await tv.remote(ENTER);
    await prepareAudio(tv, false);

    assert.equal(await screen.locator(".audio-player-art").evaluate(el => getComputedStyle(el).display), "none");
    assert.equal(await screen.locator(".audio-player-art-fallback").evaluate(el => getComputedStyle(el).display), "flex");
    assert.equal(await screen.locator('[data-key="prev-chapter"]').getAttribute("aria-disabled"), "true");
    assert.equal(await screen.locator('[data-key="next-chapter"]').getAttribute("aria-disabled"), "true");
    assert.equal(await screen.locator('[data-key="chapters"]').getAttribute("aria-disabled"), "true");
    assert.equal(await screen.locator(".audio-player-chapter").count(), 1);
    assert.equal(await screen.locator(".audio-player-chapter").isHidden(), true);

    // Transport focus skips disabled chapter controls cleanly.
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "skip-forward");
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "skip-forward");
    await tv.remote(LEFT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "play-pause");
    await tv.remote(LEFT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "skip-back");
});

playerTest("loading screen focuses Cancel, stopping screen swallows Back during slow shutdown, and AVPlay surface waits for unsettled seek close", async ({ tv }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await screen.locator('[data-key="cancel"]').waitFor();
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "cancel");
    assert.equal(await screen.locator('[data-key="cancel"]').innerText(), "Cancel");
    await tv.remote(ENTER);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    assert.equal(await screen.count(), 0);

    // Start again, settle playback, hold /sync/progress and verify visible stopping screen blocks Exit dialog.
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);
    const heldSync = tv.fake.hold("/sync/progress");
    await tv.remote(DOWN);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "stop");
    await tv.remote(ENTER);

    await screen.waitFor();
    assert.equal(await screen.getAttribute("data-stopping"), "true");
    await tv.remote(BACK);
    assert.equal(await tv.page.locator('[role="alertdialog"]').count(), 0);
    assert.equal(await screen.count(), 1);
    heldSync.release();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    assert.equal(await screen.count(), 0);

    // Start a third time, queue an unsettled seek, stop playback, and verify Browse stays hidden with stopping screen until seekTo settles close() and detaches surface.
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);
    const closesBeforeThirdStop = await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(c => c === "close").length);
    await tv.remote(FAST_FORWARD);
    await tv.remote(DOWN);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    const deletesBefore = tv.fake.requests.filter(req => req.method === "DELETE" && req.path.startsWith("/playback/")).length;
    const syncsBefore = tv.fake.requests.filter(req => req.method === "POST" && req.path === "/sync/progress").length;
    await tv.remote(ENTER);
    await tv.eventually(
        async () =>
            tv.fake.requests.filter(req => req.method === "DELETE" && req.path.startsWith("/playback/")).length === deletesBefore + 1
            && tv.fake.requests.filter(req => req.method === "POST" && req.path === "/sync/progress").length === syncsBefore + 1
            && tv.pendingReplies === 0,
        "stop network requests landed",
    );
    await tv.page.evaluate(() => Promise.resolve().then(() => Promise.resolve()));
    assert.equal(await screen.getAttribute("data-stopping"), "true");
    assert.equal(await tv.page.locator('[data-view="audiobook:audiobook:tide"]').isHidden(), true);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(c => c === "close").length), closesBeforeThirdStop);
    assert.equal(await tv.page.locator('.audio-avplay-surface object[type="application/avplayer"]').count(), 1);

    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(
        async () => await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(c => c === "close").length) === closesBeforeThirdStop + 1,
        "deferred close after seek settle",
    );
    await tv.eventually(async () => await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count() === 0, "surface detached after close");
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    assert.equal(await screen.count(), 0);
});

playerTest("held Select activates error, transport, and modal actions once on release", async ({ tv, playback }) => {
    playback.next.push({ terminal: "no_route", retryable: true });
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await screen.locator('[data-key="retry"]').waitFor();
    const startsBeforeRetry = tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length;
    assert.equal(await tv.down(DOWN), true, "Up/Down keys on error screen are prevented");
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "retry");

    await tv.down(ENTER, false);
    await tv.down(ENTER, true);
    await tv.down(ENTER, true);
    assert.equal(tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length, startsBeforeRetry);
    await tv.up(ENTER);
    await prepareAudio(tv, true);

    // Tab moving DOM focus dispatches Select to the focused button rather than stale play-pause.
    await tv.page.keyboard.press("Tab");
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "skip-forward");
    await tv.remote(ENTER);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.calls.some(call => call === "seekTo 4142000")), "skip-forward activated after Tab");
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PLAYING");
    await tv.remote(LEFT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "play-pause");

    // Transport play-pause acts only on Enter release, and blur cancels a held press.
    await tv.down(ENTER, false);
    await tv.page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await tv.up(ENTER);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PLAYING");

    await tv.down(ENTER, false);
    await tv.down(ENTER, true);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PLAYING");
    await tv.up(ENTER);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PAUSED"), "paused on release");

    // Modal selection acts only on Enter release.
    await tv.remote(DOWN);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "speed");
    await tv.remote(ENTER);
    await screen.locator('[role="dialog"]').waitFor();
    await tv.remote(DOWN);
    assert.equal(await screen.locator('[role="dialog"] :focus').getAttribute("data-rate"), "2");
    await tv.down(ENTER, false);
    await tv.down(ENTER, true);
    assert.equal(await screen.locator('[role="dialog"]').count(), 1);
    assert.equal(await screen.locator('[data-key="speed"]').innerText(), "1×");
    await tv.up(ENTER);
    await tv.eventually(async () => await screen.locator('[data-key="speed"]').innerText() === "2×", "speed changed on release");
    assert.equal(await screen.locator('[role="dialog"]').count(), 0);
});

playerTest("modal scrolling uses SkylineScroll instead of browser scrollIntoView", async ({ tv }) => {
    const longChapters = Array.from({ length: 20 }, (_, index) => ({
        index,
        title: `Chapter ${index + 1}: Long Journey`,
        start_seconds: index * 300,
        end_seconds: (index + 1) * 300,
        source: "embedded",
    }));
    const longBookReply = {
        status: 200,
        body: {
            content_id: "audiobook:fresh", type: "audiobook", title: "Long Chapters Book", genres: ["Fantasy"],
            poster_url: "/art/audiobook%3Afresh.svg",
            cast: [], crew: [], ratings: [], subtitles: [], keywords: [], status: "matched",
            user_data: { played: false, position_seconds: 12 * 300 },
            versions: [{ file_id: "af-p1", presentation_kind: "audiobook_part", presentation_part_index: 1, duration: 6000, codec_audio: "mp3", container: "mp3", chapters: longChapters }],
            audiobook: { authors: [{ name: "Susanna Clarke" }], narrators: [], total_duration_seconds: 6000 },
        },
    };
    tv.fake.scripted.set("/catalog/items/audiobook%3Afresh?image_size=large", [longBookReply, longBookReply]);
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:fresh"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:fresh"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, false);

    await tv.page.evaluate(() => {
        const w = window as unknown as { __scrollIntoViewCalls?: number };
        w.__scrollIntoViewCalls = 0;
        Element.prototype.scrollIntoView = () => {
            w.__scrollIntoViewCalls = (w.__scrollIntoViewCalls ?? 0) + 1;
        };
    });

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await tv.remote(DOWN);
    await tv.remote(RIGHT);
    await tv.remote(RIGHT);
    assert.equal(await screen.locator(":focus").getAttribute("data-key"), "chapters");
    await tv.remote(ENTER);
    await screen.locator('[role="dialog"]').waitFor();
    assert.equal(await screen.locator('[role="dialog"] :focus').getAttribute("data-chapter-index"), "12");
    await tv.eventually(async () => (await screen.locator(".audio-player-modal-list").evaluate(el => el.scrollTop)) > 0, "modal scrolled to focused chapter");
    await tv.remote(UP);
    await tv.remote(UP);
    await tv.remote(DOWN);
    const scrollCalls = await tv.page.evaluate(() => (window as unknown as { __scrollIntoViewCalls?: number }).__scrollIntoViewCalls ?? 0);
    assert.equal(scrollCalls, 0);
});

for (const lang of ["de", "ar"] as const) {
    playerTest(`audiobook player localizes copy (${lang}) and keeps scrubber LTR in RTL`, async ({ tv }) => {
        await tv.eventually(async () => (await tv.page.evaluate(() => document.documentElement.lang)) === lang, `catalog ${lang} loaded`);
        await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
        await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
        await tv.page.keyboard.press("Enter");
        await prepareAudio(tv, true);

        const screen = tv.page.locator('[data-screen="audiobook-player"]');
        await screen.locator(".audio-player-scrubber").waitFor();
        assert.equal(await screen.getAttribute("dir"), lang === "ar" ? "rtl" : "ltr");
        assert.equal(await screen.locator(".audio-player-progress").evaluate(el => getComputedStyle(el).direction), "ltr");
        assert.equal(await screen.locator(".audio-player-transport").evaluate(el => getComputedStyle(el).direction), "ltr");
        if (lang === "de") {
            assert.equal(await screen.locator('[data-key="stop"]').innerText(), "Wiedergabe beenden");
        }
    }, ({ settings }) => {
        settings.revision = 28;
        settings.profile().set(APP_LANGUAGE_KEY, lang);
    });
}

playerTest("natural completion waits for unsettled seek before firing finished exit, and a missing AVPlay seek callback times out to complete exit", async ({ tv, catalog }) => {
    const detailGets = (): number =>
        tv.fake.requests.filter(req => req.method === "GET" && req.path.startsWith("/catalog/items/audiobook%3Atide")).length;
    const stopDeletes = (): number =>
        tv.fake.requests.filter(req => req.method === "DELETE" && req.path.startsWith("/playback/")).length;
    const progressSyncs = (): number =>
        tv.fake.requests.filter(req => req.method === "POST" && req.path === "/sync/progress").length;

    // Part A: Natural completion while a seekTo is unsettled keeps stopping screen up (with title) until finishSeek() settles close & surface detach.
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await tv.remote(FAST_FORWARD);
    const closesBefore = await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(c => c === "close").length);
    const deletesBefore = stopDeletes();
    const syncsBefore = progressSyncs();
    const detailGetsBefore = detailGets();

    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    await tv.eventually(
        async () => stopDeletes() === deletesBefore + 1 && progressSyncs() === syncsBefore + 1 && tv.pendingReplies === 0,
        "natural completion network requests landed",
    );
    await tv.eventually(async () => await screen.getAttribute("data-stopping") === "true", "stopping screen rendered after natural completion");
    assert.equal(await screen.locator(".audio-player-title").innerText(), "Stormlight Archive 5 - The Tide Owes (5 of 5)");
    await tv.eventually(
        async () => await screen.locator(".audio-player-art").evaluate(el => getComputedStyle(el).display !== "none"),
        "stopping screen artwork visible",
    );
    assert.equal(await screen.locator(".audio-player-art-fallback").evaluate(el => getComputedStyle(el).display), "none");
    assert.equal(await tv.page.locator('[data-view="audiobook:audiobook:tide"]').isHidden(), true);
    assert.equal(detailGets(), detailGetsBefore, "onFinished exit waits for transport idle before refreshing Browse");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(c => c === "close").length), closesBefore);
    assert.equal(await tv.page.locator('.audio-avplay-surface object[type="application/avplayer"]').count(), 1);

    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(
        async () => await tv.page.evaluate(() => window.appHarness.avplay.calls.filter(c => c === "close").length) === closesBefore + 1,
        "deferred close after natural completion seek settle",
    );
    await tv.eventually(async () => await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count() === 0, "surface detached after natural completion");
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    assert.equal(await screen.count(), 0);
    await tv.eventually(async () => detailGets() === detailGetsBefore + 1 && tv.pendingReplies === 0, "detail refreshed after finished exit");
    assert.equal(catalog.progress.get("audiobook:tide"), 10800);

    // Part B: A seek whose AVPlay callback never fires times out at STARTUP_TIMEOUT_MS (15 s) so stop completes cleanly, and a late callback finishes deferred close.
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);
    await pauseTvClock(tv);
    await tv.remote(FAST_FORWARD);
    const deletesBefore2 = stopDeletes();
    const syncsBefore2 = progressSyncs();
    const detailGetsBefore2 = detailGets();

    await tv.remote(STOP);
    await tv.eventually(
        async () => stopDeletes() === deletesBefore2 + 1 && progressSyncs() === syncsBefore2 + 1 && tv.pendingReplies === 0,
        "timeout stop network requests landed",
    );
    await tv.jump(14_999);
    assert.equal(await screen.getAttribute("data-stopping"), "true");
    assert.equal(await tv.page.locator('[data-view="audiobook:audiobook:tide"]').isHidden(), true);
    assert.equal(await tv.page.locator('.audio-avplay-surface object[type="application/avplayer"]').count(), 1);
    assert.equal(detailGets(), detailGetsBefore2);

    await tv.jump(1);
    await tv.eventually(async () => await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count() === 0, "surface detached on seek timeout");
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    assert.equal(await screen.count(), 0);
    await tv.eventually(async () => detailGets() === detailGetsBefore2 + 1 && tv.pendingReplies === 0, "detail refreshed after seek timeout exit");

    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "NONE"), "late seek callback closes orphaned AVPlay");
});

playerTest("profile selection expiry tears down active audiobook host, screen, and AVPlay transport", async ({ tv }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);

    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    assert.equal(await screen.count(), 1);
    assert.equal(await tv.page.locator('.audio-avplay-surface object[type="application/avplayer"]').count(), 1);

    // Simulating TV background -> foreground triggers askEveryLaunch profile expiry in src/app.ts.
    await tv.page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
    });

    await tv.page.locator('[data-screen="profiles"]').waitFor();
    assert.equal(await screen.count(), 0);
    assert.equal(await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count(), 0);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "NONE");
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.some(call => call.startsWith("restoreAsync"))), false);

    // Selecting the profile again returns cleanly to Home (ask-every-launch was already chosen on first launch).
    await tv.page.locator('[data-focus="profile:p-owner"]').click();
    await tv.page.locator('[data-view="home"] [data-section="shelf"] [data-focus="audiobook:tide"]').waitFor();
    assert.equal(await screen.count(), 0);
});

playerTest("Back minimizes playing audio with Skyline Now Playing return and Detail resume-in-place", async ({ tv }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);

    const startsAfterPlay = tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length;

    await tv.remote(BACK);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    assert.equal(await tv.page.locator('[data-screen="audiobook-player"]').count(), 0);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.state), "PLAYING");

    // Reopen the live session in place from Detail Resume without sending a second /playback/start.
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').click();
    const screen = tv.page.locator('[data-screen="audiobook-player"]');
    await screen.locator(".audio-player-elapsed").waitFor();
    assert.equal(tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length, startsAfterPlay);

    // Minimize again, open Detail Chapters sheet on active book, and click Chapter 1 -> seeks in place without second start.
    await tv.remote(BACK);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="chapters"]').waitFor();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="chapters"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide:chapters"] .audiobook-chapter').first().click();
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.calls.some(call => call === "seekTo 0")), "chapter click seek in place");
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(async () => await screen.locator(".audio-player-elapsed").innerText() === "0:00", "chapter 1 elapsed 0:00");
    assert.equal(tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length, startsAfterPlay);

    // Minimize back to Detail, exit to Home where Skyline chrome is shown, advance while minimized, and reopen via Now Playing.
    await tv.remote(BACK);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    const pill = tv.page.locator(".skyline-now-playing");
    await pill.waitFor();
    assert.equal(await pill.locator(".skyline-now-playing-label").innerText(), "Stormlight Archive 5 - The Tide Owes (5 of 5)");
    assert.equal(await pill.evaluate(el => el.classList.contains("is-paused")), false);

    await tv.page.evaluate(() => window.appHarness.avplay.tick(4200 * 1000));
    await pill.click();
    await screen.locator(".audio-player-elapsed").waitFor();
    assert.equal(await screen.locator(".audio-player-elapsed").innerText(), "1:10:00");
    assert.equal(tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length, startsAfterPlay);
});

playerTest("minimized hardware media keys toggle play/pause keeping bar focus, seek, and stop cleanly", async ({ tv, catalog }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"]').waitFor();
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();

    const nowPlaying = tv.page.locator(".skyline-now-playing");
    await nowPlaying.waitFor();
    await nowPlaying.focus();

    await tv.remote(PLAY_PAUSE);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PAUSED"), "paused while minimized");
    assert.equal(await nowPlaying.evaluate(el => el.classList.contains("is-paused")), true);
    assert.equal(await tv.focused(), "audiobook-now-playing", "pause update keeps focus on Now Playing");

    await tv.remote(PLAY_PAUSE);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PLAYING"), "resumed while minimized");
    assert.equal(await nowPlaying.evaluate(el => el.classList.contains("is-paused")), false);
    assert.equal(await tv.focused(), "audiobook-now-playing");

    await tv.remote(FAST_FORWARD);
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.calls.some(call => call.startsWith("seekTo "))), "minimized skip seek");
    await tv.page.evaluate(() => window.appHarness.avplay.finishSeek());
    await tv.eventually(async () => catalog.progressWrites.length === 3, "pause, resume, and seek sync writes");

    const stopsBefore = tv.fake.requests.filter(req => req.method === "DELETE" && req.path.startsWith("/playback/")).length;
    const writesBefore = catalog.progressWrites.length;
    await tv.remote(STOP);
    await tv.eventually(() => nowPlaying.count().then(count => count === 0), "Now Playing cleared");
    assert.equal(await tv.focused(), "profiles", "disappearing focused pill moves focus to profiles");
    await tv.eventually(
        async () => tv.fake.requests.filter(req => req.method === "DELETE" && req.path.startsWith("/playback/")).length === stopsBefore + 1
            && catalog.progressWrites.length === writesBefore + 1,
        "stop DELETE and final syncProgress landed",
    );
});

// Profile-aware Browse + Player integration for minimize, Settings/failure handoffs, theme suppression, video handoff, and profile teardown.
playerTest("minimized book completing while Settings is open leaves Settings intact and does not unhide Browse", async ({ tv }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"]').waitFor();
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();

    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.locator('[data-focus="title-art"]').waitFor();
    assert.equal(await tv.page.locator('.browse[data-view="home"]').isHidden(), true);

    await tv.page.evaluate(() => window.appHarness.avplay.listener?.onstreamcompleted());
    await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.calls.includes("close")), "audio closed on finish");
    await tv.eventually(async () => await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count() === 0, "audiobook surface removed on finish");
    assert.equal(await tv.page.locator('[data-focus="title-art"]').isVisible(), true);
    assert.equal(await tv.page.locator('.browse[data-view="home"]').isHidden(), true);
    assert.equal(await tv.page.locator(".skyline-now-playing").count(), 0);
});

{
    let themes!: FakeThemes;
    playerTest("minimized book failure clears Now Playing, removes surface, restores theme music, and stops swallowing media keys", async ({ tv }) => {
        await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
        await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
        await tv.page.keyboard.press("Enter");
        await prepareAudio(tv, true);
        await tv.remote(BACK);
        await tv.page.locator('[data-view="audiobook:audiobook:tide"]').waitFor();
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator(".skyline-now-playing").waitFor();

        await tv.page.evaluate(() => window.appHarness.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED"));
        await tv.eventually(async () => await tv.page.locator(".skyline-now-playing").count() === 0, "Now Playing cleared on failure");
        assert.equal(await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count(), 0);

        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-view="item:movie:m0001"] [data-focus="play"]').waitFor();
        await tv.eventually(async () => themes.grants.length === 1, "theme music restored after minimized failure");

        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().focus();
        await tv.remote(PLAY_PAUSE);
        await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.pendingPrepares > 0), "movie PLAY_PAUSE reaches Browse");
        await tv.page.evaluate(() => {
            const avplay = window.appHarness.avplay;
            avplay.finishPrepare();
            if (avplay.calls[avplay.calls.length - 1]?.startsWith("seekTo") === true) avplay.finishSeek();
        });
        await tv.page.locator('[data-screen="player"]').waitFor();
    }, ({ tv, settings }) => {
        themes = new FakeThemes(tv.fake);
        settings.profile().set(THEME_MUSIC_ENABLED_KEY, true);
    });
}

{
    let themes!: FakeThemes;
    playerTest("active audiobook suppresses theme music until stopped and yields cleanly to video playback", async ({ tv, playback }) => {
        await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
        await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
        await tv.page.keyboard.press("Enter");
        await prepareAudio(tv, true);
        const audioSessionId = [...playback.sessions.keys()][0];
        assert.ok(audioSessionId !== undefined);
        await tv.remote(BACK);
        await tv.page.locator('[data-view="audiobook:audiobook:tide"]').waitFor();
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"] [data-section="recently_added"] [data-focus="movie:m0001"]').waitFor();

        // While playing minimized, movie Details suppresses theme music.
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-view="item:movie:m0001"] [data-focus="play"]').waitFor();
        await tv.jump(1500);
        assert.equal(themes.grants.length, 0);

        // Pausing the minimized audiobook still keeps theme music suppressed.
        await tv.remote(PLAY_PAUSE);
        await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.state === "PAUSED"), "paused before reopen");
        await tv.remote(BACK);
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('[data-view="item:movie:m0001"] [data-focus="play"]').waitFor();
        await tv.jump(1500);
        assert.equal(themes.grants.length, 0);

        // With an audiobook progress write held, video awaits audiobook DELETE + surface cleanup before /playback/start.
        const heldProgress = tv.fake.hold(`/playback/${audioSessionId}/progress`);
        await tv.jump(10_000);
        await tv.eventually(async () => tv.fake.requests.some(req => req.path === `/playback/${audioSessionId}/progress`), "audiobook progress in flight");

        const mark = tv.fake.requests.length;
        const startsBeforeVideo = tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length;
        await tv.page.locator('[data-view="item:movie:m0001"] [data-focus="play"]').click();
        await tv.jump(50);
        assert.equal(tv.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start").length, startsBeforeVideo);
        assert.equal(await tv.page.locator('[data-screen="player"]').count(), 0);

        heldProgress.release();
        await tv.eventually(() => tv.page.evaluate(() => window.appHarness.avplay.urls.length >= 2 && window.appHarness.avplay.pendingPrepares > 0), "video prepare");
        await tv.page.evaluate(() => {
            const avplay = window.appHarness.avplay;
            avplay.finishPrepare();
            if (avplay.calls[avplay.calls.length - 1]?.startsWith("seekTo") === true) avplay.finishSeek();
        });
        await tv.page.locator('[data-screen="player"]').waitFor();
        assert.equal(await tv.page.locator(".browse").isHidden(), true, "audiobook stop exit must not unhide browse over video");
        assert.equal(await tv.page.locator(".skyline-now-playing").count(), 0);
        assert.equal(await tv.page.evaluate(() => document.querySelectorAll('object[type="application/avplayer"]').length), 1);

        const tail = tv.fake.requests.slice(mark);
        const audioStopIdx = tail.findIndex(req => req.method === "DELETE" && req.path.startsWith("/playback/"));
        const audioSyncIdx = tail.findIndex(req => req.method === "POST" && req.path === "/sync/progress");
        const videoStartIdx = tail.findIndex(req => req.method === "POST" && req.path === "/playback/start");
        assert.ok(audioStopIdx >= 0 && audioSyncIdx >= 0 && videoStartIdx >= 0);
        assert.ok(audioStopIdx < videoStartIdx && audioSyncIdx < videoStartIdx, "audiobook stops and syncs before video starts");

        // Closing video (dismissing visible OSD first if needed) returns to movie Details where theme music plays normally.
        await tv.remote(BACK);
        if (await tv.page.locator('[data-screen="player"]').count() > 0) await tv.remote(BACK);
        await tv.page.locator('[data-view="item:movie:m0001"] [data-focus="play"]').waitFor();
        await tv.eventually(async () => themes.grants.length === 1, "theme music allowed once audiobook cleared");
    }, ({ tv, settings }) => {
        themes = new FakeThemes(tv.fake);
        settings.profile().set(THEME_MUSIC_ENABLED_KEY, true);
    });
}

playerTest("switching profile while audiobook is minimized tears down audio with zero cross-profile syncProgress", async ({ tv, catalog }) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:tide"]').click();
    await tv.page.locator('[data-view="audiobook:audiobook:tide"] [data-focus="play"]').waitFor();
    await tv.page.keyboard.press("Enter");
    await prepareAudio(tv, true);
    await tv.remote(BACK);
    await tv.page.locator('[data-view="audiobook:audiobook:tide"]').waitFor();
    await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
    await tv.page.locator(".skyline-now-playing").waitFor();

    await tv.page.evaluate(() => window.appHarness.avplay.tick(4500 * 1000));

    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="switch-profile"]').click();
    await tv.page.locator('[data-screen="profiles"]').waitFor();

    assert.equal(await tv.page.locator(".skyline-now-playing").count(), 0);
    assert.equal(await tv.page.locator('.audio-avplay-surface, object[type="application/avplayer"]').count(), 0);
    assert.equal(await tv.page.evaluate(() => window.appHarness.avplay.calls.includes("close")), true);
    assert.equal(catalog.progressWrites.every(write => write.profileId === "p-owner"), true);
    const writesAtSwitch = catalog.progressWrites.length;
    await tv.jump(15000);
    assert.equal(catalog.progressWrites.length, writesAtSwitch);
});
