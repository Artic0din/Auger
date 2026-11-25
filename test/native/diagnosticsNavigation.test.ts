import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import { DiagnosticsCollector, diagnosticsFingerprint, diagnosticsPayload } from "../../src/diagnostics.ts";
import { NAV_SAMPLING_KEY, type NavigationEnvironment, NavigationRecorder, type NavigationScreen, type NavigationSource } from "../../src/diagnosticsNavigation.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

type KeyListener = (event: KeyboardEvent) => void;
const KEY = { left: 37, up: 38, right: 39, down: 40, enter: 13 } as const;

/** A TV without a page: remote presses, focus, frames and long tasks are all driven by the test. */
function fakeTv(options: { longTasks?: boolean; dom?: boolean } = {}) {
    let now = 1000;
    let hidden = false;
    const capture = new Set<KeyListener>();
    const bubble = new Set<KeyListener>();
    const visibility = new Set<() => void>();
    const frames: (() => void)[] = [];
    let longTask: ((duration: number, end: number) => void) | undefined;
    let observing = 0;
    let counted = 0;
    const focus: { element: unknown; zone: string | undefined } = { element: {}, zone: "section:synth_item_42" };
    const env: NavigationEnvironment = {
        now: () => now,
        frame: callback => { frames.push(callback); },
        observeLongTasks: report => {
            if (options.longTasks === false) return undefined;
            observing++;
            longTask = report;
            return () => { observing--; longTask = undefined; };
        },
        counts: () => { counted++; return options.dom === false ? undefined : { nodes: 4200, images: 180 }; },
        cores: () => 4,
        reducedMotion: () => false,
        hidden: () => hidden,
        activeElement: () => focus.element,
        keyTarget: {
            addEventListener: (_type, listener, useCapture) => { (useCapture === true ? capture : bubble).add(listener); },
            removeEventListener: (_type, listener, useCapture) => { (useCapture === true ? capture : bubble).delete(listener); },
        },
        visibilityTarget: {
            addEventListener: (_type, listener) => { visibility.add(listener); },
            removeEventListener: (_type, listener) => { visibility.delete(listener); },
        },
    };
    return {
        env,
        focus,
        /** One remote press: capture listeners, the app's handler (`move`), then bubble listeners. */
        press(keyCode: number, move?: { zone: string | undefined } | "stay"): void {
            const event = { keyCode, key: "", timeStamp: now } as KeyboardEvent;
            for (const listener of [...capture]) listener(event);
            if (move !== undefined && move !== "stay") { focus.element = {}; focus.zone = move.zone; }
            for (const listener of [...bubble]) listener(event);
        },
        paint(after: number): void { now += after; for (const callback of frames.splice(0)) callback(); },
        advance(ms: number): void { now += ms; },
        longTask(duration: number): void { longTask?.(duration, now); },
        setHidden(value: boolean): void { hidden = value; for (const listener of [...visibility]) listener(); },
        observerCallback: () => longTask,
        observing: () => observing,
        counted: () => counted,
        listening: () => capture.size + bubble.size,
    };
}

function source(tv: ReturnType<typeof fakeTv>, screen: () => NavigationScreen | undefined = () => "home"): NavigationSource {
    return { screen, zone: () => tv.focus.zone };
}

const clock: Clock = { now: () => 0, schedule: () => () => undefined };

test("navigation breadcrumbs record screen, zone family, remote action and focus outcome without identifiers", () => {
    const tv = fakeTv();
    const recorder = new NavigationRecorder(false, () => tv.env);
    recorder.attach(source(tv));
    tv.press(KEY.right, { zone: "section:synth_item_42" });
    tv.press(KEY.right, { zone: "section:synth_item_42" });
    tv.press(KEY.up, { zone: "nav" });
    tv.press(KEY.up, "stay");
    tv.press(KEY.down, { zone: undefined });
    tv.press(KEY.down, { zone: "section:synth_item_43" });
    tv.press(KEY.enter);
    const captured = recorder.capture();
    assert.deepEqual(captured.st, [
        "home:section:right:moved*2",
        "home:section:up:zone:nav",
        "home:nav:up:stayed",
        "home:nav:down:lost",
        "home:none:down:restored",
        "home:section:enter:pressed",
    ]);
    assert.equal(captured.sc, "home");
    assert.equal(JSON.stringify(captured).includes("synth_item"), false, "zone ids after the colon never leave the TV");
});

test("breadcrumbs stay bounded and stop when browse detaches or is covered", () => {
    const tv = fakeTv();
    let screen: NavigationScreen | undefined = "home";
    const recorder = new NavigationRecorder(false, () => tv.env);
    const browse = source(tv, () => screen);
    recorder.attach(browse);
    for (let index = 0; index < 120; index++) tv.press(KEY.right, { zone: "section:a" });
    for (const zone of ["nav", "section:b", "grid", "pills", "nav", "grid", "section:c", "nav", "grid"]) tv.press(KEY.down, { zone });
    const steps = recorder.capture().st;
    assert.equal(steps.length, 8);
    screen = undefined;
    tv.press(KEY.left, { zone: "grid" });
    assert.deepEqual(recorder.capture().st, steps, "presses while browse is covered are not navigation");
    recorder.detach(browse);
    assert.equal(tv.listening(), 0);
    assert.equal(recorder.capture().sc, "unknown");
});

test("timing samples are off by default and the DOM is counted once per capture, never per key", () => {
    const tv = fakeTv();
    const recorder = new NavigationRecorder(false, () => tv.env);
    recorder.attach(source(tv));
    for (let index = 0; index < 10; index++) tv.press(KEY.right, { zone: "section:a" });
    tv.paint(16);
    assert.equal(tv.observing(), 0, "no long-task observer while sampling is off");
    assert.equal(tv.counted(), 0);
    const captured = recorder.capture();
    assert.equal(tv.counted(), 1);
    assert.equal(captured.lt, "off");
    assert.equal(captured.fr, "off");
    assert.deepEqual(captured.dom, { n: 4200, img: 180 });
    assert.equal(captured.cpu, 4);
    assert.equal(captured.rm, false);
    assert.equal(captured.api, "none");
});

test("with sampling on, frame estimates and long tasks are bounded, and missing APIs read unavailable", () => {
    const tv = fakeTv();
    const recorder = new NavigationRecorder(true, () => tv.env);
    recorder.attach(source(tv));
    assert.deepEqual(recorder.capture().fr, { n: 0 }, "observed zero before any press");
    assert.deepEqual(recorder.capture().lt, { n: 0 });
    for (const delay of [10, 20, 30, 40, 200]) {
        tv.press(KEY.right, { zone: "section:a" });
        tv.press(KEY.right, { zone: "section:a" }); // a second press before the frame is not sampled again
        tv.paint(delay);
    }
    tv.press(KEY.enter);
    tv.paint(500); // Select is not a D-pad move
    assert.deepEqual(recorder.capture().fr, { n: 5, p95: 200, w: 200 });
    tv.longTask(80);
    tv.longTask(120);
    assert.deepEqual(recorder.capture().lt, { n: 2, w: 120 });
    tv.advance(61_000);
    assert.deepEqual(recorder.capture().lt, { n: 0 }, "only the last 60 s count");

    tv.setHidden(true);
    assert.equal(tv.observing(), 0, "observer stops while hidden");
    tv.setHidden(false);
    assert.equal(tv.observing(), 1);
    recorder.detach(source(tv));
    assert.equal(tv.observing(), 1, "detaching another source changes nothing");

    const bare = fakeTv({ longTasks: false, dom: false });
    const old = new NavigationRecorder(true, () => bare.env);
    old.attach(source(bare));
    const captured = old.capture();
    assert.equal(captured.lt, "unavailable");
    assert.equal(captured.dom, "unavailable");
});

test("API timing keeps the slowest /api/v2 operation family and ignores other URLs and aborts", async () => {
    const tv = fakeTv();
    const recorder = new NavigationRecorder(false, () => tv.env);
    const slow = (ms: number, fail = false) => async (): Promise<Response> => { tv.advance(ms); if (fail) throw new TypeError("network"); return new Response("{}"); };
    await recorder.timedFetch(slow(300))("https://synthetic.example.invalid/api/v2/home/sections?item_limit=20", {});
    await recorder.timedFetch(slow(900))("https://synthetic.example.invalid/api/v2/catalog/items/synth_item_42", {});
    await recorder.timedFetch(slow(5000))("https://auger-diagnostics.plaintextlab.com/report", {});
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(recorder.timedFetch(slow(7000, true))("https://synthetic.example.invalid/api/v2/home/sections", { signal: aborted.signal }));
    assert.deepEqual(recorder.capture().api, { op: "item_detail", ms: 900 });
    await assert.rejects(recorder.timedFetch(slow(1200, true))("https://synthetic.example.invalid/api/v2/watch/synth_item_42", {}));
    assert.deepEqual(recorder.capture().api, { op: "watch_detail", ms: 1200 });
});

test("a profile reset discards late request and frame callbacks while retaining current samples", async () => {
    const tv = fakeTv();
    const recorder = new NavigationRecorder(true, () => tv.env);
    recorder.attach(source(tv));
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    const url = "https://synthetic.example.invalid/api/v2/home/sections";
    const late = recorder.timedFetch(() => pending)(url, {});
    tv.press(KEY.right);
    const oldObserver = tv.observerCallback();
    assert.ok(oldObserver);
    recorder.reset();
    oldObserver(185, tv.env.now());
    tv.longTask(75);
    assert.deepEqual(recorder.capture().lt, { n: 1, w: 75 });
    tv.advance(1000);
    release(new Response());
    await late;
    tv.paint(1);
    assert.equal(recorder.capture().api, "none");
    assert.deepEqual(recorder.capture().fr, { n: 0 });
    await recorder.timedFetch(async () => { tv.advance(3); return new Response(); })(url, {});
    assert.deepEqual(recorder.capture().api, { op: "home_sections", ms: 3 });
});

test("Home row moves and top-bar focus survive the full remote path to a manual Settings report", () => {
    const tv = fakeTv();
    const collector = new DiagnosticsCollector({ appVersion: "test", tvModel: "TV" }, clock, new MemoryPublicStorage(), () => ({}), () => tv.env);
    collector.navigation.attach(source(tv));
    tv.press(KEY.down, { zone: "section:second" });
    for (let i = 0; i < 3; i++) tv.press(KEY.right, { zone: "section:second" });
    tv.press(KEY.up, { zone: "section:first" });
    tv.press(KEY.up, { zone: "nav" });
    tv.press(KEY.up, "stay");
    for (let i = 0; i < 5; i++) tv.press(KEY.right, { zone: "nav" });
    tv.press(KEY.right, "stay");
    tv.press(KEY.enter, { zone: "selector" });
    for (let i = 0; i < 2; i++) tv.press(KEY.down, { zone: "selector" });
    tv.press(KEY.enter);
    collector.setPrecedingScreen("home");
    const { snapshot } = collector.reportFor("app_ui");
    const steps = diagnosticsPayload(snapshot, { category: "app_ui" }).nav?.st ?? [];
    assert.ok(steps.includes("home:section:right:moved*3"), "include the row movement being reported");
    assert.ok(steps.includes("home:nav:right:stayed"), "include a top-bar focus problem");
    assert.ok(steps.length <= 8);
    assert.ok(!steps.join(" ").includes("section:second"));
    assert.ok(!steps.some(step => step.startsWith("home:selector:")));
    collector.recordAppError("TypeError");
    assert.ok(collector.snapshot().navigation?.st.includes("home:selector:down:moved*2"),
        "an error in the open menu still records that menu's live focus history");
    collector.clear();
    collector.setPrecedingScreen("home");
    assert.deepEqual(collector.reportFor("app_ui").snapshot.navigation?.st, []);
});

test("opening Settings freezes the Home navigation, and an app error freezes its own for both submission paths", () => {
    const tv = fakeTv();
    const storage = new MemoryPublicStorage();
    const collector = new DiagnosticsCollector({ appVersion: "0.6.0", tvModel: "QE65S95C" }, clock, storage, () => ({}), () => tv.env);
    assert.equal(collector.navigation.samplingEnabled, false, "sampling defaults off");
    let screen: NavigationScreen = "home";
    tv.focus.zone = "section:a";
    collector.navigation.attach(source(tv, () => screen));
    tv.press(KEY.right, { zone: "section:a" });
    tv.press(KEY.up, { zone: "nav" });
    tv.press(KEY.enter);
    collector.setPrecedingScreen("home");
    screen = "settings";
    tv.press(KEY.down, { zone: undefined });
    const manual = collector.reportFor("app_ui");
    assert.deepEqual(manual.snapshot.navigation?.st, ["home:section:right:moved", "home:section:up:zone:nav", "home:nav:enter:pressed"]);
    assert.equal(manual.snapshot.navigation?.sc, "home");
    assert.deepEqual(diagnosticsPayload(manual.snapshot, { category: "app_ui" }).nav, manual.snapshot.navigation);

    screen = "home";
    tv.press(KEY.left, "stay");
    collector.recordAppError("TypeError");
    tv.press(KEY.right, { zone: "section:b" });
    const auto = diagnosticsPayload(collector.snapshot(), { auto: true });
    const chosen = diagnosticsPayload(collector.reportFor("app_ui").snapshot, { category: "app_ui" });
    assert.deepEqual(chosen.nav, auto.nav, "manual and automatic carry the error's frozen evidence");
    assert.deepEqual(auto.nav?.st.slice(-2), ["settings:nav:down:pressed", "home:none:left:stayed"]);
    assert.equal(auto.nav?.st.includes("home:none:right:restored"), false, "presses after the error are not part of it");

    const homeError = diagnosticsFingerprint(collector.snapshot(), undefined, "app");
    screen = "details";
    collector.recordAppError("TypeError");
    assert.notEqual(diagnosticsFingerprint(collector.snapshot(), undefined, "app"), homeError, "a delivered Home error cannot suppress a Details error");

    collector.clear();
    assert.equal(collector.reportFor("app_ui").snapshot.navigation, undefined, "profile change clears frozen evidence");
    collector.setPrecedingScreen("home");
    assert.deepEqual(collector.reportFor("app_ui").snapshot.navigation?.st, [], "and the breadcrumb ring");

    storage.items.set(NAV_SAMPLING_KEY, "1");
    assert.equal(new DiagnosticsCollector({ appVersion: "0.6.0", tvModel: "QE65S95C" }, clock, storage, () => ({}), () => tv.env).navigation.samplingEnabled, true);
});
