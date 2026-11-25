// #874: audio and subtitle evidence from the collector through the real manual and automatic send path into the relay,
// against fresh fake GitHub destinations. The relay-only cases live in fixtures/diagnostics-relay/mediaCases.js.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import {
    buildDiagnosticsReportUrl,
    DiagnosticsCollector,
    type DiagnosticsFetch,
    diagnosticsPayload,
    diagnosticsReportFingerprint,
    sendDiagnosticsReportFor,
} from "../../src/diagnostics.ts";
import {
    cleanIncidentCode,
    cleanTraceStep,
    type DiagnosticsIncidentPayload,
    type DiagnosticsMediaPayload,
    incidentAutoEligible,
    type MediaEvidence,
    type MediaFailure,
    mediaIncident,
    type PlaybackAttemptTrace,
    publicMediaEvidence,
} from "../../src/diagnosticsIncident.ts";
import type { AVPlay, AVPlayTrackInfo } from "../../src/player/avplay.ts";
import { readAvplayAudio } from "../../src/player/mediaEvidence.ts";
import { handleRequest, type RelayIncident, type RelayMedia } from "../../workers/diagnostics-relay/worker.js";
import { assertNoSensitive } from "./fixtures/diagnostics-relay/assertions.js";
import { type FakeGitHub, fakeGitHub } from "./fixtures/diagnostics-relay/fakeGitHub.js";
import { MemoryPublicStorage } from "./support/keyManager.ts";

// Compile-time drift checks: the client's public records must stay assignable to what the relay declares.
export function clientMediaFitsRelay(md: DiagnosticsMediaPayload): RelayMedia { return md; }
export function clientIncidentFitsRelay(inc: DiagnosticsIncidentPayload): RelayIncident { return inc; }

const DEVICE = { appVersion: "0.5.0", tvModel: "QE65S95C" };

function fakeClock(startMs: number): Clock {
    return { now: () => startMs, schedule: () => () => undefined };
}

function collector(): DiagnosticsCollector {
    return new DiagnosticsCollector(DEVICE, fakeClock(1_000_000), new MemoryPublicStorage(), () => ({}));
}

function trace(overrides: Partial<PlaybackAttemptTrace> = {}): PlaybackAttemptTrace {
    return {
        seq: 1, chain: 0, stage: "playing", done: "playing", first: undefined, http: undefined, decision: undefined, firstAvplay: undefined, lastAvplay: undefined,
        resends: 0, fallbacks: 0, reconnects: 0, opened: true, shown: true, recovered: false, exhausted: false, steps: ["playing:ok", "caption_load:fail:caption_load_failed"],
        settings: { quality: "auto", capKbps: undefined, hdr: true },
        hdrPanel: { hdr10: true, hlg: true, dolbyVision: false },
        request: { startSeconds: undefined, subtitle: "track", audio: "default" },
        plan: {
            delivery: "original_http", protocol: "http", container: "mkv", quality: "original", sourceKbps: 24000, videoCodec: "hevc",
            width: 3840, height: 2160, dynamicRange: "hdr10", startSeconds: 0, atSeconds: 754,
        },
        ...overrides,
    };
}

function evidence(overrides: Partial<MediaEvidence> = {}, subtitle: Partial<MediaEvidence["subtitle"]> = {}): MediaEvidence {
    return {
        audio: { language: "en", source: { codec: "eac3", channels: 6 }, planned: { codec: "aac", channels: 2 }, observed: { codec: "eac3", channels: 6 } },
        subtitle: {
            mode: "render",
            track: { source: "embedded", delivery: "sidecar", codec: "subrip", language: "nl", forced: false, hearingImpaired: false },
            drawnBy: "overlay", load: "failed", cues: 0, syncMs: 0, secondary: false,
            ...subtitle,
        },
        switch: { kind: "subtitle", result: "ok" },
        ...overrides,
    };
}

const CAPTION_FAILED: MediaFailure = { n: 1, stage: "caption_load", out: "failed", code: "caption_load_failed", http: undefined, network: false };

/** The relay, reached through the client's own fetch seam, writing into `destination`. */
function relayFetch(destination: FakeGitHub): DiagnosticsFetch {
    return (url, init) => handleRequest(new Request(url, init), { GITHUB_TOKEN: "test-secret-not-real" }, {
        fetch: (input, request) => destination.fetch(input, request),
        rateLimiter: { limit: async () => ({ success: true }) },
    });
}

const withoutSourceRow = (body: string | undefined): string => (body ?? "").split("\n").filter(line => !line.startsWith("| Submission source |")).join("\n");

test("the public media record keeps validated structured fields only, and an observed zero differs from not loaded", () => {
    const tainted = publicMediaEvidence(evidence({
        audio: { language: "English (SYNTH_TRACK)", source: { codec: "SYNTH_TRACK", channels: 0 }, planned: undefined, observed: { codec: "DTS", channels: 6 } },
        switch: { kind: "audio", result: "failed", code: "synth_title_the_movie" },
    }, { track: { source: "SYNTH_PATH", delivery: "sidecar", codec: "PGS", language: "pt-BR", forced: true, hearingImpaired: false }, load: "loaded", cues: 0, syncMs: -250.4 }));
    assert.deepEqual(tainted.a, { src: "unavailable", pl: "unavailable", obs: { c: "dts", ch: 6 } }, "an invalid language, codec and channel count are dropped; a missing plan is unavailable, never inferred");
    assert.deepEqual(tainted.s, { mode: "render", src: "unknown", dl: "sidecar", c: "pgs", lang: "pt-br", f: true, hi: false, via: "overlay", ld: "loaded", cues: 0, sync: -250, sec: false });
    assert.deepEqual(tainted.sw, { k: "audio", r: "failed" }, "an unrecognized switch code is dropped");
    assert.doesNotMatch(JSON.stringify(tainted), /SYNTH|synth/);

    const loading = publicMediaEvidence(evidence({}, { load: "loading", cues: 4 }));
    assert.equal("cues" in loading.s, false, "cues arriving during a load are not a completed count");
    const native = publicMediaEvidence(evidence({}, { drawnBy: "avplay", load: "fallback", syncMs: 500 }));
    assert.equal("sync" in native.s, false, "the delay never moves AVPlay's text, so none is reported as applied");
    const off = publicMediaEvidence(evidence({ switch: undefined }, { mode: "off", drawnBy: "none", load: "not_needed" }));
    assert.deepEqual(off.s, { mode: "off", via: "none", ld: "not_needed", sec: false }, "Off carries no track, cues or delay");
    assert.equal("sw" in off, false);
});

test("only a definite caption-load or switch failure files automatically; each stage and code groups separately", () => {
    const failure = (stage: MediaFailure["stage"], out: MediaFailure["out"], code: string, network = false, http?: number): DiagnosticsIncidentPayload =>
        mediaIncident(trace(), { n: 1, stage, out, code, http, network });
    const caption = failure("caption_load", "failed", "caption_load_failed");
    assert.deepEqual([caption.cat, caption.op, caption.stage, caption.code, caption.fs, caption.rec.r], ["audio_subtitles", "subtitle_download", "caption_load", "caption_load_failed", "caption_load", "none"]);
    assert.equal(incidentAutoEligible(caption), true);
    const audio = failure("audio_switch", "failed", "http_500", false, 500);
    assert.deepEqual([audio.op, audio.http, audio.code], ["replan_playback", 500, "http_500"]);
    assert.equal(incidentAutoEligible(audio), true);
    assert.equal(incidentAutoEligible(failure("subtitle_switch", "refused", "subtitle_selection_unavailable")), false, "an unavailable selection is an expected refusal");
    const rescued = failure("caption_load", "recovered", "caption_load_failed");
    assert.deepEqual([rescued.out, rescued.rec.r, rescued.fs], ["recovered", "recovered", undefined]);
    assert.equal(incidentAutoEligible(rescued), false);
    const lost = failure("subtitle_switch", "failed", "no_answer", true);
    assert.equal(lost.kind, "network");
    assert.equal(incidentAutoEligible(lost), false, "a lost answer is a connectivity symptom");
    const snapshot = { device: DEVICE, events: [] };
    const keys = [caption, audio, failure("subtitle_switch", "failed", "http_500", false, 500), failure("subtitle_switch", "failed", "http_409", false, 409)]
        .map(incident => diagnosticsReportFingerprint({ snapshot, incident }));
    assert.equal(new Set(keys).size, 4, "caption load, audio switch and two subtitle switch causes are four groups");
    assert.equal(diagnosticsReportFingerprint({ snapshot, incident: { ...caption, src: "auto" } }), keys[0], "submission source is not in the key");
    // The server's camelCase route classification keeps its code in playback traces.
    assert.equal(cleanIncidentCode("audioTrackSwitchFailed"), "audio_track_switch_failed");
    assert.equal(cleanTraceStep("avplay_play:fallback:audioTrackSwitchFailed"), "avplay_play:fallback:audio_track_switch_failed");
    assert.equal(cleanTraceStep("subtitle_switch:refused:subtitle_selection_unavailable"), "subtitle_switch:refused:subtitle_selection_unavailable");
});

/** The documented AVPlay surface with only the stream-info call under test. */
function avplayWith(getCurrentStreamInfo?: () => readonly AVPlayTrackInfo[]): AVPlay {
    const noop = (): void => undefined;
    return {
        open: noop, close: noop, prepareAsync: noop, setDisplayRect: noop, setListener: noop, play: noop, pause: noop, seekTo: noop, stop: noop,
        getState: () => "PLAYING", getCurrentTime: () => 0,
        ...(getCurrentStreamInfo === undefined ? {} : { getCurrentStreamInfo }),
    };
}

test("AVPlay's audio row is read defensively: a missing call, a refused state or an unusable row is unavailable, never guessed", () => {
    const audioRow = (extra: string): readonly AVPlayTrackInfo[] => [{ index: 1, type: "TEXT", extra_info: "{}" }, { index: 2, type: "AUDIO", extra_info: extra }];
    assert.equal(readAvplayAudio(avplayWith()), undefined, "older firmware without getCurrentStreamInfo");
    assert.equal(readAvplayAudio(avplayWith(() => { throw new DOMException("not now", "InvalidStateError"); })), undefined, "an invalid player state");
    assert.equal(readAvplayAudio(avplayWith(() => [{ index: 1, type: "TEXT", extra_info: "{}" }])), undefined, "no AUDIO row");
    assert.equal(readAvplayAudio(avplayWith(() => audioRow("not json"))), undefined);
    assert.equal(readAvplayAudio(avplayWith(() => audioRow("{\"language\":\"eng\"}"))), undefined, "a row naming neither codec nor channels");
    assert.equal(readAvplayAudio(avplayWith(() => audioRow("{\"channels\":\"six\"}"))), undefined);
    assert.deepEqual(readAvplayAudio(avplayWith(() => audioRow("{\"channels\":\"6\",\"fourCC\":\"audio/x-eac3\"}"))), { codec: "eac3", channels: 6 });
    assert.deepEqual(readAvplayAudio(avplayWith(() => audioRow("{\"channels\":2,\"codec\":\"AAC\"}"))), { codec: "aac", channels: 2 });
});

test("a captured caption-load incident freezes its media record and renders identically through the manual and automatic paths", async () => {
    const diagnostics = collector();
    diagnostics.setAutoReportEnabled(true);
    const scope = diagnostics.beginPlaybackSession();
    diagnostics.recordMediaEvidence(scope, evidence());
    const record = diagnostics.recordMediaIncident(scope, trace(), CAPTION_FAILED);
    assert.ok(record !== undefined);
    assert.equal(diagnostics.recordMediaIncident(scope, trace(), CAPTION_FAILED), record, "one failure is captured once");
    diagnostics.recordMediaEvidence(scope, evidence({ switch: { kind: "audio", result: "pending" } }, { load: "loaded", cues: 40 }));
    assert.equal(record.snapshot.media?.s.ld, "failed", "the record keeps the evidence as it stood at the failure");
    assert.equal(diagnostics.reportFor("audio_subtitles"), record, "Audio / Subtitles selects the captured incident");
    assert.equal(diagnostics.reportFor("playback").incident, undefined, "a caption failure leaves playback running, so it never answers Playback failed");
    assert.equal(diagnosticsPayload(record.snapshot, { category: record.category, incident: record.incident }).md?.s.ld, "failed");

    const fingerprint = diagnostics.claimAutoReport(record);
    assert.ok(fingerprint !== undefined, "a definite failure is claimed while reporting is on");
    const auto = fakeGitHub();
    const manual = fakeGitHub();
    const sentAuto = await sendDiagnosticsReportFor(record, relayFetch(auto), { auto: true });
    const sentManual = await sendDiagnosticsReportFor(diagnostics.reportFor("audio_subtitles"), relayFetch(manual));
    assert.ok(sentAuto.ok && sentManual.ok);
    const autoIssue = auto.created()[0]?.body;
    const manualIssue = manual.created()[0]?.body;
    assert.equal(autoIssue?.title, "Subtitles failed to load during playback");
    assert.equal(manualIssue?.title, autoIssue?.title);
    assert.equal(withoutSourceRow(manualIssue?.body), withoutSourceRow(autoIssue?.body), "same technical evidence from both entry points");
    assert.match(autoIssue?.body ?? "", /\| Submission source \| Automatic error report \|/);
    assert.match(manualIssue?.body ?? "", /\| Submission source \| Manual \|/);
    assert.match(autoIssue?.body ?? "", /\| Subtitle file load \| Failed \|/);

    const shared = fakeGitHub();
    await sendDiagnosticsReportFor(record, relayFetch(shared), { auto: true });
    const again = await sendDiagnosticsReportFor(diagnostics.reportFor("audio_subtitles"), relayFetch(shared));
    assert.ok(again.ok);
    assert.equal(again.status, "duplicate");
    assert.equal(shared.issues.length, 1, "one incident is one issue");
    for (const destination of [auto, manual, shared]) assertNoSensitive(destination, "client media report");
});

test("with automatic reporting off a definite switch failure sends nothing, and manual reporting still files it", async () => {
    const diagnostics = collector();
    const scope = diagnostics.beginPlaybackSession();
    diagnostics.recordMediaEvidence(scope, evidence({ switch: { kind: "audio", result: "failed", code: "http_500" } }, { load: "loaded", cues: 12 }));
    const record = diagnostics.recordMediaIncident(scope, trace(), { n: 1, stage: "audio_switch", out: "failed", code: "http_500", http: 500, network: false });
    assert.ok(record !== undefined);
    const destination = fakeGitHub();
    // app.ts triggerAutoReport: only a claimed incident is sent.
    const claimed = diagnostics.claimAutoReport(record);
    if (claimed !== undefined) await sendDiagnosticsReportFor(record, relayFetch(destination), { auto: true });
    assert.equal(claimed, undefined);
    assert.equal(destination.outbound.length, 0, "zero automatic sends while disabled");
    const manual = await sendDiagnosticsReportFor(diagnostics.reportFor("audio_subtitles"), relayFetch(destination));
    assert.ok(manual.ok);
    assert.equal(destination.created()[0]?.body.title, "Audio track switch failed during playback: HTTP 500");
});

test("a viewer-observed Audio / Subtitles report carries the live media record; a new attempt or profile change clears it", () => {
    const diagnostics = collector();
    const scope = diagnostics.beginPlaybackSession();
    diagnostics.recordMediaEvidence(scope, evidence({}, { load: "loaded", cues: 0 }));
    const report = diagnostics.reportFor("audio_subtitles");
    assert.equal(report.incident, undefined, "no failure was detected");
    assert.equal(report.snapshot.media?.s.cues, 0, "a completed load with no cues is reported as an observed zero");
    assert.equal(diagnosticsPayload(report.snapshot, { category: "audio_subtitles" }).md?.s.cues, 0);
    const fragment = buildDiagnosticsReportUrl(report.snapshot).split("#d=")[1] ?? "";
    const qr: unknown = JSON.parse(atob(fragment.replace(/-/g, "+").replace(/_/g, "/")));
    assert.ok(typeof qr === "object" && qr !== null && !("md" in qr), "the QR helper page cannot show md, so it does not spend the QR budget");

    const next = diagnostics.beginPlaybackSession();
    assert.equal(diagnostics.reportFor("audio_subtitles").snapshot.media, undefined, "a new attempt never inherits the previous attempt's media");
    diagnostics.recordMediaEvidence(next, evidence());
    diagnostics.clear();
    diagnostics.recordMediaEvidence(next, evidence());
    assert.equal(diagnostics.reportFor("audio_subtitles").snapshot.media, undefined, "a profile change clears it, and the ended session cannot record again");
    assert.equal(diagnostics.hasReportableData(), false);
});
