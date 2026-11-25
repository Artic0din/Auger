import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import type { SettingValue, SettingsKey } from "../../src/contracts/v2/settings.ts";
import {
    DEFAULT_DEBOUNCE_MS,
    DEFAULT_RETRY_POLICY,
    PlayerSettingsFlusher,
    retryDelayMs,
    type PlayerSettingsTransport,
    type PlayerSettingWriteScope,
} from "../../src/player/playerSettingsFlusher.ts";
import { ManualClock } from "./support/clock.ts";

const AUTO_PLAY: SettingsKey = "playback.auto_play_next";

function fakeStorage() {
    const store = new Map<string, string>();
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
        removeItem: (key: string) => { store.delete(key); },
    };
}

function transientError(): ApiError {
    return new ApiError({ kind: "network" });
}

function permanentError(): ApiError {
    return new ApiError({ kind: "problem", problem: { id: "forbidden", status: 403, title: "Forbidden", detail: "Denied", instance: "", errors: [] }, retryAfterSeconds: undefined });
}

test("debounce waits 750 ms and coalesces rapid edits to the latest value (#810)", async () => {
    const clock = new ManualClock();
    const sent: Array<{ key: SettingsKey; scope: PlayerSettingWriteScope; value: SettingValue }> = [];
    const transport: PlayerSettingsTransport = {
        putValue: async (key, scope, value) => { sent.push({ key, scope, value }); },
        effectiveValues: async () => new Map(),
    };
    const flusher = new PlayerSettingsFlusher(transport, clock);
    try {
        flusher.enqueue(AUTO_PLAY, false);
        assert.equal(flusher.unsettledValue(AUTO_PLAY), false);
        await clock.advance(DEFAULT_DEBOUNCE_MS - 1);
        assert.equal(sent.length, 0, "does not send before 750 ms");
        flusher.enqueue(AUTO_PLAY, true);
        assert.equal(flusher.unsettledValue(AUTO_PLAY), true);
        await clock.advance(DEFAULT_DEBOUNCE_MS - 1);
        assert.equal(sent.length, 0, "second edit restarts the 750 ms window");
        await clock.advance(1);
        assert.deepEqual(sent, [{ key: AUTO_PLAY, scope: "profile_device", value: true }]);
        assert.equal(flusher.unsettledValue(AUTO_PLAY), undefined, "settled once acknowledged");
    } finally {
        flusher.destroy();
    }
});

test("transient failures follow Apple's bounded retry schedule (1 s, 2 s, 4 s, 8 s, 16 s) and then hold (#810)", async () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(attempt => retryDelayMs(DEFAULT_RETRY_POLICY, attempt)), [1000, 2000, 4000, 8000, 16000]);
    const clock = new ManualClock();
    const attemptsAt: number[] = [];
    const transport: PlayerSettingsTransport = {
        putValue: async () => {
            attemptsAt.push(clock.now());
            throw transientError();
        },
        effectiveValues: async () => new Map(),
    };
    const flusher = new PlayerSettingsFlusher(transport, clock);
    try {
        flusher.enqueue(AUTO_PLAY, false);
        await clock.advance(DEFAULT_DEBOUNCE_MS);
        assert.equal(attemptsAt.length, 1, "initial attempt after 750 ms debounce");
        assert.deepEqual(flusher.heldKeys, []);

        for (const [index, delay] of [1000, 2000, 4000, 8000, 16000].entries()) {
            await clock.advance(delay - 1);
            assert.equal(attemptsAt.length, index + 1, `waits full ${delay} ms before retry ${index + 1}`);
            await clock.advance(1);
            assert.equal(attemptsAt.length, index + 2, `retry ${index + 1} fires at +${delay} ms`);
            if (index < 4) assert.deepEqual(flusher.heldKeys, [], `not held after retry ${index + 1}`);
        }
        assert.deepEqual(flusher.heldKeys, [AUTO_PLAY], "held after 5 failed automatic retries");
        assert.equal(flusher.unsettledValue(AUTO_PLAY), false, "local choice stays on this TV while held");
        await clock.advance(120_000);
        assert.equal(attemptsAt.length, 6, "no further automatic sends once held");
    } finally {
        flusher.destroy();
    }
});

test("permanent server refusal drops the write without retrying or holding (#810)", async () => {
    const clock = new ManualClock();
    let sends = 0;
    const rejected: SettingsKey[] = [];
    const transport: PlayerSettingsTransport = {
        putValue: async () => { sends++; throw permanentError(); },
        effectiveValues: async () => new Map(),
    };
    const flusher = new PlayerSettingsFlusher(transport, clock, { onRejected: key => rejected.push(key) });
    try {
        flusher.enqueue(AUTO_PLAY, false);
        await clock.advance(DEFAULT_DEBOUNCE_MS);
        await clock.advance(30_000);
        assert.equal(sends, 1, "never retried after permanent refusal");
        assert.deepEqual(flusher.heldKeys, []);
        assert.equal(flusher.unsettledValue(AUTO_PLAY), undefined);
        assert.deepEqual(rejected, [AUTO_PLAY]);
    } finally {
        flusher.destroy();
    }
});

test("retryHeldChanges sends held values again with a fresh budget, and discardHeldChanges verifies server reachability first (#810)", async () => {
    const clock = new ManualClock();
    let failWrites = true;
    let failReads = true;
    let sends = 0;
    const storage = fakeStorage();
    const transport: PlayerSettingsTransport = {
        putValue: async () => {
            sends++;
            if (failWrites) throw transientError();
        },
        effectiveValues: async () => {
            if (failReads) throw transientError();
            return new Map([[AUTO_PLAY, { value: true }]]);
        },
    };
    const flusher = new PlayerSettingsFlusher(transport, clock, { retryPolicy: { maximumAutomaticRetries: 1, baseMs: 1000, maximumMs: 4000 }, storage });
    try {
        flusher.enqueue(AUTO_PLAY, false);
        await clock.advance(DEFAULT_DEBOUNCE_MS + 1000);
        assert.deepEqual(flusher.heldKeys, [AUTO_PLAY]);
        assert.equal(sends, 2);

        // Discard while offline keeps the held change intact.
        assert.equal(await flusher.discardHeldChanges(), false);
        assert.deepEqual(flusher.heldKeys, [AUTO_PLAY]);
        assert.equal(flusher.unsettledValue(AUTO_PLAY), false);

        // Discard once the server answers clears the held change without sending a PUT.
        failReads = false;
        assert.equal(await flusher.discardHeldChanges(), true);
        assert.deepEqual(flusher.heldKeys, []);
        assert.equal(flusher.unsettledValue(AUTO_PLAY), undefined);
        assert.equal(sends, 2);

        // Re-hold and test Retry succeeding.
        flusher.enqueue(AUTO_PLAY, false);
        await clock.advance(DEFAULT_DEBOUNCE_MS + 1000);
        assert.deepEqual(flusher.heldKeys, [AUTO_PLAY]);
        failWrites = false;
        await flusher.retryHeldChanges();
        assert.deepEqual(flusher.heldKeys, []);
        assert.equal(flusher.unsettledValue(AUTO_PLAY), undefined);
        assert.equal(sends, 5);
    } finally {
        flusher.destroy();
    }
});

test("restored non-held journal entries resume delivery and clearKey supersedes in-flight writes (#810)", async () => {
    const clock = new ManualClock();
    const storage = fakeStorage();
    // Seed a non-held write in storage as if the app closed during the debounce window.
    const first = new PlayerSettingsFlusher({ putValue: async () => {}, effectiveValues: async () => new Map() }, clock, { storage });
    first.enqueue(AUTO_PLAY, false);
    first.destroy();

    const sent: SettingValue[] = [];
    const committed: SettingsKey[] = [];
    const restored = new PlayerSettingsFlusher({
        putValue: async (_key, _scope, value) => { sent.push(value); },
        effectiveValues: async () => new Map(),
    }, clock, { storage });
    restored.onCommit(key => { committed.push(key); });
    await clock.advance(DEFAULT_DEBOUNCE_MS);
    assert.deepEqual(sent, [false], "restored non-held entry drains automatically");
    assert.deepEqual(committed, [AUTO_PLAY], "onCommit fires once the write succeeds");

    // clearKey supersedes an in-flight PUT so its transient failure is never retried.
    let rejectInFlight: ((error: unknown) => void) | undefined;
    let attempts = 0;
    const flusher = new PlayerSettingsFlusher({
        putValue: async () => {
            attempts += 1;
            return new Promise<void>((_resolve, reject) => { rejectInFlight = reject; });
        },
        effectiveValues: async () => new Map(),
    }, clock);
    flusher.enqueue(AUTO_PLAY, true);
    await clock.advance(DEFAULT_DEBOUNCE_MS);
    assert.equal(attempts, 1);
    flusher.clearKey(AUTO_PLAY);
    rejectInFlight?.(transientError());
    await clock.advance(60_000);
    assert.equal(attempts, 1, "superseded in-flight write is never retried");
    assert.equal(flusher.unsettledValue(AUTO_PLAY), undefined);
    flusher.destroy();
    restored.destroy();
});

test("aborted writes stay in their original profile journal on scope switch and 429 Retry-After delays retries (#810)", async () => {
    const clock = new ManualClock();
    const storage = fakeStorage();
    let currentScope = "server:profile-a";
    const controller = new AbortController();
    let rejectInFlight: ((error: unknown) => void) | undefined;
    const flusher = new PlayerSettingsFlusher({
        putValue: async () => new Promise<void>((_resolve, reject) => { rejectInFlight = reject; }),
        effectiveValues: async () => new Map(),
    }, clock, {
        storage,
        scopeId: () => currentScope,
        signal: () => controller.signal,
    });
    flusher.enqueue(AUTO_PLAY, false);
    await clock.advance(DEFAULT_DEBOUNCE_MS);
    // Profile switch changes scope before aborting the old authority signal and destroying the flusher.
    currentScope = "server:profile-b";
    controller.abort();
    flusher.destroy();
    rejectInFlight?.(new ApiError({ kind: "aborted" }));
    await clock.advance(0);
    // Returning to profile-a restores and delivers the unsaved write.
    const delivered: SettingValue[] = [];
    const returned = new PlayerSettingsFlusher({
        putValue: async (_key, _scope, value) => { delivered.push(value); },
        effectiveValues: async () => new Map(),
    }, clock, { storage, scopeId: () => "server:profile-a" });
    assert.equal(returned.unsettledValue(AUTO_PLAY), false, "aborted write survived profile switch in original partition");
    await clock.advance(DEFAULT_DEBOUNCE_MS);
    assert.deepEqual(delivered, [false]);
    returned.destroy();

    // HTTP 429 with Retry-After: 60 s waits the full 60 s before retrying instead of burning retries in 31 s.
    let throttleAttempts = 0;
    const throttled = new PlayerSettingsFlusher({
        putValue: async () => {
            throttleAttempts += 1;
            if (throttleAttempts === 1) {
                throw new ApiError({
                    kind: "problem",
                    problem: { id: "rate_limited", status: 429, title: "Too Many Requests", detail: "Slow down", instance: "", errors: [] },
                    retryAfterSeconds: 60,
                });
            }
        },
        effectiveValues: async () => new Map(),
    }, clock);
    throttled.enqueue(AUTO_PLAY, false);
    await clock.advance(DEFAULT_DEBOUNCE_MS);
    assert.equal(throttleAttempts, 1);
    await clock.advance(59_999);
    assert.equal(throttleAttempts, 1, "does not retry before server Retry-After deadline");
    await clock.advance(1);
    assert.equal(throttleAttempts, 2, "retries once Retry-After elapses and saves cleanly");
    assert.deepEqual(throttled.heldKeys, []);
    throttled.destroy();
});

test("runSerialized aborts and waits for an in-flight player write before running direct Settings saves (#810)", async () => {
    const clock = new ManualClock();
    const events: string[] = [];
    let releaseOldPut: (() => void) | undefined;
    const flusher = new PlayerSettingsFlusher({
        putValue: async (_key, _scope, _value, signal) => new Promise<void>((resolve, reject) => {
            events.push("player-put-start");
            signal.addEventListener("abort", () => {
                events.push("player-put-aborted");
                reject(new ApiError({ kind: "aborted" }));
            }, { once: true });
            releaseOldPut = () => {
                events.push("player-put-done");
                resolve();
            };
        }),
        effectiveValues: async () => new Map(),
    }, clock);
    flusher.enqueue(AUTO_PLAY, false);
    await clock.advance(DEFAULT_DEBOUNCE_MS);
    assert.deepEqual(events, ["player-put-start"]);

    await flusher.runSerialized(AUTO_PLAY, async () => {
        events.push("settings-save");
        flusher.clearKey(AUTO_PLAY);
    });
    releaseOldPut?.();
    assert.deepEqual(events, ["player-put-start", "player-put-aborted", "settings-save", "player-put-done"]);
    assert.equal(flusher.unsettledValue(AUTO_PLAY), undefined);
    flusher.destroy();
});
