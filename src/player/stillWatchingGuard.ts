// Pass-out protection and its local TV preference, ported from silo-apple d315ef9c
// PlayerStillWatchingGuard.swift, PlayerSettings.swift (stillWatchingThreshold), and
// SettingsViewModel.swift (stillWatchingLabel).

import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";

export const DEFAULT_STILL_WATCHING_THRESHOLD = 3;
export const STILL_WATCHING_MIN = 0;
export const STILL_WATCHING_MAX = 20;
export const STILL_WATCHING_CHOICES: readonly number[] = Array.from(
    { length: STILL_WATCHING_MAX - STILL_WATCHING_MIN + 1 },
    (_, index) => STILL_WATCHING_MIN + index,
);

export function clampStillWatchingThreshold(value: number): number {
    if (!Number.isFinite(value)) return DEFAULT_STILL_WATCHING_THRESHOLD;
    return Math.min(Math.max(Math.trunc(value), STILL_WATCHING_MIN), STILL_WATCHING_MAX);
}

/** SettingsViewModel.stillWatchingLabel: Off for 0, else the localized episode count. */
export function stillWatchingLabel(count: number): string {
    const clamped = clampStillWatchingThreshold(count);
    return clamped === 0
        ? translate("settings.off")
        : translate("detail.episodeCount", { count: clamped, count_text: integerText(clamped) });
}

/**
 * Counts consecutive unattended advances so auto-play waits for the viewer once
 * the configured limit is reached (`PlayerStillWatchingGuard.swift:1-22`).
 *
 * With threshold N, N automatic advances in a row are allowed and the next
 * waits. A viewer action clears the count; a threshold of 0 never gates.
 */
export class PlayerStillWatchingGuard {
    private consecutiveAutoAdvances = 0;

    get count(): number {
        return this.consecutiveAutoAdvances;
    }

    recordAutoAdvance(): void {
        this.consecutiveAutoAdvances += 1;
    }

    recordViewerAction(): void {
        this.consecutiveAutoAdvances = 0;
    }

    shouldGate(threshold: number): boolean {
        return threshold > 0 && this.consecutiveAutoAdvances >= threshold;
    }
}

/**
 * Local-only Still Watching threshold stored per server, account, and profile
 * on this TV (`PlayerSettings.swift` `player.passoutThreshold`). Never sent to
 * the server because the streak exists only on this device.
 */
export class StillWatchingPreference {
    private readonly storage: PublicStorage | undefined;
    private readonly key: string;
    private choice: number | undefined;

    constructor(storage: PublicStorage | undefined, key: string) {
        this.storage = storage;
        this.key = key;
    }

    get value(): number {
        if (this.choice !== undefined) return this.choice;
        try {
            const raw = this.storage?.getItem(this.key);
            if (raw === null || raw === undefined || raw.trim() === "") return DEFAULT_STILL_WATCHING_THRESHOLD;
            const parsed = Number.parseInt(raw, 10);
            return Number.isNaN(parsed) ? DEFAULT_STILL_WATCHING_THRESHOLD : clampStillWatchingThreshold(parsed);
        } catch {
            return DEFAULT_STILL_WATCHING_THRESHOLD;
        }
    }

    set(threshold: number): void {
        const clamped = clampStillWatchingThreshold(threshold);
        this.choice = clamped;
        try {
            this.storage?.setItem(this.key, String(clamped));
        } catch {
            // The choice holds for this run even when public storage is blocked.
        }
    }
}
