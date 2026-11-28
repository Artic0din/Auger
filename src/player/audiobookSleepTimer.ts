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
    private deadlineMs: number | undefined;
    private cancelStep: (() => void) | undefined;
    private generation = 0;

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
        const seconds = Number.isFinite(minutes) ? Math.round(minutes) * 60 : 0;
        if (seconds <= 0) {
            this.cancel();
            return;
        }
        this.clearTimer();
        this.activeState = true;
        this.remaining = seconds;
        this.deadlineMs = this.clock.now() + seconds * 1000;
        this.scheduleTick(seconds * 1000);
        this.onChange?.(this.snapshot());
    }

    cancel(): void {
        if (!this.activeState && this.remaining === 0 && this.cancelStep === undefined) return;
        this.clearTimer();
        this.onChange?.(this.snapshot());
    }

    /** Recomputes remaining time against `Clock.now()`, expiring immediately if the deadline has passed. */
    reconcile(fireOnExpiry = true): boolean {
        if (!this.activeState || this.deadlineMs === undefined) return false;
        const now = this.clock.now();
        let remainingMs = this.deadlineMs - now;
        const maxRemainingMs = this.remaining * 1000;
        if (remainingMs > maxRemainingMs) {
            this.deadlineMs = now + maxRemainingMs;
            remainingMs = maxRemainingMs;
        }
        if (remainingMs <= 0) {
            this.clearTimer();
            const gen = this.generation;
            if (fireOnExpiry) {
                this.onFire();
            }
            if (this.generation === gen) {
                this.onChange?.(this.snapshot());
            }
            return true;
        }
        const nextRemaining = Math.ceil(remainingMs / 1000);
        const changed = nextRemaining !== this.remaining;
        this.remaining = nextRemaining;
        this.cancelStep?.();
        this.cancelStep = undefined;
        this.scheduleTick(remainingMs);
        if (changed) {
            this.onChange?.(this.snapshot());
        }
        return false;
    }

    private clearTimer(): void {
        this.generation += 1;
        this.cancelStep?.();
        this.cancelStep = undefined;
        this.activeState = false;
        this.remaining = 0;
        this.deadlineMs = undefined;
    }

    private scheduleTick(remainingMs: number): void {
        const nextRemaining = Math.ceil(remainingMs / 1000);
        const delayMs = Math.max(1, Math.ceil(remainingMs - (nextRemaining - 1) * 1000));
        this.cancelStep = this.clock.schedule(() => {
            this.cancelStep = undefined;
            this.reconcile();
        }, delayMs);
    }
}
