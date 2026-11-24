import assert from "node:assert/strict";
import type { Tv } from "./tv.ts";

const BACK = 10009;

/**
 * Leaves playback whose controls are up. Back while playing takes them down first (PlayerView.onExitCommand,
 * silo-apple 449ba476 PlayerView.swift:469-470), and the next Back leaves.
 */
export async function leavePlayer(tv: Pick<Tv, "page" | "remote">): Promise<void> {
    await tv.remote(BACK);
    assert.equal(await tv.page.locator(".player-overlay-hidden").count(), 1, "the first Back hides the controls");
    await tv.remote(BACK);
}
