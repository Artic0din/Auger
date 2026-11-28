import type { AVPlay } from "./avplay.ts";

/**
 * Shared lock for the singleton platform AVPlay instance.
 *
 * AVPlay forbids any transport call while `seekTo`, `restoreAsync`, or teardown `close` is still in flight;
 * video and audiobook controllers share this lock so switching between media kinds waits safely.
 */
export interface PendingTransport {
    seek: Promise<void> | undefined;
    restore: Promise<void> | undefined;
    closing: Promise<void> | undefined;
    streamGen: number;
    deferredCloseGen: number | undefined;
}

const pendingTransports = new WeakMap<AVPlay, PendingTransport>();

/** Returns the singleton transport lock for `avplay`. */
export function transportLock(avplay: AVPlay): PendingTransport {
    const existing = pendingTransports.get(avplay);
    if (existing !== undefined) return existing;
    const created: PendingTransport = { seek: undefined, restore: undefined, closing: undefined, streamGen: 0, deferredCloseGen: undefined };
    pendingTransports.set(avplay, created);
    return created;
}
