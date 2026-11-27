import { systemClock } from "../api/clock.ts";
import type { ConnectedServer } from "../session/core.ts";
import { physicalKey } from "../ui/keys.ts";
import { AudiobookController, type AudiobookPlaybackView, type AudiobookPlayRequest } from "./audiobookController.ts";
import { type AudiobookPlayerScreen, mountAudiobookPlayerScreen } from "./audiobookPlayerScreen.ts";
import type { PlayerPlatform } from "./playerScreen.ts";

export interface AudiobookHostDeps {
    readonly server: ConnectedServer;
    readonly platform: PlayerPlatform;
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
    private readonly listeners: ((view: AudiobookPlaybackView) => void)[] = [];
    private readonly onExit: (() => void) | undefined;
    private readonly onFinished: (() => void) | undefined;
    private surface: HTMLDivElement | undefined;
    private surfaceGen = 0;
    private removingSurface = false;
    private stopInFlight: Promise<void> | undefined;
    private screen: AudiobookPlayerScreen | undefined;
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
        this.onExit = deps.onExit;
        this.onFinished = deps.onFinished;

        this.controller = new AudiobookController({
            session: deps.server.session,
            avplay: deps.platform.avplay,
            clock: deps.platform.clock ?? systemClock,
            randomBytes: deps.platform.randomBytes,
            device: { model: deps.platform.model, appVersion: deps.platform.appVersion },
            exits: {
                onFinished: () => {
                    this.hideScreen();
                    this.removeSurface();
                    this.onFinished?.();
                },
                onClose: () => {
                    this.hideScreen();
                    this.removeSurface();
                    this.onExit?.();
                },
            },
        });
        this.controller.subscribe(view => {
            if (view.phase === "idle" || view.phase === "error") this.removeSurface();
            else this.ensureSurface();
            for (const listener of [...this.listeners]) listener(view);
        });
        document.addEventListener("visibilitychange", this.onVisibility);
    }

    get view(): AudiobookPlaybackView {
        return this.controller.view;
    }

    get isActive(): boolean {
        return this.controller.view.phase !== "idle";
    }

    get isVisible(): boolean {
        return this.screen !== undefined;
    }

    get activeContentId(): string | undefined {
        const view = this.controller.view;
        return view.phase === "idle" ? undefined : view.contentId;
    }

    subscribe(listener: (view: AudiobookPlaybackView) => void): () => void {
        this.listeners.push(listener);
        listener(this.controller.view);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index >= 0) this.listeners.splice(index, 1);
        };
    }

    start(request: AudiobookPlayRequest): void {
        if (this.destroyed) return;
        this.stopInFlight = undefined;
        this.hideScreen();
        this.ensureSurface();
        this.show();
        void this.controller.start(request);
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
        this.screen = mountAudiobookPlayerScreen(this.root, {
            controller: this.controller,
            baseUrl: this.server.server.http.base.baseUrl,
            onClose: () => { void this.stop(); },
            onStop: () => { void this.stop(); },
        });
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
        if (this.controller.view.phase === "idle") {
            const wasVisible = this.screen !== undefined;
            this.hideScreen();
            this.removeSurface();
            if (wasVisible) this.onExit?.();
            return;
        }
        this.screen?.setStopping();
        let work!: Promise<void>;
        work = (async (): Promise<void> => {
            await this.controller.stop();
        })().finally(() => {
            const current = this.stopInFlight === work;
            if (current) this.stopInFlight = undefined;
            if (current && !this.destroyed && this.controller.view.phase === "idle") {
                this.hideScreen();
                this.removeSurface();
            }
        });
        this.stopInFlight = work;
        await work;
    }

    handleMediaKey(event: KeyboardEvent): boolean {
        if (this.destroyed || !this.isActive) return false;
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
        document.removeEventListener("visibilitychange", this.onVisibility);
        this.hideScreen();
        this.listeners.length = 0;
        void this.controller.destroy();
        this.removeSurface();
    }
}
