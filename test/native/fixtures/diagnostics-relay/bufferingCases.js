// Buffering / Quality relay cases for #875 against the client wire contract (v1 payload, `inc` iv 1 and
// `bq` bv 1, src/diagnosticsBuffering.ts). Plain ES module with no Node imports, like relayCases.js, so a
// browser harness on the TV can import it next to workers/diagnostics-relay/worker.js and call
// runBufferingCases(handleRequest). Every case builds its own fresh fake destination(s).

import { fakeGitHub, send } from "./fakeGitHub.js";

class CaseFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new CaseFailure(message);
}

function equal(actual, expected, message) {
  check(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function includes(text, fragment, message) {
  check(typeof text === "string" && text.includes(fragment), `${message}: missing ${JSON.stringify(fragment)}`);
}

function excludes(text, fragment, message) {
  check(typeof text === "string" && !text.includes(fragment), `${message}: leaked ${JSON.stringify(fragment)}`);
}

const device = { v: 1, app: "0.5.0", tv: "QE65S95C", fw: "1650", os: "Tizen 9.0", ua: "Chrome/120.0.6099.5", hdr: true, srv: "412" };

// Synthetic endpoint and network identifiers; none may appear in any outbound title, body, comment or decoded metadata.
const SENSITIVE = ["synthetic.example.invalid", "192.0.2.77", "AA:BB:CC:DD:EE:FF", "SYNTHSSID", "synth-nas.local", "SYNTH_TITLE", "SYNTH_PROFILE"];

function assertNoSensitive(destination, label) {
  for (const text of destination.publishedText()) {
    for (const value of SENSITIVE) excludes(text, value, label);
  }
}

/** Evidence shaped exactly as bufferingPayload() serializes it. */
export const bufferingEvidence = {
  bv: 1, md: "always", adv: true, q: "auto", mc: "none", ll: "server", pq: "auto", pk: 8000, sk: 24000, ok: 8000, est: 12000,
  net: { t: "wifi", ec: "4g", on: true },
  spd: { kbps: 12000, src: "probe", age: 3600, fresh: true },
  st: { n: 2, d: [1200, 6000], lg: 6000 },
  sd: [{ r: "auto", fq: "auto", fk: 8000, est: 5600, o: "not_adopted" }],
};

/** A lowering whose answer was lost, then a reconnect that ran out: the failed replan and the terminal outcome in one chain. */
export const failedRecovery = {
  iv: 1, cat: "buffering", out: "failed", kind: "network", op: "replan_playback", stage: "quality_change", code: "no_answer",
  fs: "reconnect", fc: "network_unreachable", done: "playing", open: true, shown: true, rs: 0, rec: { n: 0, c: 1, r: "exhausted" },
  pl: { dl: "server_transcode_hls", pr: "hls", q: "auto", kbps: 24000, pos: 0, at: 1820 }, set: { q: "auto", cap: "none", hdr: true }, hp: "unavailable",
  req: { pos: "none", sub: "auto", aud: "default" },
  t: ["playing:ok", "quality_change:fail:no_answer", "reconnect:end:network"],
};

const separatePlaybackFailure = {
  iv: 1, cat: "playback", out: "failed", kind: "playback_failed", op: "avplay", stage: "avplay_prepare", code: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT",
  fs: "avplay_prepare", fc: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT", done: "playlist_check", av: { f: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT", l: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT" },
  open: true, shown: false, rs: 0, rec: { n: 2, c: 0, r: "exhausted" }, pl: { dl: "original_http", pr: "http", pos: 0, at: 0 },
  set: { q: "auto", cap: "none", hdr: true }, hp: "unavailable", req: { pos: "none", sub: "auto", aud: "default" },
  t: ["avplay_prepare:fallback:PLAYER_ERROR_NOT_SUPPORTED_FORMAT", "avplay_prepare:fail:PLAYER_ERROR_NOT_SUPPORTED_FORMAT"],
};

/** As the client sends a captured record: the canonical category, the submission source and the frozen evidence. */
function report(inc, source, bq) {
  return { ...device, cat: inc.cat, ...(source === "auto" ? { auto: true } : {}), inc: { ...inc, src: source }, ...(bq === undefined ? {} : { bq }) };
}

/** A user-observed Buffering / Quality report: no incident, the attempt's evidence only. */
function observed(bq, extra = {}) {
  return { ...device, cat: "buffering", ...(bq === undefined ? {} : { bq }), ...extra };
}

const withoutSourceRow = (body) => body.split("\n").filter((line) => !line.startsWith("| Submission source |")).join("\n");

export const BUFFERING_CASES = [
  {
    name: "a failed recovery renders identical evidence manually and automatically, and one issue in a shared destination",
    async run(handleRequest) {
      const manualOnly = fakeGitHub();
      const automaticOnly = fakeGitHub();
      equal((await send(handleRequest, manualOnly, report(failedRecovery, "manual", bufferingEvidence))).status, 201, "manual created");
      equal((await send(handleRequest, automaticOnly, report(failedRecovery, "auto", bufferingEvidence))).status, 201, "automatic created");
      const manual = manualOnly.created()[0].body;
      const automatic = automaticOnly.created()[0].body;
      equal(manual.title, "Playback stalled after a quality step-down: no server answer", "failed recovery title");
      equal(manual.title, automatic.title, "titles");
      equal(withoutSourceRow(manual.body), withoutSourceRow(automatic.body), "evidence");
      includes(manual.body, "| Submission source | Manual |", "manual source");
      includes(automatic.body, "| Submission source | Automatic error report |", "automatic source");
      for (const row of [
        "### Buffering and quality",
        "| Lower quality when buffering | Always |",
        "| Quality preference | Automatic quality (auto) |",
        "| Bitrate cap from Settings | None |",
        "| Learned connection limit | Applied by the server when set (value not visible on the TV) |",
        "| Planned bitrate | 8000 kbps |",
        "| Source bitrate | 24000 kbps |",
        "| Output bitrate | 8000 kbps |",
        "| Connection estimate sent at start | 12000 kbps (from a stored reading) |",
        "| Last stored speed reading | 12000 kbps from a speed test, 1 h old at capture, fresh |",
        "| Network type | Wi-Fi |",
        "| Effective connection class (browser estimate) | 4g |",
        "| Stalls of 1 s or more (outages and startup excluded) | 2; recent: 1.2 s, 6.0 s; longest 6.0 s |",
        "1. Automatic lowering after stalls · auto 8000 kbps → no new plan · step-down estimate 5600 kbps · measured throughput not available · No plan adopted",
      ]) includes(manual.body, row, "buffering evidence");
      check(manual.body.indexOf("### Buffering and quality") < manual.body.indexOf("### Device"), "evidence renders before device context");

      const shared = fakeGitHub();
      equal((await send(handleRequest, shared, report(failedRecovery, "auto", bufferingEvidence))).json.status, "created", "shared first");
      equal((await send(handleRequest, shared, report(failedRecovery, "manual", bufferingEvidence))).json.status, "duplicate", "shared second");
      equal(shared.issues.length, 1, "one issue");
      equal(shared.outbound.length, 1, "no follow-up noise");
    },
  },
  {
    name: "one causal timeline: the failed replan precedes the terminal outcome, a later Playback failed selection groups, a separate playback failure files",
    async run(handleRequest) {
      const gh = fakeGitHub();
      await send(handleRequest, gh, report(failedRecovery, "auto", bufferingEvidence));
      const body = gh.created()[0].body.body;
      const failed = body.indexOf("2. Quality change · fail · no_answer");
      const terminal = body.indexOf("3. Reconnect · end · network");
      check(failed !== -1 && terminal !== -1 && failed < terminal, "failed replan, then terminal outcome, in one sequence");
      includes(body, "| Category | Buffering / Quality |", "canonical category");
      // The client sends the same frozen record when the viewer picks Playback failed.
      equal((await send(handleRequest, gh, report(failedRecovery, "manual", bufferingEvidence))).json.status, "duplicate", "manual Playback failed selection joins");
      equal(gh.issues.length, 1, "one issue for the incident");
      equal((await send(handleRequest, gh, report(separatePlaybackFailure, "auto", undefined))).status, 201, "separate playback failure files");
      excludes(gh.created()[1].body.body, "### Buffering and quality", "a playback failure carries no buffering section");
    },
  },
  {
    name: "titles distinguish a failed quality recovery from user-observed buffering symptoms, which render their evidence",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const lowered = { ...bufferingEvidence, pk: 5600, ok: 5600, sd: [{ r: "auto", fq: "auto", fk: 8000, tq: "auto", tk: 5600, est: 5600, o: "adopted" }] };
      const stalls = { ...bufferingEvidence, md: "never", ll: "ignored", sd: [], st: { n: 3, d: [1000, 2000, 3000], lg: 3000 } };
      const forced = { ...stalls, md: "ask", ll: "server", q: "720p", mc: 4000 };
      await send(handleRequest, gh, report(failedRecovery, "manual", bufferingEvidence));
      await send(handleRequest, gh, observed(lowered, { precedingScreen: "details" }));
      await send(handleRequest, gh, observed(stalls, { precedingScreen: "home" }));
      await send(handleRequest, gh, observed(forced, { precedingScreen: "library" }));
      await send(handleRequest, gh, observed(undefined, { precedingScreen: "search" }));
      const [failure, step, stalled, capped, bare] = gh.created().map((call) => call.body);
      equal(failure.title, "Playback stalled after a quality step-down: no server answer", "failed recovery");
      equal(step.title, "Viewer reported buffering after quality was lowered", "successful step-down");
      equal(stalled.title, "Viewer reported buffering during playback", "repeated stalls");
      equal(bare.title, "Viewer reported a buffering or quality problem on Search", "no evidence falls back to the category");
      includes(step.body, "| Report type | Viewer-observed symptom (no failure detected) |", "observed report type");
      includes(step.body, "1. Automatic lowering after stalls · auto 8000 kbps → auto 5600 kbps · step-down estimate 5600 kbps · measured throughput not available · New plan adopted", "adopted step");
      includes(stalled.body, "| Learned connection limit | Ignored while lowering is off |", "learned limit ignored");
      includes(stalled.body, "| Stalls of 1 s or more (outages and startup excluded) | 3; recent: 1.0 s, 2.0 s, 3.0 s; longest 3.0 s |", "stall durations");
      includes(capped.body, "| Quality preference | Fixed quality (720p) |", "fixed quality");
      includes(capped.body, "| Bitrate cap from Settings | 4000 kbps (forced cap) |", "forced cap");
      excludes(bare.body, "### Buffering and quality", "no evidence, no section");
    },
  },
  {
    name: "a missing measurement and unavailable network APIs are labelled, not inferred",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const unmeasured = { bv: 1, md: "always", adv: false, q: "auto", mc: "none", ll: "unsupported", net: { t: "unavailable", ec: "unavailable" }, spd: "none", st: { n: 0, d: [], lg: 0 }, sd: [] };
      await send(handleRequest, gh, observed(unmeasured, { precedingScreen: "details" }));
      const body = gh.created()[0].body.body;
      for (const row of [
        "| Last stored speed reading | No stored reading |",
        "| Connection estimate sent at start | None sent |",
        "| Network type | Not reported by the TV |",
        "| Effective connection class (browser estimate) | Not reported by the TV |",
        "| Learned connection limit | Not supported by the server |",
        "| Stalls of 1 s or more (outages and startup excluded) | None measured |",
        "| Output bitrate | None named (not transcoded or not reported) |",
      ]) includes(body, row, "unmeasured evidence");
      for (const [state, text] of [["unsupported", "Not supported by the server"], ["offline", "None: offline at start"], ["metered", "None: not used on a metered network"]]) {
        const own = fakeGitHub();
        await send(handleRequest, own, observed({ ...unmeasured, spd: state }, { precedingScreen: "details" }));
        includes(own.created()[0].body.body, `| Last stored speed reading | ${text} |`, state);
      }
      const stale = fakeGitHub();
      await send(handleRequest, stale, observed({ ...unmeasured, spd: { kbps: 9000, src: "sample", age: 777600, fresh: false } }, { precedingScreen: "details" }));
      includes(stale.created()[0].body.body, "| Last stored speed reading | 9000 kbps from a playback sample, 9 d old at capture, stale (too old to send) |", "stale reading");
    },
  },
  {
    name: "hostile or invalid evidence is dropped field by field; endpoint and network identifiers never publish; other categories ignore it",
    async run(handleRequest) {
      const hostile = {
        ...bufferingEvidence,
        q: "SYNTH_TITLE",
        pq: "https://synthetic.example.invalid:8443/stream",
        mc: 9e12,
        net: { t: "SYNTHSSID", ec: "4g", on: true, ssid: "SYNTHSSID", bssid: "AA:BB:CC:DD:EE:FF", ip: "192.0.2.77", host: "synth-nas.local" },
        spd: { kbps: 12000, src: "synth-nas.local", age: 10, fresh: true },
        st: { n: 2, d: [1200, "192.0.2.77", 9e12, 6000], lg: 6000 },
        sd: [{ r: "auto", fq: "SYNTH_PROFILE", fk: 8000, o: "not_adopted", host: "synth-nas.local" }, { r: "SYNTH_TITLE", o: "adopted" }],
        endpoint: "https://synthetic.example.invalid/api",
        ip: "192.0.2.77",
      };
      const gh = fakeGitHub();
      equal((await send(handleRequest, gh, report(failedRecovery, "auto", hostile))).status, 201, "report still files");
      const body = gh.created()[0].body.body;
      includes(body, "| Quality preference | Not reported |", "invalid preference dropped");
      includes(body, "| Network type | Not reported |", "invalid network dropped as a whole");
      includes(body, "| Last stored speed reading | Not reported |", "invalid reading dropped");
      includes(body, "| Stalls of 1 s or more (outages and startup excluded) | 2; recent: 1.2 s, 6.0 s; longest 6.0 s |", "invalid durations dropped");
      includes(body, "1. Automatic lowering after stalls · unknown quality 8000 kbps → no new plan · measured throughput not available · No plan adopted", "invalid step fields dropped");
      const changes = body.slice(body.indexOf("#### Quality changes")).split("\n### ")[0];
      excludes(changes, "\n2. ", "an invalid step is dropped");
      assertNoSensitive(gh, "hostile evidence");

      const missingVersion = fakeGitHub();
      const { bv: _bv, ...unversioned } = bufferingEvidence;
      equal((await send(handleRequest, missingVersion, report(failedRecovery, "manual", unversioned))).status, 201, "an unversioned record still files");
      excludes(missingVersion.created()[0].body.body, "### Buffering and quality", "unversioned evidence is not rendered");

      const otherCategory = fakeGitHub();
      await send(handleRequest, otherCategory, { ...device, cat: "app_ui", precedingScreen: "home", bq: bufferingEvidence });
      excludes(otherCategory.created()[0].body.body, "### Buffering and quality", "only a buffering report renders it");
    },
  },
  {
    name: "an older client's buffering incident without evidence still files and groups with a current one",
    async run(handleRequest) {
      const gh = fakeGitHub();
      equal((await send(handleRequest, gh, report(failedRecovery, "auto", undefined))).status, 201, "older client files");
      excludes(gh.created()[0].body.body, "### Buffering and quality", "no section without evidence");
      equal((await send(handleRequest, gh, report(failedRecovery, "manual", bufferingEvidence))).json.issueNumber, gh.issues[0].number, "the current client's report joins the same issue");
      equal(gh.issues.length, 1, "one issue");
    },
  },
];

/** Runs every case (or the named subset) and returns per-case results; never throws. */
export async function runBufferingCases(handleRequest, names) {
  const results = [];
  for (const entry of BUFFERING_CASES) {
    if (names !== undefined && !names.includes(entry.name)) continue;
    try {
      await entry.run(handleRequest);
      results.push({ name: entry.name, ok: true });
    } catch (error) {
      results.push({ name: entry.name, ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
