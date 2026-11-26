// Buffering / Quality evidence recorded by the real player (#875): a successful step-down, repeated
// stalls, and a failed recovery that ends playback. The rig mirrors bufferingWiring.test.ts.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { BUFFERING_MODE_KEY } from "../../src/contracts/v2/settingsRows.ts";
import { DiagnosticsCollector, diagnosticsReportFingerprint } from "../../src/diagnostics.ts";
import { bufferingPayload } from "../../src/diagnosticsBuffering.ts";
import { incidentAutoEligible, playbackIncident } from "../../src/diagnosticsIncident.ts";
import { PlaybackController, type PlaybackView, type PlayRequest } from "../../src/player/controller.ts";
import { BufferingEvidence } from "../../src/player/bufferingEvidence.ts";
import { ManualClock } from "./support/clock.ts";
import { FakeAVPlay } from "./support/fakeAVPlay.ts";
import { FakePlayback, type PlanShape } from "./support/fakePlayback.ts";
import { FakeSettings } from "./support/fakeSettings.ts";
import { FakeSilo, fixture, problem } from "./support/fakeSilo.ts";
import { connected, signIn, type Harness } from "./support/harness.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

// Node's navigator has no onLine; a TV's webview does.
beforeEach(() => {
    Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).onLine;
});

const MOVIE: PlayRequest = { contentId: "movie-1", fileId: "42", title: "Movie", startSeconds: 12.5 };
const FEATURE = "buffering_quality_v1";
const BASE_FEATURES = fixture("playback_start_opaque_ids").server_features as string[];
const LADDER = [
    { label: "original", preserves_source: true },
    { label: "1080p-medium", height: 1080, bitrate_kbps: 6000, preserves_source: false },
    { label: "720p", height: 720, bitrate_kbps: 3000, preserves_source: false },
];
/** The fixture plan delivers 8000 kb/s, so the step-down estimate is floor(8000 * 7 / 10). */
const DELIVERED_KBPS = 8000;
const STEP_DOWN_KBPS = 5600;

interface Rig {
    readonly h: Harness;
    readonly server: FakePlayback;
    readonly avplay: FakeAVPlay;
    readonly controller: PlaybackController;
    readonly views: PlaybackView[];
}

async function rig(mode?: "never" | "ask" | "always"): Promise<Rig> {
    const clock = new ManualClock();
    const h = await connected({ clock, fake: new FakeSilo(clock) });
    await signIn(h);
    const owner = (await h.core.profiles.list()).find((profile) => profile.id === "p-owner");
    assert.ok(owner !== undefined);
    h.core.profiles.select(owner);
    const server = new FakePlayback(h.fake);
    const settings = new FakeSettings(h.fake);
    if (mode !== undefined) {
        settings.bufferingRows = true;
        settings.profile().set(BUFFERING_MODE_KEY as never, mode);
    }
    const avplay = new FakeAVPlay();
    let serial = 0;
    const controller = new PlaybackController({
        session: h.core.session,
        avplay,
        clock: h.clock,
        randomBytes: (bytes) => bytes.fill(++serial),
        device: { model: "QN55Q60AAFXZA", appVersion: "0.1.0" },
        // A failed recovery ends in the error view; the test reads it from there.
        exits: { onBack() {}, onEnd() {}, onError() {} },
    });
    const views: PlaybackView[] = [];
    controller.subscribe((view) => views.push(view));
    return { h, server, avplay, controller, views };
}

function advertised(extra: Partial<PlanShape> = {}): PlanShape {
    return { availableQualities: LADDER, serverFeatures: [...BASE_FEATURES, FEATURE], ...extra };
}

function replans(r: Rig): Record<string, unknown>[] {
    return r.h.fake.requests.filter((request) => request.path.endsWith("/replan")).map((request) => request.body ?? {});
}

function last(r: Rig): PlaybackView {
    const view = r.views[r.views.length - 1];
    assert.ok(view !== undefined);
    return view;
}

async function finishOpen(r: Rig): Promise<void> {
    r.avplay.finishPrepare();
    await r.h.clock.advance(0);
    if (r.avplay.calls.at(-1)?.startsWith("seekTo") === true) {
        r.avplay.finishSeek();
        await r.h.clock.advance(0);
    }
    assert.equal(r.avplay.state, "PLAYING");
}

/** Plays MOVIE and lets the 10 s startup grace pass, so the next stall counts. */
async function playPastGrace(r: Rig): Promise<void> {
    r.controller.play(MOVIE);
    await r.h.clock.advance(0);
    await finishOpen(r);
    r.avplay.tick(13_000);
    await r.h.clock.advance(11_000);
}

async function stall(r: Rig, ms: number): Promise<void> {
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(ms);
    r.avplay.listener?.onbufferingcomplete();
    await r.h.clock.advance(0);
}

test("a successful automatic step-down records the long stall, the step-down estimate and both plans", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }));
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    assert.equal(replans(r).length, 1);
    await finishOpen(r);
    const evidence = r.controller.bufferingTrace();
    assert.ok(evidence !== undefined);
    assert.equal(evidence.stepDowns.length, 1);
    const step = evidence.stepDowns[0];
    assert.ok(step !== undefined);
    assert.deepEqual([step.reason, step.outcome, step.estimateKbps, step.from?.plannedKbps, step.to?.plannedKbps], ["auto", "adopted", STEP_DOWN_KBPS, DELIVERED_KBPS, STEP_DOWN_KBPS]);
    assert.equal(step.throughputKbps, undefined, "AVPlay measures no throughput, so none is claimed");
    assert.equal(evidence.plan?.plannedKbps, STEP_DOWN_KBPS);
    assert.equal(evidence.stallCount, 1);
    const measured = evidence.stallsMs[0];
    assert.ok(measured !== undefined && measured >= 6000 && measured < 7000, `stall ${measured}`);
    assert.equal(r.controller.incidentTrace()?.first, undefined, "a successful step-down is not a failure");
    r.controller.destroy();
});

test("the viewer's Lower quality on the prompt is recorded as their choice", async () => {
    const r = await rig("ask");
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }));
    await playPastGrace(r);
    r.avplay.listener?.onbufferingstart();
    await r.h.clock.advance(6000);
    r.controller.selectBufferingPrimary();
    await r.h.clock.advance(0);
    assert.equal(r.controller.bufferingTrace()?.stepDowns[0]?.reason, "prompt");
    r.controller.destroy();
});

test("repeated stalls with lowering off are counted with their durations and no step-down", async () => {
    const r = await rig("never");
    r.server.next.push(advertised());
    await playPastGrace(r);
    for (const ms of [1000, 2000, 3000]) {
        await stall(r, ms);
        await r.h.clock.advance(5000);
    }
    assert.equal(replans(r).length, 0);
    const evidence = r.controller.bufferingTrace();
    assert.ok(evidence !== undefined);
    assert.deepEqual([evidence.mode, evidence.stallCount, evidence.stallsMs, evidence.longestStallMs, evidence.stepDowns.length], ["never", 3, [1000, 2000, 3000], 3000, 0]);
    assert.equal(bufferingPayload(evidence, r.h.clock.now()).ll, "ignored");
    r.controller.destroy();
});

async function exhaustError(r: Rig, maxSeconds = 200): Promise<Extract<PlaybackView, { phase: "error" }>> {
    for (let waited = 0; waited < maxSeconds && last(r).phase !== "error"; waited++) await r.h.clock.advance(1000);
    const view = last(r);
    assert.ok(view.phase === "error" && view.error.kind === "network", JSON.stringify(view));
    return view;
}

test("a lowering whose answer is lost and a reconnect that runs out is one buffering incident: the failed replan, then the terminal outcome", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }));
    await playPastGrace(r);
    const id = [...r.server.sessions.keys()].pop();
    assert.ok(id !== undefined);
    // The lowering's answers are lost; the reconnect then finds no session, and its one replacement start is refused.
    r.h.fake.script(`/playback/${id}/replan`, ...Array.from({ length: 3 }, () => ({ status: 503 })), problem(404, "not_found", "Playback session not found"));
    r.h.fake.script("/playback/start", problem(400, "validation_failed", "Rejected"));
    r.avplay.listener?.onbufferingstart();
    const view = await exhaustError(r, 60);

    const trace = r.controller.incidentTrace();
    assert.ok(trace !== undefined);
    assert.deepEqual([trace.first?.stage, trace.first?.buffering], ["quality_change", true]);
    const incident = playbackIncident(trace, view.error);
    assert.ok(incident !== undefined);
    assert.deepEqual([incident.cat, incident.out, incident.op, incident.stage, incident.fs, incident.http, incident.fc, incident.rec.r], ["buffering", "failed", "replan_playback", "quality_change", "reconnect", 400, "http_400", "exhausted"]);
    assert.equal(incidentAutoEligible(incident), true, "only the failed recovery qualifies for automatic filing");
    const failedReplan = incident.t.findIndex((step) => step.startsWith("quality_change:fail"));
    assert.ok(failedReplan !== -1, JSON.stringify(incident.t));
    assert.match(incident.t.at(-1) ?? "", /:end:network$/, "the terminal outcome follows the failed replan in one timeline");
    assert.ok(failedReplan < incident.t.length - 1);
    assert.deepEqual(trace.quality?.stepDowns.map((step) => [step.reason, step.outcome]), [["auto", "not_adopted"]]);

    // The same incident through the collector: one record, frozen evidence, and Playback failed selects it.
    const diagnostics = new DiagnosticsCollector({ appVersion: "0.5.0", tvModel: "QE65S95C" }, r.h.clock, new MemoryPublicStorage(), () => ({}));
    const scope = diagnostics.beginPlaybackSession();
    const record = diagnostics.recordPlaybackIncident(scope, trace, view.error);
    assert.ok(record !== undefined);
    assert.equal(diagnostics.recordPlaybackIncident(scope, trace, view.error), record, "the terminal handler does not open a second record");
    assert.equal(record.snapshot.buffering?.sd[0]?.o, "not_adopted");
    assert.equal(diagnostics.reportFor("playback"), record);
    assert.equal(diagnosticsReportFingerprint(diagnostics.reportFor("buffering")), diagnosticsReportFingerprint(record));
    r.controller.destroy();
});

test("a buffering step-down whose reconnect exhausts on pure network drops records reconnect and stays manual (#923)", async () => {
    const r = await rig();
    r.server.next.push(advertised(), advertised({ recipeKbps: STEP_DOWN_KBPS }));
    await playPastGrace(r);
    const id = [...r.server.sessions.keys()].pop();
    assert.ok(id !== undefined);
    for (let i = 0; i < 15; i++) r.h.fake.dropNextAnswer(`/playback/${id}/replan`);
    r.avplay.listener?.onbufferingstart();
    const view = await exhaustError(r);
    assert.deepEqual(view.error, { kind: "network" });

    const trace = r.controller.incidentTrace();
    assert.ok(trace !== undefined && trace.exhausted);
    const incident = playbackIncident(trace, view.error);
    assert.ok(incident !== undefined);
    assert.deepEqual([incident.cat, incident.fs, incident.http, incident.fc, incident.rec.r], ["buffering", "reconnect", undefined, "network_unreachable", "exhausted"]);
    assert.equal(incidentAutoEligible(incident), false);
    r.controller.destroy();
});

test("Restore quality clears a learned limit only after its plan is adopted", () => {
    const evidence = new BufferingEvidence();
    const trace = () => evidence.trace({ mode: "always", advertised: true, preference: "auto", manualCapKbps: undefined });
    const plan = { quality: "auto", plannedKbps: undefined, sourceKbps: undefined, outputKbps: undefined };
    const restore = { operation: "quality_change", qualityPreference: "auto", learnedLimit: "clear" } as const;
    for (const outcome of ["not_sent", "not_adopted"] as const) {
        const refused = { ...restore };
        evidence.stepQueued("restore", refused);
        assert.equal(trace().learnedLimitCleared, false);
        evidence.stepEnded(refused, outcome);
        evidence.planAdopted(plan);
        assert.equal(trace().learnedLimitCleared, false);
    }
    const lower = { operation: "quality_change", qualityPreference: "720p" } as const;
    evidence.stepQueued("auto", lower);
    evidence.stepQueued("restore", restore);
    const loweredPlan = { ...plan, quality: "720p", plannedKbps: 3000 };
    const recentSteps = () => trace().stepDowns.slice(-2).map(step => [step.reason, step.outcome, step.to]);
    evidence.planAdopted(loweredPlan, lower);
    assert.deepEqual(recentSteps(), [["auto", "adopted", loweredPlan], ["restore", "pending", undefined]]);
    assert.equal(trace().learnedLimitCleared, false, "an older response cannot settle the restore");
    evidence.planAdopted(plan, restore);
    assert.deepEqual(recentSteps(), [["auto", "adopted", loweredPlan], ["restore", "adopted", plan]]);
    assert.equal(trace().learnedLimitCleared, true);

    const nextLower = { ...lower };
    const nextRestore = { ...restore };
    evidence.stepQueued("auto", nextLower);
    evidence.stepQueued("restore", nextRestore);
    evidence.planAdopted(plan, nextRestore);
    assert.deepEqual(recentSteps(), [["auto", "pending", undefined], ["restore", "adopted", plan]]);
    evidence.stepEnded(nextLower, "not_adopted");
    assert.deepEqual(recentSteps(), [["auto", "not_adopted", undefined], ["restore", "adopted", plan]]);
});
