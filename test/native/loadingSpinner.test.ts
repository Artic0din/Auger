import assert from "node:assert/strict";
import { test } from "node:test";
import type { Clock } from "../../src/api/clock.ts";
import { LoadingSpinnerTimer, SPINNER_MIN_VISIBLE_MS, SPINNER_SHOW_DELAY_MS } from "../../src/player/loadingSpinner.ts";

class FakeClock implements Clock {
    private current = 1000;
    private nextId = 1;
    private readonly timers = new Map<number, { at: number; run: () => void }>();

    now(): number { return this.current; }

    schedule(run: () => void, ms: number): () => void {
        const id = this.nextId++;
        this.timers.set(id, { at: this.current + Math.max(0, ms), run });
        return () => { this.timers.delete(id); };
    }

    advance(ms: number): void {
        const target = this.current + ms;
        while (true) {
            let next: { id: number; at: number; run: () => void } | undefined;
            for (const [id, entry] of this.timers) {
                if (entry.at <= target && (next === undefined || entry.at < next.at)) next = { id, ...entry };
            }
            if (next === undefined) break;
            this.timers.delete(next.id);
            this.current = next.at;
            next.run();
        }
        this.current = target;
    }
}

test("stalls shorter than 500ms never show the spinner", () => {
    const clock = new FakeClock();
    const events: boolean[] = [];
    const timer = new LoadingSpinnerTimer(clock, visible => events.push(visible));
    timer.setActive(true);
    clock.advance(SPINNER_SHOW_DELAY_MS - 1);
    assert.equal(timer.visible, false);
    timer.setActive(false);
    clock.advance(1000);
    assert.equal(timer.visible, false);
    assert.deepEqual(events, []);
});

test("continuous activity shows at 500ms and holds for at least 500ms after appearing", () => {
    const clock = new FakeClock();
    const events: boolean[] = [];
    const timer = new LoadingSpinnerTimer(clock, visible => events.push(visible));
    timer.setActive(true);
    clock.advance(SPINNER_SHOW_DELAY_MS);
    assert.equal(timer.visible, true);
    assert.deepEqual(events, [true]);

    // Ends 150ms after appearing: must stay visible for the remaining 350ms.
    clock.advance(150);
    timer.setActive(false);
    assert.equal(timer.visible, true);
    clock.advance(SPINNER_MIN_VISIBLE_MS - 151);
    assert.equal(timer.visible, true);
    clock.advance(1);
    assert.equal(timer.visible, false);
    assert.deepEqual(events, [true, false]);
});

test("re-activating during minimum-visible hold cancels hiding and keeps spinner visible", () => {
    const clock = new FakeClock();
    const events: boolean[] = [];
    const timer = new LoadingSpinnerTimer(clock, visible => events.push(visible));
    timer.setActive(true);
    clock.advance(SPINNER_SHOW_DELAY_MS);
    clock.advance(100);
    timer.setActive(false);
    clock.advance(200);
    timer.setActive(true);
    clock.advance(1000);
    assert.equal(timer.visible, true);
    assert.deepEqual(events, [true]);

    // After having been visible well past 500ms, deactivating hides immediately.
    timer.setActive(false);
    assert.equal(timer.visible, false);
    assert.deepEqual(events, [true, false]);
});

test("reset hides immediately and cancels pending show and hide timers", () => {
    const clock = new FakeClock();
    const events: boolean[] = [];
    const timer = new LoadingSpinnerTimer(clock, visible => events.push(visible));
    timer.setActive(true);
    clock.advance(250);
    timer.reset();
    clock.advance(1000);
    assert.equal(timer.visible, false);
    assert.deepEqual(events, []);

    timer.setActive(true);
    clock.advance(SPINNER_SHOW_DELAY_MS);
    assert.equal(timer.visible, true);
    timer.reset();
    assert.equal(timer.visible, false);
    assert.deepEqual(events, [true, false]);
});
