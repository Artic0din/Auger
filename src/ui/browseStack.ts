import { systemClock, type Clock } from "../api/clock.ts";
import type { NativeSession } from "../session/session.ts";
import { createForegroundRunner, type Arrival, type ForegroundRunner, type Paint, type RouteEntry } from "./browseEnv.ts";
import type { FocusTarget } from "./browseFocus.ts";
import type { BrowseSignal } from "./browseSignals.ts";

export interface StackEntry {
    focus: FocusTarget | undefined;
}

export type CoverAction = "push" | "pop" | "replace" | "selectRoot" | "clearPersonal" | "reset";

export interface StackAdapter<T extends StackEntry> {
    hasData(entry: T): boolean;
    admissible?(entry: T): boolean;
    isRoot?(entry: T): boolean;
    isPersonalRoot?(entry: T): boolean;
    isProfileMenu?(entry: T): boolean;
    tabFocus?(entry: T): FocusTarget | undefined;
    onBeforeCover?(entry: T, next: T | undefined, action: CoverAction): void;
    onBeforeReveal?(revealed: T, popped: T): void;
    cover(entry: T): void;
    retire(entry: T): void;
    arrive(entry: T, why: Arrival, focus: FocusTarget | undefined, enter: boolean): void;
    deliverSignal?(entry: T, signal: BrowseSignal, visible: boolean, inStack: boolean): void;
}

export interface BrowseStackOptions<T extends StackEntry> {
    readonly session: NativeSession;
    readonly home: T;
    readonly clock?: Clock;
    readonly foreground?: ForegroundRunner;
    readonly adapter?: StackAdapter<T>;
    readonly onArrive?: (entry: T, paint: Paint) => void;
    readonly onDispose?: () => void;
}

export interface BrowseStack<T extends StackEntry = RouteEntry> {
    readonly foreground: ForegroundRunner;
    readonly disposed: boolean;
    top(): T | undefined;
    entries(): readonly T[];
    root(key: string): T | undefined;
    setRoot(key: string, entry: T): void;
    deleteRoot(key: string): boolean;
    resetRoots(keep: readonly (readonly [string, T])[]): void;
    each(fn: (entry: T, visible: boolean, inStack: boolean) => void): void;
    publish(signal: BrowseSignal): void;
    start(focus?: FocusTarget): void;
    push(next: T, focus?: FocusTarget): void;
    pop(): T | undefined;
    popDiscard(): T | undefined;
    replaceTop(next: T, focus?: FocusTarget): T | undefined;
    clearPersonalRoot(): boolean;
    selectRoot(route: T, focus?: FocusTarget, enter?: boolean): void;
    resetToHome(focus?: FocusTarget, beforeArrive?: () => void): void;
    closeInadmissible(): boolean;
    reshow(focus?: FocusTarget): void;
    dispose(): void;
}

function routeEntryAdapter(onArrive?: (entry: RouteEntry, paint: Paint) => void): StackAdapter<RouteEntry> {
    return {
        hasData: entry => entry.hasData(),
        admissible: entry => entry.admissible?.() ?? true,
        isRoot: entry => entry.root === true,
        isPersonalRoot: entry => entry.root === true && entry.kind !== "home",
        isProfileMenu: entry => entry.root === true && entry.kind !== "home",
        cover: entry => entry.cover(),
        retire: entry => entry.retire(),
        arrive: (entry, why, focus, enter) => {
            entry.arrive(why, focus);
            onArrive?.(entry, enter ? { focus, enter: true } : { focus });
        },
        deliverSignal: (entry, signal, visible, inStack) => {
            if (signal.kind === "playback.resumed" && !inStack) return;
            entry.onSignal?.(signal, visible);
        },
    };
}

/**
 * DOM-free coordinator for the Browse route stack, retained root tabs, shared
 * single-slot foreground runner, deduplicated signal traversal, capability-loss
 * closing, and Authority teardown.
 */
export function createBrowseStack(options: BrowseStackOptions<RouteEntry>): BrowseStack<RouteEntry>;
export function createBrowseStack<T extends StackEntry>(options: BrowseStackOptions<T> & { readonly adapter: StackAdapter<T> }): BrowseStack<T>;
export function createBrowseStack<T extends StackEntry>(options: BrowseStackOptions<T>): BrowseStack<T> {
    const clock = options.clock ?? systemClock;
    const foreground = options.foreground ?? createForegroundRunner(clock);
    const adapter: StackAdapter<T> = options.adapter
        ?? (routeEntryAdapter(options.onArrive as ((entry: RouteEntry, paint: Paint) => void) | undefined) as unknown as StackAdapter<T>);
    const home = options.home;
    const roots = new Map<string, T>([["home", home]]);
    let stack: T[] = [home];
    let disposed = false;

    const top = (): T | undefined => stack[stack.length - 1];

    const isAdmissible = (entry: T): boolean => adapter.admissible === undefined || adapter.admissible(entry);

    const retireUnretained = (entries: readonly T[]): void => {
        const retained = new Set(roots.values());
        for (const entry of entries) {
            if (!retained.has(entry)) adapter.retire(entry);
        }
    };

    const each = (fn: (entry: T, visible: boolean, inStack: boolean) => void): void => {
        const current = top();
        const stackSet = new Set(stack);
        for (const entry of new Set<T>([...roots.values(), ...stack])) {
            fn(entry, entry === current, stackSet.has(entry));
        }
    };

    const closeInadmissible = (): boolean => {
        if (disposed) return false;
        const active = top();
        if (active === undefined || isAdmissible(active)) return false;
        adapter.cover(active);
        foreground.abort();
        let closedRoot = false;
        while (stack.length > 1) {
            const candidate = top();
            if (candidate === undefined || isAdmissible(candidate)) break;
            const removed = stack.pop()!;
            if (adapter.isRoot?.(removed) === true) closedRoot = true;
            adapter.retire(removed);
        }
        const origin = top();
        if (origin !== undefined) {
            adapter.arrive(origin, "push", closedRoot ? undefined : origin.focus, closedRoot && adapter.hasData(origin));
        }
        return true;
    };

    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        stopAuthority();
        foreground.abort();
        const active = top();
        if (active !== undefined) adapter.cover(active);
        const all = new Set<T>([...roots.values(), ...stack]);
        stack = [];
        roots.clear();
        for (const entry of all) adapter.retire(entry);
        options.onDispose?.();
    };

    const stopAuthority = options.session.onAuthorityChange(dispose);

    return {
        foreground,
        get disposed() { return disposed; },
        top,
        entries: () => stack,
        root: key => roots.get(key),
        setRoot(key, entry) {
            if (!disposed) roots.set(key, entry);
        },
        deleteRoot(key) {
            return roots.delete(key);
        },
        resetRoots(keep) {
            if (disposed) return;
            const keepSet = new Set(keep.map(([, entry]) => entry));
            const stackSet = new Set(stack);
            const dropped = [...roots.values()].filter(entry => !keepSet.has(entry) && !stackSet.has(entry));
            roots.clear();
            for (const [key, entry] of keep) roots.set(key, entry);
            for (const entry of dropped) adapter.retire(entry);
        },
        each,
        publish(signal) {
            if (disposed) return;
            each((entry, visible, inStack) => {
                adapter.deliverSignal?.(entry, signal, visible, inStack);
            });
        },
        start(focus) {
            if (disposed) return;
            const first = top();
            if (first !== undefined) adapter.arrive(first, "push", focus, false);
        },
        push(next, focus) {
            if (disposed) return;
            const current = top();
            if (current !== undefined) {
                adapter.onBeforeCover?.(current, next, "push");
                adapter.cover(current);
            }
            foreground.abort();
            stack.push(next);
            adapter.arrive(next, "push", focus, false);
        },
        pop() {
            if (disposed || stack.length <= 1) return undefined;
            const active = stack[stack.length - 1]!;
            const under = stack[stack.length - 2];
            adapter.onBeforeCover?.(active, under, "pop");
            adapter.cover(active);
            foreground.abort();
            stack.pop();
            retireUnretained([active]);
            const current = top();
            if (current === undefined) return active;
            if (!isAdmissible(current)) {
                closeInadmissible();
                return active;
            }
            adapter.onBeforeReveal?.(current, active);
            const fromProfileMenu = adapter.isProfileMenu?.(active) === true;
            const focus = fromProfileMenu ? (adapter.tabFocus?.(current) ?? current.focus) : current.focus;
            adapter.arrive(current, "reveal", focus, false);
            return active;
        },
        popDiscard() {
            if (disposed || stack.length <= 1) return undefined;
            return stack.pop();
        },
        replaceTop(next, focus) {
            if (disposed) return undefined;
            const active = top();
            if (active !== undefined) {
                adapter.onBeforeCover?.(active, next, "replace");
                adapter.cover(active);
            }
            foreground.abort();
            const removed = stack.pop();
            if (removed !== undefined) retireUnretained([removed]);
            stack.push(next);
            adapter.arrive(next, "push", focus, false);
            return removed;
        },
        clearPersonalRoot() {
            if (disposed) return false;
            const index = stack.findIndex((entry, idx) => idx >= 1 && adapter.isPersonalRoot?.(entry) === true);
            if (index < 1) return false;
            const current = top();
            if (current !== undefined) {
                adapter.onBeforeCover?.(current, stack[index - 1], "clearPersonal");
                adapter.cover(current);
            }
            foreground.abort();
            const removed = stack.slice(index);
            stack.length = index;
            retireUnretained(removed);
            return true;
        },
        selectRoot(route, focus, enter = false) {
            if (disposed) return;
            const current = top();
            if (current !== undefined) {
                adapter.onBeforeCover?.(current, route, "selectRoot");
                adapter.cover(current);
            }
            foreground.abort();
            const covered = stack;
            stack = route === home ? [home] : [home, route];
            retireUnretained(covered);
            adapter.arrive(route, "push", focus, enter);
        },
        resetToHome(focus, beforeArrive) {
            if (disposed) return;
            const current = top();
            if (current !== undefined) {
                adapter.onBeforeCover?.(current, home, "reset");
                adapter.cover(current);
            }
            foreground.abort();
            const covered = stack;
            stack = [home];
            retireUnretained(covered);
            beforeArrive?.();
            adapter.arrive(home, "push", focus, false);
        },
        closeInadmissible,
        reshow(focus) {
            if (disposed) return;
            const current = top();
            if (current !== undefined) adapter.arrive(current, "reshow", focus ?? current.focus, false);
        },
        dispose,
    };
}
