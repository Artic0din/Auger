import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import { AudiobookSleepTimer, SLEEP_TIMER_MINUTES } from "../../src/player/audiobookSleepTimer.ts";
import { ManualClock } from "./support/clock.ts";

test("sleep timer offers the Apple TV audiobook presets and starts inactive", () => {
    assert.deepEqual(SLEEP_TIMER_MINUTES, [15, 30, 60]);
    const clock = new ManualClock();
    const timer = new AudiobookSleepTimer(clock, () => undefined);
    assert.equal(timer.active, false);
    assert.equal(timer.remainingSeconds, 0);
    assert.equal(clock.scheduled, 0);
});

test("sleep timer counts down once per second, fires at zero, and leaves no lingering timers", async () => {
    const clock = new ManualClock();
    const fired: number[] = [];
    const changes: { active: boolean; remainingSeconds: number }[] = [];
    const timer = new AudiobookSleepTimer(
        clock,
        () => fired.push(clock.now()),
        snapshot => changes.push(snapshot),
    );
    const start = clock.now();
    timer.start(15);
    assert.equal(timer.active, true);
    assert.equal(timer.remainingSeconds, 900);
    assert.equal(clock.scheduled, 1);

    await clock.advance(1000);
    assert.equal(timer.remainingSeconds, 899);
    assert.equal(fired.length, 0);

    await clock.advance(898 * 1000);
    assert.equal(timer.active, true);
    assert.equal(timer.remainingSeconds, 1);
    assert.equal(fired.length, 0);

    await clock.advance(1000);
    assert.equal(fired.length, 1);
    assert.equal(fired[0], start + 900 * 1000);
    assert.equal(timer.active, false);
    assert.equal(timer.remainingSeconds, 0);
    assert.equal(clock.scheduled, 0);
    assert.equal(changes.at(-1)?.active, false);
    assert.equal(changes.at(-1)?.remainingSeconds, 0);
});

test("starting a new interval replaces the old timer and zero/cancel clears it", async () => {
    const clock = new ManualClock();
    let fires = 0;
    const timer = new AudiobookSleepTimer(clock, () => { fires++; });
    timer.start(30);
    await clock.advance(5000);
    assert.equal(timer.remainingSeconds, 1795);

    timer.start(15);
    assert.equal(timer.active, true);
    assert.equal(timer.remainingSeconds, 900);
    assert.equal(clock.scheduled, 1);

    timer.start(0);
    assert.equal(timer.active, false);
    assert.equal(timer.remainingSeconds, 0);
    assert.equal(clock.scheduled, 0);

    timer.start(15);
    timer.cancel();
    assert.equal(timer.active, false);
    assert.equal(timer.remainingSeconds, 0);
    assert.equal(clock.scheduled, 0);

    await clock.advance(60 * 60 * 1000);
    assert.equal(fires, 0);
});

test("delayed timer callback measures expiry and remaining time against Clock.now()", () => {
    let currentMs = Date.parse("2026-01-02T03:04:05.678Z");
    const pending: { readonly fn: () => void; readonly delayMs: number; cancelled: boolean }[] = [];
    const clock: Clock = {
        now: () => currentMs,
        schedule(fn, ms) {
            const entry = { fn, delayMs: ms, cancelled: false };
            pending.push(entry);
            return () => { entry.cancelled = true; };
        },
    };
    const activeEntries = () => pending.filter(entry => !entry.cancelled);
    const deliverNext = (): void => {
        const next = activeEntries()[0];
        assert.ok(next !== undefined, "expected a scheduled callback");
        next.cancelled = true;
        next.fn();
    };

    let fired = 0;
    const timer = new AudiobookSleepTimer(clock, () => { fired++; });

    timer.start(15);
    assert.equal(timer.active, true);
    assert.equal(timer.remainingSeconds, 900);
    assert.equal(activeEntries().length, 1);

    currentMs += 300_000;
    deliverNext();
    assert.equal(timer.active, true);
    assert.equal(timer.remainingSeconds, 600);
    assert.equal(fired, 0);

    currentMs += 900_000;
    deliverNext();
    assert.equal(fired, 1);
    assert.equal(timer.active, false);
    assert.equal(timer.remainingSeconds, 0);
    assert.equal(activeEntries().length, 0);

    timer.start(15);
    currentMs += 1250;
    deliverNext();
    assert.equal(timer.remainingSeconds, 899);
    assert.equal(activeEntries().length, 1);
    assert.equal(activeEntries()[0]?.delayMs, 750);

    currentMs += 750;
    deliverNext();
    assert.equal(timer.remainingSeconds, 898);
});

test("reconcile handles external updates, backward clock jumps, no-op fire, and onFire re-entrancy", () => {
    let currentMs = Date.parse("2026-01-02T03:04:05.678Z");
    const pending: { readonly fn: () => void; readonly delayMs: number; cancelled: boolean }[] = [];
    const clock: Clock = {
        now: () => currentMs,
        schedule(fn, ms) {
            const entry = { fn, delayMs: ms, cancelled: false };
            pending.push(entry);
            return () => { entry.cancelled = true; };
        },
    };
    const activeEntries = () => pending.filter(entry => !entry.cancelled);

    const changes: { active: boolean; remainingSeconds: number }[] = [];
    let fires = 0;
    const timer = new AudiobookSleepTimer(
        clock,
        () => { fires++; },
        snapshot => changes.push(snapshot),
    );

    timer.start(15);
    changes.length = 0;

    // Direct reconcile cancels old timer and emits updated remaining time once.
    currentMs += 300_000;
    assert.equal(timer.reconcile(), false);
    assert.equal(timer.remainingSeconds, 600);
    assert.equal(activeEntries().length, 1);
    assert.equal(changes.length, 1);

    // Calling reconcile again within the same second suppresses duplicate onChange.
    currentMs += 200;
    assert.equal(timer.reconcile(), false);
    assert.equal(changes.length, 1);
    assert.equal(activeEntries().length, 1);
    assert.equal(activeEntries()[0]?.delayMs, 800);

    // Backward wall-clock jump never inflates remainingSeconds and rebases deadline cleanly.
    currentMs -= 30_000;
    assert.equal(timer.reconcile(), false);
    assert.equal(timer.remainingSeconds, 600);
    currentMs += 600_000;
    assert.equal(timer.reconcile(), true);
    assert.equal(fires, 1);
    assert.equal(timer.active, false);

    // reconcile(false) clears overdue timer without calling onFire().
    timer.start(15);
    changes.length = 0;
    currentMs += 900_000;
    assert.equal(timer.reconcile(false), true);
    assert.equal(fires, 1);
    assert.equal(timer.active, false);
    assert.deepEqual(changes, [{ active: false, remainingSeconds: 0 }]);

    // onFire calling start() then cancel() emits { active: false, remainingSeconds: 0 } only once.
    const reentrantChanges: { active: boolean; remainingSeconds: number }[] = [];
    let reentrantTimer!: AudiobookSleepTimer;
    reentrantTimer = new AudiobookSleepTimer(
        clock,
        () => {
            reentrantTimer.start(15);
            reentrantTimer.cancel();
        },
        snapshot => reentrantChanges.push(snapshot),
    );
    reentrantTimer.start(15);
    reentrantChanges.length = 0;
    currentMs += 900_000;
    reentrantTimer.reconcile();
    assert.deepEqual(reentrantChanges, [
        { active: true, remainingSeconds: 900 },
        { active: false, remainingSeconds: 0 },
    ]);

    // onFire calling start(0) still emits { active: false, remainingSeconds: 0 } cleanly.
    const zeroChanges: { active: boolean; remainingSeconds: number }[] = [];
    let zeroTimer!: AudiobookSleepTimer;
    zeroTimer = new AudiobookSleepTimer(
        clock,
        () => { zeroTimer.start(0); },
        snapshot => zeroChanges.push(snapshot),
    );
    zeroTimer.start(15);
    zeroChanges.length = 0;
    currentMs += 900_000;
    zeroTimer.reconcile();
    assert.deepEqual(zeroChanges, [{ active: false, remainingSeconds: 0 }]);
});
