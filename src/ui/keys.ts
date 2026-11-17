// Remote keys as Samsung TVs deliver them: plain keydown events with these key codes
// (Remote Control guide). Escape stands in for Back on a desktop keyboard.
import { readsRightToLeft } from "../i18n/direction.ts";

export type RemoteKey = "up" | "down" | "left" | "right" | "enter" | "back" | "play_pause" | "play" | "pause" | "stop" | "rewind" | "fast_forward" | "ime_done" | "ime_cancel";

const BY_CODE: Readonly<Record<number, RemoteKey>> = {
    13: "enter",
    27: "back",
    37: "left",
    38: "up",
    39: "right",
    40: "down",
    10009: "back",
    10252: "play_pause",
    415: "play",
    19: "pause",
    413: "stop",
    412: "rewind",
    417: "fast_forward",
    // The on-screen keyboard's Done and Cancel keys.
    65376: "ime_done",
    65385: "ime_cancel",
};

const BY_NAME: Readonly<Record<string, RemoteKey>> = {
    Enter: "enter",
    Escape: "back",
    ArrowLeft: "left",
    ArrowUp: "up",
    ArrowRight: "right",
    ArrowDown: "down",
    MediaPlayPause: "play_pause",
    MediaPlay: "play",
    MediaPause: "pause",
    MediaStop: "stop",
    MediaRewind: "rewind",
    MediaFastForward: "fast_forward",
};

/** The key the remote sent, whatever the layout: what media transport reads (a rewind is on the left in every language). */
export function physicalKey(event: KeyboardEvent): RemoteKey | undefined {
    return BY_CODE[event.keyCode] ?? BY_NAME[event.key];
}

const MIRRORED: Readonly<Partial<Record<RemoteKey, RemoteKey>>> = { left: "right", right: "left" };

/**
 * The key as the screen's layout reads it. Remote presses are physical; in a right-to-left layout the next item
 * lies to the left, so Left and Right swap, as silo-apple's `MoveCommandDirection.inLayout` does, and every
 * handler that steps "left" toward the start of a row or a column keeps doing so on the mirrored screen.
 * The layout is the one around the element the press landed on, or around `scope` when a screen decides it for
 * the whole press (the player's focus can sit in its left-to-right scrubber while the press belongs to a mirrored card).
 */
export function remoteKey(event: KeyboardEvent, scope: EventTarget | null = event.target): RemoteKey | undefined {
    const key = physicalKey(event);
    return key === undefined || !readsRightToLeft(scope) ? key : MIRRORED[key] ?? key;
}
