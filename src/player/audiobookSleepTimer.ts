import type { Clock } from "../api/clock.ts";

/** Preset sleep timer intervals (minutes), matching `AudioFullPlayerView` on Apple TV. */
export const SLEEP_TIMER_MINUTES = [15, 30, 60] as const;

export interface SleepTimerSnapshot {
    readonly active: boolean;
    readonly remainingSeconds: number;
}

/**
 * Session-scoped sleep timer: counts down once per second using `Clock` and fires `onFire`
 * when the remaining seconds reach zero, cancelling cleanly on replacement or teardown.
 */
export class AudiobookSleepTimer {
    private readonly clock: Clock;
    private readonly onFire: () => void;
    private readonly onChange: ((snapshot: SleepTimerSnapshot) => void) | undefined;
    private activeState = false;
    private remaining = 0;
    private cancelStep: (() => void) | undefined;

    constructor(clock: Clock, onFire: () => void, onChange?: (snapshot: SleepTimerSnapshot) => void) {
        this.clock = clock;
        this.onFire = onFire;
        this.onChange = onChange;
    }

    get active(): boolean {
        return this.activeState;
    }

    get remainingSeconds(): number {
        return this.remaining;
    }

    snapshot(): SleepTimerSnapshot {
        return { active: this.activeState, remainingSeconds: this.remaining };
    }

    /** Starts or replaces the countdown; non-positive minutes cancel instead. */
    start(minutes: number): void {
        const wasActive = this.activeState;
        const previousRemaining = this.remaining;
        this.clearTimer();
        if (!Number.isFinite(minutes) || minutes <= 0) {
            if (wasActive || previousRemaining !== 0) {
                this.onChange?.(this.snapshot());
            }
            return;
        }
        this.activeState = true;
        this.remaining = Math.round(minutes) * 60;
        if (this.remaining <= 0) {
            this.activeState = false;
            this.remaining = 0;
            if (wasActive || previousRemaining !== 0) {
                this.onChange?.(this.snapshot());
            }
            return;
        }
        this.onChange?.(this.snapshot());
        this.scheduleTick();
    }

    cancel(): void {
        if (!this.activeState && this.remaining === 0 && this.cancelStep === undefined) return;
        this.clearTimer();
        this.onChange?.(this.snapshot());
    }

    private clearTimer(): void {
        this.cancelStep?.();
        this.cancelStep = undefined;
        this.activeState = false;
        this.remaining = 0;
    }

    private scheduleTick(): void {
        this.cancelStep = this.clock.schedule(() => {
            this.cancelStep = undefined;
            if (!this.activeState) return;
            if (this.remaining > 1) {
                this.remaining -= 1;
                this.onChange?.(this.snapshot());
                this.scheduleTick();
                return;
            }
            this.remaining = 0;
            this.activeState = false;
            this.onFire();
            this.onChange?.(this.snapshot());
        }, 1000);
    }
}
