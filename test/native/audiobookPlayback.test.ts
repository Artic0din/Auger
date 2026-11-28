import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { AUDIOBOOK_SEEK_BACK_KEY, AUDIOBOOK_SEEK_FORWARD_KEY } from "../../src/contracts/v2/settings.ts";
import { AudiobookController, type AudiobookPlaybackView } from "../../src/player/audiobookController.ts";
import { transportLock } from "../../src/player/avplayTransport.ts";
import { PlaybackController } from "../../src/player/controller.ts";
import { AUDIOBOOK_CAPABILITIES, AUDIOBOOK_CLIENT_FEATURES } from "../../src/player/capabilities.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakeAudiobooks } from "./support/fakeAudiobooks.ts";
import { FakePlayback } from "./support/fakePlayback.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { problem, fixture, type RecordedRequest } from "./support/fakeSilo.ts";
import { connected, type Harness, signIn } from "./support/harness.ts";

interface Rig {
    readonly h: Harness;
    readonly catalog: FakeAudiobooks;
    readonly playback: FakePlayback;
    readonly settings: FakeSettings;
    readonly avplay: FakeAVPlay;
    readonly controller: AudiobookController;
    readonly views: AudiobookPlaybackView[];
    readonly exits: string[];
}

async function setup(profileId = "p-owner", withSetSpeed = true): Promise<Rig> {
    const h = await connected();
    await signIn(h);
    const profiles = await h.core.profiles.list();
    const chosen = profiles.find(profile => profile.id === profileId);
    assert.ok(chosen !== undefined);
    h.core.profiles.select(chosen);
    if (chosen.hasPin) assert.deepEqual(await h.core.profiles.verifyPin(chosen.id, "2468"), { status: "verified" });

    const catalog = new FakeAudiobooks();
    h.fake.catalog = catalog;
    const settings = new FakeSettings(h.fake);
    const playback = new FakePlayback(h.fake);
    catalog.registerAudiobookMediaFiles(playback);

    const avplay = new FakeAVPlay();
    if (withSetSpeed) {
        Object.assign(avplay, { setSpeed: (value: number) => { avplay.calls.push(`setSpeed ${value}`); } });
    }
    const views: AudiobookPlaybackView[] = [];
    const exits: string[] = [];
    let serial = 0;
    const controller = new AudiobookController({
        session: h.core.session,
        avplay,
        clock: h.clock,
        randomBytes: bytes => bytes.fill(++serial),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: {
            onFinished: () => exits.push("finished"),
            onClose: () => exits.push("close"),
        },
    });
    controller.subscribe(view => views.push(view));
    return { h, catalog, playback, settings, avplay, controller, views, exits };
}

async function settlePlay(r: Rig): Promise<void> {
    await r.h.clock.advance(0);
    for (let step = 0; step < 5 && r.avplay.pendingPrepares > 0; step++) {
        r.avplay.finishPrepare();
        await r.h.clock.advance(0);
    }
    while (r.avplay.calls.at(-1)?.startsWith("seekTo") && (r.views.at(-1)?.phase === "loading" || r.avplay.state === "READY")) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
}

function playingView(r: Rig): Extract<AudiobookPlaybackView, { phase: "playing" | "paused" }> {
    const last = r.views.at(-1);
    assert.ok(last !== undefined && (last.phase === "playing" || last.phase === "paused"), `expected playing/paused, got ${last?.phase}`);
    return last;
}

function startRequests(r: Rig): RecordedRequest[] {
    return r.h.fake.requests.filter(req => req.method === "POST" && req.path === "/playback/start");
}

function progressRequests(r: Rig): RecordedRequest[] {
    return r.h.fake.requests.filter(req => req.method === "POST" && /^\/playback\/[^/]+\/progress$/.test(req.path));
}

function stopRequests(r: Rig): RecordedRequest[] {
    return r.h.fake.requests.filter(req => req.method === "DELETE" && /^\/playback\/[^/]+$/.test(req.path));
}

test("start sends audio-only V3 capabilities, progress_persistence=client, same-origin token, and obeys resume grace/margin/restart", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide", title: "Tide", posterUrl: "/art/tide.svg" });
    assert.equal(r.views.at(-1)?.phase, "loading");
    await settlePlay(r);

    const start = startRequests(r)[0]?.body;
    assert.ok(start !== undefined);
    assert.equal(start.progress_persistence, "client");
    assert.equal(start.file_id, "af-1");
    assert.equal(start.start_position, 4112);
    assert.equal(start.allow_alternate_versions, false);
    assert.deepEqual(start.client_features, AUDIOBOOK_CLIENT_FEATURES);
    assert.deepEqual(start.client_capabilities, AUDIOBOOK_CAPABILITIES);
    assert.equal(r.avplay.state, "PLAYING");
    assert.match(r.avplay.urls[0] ?? "", /\?.*token=|\&token=/);
    const view = playingView(r);
    assert.equal(view.currentChapter?.index, 1);
    assert.equal(view.currentChapter?.title, "What the Tide Owes");

    // Restart forces start_position=0 even with saved progress.
    await r.controller.stop();
    void r.controller.start({ contentId: "audiobook:tide", restart: true });
    await settlePlay(r);
    assert.equal(startRequests(r)[1]?.body?.start_position, 0);

    // Within 30 s grace (`audiobook:fresh` at 20 s) starts at 0.
    r.catalog.progress.set("audiobook:fresh", 20);
    await r.controller.stop();
    void r.controller.start({ contentId: "audiobook:fresh" });
    await settlePlay(r);
    assert.equal(startRequests(r)[2]?.body?.start_position, 0);

    // Within 5 s of book end (10796 of 10800 s) starts at 0.
    r.catalog.progress.set("audiobook:fresh", 10796);
    await r.controller.stop();
    void r.controller.start({ contentId: "audiobook:fresh" });
    await settlePlay(r);
    assert.equal(startRequests(r)[3]?.body?.start_position, 0);

    r.controller.destroy();
});

test("stream URL rejects unsafe origins and never appends token to a non-API origin", async () => {
    const r = await setup();
    r.playback.next.push({ url: () => "https://cdn.example.net/audio/book.mp3" });
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    assert.equal(r.avplay.urls[0], "https://cdn.example.net/audio/book.mp3");
    assert.equal(r.avplay.urls[0]?.includes("token="), false);

    await r.controller.stop();
    r.playback.next.push({ url: () => "http://untrusted.example/audio/book.mp3" });
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    const unsafeErr = r.views.at(-1);
    assert.ok(unsafeErr?.phase === "error");
    assert.equal(unsafeErr.kind, "server");
    assert.equal(r.avplay.urls.length, 1, "unsafe stream URL must not reach avplay.open");
    assert.equal(stopRequests(r).length, 2, "allocated session for unsafe stream URL is stopped");

    r.playback.next.push({ protocol: "hls", delivery: "server_transcode_hls", url: sessionId => `/api/v2/stream/${sessionId}.m3u8?st=signed` });
    r.h.fake.streamPlaylist = { status: 200, text: "#EXTM3U\n#EXT-X-DEFINE:NAME=\"x\",VALUE=\"y\"\n" };
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    assert.equal(r.views.at(-1)?.phase, "error");
    assert.equal(r.avplay.urls.length, 1, "#EXT-X-DEFINE playlist must not reach avplay.open");
    assert.equal(stopRequests(r).length, 3, "allocated session for unreadable playlist is stopped");
    r.controller.destroy();
});

test("fails cleanly when the book has no playable parts or the server selects an unknown file_id", async () => {
    const r = await setup();
    r.h.fake.scripted.set("/catalog/items/audiobook%3Aempty?image_size=large", [{
        status: 200,
        body: { content_id: "audiobook:empty", type: "audiobook", title: "Empty", genres: [], cast: [], crew: [], ratings: [], subtitles: [], keywords: [], status: "matched", versions: [], audiobook: { authors: [], narrators: [], total_duration_seconds: 100 } },
    }]);
    void r.controller.start({ contentId: "audiobook:empty" });
    await r.h.clock.advance(0);
    const emptyErr = r.views.at(-1);
    assert.ok(emptyErr?.phase === "error");
    assert.equal(emptyErr.kind, "no_playable_track");

    const badDecision = fixture("playback_start_opaque_ids");
    const plan = badDecision.playback_plan as Record<string, unknown>;
    badDecision.playback_plan = { ...plan, effective_media_file_id: "other-file-99" };
    r.h.fake.scripted.set("/playback/start", [{ status: 201, body: badDecision }]);
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    const mismatchErr = r.views.at(-1);
    assert.ok(mismatchErr?.phase === "error");
    assert.equal(mismatchErr.kind, "unavailable_part");
    assert.equal(stopRequests(r).length, 1, "mismatched allocated session is closed on the server");
    r.controller.destroy();
});

test("dual-sink progress: 10s periodic writes while playing & paused, pause/seek/stop writes, and failed sync is never resent", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);

    r.avplay.tick(4117 * 1000);
    await r.h.clock.advance(10_000);
    assert.equal(progressRequests(r).length, 1);
    assert.equal(progressRequests(r)[0]?.body?.sequence, 1);
    assert.equal(progressRequests(r)[0]?.body?.is_paused, false);
    assert.equal(r.catalog.progressWrites.length, 1);
    assert.equal(r.catalog.progressWrites[0]?.positionMs, 4117000);
    assert.equal(r.catalog.progressWrites[0]?.durationMs, 10800000);
    assert.equal(r.catalog.progressWrites[0]?.forceOverwrite, true);

    // Pause immediately syncs both sinks with captured snapshot.
    r.controller.pause();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).phase, "paused");
    assert.equal(r.catalog.progressWrites.length, 2);
    assert.equal(progressRequests(r).length, 2);
    assert.equal(progressRequests(r)[1]?.body?.is_paused, true);

    // 10 s periodic timer keeps firing while paused so state stays durable.
    await r.h.clock.advance(10_000);
    assert.equal(r.catalog.progressWrites.length, 3);
    assert.equal(progressRequests(r).length, 3);
    assert.equal(progressRequests(r)[2]?.body?.is_paused, true);

    // Script 500 on /sync/progress: failed write must NOT retry or break playback.
    r.catalog.syncProgressReply = problem(500, "internal", "DB down");
    const callsBefore = r.h.fake.requests.length;
    r.avplay.tick(4200 * 1000);
    await r.h.clock.advance(10_000);
    const syncCalls = r.h.fake.requests.slice(callsBefore).filter(req => req.path === "/sync/progress");
    assert.equal(syncCalls.length, 1, "failed syncProgress must never be retried");
    assert.equal(playingView(r).phase, "paused");

    r.catalog.syncProgressReply = undefined;
    r.controller.play();
    r.avplay.tick(4215 * 1000);
    await r.controller.stop();
    assert.equal(stopRequests(r).length, 1);
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 4215000);
    assert.equal(r.h.clock.scheduled, 0);
    r.controller.destroy();
});

test("multi-part timeline: intra-part seek, cross-part switch, auto-advance, and final-part completion", async () => {
    const r = await setup();
    r.catalog.progress.set("audiobook:multipart", 300);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);
    assert.equal(playingView(r).partIndex, 0);
    assert.equal(playingView(r).partCount, 2);

    // Intra-part seek keeps current session.
    r.controller.seekTo(750);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(startRequests(r).length, 1);
    assert.equal(playingView(r).position, 750);
    assert.equal(playingView(r).currentChapter?.title, "Into the Storm");
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 750_000);

    // Cross-part seek to 1500 s stops part 1 and starts part 2 at local 300 s.
    r.controller.seekTo(1500);
    await settlePlay(r);
    assert.equal(stopRequests(r).length, 1);
    assert.equal(startRequests(r).length, 2);
    assert.equal(startRequests(r)[1]?.body?.file_id, "af-m2");
    assert.equal(startRequests(r)[1]?.body?.start_position, 300);
    assert.equal(playingView(r).partIndex, 1);
    assert.equal(playingView(r).position, 1500);
    assert.equal(playingView(r).currentChapter?.title, "Part 2 Arrival");

    // Simulate part 1 completing -> auto-advance to part 2 at 0.
    r.controller.seekTo(1100);
    await settlePlay(r);
    assert.equal(playingView(r).partIndex, 0);
    r.avplay.listener?.onstreamcompleted();
    await settlePlay(r);
    assert.equal(stopRequests(r).at(-1)?.body?.position, 1200);
    assert.equal(playingView(r).partIndex, 1);
    assert.equal(startRequests(r).at(-1)?.body?.file_id, "af-m2");
    assert.equal(startRequests(r).at(-1)?.body?.start_position, 0);
    assert.equal(r.avplay.state, "PLAYING");

    // Final part completes -> writes whole-book duration (3000 s) and triggers onFinished.
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.deepEqual(r.exits, ["finished"]);
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 3_000_000);
    assert.equal(r.views.at(-1)?.phase, "idle");
    r.controller.destroy();
});

test("skip intervals read audiobook settings, default to 10/30 on fallback, and stack rapid presses while seeking", async () => {
    const r = await setup();
    r.settings.profile().set(AUDIOBOOK_SEEK_BACK_KEY, 15);
    r.settings.profile().set(AUDIOBOOK_SEEK_FORWARD_KEY, 45);
    r.catalog.progress.set("audiobook:multipart", 100);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);
    assert.deepEqual(playingView(r).seekIntervals, { backward: 15, forward: 45 });

    // Rapid stacked presses while seekTo is in flight: +45 +45 = +90 -> 190 s!
    r.controller.skip("forward");
    r.controller.skip("forward");
    assert.equal(playingView(r).bufferedTarget, 190);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    if (r.avplay.calls.at(-1)?.startsWith("seekTo")) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(playingView(r).position, 190);

    // Fallback when settings endpoint fails: 10 back / 30 forward without failing start.
    await r.controller.stop();
    r.settings.revision = 8;
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);
    assert.deepEqual(playingView(r).seekIntervals, { backward: 10, forward: 30 });
    r.controller.destroy();
});

test("chapter navigation respects the 3s restart threshold and selects chapters across parts", async () => {
    const r = await setup();
    r.catalog.progress.set("audiobook:multipart", 602);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);
    assert.equal(playingView(r).currentChapter?.index, 1);

    // <= 3 s into chapter 1 jumps back to chapter 0 (0 s).
    r.controller.previousChapter();
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).position, 0);
    assert.equal(playingView(r).currentChapter?.index, 0);

    // > 3 s into chapter 1 restarts chapter 1 (600 s).
    r.controller.selectChapter(1);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    r.avplay.tick(610 * 1000);
    r.controller.previousChapter();
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).position, 600);
    assert.equal(playingView(r).currentChapter?.index, 1);

    // nextChapter from chapter 1 crosses into part 2 at 1200 s.
    r.controller.nextChapter();
    await settlePlay(r);
    assert.equal(playingView(r).partIndex, 1);
    assert.equal(playingView(r).position, 1200);
    assert.equal(playingView(r).currentChapter?.index, 2);
    r.controller.destroy();
});

test("playback rate restricts to [1, 2] on http_progressive with setSpeed, [1] on HLS or missing setSpeed, and handles throws", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    assert.deepEqual(playingView(r).availableRates, [1, 2]);
    r.controller.setPlaybackRate(2);
    assert.equal(playingView(r).playbackRate, 2);
    assert.ok(r.avplay.calls.includes("setSpeed 2"));

    // Ignoring unsupported rate leaves 2x unchanged.
    r.controller.setPlaybackRate(1.5);
    assert.equal(playingView(r).playbackRate, 2);

    // HLS offers only [1].
    await r.controller.stop();
    r.playback.next.push({ protocol: "hls", delivery: "server_transcode_hls", url: sessionId => `/stream/${sessionId}.m3u8` });
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    assert.deepEqual(playingView(r).availableRates, [1]);
    assert.equal(playingView(r).playbackRate, 1);
    r.controller.destroy();

    // Missing setSpeed offers [1]; throwing setSpeed falls back safely to 1.
    const noSpeed = await setup("p-owner", false);
    void noSpeed.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(noSpeed);
    assert.deepEqual(playingView(noSpeed).availableRates, [1]);
    noSpeed.controller.destroy();

    const throwing = await setup("p-owner", true);
    Object.assign(throwing.avplay, { setSpeed: () => { throw new Error("NotSupported"); } });
    void throwing.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(throwing);
    throwing.controller.setPlaybackRate(2);
    assert.equal(playingView(throwing).playbackRate, 1);
    throwing.controller.destroy();
});

test("sleep timer pauses playback and immediately syncs progress when it expires", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    r.controller.setSleepTimer(15);
    assert.equal(playingView(r).sleepTimer.active, true);
    assert.equal(playingView(r).sleepTimer.remainingSeconds, 900);
    const writesBefore = r.catalog.progressWrites.length;

    await r.h.clock.advance(900 * 1000);
    assert.equal(playingView(r).phase, "paused");
    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(playingView(r).sleepTimer.active, false);
    assert.ok(r.catalog.progressWrites.length > writesBefore);
    r.controller.destroy();
});

test("profile switch / sign-out aborts active book with zero late progress or syncProgress writes", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    r.avplay.tick(4500 * 1000);

    const callsBefore = r.h.fake.requests.length;
    const writesBefore = r.catalog.progressWrites.length;
    const profiles = await r.h.core.profiles.list();
    const kid = profiles.find(profile => profile.id === "p-kid");
    assert.ok(kid !== undefined);
    r.h.core.profiles.select(kid);
    await r.h.clock.advance(30_000);

    const lateWrites = r.h.fake.requests.slice(callsBefore).filter(req => /\/sync\/progress|\/progress|\/playback\//.test(req.path));
    assert.equal(lateWrites.length, 0);
    assert.equal(r.catalog.progressWrites.length, writesBefore);
    assert.equal(r.views.at(-1)?.phase, "idle");
    assert.equal(r.avplay.state, "NONE");
    r.controller.destroy();
});

test("visibility suspend/restore preserves paused state and playback rate with a fresh token", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    r.controller.setPlaybackRate(2);
    r.avplay.tick(4150 * 1000);

    r.controller.suspend();
    assert.ok(r.avplay.calls.includes("suspend"));

    void r.controller.restore();
    await r.h.clock.advance(0);
    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(playingView(r).playbackRate, 2);
    assert.equal(r.avplay.calls.filter(c => c === "setSpeed 2").length, 2);
    r.controller.destroy();
});

test("shared transportLock delays audiobook avplay.open until an in-flight video seek settles", async () => {
    const r = await setup();
    const video = new PlaybackController({
        session: r.h.core.session,
        avplay: r.avplay,
        clock: r.h.clock,
        randomBytes: bytes => bytes.fill(9),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: { onBack: () => undefined, onEnd: () => undefined, onError: () => undefined },
    });
    video.play({ contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: undefined });
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls.at(-1)?.startsWith("seekTo")) r.avplay.finishSeek();
    await r.h.clock.advance(0);
    video.seekBy(10);
    await r.h.clock.advance(0);
    video.destroy();

    // Pending video close waits for the uncancelled seek!
    const opensBefore = r.avplay.urls.length;
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, opensBefore, "audiobook open waits for pending video seek/close");

    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, opensBefore + 1);
    await settlePlay(r);
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();
});

test("error + retry restarts a failed audiobook playback cleanly", async () => {
    const r = await setup();
    r.playback.next.push({ terminal: "no_route", retryable: true });
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    const err = r.views.at(-1);
    assert.ok(err?.phase === "error");
    assert.equal(err.retryable, true);

    r.controller.retry();
    await settlePlay(r);
    assert.equal(playingView(r).phase, "playing");
    assert.equal(playingView(r).contentId, "audiobook:dune");
    r.controller.destroy();
});

test("single-flight syncProgress queue prevents a delayed older write from overwriting a newer seek position", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    r.avplay.tick(4200 * 1000);

    const held = r.h.fake.hold("/sync/progress");
    r.controller.pause();
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(req => req.path === "/sync/progress").length, 1);

    r.controller.seekTo(4500);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.requests.filter(req => req.path === "/sync/progress").length, 1, "newer sync waits in queue");

    held.release();
    await r.h.clock.advance(0);
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 4_500_000);
    assert.equal(r.catalog.progress.get("audiobook:tide"), 4500);
    r.controller.destroy();
});

test("canceling Start Over before prepare completes stops the server session without erasing resume progress", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide", restart: true });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);

    const writesBefore = r.catalog.progressWrites.length;
    const stopsBefore = stopRequests(r).length;
    await r.controller.stop();

    assert.equal(stopRequests(r).length, stopsBefore + 1);
    assert.equal(r.catalog.progressWrites.length, writesBefore);
    assert.equal(r.catalog.progress.get("audiobook:tide"), 4112);
    r.controller.destroy();
});

test("offset timeline plans combine timelineOffsetSeconds and playerStartSeconds before first playtime tick", async () => {
    const r = await setup();
    r.playback.next.push({ timeline: { timeline_offset_seconds: 594, player_start_seconds: 16, source_start_seconds: 610 } });
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    assert.equal(playingView(r).position, 610);
    await r.controller.stop();
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 610_000);
    r.controller.destroy();
});

test("failures during part auto-advance, cross-part seek, and standby restore transition cleanly to Retry", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);

    // Auto-advance 503 -> error with retryable=true; Retry recovers cleanly.
    r.h.fake.scripted.set("/playback/start", [problem(503, "unavailable", "Busy")]);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    const advanceErr = r.views.at(-1);
    assert.ok(advanceErr?.phase === "error" && advanceErr.retryable);
    assert.equal(r.avplay.state, "NONE");
    r.h.fake.scripted.delete("/playback/start");
    r.controller.retry();
    await settlePlay(r);
    assert.equal(playingView(r).partIndex, 1);

    // Cross-part seek back to part 0 hits 503 -> error with retryable=true; Retry recovers cleanly.
    r.h.fake.scripted.set("/playback/start", [problem(503, "unavailable", "Busy")]);
    r.controller.seekTo(100);
    await r.h.clock.advance(0);
    const seekErr = r.views.at(-1);
    assert.ok(seekErr?.phase === "error" && seekErr.retryable);
    r.h.fake.scripted.delete("/playback/start");
    r.controller.retry();
    await settlePlay(r);
    assert.equal(playingView(r).partIndex, 0);

    // Non-restoreAsync fallback: 503 on fallback /playback/start transitions to error with Retry, and successful fallback uses a fresh attempt ID.
    r.controller.suspend();
    Object.assign(r.avplay, { restoreAsync: undefined });
    r.h.fake.scripted.set("/playback/start", [problem(503, "unavailable", "Busy")]);
    await r.controller.restore();
    const fallbackErr = r.views.at(-1);
    assert.ok(fallbackErr?.phase === "error" && fallbackErr.retryable);
    r.h.fake.scripted.delete("/playback/start");
    r.controller.retry();
    await settlePlay(r);
    assert.equal(playingView(r).phase, "playing");

    // Token refresh failure during restore() transitions to error instead of leaving an unhandled rejection.
    delete (r.avplay as { restoreAsync?: unknown }).restoreAsync;
    r.controller.suspend();
    await r.h.clock.advance(3600 * 1000);
    r.h.fake.expireAccessTokens();
    r.h.fake.scripted.set("/auth/refresh", [problem(500, "internal_error", "Refresh unavailable")]);
    await r.controller.restore();
    const restoreErr = r.views.at(-1);
    assert.ok(restoreErr?.phase === "error");
    r.h.fake.scripted.delete("/auth/refresh");
    r.controller.destroy();
});

test("late stop or final-part completion does not emit idle or exit callbacks after a newer start begins", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    const heldStopSync = r.h.fake.hold("/sync/progress");
    const stopping = r.controller.stop();
    await r.h.clock.advance(0);
    void r.controller.start({ contentId: "audiobook:tide" });
    await r.h.clock.advance(0);
    heldStopSync.release();
    await stopping;
    await settlePlay(r);

    assert.equal(r.exits.length, 0);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(playingView(r).contentId, "audiobook:tide");

    const heldFinishSync = r.h.fake.hold("/sync/progress");
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    heldFinishSync.release();
    await settlePlay(r);

    assert.equal(r.exits.includes("finished"), false);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(playingView(r).contentId, "audiobook:dune");
    r.controller.destroy();
});

test("mid-book playback error stops the orphaned session and Retry resumes from last played position", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide", restart: true });
    await settlePlay(r);
    r.avplay.tick(4500 * 1000);
    await r.h.clock.advance(0);

    const stopsBefore = stopRequests(r).length;
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(0);
    const err = r.views.at(-1);
    assert.ok(err?.phase === "error" && err.retryable);
    assert.equal(stopRequests(r).length, stopsBefore + 1);

    r.controller.retry();
    await settlePlay(r);
    assert.equal(startRequests(r).at(-1)?.body?.start_position, 4500);
    assert.equal(playingView(r).position, 4500);
    r.controller.destroy();
});

test("sleep timer expiring during a part transition pauses the newly prepared part immediately", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);
    r.controller.setSleepTimer(15);

    // Advance within Part 0 until 5 s remain, then hold the Part 2 /playback/start request across expiry.
    await r.h.clock.advance(895 * 1000);
    const heldStart = r.h.fake.hold("/playback/start");
    r.controller.seekTo(1200);
    await r.h.clock.advance(5 * 1000);
    heldStart.release();
    await settlePlay(r);

    assert.equal(playingView(r).phase, "paused");
    assert.equal(playingView(r).sleepTimer.active, false);
    assert.notEqual(r.avplay.state, "PLAYING");
    r.controller.destroy();
});

test("failed seek still runs the queued skip behind it and clears seeking when idle", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    r.controller.skip("forward");
    r.controller.skip("forward");
    r.avplay.finishSeek("UnknownError");
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).position, 100);
    assert.equal(playingView(r).seeking, false);

    r.controller.skip("forward");
    r.avplay.finishSeek("UnknownError");
    await r.h.clock.advance(0);
    assert.equal(playingView(r).seeking, false);
    assert.equal(playingView(r).bufferedTarget, undefined);
    r.controller.destroy();
});

test("voluntary destroy while playing flushes final syncProgress and stops the server session", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    r.avplay.tick(95 * 1000);

    const writesBefore = r.catalog.progressWrites.length;
    const stopsBefore = stopRequests(r).length;
    r.controller.destroy();
    await r.h.clock.advance(0);

    assert.equal(r.catalog.progressWrites.length, writesBefore + 1);
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 95_000);
    assert.equal(stopRequests(r).length, stopsBefore + 1);
});

test("profile switch during pending stop or completion sync aborts queued writes and suppresses onFinished", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    // Delayed stop sync while switching profiles must abort and never write under replacement profile.
    const heldStopSync = r.h.fake.hold("/sync/progress");
    const stopping = r.controller.stop();
    await r.h.clock.advance(0);
    const kid = (await r.h.core.profiles.list()).find(profile => profile.id === "p-kid");
    assert.ok(kid !== undefined);
    r.h.core.profiles.select(kid);
    heldStopSync.release();
    await stopping;
    await r.h.clock.advance(0);
    assert.equal(r.catalog.progressWrites.filter(w => w.profileId === "p-kid").length, 0);

    // Natural completion with a held periodic sync + queued final write aborts on profile change without firing onFinished.
    const owner = (await r.h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    r.h.core.profiles.select(owner);
    r.controller.destroy();

    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r2);
    const heldPeriodic = r2.h.fake.hold("/sync/progress");
    await r2.h.clock.advance(10_000);
    r2.avplay.listener?.onstreamcompleted();
    await r2.h.clock.advance(0);
    const kid2 = (await r2.h.core.profiles.list()).find(profile => profile.id === "p-kid");
    assert.ok(kid2 !== undefined);
    r2.h.core.profiles.select(kid2);
    heldPeriodic.release();
    await r2.h.clock.advance(0);
    assert.equal(r2.views.at(-1)?.phase, "idle");
    assert.equal(r2.exits.includes("finished"), false);
    assert.equal(r2.catalog.progressWrites.filter(w => w.profileId === "p-kid").length, 0);

    // Authority switch after failAttempt clears stale error view and prevents retry under replacement profile.
    r2.playback.next.push({ terminal: "no_route", retryable: true });
    void r2.controller.start({ contentId: "audiobook:dune" });
    await r2.h.clock.advance(0);
    assert.equal(r2.views.at(-1)?.phase, "error");
    const owner2 = (await r2.h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner2 !== undefined);
    r2.h.core.profiles.select(owner2);
    assert.equal(r2.views.at(-1)?.phase, "idle");
    const startsBeforeRetry = startRequests(r2).length;
    r2.controller.retry();
    await r2.h.clock.advance(0);
    assert.equal(startRequests(r2).length, startsBeforeRetry);
    r2.controller.destroy();
});

test("natural completion serializes queued sync writes in activeTeardown before a subsequent Start Over", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);

    const held = r.h.fake.hold("/sync/progress");
    await r.h.clock.advance(10_000);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);

    const startsBefore = startRequests(r).length;
    void r.controller.start({ contentId: "audiobook:tide", restart: true });
    await r.h.clock.advance(0);
    assert.equal(startRequests(r).length, startsBefore, "replacement start waits for completion writes");

    held.release();
    await settlePlay(r);
    r.controller.pause();
    await r.h.clock.advance(0);

    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 0);
    assert.equal(r.catalog.progress.get("audiobook:tide"), 0);
    r.controller.destroy();
});

test("cross-part seek syncs after prepare finishes, preserves confirmed position on early stop, and saves boundary on Part 2 start failure", async () => {
    const r = await setup();
    r.catalog.progress.set("audiobook:multipart", 300);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);

    // Cross-part seek writes immediately once onPrepared + initial seek complete (no 10s wait).
    const writesBeforeSeek = r.catalog.progressWrites.length;
    r.controller.seekTo(1500);
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);
    assert.equal(r.catalog.progressWrites.length, writesBeforeSeek, "destination not synced before preparation settles");
    await settlePlay(r);
    assert.equal(r.catalog.progressWrites.length, writesBeforeSeek + 1);
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 1_500_000);

    // Stopping while Part 0 replacement is preparing saves last confirmed 400 s instead of unreached 200 s.
    r.controller.seekTo(400);
    await settlePlay(r);
    assert.equal(playingView(r).position, 400);
    r.controller.seekTo(1500);
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);
    await r.controller.stop();
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 400_000);

    // Auto-advance from Part 0 to Part 1 persists 1200 s boundary even if Part 1 /playback/start fails 503.
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);
    const heldBoundary = r.h.fake.hold("/sync/progress");
    r.h.fake.scripted.set("/playback/start", [problem(503, "unavailable", "Busy")]);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    assert.equal(r.views.at(-1)?.phase, "error");
    heldBoundary.release();
    await r.h.clock.advance(0);
    assert.equal(r.catalog.progressWrites.at(-1)?.positionMs, 1_200_000);

    r.h.fake.scripted.delete("/playback/start");
    r.controller.retry();
    await settlePlay(r);
    assert.equal(playingView(r).partIndex, 1);
    assert.equal(playingView(r).position, 1200);
    r.controller.destroy();
});

test("rejects a server plan returning a different part's effectiveMediaFileId and stops orphaned session", async () => {
    const r = await setup();
    const badDecision = fixture("playback_start_opaque_ids");
    const plan = badDecision.playback_plan as Record<string, unknown>;
    badDecision.playback_plan = { ...plan, effective_media_file_id: "af-m2" };
    r.h.fake.scripted.set("/playback/start", [{ status: 201, body: badDecision }]);

    void r.controller.start({ contentId: "audiobook:multipart" });
    await r.h.clock.advance(0);
    const err = r.views.at(-1);
    assert.ok(err?.phase === "error");
    assert.equal(err.kind, "unavailable_part");
    assert.equal(err.retryable, false);
    assert.equal(r.avplay.urls.length, 0);
    assert.equal(stopRequests(r).length, 1);
    r.controller.destroy();
});

test("same-part seeks outside seekWindow or with can_seek_anywhere=false reopen via server start", async () => {
    const r = await setup();
    r.playback.next.push({ timeline: { can_seek_anywhere: false, timeline_offset_seconds: 0 } });
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    r.controller.seekTo(120);
    await settlePlay(r);
    assert.equal(startRequests(r).length, 2);
    assert.equal(startRequests(r)[1]?.body?.start_position, 120);
    assert.equal(stopRequests(r).length, 1);

    await r.controller.stop();
    r.playback.next.push({
        timeline: {
            can_seek_anywhere: true,
            timeline_offset_seconds: 100,
            seek_window_start_seconds: 100,
            seek_window_end_seconds: 200,
            player_start_seconds: 0,
            source_start_seconds: 100,
        },
    });
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    const startsBefore = startRequests(r).length;
    r.controller.seekTo(50);
    await settlePlay(r);
    assert.equal(startRequests(r).length, startsBefore + 1, "seek before seekWindow reopens via server");
    assert.equal(startRequests(r).at(-1)?.body?.start_position, 50);
    r.controller.destroy();
});

test("pause requests during part transitions and in-flight seeks apply once settled", async () => {
    const r = await setup();
    r.catalog.progress.set("audiobook:multipart", 300);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);

    // Pause during cross-part transition keeps Part 1 paused on prepare completion.
    r.controller.seekTo(1500);
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);
    r.controller.pause();
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).phase, "paused");
    assert.equal(r.avplay.state, "READY");

    // Resume, then pause while intra-part seekTo is in flight: pause waits until finishSeek.
    r.controller.play();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.seekTo(1600);
    r.controller.pause();
    assert.equal(r.avplay.state, "PLAYING", "pause must not invoke AVPlay while seekTo is in flight");
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(playingView(r).phase, "paused");
    r.controller.destroy();
});

test("suspend during prepareAsync prevents auto-play and shared transportLock waits for pending restoreAsync", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);

    r.controller.suspend();
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "NONE", "hidden prepare completion closes transport without playing");

    await r.controller.restore();
    await settlePlay(r);
    assert.equal(r.avplay.state, "PLAYING");

    // Start video while audiobook restoreAsync is still pending: video open waits for restoreAsync via shared transportLock.
    r.controller.suspend();
    void r.controller.restore();
    await r.h.clock.advance(0);
    const urlsBeforeVideo = r.avplay.urls.length;
    const video = new PlaybackController({
        session: r.h.core.session,
        avplay: r.avplay,
        clock: r.h.clock,
        randomBytes: bytes => bytes.fill(8),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: { onBack: () => undefined, onEnd: () => undefined, onError: () => undefined },
    });
    void r.controller.stop();
    video.play({ contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: undefined });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, urlsBeforeVideo, "video avplay.open waits for pending restoreAsync");

    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.urls.length, urlsBeforeVideo + 1);
    video.destroy();
    r.controller.destroy();
});

test("concurrent session progress coalesces and standby fallback clears inFlightProgress for reopened session", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    const firstSession = [...r.playback.sessions.keys()][0];
    assert.ok(firstSession !== undefined);

    const heldProgress = r.h.fake.hold(`/playback/${firstSession}/progress`);
    await r.h.clock.advance(10_000);
    r.avplay.tick(4150 * 1000);
    r.controller.pause();
    heldProgress.release();
    await r.h.clock.advance(0);
    assert.equal(progressRequests(r).length, 2, "queued progress snapshot fires right after in-flight progress settles");
    assert.equal(progressRequests(r)[1]?.body?.is_paused, true);

    // Standby fallback while progress is in flight clears inFlightProgress so reopened session keeps reporting progress.
    r.controller.play();
    await r.h.clock.advance(0);
    const heldFallbackProgress = r.h.fake.hold(`/playback/${firstSession}/progress`);
    await r.h.clock.advance(10_000);
    r.controller.suspend();
    Object.assign(r.avplay, { restoreAsync: undefined });
    const restoring = r.controller.restore();
    await r.h.clock.advance(0);
    heldFallbackProgress.release();
    await restoring;
    await settlePlay(r);

    const progressCountAfterReopen = progressRequests(r).length;
    await r.h.clock.advance(10_000);
    assert.equal(progressRequests(r).length, progressCountAfterReopen + 1);
    r.controller.destroy();
});

test("mid-book failure at position 0 preserves start_position=0 on retry", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    // Reject sync writes so server progress stays nonzero (4112 s) when reaching position 0.
    r.catalog.syncProgressReply = problem(500, "internal", "Offline");
    r.controller.seekTo(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).position, 0);
    assert.equal(r.catalog.progress.get("audiobook:tide"), 4112);

    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(0);
    const err = r.views.at(-1);
    assert.ok(err?.phase === "error" && err.retryable);

    r.catalog.syncProgressReply = undefined;
    r.controller.retry();
    await settlePlay(r);
    assert.equal(startRequests(r).at(-1)?.body?.start_position, 0);
    assert.equal(playingView(r).position, 0);
    r.controller.destroy();
});

test("administrator termination (410 playback_session_ended) retires audiobook cleanly with no replacement", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    const sessionId = [...r.playback.sessions.keys()][0];
    assert.ok(sessionId !== undefined);

    r.playback.endByAdmin(sessionId);
    await r.h.clock.advance(10_000);
    assert.equal(r.views.at(-1)?.phase, "idle");
    assert.deepEqual(r.exits, ["close"]);
    assert.equal(r.avplay.state, "NONE");
    assert.equal(r.h.clock.scheduled, 0);

    const reqCount = r.h.fake.requests.length;
    await r.h.clock.advance(30_000);
    assert.equal(r.h.fake.requests.length, reqCount);
    r.controller.destroy();
});

test("hung prepareAsync and seekTo time out after 15 s and release shared transportLock", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);

    await r.h.clock.advance(15_000);
    const prepErr = r.views.at(-1);
    assert.ok(prepErr?.phase === "error" && prepErr.retryable);
    assert.equal(r.avplay.state, "NONE");

    r.controller.retry();
    await settlePlay(r);
    const origSeekTo = r.avplay.seekTo.bind(r.avplay);
    Object.assign(r.avplay, {
        seekTo: () => {
            Object.assign(r.avplay, { seekTo: origSeekTo });
        },
    });
    r.controller.seekTo(120);
    await r.h.clock.advance(15_000);
    assert.equal(playingView(r).seeking, false);

    await r.controller.stop();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    assert.equal(playingView(r).contentId, "audiobook:tide");
    r.controller.destroy();
});

test("hide during restoreAsync or stopServerSession preserves deferred reopen and blocks AVPlay calls while restoring", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    const firstSession = [...r.playback.sessions.keys()][0];
    assert.ok(firstSession !== undefined);

    // Pause and seek while restoreAsync is pending must not touch AVPlay until restore settles.
    r.controller.suspend();
    void r.controller.restore();
    await r.h.clock.advance(0);
    const callsDuringRestore = r.avplay.calls.length;
    r.controller.pause();
    r.controller.seekTo(200);
    assert.equal(r.avplay.calls.slice(callsDuringRestore).some(c => c.startsWith("pause") || c.startsWith("seekTo")), false);
    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PAUSED");
    assert.ok(r.avplay.calls.at(-1)?.startsWith("seekTo 200000"));
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).phase, "paused");
    assert.equal(playingView(r).position, 200);

    // Hiding while fallback stopServerSession is in flight retains deferred reopen for the next restore().
    r.controller.play();
    await r.h.clock.advance(0);
    r.controller.suspend();
    Object.assign(r.avplay, { restoreAsync: undefined });
    const heldStop = r.h.fake.hold(`/playback/${firstSession}`);
    const firstRestore = r.controller.restore();
    await r.h.clock.advance(0);
    r.controller.suspend();
    heldStop.release();
    await firstRestore;
    await r.h.clock.advance(0);

    const startsBeforeSecondRestore = startRequests(r).length;
    void r.controller.restore();
    await settlePlay(r);
    assert.equal(startRequests(r).length, startsBeforeSecondRestore + 1);
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();
});

test("same-book Start Over drains in-flight sync and drops queued pre-restart writes, and setPlaybackRate ignores initial load", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);
    r.controller.setPlaybackRate(2);
    assert.equal(r.views.at(-1)?.phase, "loading", "setPlaybackRate during initial load must not flip view to playing");
    await settlePlay(r);

    const held = r.h.fake.hold("/sync/progress");
    await r.h.clock.advance(10_000);
    r.avplay.tick(4300 * 1000);
    r.controller.pause();

    const startsBefore = startRequests(r).length;
    void r.controller.start({ contentId: "audiobook:tide", restart: true });
    await r.h.clock.advance(0);
    assert.equal(startRequests(r).length, startsBefore, "Start Over waits for held syncInFlight to drain");

    held.release();
    await settlePlay(r);
    r.controller.pause();
    await r.h.clock.advance(0);
    assert.equal(r.catalog.progressWrites.some(w => w.positionMs === 4_300_000), false);
    assert.equal(r.catalog.progress.get("audiobook:tide"), 0);
    r.controller.destroy();
});

test("stale prepareAsync error never cancels replacement startup timeout", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 1);

    void r.controller.start({ contentId: "audiobook:tide" });
    await r.h.clock.advance(0);
    assert.equal(r.avplay.pendingPrepares, 2);

    // Older attempt's prepare fails while the newer attempt is preparing: newer 15 s timeout must still fire.
    r.avplay.finishPrepare("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(0);
    assert.equal(r.views.at(-1)?.phase, "loading");

    await r.h.clock.advance(15_000);
    const err = r.views.at(-1);
    assert.ok(err?.phase === "error" && err.retryable);
    r.controller.destroy();
});

test("stopping while auto-advance switchPart is retiring Part 1 sends only one DELETE at part duration", async () => {
    const r = await setup();
    r.catalog.progress.set("audiobook:multipart", 1100);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);
    const part1Session = [...r.playback.sessions.keys()][0];
    assert.ok(part1Session !== undefined);

    const heldStop = r.h.fake.hold(`/playback/${part1Session}`);
    r.avplay.listener?.onstreamcompleted();
    await r.h.clock.advance(0);
    let stopResolved = false;
    const stopping = r.controller.stop().then(() => { stopResolved = true; });
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.heldReplies, 1, "stop() must not abort held retiring DELETE");
    assert.equal(stopResolved, false, "stop() waits for retiring DELETE to settle");
    heldStop.release();
    await stopping;
    assert.equal(stopResolved, true);

    const part1Stops = stopRequests(r).filter(req => req.path === `/playback/${part1Session}`);
    assert.equal(part1Stops.length, 1);
    assert.equal(part1Stops[0]?.body?.position, 1200);
    r.controller.destroy();

    // Even when a periodic /progress is in flight during natural auto-advance, stop() still waits for and sends DELETE.
    const r2 = await setup();
    r2.catalog.progress.set("audiobook:multipart", 1100);
    void r2.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r2);
    const s1 = [...r2.playback.sessions.keys()][0];
    assert.ok(s1 !== undefined);
    const heldProgress = r2.h.fake.hold(`/playback/${s1}/progress`);
    await r2.h.clock.advance(10_000);
    r2.avplay.listener?.onstreamcompleted();
    await r2.h.clock.advance(0);
    const stopping2 = r2.controller.stop();
    await r2.h.clock.advance(0);
    assert.equal(stopRequests(r2).filter(req => req.path === `/playback/${s1}`).length, 0);
    heldProgress.release();
    await stopping2;
    const s1Stops = stopRequests(r2).filter(req => req.path === `/playback/${s1}`);
    assert.equal(s1Stops.length, 1);
    assert.equal(s1Stops[0]?.body?.position, 1200);
    r2.controller.destroy();
});

test("sleep timer expiring while suspended mid-seek still pauses AVPlay after restore and finishSeek", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    r.controller.setSleepTimer(15);
    await r.h.clock.advance(895 * 1000);

    r.controller.seekTo(120);
    r.controller.suspend();
    await r.h.clock.advance(5 * 1000);
    void r.controller.restore();
    r.avplay.finishSeek();
    await r.h.clock.advance(0);

    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(playingView(r).phase, "paused");
    r.controller.destroy();

    // Also when a second seek is queued while suspended and finishSeek runs before restore().
    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r2);
    r2.controller.setSleepTimer(15);
    await r2.h.clock.advance(895 * 1000);
    r2.controller.seekTo(120);
    r2.controller.seekTo(240);
    r2.controller.suspend();
    await r2.h.clock.advance(5 * 1000);
    r2.avplay.finishSeek();
    await r2.h.clock.advance(0);
    assert.ok(r2.avplay.calls.includes("suspend"));

    void r2.controller.restore();
    await r2.h.clock.advance(0);
    r2.avplay.finishRestore();
    await r2.h.clock.advance(0);
    assert.equal(r2.avplay.state, "PAUSED");
    r2.avplay.finishSeek();
    await r2.h.clock.advance(0);
    assert.equal(r2.avplay.state, "PAUSED");
    assert.equal(playingView(r2).phase, "paused");
    assert.equal(playingView(r2).position, 240);
    r2.controller.destroy();
});

test("setPlaybackRate changed while seeking is applied when seekTo settles", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    const speedCallsBefore = r.avplay.calls.filter(c => c === "setSpeed 2").length;
    r.controller.seekTo(120);
    r.controller.setPlaybackRate(2);
    assert.equal(r.avplay.calls.filter(c => c === "setSpeed 2").length, speedCallsBefore);

    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).playbackRate, 2);
    assert.equal(r.avplay.calls.filter(c => c === "setSpeed 2").length, speedCallsBefore + 1);
    r.controller.destroy();
});

test("voluntary cancel while /playback/start is held retires allocated server session cleanly", async () => {
    const r = await setup();
    const heldStart = r.h.fake.hold("/playback/start");
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);

    const stopsBefore = stopRequests(r).length;
    const urlsBefore = r.avplay.urls.length;
    await r.controller.stop();
    heldStart.release();
    await r.h.clock.advance(0);

    assert.equal(r.avplay.urls.length, urlsBefore);
    assert.equal(stopRequests(r).length, stopsBefore + 1);
    r.controller.destroy();
});

test("sleep timer expiry overrides pending resume queued while paused mid-seek", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);

    r.controller.pause();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "PAUSED");

    r.controller.setSleepTimer(15);
    await r.h.clock.advance(895 * 1000);

    const playsBefore = r.avplay.calls.filter(c => c === "play").length;
    r.controller.seekTo(120);
    r.controller.play();
    await r.h.clock.advance(5 * 1000);

    r.avplay.finishSeek();
    await r.h.clock.advance(0);

    assert.equal(r.avplay.calls.filter(c => c === "play").length, playsBefore);
    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(playingView(r).phase, "paused");
    assert.equal(playingView(r).position, 120);
    assert.equal(playingView(r).sleepTimer.active, false);

    // If AVPlay reports PLAYING when the seek settles after timer expiry overrode a queued resume, pause it.
    r.controller.setSleepTimer(15);
    await r.h.clock.advance(895 * 1000);
    r.controller.seekTo(240);
    r.controller.play();
    await r.h.clock.advance(5 * 1000);

    const pausesBefore = r.avplay.calls.filter(c => c === "pause").length;
    r.avplay.state = "PLAYING";
    r.avplay.finishSeek();
    await r.h.clock.advance(0);

    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(r.avplay.calls.filter(c => c === "pause").length, pausesBefore + 1);
    assert.equal(playingView(r).phase, "paused");
    assert.equal(playingView(r).position, 240);
    assert.equal(playingView(r).sleepTimer.active, false);
    r.controller.destroy();
});

test("stopping during fallback restore session retirement sends only one DELETE and waits for it", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    const firstSession = [...r.playback.sessions.keys()][0];
    assert.ok(firstSession !== undefined);

    r.controller.suspend();
    Object.assign(r.avplay, { restoreAsync: undefined });
    const heldStop = r.h.fake.hold(`/playback/${firstSession}`);
    const restoring = r.controller.restore();
    await r.h.clock.advance(0);
    assert.equal(
        stopRequests(r).filter(req => req.path === `/playback/${firstSession}`).length,
        1,
        "fallback restore must issue the retirement DELETE before stop()",
    );
    assert.equal(r.h.fake.heldReplies, 1, "fallback retirement DELETE reply must be held before stop()");

    let stopResolved = false;
    const stopping = r.controller.stop().then(() => { stopResolved = true; });
    await r.h.clock.advance(0);
    assert.equal(r.h.fake.heldReplies, 1, "stop() must not abort held fallback retirement DELETE");
    assert.equal(stopResolved, false, "stop() waits for fallback retirement DELETE to settle");

    heldStop.release();
    await Promise.all([restoring, stopping]);

    assert.equal(stopResolved, true);
    assert.equal(stopRequests(r).filter(req => req.path === `/playback/${firstSession}`).length, 1);
    assert.equal(startRequests(r).length, 1);
    assert.equal(r.views.at(-1)?.phase, "idle");
    r.controller.destroy();
});

test("restore pauses instead of resuming when sleep deadline passed during suspend with delayed timers", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    let clockJumpMs = 0;
    const origNow = r.h.clock.now.bind(r.h.clock);
    r.h.clock.now = () => origNow() + clockJumpMs;

    r.controller.setSleepTimer(15);
    r.controller.suspend();

    const progressBeforeRestore = progressRequests(r).length;
    clockJumpMs = 20 * 60 * 1000;
    const restoring = r.controller.restore();
    await r.h.clock.advance(0);
    r.avplay.finishRestore();
    await restoring;
    await r.h.clock.advance(0);

    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(playingView(r).phase, "paused");
    assert.equal(playingView(r).sleepTimer.active, false);
    assert.equal(playingView(r).sleepTimer.remainingSeconds, 0);
    assert.equal(progressRequests(r).length, progressBeforeRestore + 1);
    assert.equal(progressRequests(r).at(-1)?.body?.is_paused, true);

    // Fallback reopen when deadline passes while failing restoreAsync is pending retires with is_paused=true and stays READY/paused.
    r.controller.play();
    await r.h.clock.advance(0);
    r.controller.setSleepTimer(15);
    r.controller.suspend();
    const fallback = r.controller.restore();
    await r.h.clock.advance(0);
    clockJumpMs += 20 * 60 * 1000;
    r.avplay.finishRestore("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(0);
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    await fallback;

    assert.equal(stopRequests(r).at(-1)?.body?.is_paused, true);
    assert.equal(r.avplay.state, "READY");
    assert.equal(playingView(r).phase, "paused");
    assert.equal(playingView(r).sleepTimer.active, false);
    r.controller.destroy();
});

test("sleep deadline passing during pending restoreAsync, thrown suspend(), or cross-part prepareAsync keeps playback paused", async () => {
    // Subcase A: deadline passes while warm restoreAsync is pending.
    const r1 = await setup();
    void r1.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r1);
    let jump1 = 0;
    const origNow1 = r1.h.clock.now.bind(r1.h.clock);
    r1.h.clock.now = () => origNow1() + jump1;

    r1.controller.setSleepTimer(15);
    r1.controller.suspend();
    const progressBeforeWarm = progressRequests(r1).length;
    const restoring = r1.controller.restore();
    await r1.h.clock.advance(0);
    jump1 = 20 * 60 * 1000;
    r1.avplay.finishRestore();
    await restoring;
    await r1.h.clock.advance(0);

    assert.equal(r1.avplay.state, "PAUSED");
    assert.equal(playingView(r1).phase, "paused");
    assert.equal(playingView(r1).sleepTimer.active, false);
    assert.equal(progressRequests(r1).length, progressBeforeWarm + 1);
    assert.equal(progressRequests(r1).at(-1)?.body?.is_paused, true);
    r1.controller.destroy();

    // Subcase B: avplay.suspend() throws leaving hidden=true, suspended=false, state=PLAYING; restore() must pause AVPlay.
    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r2);
    let jump2 = 0;
    const origNow2 = r2.h.clock.now.bind(r2.h.clock);
    r2.h.clock.now = () => origNow2() + jump2;

    r2.controller.setSleepTimer(15);
    const origSuspend = r2.avplay.suspend.bind(r2.avplay);
    Object.assign(r2.avplay, {
        suspend: () => {
            Object.assign(r2.avplay, { suspend: origSuspend });
            throw new Error("suspend rejected");
        },
    });
    r2.controller.suspend();
    assert.equal(r2.avplay.state, "PLAYING");

    jump2 = 20 * 60 * 1000;
    await r2.controller.restore();
    assert.equal(r2.avplay.state, "PAUSED");
    assert.equal(playingView(r2).phase, "paused");
    assert.equal(playingView(r2).sleepTimer.active, false);
    r2.controller.destroy();

    // Subcase C: deadline passes while cross-part prepareAsync is pending (finishStart() reconcile).
    const r3 = await setup();
    void r3.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r3);
    let jump3 = 0;
    const origNow3 = r3.h.clock.now.bind(r3.h.clock);
    r3.h.clock.now = () => origNow3() + jump3;

    r3.controller.setSleepTimer(15);
    r3.controller.seekTo(1300);
    await r3.h.clock.advance(0);
    assert.equal(r3.avplay.pendingPrepares, 1);

    jump3 = 20 * 60 * 1000;
    r3.avplay.finishPrepare();
    await r3.h.clock.advance(0);
    r3.avplay.finishSeek();
    await r3.h.clock.advance(0);

    assert.equal(r3.avplay.state, "READY");
    assert.equal(playingView(r3).phase, "paused");
    assert.equal(playingView(r3).sleepTimer.active, false);
    r3.controller.destroy();

    // Subcase D: clock jumps past deadline BEFORE seeking across parts retires old session with is_paused=true.
    const r4 = await setup();
    void r4.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r4);
    let jump4 = 0;
    const origNow4 = r4.h.clock.now.bind(r4.h.clock);
    r4.h.clock.now = () => origNow4() + jump4;

    r4.controller.setSleepTimer(15);
    jump4 = 20 * 60 * 1000;
    r4.controller.seekTo(1300);
    await r4.h.clock.advance(0);
    assert.equal(stopRequests(r4).at(-1)?.body?.is_paused, true);

    r4.avplay.finishPrepare();
    await r4.h.clock.advance(0);
    r4.avplay.finishSeek();
    await r4.h.clock.advance(0);

    assert.equal(r4.avplay.state, "READY");
    assert.equal(playingView(r4).phase, "paused");
    assert.equal(playingView(r4).sleepTimer.active, false);
    r4.controller.destroy();
});

test("intra-part seek settlement and explicit play() reconcile delayed sleep timer deadlines", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    let clockJumpMs = 0;
    const origNow = r.h.clock.now.bind(r.h.clock);
    r.h.clock.now = () => origNow() + clockJumpMs;

    // Subcase A: paused mid-seek + queued play() + delayed deadline passing before finishSeek().
    r.controller.pause();
    await r.h.clock.advance(0);
    r.controller.setSleepTimer(15);
    r.controller.seekTo(120);
    r.controller.play();
    const progressBeforeSeek = progressRequests(r).length;
    const writesBeforeSeek = r.catalog.progressWrites.length;
    clockJumpMs = 20 * 60 * 1000;
    r.avplay.finishSeek();
    await r.h.clock.advance(0);

    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(playingView(r).phase, "paused");
    assert.equal(playingView(r).position, 120);
    assert.equal(playingView(r).sleepTimer.active, false);
    assert.equal(progressRequests(r).length, progressBeforeSeek + 1);
    assert.equal(r.catalog.progressWrites.length, writesBeforeSeek + 1);
    assert.equal(progressRequests(r).at(-1)?.body?.is_paused, true);
    assert.equal(progressRequests(r).at(-1)?.body?.position, 120);

    // Subcase B: explicit play() past a delayed deadline clears the expired timer without later re-pausing.
    r.controller.setSleepTimer(15);
    clockJumpMs += 20 * 60 * 1000;
    r.controller.play();
    await r.h.clock.advance(0);

    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(playingView(r).phase, "playing");
    assert.equal(playingView(r).sleepTimer.active, false);

    await r.h.clock.advance(5000);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(playingView(r).phase, "playing");
    r.controller.destroy();
});

test("on-time sleep expiry during suspend or thrown suspend() pauses AVPlay and syncs immediately on restore", async () => {
    // Case 1: on-time expiry during normal suspend syncs pause immediately on warm restore.
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    r.controller.setSleepTimer(15);
    r.controller.suspend();
    await r.h.clock.advance(15 * 60 * 1000);

    const progressBefore = progressRequests(r).length;
    const restoring = r.controller.restore();
    await r.h.clock.advance(0);
    r.avplay.finishRestore();
    await restoring;
    await r.h.clock.advance(0);

    assert.equal(r.avplay.state, "PAUSED");
    assert.equal(playingView(r).phase, "paused");
    assert.equal(progressRequests(r).length, progressBefore + 1);
    assert.equal(progressRequests(r).at(-1)?.body?.is_paused, true);
    r.controller.destroy();

    // Case 2: on-time expiry after avplay.suspend() throws pauses AVPlay and syncs on fast-path restore.
    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r2);
    r2.controller.setSleepTimer(15);
    const origSuspend = r2.avplay.suspend.bind(r2.avplay);
    Object.assign(r2.avplay, {
        suspend: () => {
            Object.assign(r2.avplay, { suspend: origSuspend });
            throw new Error("suspend rejected");
        },
    });
    r2.controller.suspend();
    assert.equal(r2.avplay.state, "PLAYING");
    await r2.h.clock.advance(15 * 60 * 1000);

    const progressBefore2 = progressRequests(r2).length;
    await r2.controller.restore();
    await r2.h.clock.advance(0);

    assert.equal(r2.avplay.state, "PAUSED");
    assert.equal(playingView(r2).phase, "paused");
    assert.equal(progressRequests(r2).length, progressBefore2 + 1);
    assert.equal(progressRequests(r2).at(-1)?.body?.is_paused, true);
    r2.controller.destroy();
});

test("410 server termination drains in-flight whole-book sync before replacement Start Over", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    const sessionId = [...r.playback.sessions.keys()][0];
    assert.ok(sessionId !== undefined);

    const heldSync = r.h.fake.hold("/sync/progress");
    await r.h.clock.advance(10_000);
    r.playback.endByAdmin(sessionId);
    await r.h.clock.advance(10_000);
    assert.equal(r.views.at(-1)?.phase, "idle");
    assert.equal(r.h.fake.heldReplies, 1);

    const startsBefore = startRequests(r).length;
    void r.controller.start({ contentId: "audiobook:tide", restart: true });
    await r.h.clock.advance(0);
    assert.equal(startRequests(r).length, startsBefore, "Start Over waits for 410-retired attempt's in-flight sync");

    heldSync.release();
    await settlePlay(r);
    r.controller.pause();
    await r.h.clock.advance(0);
    assert.equal(startRequests(r).at(-1)?.body?.start_position, 0);
    assert.equal(r.catalog.progress.get("audiobook:tide"), 0);
    r.controller.destroy();
});

test("delayed native seekTo callback settling after timeout and stop() closes AVPlay cleanly", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    r.controller.seekTo(120);
    await r.h.clock.advance(15_000);
    assert.equal(playingView(r).seeking, false);

    await r.controller.stop();
    assert.equal(r.views.at(-1)?.phase, "idle");
    assert.equal(r.avplay.state, "PLAYING", "close() rejected while native seek is still pending");
    const closesBefore = r.avplay.calls.filter(c => c === "close").length;

    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.calls.filter(c => c === "close").length, closesBefore + 1);
    assert.equal(r.avplay.state, "NONE");

    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    assert.equal(playingView(r).contentId, "audiobook:tide");
    assert.equal(r.avplay.state, "PLAYING");
    r.controller.destroy();

    // Two-generation isolation: Stream 1's stale seekTo callback must not close Stream 2 even when Stream 2 has a deferred close.
    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r2);

    let stream1SeekSuccess: (() => void) | undefined;
    const origSeekTo = r2.avplay.seekTo.bind(r2.avplay);
    Object.assign(r2.avplay, {
        seekTo: (_ms: number, success: () => void) => {
            Object.assign(r2.avplay, { seekTo: origSeekTo });
            stream1SeekSuccess = success;
        },
    });
    r2.controller.seekTo(120);
    await r2.h.clock.advance(15_000);
    await r2.controller.stop();

    void r2.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r2);
    const s2 = [...r2.playback.sessions.keys()][1];
    assert.ok(s2 !== undefined);
    r2.controller.suspend();
    void r2.controller.restore();
    await r2.h.clock.advance(0);
    const held2 = r2.h.fake.hold(`/playback/${s2}`);
    await r2.h.clock.advance(15_000);
    const origClose2 = r2.avplay.close.bind(r2.avplay);
    Object.assign(r2.avplay, {
        close: () => {
            Object.assign(r2.avplay, { close: origClose2 });
            throw new Error("gen 2 restore unwinding");
        },
    });
    const stop2 = r2.controller.stop();
    await r2.h.clock.advance(0);
    held2.release();
    await stop2;

    assert.ok(stream1SeekSuccess !== undefined);
    stream1SeekSuccess();
    await r2.h.clock.advance(0);
    assert.equal(r2.avplay.state, "PLAYING", "Stream 1 late seekTo callback must not close Stream 2");

    r2.avplay.finishRestore();
    await r2.h.clock.advance(0);
    assert.equal(r2.avplay.state, "NONE", "Stream 2 own callback closes Stream 2");
    r2.controller.destroy();
});

test("delayed native restoreAsync closes idle AVPlay when orphaned and never closes a replacement video stream", async () => {
    // Subcase A: late restoreAsync callback after timeout + stop() closes AVPlay when still orphaned.
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    const firstSession = [...r.playback.sessions.keys()][0];
    assert.ok(firstSession !== undefined);

    r.controller.suspend();
    void r.controller.restore();
    await r.h.clock.advance(0);

    const heldStop = r.h.fake.hold(`/playback/${firstSession}`);
    await r.h.clock.advance(15_000);
    const origClose = r.avplay.close.bind(r.avplay);
    Object.assign(r.avplay, {
        close: () => {
            Object.assign(r.avplay, { close: origClose });
            throw new Error("restore still unwinding");
        },
    });
    const stopping = r.controller.stop();
    await r.h.clock.advance(0);
    heldStop.release();
    await stopping;
    assert.notEqual(r.avplay.state, "NONE");

    r.avplay.finishRestore();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "NONE");
    r.controller.destroy();

    // Subcase B: if PlaybackController opens a replacement video stream first, the late restoreAsync must not close it.
    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r2);
    const s2 = [...r2.playback.sessions.keys()][0];
    assert.ok(s2 !== undefined);

    r2.controller.suspend();
    void r2.controller.restore();
    await r2.h.clock.advance(0);

    const heldStop2 = r2.h.fake.hold(`/playback/${s2}`);
    await r2.h.clock.advance(15_000);
    const origClose2 = r2.avplay.close.bind(r2.avplay);
    Object.assign(r2.avplay, {
        close: () => {
            Object.assign(r2.avplay, { close: origClose2 });
            throw new Error("restore still unwinding");
        },
    });
    const stopping2 = r2.controller.stop();
    await r2.h.clock.advance(0);
    heldStop2.release();
    await stopping2;

    const video = new PlaybackController({
        session: r2.h.core.session,
        avplay: r2.avplay,
        clock: r2.h.clock,
        randomBytes: bytes => bytes.fill(9),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        exits: { onBack: () => undefined, onEnd: () => undefined, onError: () => undefined },
    });
    const lock = transportLock(r2.avplay);
    const genBeforeVideo = lock.streamGen;
    video.play({ contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: undefined });
    await r2.h.clock.advance(0);
    r2.avplay.finishPrepare();
    await r2.h.clock.advance(0);
    assert.equal(r2.avplay.state, "PLAYING");
    assert.equal(lock.streamGen, genBeforeVideo + 1, "video avplay.open() must advance shared streamGen");

    lock.deferredCloseGen = lock.streamGen;
    r2.avplay.finishRestore();
    await r2.h.clock.advance(0);
    assert.equal(r2.avplay.state, "PLAYING", "late audiobook restore callback must not close active video stream");
    video.destroy();
    r2.controller.destroy();

    // Subcase C: Stream 1's stale callback must never close Stream 2 even when Stream 2 also has a pending deferred close.
    const r3 = await setup();
    void r3.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r3);
    const s1Gen = [...r3.playback.sessions.keys()][0];
    assert.ok(s1Gen !== undefined);

    r3.controller.suspend();
    void r3.controller.restore();
    await r3.h.clock.advance(0);
    const heldGen1 = r3.h.fake.hold(`/playback/${s1Gen}`);
    await r3.h.clock.advance(15_000);
    const origClose3 = r3.avplay.close.bind(r3.avplay);
    Object.assign(r3.avplay, {
        close: () => {
            Object.assign(r3.avplay, { close: origClose3 });
            throw new Error("gen 1 restore unwinding");
        },
    });
    const stopGen1 = r3.controller.stop();
    await r3.h.clock.advance(0);
    heldGen1.release();
    await stopGen1;

    void r3.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r3);
    const s2Gen = [...r3.playback.sessions.keys()][1];
    assert.ok(s2Gen !== undefined);
    r3.controller.suspend();
    void r3.controller.restore();
    await r3.h.clock.advance(0);
    const heldGen2 = r3.h.fake.hold(`/playback/${s2Gen}`);
    await r3.h.clock.advance(15_000);
    Object.assign(r3.avplay, {
        close: () => {
            Object.assign(r3.avplay, { close: origClose3 });
            throw new Error("gen 2 restore unwinding");
        },
    });
    const stopGen2 = r3.controller.stop();
    await r3.h.clock.advance(0);
    heldGen2.release();
    await stopGen2;

    r3.avplay.finishRestore();
    await r3.h.clock.advance(0);
    assert.equal(r3.avplay.state, "PLAYING", "Stream 1 stale callback must not close Stream 2");

    r3.avplay.finishRestore();
    await r3.h.clock.advance(0);
    assert.equal(r3.avplay.state, "NONE", "Stream 2 own callback closes Stream 2");
    r3.controller.destroy();
});

test("suspend() while replacement start awaits previous teardown defers replacement AVPlay open until restore()", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);

    const heldSync = r.h.fake.hold("/sync/progress");
    await r.h.clock.advance(10_000);
    void r.controller.start({ contentId: "audiobook:dune" });
    await r.h.clock.advance(0);

    r.controller.suspend();
    heldSync.release();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "NONE");
    assert.equal(r.avplay.pendingPrepares, 0);

    await r.controller.restore();
    await settlePlay(r);
    assert.equal(r.avplay.state, "PLAYING");
    assert.equal(playingView(r).contentId, "audiobook:dune");
    r.controller.destroy();

    // If suspend() then restore() happen while still awaiting prior teardown, replacement starts on teardown release.
    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r2);

    const heldSync2 = r2.h.fake.hold("/sync/progress");
    await r2.h.clock.advance(10_000);
    void r2.controller.start({ contentId: "audiobook:dune" });
    await r2.h.clock.advance(0);

    r2.controller.suspend();
    await r2.controller.restore();
    heldSync2.release();
    await settlePlay(r2);
    assert.equal(r2.avplay.state, "PLAYING");
    assert.equal(playingView(r2).contentId, "audiobook:dune");
    r2.controller.destroy();
});

test("stop() syncs pending or queued seek targets before AVPlay seek settles", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);

    // Case 1: single skip before finishSeek() -> stop() syncs 4112 + 30 = 4142 s.
    r.controller.skip("forward");
    assert.equal(playingView(r).bufferedTarget, 4142);
    await r.controller.stop();
    assert.equal(r.catalog.progress.get("audiobook:tide"), 4142);
    assert.equal(stopRequests(r).at(-1)?.body?.position, 4142);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);

    // Case 2: rapid double-skip while first seek is pending (queuedSeekTarget set) -> stop() syncs +60 s.
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    r.controller.skip("forward");
    r.controller.skip("forward");
    assert.equal(playingView(r).bufferedTarget, 4202);
    await r.controller.stop();
    assert.equal(r.catalog.progress.get("audiobook:tide"), 4202);
    assert.equal(stopRequests(r).at(-1)?.body?.position, 4202);
    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    await r.controller.destroy();
});

test("destroy() defers AVPlay close and reports transportBusy until in-flight seek settles", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);

    r.controller.skip("forward");
    const closesBefore = r.avplay.calls.filter(call => call === "close").length;
    const destroying = r.controller.destroy();
    assert.equal(r.controller.transportBusy, true);
    assert.equal(r.avplay.calls.filter(call => call === "close").length, closesBefore);

    r.avplay.finishSeek();
    await destroying;
    assert.equal(r.controller.transportBusy, false);
    assert.equal(r.avplay.calls.filter(call => call === "close").length, closesBefore + 1);
    assert.equal(r.avplay.state, "NONE");
});

test("stop() persists queued cross-part skip position to syncProgress while keeping retiring part stop file-local", async () => {
    const r = await setup();
    r.catalog.progress.set("audiobook:multipart", 1150);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);

    r.controller.skip("forward");
    r.controller.skip("forward");
    assert.equal(playingView(r).bufferedTarget, 1210);
    await r.controller.stop();
    assert.equal(r.catalog.progress.get("audiobook:multipart"), 1210);
    assert.equal(stopRequests(r).at(-1)?.body?.position, 1150);

    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    await r.controller.destroy();
});

test("retry() after playback error during an unsettled seek resumes at the pending or queued target", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);

    r.controller.skip("forward");
    r.controller.skip("forward");
    assert.equal(playingView(r).bufferedTarget, 4172);
    r.avplay.listener?.onerror("PLAYER_ERROR_CONNECTION_FAILED");
    await r.h.clock.advance(0);
    assert.equal(r.views.at(-1)?.phase, "error");

    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    r.controller.retry();
    await settlePlay(r);
    assert.equal(startRequests(r).at(-1)?.body?.start_position, 4172);
    assert.equal(playingView(r).position, 4172);
    await r.controller.destroy();
});

test("stop() bounds missing seekTo callback by STARTUP_TIMEOUT_MS and retires AVPlay on timeout or late callback", async () => {
    // Case 1: AVPlay refuses close() while seek is still unwinding natively; timeout releases whenTransportIdle() and late callback performs deferred close.
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);

    r.controller.skip("forward");
    await r.controller.stop();
    assert.equal(r.controller.transportBusy, true);
    let idleResolved = false;
    const idle = r.controller.whenTransportIdle().then(() => { idleResolved = true; });

    await r.h.clock.advance(14_999);
    assert.equal(idleResolved, false);
    assert.equal(r.controller.transportBusy, true);

    await r.h.clock.advance(1);
    await idle;
    assert.equal(idleResolved, true);
    assert.equal(r.controller.transportBusy, false);
    assert.equal(r.avplay.state, "PLAYING");

    r.avplay.finishSeek();
    await r.h.clock.advance(0);
    assert.equal(r.avplay.state, "NONE");
    await r.controller.destroy();

    // Case 2: seekTo callback is dropped natively without blocking close(); timeout immediately closes AVPlay.
    const r2 = await setup();
    void r2.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r2);
    Object.assign(r2.avplay, { seekTo: () => undefined });
    const closesBefore = r2.avplay.calls.filter(c => c === "close").length;

    r2.controller.skip("forward");
    await r2.controller.stop();
    assert.equal(r2.controller.transportBusy, true);
    await r2.h.clock.advance(15_000);
    await r2.controller.whenTransportIdle();
    assert.equal(r2.controller.transportBusy, false);
    assert.equal(r2.avplay.calls.filter(c => c === "close").length, closesBefore + 1);
    assert.equal(r2.avplay.state, "NONE");
    await r2.controller.destroy();
});

test("starting another book while active flushes final syncProgress and stops old session first", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:tide" });
    await settlePlay(r);
    r.avplay.tick(4500 * 1000);
    await r.h.clock.advance(0);

    const requestMark = r.h.fake.requests.length;
    const writesBefore = r.catalog.progressWrites.length;
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);

    const view = playingView(r);
    assert.equal(view.contentId, "audiobook:dune");
    assert.equal(r.catalog.progressWrites.length, writesBefore + 1);
    assert.deepEqual(r.catalog.progressWrites.at(-1), {
        profileId: "p-owner",
        mediaItemId: "audiobook:tide",
        positionMs: 4_500_000,
        durationMs: 10_800_000,
        forceOverwrite: true,
    });

    const tail = r.h.fake.requests.slice(requestMark);
    const stopIdx = tail.findIndex(req => req.method === "DELETE" && req.path.startsWith("/playback/"));
    const syncIdx = tail.findIndex(req => req.method === "POST" && req.path === "/sync/progress");
    const nextStartIdx = tail.findIndex(req => req.method === "POST" && req.path === "/playback/start");
    assert.ok(stopIdx >= 0 && syncIdx >= 0 && nextStartIdx >= 0);
    assert.ok(stopIdx < nextStartIdx && syncIdx < nextStartIdx, "old session stop + syncProgress precede next book start");
    r.controller.destroy();
});

test("restarting the same book stops the old server session without overwriting progress", async () => {
    const r = await setup();
    void r.controller.start({ contentId: "audiobook:dune" });
    await settlePlay(r);
    r.avplay.tick(120 * 1000);
    await r.h.clock.advance(0);

    const writesBefore = r.catalog.progressWrites.length;
    const stopsBefore = stopRequests(r).length;
    void r.controller.start({ contentId: "audiobook:dune", restart: true });
    await settlePlay(r);

    assert.equal(stopRequests(r).length, stopsBefore + 1);
    assert.equal(r.catalog.progressWrites.length, writesBefore, "restart skips flushing old mid-book position");
    assert.equal(startRequests(r).at(-1)?.body?.start_position, 0);
    r.controller.destroy();
});

test("resuming via seekTo + play from a paused book across part boundaries starts the target part playing", async () => {
    const r = await setup();
    r.catalog.progress.set("audiobook:multipart", 300);
    void r.controller.start({ contentId: "audiobook:multipart" });
    await settlePlay(r);

    r.controller.pause();
    await r.h.clock.advance(0);
    assert.equal(playingView(r).phase, "paused");
    assert.equal(r.avplay.state, "PAUSED");

    r.controller.seekTo(1500);
    r.controller.play();
    await settlePlay(r);

    assert.equal(playingView(r).phase, "playing");
    assert.equal(playingView(r).partIndex, 1);
    assert.equal(playingView(r).position, 1500);
    assert.equal(r.avplay.state, "PLAYING");
    await r.controller.destroy();
});
