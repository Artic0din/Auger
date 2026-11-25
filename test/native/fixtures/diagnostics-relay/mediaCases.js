// Relay cases for #874 (Audio / Subtitles) against the client wire contract: `inc` as mediaIncident() serializes it and
// `md` as publicMediaEvidence() does (src/diagnosticsIncident.ts). Plain ES module with no Node imports, so the TV harness
// runs these with the playback cases through runRelayCases(handleRequest). Every case builds fresh fake destinations.

import { assertNoSensitive, check, equal, excludes, includes } from "./assertions.js";
import { fakeGitHub, incidentGroupId, send } from "./fakeGitHub.js";

const APP = "0.5.0";
const TV = "QE65S95C";
const device = { v: 1, app: APP, tv: TV, fw: "1650", os: "Tizen 9.0", ua: "Chrome/120.0.6099.5", hdr: true, srv: "412" };

function report(inc, source, md, extra = {}) {
  return { ...device, cat: inc.cat, ...(source === "auto" ? { auto: true } : {}), ...extra, md, inc: { ...inc, src: source } };
}

/** A viewer-observed report: no incident, the selected category and the screen before Settings. */
function observed(md, extra = {}) {
  return { ...device, cat: "audio_subtitles", precedingScreen: "details", md, ...extra };
}

const withoutSourceRow = (body) => body.split("\n").filter((line) => !line.startsWith("| Submission source |")).join("\n");

// ---------------------------------------------------------------------------
// Media records, shaped as publicMediaEvidence() serializes them
// ---------------------------------------------------------------------------

const audio = { lang: "en", src: { c: "eac3", ch: 6 }, pl: { c: "aac", ch: 2 }, obs: { c: "eac3", ch: 6 } };

/** Overlay subtitles whose file loaded `cues` cues; zero is an observed count. */
export const overlayLoaded = (cues) => ({
  mv: 1, a: audio,
  s: { mode: "render", src: "external", c: "subrip", dl: "sidecar", lang: "en", f: false, hi: false, via: "overlay", ld: "loaded", cues, sync: 250, sec: false },
});

/** The shown embedded track's file failed and nothing drew it. */
export const captionFailedMedia = {
  mv: 1, a: audio,
  s: { mode: "render", src: "embedded", c: "subrip", dl: "sidecar", lang: "nl", f: false, hi: false, via: "overlay", ld: "failed", sync: 0, sec: false },
};

/** The file failed and AVPlay drew the embedded track instead. */
export const captionFallbackMedia = {
  mv: 1, a: audio,
  s: { mode: "render", src: "embedded", c: "subrip", dl: "sidecar", lang: "nl", f: false, hi: false, via: "avplay", ld: "fallback", sec: false },
};

/** Subtitles Off, with AVPlay's audio report unavailable and no recipe in the plan. */
export const subtitlesOffMedia = {
  mv: 1, a: { lang: "en", src: { c: "eac3", ch: 6 }, pl: "unavailable", obs: "unavailable" },
  s: { mode: "off", via: "none", ld: "not_needed", sec: false },
};

const withSwitch = (md, k, r, code) => ({ ...md, sw: { k, r, ...(code === undefined ? {} : { code }) } });

// ---------------------------------------------------------------------------
// Incidents, shaped as mediaIncident() serializes them
// ---------------------------------------------------------------------------

const playingPlan = { dl: "original_http", pr: "http", ct: "mkv", q: "original", kbps: 24000, vc: "hevc", res: "3840x2160", dr: "hdr10", pos: 0, at: 754 };
const context = {
  iv: 1, cat: "audio_subtitles", done: "playing", open: true, shown: true, rs: 0, pl: playingPlan,
  set: { q: "auto", cap: "none", hdr: true }, hp: { h10: true, hlg: true, dv: false }, req: { pos: "none", sub: "track", aud: "default" },
};
const settled = (stage, out, code, extra = {}) => ({
  ...context, out, op: stage === "caption_load" ? "subtitle_download" : "replan_playback", stage, code, fs: stage, fc: code,
  rec: { n: 0, c: 0, r: "none" }, t: ["playing:ok", `${stage}:${out === "refused" ? "refused" : "fail"}:${code}`], ...extra,
});

export const captionLoadFailed = settled("caption_load", "failed", "caption_load_failed");
export const captionLoadRecovered = {
  ...context, out: "recovered", op: "subtitle_download", stage: "caption_load", code: "caption_load_failed",
  rec: { n: 0, c: 0, r: "recovered" }, t: ["playing:ok", "caption_load:fallback:caption_load_failed"],
};
export const audioSwitchFailed = settled("audio_switch", "failed", "http_500", { http: 500, req: { ...context.req, aud: "default" } });
export const subtitleSwitchFailed = settled("subtitle_switch", "failed", "http_409", { http: 409 });
export const subtitleSwitchRefused = settled("subtitle_switch", "refused", "subtitle_selection_unavailable");
export const subtitleSwitchUnanswered = settled("subtitle_switch", "failed", "no_answer", { kind: "network" });

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const MEDIA_CASES = [
  {
    name: "#874 caption load failure: automatic and manual render the same evidence; one shared destination files one issue",
    async run(handleRequest) {
      const media = withSwitch(captionFailedMedia, "subtitle", "ok");
      const auto = fakeGitHub();
      const manual = fakeGitHub();
      equal((await send(handleRequest, auto, report(captionLoadFailed, "auto", media))).status, 201, "automatic created");
      equal((await send(handleRequest, manual, report(captionLoadFailed, "manual", media))).status, 201, "manual created");
      const [autoIssue] = auto.created().map((call) => call.body);
      const [manualIssue] = manual.created().map((call) => call.body);
      equal(autoIssue.title, "Subtitles failed to load during playback", "caption title");
      equal(manualIssue.title, autoIssue.title, "same title from both entry points");
      equal(withoutSourceRow(manualIssue.body), withoutSourceRow(autoIssue.body), "same technical evidence");
      includes(autoIssue.body, "| Submission source | Automatic error report |", "automatic source");
      includes(manualIssue.body, "| Submission source | Manual |", "manual source");
      for (const row of [
        "| Category | Audio / Subtitles |",
        "| Outcome | Failed |",
        "| Operation | Subtitle download |",
        "| First failed stage | Subtitle file load |",
        "| First failure code | caption_load_failed |",
        "| Recovery | None attempted |",
        "| Audio source (file) | eac3 · 6 ch |",
        "| Audio output (planned by server) | aac · 2 ch |",
        "| Audio stream reported by AVPlay | eac3 · 6 ch |",
        "| Subtitle track | embedded · subrip · sidecar · nl |",
        "| Subtitles drawn by | Auger caption overlay |",
        "| Subtitle file load | Failed |",
        "| Subtitle cues loaded | Not observed |",
        "| Requested switch | Subtitle · Succeeded |",
        "2. Subtitle file load · fail · caption_load_failed",
        `<!-- auger-group:inc1:${incidentGroupId(APP, TV, captionLoadFailed)} -->`,
      ]) includes(autoIssue.body, row, "caption body");
      check(autoIssue.body.indexOf("### Audio and subtitles") < autoIssue.body.indexOf("### Device"), "audio and subtitles render before device context");
      equal(JSON.stringify(autoIssue.labels), JSON.stringify(["diagnostics", "needs-triage"]), "labels");

      const shared = fakeGitHub();
      await send(handleRequest, shared, report(captionLoadFailed, "auto", media));
      const second = await send(handleRequest, shared, report(captionLoadFailed, "manual", media));
      equal(second.json.status, "duplicate", "the same incident from the other entry point is the same issue");
      equal(shared.issues.length, 1, "one issue");
      for (const [destination, label] of [[auto, "auto"], [manual, "manual"], [shared, "shared"]]) assertNoSensitive(destination, label);
    },
  },
  {
    name: "#874 caption load, audio switch and subtitle switch failures get distinct titles and issues",
    async run(handleRequest) {
      const gh = fakeGitHub();
      await send(handleRequest, gh, report(captionLoadFailed, "auto", captionFailedMedia));
      await send(handleRequest, gh, report(audioSwitchFailed, "auto", withSwitch(overlayLoaded(12), "audio", "failed", "http_500")));
      await send(handleRequest, gh, report(subtitleSwitchFailed, "auto", withSwitch(overlayLoaded(12), "subtitle", "failed", "http_409")));
      const [caption, audioIssue, subtitle] = gh.created().map((call) => call.body);
      equal(caption.title, "Subtitles failed to load during playback", "caption title");
      equal(audioIssue.title, "Audio track switch failed during playback: HTTP 500", "audio switch title");
      equal(subtitle.title, "Subtitle track switch failed during playback: HTTP 409", "subtitle switch title");
      equal(gh.issues.length, 3, "three issues");
      includes(audioIssue.body, "| First failed stage | Audio track switch |", "audio stage");
      includes(audioIssue.body, "| HTTP status | 500 |", "observed status");
      includes(audioIssue.body, "| Requested switch | Audio · Failed · http_500 |", "switch result");
      includes(subtitle.body, "| First failed stage | Subtitle track switch |", "subtitle stage");
      includes(subtitle.body, "| Requested switch | Subtitle · Failed · http_409 |", "switch result");
      includes(subtitle.body, "| Subtitle cues loaded | 12 |", "previous track's cues still observed");
    },
  },
  {
    name: "#874 a refused switch, a recovered caption load and a lost switch answer stay manual, with their recovery outcome",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const cases = [
        [subtitleSwitchRefused, withSwitch(overlayLoaded(12), "subtitle", "refused", "subtitle_selection_unavailable"), "Subtitle track switch refused: selected subtitles unavailable"],
        [captionLoadRecovered, captionFallbackMedia, "Subtitles failed to load during playback, then recovered"],
        [subtitleSwitchUnanswered, withSwitch(overlayLoaded(12), "subtitle", "failed", "no_answer"), "Subtitle track switch failed during playback: no server answer"],
      ];
      for (const [inc, md] of cases) {
        const automatic = await send(handleRequest, gh, report(inc, "auto", md));
        equal(automatic.status, 422, `${inc.stage} ${inc.out} is not auto-reportable`);
        equal(automatic.json.error, "not_auto_reportable", "error code");
      }
      equal(gh.created().length, 0, "no automatic issue");
      for (const [inc, md] of cases) equal((await send(handleRequest, gh, report(inc, "manual", md))).status, 201, `${inc.stage} manual created`);
      const [refused, recovered, unanswered] = gh.created().map((call) => call.body);
      cases.forEach(([, , title], index) => equal([refused, recovered, unanswered][index].title, title, "title"));
      includes(refused.body, "| Outcome | Refused (expected refusal) |", "refusal outcome");
      includes(refused.body, "| Requested switch | Subtitle · Refused (selection unavailable) · subtitle_selection_unavailable |", "refusal switch row");
      includes(recovered.body, "| Recovery | Recovered |", "recovery outcome");
      includes(recovered.body, "| Subtitle file load | Failed; AVPlay drew the embedded track |", "fallback load");
      includes(recovered.body, "| Subtitles drawn by | AVPlay (TV player) |", "AVPlay draws");
      includes(unanswered.body, "| Error kind | network |", "a lost answer is a connectivity symptom");
    },
  },
  {
    name: "#874 viewer-observed reports: zero loaded cues is an observed zero; subtitles Off has no load, cues or delay; the same screen groups",
    async run(handleRequest) {
      const gh = fakeGitHub();
      equal((await send(handleRequest, gh, observed(withSwitch(overlayLoaded(0), "audio", "ok")))).status, 201, "observed created");
      const [zero] = gh.created().map((call) => call.body);
      equal(zero.title, "Viewer reported an audio or subtitle problem on Details", "observed title");
      for (const row of [
        "| Report type | Viewer-observed symptom (no failure detected) |",
        "| Subtitle file load | Loaded |",
        "| Subtitle cues loaded | 0 |",
        "| Subtitle delay (applied) | +250 ms |",
        "| Audio output (planned by server) | aac · 2 ch |",
        "| Audio stream reported by AVPlay | eac3 · 6 ch |",
        "| Requested switch | Audio · Succeeded |",
      ]) includes(zero.body, row, "zero-cue body");

      const off = fakeGitHub();
      await send(handleRequest, off, observed(subtitlesOffMedia));
      const [offIssue] = off.created().map((call) => call.body);
      for (const row of [
        "| Subtitle mode (planned) | off |",
        "| Subtitles drawn by | Not shown |",
        "| Subtitle file load | Not needed (no subtitle file drawn by Auger) |",
        "| Subtitle cues loaded | Not observed |",
        "| Subtitle delay (applied) | Not applied |",
        "| Audio output (planned by server) | Not stated in the plan |",
        "| Audio stream reported by AVPlay | Not reported by AVPlay |",
        "| Requested switch | None this attempt |",
      ]) includes(offIssue.body, row, "off body");
      excludes(offIssue.body, "| Subtitle track |", "no track row when Off");

      const grouped = await send(handleRequest, gh, observed(subtitlesOffMedia));
      equal(grouped.json.status, "updated", "the same screen and category updates the observed issue");
      const comment = gh.comments()[0].body.body;
      includes(comment, "**Subtitle mode:** `render` → `off`", "mode change");
      includes(comment, "**Subtitles drawn by:** `overlay` → `none`", "drawer change");
    },
  },
  {
    name: "#874 track labels, cue text, unknown codecs and invalid languages never reach a title, body, comment or metadata",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const tainted = {
        mv: 1,
        label: "SYNTH_TRACK",
        a: { lang: "SYNTH_TRACK", src: { c: "SYNTH_TRACK" }, pl: { c: "aac", ch: 2, title: "SYNTH_TRACK" }, obs: { c: "eac3", ch: 99 }, name: "SYNTH_TRACK" },
        s: {
          mode: "render", src: "external", c: "SYNTH_SUBTITLE", dl: "sidecar", lang: "synth-SYNTH_TRACK", f: false, hi: false,
          via: "overlay", ld: "loaded", cues: 3, sync: 250, sec: false, label: "SYNTH_TRACK", text: "SYNTH_SUBTITLE line",
        },
        sw: { k: "subtitle", r: "failed", code: "synth_title_the_movie" },
      };
      const inc = { ...subtitleSwitchFailed, label: "SYNTH_TRACK", trackName: "SYNTH_SUBTITLE" };
      equal((await send(handleRequest, gh, report(inc, "auto", tainted, { play: { sub: "render · SYNTH_TRACK" } }))).status, 201, "created");
      const [issue] = gh.created().map((call) => call.body);
      for (const row of [
        "| Audio language | Not reported |",
        "| Audio source (file) | Not reported |",
        "| Audio output (planned by server) | aac · 2 ch |",
        "| Audio stream reported by AVPlay | eac3 |",
        "| Subtitle track | external · sidecar |",
        "| Requested switch | Subtitle · Failed · Unlisted code |",
      ]) includes(issue.body, row, "validated media rows");
      await send(handleRequest, gh, report(inc, "manual", { ...tainted, s: { ...tainted.s, cues: 4 } }));
      equal(gh.comments().length, 1, "a changed cue count adds a follow-up");
      assertNoSensitive(gh, "media privacy");
    },
  },
  {
    name: "#874 a later report of the same incident records changed audio and subtitle evidence on the same issue",
    async run(handleRequest) {
      const gh = fakeGitHub();
      await send(handleRequest, gh, report(captionLoadFailed, "auto", captionFailedMedia));
      const changed = { ...captionFailedMedia, a: { ...audio, obs: { c: "eac3", ch: 2 } } };
      const next = await send(handleRequest, gh, report(captionLoadFailed, "manual", changed));
      equal(next.json.status, "updated", "same incident updates");
      includes(gh.comments()[0].body.body, "**AVPlay audio channels:** `6` → `2`", "observed channel change");
      equal((await send(handleRequest, gh, report(captionLoadFailed, "manual", changed))).json.status, "duplicate", "same evidence");
      equal(gh.issues.length, 1, "one issue");
    },
  },
  {
    name: "#874 older payloads without md, an unknown md version and an unknown media stage still file safely",
    async run(handleRequest) {
      const legacy = fakeGitHub();
      equal((await send(handleRequest, legacy, { v: 1, app: "0.4.0", tv: TV, cat: "audio_subtitles", play: { sub: "render · external SRT (sidecar)", e: "playback_failed" } })).status, 201, "legacy created");
      const [old] = legacy.created().map((call) => call.body);
      includes(old.body, "| Subtitle mode | render · external SRT (sidecar) |", "legacy subtitle summary kept");
      excludes(old.body, "### Audio and subtitles", "no media section without md");

      const future = fakeGitHub();
      await send(handleRequest, future, report(captionLoadFailed, "manual", { ...captionFailedMedia, mv: 2 }));
      excludes(future.created()[0].body.body, "### Audio and subtitles", "an unknown md version is discarded");

      const unknownStage = fakeGitHub();
      equal((await send(handleRequest, unknownStage, report({ ...captionLoadFailed, stage: "caption_teleport", fs: "caption_teleport" }, "manual", captionFailedMedia))).status, 201, "created");
      const fallback = unknownStage.created()[0].body;
      equal(fallback.title, "Audio or subtitle problem reported", "unknown stage falls back to the category");
      includes(fallback.body, "| First failed stage | Not reported |", "no invented stage");
    },
  },
];
