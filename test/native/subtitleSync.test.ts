import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSyncState, decodeSyncStatus } from "../../src/contracts/v2/subtitleSync.ts";
import { describeTiming, failureText, phaseText, scaleText, SubtitleSync, syncActionNote, syncPercent, syncResult, syncStatusLabel } from "../../src/player/subtitleSync.ts";
import { connected, signIn } from "./support/harness.ts";
import { problem } from "./support/fakeSilo.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { type MessageKey, translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const FILE = "42";
const KEY = "stored-7";
const IDENTITY = { offset_ms: 0, scale: 1 };

const available = { revision: "r", state: "available", allowed: true, auto_sync: true, external: true };
function job(status: string, extra: Record<string, unknown> = {}) {
    return { id: "job-1", status, trigger: "manual", confidence: null, created_at: "2026-11-17T01:00:00.000Z", finished_at: null, ...extra };
}
function state(extra: Record<string, unknown> = {}, key = KEY) {
    return { key, media_file_id: FILE, source: key.startsWith("external-") ? "external" : "downloaded", language: "en", format: "srt", label: "Release.Name", timing: IDENTITY, ...extra };
}

async function setup(status: Record<string, unknown> | null = available, listed: readonly Record<string, unknown>[] = [state()]) {
    const h = await connected();
    await signIn(h);
    const profile = (await h.core.profiles.list())[0];
    assert.ok(profile);
    h.core.profiles.select(profile);
    if (status !== null) h.fake.script("/subtitles/sync/status", { status: 200, body: status });
    h.fake.script(`/subtitles/${FILE}/sync`, { status: 200, body: { subtitles: listed } });
    const changed: string[] = [];
    const sync = new SubtitleSync(h.core.session, h.clock, FILE, () => undefined, key => changed.push(key));
    await h.clock.advance(0);
    return { h, sync, changed };
}

test("the status gates the rows: available and allowed, nothing else", () => {
    assert.equal(decodeSyncStatus(available).available, true);
    assert.equal(decodeSyncStatus({ ...available, allowed: false }).available, false);
    for (const unavailable of ["disabled", "not_configured", "unsupported", "future_state"]) assert.equal(decodeSyncStatus({ ...available, state: unavailable }).available, false);
    assert.equal(decodeSyncStatus({ ...available, external: false }).external, false);
    assert.throws(() => decodeSyncStatus({ revision: "r", state: "available", allowed: true, auto_sync: true }));
});

test("a sync state keeps its key, source, timing and latest job", () => {
    const decoded = decodeSyncState(state({ source: "external", sync: job("running", { phase: "analyzing", progress: 0.4 }), timing: { offset_ms: -3000, scale: 1.0 } }, "external-abc"));
    assert.equal(decoded.key, "external-abc");
    assert.equal(decoded.external, true);
    assert.deepEqual(decoded.timing, { offsetMs: -3000, scale: 1 });
    assert.deepEqual(decoded.job && { status: decoded.job.status, phase: decoded.job.phase, progress: decoded.job.progress }, { status: "running", phase: "analyzing", progress: 0.4 });
    assert.equal(decodeSyncState(state()).job, undefined);
    assert.throws(() => decodeSyncState({ ...state(), key: "" }));
});

test("status labels read as Apple's SubtitleSyncLabel.status", () => {
    const at = (offsetMs: number, scale = 1) => ({ offsetMs, scale });
    const running = (progress: number | undefined) => ({ id: "j", status: "running", trigger: "manual", phase: "analyzing" as const, progress, failure: undefined, result: undefined });
    assert.equal(syncStatusLabel(at(0), running(0.4)), "Syncing… 40%");
    assert.equal(syncStatusLabel(at(0), running(0)), "Syncing…");
    assert.equal(syncStatusLabel(at(0), running(undefined)), "Syncing…");
    assert.equal(syncStatusLabel(at(0), { ...running(1), status: "no_match" }), "Doesn't match this video");
    assert.equal(syncStatusLabel(at(0), { ...running(1), status: "failed" }), "Sync failed");
    assert.equal(syncStatusLabel(at(0), { ...running(1), status: "already_synced" }), "Already in sync");
    assert.equal(syncStatusLabel(at(0), { ...running(1), status: "synced" }), "Original timing");
    assert.equal(syncStatusLabel(at(-3000), { ...running(1), status: "synced", result: at(-3000) }), "Synced −3.0 s");
    assert.equal(syncStatusLabel(at(2300), { ...running(1), status: "synced", result: at(-3000) }), "Timing adjusted +2.3 s");
    assert.equal(syncStatusLabel(at(2300), undefined), "Timing adjusted +2.3 s");
    assert.equal(syncStatusLabel(at(0), undefined), undefined);
});

test("progress is a whole percentage and phases read plainly", () => {
    const running = (progress: number | undefined, phase?: "queued" | "analyzing" | "matching") => ({ id: "j", status: "running", trigger: "manual", phase, progress, failure: undefined, result: undefined });
    assert.equal(syncPercent(running(0.416)), 42);
    assert.equal(syncPercent(running(2)), 100);
    assert.equal(syncPercent(running(undefined)), 0);
    assert.equal(syncPercent({ ...running(1), status: "synced" }), undefined);
    assert.equal(phaseText(running(0, "matching")), "Matching lines to speech…");
    assert.equal(phaseText(running(0, "analyzing")), "Listening to the audio…");
    assert.equal(phaseText(running(0, "queued")), "Waiting to start…");
    assert.equal(phaseText(running(0)), "Waiting to start…");
    assert.equal(phaseText({ ...running(1), status: "failed" }), undefined);
});

test("failure and result lines read as Apple's", () => {
    assert.equal(failureText("subtitle_changed"), "The subtitle changed while it was syncing. Try again.");
    assert.equal(failureText("no_audio"), "This video has no audio Auger can read.");
    assert.equal(failureText("unavailable"), "The server is busy. Try again in a few minutes.");
    assert.equal(failureText("error"), "Sync failed. Try again.");
    assert.equal(failureText(undefined), "Sync failed. Try again.");
    const finished = (status: string, extra: Record<string, unknown> = {}) => ({ id: "j", status, trigger: "manual", phase: undefined, progress: undefined, failure: undefined, result: undefined, ...extra });
    assert.deepEqual(syncResult({ offsetMs: -3000, scale: 1 }, finished("synced")), { text: "Synced to the audio: −3.0 s", warning: false });
    assert.equal(syncResult({ offsetMs: 0, scale: 1 }, finished("synced")), undefined);
    assert.deepEqual(syncResult({ offsetMs: 0, scale: 1 }, finished("already_synced")), { text: "Already matches the audio.", warning: false });
    assert.deepEqual(syncResult({ offsetMs: 0, scale: 1 }, finished("no_match")), { text: "Doesn't match this video's audio; probably for another release.", warning: true });
    assert.deepEqual(syncResult({ offsetMs: 0, scale: 1 }, finished("failed", { failure: "no_audio" })), { text: "This video has no audio Auger can read.", warning: true });
    assert.equal(syncResult({ offsetMs: 0, scale: 1 }, undefined), undefined);
    assert.equal(syncActionNote(false), "Matches the timing to the audio for everyone watching.");
    assert.equal(syncActionNote(true), "Matches the timing to the audio for everyone. The file itself isn't changed.");
});

test("timing text rounds as printf does and names frame-rate conversions", () => {
    assert.equal(describeTiming({ offsetMs: 2300, scale: 1 }), "+2.3 s");
    assert.equal(describeTiming({ offsetMs: -400, scale: 1 }), "−0.4 s");
    assert.equal(describeTiming({ offsetMs: 0, scale: 1 }), "+0.0 s");
    // printf rounds an exact tie to even where toFixed rounds it up.
    assert.equal(describeTiming({ offsetMs: 250, scale: 1 }), "+0.2 s");
    assert.equal(describeTiming({ offsetMs: 750, scale: 1 }), "+0.8 s");
    assert.equal(describeTiming({ offsetMs: 1250, scale: 1 }), "+1.2 s");
    assert.equal(describeTiming({ offsetMs: -250, scale: 1 }), "−0.2 s");
    assert.equal(scaleText(1), undefined);
    assert.equal(scaleText(25 / 23.976), "25→23.976 fps");
    assert.equal(scaleText(1.0042), "×1.0042 speed");
    assert.equal(describeTiming({ offsetMs: 0, scale: 25 / 23.976 }), "25→23.976 fps");
    assert.equal(describeTiming({ offsetMs: 1500, scale: 25 / 23.976 }), "+1.5 s · 25→23.976 fps");
});

test("sync rows wait for the server: unavailable status asks for nothing more", async () => {
    const { h, sync } = await setup({ ...available, state: "disabled" });
    assert.equal(sync.view.available, false);
    assert.deepEqual(sync.view.timing, {});
    assert.equal(h.fake.requests.some(row => row.path === `/subtitles/${FILE}/sync`), false);
    const refused = await setup({ ...available, allowed: false });
    assert.equal(refused.sync.view.available, false);
    sync.destroy();
    refused.sync.destroy();
});

test("a failed status read leaves sync out and never gates playback", async () => {
    const { sync } = await setup(null);
    assert.equal(sync.view.available, false);
    sync.destroy();
});

test("an available server lists each subtitle's timing controls and status", async () => {
    const { sync } = await setup(available, [state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("synced", { result: { offset_ms: -3000, scale: 1 }, finished_at: "2026-11-17T01:00:05.000Z" }) }), state({ language: "fr" }, "external-9")]);
    assert.equal(sync.view.available, true);
    assert.equal(sync.view.status[KEY], "Synced −3.0 s");
    assert.equal(sync.view.status["external-9"], undefined);
    assert.deepEqual(sync.view.timing[KEY], { key: KEY, canSync: true, canReset: true, busy: false, inProgress: false, forbidden: undefined, progress: undefined, note: { text: "Synced to the audio: −3.0 s", tone: "plain" } });
    assert.deepEqual(sync.view.timing["external-9"], { key: "external-9", canSync: true, canReset: false, busy: false, inProgress: false, forbidden: undefined, progress: undefined, note: { text: "Matches the timing to the audio for everyone. The file itself isn't changed.", tone: "hint" } });
    sync.destroy();
});

test("sidecar files wait for the server's external flag", async () => {
    const { sync } = await setup({ ...available, external: false }, [state(), state({}, "external-9")]);
    assert.equal(sync.view.timing["external-9"], undefined);
    assert.equal(sync.view.timing[KEY]?.canSync, true);
    sync.destroy();
});

test("Sync to Audio starts once, shows progress, polls to the result and reports the timing change", async () => {
    const { h, sync, changed } = await setup();
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`,
        { status: 202, body: { subtitle: state({ sync: job("pending", { phase: "queued", progress: 0 }) }) } },
        { status: 200, body: { subtitle: state({ sync: job("running", { phase: "analyzing", progress: 0.4 }) }) } },
        { status: 200, body: { subtitle: state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("synced", { result: { offset_ms: -3000, scale: 1 }, finished_at: "2026-11-17T01:00:09.000Z" }) }) } });
    const start = sync.request(KEY);
    await start;
    await sync.request(KEY);
    assert.equal(h.fake.requests.filter(row => row.method === "POST" && row.path === `/subtitles/${FILE}/sync/${KEY}`).length, 1, "a press during a running job does nothing");
    assert.deepEqual(sync.view.timing[KEY]?.progress, { percent: 0, phase: "Waiting to start…" });
    assert.equal(sync.view.timing[KEY]?.inProgress, true);
    await h.clock.advance(3000);
    assert.deepEqual(sync.view.timing[KEY]?.progress, { percent: 40, phase: "Listening to the audio…" });
    assert.equal(sync.view.status[KEY], "Syncing… 40%");
    await h.clock.advance(3000);
    assert.equal(sync.view.timing[KEY]?.inProgress, false);
    assert.equal(sync.view.timing[KEY]?.progress, undefined);
    assert.equal(sync.view.status[KEY], "Synced −3.0 s");
    assert.deepEqual(sync.view.timing[KEY]?.note, { text: "Synced to the audio: −3.0 s", tone: "plain" });
    assert.deepEqual(changed, [KEY, KEY], "the first listing, then the changed timing once");
    assert.equal(sync.timingVersion(KEY), 2);
    const reads = h.fake.requests.length;
    await h.clock.advance(60000);
    assert.equal(h.fake.requests.length, reads, "polling stops once the job ends");
    assert.ok(h.fake.requests.find(row => row.path === `/subtitles/${FILE}/sync/${KEY}` && row.method === "POST")?.headers["x-profile-id"]);
    sync.destroy();
});

test("a job still running after five minutes stops polling until the list is read again", async () => {
    const { h, sync } = await setup(available, [state({ sync: job("running", { phase: "matching", progress: 0.5 }) })]);
    const reading = (): number => h.fake.requests.filter(row => row.method === "GET" && row.path === `/subtitles/${FILE}/sync/${KEY}`).length;
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, ...Array.from({ length: 200 }, () => ({ status: 200, body: { subtitle: state({ sync: job("running", { phase: "matching", progress: 0.5 }) }) } })));
    await h.clock.advance(5 * 60000);
    const polled = reading();
    assert.ok(polled >= 90 && polled <= 101, `polled every 3 s for five minutes, not ${polled}`);
    await h.clock.advance(30000);
    assert.equal(reading(), polled, "the limit stops the poll");
    sync.destroy();
});

test("refusals and failures reach the row in Apple's words", async () => {
    const { h, sync } = await setup();
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, problem(403, "forbidden", "Forbidden"));
    await sync.request(KEY);
    assert.equal(sync.view.timing[KEY]?.forbidden, "This server doesn't allow changing subtitle timing.");
    const unsupported = await setup();
    unsupported.h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, problem(422, "unprocessable", "Unprocessable"));
    await unsupported.sync.request(KEY);
    assert.equal(unsupported.sync.view.timing[KEY]?.canSync, false);
    assert.deepEqual(unsupported.sync.view.timing[KEY]?.note, { text: "This format can't be synced.", tone: "error" });
    const broken = await setup();
    broken.h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, problem(500, "internal", "Internal"));
    await broken.sync.request(KEY);
    assert.deepEqual(broken.sync.view.timing[KEY]?.note, { text: "Couldn't sync this subtitle. Try again.", tone: "error" });
    assert.equal(broken.sync.view.timing[KEY]?.busy, false);
    sync.destroy();
    unsupported.sync.destroy();
    broken.sync.destroy();
});

test("Reset Timing reads the validator, then replaces the timing with the identity", async () => {
    const { h, sync, changed } = await setup(available, [state({ timing: { offset_ms: 2300, scale: 1 } })]);
    assert.equal(sync.view.timing[KEY]?.canReset, true);
    assert.deepEqual(changed, [KEY], "first listed off the identity: the cues are read again once");
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, { status: 200, headers: { ETag: "\"v3\"" }, body: { subtitle: state({ timing: { offset_ms: 2300, scale: 1 } }) } });
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}/timing`, { status: 200, body: { subtitle: state() } });
    await sync.reset(KEY);
    const put = h.fake.requests.find(row => row.method === "PUT");
    assert.equal(put?.path, `/subtitles/${FILE}/sync/${KEY}/timing`);
    assert.equal(put?.headers["if-match"], "\"v3\"");
    assert.deepEqual(put?.body, { offset_ms: 0, scale: 1 });
    assert.equal(sync.view.timing[KEY]?.canReset, false);
    assert.deepEqual(changed, [KEY, KEY], "and again for the reset");
    sync.destroy();
});

test("Reset Timing failures say what happened and a changed subtitle asks for another try", async () => {
    const { h, sync } = await setup(available, [state({ timing: { offset_ms: 2300, scale: 1 } })]);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, { status: 200, headers: { ETag: "\"v3\"" }, body: { subtitle: state({ timing: { offset_ms: 2300, scale: 1 } }) } });
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}/timing`, problem(412, "precondition-failed", "Precondition Failed"));
    await sync.reset(KEY);
    assert.deepEqual(sync.view.timing[KEY]?.note, { text: "The subtitle changed. Try again.", tone: "error" });
    assert.equal(sync.view.timing[KEY]?.canReset, true);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, problem(500, "internal", "Internal"));
    await sync.reset(KEY);
    assert.deepEqual(sync.view.timing[KEY]?.note, { text: "Couldn't reset the timing. Try again.", tone: "error" });
    sync.destroy();
});

test("a read answered without a validator never sends the reset", async () => {
    const { h, sync } = await setup(available, [state({ timing: { offset_ms: 2300, scale: 1 } })]);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, { status: 200, body: { subtitle: state({ timing: { offset_ms: 2300, scale: 1 } }) } });
    await sync.reset(KEY);
    assert.equal(h.fake.requests.some(row => row.method === "PUT"), false);
    assert.deepEqual(sync.view.timing[KEY]?.note, { text: "Couldn't reset the timing. Try again.", tone: "error" });
    sync.destroy();
});

test("a poll that fails late for an older job does not stop following the newer one", async () => {
    const running = state({ sync: job("running", { phase: "matching", progress: 0.5 }) });
    const { h, sync } = await setup(available, [running]);
    const path = `/subtitles/${FILE}/sync/${KEY}`;
    h.fake.script(path, problem(404, "not_found", "Not found"));
    const slow = h.fake.hold(path);
    await h.clock.advance(3000);
    const finished = state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("synced", { result: { offset_ms: -3000, scale: 1 } }) });
    h.fake.script(`/subtitles/${FILE}/sync`, { status: 200, body: { subtitles: [finished] } });
    sync.reload();
    await h.clock.advance(0);
    h.fake.script(path,
        { status: 202, body: { subtitle: state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("pending", { id: "job-2", phase: "queued", progress: 0 }) }) } },
        { status: 200, body: { subtitle: state({ timing: { offset_ms: -2500, scale: 1 }, sync: job("synced", { id: "job-2", result: { offset_ms: -2500, scale: 1 } }) }) } });
    await sync.request(KEY);
    assert.equal(sync.view.timing[KEY]?.inProgress, true);
    slow.release();
    await h.clock.advance(0);
    assert.equal(sync.view.timing[KEY]?.inProgress, true, "the old poll's 404 does not end the new job");
    await h.clock.advance(3000);
    assert.equal(sync.view.status[KEY], "Synced −2.5 s", "the new job is still followed to its end");
    sync.destroy();
});

test("destroying the model stops polling", async () => {
    const { h, sync } = await setup(available, [state({ sync: job("running", { progress: 0.1 }) })]);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, ...Array.from({ length: 5 }, () => ({ status: 200, body: { subtitle: state({ sync: job("running", { progress: 0.1 }) }) } })));
    sync.destroy();
    const before = h.fake.requests.length;
    await h.clock.advance(30000);
    assert.equal(h.fake.requests.length, before);
});

test("an answer for another file or another subtitle is refused, not recorded", async () => {
    const { h, sync } = await setup();
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, { status: 202, body: { subtitle: state({ timing: { offset_ms: 5000, scale: 1 } }, "stored-8") } });
    await sync.request(KEY);
    assert.deepEqual(sync.view.timing[KEY]?.note, { text: "Couldn't sync this subtitle. Try again.", tone: "error" });
    assert.equal(sync.view.timing["stored-8"], undefined);
    assert.equal(sync.view.timing[KEY]?.canReset, false);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, { status: 202, body: { subtitle: state({ media_file_id: "99" }) } });
    await sync.request(KEY);
    assert.equal(sync.view.timing[KEY]?.inProgress, false);
    sync.destroy();
});

test("a refused re-arm after the poll limit leaves the job re-armable instead of stuck on Syncing", async () => {
    const { h, sync } = await setup(available, [state({ sync: job("running", { phase: "matching", progress: 0.5 }) })]);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, ...Array.from({ length: 200 }, () => ({ status: 200, body: { subtitle: state({ sync: job("running", { phase: "matching", progress: 0.5 }) }) } })));
    await h.clock.advance(5 * 60000 + 6000);
    assert.equal(sync.view.timing[KEY]?.inProgress, false, "the limit frees the row");
    h.fake.scripted.delete(`/subtitles/${FILE}/sync/${KEY}`);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, problem(500, "internal", "Internal"));
    await sync.request(KEY);
    assert.deepEqual(sync.view.timing[KEY]?.note, { text: "Couldn't sync this subtitle. Try again.", tone: "error" });
    assert.equal(sync.view.timing[KEY]?.inProgress, false, "the refused press does not make the old job active again");
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, { status: 202, body: { subtitle: state({ sync: job("running", { progress: 0.6 }) }) } });
    await sync.request(KEY);
    assert.equal(h.fake.requests.filter(row => row.method === "POST" && row.path === `/subtitles/${FILE}/sync/${KEY}`).length, 2, "the next press goes out");
    assert.equal(sync.view.timing[KEY]?.inProgress, true);
    sync.destroy();
});

test("a list read that left before a newer answer arrived does not overwrite it", async () => {
    const { h, sync } = await setup();
    h.fake.script(`/subtitles/${FILE}/sync`, { status: 200, body: { subtitles: [state()] } });
    const hold = h.fake.hold(`/subtitles/${FILE}/sync`);
    sync.reload();
    await h.clock.advance(0);
    h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, { status: 202, body: { subtitle: state({ sync: job("running", { phase: "queued", progress: 0 }) }) } });
    await sync.request(KEY);
    hold.release();
    await h.clock.advance(0);
    assert.equal(sync.view.timing[KEY]?.inProgress, true, "the late idle listing is dropped");
    sync.destroy();
});

test("a list read during a slow poll does not start a second poll whose late answer revives the finished job", async () => {
    const running = state({ sync: job("running", { phase: "matching", progress: 0.5 }) });
    const { h, sync } = await setup(available, [running]);
    const path = `/subtitles/${FILE}/sync/${KEY}`;
    const reading = (): number => h.fake.requests.filter(row => row.method === "GET" && row.path === path).length;
    h.fake.script(path,
        { status: 200, body: { subtitle: running } },
        { status: 200, body: { subtitle: state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("synced", { result: { offset_ms: -3000, scale: 1 } }) }) } });
    h.fake.script(`/subtitles/${FILE}/sync`, { status: 200, body: { subtitles: [running] } });
    const slow = h.fake.hold(path);
    await h.clock.advance(3000);
    assert.equal(reading(), 1);
    sync.reload();
    await h.clock.advance(0);
    await h.clock.advance(3000);
    assert.equal(reading(), 1, "no second poll while the first is still waiting");
    slow.release();
    await h.clock.advance(0);
    await h.clock.advance(3000);
    assert.equal(reading(), 2);
    assert.equal(sync.view.timing[KEY]?.inProgress, false, "the job ends at the newer answer");
    sync.destroy();
});

test("each subtitle's timing has a version: the first sight and each change raise it, an unchanged answer does not", async () => {
    const synced = state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("synced", { result: { offset_ms: -3000, scale: 1 } }) });
    const { h, sync, changed } = await setup(available, [synced, state({}, "stored-8")]);
    assert.deepEqual(changed, [KEY, "stored-8"], "cues read before the first listing may predate either timing, the original one included");
    assert.deepEqual([sync.timingVersion(KEY), sync.timingVersion("stored-8"), sync.timingVersion("unlisted")], [1, 1, 0]);
    h.fake.script(`/subtitles/${FILE}/sync`, { status: 200, body: { subtitles: [synced, state({ timing: { offset_ms: 500, scale: 1 } }, "stored-8")] } });
    sync.reload();
    await h.clock.advance(0);
    assert.deepEqual([sync.timingVersion(KEY), sync.timingVersion("stored-8")], [1, 2]);
    assert.deepEqual(changed, [KEY, "stored-8", "stored-8"]);
    sync.destroy();
});

test("a poll answer overtaken by a newer answer for the same subtitle is dropped, so a new job keeps being followed", async () => {
    const running = state({ sync: job("running", { phase: "matching", progress: 0.5 }) });
    const { h, sync } = await setup(available, [running]);
    const path = `/subtitles/${FILE}/sync/${KEY}`;
    const finished = state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("synced", { result: { offset_ms: -3000, scale: 1 } }) });
    h.fake.script(path, { status: 200, body: { subtitle: finished } });
    const slow = h.fake.hold(path);
    await h.clock.advance(3000);
    h.fake.script(`/subtitles/${FILE}/sync`, { status: 200, body: { subtitles: [finished] } });
    sync.reload();
    await h.clock.advance(0);
    assert.equal(sync.view.timing[KEY]?.inProgress, false, "the listing saw the first job finish");
    h.fake.script(path,
        { status: 202, body: { subtitle: state({ timing: { offset_ms: -3000, scale: 1 }, sync: job("pending", { id: "job-2", phase: "queued", progress: 0 }) }) } },
        { status: 200, body: { subtitle: state({ timing: { offset_ms: -2500, scale: 1 }, sync: job("synced", { id: "job-2", result: { offset_ms: -2500, scale: 1 } }) }) } });
    await sync.request(KEY);
    assert.equal(sync.view.timing[KEY]?.inProgress, true);
    slow.release();
    await h.clock.advance(0);
    assert.equal(sync.view.timing[KEY]?.inProgress, true, "the old poll's answer does not end the new job");
    await h.clock.advance(3000);
    assert.equal(sync.view.timing[KEY]?.inProgress, false, "the new job is still followed to its end");
    assert.equal(sync.view.status[KEY], "Synced −2.5 s");
    sync.destroy();
});

test("a scale-only timing counts as a timing: first listed and changed, it raises the version", async () => {
    const { h, sync, changed } = await setup(available, [state({ timing: { offset_ms: 0, scale: 1.04271 } })]);
    assert.deepEqual(changed, [KEY]);
    assert.equal(sync.view.timing[KEY]?.canReset, true, "a frame-rate conversion alone can be reset");
    h.fake.script(`/subtitles/${FILE}/sync`, { status: 200, body: { subtitles: [state({ timing: { offset_ms: 0, scale: 0.95904 } })] } });
    sync.reload();
    await h.clock.advance(0);
    assert.deepEqual(changed, [KEY, KEY], "a change of scale alone asks for the cues again");
    assert.equal(sync.timingVersion(KEY), 2);
    sync.destroy();
});

// SubtitleSyncLabel and SubtitleSyncModel (silo-apple main 9dabb62) read player.subtitleSync.* and player.tracks.*: each line follows the shown language.
test("every sync line reads in the shown language, with English as before", async () => {
    const de = (key: MessageKey, args?: Parameters<typeof translate>[1]): string => translate(key, args, "de");
    const at = (offsetMs: number, scale = 1) => ({ offsetMs, scale });
    const finished = (status: string, extra: Record<string, unknown> = {}) => ({ id: "j", status, trigger: "manual", phase: undefined, progress: undefined, failure: undefined, result: undefined, ...extra });
    const running = (progress: number, phase?: "queued" | "analyzing" | "matching") => ({ ...finished("running"), phase, progress });
    assert.notEqual(de("player.subtitleSync.statusFailed"), "Sync failed", "the German file carries the sync keys");
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    try {
        assert.equal(syncStatusLabel(at(0), running(0.4)), de("player.subtitleSync.statusSyncingPercent", { percent: "40" }));
        assert.equal(syncStatusLabel(at(0), running(0)), de("player.tracks.syncing"));
        assert.equal(syncStatusLabel(at(0), finished("no_match")), de("player.subtitleSync.statusNoMatch"));
        assert.equal(syncStatusLabel(at(0), finished("failed")), de("player.subtitleSync.statusFailed"));
        assert.equal(syncStatusLabel(at(0), finished("already_synced")), de("player.subtitleSync.statusAlreadyInSync"));
        assert.equal(syncStatusLabel(at(0), finished("synced")), de("player.subtitleSync.statusOriginal"));
        assert.equal(syncStatusLabel(at(-3000), finished("synced", { result: at(-3000) })), de("player.subtitleSync.statusSynced", { timing: "−3.0 s" }));
        assert.equal(syncStatusLabel(at(2300), undefined), de("player.subtitleSync.statusAdjusted", { timing: "+2.3 s" }));
        assert.equal(phaseText(running(0, "matching")), de("player.subtitleSync.phaseMatching"));
        assert.equal(phaseText(running(0, "analyzing")), de("player.subtitleSync.phaseAnalyzing"));
        assert.equal(phaseText(running(0)), de("player.subtitleSync.phaseWaiting"));
        assert.equal(failureText("subtitle_changed"), de("player.subtitleSync.failureSubtitleChanged"));
        assert.equal(failureText("no_audio"), de("player.subtitleSync.failureNoAudio"));
        assert.equal(failureText("unavailable"), de("player.subtitleSync.failureUnavailable"));
        assert.equal(failureText(undefined), de("player.subtitleSync.failureGeneric"));
        assert.deepEqual(syncResult(at(-3000), finished("synced")), { text: de("player.subtitleSync.resultSynced", { timing: "−3.0 s" }), warning: false });
        assert.deepEqual(syncResult(at(0), finished("already_synced")), { text: de("player.subtitleSync.resultAlreadyMatches"), warning: false });
        assert.deepEqual(syncResult(at(0), finished("no_match")), { text: de("player.subtitleSync.resultNoMatch"), warning: true });
        assert.equal(syncActionNote(false), de("player.subtitleSync.actionNote"));
        assert.equal(syncActionNote(true), de("player.subtitleSync.actionNoteExternal"));
        assert.equal(scaleText(1.0042), de("player.subtitleSync.speedFactor", { rate: "1.0042" }));
    } finally { setAppLanguage(null); }
    // A refusal recorded in English reads in German once German is shown: the model keeps the key, not the sentence.
    const refused = await setup();
    refused.h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, problem(403, "forbidden", "Forbidden"));
    await refused.sync.request(KEY);
    const broken = await setup();
    broken.h.fake.script(`/subtitles/${FILE}/sync/${KEY}`, problem(500, "internal", "Internal"));
    await broken.sync.request(KEY);
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    try {
        assert.equal(refused.sync.view.timing[KEY]?.forbidden, de("player.subtitleSync.forbiddenServer"));
        assert.deepEqual(broken.sync.view.timing[KEY]?.note, { text: de("player.subtitleSync.syncFailedRetry"), tone: "error" });
    } finally { setAppLanguage(null); refused.sync.destroy(); broken.sync.destroy(); }
});
