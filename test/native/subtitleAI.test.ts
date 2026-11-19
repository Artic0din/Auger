import assert from "node:assert/strict";
import { test } from "node:test";
import { SubtitleAI } from "../../src/player/subtitleAI.ts";
import { decodeAIStatus } from "../../src/contracts/v2/subtitleAI.ts";
import { connected, signIn } from "./support/harness.ts";
import { problem, type Reply } from "./support/fakeSilo.ts";

const request = { media_file_id: "42", kind: "translate", source_index: 2, source_language: "en", target_language: "fr", start_position: 12 } as const;
const job = (status: string, extra: Record<string, unknown> = {}) => ({ job: { id: "opaque-job", media_file_id: "42", kind: "translate", source_index: 2, target_language: "fr", status, result_subtitle_id: status === "completed" ? "opaque-result" : null, ...extra } });

async function setup(remaining = 3, enabled = true, blocked = new Set<string>()) {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    h.fake.script("/subtitles/ai/status", { status: 200, body: { enabled, transcribe_enabled: enabled, allowed: true, state: "available", revision: "opaque" } });
    h.fake.script("/subtitles/ai/quota", ...Array.from({ length: 3 }, () => ({ status: 200, body: { limited: true, limit: 5, used: 5 - remaining, remaining, period: "month" } })));
    h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "fr" }, { value: "en" }] } } } });
    const ai = new SubtitleAI(h.core.session, h.clock, "42", () => undefined, blocked);
    await h.clock.advance(0);
    return { h, ai };
}

test("AI gates translation and transcription independently and treats unknown states as unavailable", () => {
    assert.deepEqual(decodeAIStatus({ enabled: false, transcribe_enabled: true, allowed: true, state: "available" }), { translate: false, transcribe: true });
    assert.deepEqual(decodeAIStatus({ enabled: true, transcribe_enabled: true, allowed: true, state: "future" }), { translate: false, transcribe: false });
});

test("AI creates once, polls opaque identities and exposes a labeled completed result", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("pending") });
    h.fake.script("/subtitles/ai/jobs/opaque-job", { status: 200, body: job("completed") });
    await ai.start(request);
    await ai.start(request);
    assert.equal(ai.view?.busy, true);
    await h.clock.advance(2000);
    assert.deepEqual(ai.view?.results, [{ id: "opaque-result", label: "AI-translated · FR" }]);
    assert.equal(ai.view?.quota?.remaining, 3);
    const starts = h.fake.requests.filter(row => row.path === "/subtitles/ai/translate");
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0]?.body, request);
    assert.ok(starts[0]?.headers["x-profile-id"]);
    assert.equal(h.fake.requests.some(row => row.path.startsWith("/playback")), false);
    ai.destroy();
});

test("exhausted transcription quota blocks spending while translation and unavailable playback remain safe", async () => {
    const { h, ai } = await setup(0);
    await ai.start({ ...request, kind: "transcribe", target_language: "" });
    assert.match(ai.view?.message ?? "", /exhausted/);
    assert.equal(h.fake.requests.some(row => row.method === "POST" && row.path === "/subtitles/ai/translate"), false);
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("completed") });
    await ai.start(request);
    assert.equal(ai.view?.results.length, 1, "text translation does not spend ASR quota");
    ai.destroy();
    const unavailable = await setup(0, false);
    await unavailable.ai.start(request);
    assert.equal(unavailable.ai.view, undefined);
    assert.equal(unavailable.h.fake.requests.some(row => row.path === "/subtitles/ai/translate"), false);
    unavailable.ai.destroy();
});

test("unknown create outcomes are never resent and job failures report a reason", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("pending", { media_file_id: "wrong" }) });
    await ai.start(request);
    await ai.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
    assert.match(ai.view?.message ?? "", /not sent again/);
    ai.destroy();
    const failed = await setup();
    failed.h.fake.script("/subtitles/ai/translate", { status: 202, body: job("failed", { error_message: "Provider could not decode the source track." }) });
    await failed.ai.start(request);
    assert.match(failed.ai.view?.message ?? "", /could not decode/);
    failed.ai.destroy();
});

test("authority loss cancels polling and quota refusals never become playback failures", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("running") });
    await ai.start(request);
    h.core.profiles.clear();
    const count = h.fake.requests.length;
    await h.clock.advance(10000);
    assert.equal(h.fake.requests.length, count);
    ai.destroy();
    const refused = await setup();
    refused.h.fake.script("/subtitles/ai/translate", problem(429, "quota_exceeded", "Quota exhausted"));
    await refused.ai.start(request);
    assert.match(refused.ai.view?.message ?? "", /quota_exceeded/);
    refused.ai.destroy();
});

test("a rejected AI create is not replayed after account token refresh", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", problem(401, "authentication_required", "Sign in again"));
    await ai.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
    assert.equal(ai.view?.busy, false);
    ai.destroy();
});

test("lost polling or an unknown accepted status cannot create another quota-spending job", async () => {
    for (const status of ["pending", "future"]) {
        const { h, ai } = await setup();
        h.fake.script("/subtitles/ai/translate", { status: 202, body: job(status) });
        h.fake.script("/subtitles/ai/jobs/opaque-job", ...Array.from({ length: 3 }, () => problem(400, "unavailable", "Job state unavailable")));
        await ai.start(request);
        await h.clock.advance(6000);
        await ai.start(request);
        assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
        assert.equal(ai.view?.busy, true);
        ai.destroy();
    }
});

test("a 429 quota refusal is definite, so a later start is allowed while 5xx stays uncertain", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", problem(429, "quota_exceeded", "Quota exhausted"), { status: 202, body: job("completed") });
    await ai.start(request);
    assert.equal(ai.view?.busy, false);
    await ai.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 2);
    assert.equal(ai.view?.results.length, 1);
    ai.destroy();
    const failed = await setup();
    failed.h.fake.script("/subtitles/ai/translate", problem(503, "unavailable", "Try later"), { status: 202, body: job("completed") });
    await failed.ai.start(request);
    await failed.ai.start(request);
    assert.equal(failed.h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
    assert.equal(failed.ai.view?.busy, true);
    failed.ai.destroy();
});

test("a failed poll is retried and a later answer still delivers the finished track", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("pending") });
    h.fake.script("/subtitles/ai/jobs/opaque-job", problem(400, "unavailable", "Job state unavailable"), { status: 200, body: job("completed") });
    await ai.start(request);
    await h.clock.advance(2000);
    assert.equal(ai.view?.busy, true, "one lost poll keeps waiting");
    await h.clock.advance(2000);
    assert.deepEqual(ai.view?.results, [{ id: "opaque-result", label: "AI-translated · FR" }]);
    assert.equal(ai.view?.busy, false);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
    ai.destroy();
});

test("the duplicate-job block for a file survives switching to another file and back", async () => {
    const blocked = new Set<string>();
    const { h, ai } = await setup(3, true, blocked);
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("running") });
    await ai.start(request);
    ai.destroy();
    h.fake.script("/subtitles/ai/status", { status: 200, body: { enabled: true, transcribe_enabled: true, allowed: true, state: "available", revision: "opaque" } });
    h.fake.script("/subtitles/ai/quota", { status: 200, body: { limited: true, limit: 5, used: 2, remaining: 3, period: "month" } });
    const back = new SubtitleAI(h.core.session, h.clock, "42", () => undefined, blocked);
    await h.clock.advance(0);
    assert.equal(back.view?.busy, true);
    await back.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1);
    back.destroy();
});

test("the quota keeps its used and limit counts and a job its progress", async () => {
    const { h, ai } = await setup();
    assert.deepEqual({ used: ai.view?.quota?.used, limit: ai.view?.quota?.limit }, { used: 2, limit: 5 });
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("running", { progress: 0.42, progress_message: "Translating cues" }) });
    h.fake.script("/subtitles/ai/jobs/opaque-job", { status: 200, body: job("running", { progress: 2, progress_message: "" }) });
    await ai.start(request);
    assert.deepEqual(ai.view && { phase: ai.view.phase, kind: ai.view.kind, progress: ai.view.progress }, { phase: "busy", kind: "translate", progress: { percent: 42, message: "Translating cues" } });
    await h.clock.advance(2000);
    assert.deepEqual(ai.view?.progress, { percent: 100, message: "" }, "progress is clamped to 0 to 100");
    ai.destroy();
});

test("a transcription that translates needs both capabilities, a listed language and quota", async () => {
    const both = { ...request, kind: "transcribe_translate" as const, source_index: -1, source_language: "" };
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("completed", { kind: "transcribe_translate", source_index: -1 }) });
    await ai.start({ ...both, target_language: "xx" });
    assert.equal(h.fake.requests.some(row => row.path === "/subtitles/ai/translate"), false, "a language the server does not list is not sent");
    await ai.start(both);
    assert.deepEqual(h.fake.requests.find(row => row.path === "/subtitles/ai/translate")?.body, both);
    assert.equal(ai.view?.results.length, 1);
    ai.destroy();
    const empty = await setup(0);
    await empty.ai.start(both);
    assert.equal(empty.h.fake.requests.some(row => row.path === "/subtitles/ai/translate"), false, "no quota, nothing spent");
    empty.ai.destroy();
});

test("a finished, failed or cancelled job leaves a phase the menu can read, and Dismiss clears a failure", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("failed", { error_message: "Provider could not decode the source track." }) });
    await ai.start(request);
    assert.deepEqual(ai.view && { phase: ai.view.phase, message: ai.view.message }, { phase: "failed", message: "Provider could not decode the source track." });
    ai.acknowledge();
    assert.equal(ai.view?.phase, "idle");
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("completed") });
    await ai.start(request);
    assert.equal(ai.view?.phase, "completed");
    ai.acknowledge();
    assert.equal(ai.view?.phase, "idle");
    ai.destroy();
});

test("Cancel asks the server to stop the job, stops polling and keeps the quota spent as it is", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("running") });
    h.fake.script("/subtitles/ai/jobs/opaque-job/cancel", { status: 200, body: job("cancelled") });
    await ai.start(request);
    await ai.cancel();
    assert.equal(h.fake.requests.filter(row => row.method === "POST" && row.path === "/subtitles/ai/jobs/opaque-job/cancel").length, 1);
    assert.equal(ai.view?.phase, "idle");
    const count = h.fake.requests.length;
    await h.clock.advance(10000);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/jobs/opaque-job").length, 0, "no further polls");
    assert.ok(h.fake.requests.length >= count);
    await ai.cancel();
    assert.equal(h.fake.requests.filter(row => row.path.endsWith("/cancel")).length, 1, "nothing to cancel");
    ai.destroy();
});

test("a held request shows as failed with Discard, which lets the next start go out", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", problem(503, "unavailable", "Try later"), { status: 202, body: job("completed") });
    await ai.start(request);
    assert.deepEqual(ai.view && { phase: ai.view.phase, held: ai.view.held }, { phase: "failed", held: true });
    await ai.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 1, "held until discarded");
    ai.discardHeld();
    assert.equal(ai.view?.held, false);
    await ai.start(request);
    assert.equal(h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length, 2);
    ai.destroy();
});

test("Cancel while the create request is pending stops that job once the server names it, and never the previous one", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("completed") });
    await ai.start(request);
    const hold = h.fake.hold("/subtitles/ai/translate");
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("running", { id: "second-job" }) });
    h.fake.script("/subtitles/ai/jobs/second-job/cancel", { status: 200, body: job("cancelled", { id: "second-job" }) });
    const second = ai.start(request);
    await h.clock.advance(0);
    await ai.cancel();
    assert.deepEqual(ai.view && { phase: ai.view.phase, held: ai.view.held }, { phase: "failed", held: true }, "the request may still start a job, so the file is held until it answers");
    hold.release();
    await second;
    await h.clock.advance(10000);
    assert.equal(ai.view?.held, false, "the answer settles the hold");
    assert.deepEqual(h.fake.requests.filter(row => row.path.endsWith("/cancel")).map(row => row.path), ["/subtitles/ai/jobs/second-job/cancel"]);
    assert.equal(h.fake.requests.some(row => row.path === "/subtitles/ai/jobs/second-job"), false, "a cancelled job is never polled");
    assert.equal(ai.view?.phase, "idle");
    assert.equal(ai.view?.results.length, 1, "no result from the cancelled job");
    ai.destroy();
});

test("a poll that was in flight when the job was cancelled cannot change the next job, whether it answers or fails", async () => {
    for (const late of ["completed", "failed", "error"] as const) {
        const { h, ai } = await setup();
        h.fake.script("/subtitles/ai/translate", { status: 202, body: job("running") }, { status: 202, body: job("running", { id: "second-job" }) });
        h.fake.script("/subtitles/ai/jobs/opaque-job/cancel", { status: 200, body: job("cancelled") });
        await ai.start(request);
        const hold = h.fake.hold("/subtitles/ai/jobs/opaque-job");
        h.fake.script("/subtitles/ai/jobs/opaque-job", late === "error" ? problem(400, "unavailable", "Job state unavailable") : { status: 200, body: job(late, late === "completed" ? { result_subtitle_id: "old-result" } : { error_message: "old failure" }) });
        await h.clock.advance(2000);
        await ai.cancel();
        await ai.start({ ...request, target_language: "fr" });
        assert.equal(ai.view?.phase, "busy");
        hold.release();
        await h.clock.advance(0);
        assert.equal(ai.view?.phase, "busy", `${late}: the first job's answer is dropped`);
        assert.equal(ai.view?.results.length, 0);
        assert.equal(ai.view?.held, false, `${late}: the file is not held because a cancelled job's poll failed`);
        h.fake.script("/subtitles/ai/jobs/second-job", { status: 200, body: job("completed", { id: "second-job", result_subtitle_id: "new-result" }) });
        await h.clock.advance(2000);
        assert.deepEqual(ai.view?.results.map(result => result.id), ["new-result"], `${late}: the second job's own polling continues`);
        assert.equal(ai.view?.phase, "completed");
        ai.destroy();
    }
});

async function cancelledPendingCreate(blocked = new Set<string>(), ...creates: Reply[]) {
    const { h, ai } = await setup(3, true, blocked);
    h.fake.script("/subtitles/ai/translate", ...creates);
    const hold = h.fake.hold("/subtitles/ai/translate");
    const first = ai.start(request);
    await h.clock.advance(0);
    await ai.cancel();
    return { h, ai, hold, first };
}
const creates = (h: Awaited<ReturnType<typeof setup>>["h"]): number => h.fake.requests.filter(row => row.path === "/subtitles/ai/translate").length;

test("while a cancelled create is still pending, no second request goes out; once it answers, the next start does", async () => {
    const { h, ai, hold, first } = await cancelledPendingCreate(new Set(), { status: 202, body: job("running", { id: "first-job" }) }, { status: 202, body: job("running", { id: "next-job" }) });
    h.fake.script("/subtitles/ai/jobs/first-job/cancel", { status: 200, body: job("cancelled", { id: "first-job" }) });
    await ai.start(request);
    assert.equal(creates(h), 1, "held until the first create answers");
    assert.equal(ai.view?.held, true);
    hold.release();
    await first;
    assert.equal(ai.view?.held, false);
    assert.equal(ai.view?.phase, "idle");
    await ai.start(request);
    assert.equal(creates(h), 2);
    ai.destroy();
});

test("a cancelled create that fails with an unknown outcome stays held until the viewer discards it", async () => {
    const { h, ai, hold, first } = await cancelledPendingCreate(new Set(), problem(503, "unavailable", "Try later"));
    hold.release();
    await first;
    assert.equal(ai.view?.held, true);
    assert.match(ai.view?.message ?? "", /Could not confirm/);
    await ai.start(request);
    assert.equal(creates(h), 1);
    ai.discardHeld();
    assert.equal(ai.view?.held, false);
    ai.destroy();
});

test("a cancelled create the server refuses outright releases the file", async () => {
    const { h, ai, hold, first } = await cancelledPendingCreate(new Set(), problem(429, "quota_exceeded", "Quota exhausted"));
    hold.release();
    await first;
    assert.deepEqual(ai.view && { phase: ai.view.phase, held: ai.view.held, message: ai.view.message }, { phase: "idle", held: false, message: "" });
    assert.equal(creates(h), 1);
    ai.destroy();
});

test("a menu closed while a cancelled create is pending leaves its file held for the next one", async () => {
    const blocked = new Set<string>();
    const { h, ai, hold, first } = await cancelledPendingCreate(blocked, { status: 202, body: job("running", { id: "first-job" }) });
    ai.destroy();
    hold.release();
    await first;
    assert.equal(blocked.has("42"), true);
    h.fake.script("/subtitles/ai/status", { status: 200, body: { enabled: true, transcribe_enabled: true, allowed: true, state: "available", revision: "opaque" } });
    h.fake.script("/subtitles/ai/quota", { status: 200, body: { limited: true, limit: 5, used: 2, remaining: 3, period: "month" } });
    h.fake.script("/settings/contract", { status: 200, body: { option_sets: { playback_subtitle_languages: { options: [{ value: "fr" }, { value: "en" }] } } } });
    const reopened = new SubtitleAI(h.core.session, h.clock, "42", () => undefined, blocked);
    await h.clock.advance(0);
    await reopened.start(request);
    assert.equal(creates(h), 1);
    assert.equal(reopened.view?.held, true);
    reopened.destroy();
});

test("a cancelled create that answers after Discard, while a newer job runs, leaves that job's panel alone", async () => {
    const { h, ai, hold, first } = await cancelledPendingCreate(new Set(), problem(503, "unavailable", "Try later"), { status: 202, body: job("running", { id: "newer-job" }) });
    ai.discardHeld();
    await ai.start(request);
    assert.equal(ai.view?.phase, "busy");
    hold.release();
    await first;
    assert.equal(ai.view?.phase, "busy", "the newer job still owns the panel");
    assert.equal(ai.view?.message, "Generating AI subtitles…");
    assert.equal(creates(h), 2);
    ai.destroy();
});

test("a cancelled create whose hold was discarded cannot take the hold back when it later fails, whatever the newer job does", async () => {
    const { h, ai, hold, first } = await cancelledPendingCreate(new Set(), problem(503, "unavailable", "Try later"), { status: 202, body: job("running", { id: "newer-job" }) });
    h.fake.script("/subtitles/ai/jobs/newer-job", { status: 200, body: job("completed", { id: "newer-job" }) });
    ai.discardHeld();
    await ai.start(request);
    hold.release();
    await first;
    assert.equal(ai.view?.held, false, "the discarded request's late failure does not hold the file");
    await h.clock.advance(2000);
    assert.deepEqual(ai.view && { phase: ai.view.phase, held: ai.view.held }, { phase: "completed", held: false });
    assert.equal(ai.view?.results.length, 1);
    ai.destroy();
});

test("a job that completes without a subtitle result stays on the failure panel with its reason until dismissed", async () => {
    const { h, ai } = await setup();
    h.fake.script("/subtitles/ai/translate", { status: 202, body: job("pending") });
    h.fake.script("/subtitles/ai/jobs/opaque-job", { status: 200, body: job("completed", { result_subtitle_id: null }) });
    await ai.start(request);
    await h.clock.advance(2000);
    assert.equal(ai.view?.phase, "failed", "not completed: the screen closes a completed menu and clears its notice");
    assert.equal(ai.view?.message, "AI job completed without a subtitle result.");
    assert.deepEqual(ai.view?.results, []);
    assert.equal(ai.view?.busy, false);
    ai.acknowledge();
    assert.equal(ai.view?.phase, "idle");
    ai.destroy();
});
