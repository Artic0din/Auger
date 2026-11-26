// PlayerLoadingSpinner.swift (silo-apple main 3289bedb): 500 ms show delay and 500 ms minimum visible duration.
import type { Clock } from "../api/clock.ts";

/** A stall shorter than this shows nothing (`PlayerLoadingSpinner.showDelay`). */
export const SPINNER_SHOW_DELAY_MS = 500;
/** Once shown, the spinner stays at least this long (`PlayerLoadingSpinner.minimumVisible`). */
export const SPINNER_MIN_VISIBLE_MS = 500;

/**
 * Drives the loading spinner's visibility from continuous activity: on after
 * `SPINNER_SHOW_DELAY_MS`, and off no sooner than `SPINNER_MIN_VISIBLE_MS` after appearing.
 */
export class LoadingSpinnerTimer {
    private readonly clock: Clock;
    private readonly onChange: (visible: boolean) => void;
    private active = false;
    private shown = false;
    private shownAt: number | undefined;
    private cancelTimer: (() => void) | undefined;

    constructor(clock: Clock, onChange: (visible: boolean) => void) {
        this.clock = clock;
        this.onChange = onChange;
    }

    get visible(): boolean {
        return this.shown;
    }

    setActive(next: boolean): void {
        if (next === this.active) return;
        this.active = next;
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        if (next) {
            if (this.shown) return;
            this.cancelTimer = this.clock.schedule(() => {
                this.cancelTimer = undefined;
                if (!this.active) return;
                this.shownAt = this.clock.now();
                this.shown = true;
                this.onChange(true);
            }, SPINNER_SHOW_DELAY_MS);
            return;
        }
        if (!this.shown) return;
        const elapsed = this.shownAt === undefined ? SPINNER_MIN_VISIBLE_MS : Math.max(0, this.clock.now() - this.shownAt);
        const remaining = Math.max(0, SPINNER_MIN_VISIBLE_MS - elapsed);
        if (remaining === 0) {
            this.shownAt = undefined;
            this.shown = false;
            this.onChange(false);
            return;
        }
        this.cancelTimer = this.clock.schedule(() => {
            this.cancelTimer = undefined;
            if (this.active) return;
            this.shownAt = undefined;
            this.shown = false;
            this.onChange(false);
        }, remaining);
    }

    /** Immediately hides the spinner and cancels pending show/hide timers. */
    reset(): void {
        this.cancelTimer?.();
        this.cancelTimer = undefined;
        const wasVisible = this.shown;
        this.active = false;
        this.shown = false;
        this.shownAt = undefined;
        if (wasVisible) this.onChange(false);
    }
}
