# Navigation diagnostics: S95C validation protocol (#876)

This protocol covers the App / Navigation evidence from `src/diagnosticsNavigation.ts`.
It has two parts:

1. The sampling overhead gate, which decides whether continuous timing sampling may ship enabled.
2. Submission checks, which drive the manual and automatic reports to a rendered issue without touching the public tracker.

Run both on the same signed `.wgt` and the same S95C, following [simulator-evidence.md](simulator-evidence.md) for install and hash checks.
Record the build SHA, the installed asset hash, the TV firmware and the Tizen version with every result.

## What is always on and what is gated

Breadcrumbs always record.
Each remote press stores one short step (`screen:zone:action:outcome`).
They live in a bounded ring of 8, and repeated steps collapse into a count.
DOM node and image counts, core count and reduced motion are read once per capture, never per key.
The slowest `/api/v2` operation family is timed to response headers on every request.

Continuous sampling is gated by `localStorage["auger.diagnostics.navSampling"] === "1"` and is off by default.
It adds two things:

- A `longtask` PerformanceObserver.
- One `requestAnimationFrame` per D-pad arrow press, which gives the keydown-to-next-frame estimate.

The observer runs only while browse owns the remote and the app is visible.
Reports say `Sampling off` while the gate is closed.
They say `Unavailable on this TV` when the API is missing.

Turn the gate on or off from the Web Inspector console, then reload:

```js
localStorage.setItem("auger.diagnostics.navSampling", "1"); location.reload(); // enabled
localStorage.removeItem("auger.diagnostics.navSampling"); location.reload();   // disabled
```

## Part 1: sampling overhead gate

### Matched conditions

Keep these identical across every run:

- The same TV, `.wgt`, server, profile and Home content.
- No playback started since launch.
- Reduced motion as found; record it.
- Relaunch the app before each run.
- Wait 10 s after Home settles.
- Put focus on the first card of the first Home row (one **Down** from the top bar).

Interleave the runs as `A1 B1 A2 B2 A3 B3`.
A means sampling disabled and B means sampling enabled.
Each run executes the driver below once.
The driver runs 10 repetitions of a closed Home row loop (Right ×12, Left ×12) and a closed top-bar loop (Up, Right ×3, Left ×3, Down).
Both loops end where they started.

### Independent instrumentation

The driver measures with its own long-task observer and its own frame timing.
It never reads Auger's recorder.
It dispatches the presses on the focused element, so Auger's real key handlers move focus.
It prints one JSON line per run.

```js
(async () => {
  const LOOPS = {
    row: [...Array(12).fill("ArrowRight"), ...Array(12).fill("ArrowLeft")],
    topbar: ["ArrowUp", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowDown"],
  };
  const REPEATS = 10, GAP_MS = 250;
  const sampling = localStorage.getItem("auger.diagnostics.navSampling") === "1";
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve(performance.now())));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const longTasks = [];
  const observer = "PerformanceObserver" in window && PerformanceObserver.supportedEntryTypes.includes("longtask")
    ? new PerformanceObserver(list => { for (const entry of list.getEntries()) longTasks.push(entry.duration); })
    : undefined;
  observer?.observe({ type: "longtask" });
  const samples = { row: [], topbar: [] };
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    for (const [name, keys] of Object.entries(LOOPS)) {
      for (const key of keys) {
        const target = document.activeElement ?? document.body;
        const start = performance.now();
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
        samples[name].push((await frame()) - start);
        await pause(GAP_MS);
      }
    }
  }
  observer?.disconnect();
  const stats = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = q => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
    return { n: sorted.length, p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), worst: +sorted.at(-1).toFixed(1) };
  };
  console.log(JSON.stringify({
    sampling, row: stats(samples.row), topbar: stats(samples.topbar),
    longTasks: observer ? { n: longTasks.length, worst: +(Math.max(0, ...longTasks)).toFixed(1) } : "unavailable",
  }));
})();
```

### Ceiling, decided from the A runs before reading B

The ceiling is fixed from the A runs before any B result is read.
Do the steps in this order:

1. For each loop, set the noise `N` to the largest minus the smallest p95 across A1–A3.
2. Set the frame budget `F` to 16.7 ms (60 Hz).
   The allowed overhead is a quarter of that, 4.2 ms.
3. Set the ceiling `C` to the larger of `N` and 1 ms, capped at 4.2 ms.
4. Mark the result **inconclusive** if `N` is above 4.2 ms.
   That noise is too large to see overhead within a quarter frame.
   Keep sampling off, double `REPEATS` and rerun.
5. Write `N`, `C` and the decision rule into the results table before computing any B statistic.

### Pass or fail

Sampling may ship enabled only when both loops meet all three conditions:

- The mean B p95 minus the mean A p95 is no more than `C`.
- The worst B frame is no more than the worst A frame plus `F`.
- The B long-task count stays within the range seen in A, plus one.

If any condition fails, keep `navSampling` off.
Then reduce the sampling, for example by sampling one arrow press in four, and rerun.
Enabling it by default is a one-line change to the default read in `DiagnosticsCollector` and needs this table attached to that PR.

| Run | Sampling | Row p95 / worst (ms) | Top bar p95 / worst (ms) | Long tasks n / worst |
| --- | --- | --- | --- | --- |
| A1 | off | | | |
| B1 | on | | | |
| A2 | off | | | |
| B2 | on | | | |
| A3 | off | | | |
| B3 | on | | | |
| Noise `N` / ceiling `C` | | | | |
| Decision | | | | |

## Part 2: submission checks without the public tracker

Synthetic incidents must never reach the public tracker.
Before each check, paste this into the Web Inspector console.
It captures what Auger would send and answers as the relay would:

```js
window.__augerReports = [];
const realFetch = window.fetch.bind(window);
window.fetch = (url, init) => String(url).startsWith("https://auger-diagnostics.plaintextlab.com/")
  ? (window.__augerReports.push(JSON.parse(init.body)), Promise.resolve(new Response(JSON.stringify({ ok: true, status: "created", issueNumber: 1, reportId: "AUG-TEST" }), { status: 201 })))
  : realFetch(url, init);
```

After each check, copy the captured payloads with `copy(JSON.stringify(window.__augerReports))`.
Save them as `reports.json` on the Mac.
Then render them through the real relay into one shared fake GitHub destination:

```sh
node --input-type=module -e '
import { readFileSync } from "node:fs";
import { handleRequest } from "./workers/diagnostics-relay/worker.js";
import { fakeGitHub, send } from "./test/native/fixtures/diagnostics-relay/fakeGitHub.js";
const gh = fakeGitHub();
for (const report of JSON.parse(readFileSync("reports.json", "utf8"))) console.log((await send(handleRequest, gh, report)).json);
for (const call of gh.outbound) console.log("----", call.method, call.url, "\n" + (call.body.title ?? "") + "\n" + call.body.body);
'
```

| Check | Steps on the TV | Expected |
| --- | --- | --- |
| Default off | Fresh install → **Settings → Diagnostics**. | **Automatic Error Reports** is off. Nothing is captured until a manual send. |
| Manual after Home navigation | Home: Right ×3 on the first row, Up to the top bar, open **Settings → Diagnostics → Send Diagnostics Report → App / Navigation**. | Title `Viewer reported a navigation problem on Home`. The steps list Home section moves, the top-bar zone change and `Select · pressed`, with no Settings steps. The payload holds no zone id text after a colon, no item keys, URLs or titles. |
| Slow-focus fallback | Same as above, holding Right for a few seconds first. | A user-observed title only, never an inferred "slow" claim. Steps show `Right · moved within the zone (×N)`. |
| Automatic off, uncaught error | Automatic off. On Home, run `setTimeout(() => { throw new TypeError("probe") })`. | Nothing captured. |
| Automatic on, uncaught error | Turn **Automatic Error Reports** on. On Home, run the same throw after a few row moves. | One automatic payload. Title `Home navigation raised an uncaught TypeError`. The source is `Automatic error report`. The word `probe` appears nowhere. |
| Manual for the same error | Then open **Settings → Diagnostics → Send → App / Navigation**. | The navigation section matches the automatic body. The source is `Manual (App / Navigation)`. In the shared destination, the second report returns `duplicate` on the same issue. |
| Unhandled rejection | Automatic on, on Details: `Promise.reject(new RangeError("probe"))`. | A separate issue titled `Details navigation raised an uncaught RangeError`. |
| Profile isolation | Capture an error, switch profile, then send App / Navigation manually. | The earlier steps and error are absent. |
| Sampling disabled and enabled | Repeat the manual check with the gate off, then on. | Off shows `Sampling off` for long tasks and frame estimate. On shows observed counts, which may be `0 observed`. |

## Platform fields to record

For each field, record whether the S95C runtime observed it, approximated it or had it unavailable.
Read the values from a captured `nav` block.
This runtime's result does not establish Tizen 8 support.

| Field | `nav` key | Source | Observed / approximate / unavailable |
| --- | --- | --- | --- |
| Long tasks over 50 ms | `lt` | `PerformanceObserver` `longtask` | |
| D-pad input to next frame | `fr` | `KeyboardEvent.timeStamp` to the `requestAnimationFrame` callback (approximate) | |
| DOM nodes / images | `dom` | `getElementsByTagName("*")`, `document.images` | |
| CPU cores | `cpu` | `navigator.hardwareConcurrency` | |
| Reduced motion | `rm` | `prefers-reduced-motion` media query | |
| Slowest API operation | `api` | `/api/v2` fetch to response headers; aborted requests are not timed | |
