// Buffering / Quality evidence (#875): the public `bq` record, its capture with a buffering-owned
// incident, and the live context a user-observed Buffering / Quality report carries.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import { buildDiagnosticsReportUrl, DiagnosticsCollector, diagnosticsPayload, diagnosticsReportFingerprint } from "../../src/diagnostics.ts";
import { bufferingPayload } from "../../src/diagnosticsBuffering.ts";
import { incidentAutoEligible, type PlaybackAttemptTrace } from "../../src/diagnosticsIncident.ts";
import type { BufferingEvidenceTrace } from "../../src/player/bufferingEvidence.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

const NOW = 1_800_000_000_000;
const DEVICE = { appVersion: "0.5.0", tvModel: "QE65S95C" };

function fakeClock(startMs = NOW): Clock {
    return { now: () => startMs, schedule: () => () => undefined };
}

function collector(): DiagnosticsCollector {
    return new DiagnosticsCollector(DEVICE, fakeClock(), new MemoryPublicStorage(), () => ({}));
}

const AUTO_PLAN = { quality: "auto", plannedKbps: 8000, sourceKbps: 24000, outputKbps: 8000 };
const LOWERED_PLAN = { quality: "auto", plannedKbps: 5600, sourceKbps: 24000, outputKbps: 5600 };

function evidence(overrides: Partial<BufferingEvidenceTrace> = {}): BufferingEvidenceTrace {
    return {
        revision: 1, mode: "always", advertised: true, preference: "auto", manualCapKbps: undefined, learnedLimitCleared: false,
        plan: AUTO_PLAN, startEstimateKbps: 12000,
        speed: { kbps: 12000, source: "probe", measuredAt: NOW - 3_600_000, fresh: true },
        network: { type: "wifi", effectiveType: "4g", online: true },
        stallCount: 2, stallsMs: [1234, 6040], longestStallMs: 6040,
        stepDowns: [{ reason: "auto", from: AUTO_PLAN, to: undefined, estimateKbps: 5600, throughputKbps: undefined, outcome: "not_adopted" }],
        ...overrides,
    };
}

/** A buffering lowering whose answer was lost, then a reconnect that ran out: the failed recovery that ends playback. */
function failedRecovery(quality: BufferingEvidenceTrace = evidence(), overrides: Partial<PlaybackAttemptTrace> = {}): PlaybackAttemptTrace {
    return {
        seq: 1, chain: 0, stage: "reconnect", done: "playing", first: { stage: "quality_change", code: "no_answer", buffering: true },
        http: 400, decision: undefined, firstAvplay: undefined, lastAvplay: undefined, resends: 0, fallbacks: 0, reconnects: 1,
        opened: true, shown: true, recovered: false, exhausted: true,
        steps: ["playing:ok", "quality_change:fail:no_answer", "reconnect:end:network"],
        settings: { quality: "auto", capKbps: undefined, hdr: true }, hdrPanel: "unavailable",
        request: { startSeconds: undefined, subtitle: "auto", audio: "default" },
        plan: { delivery: "server_transcode_hls", protocol: "hls", container: "hls", quality: "auto", sourceKbps: 24000, videoCodec: "hevc", width: 3840, height: 2160, dynamicRange: "sdr", startSeconds: 0, atSeconds: 1820 },
        quality,
        ...overrides,
    };
}

test("the evidence distinguishes automatic quality, a forced cap, and missing or stale speed data", () => {
    const automatic = bufferingPayload(evidence(), NOW);
    assert.deepEqual([automatic.q, automatic.mc, automatic.ll], ["auto", "none", "server"]);
    assert.deepEqual(automatic.spd, { kbps: 12000, src: "probe", age: 3600, fresh: true });
    assert.deepEqual([automatic.pq, automatic.pk, automatic.sk, automatic.ok, automatic.est], ["auto", 8000, 24000, 8000, 12000]);
    assert.deepEqual(automatic.st, { n: 2, d: [1200, 6000], lg: 6000 }, "durations round to 100 ms");
    assert.deepEqual(automatic.sd, [{ r: "auto", fq: "auto", fk: 8000, est: 5600, o: "not_adopted" }], "no throughput was measured, so none is reported");

    const forced = bufferingPayload(evidence({ preference: "720p", manualCapKbps: 4000 }), NOW);
    assert.deepEqual([forced.q, forced.mc], ["720p", 4000]);

    const stale = bufferingPayload(evidence({ speed: { kbps: 9000, source: "sample", measuredAt: NOW - 9 * 86_400_000, fresh: false } }), NOW);
    assert.deepEqual(stale.spd, { kbps: 9000, src: "sample", age: 9 * 86_400, fresh: false });
    for (const missing of ["unsupported", "offline", "metered", "none"] as const) {
        assert.equal(bufferingPayload(evidence({ speed: missing, startEstimateKbps: undefined }), NOW).spd, missing);
    }
    assert.equal(bufferingPayload(evidence({ startEstimateKbps: undefined }), NOW).est, undefined, "no estimate sent is not an observed zero");
});

test("network type and the effective connection class are separate, and an absent API is unavailable", () => {
    assert.deepEqual(bufferingPayload(evidence(), NOW).net, { t: "wifi", ec: "4g", on: true });
    assert.deepEqual(bufferingPayload(evidence({ network: { type: undefined, effectiveType: undefined, online: undefined } }), NOW).net, { t: "unavailable", ec: "unavailable" });
    assert.deepEqual(bufferingPayload(evidence({ network: { type: "bluetooth", effectiveType: "5g", online: false } }), NOW).net, { t: "other", ec: "unavailable", on: false });
});

test("the learned connection limit names how it applied, never a value the TV did not see", () => {
    assert.equal(bufferingPayload(evidence({ advertised: false }), NOW).ll, "unsupported");
    assert.equal(bufferingPayload(evidence({ mode: "never" }), NOW).ll, "ignored");
    assert.equal(bufferingPayload(evidence({ learnedLimitCleared: true }), NOW).ll, "cleared");
    assert.equal(bufferingPayload(evidence({ mode: "ask" }), NOW).ll, "server");
});

test("bounds hold and labels outside the allowlist never leave the TV", () => {
    const marker = "SYNTH_TITLE";
    const hostile = bufferingPayload(evidence({
        preference: `${marker} 1080p`,
        manualCapKbps: 9e9,
        plan: { quality: `https://${marker}.example/x`, plannedKbps: -1, sourceKbps: Number.NaN, outputKbps: 2e9 },
        stallCount: 400,
        stallsMs: Array.from({ length: 12 }, (_, index) => (index + 1) * 1000).concat([9e9]),
        longestStallMs: 9e9,
        stepDowns: Array.from({ length: 6 }, () => ({ reason: "prompt" as const, from: { quality: marker, plannedKbps: 8000, sourceKbps: undefined, outputKbps: undefined }, to: undefined, estimateKbps: undefined, throughputKbps: 3000, outcome: "pending" as const })),
    }), NOW);
    assert.equal(JSON.stringify(hostile).includes(marker), false);
    assert.deepEqual([hostile.q, hostile.mc, hostile.pq, hostile.pk, hostile.sk, hostile.ok], [undefined, 1_000_000, undefined, undefined, undefined, 1_000_000]);
    assert.equal(hostile.st.n, 99);
    assert.equal(hostile.st.d.length, 8);
    assert.equal(hostile.st.d.at(-1), 600_000);
    assert.equal(hostile.st.lg, 600_000);
    assert.equal(hostile.sd.length, 4);
    assert.deepEqual(hostile.sd[0], { r: "prompt", fk: 8000, thr: 3000, o: "pending" });
});

test("a failed recovery freezes its evidence: manual and automatic sends match, and the QR link stays short", () => {
    const diagnostics = collector();
    const scope = diagnostics.beginPlaybackSession();
    const record = diagnostics.recordPlaybackIncident(scope, failedRecovery(), { kind: "network" });
    assert.ok(record !== undefined);
    assert.equal(record.category, "buffering");
    assert.ok(incidentAutoEligible(record.incident), "the recovery ran out and playback ended");
    assert.deepEqual(record.snapshot.buffering, bufferingPayload(evidence(), NOW));

    const manual = diagnosticsPayload(record.snapshot, { category: record.category, incident: record.incident });
    const automatic = diagnosticsPayload(record.snapshot, { category: record.category, incident: record.incident, auto: true });
    assert.deepEqual(manual.bq, automatic.bq);
    assert.deepEqual(manual.bq?.sd, [{ r: "auto", fq: "auto", fk: 8000, est: 5600, o: "not_adopted" }]);
    assert.deepEqual([manual.inc?.src, automatic.inc?.src], ["manual", "auto"]);

    // Playback failed selects the same frozen record, keeping its canonical category and evidence.
    assert.equal(diagnostics.reportFor("playback"), record);
    assert.equal(diagnosticsReportFingerprint(diagnostics.reportFor("playback")), diagnosticsReportFingerprint(record));

    const fragment = new URL(buildDiagnosticsReportUrl(record.snapshot)).hash.slice("#d=".length);
    assert.equal(Object.hasOwn(JSON.parse(Buffer.from(fragment, "base64url").toString("utf8")) as object, "bq"), false);
});

test("automatic filing stays off until the viewer enables it, and a manual report still carries the evidence", () => {
    const diagnostics = collector();
    assert.equal(diagnostics.autoReportEnabled, false, "fresh install defaults off");
    const scope = diagnostics.beginPlaybackSession();
    const record = diagnostics.recordPlaybackIncident(scope, failedRecovery(), { kind: "network" });
    assert.ok(record !== undefined);
    assert.equal(diagnostics.claimAutoReport(record), undefined, "nothing is sent while disabled");
    assert.ok(diagnosticsPayload(record.snapshot, { category: record.category, incident: record.incident }).bq !== undefined);
    diagnostics.setAutoReportEnabled(true);
    assert.ok(diagnostics.claimAutoReport(record) !== undefined);
    assert.equal(diagnostics.claimAutoReport(record), undefined, "one incident files once");
});

test("buffering recovery exhaustion without an HTTP response stays manual while preserving frozen evidence", () => {
    const diagnostics = collector();
    diagnostics.setAutoReportEnabled(true);
    for (const [overrides, expectedCode] of [
        [{ http: undefined }, "network_unreachable"],
        [{ http: undefined, timedOut: true }, "no_response"],
    ] as const) {
        const dropScope = diagnostics.beginPlaybackSession();
        const record = diagnostics.recordPlaybackIncident(dropScope, failedRecovery(evidence(), overrides), { kind: "network" });
        assert.ok(record !== undefined);
        assert.equal(record.category, "buffering");
        assert.equal(record.incident.fc, expectedCode);
        assert.equal(incidentAutoEligible(record.incident), false);
        assert.equal(diagnostics.claimAutoReport(record), undefined, "pure drop or timeout never auto-files");
        assert.deepEqual(diagnostics.reportFor("buffering"), record, "manual report still preserves the frozen buffering record");
    }
});

test("a successful step-down and repeated stalls are user-observed reports with the attempt's evidence, never incidents", () => {
    const diagnostics = collector();
    const scope = diagnostics.beginPlaybackSession();
    const lowered = evidence({ stepDowns: [{ reason: "auto", from: AUTO_PLAN, to: LOWERED_PLAN, estimateKbps: 5600, throughputKbps: undefined, outcome: "adopted" }], plan: LOWERED_PLAN });
    diagnostics.recordBufferingContext(scope, lowered);
    assert.equal(diagnostics.incidentFor("buffering"), undefined);
    const report = diagnostics.reportFor("buffering");
    assert.equal(report.incident, undefined);
    const payload = diagnosticsPayload(report.snapshot, { category: report.category });
    assert.deepEqual(payload.bq?.sd, [{ r: "auto", fq: "auto", fk: 8000, tq: "auto", tk: 5600, est: 5600, o: "adopted" }]);
    assert.equal(diagnosticsPayload(diagnostics.reportFor("playback").snapshot, { category: "playback" }).bq, undefined, "only Buffering / Quality carries it");

    const stalls = evidence({ mode: "never", stepDowns: [], stallCount: 3, stallsMs: [1000, 1500, 2000], longestStallMs: 2000 });
    diagnostics.recordBufferingContext(scope, stalls);
    const observed = diagnosticsPayload(diagnostics.reportFor("buffering").snapshot, { category: "buffering" });
    assert.deepEqual([observed.bq?.md, observed.bq?.ll, observed.bq?.st.n, observed.bq?.sd.length], ["never", "ignored", 3, 0]);
});

test("a user-observed report without a measurement says so", () => {
    const diagnostics = collector();
    const scope = diagnostics.beginPlaybackSession();
    diagnostics.recordBufferingContext(scope, evidence({ speed: "none", startEstimateKbps: undefined, network: { type: undefined, effectiveType: undefined, online: undefined }, stallCount: 0, stallsMs: [], longestStallMs: 0, stepDowns: [] }));
    const bq = diagnosticsPayload(diagnostics.reportFor("buffering").snapshot, { category: "buffering" }).bq;
    assert.ok(bq !== undefined);
    assert.equal(bq.spd, "none");
    assert.equal(bq.est, undefined);
    assert.deepEqual(bq.net, { t: "unavailable", ec: "unavailable" });
    assert.deepEqual(bq.st, { n: 0, d: [], lg: 0 });
});

test("a new attempt, a profile change and a stale player never carry buffering evidence forward", () => {
    const diagnostics = collector();
    const first = diagnostics.beginPlaybackSession();
    diagnostics.recordBufferingContext(first, evidence());
    const second = diagnostics.beginPlaybackSession();
    assert.equal(diagnostics.reportFor("buffering").snapshot.buffering, undefined, "a new attempt starts without the last one's evidence");
    diagnostics.recordBufferingContext(first, evidence());
    assert.equal(diagnostics.reportFor("buffering").snapshot.buffering, undefined, "an earlier attempt's player cannot record into this one");
    diagnostics.recordBufferingContext(second, evidence());
    assert.ok(diagnostics.reportFor("buffering").snapshot.buffering !== undefined);
    diagnostics.clear();
    assert.equal(diagnostics.reportFor("buffering").snapshot.buffering, undefined, "sign-out or a profile switch clears it");
});
