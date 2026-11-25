// App / Navigation evidence: the remote actions before a report, what focus did, and bounded performance
// context. Breadcrumbs always record; timing samples (long tasks, keydown-to-next-frame) run only when sampling is on.
// Every public value is an allowlisted word from shared/diagnostics-navigation.js or a bounded integer.

import { NAV_MAX_REPEAT, NAV_MAX_STEPS, navApiOperation, navZone } from "../shared/diagnostics-navigation.js";
import type { FetchLike } from "./api/http.ts";
import type { DiagnosticsScreen } from "./diagnostics.ts";
import { physicalKey, type RemoteKey } from "./ui/keys.ts";

/** Opt-in for continuous timing samples. Off until the S95C overhead comparison in docs/evidence/navigation-sampling.md passes. */
export const NAV_SAMPLING_KEY = "auger.diagnostics.navSampling";

export type NavigationScreen = DiagnosticsScreen | "settings";

/** The screen that owns the remote. Browse attaches one; nothing is recorded while none is attached. */
export interface NavigationSource {
    /** Undefined while browse is covered (playback, an overlay): presses there are not navigation. */
    screen(): NavigationScreen | undefined;
    /** Raw id of the focus zone holding focus; only its family is ever published. */
    zone(): string | undefined;
}

/** Public navigation record (`nav`) carried inside the v1 payload. "off": sampling disabled; "unavailable": the platform API is missing. */
export interface NavigationPayload {
    readonly nv: 1;
    readonly sc: NavigationScreen | "unknown";
    /** `screen:zone:action:outcome[:targetZone][*count]`, oldest first. */
    readonly st: readonly string[];
    readonly lt: { readonly n: number; readonly w?: number } | "off" | "unavailable";
    /** Estimate: keydown event time to the next animation frame callback, D-pad arrows only. */
    readonly fr: { readonly n: number; readonly p95?: number; readonly w?: number } | "off" | "unavailable";
    readonly dom: { readonly n: number; readonly img: number } | "unavailable";
    readonly cpu: number | "unavailable";
    readonly rm: boolean | "unavailable";
    /** Slowest recent /api/v2 request, time to response headers. */
    readonly api: { readonly op: string; readonly ms: number } | "none";
}

/** Where remote presses are heard: the window in the app, a fake in tests. */
export interface KeyEvents {
    addEventListener(type: "keydown", listener: (event: KeyboardEvent) => void, capture?: boolean): void;
    removeEventListener(type: "keydown", listener: (event: KeyboardEvent) => void, capture?: boolean): void;
}

/** Platform access, feature-detected once here so tests can stand in for a TV without an API. */
export interface NavigationEnvironment {
    now(): number;
    frame(callback: () => void): void;
    /** Starts a long-task observer and returns its stop, or undefined when the runtime has none. */
    observeLongTasks(report: (durationMs: number, endMs: number) => void): (() => void) | undefined;
    counts(): { readonly nodes: number; readonly images: number } | undefined;
    cores(): number | undefined;
    reducedMotion(): boolean | undefined;
    hidden(): boolean;
    /** Compared by identity only. */
    activeElement(): unknown;
    readonly keyTarget: KeyEvents;
    readonly visibilityTarget: VisibilityEvents;
}

export interface VisibilityEvents {
    addEventListener(type: "visibilitychange", listener: () => void): void;
    removeEventListener(type: "visibilitychange", listener: () => void): void;
}

const INERT_EVENTS: KeyEvents & VisibilityEvents = { addEventListener: () => undefined, removeEventListener: () => undefined };

const ACTIONS = new Set<RemoteKey>(["up", "down", "left", "right", "enter", "back", "play_pause", "play", "pause", "stop", "rewind", "fast_forward"]);
const ARROWS = new Set<RemoteKey>(["up", "down", "left", "right"]);
const MAX_FRAMES = 64;
const MAX_LONG_TASKS = 32;
const LONG_TASK_WINDOW_MS = 60_000;
const MAX_API = 16;
const MAX_MS = 60_000;

const ms = (value: number): number => Math.min(MAX_MS, Math.max(0, Math.round(value)));

export function browserNavigationEnvironment(): NavigationEnvironment {
    return {
        now: () => performance.now(),
        frame: callback => { requestAnimationFrame(() => callback()); },
        observeLongTasks: report => {
            try {
                if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes.includes("longtask")) return undefined;
                const observer = new PerformanceObserver(list => {
                    for (const entry of list.getEntries()) report(entry.duration, entry.startTime + entry.duration);
                });
                observer.observe({ type: "longtask" });
                return () => observer.disconnect();
            } catch {
                return undefined;
            }
        },
        counts: () => typeof document === "undefined" ? undefined : { nodes: document.getElementsByTagName("*").length, images: document.images.length },
        cores: () => {
            const cores = typeof navigator === "undefined" ? undefined : navigator.hardwareConcurrency;
            return typeof cores === "number" && Number.isInteger(cores) && cores > 0 ? Math.min(cores, 64) : undefined;
        },
        reducedMotion: () => typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)").matches : undefined,
        // Guarded so a collector built outside a page (node:test) still captures, with DOM fields unavailable.
        hidden: () => typeof document !== "undefined" && document.hidden,
        activeElement: () => typeof document === "undefined" ? null : document.activeElement,
        keyTarget: typeof window === "undefined" ? INERT_EVENTS : window,
        visibilityTarget: typeof document === "undefined" ? INERT_EVENTS : document,
    };
}

interface Pending {
    readonly action: RemoteKey;
    readonly screen: NavigationScreen;
    readonly zone: string | undefined;
    readonly element: unknown;
}

export class NavigationRecorder {
    private readonly sampling: boolean;
    private readonly makeEnv: () => NavigationEnvironment;
    private env: NavigationEnvironment | undefined;
    private source: NavigationSource | undefined;
    private pending: Pending | undefined;
    private readonly steps: { text: string; count: number }[] = [];
    private readonly frames: number[] = [];
    private framePending = false;
    private readonly longTasks: { end: number; duration: number }[] = [];
    /** Undefined until the observer was first wanted; false when the runtime has no long-task API. */
    private longTaskSupported: boolean | undefined;
    private stopLongTasks: (() => void) | undefined;
    private readonly api: { op: string; ms: number }[] = [];

    constructor(sampling: boolean, environment: () => NavigationEnvironment = browserNavigationEnvironment) {
        this.sampling = sampling;
        this.makeEnv = environment;
    }

    get samplingEnabled(): boolean {
        return this.sampling;
    }

    /** Starts recording the source's presses; replaces any earlier source. */
    attach(source: NavigationSource): void {
        if (this.source !== undefined) this.detach(this.source);
        const env = this.environment();
        this.source = source;
        env.keyTarget.addEventListener("keydown", this.onCapture, true);
        env.keyTarget.addEventListener("keydown", this.onBubble);
        env.visibilityTarget.addEventListener("visibilitychange", this.onVisibility);
        this.syncObserver(true);
    }

    detach(source: NavigationSource): void {
        if (this.source !== source) return;
        this.settle();
        this.source = undefined;
        const env = this.environment();
        env.keyTarget.removeEventListener("keydown", this.onCapture, true);
        env.keyTarget.removeEventListener("keydown", this.onBubble);
        env.visibilityTarget.removeEventListener("visibilitychange", this.onVisibility);
        this.syncObserver(false);
    }

    /** Ends a profile session's evidence. */
    reset(): void {
        this.pending = undefined;
        this.steps.length = 0;
        this.frames.length = 0;
        this.longTasks.length = 0;
        this.api.length = 0;
    }

    /** Times /api/v2 requests to response headers. Aborted requests are not timed: an abort measures the viewer, not the server. */
    timedFetch(fetch: FetchLike): FetchLike {
        return (url, init) => {
            const op = navApiOperation(url);
            if (op === undefined) return fetch(url, init);
            const env = this.environment();
            const started = env.now();
            return fetch(url, init).then(response => {
                this.pushApi(op, env.now() - started);
                return response;
            }, (error: unknown) => {
                if (init.signal?.aborted !== true) this.pushApi(op, env.now() - started);
                throw error;
            });
        };
    }

    /** Freezes the evidence now. Counts DOM nodes once here, never per key. */
    capture(): NavigationPayload {
        this.settle();
        const env = this.environment();
        const counts = env.counts();
        const cores = env.cores();
        const reducedMotion = env.reducedMotion();
        const slowest = this.api.reduce<{ op: string; ms: number } | undefined>((best, entry) => best === undefined || entry.ms > best.ms ? entry : best, undefined);
        return {
            nv: 1,
            sc: this.source?.screen() ?? "unknown",
            st: this.steps.map(step => step.count > 1 ? `${step.text}*${step.count}` : step.text),
            lt: this.longTaskSummary(env.now()),
            fr: this.frameSummary(),
            dom: counts === undefined ? "unavailable" : { n: Math.min(counts.nodes, 1_000_000), img: Math.min(counts.images, 100_000) },
            cpu: cores ?? "unavailable",
            rm: reducedMotion ?? "unavailable",
            api: slowest === undefined ? "none" : { op: slowest.op, ms: slowest.ms },
        };
    }

    private environment(): NavigationEnvironment {
        this.env ??= this.makeEnv();
        return this.env;
    }

    private longTaskSummary(now: number): NavigationPayload["lt"] {
        if (!this.sampling) return "off";
        if (this.longTaskSupported === false) return "unavailable";
        const recent = this.longTasks.filter(task => now - task.end <= LONG_TASK_WINDOW_MS);
        if (recent.length === 0) return { n: 0 };
        return { n: recent.length, w: ms(Math.max(...recent.map(task => task.duration))) };
    }

    private frameSummary(): NavigationPayload["fr"] {
        if (!this.sampling) return "off";
        if (this.frames.length === 0) return { n: 0 };
        const sorted = [...this.frames].sort((a, b) => a - b);
        const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
        return { n: sorted.length, p95: ms(p95), w: ms(sorted[sorted.length - 1] ?? 0) };
    }

    private readonly onCapture = (event: KeyboardEvent): void => {
        this.settle();
        const key = physicalKey(event);
        if (key === undefined || !ACTIONS.has(key)) return;
        const source = this.source;
        const screen = source?.screen();
        this.syncObserver(screen !== undefined);
        if (source === undefined || screen === undefined) return;
        const env = this.environment();
        this.pending = { action: key, screen, zone: source.zone(), element: env.activeElement() };
        if (!this.sampling || !ARROWS.has(key) || this.framePending) return;
        // A key's timeStamp shares performance.now()'s origin in Chromium; an implausible one falls back to now.
        const now = env.now();
        const start = event.timeStamp > 0 && event.timeStamp <= now ? event.timeStamp : now;
        this.framePending = true;
        env.frame(() => {
            this.framePending = false;
            this.frames.push(env.now() - start);
            if (this.frames.length > MAX_FRAMES) this.frames.shift();
        });
    };

    /** The app's handlers ran during this event's dispatch; a press they stopped settles at the next press or capture instead. */
    private readonly onBubble = (): void => this.settle();

    private readonly onVisibility = (): void => this.syncObserver(this.source?.screen() !== undefined);

    private settle(): void {
        const pending = this.pending;
        if (pending === undefined) return;
        this.pending = undefined;
        const env = this.environment();
        const from = navZone(pending.zone);
        let outcome: string = "pressed";
        // Settings keeps its own focus host, so no zone is known there and an arrow's outcome cannot be judged.
        if (ARROWS.has(pending.action) && pending.screen !== "settings") {
            const to = this.source?.zone();
            if (env.activeElement() === pending.element) outcome = "stayed";
            else if (to === undefined) outcome = "lost";
            else if (pending.zone === undefined) outcome = "restored";
            else if (to === pending.zone) outcome = "moved";
            else outcome = `zone:${navZone(to)}`;
        }
        this.pushStep(`${pending.screen}:${from}:${pending.action}:${outcome}`);
    }

    private pushStep(text: string): void {
        const last = this.steps[this.steps.length - 1];
        if (last?.text === text) {
            last.count = Math.min(NAV_MAX_REPEAT, last.count + 1);
            return;
        }
        this.steps.push({ text, count: 1 });
        if (this.steps.length > NAV_MAX_STEPS) this.steps.shift();
    }

    private pushApi(op: string, duration: number): void {
        this.api.push({ op, ms: ms(duration) });
        if (this.api.length > MAX_API) this.api.shift();
    }

    /** Long-task observation runs only while sampling is on, a browse screen owns the remote and the app is visible. */
    private syncObserver(active: boolean): void {
        const wanted = this.sampling && active && this.source !== undefined && !this.environment().hidden();
        if (wanted && this.stopLongTasks === undefined && this.longTaskSupported !== false) {
            this.stopLongTasks = this.environment().observeLongTasks((duration, end) => {
                if (this.source?.screen() === undefined) return;
                this.longTasks.push({ end, duration });
                if (this.longTasks.length > MAX_LONG_TASKS) this.longTasks.shift();
            });
            this.longTaskSupported = this.stopLongTasks !== undefined;
        } else if (!wanted && this.stopLongTasks !== undefined) {
            this.stopLongTasks();
            this.stopLongTasks = undefined;
        }
    }
}
