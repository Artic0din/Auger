// Relay cases for #872/#873 against the client wire contract (v1 payload + `inc` iv 1, src/diagnosticsIncident.ts).
// Plain ES module: no Node imports, no assertion library, so a browser harness on the TV can import it next to
// workers/diagnostics-relay/worker.js and call runRelayCases(handleRequest). Each case builds its own fresh fake
// destination(s); the equivalence comparison and the shared-destination grouping never share one.

import { deployedLegacyFingerprint, encodeState, fakeGitHub, fnv, incidentGroupId, send } from "./fakeGitHub.js";

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

const APP = "0.5.0";
const TV = "QE65S95C";
const device = { v: 1, app: APP, tv: TV, fw: "1650", os: "Tizen 9.0", ua: "Chrome/120.0.6099.5", hdr: true, srv: "412" };

// Synthetic sensitive markers; none may appear in any outbound title, body, comment or decoded metadata.
const SENSITIVE = [
  "synthetic.example.invalid",
  "SYNTHTOKEN",
  "SYNTH_TITLE",
  "synth_title_the_movie",
  "192.0.2.77",
  "AA:BB:CC:DD:EE:FF",
  "SYNTHSSID",
  "synthssid",
  "synth-nas.local",
  "SYNTH_PROFILE",
  "synth_profile",
  "SYNTHBEARER",
  "SYNTHSTACK",
  "SYNTH_TRACK",
  "SYNTH_SUBTITLE",
  "SYNTHSERIAL",
  "SYNTH_PATH",
];

function assertNoSensitive(destination, label) {
  for (const text of destination.publishedText()) {
    for (const value of SENSITIVE) excludes(text, value, label);
  }
}

// ---------------------------------------------------------------------------
// Incidents, shaped exactly as playbackIncident() serializes them
// ---------------------------------------------------------------------------

const NOT_REACHED = "not_reached";
const panel = { h10: true, hlg: true, dv: false };
const request = { pos: "none", sub: "auto", aud: "default" };
const defaults = { q: "auto", cap: "none", hdr: true };

/** A v1 payload carrying `inc`; `source` sets both `inc.src` and the legacy `auto` flag, as the client does. */
function report(inc, source, extra = {}) {
  return { ...device, cat: inc.cat, ...(source === "auto" ? { auto: true } : {}), ...extra, inc: { ...inc, src: source } };
}

/** #868 shape: start decision adaptation_unavailable carrying terminal reason session_expired; AVPlay never opened. */
export const sessionExpiredAtStart = {
  iv: 1, cat: "playback", out: "failed", kind: "terminal", op: "start_playback", stage: "start", code: "session_expired",
  fs: "start", fc: "session_expired", done: "settings", dec: "adaptation_unavailable", rt: false, open: false, shown: false,
  rs: 0, rec: { n: 0, c: 0, r: "none" }, pl: NOT_REACHED, set: defaults, hp: panel, req: request,
  t: ["capabilities:ok", "settings:ok", "start:end:terminal"],
};

/** Missing playback session: progress report answered HTTP 404 while playing. */
export const missingSession404 = {
  iv: 1, cat: "playback", out: "failed", kind: "session_expired", op: "progress_report", stage: "progress", code: "http_404",
  fs: "progress", fc: "http_404", done: "playing", http: 404, open: true, shown: true, rs: 1, rec: { n: 0, c: 0, r: "none" },
  pl: { dl: "original_http", pr: "http", ct: "mkv", q: "original", kbps: 24000, vc: "hevc", res: "3840x2160", dr: "hdr10", pos: 0, at: 754 },
  set: defaults, hp: panel, req: request, t: ["playing:ok", "progress:fail:http_404"],
};

/** The same expiry with no HTTP status observed: the client names it session_missing, never an invented status. */
const sessionMissing = { ...missingSession404, code: "session_missing", fc: "session_missing", http: undefined, t: ["playing:ok", "progress:end:session_expired"] };

/** Stale-attempt shape: a capped HLS attempt failing before player open, after an earlier Direct Play succeeded. */
export const cappedHlsBeforeOpen = {
  iv: 1, cat: "playback", out: "failed", kind: "playback_failed", op: "hls_playlist", stage: "playlist_check", code: "hls_playlist_unreadable",
  fs: "playlist_check", fc: "hls_playlist_unreadable", done: "media_token", open: false, shown: false, rs: 0, rec: { n: 0, c: 0, r: "none" },
  pl: { dl: "server_transcode_hls", pr: "hls", ct: "hls", q: "720p", kbps: 24000, vc: "hevc", res: "3840x2160", dr: "hdr10", pos: 0, at: 0 },
  set: { q: "720p", cap: 4000, hdr: false }, req: request, t: ["media_token:ok", "playlist_check:fail:hls_playlist_unreadable"],
};

const avplayAt = (stage, first, last = first) => ({
  iv: 1, cat: "playback", out: "failed", kind: "playback_failed", op: "avplay", stage, code: first, fs: stage, fc: last,
  done: "playlist_check", av: { f: first, l: last }, open: true, shown: false, rs: 0, rec: { n: 2, c: 0, r: "exhausted" },
  pl: { dl: "original_http", pr: "http", ct: "mkv", vc: "hevc", pos: 0, at: 0 }, set: defaults, hp: panel, req: request,
  t: [`${stage}:fallback:${first}`, `${stage}:fallback:${first}`, `${stage}:fail:${last}`],
});

const bufferingOwned = {
  iv: 1, cat: "buffering", out: "failed", kind: "playback_failed", op: "replan_playback", stage: "quality_change", code: "PLAYER_ERROR_CONNECTION_FAILED",
  fs: "quality_change", fc: "PLAYER_ERROR_CONNECTION_FAILED", done: "playing", av: { f: "PLAYER_ERROR_CONNECTION_FAILED", l: "PLAYER_ERROR_CONNECTION_FAILED" },
  open: true, shown: true, rs: 0, rec: { n: 2, c: 0, r: "exhausted" },
  pl: { dl: "server_transcode_hls", pr: "hls", q: "1080p", pos: 0, at: 1820 }, set: { q: "auto", cap: 8000, hdr: true }, hp: "unavailable", req: request,
  t: ["playing:ok", "quality_change:fallback:PLAYER_ERROR_CONNECTION_FAILED", "quality_change:fail:PLAYER_ERROR_CONNECTION_FAILED"],
};

const withoutSourceRow = (body) => body.split("\n").filter((line) => !line.startsWith("| Submission source |")).join("\n");

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const CASES = [
  {
    name: "#868 shape: plain refusal title, observed operation and decision, no invented HTTP status, sign-in claim or earlier plan",
    async run(handleRequest) {
      const gh = fakeGitHub();
      // `play` mimics a stale summary; with no plan for this attempt it must not render.
      const payload = report(sessionExpiredAtStart, "auto", { play: { m: "Direct play · MKV", d: "Original HTTP", e: "terminal: session_expired" } });
      const result = await send(handleRequest, gh, payload);
      equal(result.status, 201, "created");
      const [issue] = gh.created();
      equal(issue.body.title, "Playback start refused: session expired", "title");
      const body = issue.body.body;
      for (const row of [
        "| Category | Playback failed |",
        "| Submission source | Automatic error report |",
        "| Outcome | Failed |",
        "| Error kind | terminal |",
        "| Operation | Start playback |",
        "| First failed stage | Playback start request |",
        "| First failure code | session_expired |",
        "| Last completed stage | Playback settings |",
        "| Server decision | adaptation_unavailable |",
        "| HTTP status | Not observed |",
        "| Retryable | No |",
        "| AVPlay opened | No |",
        "| Route fallbacks | 0 |",
        "| Quality preference | auto |",
        "| HDR setting | On |",
        "| Plan | Never reached |",
        "| Position at failure | Never reached |",
        "| HDR panel capability | HDR10 yes, HLG yes, Dolby Vision no |",
        "1. Playback capabilities · ok",
        "3. Playback start request · end · terminal",
        `<!-- auger-group:inc1:${incidentGroupId(APP, TV, sessionExpiredAtStart)} -->`,
        `<!-- auger-fp:${deployedLegacyFingerprint(APP, TV, "terminal: session_expired")} -->`,
      ]) includes(body, row, "#868 body");
      check(!/HTTP [1-5]\d\d/.test(body), "no HTTP status may be invented");
      check(!/sign-in/i.test(body) && !/sign-in/i.test(issue.body.title), "session_expired must not claim a sign-in failure");
      excludes(body, "Direct play", "stale plan summary must not render when this attempt has no plan");
      check(body.indexOf("### Event sequence") < body.indexOf("### Device"), "events and outcomes render before device context");
      equal(JSON.stringify(issue.body.labels), JSON.stringify(["diagnostics", "needs-triage"]), "labels");
    },
  },
  {
    name: "missing playback session (observed HTTP 404), session missing without a status, and a start HTTP 401 stay distinct",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const startUnauthorized = { ...sessionExpiredAtStart, kind: "server", code: "http_401", fc: "http_401", http: 401, dec: undefined, rt: undefined, t: ["start:fail:http_401"] };
      for (const inc of [missingSession404, sessionMissing, startUnauthorized, sessionExpiredAtStart]) {
        equal((await send(handleRequest, gh, report(inc, "auto"))).status, 201, `${inc.code} created`);
      }
      const [notFound, missing, unauthorized] = gh.created().map((call) => call.body);
      equal(notFound.title, "Playback progress report failed: HTTP 404", "404 title");
      equal(missing.title, "Playback progress report failed: playback session missing", "no-status title");
      equal(unauthorized.title, "Playback start failed: HTTP 401", "401 title");
      includes(notFound.body, "| HTTP status | 404 |", "404 status");
      includes(notFound.body, "| Position at failure | 12:34 |", "observed position");
      includes(missing.body, "| HTTP status | Not observed |", "no status invented");
      equal(gh.issues.length, 4, "four issues");
      const reconnect = fakeGitHub();
      await send(handleRequest, reconnect, report({ ...missingSession404, fs: "reconnect", fc: "terminal_error", http: undefined }, "manual"));
      const body = reconnect.created()[0].body.body;
      includes(body, "| First failure HTTP status | 404 |", "progress response retained");
      includes(body, "| Final HTTP status | Not observed |", "no status invented for replacement refusal");
    },
  },
  {
    name: "capped HLS attempt before player open shows only its own settings and plan, with an observed zero position",
    async run(handleRequest) {
      const gh = fakeGitHub();
      await send(handleRequest, gh, report(cappedHlsBeforeOpen, "manual", { play: { m: "Transcoded by the server · MKV", d: "Server Transcode HLS" } }));
      const { title, body } = gh.created()[0].body;
      equal(title, "HLS playlist check failed before playback: HLS playlist unreadable", "title");
      for (const row of [
        "| Quality preference | 720p |",
        "| Bitrate cap | 4000 kbps |",
        "| HDR setting | Off |",
        "| Plan | Server Transcode HLS |",
        "| Stream quality | 720p |",
        "| Container | hls |",
        "| Recovery | None attempted |",
        "| Position at failure | 0:00 |",
        "| AVPlay opened | No |",
        "| HDR panel capability | Not reported |",
        "| Playback | Transcoded by the server · MKV |",
      ]) includes(body, row, "capped HLS body");
      excludes(body, "Direct Play", "no earlier attempt plan");
      excludes(body, "Original HTTP", "no earlier attempt delivery");
    },
  },
  {
    name: "known stages with the same generic AVPlay code get distinct titles and issues; an unknown stage falls back without inventing one",
    async run(handleRequest) {
      const gh = fakeGitHub();
      for (const stage of ["avplay_open", "avplay_prepare", "avplay_play"]) await send(handleRequest, gh, report(avplayAt(stage, "PLAYER_ERROR_GENERIC"), "auto"));
      const titles = gh.created().map((call) => call.body.title);
      equal(titles[0], "Player could not open the stream: PLAYER_ERROR_GENERIC", "open title");
      equal(titles[1], "Player could not prepare the stream: PLAYER_ERROR_GENERIC", "prepare title");
      equal(titles[2], "Player could not begin playback: PLAYER_ERROR_GENERIC", "play title");
      equal(gh.issues.length, 3, "three issues");
      const unknown = fakeGitHub();
      const result = await send(handleRequest, unknown, report({ ...avplayAt("avplay_prepare", "PLAYER_ERROR_GENERIC"), stage: "transmogrify" }, "auto"));
      equal(result.status, 201, "unknown stage still creates an issue");
      const fallback = unknown.created()[0].body;
      equal(fallback.title, "Playback problem reported", "unknown stage falls back");
      includes(fallback.body, "| First failed stage | Not reported |", "unknown stage not rendered");
    },
  },
  {
    name: "the first failure groups; a differing final AVPlay code is recorded on the same issue, a differing first code files separately",
    async run(handleRequest) {
      const gh = fakeGitHub();
      await send(handleRequest, gh, report(avplayAt("avplay_prepare", "PLAYER_ERROR_NOT_SUPPORTED_FORMAT", "PLAYER_ERROR_CONNECTION_FAILED"), "auto"));
      const first = gh.created()[0].body;
      equal(first.title, "Player could not prepare the stream: PLAYER_ERROR_NOT_SUPPORTED_FORMAT", "title names the first failure");
      includes(first.body, "| First AVPlay error | PLAYER_ERROR_NOT_SUPPORTED_FORMAT |", "first code");
      includes(first.body, "| Last AVPlay error | PLAYER_ERROR_CONNECTION_FAILED |", "last code");
      includes(first.body, "| Final code | PLAYER_ERROR_CONNECTION_FAILED |", "final code");
      includes(first.body, "| Route fallbacks | 2 |", "fallbacks");
      includes(first.body, "| Recovery | Exhausted |", "recovery");
      const sameFirst = await send(handleRequest, gh, report(avplayAt("avplay_prepare", "PLAYER_ERROR_NOT_SUPPORTED_FORMAT", "PLAYER_ERROR_INVALID_STATE"), "auto"));
      equal(sameFirst.json.status, "updated", "same first failure updates the issue");
      includes(gh.comments()[0].body.body, "**Final code:** `PLAYER_ERROR_CONNECTION_FAILED` → `PLAYER_ERROR_INVALID_STATE`", "final code change");
      equal((await send(handleRequest, gh, report(avplayAt("avplay_prepare", "PLAYER_ERROR_CONNECTION_FAILED"), "auto"))).status, 201, "different first code files separately");
      equal(gh.issues.length, 2, "two issues");
    },
  },
  {
    name: "a different source plan keeps its codec, range and resolution in the follow-up",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const prior = cappedHlsBeforeOpen;
      await send(handleRequest, gh, report(prior, "auto"));
      const pl = { ...prior.pl, vc: "h.264", res: "1920x1080", dr: "hdr10plus", pr: "https", ct: "mp4", q: "1080p", kbps: 12000 };
      const next = report({ ...prior, pl }, "manual");
      equal((await send(handleRequest, gh, next)).json.status, "updated", "source-only change");
      const body = gh.comments()[0].body.body;
      for (const [label, from, to] of [
        ["Video codec", "hevc", "h.264"], ["Resolution", "3840x2160", "1920x1080"], ["Dynamic range", "hdr10", "hdr10plus"],
        ["Protocol", "hls", "https"], ["Container", "hls", "mp4"], ["Stream quality", "720p", "1080p"], ["Source bitrate (kbps)", "24000", "12000"],
      ]) includes(body, `**${label}:** \`${from}\` → \`${to}\``, label);
      equal((await send(handleRequest, gh, next)).json.status, "duplicate", "same evidence");
    },
  },
  {
    name: "intermediate AVPlay exceptions retain the method and exception name",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const base = avplayAt("avplay_prepare", "PLAYER_ERROR_NOT_SUPPORTED_FORMAT");
      const inc = { ...base, t: [...base.t, "avplay_prepare:fallback:prepareAsync:InvalidAccessError"] };
      await send(handleRequest, gh, report(inc, "auto"));
      includes(gh.created()[0].body.body, "fallback · prepareAsync:InvalidAccessError", "full exception in event sequence");
    },
  },
  {
    name: "a changed device or server updates the same incident once",
    async run(handleRequest) {
      const gh = fakeGitHub();
      await send(handleRequest, gh, report(sessionExpiredAtStart, "auto"));
      const next = report(sessionExpiredAtStart, "manual", { fw: "1660", srv: "413" });
      equal((await send(handleRequest, gh, next)).json.status, "updated", "environment-only change");
      const comment = gh.comments()[0].body.body;
      includes(comment, "**Firmware:** `1650` → `1660`", "firmware change");
      includes(comment, "**Silo server:** `412` → `413`", "server change");
      equal((await send(handleRequest, gh, next)).json.status, "duplicate", "repeat delivery");
      equal(gh.issues.length, 1, "same issue");
      equal(gh.comments().length, 1, "one follow-up");
    },
  },
  {
    name: "recovered, refused, interrupted and network outcomes stay manual: automatic sends are rejected without touching GitHub",
    async run(handleRequest) {
      const recovered = { ...avplayAt("avplay_prepare", "PLAYER_ERROR_CONNECTION_FAILED"), out: "recovered", kind: undefined, fs: undefined, fc: undefined, rec: { n: 1, c: 0, r: "recovered" } };
      const refused = { ...sessionExpiredAtStart, out: "refused", code: "version_unavailable", fc: "version_unavailable", dec: undefined };
      const interrupted = { ...missingSession404, out: "interrupted", kind: "backgrounded", code: "backgrounded", fc: "backgrounded", http: undefined };
      const network = { ...missingSession404, kind: "network", code: "network_unreachable", fc: "network_unreachable", http: undefined };
      const automatic = fakeGitHub();
      for (const inc of [recovered, refused, interrupted, network]) {
        const rejected = await send(handleRequest, automatic, report(inc, "auto"));
        equal(rejected.status, 422, `${inc.out}/${inc.kind} automatic rejected`);
        equal(rejected.json.error, "not_auto_reportable", "error code");
      }
      const legacyFlagOnly = { ...report(recovered, "manual"), auto: true };
      equal((await send(handleRequest, automatic, legacyFlagOnly)).status, 422, "legacy auto flag alone also counts as automatic");
      equal(automatic.outbound.length, 0, "no GitHub writes for rejected automatic sends");
      const exhausted = { ...network, rec: { n: 1, c: 1, r: "exhausted" } };
      equal((await send(handleRequest, automatic, report(exhausted, "auto"))).status, 201, "exhausted network recovery files");

      const manual = fakeGitHub();
      for (const inc of [recovered, refused, interrupted, network]) equal((await send(handleRequest, manual, report(inc, "manual"))).status, 201, `${inc.out} manual files`);
      const titles = manual.created().map((call) => call.body.title);
      equal(titles[0], "Player could not prepare the stream: PLAYER_ERROR_CONNECTION_FAILED, then recovered", "recovered title");
      equal(titles[1], "Playback start refused: selected version unavailable", "refusal title");
      equal(titles[2], "Playback stopped when Auger was backgrounded", "interrupted title");
      equal(titles[3], "Playback progress report failed: network unreachable", "network title");
      includes(manual.created()[0].body.body, "| Outcome | Recovered |", "recovered outcome row");
      includes(manual.created()[0].body.body, "| Final stage | Recovered |", "no final failure for a recovery");
    },
  },
  {
    name: "each incident category: manual and automatic render identical titles and evidence in separate destinations, and one issue in a shared one",
    async run(handleRequest) {
      for (const inc of [sessionExpiredAtStart, missingSession404, bufferingOwned]) {
        const label = `${inc.cat}/${inc.stage}`;
        const manualOnly = fakeGitHub();
        const automaticOnly = fakeGitHub();
        await send(handleRequest, manualOnly, report(inc, "manual"));
        await send(handleRequest, automaticOnly, report(inc, "auto"));
        const manual = manualOnly.created()[0].body;
        const automatic = automaticOnly.created()[0].body;
        equal(manual.title, automatic.title, `${label} titles`);
        equal(withoutSourceRow(manual.body), withoutSourceRow(automatic.body), `${label} evidence`);
        includes(manual.body, "| Submission source | Manual |", `${label} manual source`);
        includes(automatic.body, "| Submission source | Automatic error report |", `${label} automatic source`);

        const shared = fakeGitHub();
        equal((await send(handleRequest, shared, report(inc, "auto"))).json.status, "created", `${label} shared first`);
        equal((await send(handleRequest, shared, report(inc, "manual"))).json.status, "duplicate", `${label} shared second`);
        equal((await send(handleRequest, shared, report(inc, "manual"))).json.status, "duplicate", `${label} repeat delivery`);
        equal(shared.issues.length, 1, `${label} one issue`);
        equal(shared.outbound.length, 1, `${label} no follow-up noise`);
      }
    },
  },
  {
    name: "Buffering / Quality owns a failed quality replan: a later Playback failed selection keeps its grouping; an unrelated failure files",
    async run(handleRequest) {
      const gh = fakeGitHub();
      await send(handleRequest, gh, report(bufferingOwned, "auto"));
      const issue = gh.created()[0].body;
      equal(issue.title, "Playback stalled after a quality step-down: PLAYER_ERROR_CONNECTION_FAILED", "buffering title");
      includes(issue.body, "| Category | Buffering / Quality |", "canonical category");
      includes(issue.body, "| HDR panel capability | Unknown on this TV |", "unknown panel capability");
      includes(issue.body, "| Position at failure | 30:20 |", "position at failure");
      // The client sends the frozen buffering record for a manual Playback failed selection.
      equal((await send(handleRequest, gh, report(bufferingOwned, "manual"))).json.status, "duplicate", "manual selection joins the buffering issue");
      const terminal = { ...bufferingOwned, fs: "playing", fc: "PLAYER_ERROR_INVALID_STATE", t: [...bufferingOwned.t, "playing:fail:PLAYER_ERROR_INVALID_STATE"] };
      equal((await send(handleRequest, gh, report(terminal, "auto"))).json.status, "updated", "later terminal outcome recorded once");
      includes(gh.comments()[0].body.body, "PLAYER_ERROR_INVALID_STATE", "terminal outcome in comment");
      equal(gh.issues.length, 1, "one buffering issue");
      equal((await send(handleRequest, gh, report(avplayAt("avplay_prepare", "PLAYER_ERROR_NOT_SUPPORTED_FORMAT"), "auto"))).status, 201, "unrelated playback failure files");
    },
  },
  {
    name: "viewer-observed reports group by category and allowlisted preceding screen; raw routes never render",
    async run(handleRequest) {
      const observed = (screen, cat = "app_ui") => ({ ...device, cat, ...(screen === undefined ? {} : { precedingScreen: screen }) });
      const gh = fakeGitHub();
      equal((await send(handleRequest, gh, observed("home"))).status, 201, "home created");
      equal((await send(handleRequest, gh, observed("home"))).json.status, "duplicate", "same screen groups");
      equal((await send(handleRequest, gh, observed("watchParty"))).status, 201, "different screen files");
      equal((await send(handleRequest, gh, observed("/details/SYNTH_TITLE?id=SYNTH_PROFILE"))).status, 201, "raw route accepted without the route");
      const [home, party, raw] = gh.created().map((call) => call.body);
      equal(home.title, "Viewer reported a navigation problem on Home", "home title");
      equal(party.title, "Viewer reported a navigation problem on Watch Party", "watch party title");
      equal(raw.title, "Viewer reported a navigation problem", "unknown screen falls back to the category");
      includes(home.body, "| Screen before Settings | Home |", "screen row");
      includes(home.body, "| Report type | Viewer-observed symptom (no failure detected) |", "report type");
      includes(home.body, "<!-- auger-group:obs1:", "observed marker");
      assertNoSensitive(gh, "observed outbound");
    },
  },
  {
    name: "titles stay plain: no bracketed prefix, no model, within 140 characters",
    async run(handleRequest) {
      const gh = fakeGitHub();
      for (const inc of [sessionExpiredAtStart, missingSession404, cappedHlsBeforeOpen, bufferingOwned, avplayAt("avplay_seek", "seekTo:InvalidStateError")]) {
        await send(handleRequest, gh, report(inc, "manual"));
      }
      for (const call of gh.created()) {
        const title = call.body.title;
        check(!title.startsWith("["), `bracketed prefix: ${title}`);
        excludes(title, TV, "model in title");
        check(title.length <= 140, `title length ${title.length}`);
      }
      equal(gh.created()[4].body.title, "Player could not seek to the start position: seekTo:InvalidStateError", "seek title");
    },
  },
  {
    name: "direct input with client sanitization bypassed: unknown fields, synthetic markers and oversized values never reach titles, bodies, comments or metadata",
    async run(handleRequest) {
      const hostileInc = {
        ...sessionExpiredAtStart,
        dec: undefined,
        kind: "SYNTH_TITLE",
        src: "SYNTHSTACK",
        code: "synth_title_the_movie",
        fc: "SYNTH_TITLE",
        http: 9999,
        rs: 9999,
        av: { f: "PLAYER_ERROR_SYNTHTOKEN", l: "open:SYNTHSTACK" },
        rec: { n: 1e6, c: 1, r: "SYNTH" },
        pl: { dl: "original_http", pr: "synth-nas.local", ct: "SYNTH_PATH", q: "synth_profile", res: "SYNTH", dr: "synthssid", pos: -1, at: 754 },
        set: { q: "synthssid", cap: "SYNTH", hdr: "yes" },
        hp: "SYNTHSSID",
        req: { pos: "SYNTH", sub: "SYNTH_SUBTITLE", aud: "track" },
        t: ["start:fail:synth_title_the_movie", "SYNTHSTACK:fail", "start:end:/media/SYNTH_PATH", "start:retry:http_503"],
        title: "SYNTH_TITLE The Movie",
        url: "https://synthetic.example.invalid/x?token=SYNTHTOKEN",
        profileId: "SYNTH_PROFILE_1",
        message: "Bearer SYNTHBEARER",
      };
      const hostile = {
        ...device,
        tv: "SYNTHSERIAL0123456789",
        fw: "SYNTHSERIAL0123456789",
        srv: "192.0.2.77",
        ua: "Mozilla SYNTHTOKEN",
        precedingScreen: "SYNTH_TITLE",
        mac: "AA:BB:CC:DD:EE:FF",
        play: { m: "Direct play · SYNTH_TITLE", a: "English · SYNTH_TRACK Commentary", s: "SYNTH_SUBTITLE", n: ["SYNTH_TITLE"] },
        log: ["01:00:00 [network] GET https://synthetic.example.invalid/?token=SYNTHTOKEN from 192.0.2.77"],
        inc: hostileInc,
      };
      const gh = fakeGitHub();
      equal((await send(handleRequest, gh, hostile)).status, 201, "accepted with unsafe values dropped");
      const { title, body } = gh.created()[0].body;
      equal(title, "Playback start failed", "unlisted code never reaches the title");
      includes(body, "| First failure code | Unlisted code |", "unlisted code named without its text");
      includes(body, "| Last AVPlay error | open:error |", "unknown exception name collapses");
      includes(body, "| HTTP status | Not observed |", "out-of-range status dropped");
      includes(body, "3. Playback start request · retry · http_503", "valid step kept after invalid steps are dropped");
      includes(body, "| Position at failure | 12:34 |", "valid plan field kept");
      await send(handleRequest, gh, { ...hostile, inc: { ...hostileInc, rs: 3 } });
      equal(gh.comments().length, 1, "follow-up comment produced for inspection");
      assertNoSensitive(gh, "incident outbound");

      const rejected = fakeGitHub();
      const badCategory = await send(handleRequest, rejected, { ...hostile, inc: { ...hostileInc, cat: "SYNTH_TITLE" } });
      equal(badCategory.status, 400, "invalid required incident field rejected");
      equal(JSON.stringify(badCategory.json.fields), JSON.stringify(["inc.cat"]), "rejected field named");
      equal((await send(handleRequest, rejected, { ...hostile, inc: [hostileInc] })).status, 400, "non-object incident rejected");
      equal((await send(handleRequest, rejected, { ...hostile, inc: { ...hostileInc, iv: 2 } })).status, 400, "unknown incident version rejected");
      equal((await send(handleRequest, rejected, { ...hostile, v: 2 })).status, 400, "unknown payload version rejected");
      const oversized = await send(handleRequest, rejected, JSON.stringify({ ...hostile, padding: "y".repeat(9000) }));
      equal(oversized.status, 413, "oversized body rejected");
      equal(rejected.outbound.length, 0, "no GitHub writes for rejected reports");
    },
  },
  {
    name: "legacy client input with sanitization bypassed: free text is discarded field by field, including comments and metadata",
    async run(handleRequest) {
      const legacyHostile = {
        v: 1,
        app: "0.4.0",
        tv: TV,
        cat: "playback",
        fw: "SYNTHSERIAL0123456789",
        os: "Tizen 8.0 synth-nas.local",
        ua: "Mozilla SYNTHTOKEN",
        srv: "synth-nas.local:8096",
        mem: "SYNTH_PROFILE",
        title: "SYNTH_TITLE",
        play: {
          m: "Direct play · SYNTH_TITLE",
          v: "HEVC · SYNTH_TITLE",
          a: "English · SYNTH_TRACK Commentary",
          s: "SYNTH_SUBTITLE track",
          src: "MKV · /media/SYNTH_PATH/movie.mkv",
          tr: "HLS · SYNTHTOKEN",
          sub: "burn_in · embedded SYNTHTOKEN (burn_in_only)",
          pos: "SYNTHSTACK",
          n: ["Decision for SYNTH_TITLE"],
          e: "playback_failed: SYNTH_TITLE",
          av: "open:SYNTHSTACK",
          x: "SYNTH_PROFILE",
        },
        log: [
          "01:00:00 [network] GET https://synthetic.example.invalid/?token=SYNTHTOKEN from 192.0.2.77",
          "01:00:01 [app] profile SYNTH_PROFILE selected",
          "01:00:02 [playback] error playback_failed: SYNTH_TITLE (PLAYER_ERROR_NOT_SUPPORTED_FORMAT)",
          "01:00:03 [playback] plan Direct play · MKV (Original HTTP) SYNTH_TITLE",
          "01:00:04 [playback] avplay PLAYER_ERROR_SYNTHTOKEN",
          "01:00:05 [playback] avplay PLAYER_ERROR_NOT_SUPPORTED_FORMAT (fallback #1)",
          "01:00:06 [playback] error terminal: synth_title_the_movie",
          `01:00:07 [playback] ${"z".repeat(5000)}`,
        ],
      };
      const gh = fakeGitHub();
      equal((await send(handleRequest, gh, legacyHostile)).status, 201, "legacy accepted");
      const issue = gh.created()[0].body;
      equal(issue.title, "Playback failed on every offered route: open:error", "legacy title from recognized evidence");
      includes(issue.body, "01:00:05 [playback] avplay PLAYER_ERROR_NOT_SUPPORTED_FORMAT (fallback #1)", "recognized AVPlay line kept");
      await send(handleRequest, gh, { ...legacyHostile, fw: "1661" });
      equal(gh.comments().length, 1, "legacy follow-up produced for inspection");
      assertNoSensitive(gh, "legacy outbound");
    },
  },
  {
    name: "valid legacy report stays useful (positive control) and keeps the deployed fingerprint",
    async run(handleRequest) {
      const legacy = {
        v: 1,
        app: "0.4.0",
        tv: TV,
        cat: "playback",
        auto: true,
        fw: "1650",
        os: "Tizen 9.0",
        ua: "Chrome/120.0.6099.5",
        hdr: true,
        srv: "412",
        mem: "48 / 96 MB (limit 512 MB)",
        ram: "4 GB",
        scr: "3840x2160",
        up: 12,
        play: {
          m: "Direct play · MKV",
          d: "Original HTTP",
          st: "Failed",
          src: "MKV · HEVC 3840x2160 23.98fps · HDR10 · 24.0 Mbps · 2:00:00 (~21.1 GB)",
          tr: "HTTP · MKV",
          sub: "burn_in · embedded ASS (burn_in_only)",
          pos: "0:15 / 1:00:00",
          hdr: true,
          av: "PLAYER_ERROR_NOT_SUPPORTED_FORMAT",
          fb: 2,
          e: "playback_failed",
        },
        log: [
          "03:00:00 [playback] plan Direct play · MKV (Original HTTP) HEVC · 3840×2160 · 23.976 fps",
          "03:00:01 [playback] avplay PLAYER_ERROR_NOT_SUPPORTED_FORMAT (fallback #1)",
          "03:00:02 [playback] error playback_failed (PLAYER_ERROR_NOT_SUPPORTED_FORMAT)",
        ],
      };
      const gh = fakeGitHub();
      await send(handleRequest, gh, legacy);
      const issue = gh.created()[0].body;
      equal(issue.title, "Playback failed on every offered route: PLAYER_ERROR_NOT_SUPPORTED_FORMAT", "legacy title");
      for (const fragment of [
        "| Report source | Automatic error report |",
        "| Last error | playback_failed |",
        "| AVPlay error | PLAYER_ERROR_NOT_SUPPORTED_FORMAT |",
        "| Route fallbacks | 2 |",
        "| Playback | Direct play · MKV |",
        "| Delivery | Original HTTP |",
        `| Source file | ${legacy.play.src} |`,
        "| Stream | HTTP · MKV |",
        "| Subtitle mode | burn_in · embedded ASS (burn_in_only) |",
        "| Position | 0:15 / 1:00:00 |",
        "| HDR setting | On |",
        "| HDR TV support | Yes |",
        "Firmware 1650",
        "Tizen 9.0",
        "| JS heap | 48 / 96 MB (limit 512 MB) |",
        ...legacy.log,
        `<!-- auger-fp:${deployedLegacyFingerprint("0.4.0", TV, "playback_failed:PLAYER_ERROR_NOT_SUPPORTED_FORMAT")} -->`,
      ]) includes(issue.body, fragment, "legacy body");
      check(issue.body.indexOf("### Recent Events") < issue.body.indexOf("### Device"), "events before device context");
      const insufficient = fakeGitHub();
      await send(handleRequest, insufficient, { v: 1, app: "0.4.0", tv: TV });
      await send(handleRequest, insufficient, { v: 1, app: "0.4.0", tv: TV, cat: "playback" });
      await send(handleRequest, insufficient, { v: 1, app: "0.4.0", tv: TV, auto: true, play: { st: "Failed", m: "Direct play · MKV" } });
      equal(insufficient.created()[0].body.title, "TV diagnostic report received", "no evidence");
      equal(insufficient.created()[1].body.title, "Viewer reported a playback problem", "category only");
      equal(insufficient.created()[2].body.title, "Playback problem reported", "automatic legacy without evidence");
    },
  },
  {
    name: "legacy client finds its existing issue by the original marker after a title edit, without republishing old free text",
    async run(handleRequest) {
      const signature = "playback_failed";
      const oldState = {
        fw: "1640",
        cat: "playback",
        m: "Direct play · SYNTH_TITLE",
        a: "English · SYNTH_TRACK",
        s: "SYNTH_SUBTITLE",
        n: ["SYNTH_TITLE decision"],
        e: signature,
        log: ["[playback] avplay PLAYER_ERROR_NOT_SUPPORTED_FORMAT (fallback #1)"],
      };
      const seeded = {
        number: 500,
        title: "Maintainer-edited title for an S95C playback failure",
        body: `## Diagnostics Report (Sent from Auger TV)\n\n<!-- auger-fp:${deployedLegacyFingerprint("0.4.0", TV, signature)} -->\n<!-- auger-hash:00000000 -->\n<!-- auger-state:${encodeState(oldState)} -->`,
      };
      const gh = fakeGitHub([seeded]);
      const result = await send(handleRequest, gh, { v: 1, app: "0.4.0", tv: TV, cat: "playback", fw: "1650", play: { m: "Direct play · MKV", e: signature } });
      equal(result.json.status, "updated", "matched by legacy marker");
      equal(result.json.issueNumber, 500, "seeded issue");
      equal(gh.created().length, 0, "no new issue");
      check(gh.outbound.every((call) => call.method === "POST" && call.url.endsWith("/issues/500/comments")), "only a comment; title and body untouched");
      const comment = gh.comments()[0].body.body;
      includes(comment, "**Firmware:** `1640` → `1650`", "allowlisted previous value republished");
      includes(comment, "**Playback:** `earlier value` → `Direct play · MKV`", "unrecognized previous value withheld");
      assertNoSensitive(gh, "legacy follow-up");
      equal(gh.issues[0].title, seeded.title, "title untouched");
    },
  },
  {
    name: "an incident reuses a legacy issue only when that issue's recorded evidence identifies the same failure",
    async run(handleRequest) {
      const terminalFp = deployedLegacyFingerprint(APP, TV, "terminal: session_expired");
      const seed = (number, state, fp = terminalFp) => ({ number, title: `legacy ${number}`, body: `<!-- auger-fp:${fp} -->\n<!-- auger-state:${encodeState(state)} -->` });

      const clean = fakeGitHub([seed(600, { e: "terminal: session_expired", log: ["[app] error TypeError"] })]);
      const reused = await send(handleRequest, clean, report(sessionExpiredAtStart, "auto"));
      equal(reused.json.status, "updated", "unambiguous legacy evidence reused");
      equal(reused.json.issueNumber, 600, "legacy issue");
      includes(clean.comments()[0].body.body, "| First failure code | session_expired |", "incident evidence in comment");
      includes(clean.comments()[0].body.body, "Incident record from a current Auger client", "format noted");

      const replanned = fakeGitHub([seed(601, { e: "terminal: session_expired", log: ["[playback] plan Direct play · MKV (Original HTTP)"] })]);
      equal((await send(handleRequest, replanned, report(sessionExpiredAtStart, "auto"))).status, 201, "legacy evidence of a running stream is ambiguous");

      const reversed = fakeGitHub();
      await send(handleRequest, reversed, report(sessionExpiredAtStart, "auto"));
      const ambiguous = { v: 1, app: APP, tv: TV, play: { e: "terminal: session_expired" }, log: ["01:00:00 [playback] plan Direct play · MKV (Original HTTP)"] };
      equal((await send(handleRequest, reversed, ambiguous)).status, 201, "an ambiguous legacy report stays separate when it arrives second");

      const localized = { ...ambiguous, log: ["01:00:00 [playback] plan Direktwiedergabe · MKV"] };
      for (const legacyFirst of [true, false]) {
        const destination = fakeGitHub();
        const current = report(sessionExpiredAtStart, "auto");
        const sequence = legacyFirst ? [localized, current] : [current, localized];
        for (const payload of sequence) equal((await send(handleRequest, destination, payload)).status, 201, "localized plan evidence keeps the issues separate");
        check(!JSON.stringify(destination.created()).includes("Direktwiedergabe"), "localized text stays private");
      }

      const missingState = fakeGitHub([{ number: 602, title: "legacy", body: `<!-- auger-fp:${terminalFp} -->` }]);
      equal((await send(handleRequest, missingState, report(sessionExpiredAtStart, "auto"))).status, 201, "legacy issue without evidence is ambiguous");

      const generic = fakeGitHub([seed(603, { e: "playback_failed" }, deployedLegacyFingerprint(APP, TV, "playback_failed"))]);
      equal((await send(handleRequest, generic, report(avplayAt("avplay_prepare", "prepareAsync:NotSupportedError"), "auto"))).status, 201, "generic playback_failed never absorbs a staged incident");

      const stagedFp = deployedLegacyFingerprint(APP, TV, "playback_failed:prepareAsync:NotSupportedError");
      const stagedState = { e: "playback_failed", av: "prepareAsync:NotSupportedError", log: ["[playback] avplay prepareAsync:NotSupportedError (fallback #1)"] };
      const staged = fakeGitHub([seed(604, stagedState, stagedFp)]);
      equal((await send(handleRequest, staged, report(avplayAt("avplay_prepare", "prepareAsync:NotSupportedError"), "auto"))).json.issueNumber, 604, "staged AVPlay legacy issue reused");
      const differing = fakeGitHub([seed(605, stagedState, stagedFp)]);
      equal((await send(handleRequest, differing, report(avplayAt("avplay_prepare", "prepareAsync:NotSupportedError", "PLAYER_ERROR_CONNECTION_FAILED"), "auto"))).status, 201, "differing first/final codes stay separate");

      const bare = fakeGitHub([seed(606, { e: "session_expired" }, deployedLegacyFingerprint(APP, TV, "session_expired"))]);
      equal((await send(handleRequest, bare, report(sessionMissing, "auto"))).status, 201, "bare legacy session_expired stays separate");
    },
  },
  {
    name: "concurrent equivalent legacy and current reports create one issue",
    async run(handleRequest) {
      const legacy = { v: 1, app: APP, tv: TV, play: { e: "terminal: session_expired" } };
      const current = report(sessionExpiredAtStart, "auto");
      for (const pair of [[legacy, current], [current, legacy]]) {
        const gh = fakeGitHub();
        const results = await Promise.all(pair.map(payload => send(handleRequest, gh, payload)));
        equal(gh.created().length, 1, "one creation");
        equal(results[0].json.issueNumber, results[1].json.issueNumber, "same destination");
      }
    },
  },
  {
    name: "an exact incident wins over a verified legacy match on an earlier page",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const current = report(sessionExpiredAtStart, "auto");
      const legacy = { v: 1, app: APP, tv: TV, play: { e: "terminal: session_expired" } };
      const legacyGh = fakeGitHub();
      await send(handleRequest, legacyGh, legacy);
      const created = await send(handleRequest, gh, current);
      gh.issues.push({ ...legacyGh.issues[0], number: 901 });
      let unavailable = false;
      const destination = { fetch: async (url, init) => {
        if (url.endsWith("&page=2")) {
          return unavailable ? new Response(null, { status: 503 }) : new Response(JSON.stringify(gh.issues));
        }
        if (url.includes("?state=open")) {
          return new Response(JSON.stringify([gh.issues.find(issue => issue.number === 901)]), {
            headers: { Link: `<${url}&page=2>; rel="next"` },
          });
        }
        return gh.fetch(url, init);
      } };
      const next = { ...current, fw: "1660" };
      const updated = await send(handleRequest, destination, next);
      equal(updated.json.status, "updated", "updated exact match");
      equal(updated.json.issueNumber, created.json.issueNumber, "preferred current issue");
      unavailable = true;
      const fallback = await send(handleRequest, destination, { ...next, fw: "1670" });
      equal(fallback.json.issueNumber, 901, "verified legacy issue used when the next page is unavailable");
      equal(fallback.json.status, "updated", "follow-up reached the verified issue");
      const noMatch = await send(handleRequest, destination, report(cappedHlsBeforeOpen, "auto"));
      equal(noMatch.status, 502, "incomplete lookup without a verified match remains an error");
    },
  },
  {
    name: "collision guard: a marker hit whose embedded evidence names a different failure is not reused",
    async run(handleRequest) {
      const key = ["playback", "start_playback", "start", "session_expired"];
      const groupMarker = `<!-- auger-group:inc1:${incidentGroupId(APP, TV, sessionExpiredAtStart)} -->`;
      const guard = fnv(["guard", APP, TV, ...key].join("\n"));
      const collided = fakeGitHub([{ number: 700, title: "other", body: `${groupMarker}\n<!-- auger-state:inc1:${encodeState({ gk: "00000000" })} -->` }]);
      equal((await send(handleRequest, collided, report(sessionExpiredAtStart, "auto"))).status, 201, "incident collision files separately");

      const same = fakeGitHub([{ number: 701, title: "same", body: `${groupMarker}\n<!-- auger-state:inc1:${encodeState({ gk: guard })} -->` }]);
      equal((await send(handleRequest, same, report(sessionExpiredAtStart, "auto"))).json.issueNumber, 701, "verified incident marker reused");

      const legacyFp = deployedLegacyFingerprint("0.4.0", TV, "network");
      const legacyCollision = fakeGitHub([{ number: 702, title: "legacy", body: `<!-- auger-fp:${legacyFp} -->\n<!-- auger-state:${encodeState({ e: "playback_failed" })} -->` }]);
      equal((await send(handleRequest, legacyCollision, { v: 1, app: "0.4.0", tv: TV, play: { e: "network" } })).status, 201, "legacy collision files separately");
    },
  },
];

/** Runs every case (or the named subset) and returns per-case results; never throws. */
export async function runRelayCases(handleRequest, names) {
  const results = [];
  for (const entry of CASES) {
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
