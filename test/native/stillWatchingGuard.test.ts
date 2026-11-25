import assert from "node:assert/strict";
import { test } from "node:test";
import {
    clampStillWatchingThreshold,
    DEFAULT_STILL_WATCHING_THRESHOLD,
    PlayerStillWatchingGuard,
    STILL_WATCHING_CHOICES,
    stillWatchingLabel,
    StillWatchingPreference,
} from "../../src/player/stillWatchingGuard.ts";
import { MemoryPublicStorage } from "./support/keyManager.ts";

test("PlayerStillWatchingGuard allows N unattended advances and gates the next (#796)", () => {
    const guard = new PlayerStillWatchingGuard();
    assert.equal(guard.shouldGate(3), false);

    guard.recordAutoAdvance();
    assert.equal(guard.count, 1);
    assert.equal(guard.shouldGate(3), false);

    guard.recordAutoAdvance();
    assert.equal(guard.count, 2);
    assert.equal(guard.shouldGate(3), false);

    guard.recordAutoAdvance();
    assert.equal(guard.count, 3);
    assert.equal(guard.shouldGate(3), true);

    guard.recordViewerAction();
    assert.equal(guard.count, 0);
    assert.equal(guard.shouldGate(3), false);
});

test("threshold 0 never gates regardless of unattended advance count (#796)", () => {
    const guard = new PlayerStillWatchingGuard();
    for (let i = 0; i < 25; i++) guard.recordAutoAdvance();
    assert.equal(guard.shouldGate(0), false);
    assert.equal(guard.shouldGate(-1), false);
});

test("StillWatchingPreference defaults to 3, clamps 0..20, and persists locally (#796)", () => {
    const storage = new MemoryPublicStorage();
    const pref = new StillWatchingPreference(storage, "silo.player.stillWatchingThreshold:p1");
    assert.equal(pref.value, DEFAULT_STILL_WATCHING_THRESHOLD);
    assert.equal(STILL_WATCHING_CHOICES.length, 21);
    assert.equal(STILL_WATCHING_CHOICES[0], 0);
    assert.equal(STILL_WATCHING_CHOICES[20], 20);

    pref.set(25);
    assert.equal(pref.value, 20);
    assert.equal(new StillWatchingPreference(storage, "silo.player.stillWatchingThreshold:p1").value, 20);

    pref.set(-5);
    assert.equal(pref.value, 0);
    assert.equal(new StillWatchingPreference(storage, "silo.player.stillWatchingThreshold:p1").value, 0);

    storage.setItem("silo.player.stillWatchingThreshold:corrupt", "not-a-number");
    assert.equal(new StillWatchingPreference(storage, "silo.player.stillWatchingThreshold:corrupt").value, 3);
    assert.equal(clampStillWatchingThreshold(Number.NaN), 3);

    assert.equal(stillWatchingLabel(0), "Off");
    assert.equal(stillWatchingLabel(1), "1 episode");
    assert.equal(stillWatchingLabel(3), "3 episodes");
});
