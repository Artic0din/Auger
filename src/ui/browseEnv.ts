import { type Clock, systemClock } from "../api/clock.ts";
import type { FocusTarget } from "./browseFocus.ts";

export const SLOW_MS = 5000;

export interface FocusReader {
    inputRevision(): number;
    focused(): FocusTarget | undefined;
}

export const idleFocusReader: FocusReader = {
    inputRevision: () => 0,
    focused: () => undefined,
};

/** What a route asks the screen to focus after a paint. `enter` runs `host.focusDefault()`. */
export interface Paint {
    readonly focus?: FocusTarget | undefined;
    readonly enter?: true;
}

export type Arrival = "push" | "reveal" | "root" | "reshow";

export interface ForegroundSlot {
    readonly signal: AbortSignal;
    active(): boolean;
    finish(): void;
}

/** Single shared foreground read slot and slow-read timer across the Browse stack. */
export interface ForegroundRunner {
    begin(options?: { readonly quiet?: boolean; readonly onSlow?: () => void }): ForegroundSlot;
    abort(): void;
    busy(): boolean;
}

export function createForegroundRunner(clock: Clock = systemClock, slowMs = SLOW_MS): ForegroundRunner {
    let current: AbortController | undefined;
    let cancelSlow: () => void = () => undefined;

    const clearSlow = (): void => {
        cancelSlow();
        cancelSlow = () => undefined;
    };

    return {
        begin(options) {
            current?.abort();
            clearSlow();
            const controller = new AbortController();
            current = controller;
            if (options?.quiet !== true && options?.onSlow !== undefined) {
                const notifySlow = options.onSlow;
                cancelSlow = clock.schedule(() => {
                    if (current === controller && !controller.signal.aborted) notifySlow();
                }, slowMs);
            }
            return {
                signal: controller.signal,
                active: () => current === controller && !controller.signal.aborted,
                finish: () => {
                    if (current === controller) {
                        current = undefined;
                        clearSlow();
                    }
                },
            };
        },
        abort() {
            current?.abort();
            current = undefined;
            clearSlow();
        },
        busy() {
            return current !== undefined;
        },
    };
}

/** Structural lifecycle implemented by extracted Browse route modules. */
export interface RouteEntry {
    readonly kind: string;
    readonly root?: boolean;
    focus: FocusTarget | undefined;
    arrive(why: Arrival, focus?: FocusTarget): void;
    cover(): void;
    retire(): void;
    admissible?(): boolean;
    hasData(): boolean;
    markStale(): void;
}
