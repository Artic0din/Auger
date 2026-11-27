import assert from "node:assert/strict";
import { test } from "node:test";
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
