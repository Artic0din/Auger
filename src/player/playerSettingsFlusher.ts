// Debounced, retried writer for player device settings, ported from silo-apple d315ef9c
// PlayerSettingsFlusher.swift and SettingValueModels.swift (matching Android's ServerSettingsFlusher).
// One pending value per key; transient failures retry on a bounded exponential backoff, then hold
// until the viewer retries or discards in Settings. Permanent refusals drop the write.

import type { Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { SettingValue, SettingsKey } from "../contracts/v2/settings.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";

export type PlayerSettingWriteScope = "profile_device" | "profile";

export interface SettingWriteRetryPolicy {
    readonly maximumAutomaticRetries: number;
    readonly baseMs: number;
    readonly maximumMs: number;
}

/** 750 ms matches silo-apple PlayerSettingsFlusher.defaultDebounce and Android ServerSettingsFlusher. */
export const DEFAULT_DEBOUNCE_MS = 750;

/** SettingWriteRetryPolicy.default: 5 automatic retries at 1 s, 2 s, 4 s, 8 s, 16 s (capped at 60 s). */
export const DEFAULT_RETRY_POLICY: SettingWriteRetryPolicy = {
    maximumAutomaticRetries: 5,
    baseMs: 1000,
    maximumMs: 60_000,
};

/** HeldSettingChange.message (silo-apple SettingValueModels.swift:776). */
export const HELD_CHANGE_MESSAGE = "A change couldn't be saved to the server. It stays on this device until you try again or discard it.";

/** HeldSettingChange.discardNeedsServerMessage (silo-apple SettingValueModels.swift:781). */
export const HELD_DISCARD_NEEDS_SERVER_MESSAGE = "Couldn't reach the server to discard this change. It stays on this device until the server can be reached.";

export function retryDelayMs(policy: SettingWriteRetryPolicy, attempt: number): number {
    const shift = Math.min(Math.max(attempt - 1, 0), 6);
    return Math.min(policy.baseMs * (1 << shift), policy.maximumMs);
}

export interface PlayerSettingsTransport {
    putValue(key: SettingsKey, scope: PlayerSettingWriteScope, value: SettingValue, signal: AbortSignal): Promise<void>;
    effectiveValues(keys: readonly SettingsKey[], signal: AbortSignal): Promise<Map<SettingsKey, { readonly value: SettingValue }>>;
}

export function sessionPlayerSettingsTransport(session: NativeSession): PlayerSettingsTransport {
    return {
        async putValue(key, scope, value, signal): Promise<void> {
            await session.call({ ...operations.putSetting(key, value, scope), profileScoped: true, signal });
        },
        async effectiveValues(keys, signal): Promise<Map<SettingsKey, { readonly value: SettingValue }>> {
            const values = await session.call({ ...operations.effectiveSettings(keys), retry: "never", profileScoped: true, signal });
            const out = new Map<SettingsKey, { readonly value: SettingValue }>();
            for (const [entryKey, row] of values) out.set(entryKey, { value: row.value });
            return out;
        },
    };
}

interface PendingSettingWrite {
    readonly value: SettingValue;
    readonly scope: PlayerSettingWriteScope;
    readonly scopeId: string;
    readonly generation: number;
    failedAttempts: number;
    isHeld: boolean;
}

export interface PlayerSettingsFlusherOptions {
    readonly debounceMs?: number;
    readonly retryPolicy?: SettingWriteRetryPolicy;
    /** Active partition identifier (for example server+profile). Switching partitions isolates queues. */
    readonly scopeId?: () => string;
    /** Active authority signal. Aborting cancels in-flight writes without dropping queued entries. */
    readonly signal?: () => AbortSignal;
    /** Optional public storage for persisting queued/held entries per partition across reloads. */
    readonly storage?: PublicStorage;
    readonly onRejected?: (key: SettingsKey) => void;
}

const JOURNAL_PREFIX = "silo.playerSettings.journal:";

function sameValue(a: SettingValue, b: SettingValue): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

function classifyFailure(error: unknown): "aborted" | "transient" | "permanent" {
    if (error instanceof ApiError) {
        if (error.aborted) return "aborted";
        return error.transient ? "transient" : "permanent";
    }
    if (error instanceof Error && error.name === "AbortError") return "aborted";
    return "transient";
}

/**
 * Debounced, retried writer for player device settings (`PlayerSettingsFlusher.swift`).
 * Keeps one pending value per key per partition, retries transient failures on bounded backoff,
 * and holds exhausted keys until retried or discarded in Settings.
 */
export class PlayerSettingsFlusher {
    private readonly transport: PlayerSettingsTransport;
    private readonly clock: Clock;
    private readonly debounceMs: number;
    private readonly retryPolicy: SettingWriteRetryPolicy;
    private readonly readScopeId: () => string;
    private readonly readSignal: () => AbortSignal;
    private readonly storage: PublicStorage | undefined;
    private readonly onRejected: ((key: SettingsKey) => void) | undefined;

    private activeScopeId: string;
    private pending = new Map<SettingsKey, PendingSettingWrite>();
    private inFlight = new Map<SettingsKey, PendingSettingWrite>();
    private failedInDrain = new Map<SettingsKey, PendingSettingWrite>();
    private readonly keyGenerations = new Map<SettingsKey, number>();
    private cancelDebounce: (() => void) | undefined;
    private cancelRetry: (() => void) | undefined;
    private draining = false;
    private waiters: (() => void)[] = [];
    private listeners = new Set<() => void>();
    private commitListeners = new Set<(key: SettingsKey) => void>();
    private destroyed = false;

    constructor(transport: PlayerSettingsTransport, clock: Clock, options: PlayerSettingsFlusherOptions = {}) {
        this.transport = transport;
        this.clock = clock;
        this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        this.retryPolicy = options.retryPolicy ?? DEFAULT_RETRY_POLICY;
        this.readScopeId = options.scopeId ?? (() => "default");
        this.readSignal = options.signal ?? (() => new AbortController().signal);
        this.storage = options.storage;
        this.onRejected = options.onRejected;
        this.activeScopeId = this.readScopeId();
        this.loadJournal(this.activeScopeId);
        this.scheduleRestoredWrites();
    }

    /** Keys in the active partition whose automatic retries ran out and are held on this TV. */
    get heldKeys(): readonly SettingsKey[] {
        this.syncScope();
        const keys: SettingsKey[] = [];
        for (const [key, write] of this.pending) {
            if (write.isHeld) keys.push(key);
        }
        return keys.sort();
    }

    get hasPendingWrites(): boolean {
        this.syncScope();
        return this.pending.size > 0 || this.inFlight.size > 0 || this.draining;
    }

    /** Latest local value owed to the server (queued, in flight, or held) for the active partition. */
    unsettledValue(key: SettingsKey): SettingValue | undefined {
        this.syncScope();
        const queued = this.pending.get(key);
        if (queued !== undefined) return queued.value;
        const active = this.inFlight.get(key);
        if (active !== undefined && active.scopeId === this.activeScopeId) return active.value;
        const failed = this.failedInDrain.get(key);
        if (failed !== undefined && failed.scopeId === this.activeScopeId) return failed.value;
        return undefined;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** Notified when a queued write for `key` succeeds on the server (used to invalidate stale reads and refresh Settings). */
    onCommit(listener: (key: SettingsKey) => void): () => void {
        this.commitListeners.add(listener);
        return () => { this.commitListeners.delete(listener); };
    }

    /** Queue one desired value for `key`, replacing any older pending value and restarting debounce. */
    enqueue(key: SettingsKey, value: SettingValue, scope: PlayerSettingWriteScope = "profile_device"): void {
        if (this.destroyed) return;
        this.syncScope();
        const existing = this.pending.get(key);
        if (existing !== undefined && !existing.isHeld && existing.scope === scope && sameValue(existing.value, value)) {
            this.armDebounce();
            return;
        }
        const generation = this.bumpGeneration(key);
        this.inFlight.delete(key);
        this.failedInDrain.delete(key);
        this.pending.set(key, { value, scope, scopeId: this.activeScopeId, generation, failedAttempts: 0, isHeld: false });
        this.persistJournal();
        this.clearRetryTimer();
        this.armDebounce();
        this.notify();
    }

    /** Forget any queued, in-flight, or held entry for `key` (for example after Settings saved or reset it directly). */
    clearKey(key: SettingsKey): void {
        this.syncScope();
        const hadPending = this.pending.delete(key);
        const hadInFlight = this.inFlight.delete(key);
        const hadFailed = this.failedInDrain.delete(key);
        if (!hadPending && !hadInFlight && !hadFailed) return;
        this.bumpGeneration(key);
        this.persistJournal();
        this.notify();
    }

    /** Immediately drain all non-held queued writes and resolve once the drain completes. */
    async flushNow(): Promise<void> {
        if (this.destroyed) return;
        this.syncScope();
        this.clearDebounceTimer();
        this.clearRetryTimer();
        if (this.draining) {
            await new Promise<void>(resolve => { this.waiters.push(resolve); });
            return;
        }
        if (!this.hasSendableWrites()) return;
        await this.drain();
    }

    /** Reset retry budget on all held keys in the active partition and send them immediately. */
    async retryHeldChanges(): Promise<void> {
        if (this.destroyed) return;
        this.syncScope();
        let changed = false;
        for (const [key, write] of this.pending) {
            if (!write.isHeld) continue;
            this.pending.set(key, { ...write, failedAttempts: 0, isHeld: false });
            changed = true;
        }
        if (changed) {
            this.persistJournal();
            this.notify();
        }
        await this.flushNow();
    }

    /**
     * Re-read the server's values for held keys before dropping them, matching Apple's
     * `discardHeldDeviceSettingChanges`. Returns false and keeps held changes when the server
     * cannot be reached.
     */
    async discardHeldChanges(): Promise<boolean> {
        if (this.destroyed) return false;
        this.syncScope();
        const keys = this.heldKeys;
        if (keys.length === 0) return true;
        const scopeId = this.activeScopeId;
        try {
            await this.transport.effectiveValues(keys, this.readSignal());
        } catch {
            return false;
        }
        if (this.destroyed || this.readScopeId() !== scopeId) return false;
        let changed = false;
        for (const key of keys) {
            if (this.pending.get(key)?.isHeld === true) {
                this.pending.delete(key);
                changed = true;
            }
        }
        if (changed) {
            this.persistJournal();
            this.notify();
        }
        return true;
    }

    destroy(): void {
        this.destroyed = true;
        this.clearDebounceTimer();
        this.clearRetryTimer();
        const queued = this.waiters.splice(0);
        for (const resolve of queued) resolve();
        this.listeners.clear();
        this.commitListeners.clear();
    }

    private bumpGeneration(key: SettingsKey): number {
        const next = (this.keyGenerations.get(key) ?? 0) + 1;
        this.keyGenerations.set(key, next);
        return next;
    }

    private isCurrent(key: SettingsKey, write: PendingSettingWrite): boolean {
        return (this.keyGenerations.get(key) ?? 0) === write.generation;
    }

    private syncScope(): void {
        const nextScope = this.readScopeId();
        if (nextScope === this.activeScopeId) return;
        this.activeScopeId = nextScope;
        this.pending.clear();
        this.clearDebounceTimer();
        this.clearRetryTimer();
        this.loadJournal(nextScope);
        this.scheduleRestoredWrites();
    }

    private scheduleRestoredWrites(): void {
        if (this.destroyed) return;
        let hasFresh = false;
        let minRetryingAttempt: number | undefined;
        for (const write of this.pending.values()) {
            if (write.isHeld) continue;
            if (write.failedAttempts === 0) hasFresh = true;
            else minRetryingAttempt = minRetryingAttempt === undefined ? write.failedAttempts : Math.min(minRetryingAttempt, write.failedAttempts);
        }
        if (hasFresh) this.armDebounce();
        else if (minRetryingAttempt !== undefined) this.armRetry(minRetryingAttempt);
    }

    private hasSendableWrites(): boolean {
        for (const write of this.pending.values()) {
            if (!write.isHeld) return true;
        }
        return false;
    }

    private armDebounce(): void {
        this.clearDebounceTimer();
        this.cancelDebounce = this.clock.schedule(() => {
            this.cancelDebounce = undefined;
            if (!this.destroyed) void this.flushNow();
        }, this.debounceMs);
    }

    private clearDebounceTimer(): void {
        this.cancelDebounce?.();
        this.cancelDebounce = undefined;
    }

    private armRetry(attempt: number): void {
        this.clearRetryTimer();
        const delay = retryDelayMs(this.retryPolicy, attempt);
        this.cancelRetry = this.clock.schedule(() => {
            this.cancelRetry = undefined;
            if (!this.destroyed) void this.flushNow();
        }, delay);
    }

    private clearRetryTimer(): void {
        this.cancelRetry?.();
        this.cancelRetry = undefined;
    }

    private async drain(): Promise<void> {
        this.draining = true;
        const rejected: SettingsKey[] = [];
        try {
            while (!this.destroyed) {
                const snapshot = new Map<SettingsKey, PendingSettingWrite>();
                for (const [key, write] of this.pending) {
                    if (write.isHeld) continue;
                    snapshot.set(key, write);
                    this.pending.delete(key);
                }
                if (snapshot.size === 0) break;
                this.inFlight = new Map(snapshot);
                this.persistJournal();

                for (const key of [...snapshot.keys()].sort()) {
                    const write = snapshot.get(key);
                    if (write === undefined || this.destroyed) continue;
                    if (this.readScopeId() !== write.scopeId) {
                        this.inFlight.delete(key);
                        this.failedInDrain.delete(key);
                        continue;
                    }
                    try {
                        await this.transport.putValue(key, write.scope, write.value, this.readSignal());
                        if (this.inFlight.get(key) === write) this.inFlight.delete(key);
                        if (this.isCurrent(key, write)) {
                            this.failedInDrain.delete(key);
                            for (const listener of [...this.commitListeners]) listener(key);
                        }
                    } catch (error) {
                        if (this.inFlight.get(key) === write) this.inFlight.delete(key);
                        if (!this.isCurrent(key, write)) continue;
                        const kind = classifyFailure(error);
                        if (kind === "permanent") {
                            this.failedInDrain.delete(key);
                            rejected.push(key);
                        } else if (kind === "aborted") {
                            this.failedInDrain.set(key, write);
                        } else {
                            const failedAttempts = write.failedAttempts + 1;
                            const isHeld = failedAttempts > this.retryPolicy.maximumAutomaticRetries;
                            this.failedInDrain.set(key, { ...write, failedAttempts, isHeld });
                        }
                    }
                    this.persistJournal();
                }
            }
        } finally {
            const currentScope = this.readScopeId();
            let minRetryingAttempt: number | undefined;
            for (const [key, write] of this.failedInDrain) {
                if (write.scopeId === currentScope && this.isCurrent(key, write) && !this.pending.has(key)) {
                    this.pending.set(key, write);
                    if (!write.isHeld && write.failedAttempts > 0) {
                        minRetryingAttempt = minRetryingAttempt === undefined ? write.failedAttempts : Math.min(minRetryingAttempt, write.failedAttempts);
                    }
                }
            }
            this.inFlight.clear();
            this.failedInDrain.clear();
            this.persistJournal();
            this.draining = false;
            const queued = this.waiters.splice(0);
            for (const resolve of queued) resolve();
            if (!this.destroyed && minRetryingAttempt !== undefined) {
                this.armRetry(minRetryingAttempt);
            }
            this.notify();
            for (const key of rejected) this.onRejected?.(key);
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) listener();
    }

    private persistJournal(): void {
        if (this.storage === undefined) return;
        const storageKey = `${JOURNAL_PREFIX}${this.activeScopeId}`;
        const entries: Record<string, PendingSettingWrite> = {};
        for (const map of [this.failedInDrain, this.inFlight, this.pending]) {
            for (const [key, write] of map) {
                if (write.scopeId === this.activeScopeId) entries[key] = write;
            }
        }
        try {
            if (Object.keys(entries).length === 0) this.storage.removeItem(storageKey);
            else this.storage.setItem(storageKey, JSON.stringify(entries));
        } catch {
            // Public storage errors must not break playback or settings edits.
        }
    }

    private loadJournal(scopeId: string): void {
        if (this.storage === undefined) return;
        try {
            const raw = this.storage.getItem(`${JOURNAL_PREFIX}${scopeId}`);
            if (raw === null) return;
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed !== "object" || parsed === null) return;
            for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof entry !== "object" || entry === null) continue;
                const record = entry as Record<string, unknown>;
                const scope = record.scope === "profile" ? "profile" : "profile_device";
                const failedAttempts = typeof record.failedAttempts === "number" && Number.isInteger(record.failedAttempts) && record.failedAttempts >= 0 ? record.failedAttempts : 0;
                const isHeld = record.isHeld === true;
                if (!("value" in record)) continue;
                this.pending.set(key as SettingsKey, {
                    value: record.value as SettingValue,
                    scope,
                    scopeId,
                    generation: this.bumpGeneration(key as SettingsKey),
                    failedAttempts,
                    isHeld,
                });
            }
        } catch {
            // Corrupt journal entries are ignored cleanly.
        }
    }
}
