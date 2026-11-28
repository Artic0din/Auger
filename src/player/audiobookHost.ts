import { systemClock } from "../api/clock.ts";
import type { ConnectedServer } from "../session/core.ts";
import { physicalKey } from "../ui/keys.ts";
import { AudiobookController, type AudiobookPlaybackView, type AudiobookPlayRequest } from "./audiobookController.ts";
import { type AudiobookPlayerScreen, mountAudiobookPlayerScreen } from "./audiobookPlayerScreen.ts";
import type { PlayerPlatform } from "./playerScreen.ts";

export interface AudiobookNowPlaying {
    readonly contentId: string;
    readonly title: string;
    readonly authorLine: string | undefined;
    readonly posterUrl: string | undefined;
    readonly paused: boolean;
}

export interface AudiobookHostDeps {
    readonly server: ConnectedServer;
    readonly platform: PlayerPlatform;
    readonly onMinimize?: () => void;
    readonly onExit?: () => void;
    readonly onFinished?: () => void;
}

/**
 * Owns the persistent AVPlay container surface and `AudiobookController` instance, separating the
 * underlying audio playback lifecycle from the full-screen player overlay.
 */
export class AudiobookHost {
    private readonly root: HTMLElement;
    private readonly server: ConnectedServer;
    private readonly controller: AudiobookController;
    private readonly listeners: ((view: AudiobookPlaybackView, visible: boolean) => void)[] = [];
    private readonly onMinimize: (() => void) | undefined;
    private readonly onExit: (() => void) | undefined;
    private readonly onFinished: (() => void) | undefined;
    private surface: HTMLDivElement | undefined;
    private surfaceGen = 0;
    private exitGen = 0;
    private removingSurface = false;
    private stopInFlight: Promise<void> | undefined;
    private screen: AudiobookPlayerScreen | undefined;
    private pendingExitRestore = false;
    private destroyed = false;

    private readonly onVisibility = (): void => {
        if (this.destroyed) return;
        if (document.hidden) {
            this.controller.suspend();
        } else if (!this.server.session.authoritySignal.aborted) {
            void this.controller.restore();
        }
    };

    constructor(root: HTMLElement, deps: AudiobookHostDeps) {
        this.root = root;
        this.server = deps.server;
        this.onMinimize = deps.onMinimize;
        this.onExit = deps.onExit;
        this.onFinished = deps.onFinished;

        this.controller = new AudiobookController({
            session: deps.server.session,
            avplay: deps.platform.avplay,
            clock: deps.platform.clock ?? systemClock,
            randomBytes: deps.platform.randomBytes,
            device: { model: deps.platform.model, appVersion: deps.platform.appVersion },
            exits: {
                onFinished: () => this.finishExit("finished"),
                onClose: () => this.finishExit("close"),
            },
        });
        this.controller.subscribe(view => {
            if (view.phase === "idle" || view.phase === "error") this.removeSurface();
            else this.ensureSurface();
            this.notify();
        });
        document.addEventListener("visibilitychange", this.onVisibility);
    }

    get view(): AudiobookPlaybackView {
        return this.controller.view;
    }

    get isActive(): boolean {
        return this.controller.view.phase !== "idle"
            || this.controller.transportBusy
            || this.stopInFlight !== undefined
            || this.surface !== undefined;
    }

    get isVisible(): boolean {
        return this.screen !== undefined;
    }

    get activeContentId(): string | undefined {
        const view = this.controller.view;
        return view.phase === "idle" ? undefined : view.contentId;
    }

    get nowPlaying(): AudiobookNowPlaying | undefined {
        const view = this.controller.view;
        if (view.phase !== "playing" && view.phase !== "paused") return undefined;
        if (this.destroyed || this.stopInFlight !== undefined) return undefined;
        return {
            contentId: view.contentId,
            title: view.title,
            authorLine: view.authorLine,
            posterUrl: view.posterUrl,
            paused: view.phase === "paused",
        };
    }

    subscribe(listener: (view: AudiobookPlaybackView, visible: boolean) => void): () => void {
        this.listeners.push(listener);
        listener(this.controller.view, this.isVisible);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) this.listeners.splice(index, 1);
        };
    }

    start(request: AudiobookPlayRequest): void {
        if (this.destroyed) return;
        this.exitGen += 1;
        this.stopInFlight = undefined;
        this.pendingExitRestore = false;
        this.hideScreen();
        this.ensureSurface();
        this.show();
        void this.controller.start(request);
    }

    private finishExit(kind: "close" | "finished"): void {
        if (this.destroyed) return;
        const gen = ++this.exitGen;
        const shouldRestore = kind === "finished"
            ? this.screen !== undefined
            : this.screen !== undefined || this.pendingExitRestore;
        this.pendingExitRestore = false;
        const finalize = (): void => {
            if (this.destroyed || this.exitGen !== gen || this.controller.view.phase !== "idle") return;
            const hadScreen = this.screen !== undefined;
            this.hideScreen();
            this.removeSurface();
            this.notify();
            if (hadScreen || shouldRestore) {
                if (kind === "finished") this.onFinished?.();
                else this.onExit?.();
            }
        };
        if (!this.controller.transportBusy) {
            finalize();
            return;
        }
        this.screen?.setStopping();
        this.notify();
        // AudiobookController bounds pending seekTo/restoreAsync by STARTUP_TIMEOUT_MS before retiring AVPlay.
        void this.controller.whenTransportIdle().finally(finalize);
    }

    private ensureSurface(): void {
        if (this.destroyed) return;
        this.surfaceGen += 1;
        this.removingSurface = false;
        if (this.surface !== undefined) return;
        const surface = document.createElement("div");
        surface.className = "audio-avplay-surface";
        surface.setAttribute("aria-hidden", "true");
        const avObject = document.createElement("object");
        avObject.type = "application/avplayer";
        surface.appendChild(avObject);
        this.root.appendChild(surface);
        this.surface = surface;
    }

    private removeSurface(): void {
        const surface = this.surface;
        if (surface === undefined) return;
        if (!this.controller.transportBusy) {
            this.surfaceGen += 1;
            this.removingSurface = false;
            surface.remove();
            this.surface = undefined;
            return;
        }
        if (this.removingSurface) return;
        this.removingSurface = true;
        const gen = ++this.surfaceGen;
        void this.controller.whenTransportIdle().finally(() => {
            if (this.surfaceGen === gen && this.surface === surface) {
                this.removingSurface = false;
                surface.remove();
                this.surface = undefined;
            }
        });
    }

    show(): void {
        if (this.destroyed || this.screen !== undefined) return;
        this.pendingExitRestore = false;
        this.screen = mountAudiobookPlayerScreen(this.root, {
            controller: this.controller,
            baseUrl: this.server.server.http.base.baseUrl,
            onClose: () => {
                const phase = this.controller.view.phase;
                if (phase === "playing" || phase === "paused") this.minimize();
                else void this.stop();
            },
            onStop: () => { void this.stop(); },
        });
        this.notify();
    }

    seekAndShow(seconds: number): void {
        if (this.destroyed || this.stopInFlight !== undefined) return;
        this.ensureSurface();
        this.show();
        this.controller.seekTo(seconds);
        this.controller.play();
    }

    minimize(): void {
        if (this.destroyed || this.screen === undefined || this.stopInFlight !== undefined) return;
        this.pendingExitRestore = false;
        this.hideScreen();
        this.notify();
        this.onMinimize?.();
    }

    hideScreen(): void {
        this.screen?.destroy();
        this.screen = undefined;
    }

    async stop(): Promise<void> {
        if (this.destroyed) return;
        if (this.stopInFlight !== undefined) {
            await this.stopInFlight;
            return;
        }
        const wasVisible = this.screen !== undefined;
        if (this.controller.view.phase === "idle" && !this.controller.transportBusy) {
            this.pendingExitRestore = false;
            this.hideScreen();
            this.removeSurface();
            this.notify();
            if (wasVisible) this.onExit?.();
            return;
        }
        if (wasVisible) this.pendingExitRestore = true;
        this.screen?.setStopping();
        let work!: Promise<void>;
        work = (async (): Promise<void> => {
            await this.controller.stop();
            if (!this.destroyed && this.stopInFlight === work && this.controller.view.phase === "idle" && this.controller.transportBusy) {
                await this.controller.whenTransportIdle();
            }
        })().finally(() => {
            const current = this.stopInFlight === work;
            if (current) this.stopInFlight = undefined;
            if (current && !this.destroyed && this.controller.view.phase === "idle" && !this.controller.transportBusy) {
                const hadScreen = this.screen !== undefined;
                const shouldRestore = hadScreen || this.pendingExitRestore;
                this.pendingExitRestore = false;
                this.hideScreen();
                this.removeSurface();
                this.notify();
                if (shouldRestore) this.onExit?.();
            }
        });
        this.stopInFlight = work;
        this.notify();
        await work;
    }

    handleMediaKey(event: KeyboardEvent): boolean {
        if (this.destroyed || this.nowPlaying === undefined) return false;
        const key = physicalKey(event);
        switch (key) {
            case "play_pause": this.controller.togglePlayPause(); return true;
            case "play": this.controller.play(); return true;
            case "pause": this.controller.pause(); return true;
            case "stop": void this.stop(); return true;
            case "rewind": this.controller.skip("backward"); return true;
            case "fast_forward": this.controller.skip("forward"); return true;
            default: return false;
        }
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.exitGen += 1;
        this.pendingExitRestore = false;
        document.removeEventListener("visibilitychange", this.onVisibility);
        this.hideScreen();
        this.listeners.length = 0;
        void this.controller.destroy();
        this.removeSurface();
    }

    private notify(): void {
        if (this.destroyed) return;
        const current = this.controller.view;
        const visible = this.isVisible;
        for (const listener of [...this.listeners]) listener(current, visible);
    }
}
