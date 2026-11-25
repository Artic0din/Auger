import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import { AUTO_REPORT_COOLDOWN_MS, DiagnosticsCollector, diagnosticsReportFingerprint, sendDiagnosticsReportFor } from "../../src/diagnostics.ts";
import { cleanTraceStep, incidentAutoEligible, type PlaybackAttemptTrace, playbackIncident } from "../../src/diagnosticsIncident.ts";
import type { PlaybackError } from "../../src/player/controller.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

function fakeClock(startMs: number): Clock & { set(ms: number): void } {
    let current = startMs;
    return { now: () => current, schedule: () => () => undefined, set: (ms: number) => { current = ms; } };
}

const DEVICE = { appVersion: "0.4.1", tvModel: "QA77S95CAWXXY" };

function trace(overrides: Partial<PlaybackAttemptTrace> = {}): PlaybackAttemptTrace {
    return {
        seq: 1, stage: "start", done: "settings", first: undefined, http: undefined, decision: undefined, firstAvplay: undefined, lastAvplay: undefined,
        resends: 0, fallbacks: 0, reconnects: 0, opened: false, shown: false, recovered: false, steps: [],
        settings: { quality: "auto", capKbps: undefined, hdr: true },
        hdrPanel: { hdr10: true, hlg: true, dolbyVision: false },
        request: { startSeconds: undefined, subtitle: "auto", audio: "default" },
        plan: undefined,
        ...overrides,
    };
}

const SESSION_EXPIRED: PlaybackError = { kind: "terminal", reason: "session_expired", message: "Cannot play", retryable: true };

function collector(storage = new MemoryPublicStorage(), clock = fakeClock(1_000_000)): DiagnosticsCollector {
    return new DiagnosticsCollector(DEVICE, clock, storage, () => ({ memory: "11 / 10 MB" }));
}

test("a start refused with session_expired and a missing session with an observed 404 keep distinct evidence and grouping", () => {
    const refused = playbackIncident(trace({ decision: "adaptation_unavailable" }), SESSION_EXPIRED);
    const missing = playbackIncident(trace({ stage: "progress", done: "playing", http: 404, opened: true, shown: true }), { kind: "session_expired" });
    assert.ok(refused !== undefined && missing !== undefined);
    assert.deepEqual([refused.op, refused.stage, refused.code, refused.http, refused.dec], ["start_playback", "start", "session_expired", undefined, "adaptation_unavailable"]);
    assert.deepEqual([missing.op, missing.stage, missing.code, missing.http, missing.open], ["progress_report", "progress", "http_404", 404, true]);
    const fingerprint = (incident: typeof refused) => diagnosticsReportFingerprint({ snapshot: { device: DEVICE, events: [] }, incident });
    assert.notEqual(fingerprint(refused), fingerprint(missing));
    assert.equal(playbackIncident(trace(), { kind: "session_expired" })?.code, "session_missing", "no status is invented without an answer");
});

test("an expected refusal and a retried success never file; a failure after recovery is exhausted files once", () => {
    const storage = new MemoryPublicStorage();
    const clock = fakeClock(1_000_000);
    const diagnostics = collector(storage, clock);
    diagnostics.setAutoReportEnabled(true);
    const scope = diagnostics.beginPlaybackSession();

    const refusal = diagnostics.recordPlaybackIncident(scope, trace({ seq: 1, stage: "subtitles" }), { kind: "terminal", reason: "version_unavailable", message: "x", retryable: false });
    assert.equal(refusal?.incident.out, "refused");
    assert.equal(refusal === undefined ? "none" : diagnostics.claimAutoReport(refusal), undefined);

    assert.equal(diagnostics.recordPlaybackIncident(scope, trace({ seq: 2, stage: "playing", shown: true, resends: 2, steps: ["start:retry:http_503", "start:retry:http_503", "start:ok"] })), undefined, "a retried success is no incident");

    const exhausted = diagnostics.recordPlaybackIncident(scope, trace({
        seq: 3, stage: "avplay_prepare", opened: true, fallbacks: 3,
        first: { stage: "avplay_prepare", code: "prepareAsync:UnknownError", buffering: false },
        firstAvplay: "prepareAsync:UnknownError", lastAvplay: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT",
    }), { kind: "playback_failed" });
    assert.ok(exhausted !== undefined);
    assert.equal(exhausted.incident.rec.r, "exhausted");
    assert.deepEqual(exhausted.incident.av, { f: "prepareAsync:UnknownError", l: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT" });
    const fingerprint = diagnostics.claimAutoReport(exhausted);
    assert.ok(fingerprint !== undefined);
    assert.equal(diagnostics.claimAutoReport(exhausted), undefined, "one incident files once");
    diagnostics.markAutoDelivered(fingerprint);
    clock.set(1_000_000 + AUTO_REPORT_COOLDOWN_MS + 1);
    const repeat = diagnostics.recordPlaybackIncident(scope, trace({ seq: 4, stage: "avplay_prepare", first: { stage: "avplay_prepare", code: "prepareAsync:UnknownError", buffering: false }, lastAvplay: "PLAYER_ERROR_INVALID_STATE" }), { kind: "playback_failed" });
    assert.ok(repeat !== undefined);
    assert.equal(diagnosticsReportFingerprint(repeat), fingerprint, "same first failure, different final code: same group");
    assert.equal(diagnostics.claimAutoReport(repeat), undefined, "a delivered group is not filed again");

    const other = playbackIncident(trace({ stage: "avplay_prepare", first: { stage: "avplay_prepare", code: "startup_timeout", buffering: false } }), { kind: "playback_failed" });
    assert.ok(other !== undefined);
    assert.notEqual(diagnosticsReportFingerprint({ snapshot: exhausted.snapshot, incident: other }), fingerprint, "a different first failure is a different group");
});

test("automatic reporting off never claims, while manual reporting still selects the incident", () => {
    const diagnostics = collector();
    const scope = diagnostics.beginPlaybackSession();
    const record = diagnostics.recordPlaybackIncident(scope, trace(), SESSION_EXPIRED);
    assert.ok(record !== undefined);
    assert.equal(diagnostics.claimAutoReport(record), undefined);
    assert.equal(diagnostics.reportFor("playback"), record);
});

test("manual and automatic submissions of one incident send identical technical evidence and differ only in source", async () => {
    const clock = fakeClock(1_000_000);
    let heap = 10;
    const diagnostics = new DiagnosticsCollector(DEVICE, clock, new MemoryPublicStorage(), () => ({ memory: `${heap++} MB` }));
    diagnostics.setAutoReportEnabled(true);
    const scope = diagnostics.beginPlaybackSession();
    const record = diagnostics.recordPlaybackIncident(scope, trace({ decision: "adaptation_unavailable" }), SESSION_EXPIRED);
    assert.ok(record !== undefined);
    // Later activity in the same session must not change what the incident says.
    clock.set(1_000_000 + 10 * 60_000);
    diagnostics.recordEvent("app", "later navigation");
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ reportId: "AUG-1", status: "created" }), { status: 200 });
    };
    await sendDiagnosticsReportFor(record, fetchFn, { auto: true });
    await sendDiagnosticsReportFor(diagnostics.reportFor("playback"), fetchFn);
    const [auto, manual] = bodies;
    assert.ok(auto !== undefined && manual !== undefined);
    const strip = (body: Record<string, unknown>) => {
        const { auto: _auto, inc, ...rest } = body;
        const { src, ...technical } = inc as Record<string, unknown>;
        return { rest, technical, src };
    };
    assert.deepEqual(strip(manual).rest, strip(auto).rest);
    assert.deepEqual(strip(manual).technical, strip(auto).technical);
    assert.equal(strip(auto).src, "auto");
    assert.equal(strip(manual).src, "manual");
    assert.ok(!JSON.stringify(manual).includes("later navigation"));
    assert.equal(diagnosticsReportFingerprint(record), diagnosticsReportFingerprint(diagnostics.reportFor("playback")));
});

test("a profile session that ends clears its incidents and ignores a stale player's late capture", () => {
    const diagnostics = collector();
    diagnostics.setAutoReportEnabled(true);
    const scope = diagnostics.beginPlaybackSession();
    const record = diagnostics.recordPlaybackIncident(scope, trace(), SESSION_EXPIRED);
    assert.ok(record !== undefined);
    diagnostics.clear();
    assert.equal(diagnostics.incidentFor("playback"), undefined);
    assert.equal(diagnostics.claimAutoReport(record), undefined, "evidence from an ended session is never sent");
    assert.equal(diagnostics.recordPlaybackIncident(scope, trace({ seq: 2 }), SESSION_EXPIRED), undefined, "a stale scope cannot record into the new session");
    const fresh = diagnostics.reportFor("playback");
    assert.equal(fresh.incident, undefined, "without an incident a manual report is user-observed");
    assert.equal(fresh.category, "playback");
});

test("a failed buffering-quality replan that ends playback belongs to Buffering / Quality, also when reported as Playback failed", () => {
    const diagnostics = collector();
    const scope = diagnostics.beginPlaybackSession();
    const record = diagnostics.recordPlaybackIncident(scope, trace({
        stage: "reconnect", opened: true, shown: true, reconnects: 1,
        first: { stage: "quality_change", code: "no_answer", buffering: true },
    }), { kind: "network" });
    assert.ok(record !== undefined);
    assert.equal(record.category, "buffering");
    assert.equal(record.incident.op, "replan_playback");
    assert.equal(record.incident.stage, "quality_change");
    assert.equal(diagnostics.reportFor("playback"), record, "Playback failed selects the same incident");
    assert.equal(diagnostics.reportFor("buffering"), record);
    assert.equal(diagnosticsReportFingerprint(diagnostics.reportFor("playback")), diagnosticsReportFingerprint(record));
    const unrelated = playbackIncident(trace({ stage: "avplay_prepare" }), { kind: "playback_failed" });
    assert.equal(unrelated?.cat, "playback", "an independent playback failure keeps its own category");
});

test("incident serialization drops synthetic sensitive markers from codes, steps, plan and settings", () => {
    const marker = "SECRETMARK";
    const incident = playbackIncident(trace({
        stage: "avplay_prepare",
        first: { stage: "avplay_prepare", code: `https://${marker}.example/stream?token=${marker}`, buffering: false },
        firstAvplay: `open:${marker}Error`, lastAvplay: `PLAYER_ERROR_${marker}`,
        steps: [`avplay_prepare:fail:${marker}`, `${marker}:ok`, "avplay_prepare:bogus", "start:ok:http_200"],
        settings: { quality: `${marker} quality`, capKbps: 4000, hdr: false },
        plan: { delivery: marker, protocol: `hls ${marker}`, container: "mkv", quality: "1080p", sourceKbps: 5700, videoCodec: "h264", width: 1920, height: 1080, dynamicRange: "sdr", startSeconds: 139.4, atSeconds: 140.9 },
    }), { kind: "terminal", reason: `Movie ${marker} title`, message: marker, retryable: false });
    assert.ok(incident !== undefined);
    const json = JSON.stringify(incident);
    assert.ok(!json.includes(marker), json);
    assert.equal(incident.code, "terminal_error");
    assert.deepEqual(incident.av, { f: "open:error" });
    assert.deepEqual(incident.t, ["avplay_prepare:fail", "start:ok:http_200"]);
    assert.ok(incident.pl !== "not_reached" && incident.pl.dl === "unknown" && incident.pl.pr === undefined && incident.pl.pos === 139);
    assert.ok(incident.set !== "not_reached" && incident.set.q === "unknown" && incident.set.cap === 4000 && incident.set.hdr === false);
    assert.equal(cleanTraceStep("playing:recovered"), "playing:recovered");
    assert.equal(incidentAutoEligible(incident), true);
});

test("unavailable, not reached and observed zero stay distinguishable", () => {
    const before = playbackIncident(trace({ stage: "capabilities", done: undefined, settings: undefined }), { kind: "network" });
    assert.ok(before !== undefined);
    assert.equal(before.done, "none");
    assert.equal(before.set, "not_reached");
    assert.equal(before.pl, "not_reached");
    assert.equal(before.rs, 0);
    assert.equal(before.code, "network_unreachable");
    assert.equal(incidentAutoEligible(before), false, "a connectivity failure is a manual symptom");
    const uncapped = playbackIncident(trace(), SESSION_EXPIRED);
    assert.ok(uncapped !== undefined && uncapped.set !== "not_reached");
    assert.equal(uncapped.set.cap, "none");
    assert.deepEqual(uncapped.req, { pos: "none", sub: "auto", aud: "default" });
});

test("a new attempt's incident snapshot excludes an earlier attempt's events and playback summary (#864)", () => {
    const diagnostics = collector();
    diagnostics.beginPlaybackSession();
    diagnostics.recordPlaybackStats({
        nowPlaying: [],
        playback: [{ label: "Playback", value: "Direct play · MKV" }],
        stream: [{ label: "Playback status", value: "Playing" }],
        engine: [{ label: "Delivery", value: "Original HTTP" }],
    });
    const scope = diagnostics.beginPlaybackSession();
    assert.equal(diagnostics.snapshot().lastPlayback, undefined, "a new attempt starts without the previous plan");
    diagnostics.recordPlaybackError("playback_failed", "");
    const record = diagnostics.recordPlaybackIncident(scope, trace({ seq: 2, stage: "playlist_check", first: { stage: "playlist_check", code: "hls_playlist_unreadable", buffering: false } }), { kind: "playback_failed" });
    assert.ok(record !== undefined);
    const json = JSON.stringify(record.snapshot);
    assert.ok(!json.includes("Direct play"), json);
    assert.ok(record.snapshot.events.some(event => event.text.startsWith("error playback_failed")), json);
    assert.ok(diagnostics.snapshot().events.some(event => event.text.startsWith("plan Direct play")), "the live log keeps history for user-observed reports");
});
