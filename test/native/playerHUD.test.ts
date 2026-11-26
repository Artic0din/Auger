import assert from "node:assert/strict";
import { test } from "node:test";
import { chapterTitle, currentChapter, planStats, statLabel, videoOptions } from "../../src/player/playerHUD.ts";
import { decodePlayerChapters } from "../../src/contracts/v2/chapters.ts";
import { HUDState } from "../../src/player/hudState.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import type { PlaybackPlan } from "../../src/contracts/v2/playback.ts";
import { decodePlaybackDecision } from "../../src/contracts/v2/playback.ts";
import { fixture } from "./support/fakeSilo.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

test("video settings validate before calling AVPlay, retain confirmed values on failure and restore after reopen", () => {
    const decision = decodePlaybackDecision(fixture("playback_start_opaque_ids"));
    assert.ok(decision.outcome === "playable");
    const plan: PlaybackPlan = decision.plan;
    const calls: string[] = [];
    let fail = false;
    const avplay = Object.assign(new FakeAVPlay(), {
        setSpeed(speed: number) { if (fail) throw new Error("Unsupported"); calls.push(`speed ${speed}`); },
        setDisplayMethod(mode: "PLAYER_DISPLAY_MODE_LETTER_BOX" | "PLAYER_DISPLAY_MODE_FULL_SCREEN") { calls.push(mode); },
    });
    const hud = new HUDState();
    hud.setVideo(avplay, plan, "speed", "1.5");
    assert.deepEqual(calls, []);
    hud.setVideo(avplay, plan, "speed", "2");
    hud.setVideo(avplay, plan, "aspect", "Stretch");
    assert.equal(hud.speed, 2);
    assert.equal(hud.aspect, "Stretch");
    fail = true;
    hud.setVideo(avplay, plan, "speed", "1");
    assert.equal(hud.speed, 2);
    assert.match(hud.message, /unavailable/);
    fail = false;
    hud.restore(avplay, plan);
    assert.deepEqual(calls, ["speed 2", "PLAYER_DISPLAY_MODE_FULL_SCREEN", "speed 2", "PLAYER_DISPLAY_MODE_FULL_SCREEN"]);
    avplay.setDisplayMethod = () => { throw new Error("Unsupported aspect"); };
    hud.restore(avplay, plan);
    assert.equal(hud.speed, 2, "an aspect error cannot change the successfully restored speed");
    assert.equal(hud.aspect, undefined, "a failed restore cannot claim an unconfirmed default");
});

test("chapters belong to the effective file and retain source seconds", () => {
    const chapters = decodePlayerChapters({ versions: [
        { file_id: "other", chapters: [{ index: 0, title: "Wrong", start_seconds: 0, end_seconds: 30 }] },
        { file_id: "42", chapters: [{ index: 0, title: "", start_seconds: 0, end_seconds: 30 }, { index: 1, title: "Second", start_seconds: 30, end_seconds: 80 }] },
    ] }, "42");
    assert.equal(chapters[0]?.title, undefined);
    assert.equal(chapters[1]?.title, "Second");
    assert.equal(chapterTitle(chapters[0]!, 0), "Chapter 1");
    assert.equal(chapterTitle(chapters[1]!, 1), "Second");
    setAppLanguage("de", SHIPPED_LANGUAGES, ["de-DE"]);
    try {
        assert.equal(chapterTitle(chapters[0]!, 0), "Kapitel 1");
    } finally {
        setAppLanguage(null);
    }
    setAppLanguage("ar", SHIPPED_LANGUAGES, ["ar-SA"]);
    try {
        assert.match(chapterTitle(chapters[0]!, 0), /١/);
    } finally {
        setAppLanguage(null);
    }
    assert.equal(currentChapter(chapters, 29.9), 0);
    assert.equal(currentChapter(chapters, 30), 1);
    assert.equal(currentChapter(chapters, -1), -1);
    assert.deepEqual(decodePlayerChapters({ versions: [{ file_id: "42" }] }, "42"), []);
    assert.throws(() => decodePlayerChapters({ versions: [{ file_id: "42", chapters: [{ index: 0, title: "Bad", start_seconds: -1, end_seconds: 2 }] }] }, "42"));
});

test("AVPlay speed options are the supported Apple intersection; omit unproven crop-to-fill", () => {
    assert.deepEqual(videoOptions(true, true, "http_progressive"), { speeds: [1, 2], aspects: ["Fit", "Stretch"] });
    assert.deepEqual(videoOptions(true, true, "hls").speeds, []);
    assert.deepEqual(videoOptions(false, false, "http"), { speeds: [], aspects: [] });
});

/** The fixture's plan with `patch` laid over its `playback_plan`, as a server would send it. */
function planWith(patch: (plan: Record<string, unknown>) => void): PlaybackPlan {
    const wire = fixture("playback_start_opaque_ids");
    const plan = structuredClone(wire.playback_plan) as Record<string, unknown>;
    patch(plan);
    const decision = decodePlaybackDecision({ ...wire, playback_plan: plan });
    assert.ok(decision.outcome === "playable");
    return decision.plan;
}

const STEREO = { isDefault: true, language: "eng", codec: "aac", channels: 2, title: undefined };

// PlaybackStats.playbackRows/streamRows/engineRows and InfoNowPlayingRows (silo-apple e0337595, #1178).
test("Stats groups the plan's facts as Apple's Playback, Stream and Engine rows, one row per fact", () => {
    const plan = planWith(() => undefined);
    const stats = planStats(plan, { audio: { track: STEREO, ordinal: 0 }, subtitle: undefined, speed: 1, status: "Playing", host: "media.example" });
    assert.deepEqual(stats.nowPlaying, [
        { label: "Video", value: "1080p" },
        { label: "Audio", value: "English · AAC Stereo" },
        { label: "Subtitles", value: "Off" },
        { label: "Playback", value: "Direct play" },
    ]);
    assert.deepEqual(stats.playback, [
        { label: "Playback", value: "Direct play · MP4" },
        { label: "Video", value: "H.264 · 1920×1080 · 23.976 fps · 8.0 Mbps" },
        { label: "Dynamic range", value: "SDR" },
        { label: "Audio", value: "English · AAC Stereo" },
        { label: "Subtitles", value: "Off" },
        { label: "Diagnostics", value: "Validated original playback" },
    ]);
    assert.deepEqual(stats.stream, [{ label: "Playback status", value: "Playing" }]);
    assert.deepEqual(stats.engine, [{ label: "Delivery", value: "Original HTTP" }, { label: "Source", value: "media.example" }]);
});

test("a transcode names the server's work, the range change, the speed and every warning under one Diagnostics label", () => {
    const plan = planWith(plan => {
        plan.delivery = "server_transcode_hls";
        plan.decision_reason = "video_codec_unsupported";
        plan.degradation_warnings = [{ code: "hdr_tonemapped", message: "HDR was tone-mapped to SDR." }];
        plan.source = { ...(plan.source as Record<string, unknown>), container: "matroska", video_codec: "hevc", width: 3840, height: 1600, dynamic_range: "dolby_vision", dolby_vision_profile: 8 };
        plan.effective_recipe = { ...(plan.effective_recipe as Record<string, unknown>), video_codec: "hevc", width: 3840, height: 1600, frame_rate: 24, bitrate_kbps: 20000, dynamic_range: "sdr" };
    });
    const forced = plan.subtitle.inventory[1];
    assert.ok(forced !== undefined);
    const stats = planStats(plan, {
        audio: { track: { isDefault: false, language: "por", codec: "eac3", channels: 6, title: "Portuguese" }, ordinal: 1 },
        subtitle: { entry: { ...forced, language: "por", label: "Forced", codec: "pgs" }, generated: undefined },
        speed: 2, status: "Paused", host: "media.example",
    });
    assert.deepEqual(stats.nowPlaying.map(row => row.value), ["4K", "Portuguese · EAC3 5.1", "Portuguese (Forced)", "Transcoded by the server"]);
    assert.deepEqual(stats.playback, [
        { label: "Playback", value: "Transcoded by the server · MKV" },
        { label: "Video", value: "HEVC · 3840×1600 · 24 fps · 20.0 Mbps" },
        { label: "Dynamic range", value: "Dolby Vision Profile 8 → SDR" },
        // Stats names the audio that reaches the TV (the recipe's AAC stereo); Info keeps the track as the Audio tab names it.
        { label: "Audio", value: "Portuguese · AAC Stereo" },
        { label: "Subtitles", value: "Portuguese · PGS · Forced" },
        { label: "Playback rate", value: "2×" },
        { label: "Diagnostics", value: "Video codec unsupported" },
        { label: "", value: "HDR was tone-mapped to SDR." },
    ]);
    assert.deepEqual(stats.stream, [{ label: "Playback status", value: "Paused" }]);
    assert.deepEqual(stats.engine, [{ label: "Delivery", value: "Server Transcode HLS" }, { label: "Source", value: "media.example" }]);
});

test("Now playing names an HDR picture by its class and range, and leaves out what the plan does not say", () => {
    const hdr = planWith(plan => {
        plan.source = { ...(plan.source as Record<string, unknown>), dynamic_range: "hdr10" };
        plan.effective_recipe = { ...(plan.effective_recipe as Record<string, unknown>), width: 1440, height: 1080, dynamic_range: "hdr10" };
    });
    const stats = planStats(hdr, { audio: undefined, subtitle: undefined, speed: undefined, status: "Rebuffering", host: undefined });
    assert.deepEqual(stats.nowPlaying, [{ label: "Video", value: "1080p · HDR10" }, { label: "Subtitles", value: "Off" }, { label: "Playback", value: "Direct play" }]);
    assert.deepEqual(stats.playback.map(row => row.label), ["Playback", "Video", "Dynamic range", "Subtitles", "Diagnostics"]);
    assert.equal(stats.playback.find(row => row.label === "Dynamic range")?.value, "HDR10");
    assert.deepEqual(stats.stream, [{ label: "Playback status", value: "Rebuffering" }]);
    assert.deepEqual(stats.engine, [{ label: "Delivery", value: "Original HTTP" }]);
});

test("a remux reads as remuxed by the server, and an AI track keeps its own name", () => {
    const plan = planWith(plan => { plan.delivery = "server_remux_hls"; });
    const first = plan.subtitle.inventory[0];
    assert.ok(first !== undefined);
    const stats = planStats(plan, { audio: undefined, subtitle: { entry: first, generated: "English (AI)" }, speed: 1, status: "Playing", host: undefined });
    assert.equal(stats.nowPlaying.find(row => row.label === "Playback")?.value, "Remuxed by the server");
    assert.equal(stats.nowPlaying.find(row => row.label === "Subtitles")?.value, "English (AI)");
    assert.equal(stats.playback.find(row => row.label === "Subtitles")?.value, "English (AI)");
    assert.equal(stats.engine[0]?.value, "Server Remux HLS");
});

test("a recipe with no channel count names its codec alone, never the source track's layout", () => {
    const plan = planWith(plan => {
        const recipe = { ...(plan.effective_recipe as Record<string, unknown>) };
        delete recipe.audio_channels;
        plan.effective_recipe = recipe;
    });
    const stats = planStats(plan, { audio: { track: { isDefault: true, language: "eng", codec: "dts", channels: 6, title: undefined }, ordinal: 0 }, subtitle: undefined, speed: 1, status: "Playing", host: undefined });
    assert.equal(stats.playback.find(row => row.label === "Audio")?.value, "English · AAC");
    assert.equal(stats.nowPlaying.find(row => row.label === "Audio")?.value, "English · DTS 5.1");
});

test("with no source range, Dynamic range names what the recipe delivers", () => {
    const plan = planWith(plan => {
        const source = { ...(plan.source as Record<string, unknown>) };
        delete source.dynamic_range;
        plan.source = source;
        plan.effective_recipe = { ...(plan.effective_recipe as Record<string, unknown>), dynamic_range: "hdr10" };
    });
    const stats = planStats(plan, { audio: undefined, subtitle: undefined, speed: 1, status: "Playing", host: undefined });
    assert.equal(stats.playback.find(row => row.label === "Dynamic range")?.value, "HDR10");
});

// AetherPlaybackStatsProjection.playMethodLabel (silo-apple b54fefb1): the play method reads Apple's player.stats.playMethod* keys.
test("the play method reads in the shown language, as Apple's playMethodLabel does", () => {
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    try {
        const methods = (["original_http", "server_remux_hls", "server_remux_progressive", "server_transcode_hls"] as const).map(delivery => {
            const stats = planStats(planWith(plan => { plan.delivery = delivery; }), { audio: undefined, subtitle: undefined, speed: 1, status: "Playing", host: undefined });
            return [stats.nowPlaying.at(-1)?.value, stats.playback[0]?.value];
        });
        assert.deepEqual(methods, [
            ["Direktwiedergabe", "Direktwiedergabe · MP4"],
            ["Vom Server neu verpackt", "Vom Server neu verpackt · MP4"],
            ["Vom Server neu verpackt", "Vom Server neu verpackt · MP4"],
            ["Vom Server transcodiert", "Vom Server transcodiert · MP4"],
        ]);
    } finally { setAppLanguage(null); }
});

// AetherPlaybackStatsProjection.phaseLabel and deliveryLabel (silo-apple main 71a3beb9, lines 60-70 and 529-542), and
// PlaybackStats' Diagnostics row (PlaybackStats.swift:121): the status, the delivery and the Diagnostics label read the catalog.
test("Stats' status, delivery and Diagnostics read in the shown language, as Apple's projection does", () => {
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    try {
        const statuses = (["Playing", "Paused", "Rebuffering"] as const).map(status => planStats(planWith(() => undefined), { audio: undefined, subtitle: undefined, speed: 1, status, host: undefined }).stream[0]?.value);
        assert.deepEqual(statuses, ["Wird abgespielt", "Pausiert", "Wird erneut gepuffert"]);
        const deliveries = (["original_http", "server_remux_progressive", "server_remux_hls", "server_transcode_hls"] as const).map(delivery =>
            planStats(planWith(plan => { plan.delivery = delivery; }), { audio: undefined, subtitle: undefined, speed: 1, status: "Playing", host: undefined }).engine[0]);
        assert.deepEqual(deliveries, [
            { label: "Delivery", value: "Original-HTTP" },
            { label: "Delivery", value: "Server-Remux" },
            { label: "Delivery", value: "Server-Remux (HLS)" },
            { label: "Delivery", value: "Server-Transkodierung (HLS)" },
        ]);
        const notes = planStats(planWith(plan => { plan.decision_reason = "video_codec_unsupported"; }), { audio: undefined, subtitle: undefined, speed: 1, status: "Playing", host: undefined }).playback.at(-1);
        assert.deepEqual(notes, { label: "Diagnostics", value: "Video codec unsupported" }, "the label stays the row's id; the reason is server text");
        assert.equal(statLabel("Diagnostics"), "Diagnose");
        assert.equal(statLabel("Delivery"), "Bereitstellung");
    } finally { setAppLanguage(null); }
});
