// Relay cases for #876 App / Navigation evidence (`nav` nv 1, src/diagnosticsNavigation.ts).
// Plain ES module like relayCases.js: no Node imports, so a browser harness on the TV can import it next to
// workers/diagnostics-relay/worker.js and call runNavigationCases(handleRequest). Each case builds fresh fake
// destinations; the equivalence comparison and the shared-destination grouping never share one.

import { deployedLegacyFingerprint, encodeState, fakeGitHub, send } from "./fakeGitHub.js";

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

const APP = "0.6.0";
const TV = "QE65S95C";
const device = { v: 1, app: APP, tv: TV, fw: "1650", os: "Tizen 9.0", ua: "Chrome/120.0.6099.5", hdr: true, srv: "412" };
const LOG = ["12:00:01 [app] error TypeError"];

/** Home row navigation, then Up into the top bar: shaped exactly as NavigationRecorder.capture() serializes it. */
export const homeRowNavigation = {
  nv: 1,
  sc: "home",
  st: ["home:section:right:moved*3", "home:section:up:zone:nav", "home:nav:right:moved"],
  lt: { n: 2, w: 180 },
  fr: { n: 12, p95: 48, w: 120 },
  dom: { n: 4200, img: 180 },
  cpu: 4,
  rm: false,
  api: { op: "home_sections", ms: 900 },
};

/** The navigation section of an issue body, for comparing two renderings without their source rows. */
function navigationSection(body) {
  const start = body.indexOf("### Navigation before the report");
  check(start !== -1, "navigation section rendered");
  const end = body.indexOf("\n### ", start + 1);
  return body.slice(start, end === -1 ? undefined : end);
}

const autoError = (nav, err = "TypeError") => ({ ...device, err, auto: true, log: LOG, nav });
const manualError = (nav, err = "TypeError") => ({ ...device, err, cat: "app_ui", precedingScreen: nav.sc, log: LOG, nav });

const SENSITIVE = ["SYNTH_TITLE", "SYNTHTOKEN", "synthetic.example.invalid", "SYNTH_PROFILE", "192.0.2.77", "synth_item_42"];

export const CASES = [
  {
    name: "uncaught navigation error: manual and automatic submissions render the same evidence and file one issue",
    async run(handleRequest) {
      const autoGh = fakeGitHub();
      const manualGh = fakeGitHub();
      equal((await send(handleRequest, autoGh, autoError(homeRowNavigation))).status, 201, "auto filed");
      equal((await send(handleRequest, manualGh, manualError(homeRowNavigation))).status, 201, "manual filed");
      const [auto] = autoGh.created();
      const [manual] = manualGh.created();
      equal(auto.body.title, "Home navigation raised an uncaught TypeError", "auto title");
      equal(manual.body.title, auto.body.title, "manual title matches");
      equal(navigationSection(manual.body.body), navigationSection(auto.body.body), "same navigation evidence");
      includes(auto.body.body, "| Report source | Automatic error report |", "auto source");
      includes(manual.body.body, "| Report source | Manual (App / Navigation) |", "manual source");
      includes(auto.body.body, "1. Home · zone section · Right · moved within the zone (×3)", "row steps");
      includes(auto.body.body, "2. Home · zone section · Up · moved to zone nav", "top-bar step");
      includes(auto.body.body, "| D-pad input to next frame (estimate) | p95 48 ms, worst 120 ms (12 samples) |", "frame estimate");
      includes(auto.body.body, "| Slowest API operation (to response headers) | home_sections · 900 ms |", "api latency");
      check(auto.body.body.indexOf("### Navigation before the report") < auto.body.body.indexOf("### Device"), "navigation before device");
      check(!auto.body.body.includes("### ELI5") && !manual.body.body.includes("### ELI5"), "diagnostics issues must not include an ELI5 section");
      equal(JSON.stringify(auto.body.labels), JSON.stringify(["diagnostics", "needs-triage"]), "labels");

      const shared = fakeGitHub();
      const first = await send(handleRequest, shared, autoError(homeRowNavigation));
      const second = await send(handleRequest, shared, manualError(homeRowNavigation));
      equal(shared.created().length, 1, "one issue");
      equal(second.json.issueNumber, first.json.issueNumber, "same issue");
      equal(second.json.status, "duplicate", "identical evidence is a duplicate");
      equal(shared.comments().length, 0, "no follow-up for the same incident");
    },
  },
  {
    name: "different screens or error names file separately with distinct titles",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const first = await send(handleRequest, gh, autoError(homeRowNavigation));
      const details = { ...homeRowNavigation, sc: "details", st: ["details:actions:down:zone:seasons"] };
      equal((await send(handleRequest, gh, autoError(details))).status, 201, "details error files separately");
      equal((await send(handleRequest, gh, autoError(homeRowNavigation, "UnhandledRejection"))).status, 201, "another error name files separately");
      const titles = gh.created().map((call) => call.body.title);
      equal(titles[1], "Details navigation raised an uncaught TypeError", "details title");
      equal(titles[2], "Home navigation raised an unhandled promise rejection", "rejection title");
      const later = { ...homeRowNavigation, st: ["home:section:left:stayed"], fr: { n: 3, p95: 30, w: 31 } };
      equal((await send(handleRequest, gh, manualError(later))).json.issueNumber, first.json.issueNumber, "same screen and error reuse the first issue");
      check(!gh.comments()[0].body.body.includes("**Category:**"), "manual submission does not add a category change");
      includes(gh.comments()[0].body.body, "p95 30 ms", "follow-up shows the new navigation evidence");
    },
  },
  {
    name: "a legacy app error issue cannot name a screen, so a navigation error never reuses it",
    async run(handleRequest) {
      const fp = deployedLegacyFingerprint(APP, TV, "app:TypeError");
      const seeded = { number: 640, title: "Auger raised an uncaught TypeError", body: `<!-- auger-fp:${fp} -->\n<!-- auger-state:${encodeState({ err: "TypeError" })} -->` };
      const gh = fakeGitHub([seeded]);
      equal((await send(handleRequest, gh, autoError(homeRowNavigation))).status, 201, "current report files separately");
      const legacy = await send(handleRequest, gh, { ...device, err: "TypeError", auto: true, log: LOG });
      equal(legacy.json.issueNumber, 640, "an installed client still reaches its own issue");
      const unknown = await send(handleRequest, gh, autoError({ ...homeRowNavigation, sc: "unknown" }));
      equal(unknown.json.issueNumber, 640, "an error outside browse keeps the legacy grouping");
      equal(gh.created()[0].body.title, "Home navigation raised an uncaught TypeError", "title");
    },
  },
  {
    name: "Settings after Home row navigation: the manual report still describes the Home action",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const frozen = { ...homeRowNavigation, st: [...homeRowNavigation.st, "home:nav:enter:pressed"] };
      const payload = { ...device, cat: "app_ui", precedingScreen: "home", nav: frozen };
      const filed = await send(handleRequest, gh, payload);
      equal(filed.status, 201, "filed");
      const [issue] = gh.created();
      equal(issue.body.title, "Viewer reported a navigation problem on Home", "user-observed title");
      includes(issue.body.body, "Viewer-observed symptom (no failure detected)", "report type");
      includes(issue.body.body, "| Screen at capture | Home |", "screen");
      includes(issue.body.body, "4. Home · zone nav · Select · pressed", "the press that opened Settings");
      const again = await send(handleRequest, gh, { ...payload, nav: { ...frozen, fr: { n: 20, p95: 60, w: 90 } } });
      equal(again.json.issueNumber, filed.json.issueNumber, "same symptom and screen group together");
      equal(gh.created().length, 1, "one issue");
    },
  },
  {
    name: "off, unavailable and observed zero render distinctly",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const missing = { nv: 1, sc: "home", st: [], lt: "unavailable", fr: "off", dom: "unavailable", cpu: "unavailable", rm: "unavailable", api: "none" };
      await send(handleRequest, gh, { ...device, cat: "app_ui", precedingScreen: "home", nav: missing });
      const body = gh.created()[0].body.body;
      includes(body, "No remote actions recorded.", "empty breadcrumb");
      includes(body, "| Long tasks over 50 ms (last 60 s) | Unavailable on this TV |", "long tasks unavailable");
      includes(body, "| D-pad input to next frame (estimate) | Sampling off |", "frames off");
      includes(body, "| DOM nodes / images | Unavailable on this TV |", "dom unavailable");
      includes(body, "| Slowest API operation (to response headers) | None observed |", "no api");

      const zeroGh = fakeGitHub();
      await send(handleRequest, zeroGh, { ...device, cat: "app_ui", precedingScreen: "search", nav: { ...missing, sc: "search", lt: { n: 0 }, fr: { n: 0 } } });
      const zero = zeroGh.created()[0].body.body;
      includes(zero, "| Long tasks over 50 ms (last 60 s) | 0 observed |", "observed zero long tasks");
      includes(zero, "| D-pad input to next frame (estimate) | 0 samples |", "observed zero frames");
    },
  },
  {
    name: "hostile or oversized navigation values never publish",
    async run(handleRequest) {
      const gh = fakeGitHub();
      const hostile = {
        nv: 1,
        sc: "SYNTH_PROFILE",
        st: [
          "home:section:SYNTH_TITLE:moved",
          "home:section:synth_item_42:right:moved",
          "home:SYNTHTOKEN:right:moved",
          "home:section:up:zone:synthetic.example.invalid",
          "home:section:right:moved*100",
          ...Array.from({ length: 40 }, () => "home:grid:down:moved"),
        ],
        lt: { n: "SYNTHTOKEN", w: 10 },
        fr: { n: 12, p95: "192.0.2.77", w: 1e9 },
        dom: { n: "many", img: 1 },
        cpu: 9999,
        rm: "SYNTH_TITLE",
        api: { op: "synthetic.example.invalid", ms: 10 },
        extra: "SYNTHTOKEN",
      };
      equal((await send(handleRequest, gh, { ...device, err: "TypeError", auto: true, nav: hostile })).status, 201, "report still files");
      for (const text of gh.publishedText()) for (const value of SENSITIVE) excludes(text, value, "published text");
      const body = gh.created()[0].body.body;
      equal(gh.created()[0].body.title, "Auger raised an uncaught TypeError", "unknown screen keeps the generic title");
      check((body.match(/^\d+\. /gm) ?? []).length <= 8, "steps stay bounded");
      excludes(body, "Right · moved within the zone (×100)", "an out-of-range repeat count drops the step");
      includes(body, "| D-pad input to next frame (estimate) | (12 samples) |", "invalid numbers are dropped, not printed");
      includes(body, "| Long tasks over 50 ms (last 60 s) | Not reported |", "invalid count drops the sample");
      includes(body, "| Reduced motion | Not reported |", "invalid flag drops");

      const futureGh = fakeGitHub();
      await send(handleRequest, futureGh, { ...device, cat: "app_ui", precedingScreen: "home", nav: { ...homeRowNavigation, nv: 2 } });
      excludes(futureGh.created()[0].body.body, "### Navigation before the report", "an unknown nav version is dropped");
    },
  },
];

/** Runs every case (or the named subset) and returns per-case results; never throws. */
export async function runNavigationCases(handleRequest, names) {
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
