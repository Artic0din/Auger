// Samsung AVPlay as its API reference documents it, for the player tests. Calls outside a
// method's documented states throw InvalidStateError, as the platform does. prepareAsync and
// seekTo callbacks are kept and fire whenever the test releases them, even after close() or a
// newer open(): the platform cannot cancel them, so the player must ignore late ones. Listener
// events go to whichever listener is registered when they fire, and a test can also hold an old
// listener object and call it late.

import type { AVPlay, AVPlayAsyncError, AVPlayListener, AVPlayTrackInfo } from "../../../src/player/avplay.ts";

type State = "NONE" | "IDLE" | "READY" | "PLAYING" | "PAUSED";

interface Pending {
    readonly success: () => void;
    readonly error: (error: AVPlayAsyncError) => void;
    /** The open() this call was made under. */
    readonly stream: number;
}

class InvalidStateError extends Error {
    constructor(method: string, state: State) {
        super(`${method} is not allowed in ${state}`);
        this.name = "InvalidStateError";
    }
}

class InvalidValuesError extends Error {
    constructor(method: string) {
        super(`${method} rejected the track`);
        this.name = "InvalidValuesError";
    }
}

export class FakeAVPlay implements AVPlay {
    state: State = "NONE";
    /** Every call in order, e.g. "open <url>", "seekTo 12500", "play". */
    readonly calls: string[] = [];
    readonly listeners: AVPlayListener[] = [];
    readonly urls: string[] = [];
    positionMs = 0;
    /** AUDIO rows of the open stream, listed before `tracks`. A TV lists every audio stream of an original file. */
    audioTracks: AVPlayTrackInfo[] = [1, 2, 3].map((index) => ({ index, type: "AUDIO", extra_info: "{\"channels\":\"2\",\"fourCC\":\"audio/mpeg\"}" }));
    /** Other rows `getTotalTrackInfo` returns for the open stream. */
    tracks: AVPlayTrackInfo[] = [];
    /** TEXT index from the last `setSelectTrack`, until subtitles are silenced. */
    textIndex: number | undefined;
    /** AUDIO index from the last `setSelectTrack`; until then the stream's first AUDIO row plays. */
    audioIndex: number | undefined;
    silentSubtitle = false;
    /** Between suspend() and a restore. */
    private suspendedPlayer = false;
    private stream = 0;
    private readonly prepares: Pending[] = [];
    private readonly seeks: (Pending & { readonly ms: number })[] = [];
    private readonly restores: (Pending & { readonly ms: number })[] = [];

    get listener(): AVPlayListener | undefined {
        return this.listeners[this.listeners.length - 1];
    }

    open(url: string): void {
        this.require("open", ["NONE", "IDLE"]);
        this.stream++;
        this.state = "IDLE";
        this.positionMs = 0;
        this.audioIndex = undefined;
        this.urls.push(url);
        this.calls.push(`open ${url}`);
    }

    close(): void {
        this.suspendedPlayer = false;
        this.require("close", ["NONE", "IDLE", "READY", "PLAYING", "PAUSED"]);
        this.calls.push("close");
        this.state = "NONE";
    }

    prepareAsync(success: () => void, error: (error: AVPlayAsyncError) => void): void {
        this.require("prepareAsync", ["IDLE", "READY"]);
        this.calls.push("prepareAsync");
        this.prepares.push({ success, error, stream: this.stream });
    }

    readonly displayRects: number[][] = [];
    setDisplayRect(x: number, y: number, width: number, height: number): void {
        this.require("setDisplayRect", ["IDLE", "READY", "PLAYING", "PAUSED"]);
        this.displayRects.push([x, y, width, height]);
    }

    setListener(listener: AVPlayListener): void {
        this.listeners.push(listener);
    }

    play(): void {
        this.require("play", ["READY", "PLAYING", "PAUSED"]);
        this.calls.push("play");
        this.state = "PLAYING";
    }

    pause(): void {
        this.require("pause", ["PLAYING", "PAUSED"]);
        this.calls.push("pause");
        this.state = "PAUSED";
    }

    seekTo(milliseconds: number, success: () => void, error: (error: AVPlayAsyncError) => void): void {
        this.require("seekTo", ["IDLE", "READY", "PLAYING", "PAUSED"]);
        this.calls.push(`seekTo ${milliseconds}`);
        this.seeks.push({ success, error, stream: this.stream, ms: milliseconds });
    }

    suspend(): void {
        this.require("suspend", ["READY", "PLAYING", "PAUSED"]);
        this.calls.push("suspend");
        this.suspendedPlayer = true;
    }

    restoreAsync(url: string | null, resumeTime: number | null, prepare: boolean, success: () => void, error: (error: AVPlayAsyncError) => void): void {
        this.require("restoreAsync", ["NONE", "PLAYING", "PAUSED"]);
        const ms = resumeTime ?? 0;
        const published = url ?? "";
        this.calls.push(`restoreAsync ${ms} prepare=${prepare} ${published}`);
        if (published !== "") {
            this.urls.push(published);
        }
        this.restores.push({ success, error, stream: this.stream, ms });
    }

    stop(): void {
        this.calls.push("stop");
        if (this.state !== "NONE") {
            this.state = "IDLE";
        }
    }

    getState(): string {
        return this.state;
    }

    getCurrentTime(): number {
        return this.positionMs;
    }

    getTotalTrackInfo(): readonly AVPlayTrackInfo[] {
        this.require("getTotalTrackInfo", ["PLAYING", "PAUSED"]);
        this.calls.push("getTotalTrackInfo");
        return this.rows;
    }

    getCurrentStreamInfo(): readonly AVPlayTrackInfo[] {
        this.require("getCurrentStreamInfo", ["READY", "PLAYING", "PAUSED"]);
        this.calls.push("getCurrentStreamInfo");
        const audio = this.audioIndex ?? this.audioTracks[0]?.index;
        return this.rows.filter((track) => track.type === "AUDIO" ? track.index === audio : track.type === "TEXT" && track.index === this.textIndex);
    }

    setSelectTrack(trackType: "AUDIO" | "TEXT", trackIndex: number): void {
        // "PAUSED" is documented for TEXT tracks only.
        this.require("setSelectTrack", trackType === "AUDIO" ? ["PLAYING"] : ["PLAYING", "PAUSED"]);
        if (!this.rows.some((track) => track.type === trackType && track.index === trackIndex)) {
            throw new InvalidValuesError("setSelectTrack");
        }
        this.calls.push(`setSelectTrack ${trackType} ${trackIndex}`);
        if (trackType === "TEXT") {
            // Selecting a TEXT track does not unhide subtitles: only setSilentSubtitle(false) does, as AVPlay documents the two calls separately.
            this.textIndex = trackIndex;
        } else {
            this.audioIndex = trackIndex;
        }
    }

    setSilentSubtitle(hidden: boolean): void {
        this.require("setSilentSubtitle", ["IDLE", "PLAYING", "PAUSED"]);
        // A suspended player refuses to change subtitle visibility until it is restored (#745 review).
        if (this.suspendedPlayer) throw new DOMException("suspended", "InvalidStateError");
        this.calls.push(`setSilentSubtitle ${hidden}`);
        this.silentSubtitle = hidden;
        if (hidden) this.textIndex = undefined;
    }

    private get rows(): AVPlayTrackInfo[] {
        return [...this.audioTracks, ...this.tracks];
    }

    // --- test controls ---

    get pendingPrepares(): number {
        return this.prepares.length;
    }

    /** Fires the oldest pending prepareAsync callback, current or not. */
    finishPrepare(errorName?: string): void {
        const pending = this.prepares.shift();
        if (pending === undefined) {
            throw new Error("no prepareAsync pending");
        }
        if (errorName !== undefined) {
            pending.error({ name: errorName });
            return;
        }
        if (pending.stream === this.stream && this.state === "IDLE") {
            this.state = "READY";
        }
        pending.success();
    }

    /** Fires the oldest pending seekTo callback. */
    finishSeek(errorName?: string): void {
        const pending = this.seeks.shift();
        if (pending === undefined) {
            throw new Error("no seekTo pending");
        }
        if (errorName !== undefined) {
            pending.error({ name: errorName });
            return;
        }
        if (pending.stream === this.stream) {
            this.positionMs = pending.ms;
        }
        pending.success();
    }

    /** Fires the oldest pending restoreAsync callback. */
    finishRestore(errorName?: string): void {
        const pending = this.restores.shift();
        if (pending === undefined) {
            throw new Error("no restoreAsync pending");
        }
        if (errorName !== undefined) {
            pending.error({ name: errorName });
            return;
        }
        if (pending.ms > 0) {
            this.positionMs = pending.ms;
        }
        this.suspendedPlayer = false;
        pending.success();
    }

    /** Playback reached `ms` on the current listener. */
    tick(ms: number): void {
        this.positionMs = ms;
        this.listener?.oncurrentplaytime(ms);
    }

    private require(method: string, states: readonly State[]): void {
        if (this.seeks.length > 0) {
            // "During this async operation, the other API would not be allowed."
            throw new InvalidStateError(`${method} during seekTo`, this.state);
        }
        if (states.indexOf(this.state) === -1) {
            throw new InvalidStateError(method, this.state);
        }
    }
}
