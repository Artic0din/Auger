import { applyScreenDirection } from "../i18n/direction.ts";
import { localizeNumerals } from "../i18n/format.ts";
import { translate } from "../i18n/translate.ts";
import { artworkUrl } from "../ui/browseModel.ts";
import { formatHMS } from "../ui/audiobookDetail.ts";
import { physicalKey, remoteKey, type RemoteKey } from "../ui/keys.ts";
import { isFreshSelect, listenSelectRelease, swallowSelect } from "../ui/selectRelease.ts";
import { SkylineScroll } from "../ui/skylineScroll.ts";
import type { AudiobookChapterEntry, AudiobookController, AudiobookPlaybackView } from "./audiobookController.ts";
import { DEFAULT_AUDIO_COVER_PALETTE, extractCoverPalette } from "./audiobookPalette.ts";
import { SLEEP_TIMER_MINUTES } from "./audiobookSleepTimer.ts";
import {
    chaptersListIcon, checkmarkIcon, moonFilledIcon, moonIcon, nextChapterIcon, pauseIcon, playIcon,
    prevChapterIcon, skipIcon, speedIcon, spinnerIcon, stopIcon, waveformIcon,
} from "./playerIcons.ts";

export interface AudiobookPlayerScreenDeps {
    readonly controller: AudiobookController;
    readonly baseUrl: string;
    readonly onClose: () => void;
    readonly onStop: () => void;
}

export interface AudiobookPlayerScreen {
    setStopping(): void;
    destroy(): void;
}

type ActiveView = Extract<AudiobookPlaybackView, { phase: "playing" | "paused" }>;
type MenuKind = "chapters" | "speed" | "sleep";

interface FocusTarget {
    readonly zone: "scrubber" | "transport" | "options" | "loading" | "error";
    readonly key: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function localizedChapterName(chapter: AudiobookChapterEntry): string {
    const trimmed = chapter.title.trim();
    return trimmed !== "" ? trimmed : translate("detail.audiobook.chapter", { number: localizeNumerals(String(chapter.index + 1)) });
}

function focusButton(button: HTMLElement | undefined): void {
    button?.focus({ preventScroll: true });
}

function disabledControl(target: Element | null): boolean {
    return target instanceof HTMLButtonElement && (target.disabled || target.getAttribute("aria-disabled") === "true");
}

export function mountAudiobookPlayerScreen(container: HTMLElement, deps: AudiobookPlayerScreenDeps): AudiobookPlayerScreen {
    const screen = el("section", "audio-player-screen");
    screen.dataset.screen = "audiobook-player";
    screen.tabIndex = -1;
    applyScreenDirection(screen);
    container.appendChild(screen);

    const scroller = new SkylineScroll();
    let lastView: AudiobookPlaybackView = deps.controller.view;
    let lastBook: { readonly title: string; readonly posterUrl: string | undefined } | undefined =
        lastView.phase === "idle" ? undefined : { title: lastView.title, posterUrl: lastView.posterUrl };
    let phaseGroup: "none" | "loading" | "active" | "error" | "stopping" = "none";
    let currentMenu: { kind: MenuKind; returnKey: string; list: HTMLElement; buttons: HTMLButtonElement[]; focusedIndex: number } | undefined;
    let currentFocus: FocusTarget = { zone: "transport", key: "play-pause" };
    let loadingButton: HTMLButtonElement | undefined;
    let errorButtons: HTMLButtonElement[] = [];
    let selectHeld: { readonly element: Element | null; readonly context: string } | undefined;
    let stopping = false;
    let destroyed = false;

    // Active DOM refs kept intact across 1 s ticks so focus and transitions never flicker.
    let activeDom: {
        artFrame: HTMLElement;
        img: HTMLImageElement;
        fallback: HTMLElement;
        loadedPoster: string | undefined;
        titleEl: HTMLElement;
        authorEl: HTMLElement;
        chapterEl: HTMLElement;
        scrubberEl: HTMLElement;
        fillEl: HTMLElement;
        pendingEl: HTMLElement;
        ticksKey: string;
        ticksHost: HTMLElement;
        elapsedEl: HTMLElement;
        remainingEl: HTMLElement;
        prevBtn: HTMLButtonElement;
        skipBackBtn: HTMLButtonElement;
        skipBackInterval: number;
        playPauseBtn: HTMLButtonElement;
        isPausedIcon: boolean | undefined;
        skipForwardBtn: HTMLButtonElement;
        skipForwardInterval: number;
        nextBtn: HTMLButtonElement;
        chaptersBtn: HTMLButtonElement;
        speedBtn: HTMLButtonElement;
        speedText: string;
        sleepBtn: HTMLButtonElement;
        sleepKey: string;
        stopBtn: HTMLButtonElement;
    } | undefined;

    const applyPalette = (palette: { readonly top: string; readonly mid: string; readonly bottom: string }): void => {
        screen.style.setProperty("--audio-bg-top", palette.top);
        screen.style.setProperty("--audio-bg-mid", palette.mid);
        screen.style.setProperty("--audio-bg-bottom", palette.bottom);
    };
    applyPalette(DEFAULT_AUDIO_COVER_PALETTE);

    const mountArtwork = (frame: HTMLElement, posterUrl: string | undefined): { img: HTMLImageElement; fallback: HTMLElement } => {
        const img = el("img", "audio-player-art");
        img.alt = "";
        const fallback = el("div", "audio-player-art-fallback");
        fallback.innerHTML = waveformIcon();
        frame.append(img, fallback);
        const resolved = artworkUrl(posterUrl, deps.baseUrl);
        if (resolved === undefined) {
            img.hidden = true;
            fallback.hidden = false;
        } else {
            img.hidden = false;
            fallback.hidden = true;
            img.addEventListener("load", () => {
                if (!destroyed) applyPalette(extractCoverPalette(img));
            });
            img.addEventListener("error", () => {
                img.hidden = true;
                fallback.hidden = false;
                applyPalette(DEFAULT_AUDIO_COVER_PALETTE);
            });
            img.src = resolved;
        }
        return { img, fallback };
    };

    const hasBookChapters = (): boolean =>
        lastView.phase === "playing" || lastView.phase === "paused" ? lastView.chapters.length > 0 : false;

    const transportButtons = (hasChapters: boolean): HTMLButtonElement[] => {
        if (activeDom === undefined) return [];
        const all = [activeDom.prevBtn, activeDom.skipBackBtn, activeDom.playPauseBtn, activeDom.skipForwardBtn, activeDom.nextBtn];
        return hasChapters ? all : all.filter(btn => btn !== activeDom?.prevBtn && btn !== activeDom?.nextBtn);
    };

    // Matches AudioFullPlayerView TVPlayerLayout secondary controls order: Speed, Sleep Timer, Chapters, Stop.
    const optionButtons = (hasChapters: boolean): HTMLButtonElement[] => {
        if (activeDom === undefined) return [];
        const all = [activeDom.speedBtn, activeDom.sleepBtn, activeDom.chaptersBtn, activeDom.stopBtn];
        return hasChapters ? all : all.filter(btn => btn !== activeDom?.chaptersBtn);
    };

    const selectContext = (): string => [
        stopping ? "stopping" : lastView.phase,
        currentMenu?.kind ?? "",
        currentFocus.zone,
        currentFocus.key,
    ].join("|");

    const endSelect = (): void => {
        selectHeld = undefined;
    };

    const focusZoneKey = (target: FocusTarget): void => {
        if (target.zone === "loading" && loadingButton !== undefined) {
            currentFocus = target;
            focusButton(loadingButton);
            return;
        }
        if (target.zone === "scrubber" && activeDom !== undefined) {
            currentFocus = target;
            focusButton(activeDom.scrubberEl);
            return;
        }
        const chapters = hasBookChapters();
        const pool = target.zone === "transport"
            ? transportButtons(chapters)
            : target.zone === "options"
                ? optionButtons(chapters)
                : errorButtons;
        const match = pool.find(btn => btn.dataset.key === target.key) ?? pool[0];
        if (match === undefined) return;
        currentFocus = { zone: target.zone, key: match.dataset.key ?? "" };
        focusButton(match);
    };

    const closeMenu = (): void => {
        if (currentMenu === undefined) return;
        scroller.stop();
        const returnKey = currentMenu.returnKey;
        const shell = screen.querySelector<HTMLElement>(".audio-player-shell");
        if (shell !== null) shell.inert = false;
        screen.querySelector(".audio-player-modal-backdrop")?.remove();
        currentMenu = undefined;
        focusZoneKey({ zone: "options", key: returnKey });
    };

    const openMenu = (kind: MenuKind, returnKey: string): void => {
        if (stopping || (lastView.phase !== "playing" && lastView.phase !== "paused")) return;
        const view = lastView;
        scroller.stop();
        screen.querySelector(".audio-player-modal-backdrop")?.remove();
        const shell = screen.querySelector<HTMLElement>(".audio-player-shell");
        if (shell !== null) shell.inert = true;
        const backdrop = el("div", "audio-player-modal-backdrop");
        const modal = el("div", "audio-player-modal");
        modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");

        const titleText = kind === "chapters"
            ? translate("options.chapters")
            : kind === "speed"
                ? translate("audiobook.speed.title")
                : translate("audiobook.sleepTimer.title");
        modal.setAttribute("aria-label", titleText);
        modal.appendChild(el("h2", "audio-player-modal-title", titleText));
        const list = el("div", "audio-player-modal-list");
        const buttons: HTMLButtonElement[] = [];
        let initialIndex = 0;

        if (kind === "chapters") {
            const activeIndex = view.currentChapter?.index;
            view.chapters.forEach((chapter, index) => {
                const row = el("button", "audio-player-modal-row");
                row.type = "button";
                row.dataset.chapterIndex = String(index);
                const main = el("span", "audio-player-modal-row-main");
                const name = el("span", "audio-player-modal-row-title", localizedChapterName(chapter));
                main.appendChild(name);
                if (activeIndex === index) {
                    initialIndex = index;
                    main.appendChild(el("span", "audio-player-now-badge", translate("detail.audiobook.nowBadge")));
                }
                const meta = el("span", "audio-player-modal-row-meta", formatHMS(chapter.start));
                row.append(main, meta);
                row.addEventListener("click", () => {
                    deps.controller.selectChapter(index);
                    closeMenu();
                });
                buttons.push(row);
                list.appendChild(row);
            });
        } else if (kind === "speed") {
            view.availableRates.forEach((rate, index) => {
                const selected = Math.abs(view.playbackRate - rate) < 0.001;
                if (selected) initialIndex = index;
                const row = el("button", "audio-player-modal-row");
                row.type = "button";
                row.dataset.rate = String(rate);
                row.setAttribute("aria-checked", String(selected));
                const main = el("span", "audio-player-modal-row-main", `${localizeNumerals(String(rate))}×`);
                const check = el("span", "audio-player-modal-row-check");
                if (selected) check.innerHTML = checkmarkIcon();
                row.append(main, check);
                row.addEventListener("click", () => {
                    deps.controller.setPlaybackRate(rate);
                    closeMenu();
                });
                buttons.push(row);
                list.appendChild(row);
            });
        } else {
            const presets: readonly { minutes: number; label: string }[] = [
                { minutes: 0, label: translate("audiobook.sleepTimer.off") },
                ...SLEEP_TIMER_MINUTES.map(minutes => ({
                    minutes,
                    label: translate("audiobook.sleepTimer.minutesShort", { minutes }),
                })),
            ];
            presets.forEach((preset, index) => {
                const selected = preset.minutes === 0
                    ? !view.sleepTimer.active
                    : view.sleepTimer.active && view.sleepTimer.presetMinutes === preset.minutes;
                if (selected) initialIndex = index;
                const row = el("button", "audio-player-modal-row");
                row.type = "button";
                row.dataset.sleepMinutes = String(preset.minutes);
                row.setAttribute("aria-checked", String(selected));
                const main = el("span", "audio-player-modal-row-main", preset.label);
                const check = el("span", "audio-player-modal-row-check");
                if (selected) check.innerHTML = checkmarkIcon();
                row.append(main, check);
                row.addEventListener("click", () => {
                    deps.controller.setSleepTimer(preset.minutes);
                    closeMenu();
                });
                buttons.push(row);
                list.appendChild(row);
            });
        }

        modal.appendChild(list);
        backdrop.appendChild(modal);
        screen.appendChild(backdrop);
        currentMenu = { kind, returnKey, list, buttons, focusedIndex: initialIndex };
        const initialButton = buttons[initialIndex] ?? buttons[0];
        focusButton(initialButton);
        if (initialButton !== undefined) scroller.reveal(initialButton, list);
    };

    const renderLoading = (view: Extract<AudiobookPlaybackView, { phase: "loading" }>): void => {
        scroller.stop();
        currentMenu = undefined;
        activeDom = undefined;
        errorButtons = [];
        phaseGroup = "loading";
        screen.innerHTML = "";
        const shell = el("div", "audio-player-shell is-centered");
        const frame = el("div", "audio-player-art-frame");
        mountArtwork(frame, view.posterUrl);
        const meta = el("div", "audio-player-meta");
        meta.appendChild(el("h1", "audio-player-title", view.title));
        const status = el("div", "audio-player-status");
        const spin = el("span", "player-next-spinner");
        spin.innerHTML = spinnerIcon();
        status.append(spin, el("span", "", view.subtitle ?? translate("audiobook.player.starting")));
        const actions = el("div", "audio-player-error-actions");
        const cancelBtn = el("button", "audio-player-option-btn", translate("common.cancel"));
        cancelBtn.type = "button";
        cancelBtn.dataset.key = "cancel";
        cancelBtn.addEventListener("click", () => deps.onClose());
        actions.appendChild(cancelBtn);
        loadingButton = cancelBtn;
        shell.append(frame, meta, status, actions);
        screen.appendChild(shell);
        focusZoneKey({ zone: "loading", key: "cancel" });
    };

    const renderStopping = (): void => {
        scroller.stop();
        currentMenu = undefined;
        activeDom = undefined;
        loadingButton = undefined;
        errorButtons = [];
        phaseGroup = "stopping";
        screen.dataset.stopping = "true";
        screen.setAttribute("aria-busy", "true");
        screen.innerHTML = "";
        const shell = el("div", "audio-player-shell is-centered");
        const frame = el("div", "audio-player-art-frame");
        const posterUrl = lastView.phase === "idle" ? lastBook?.posterUrl : lastView.posterUrl;
        mountArtwork(frame, posterUrl);
        const meta = el("div", "audio-player-meta");
        const title = lastView.phase === "idle" ? (lastBook?.title ?? "") : lastView.title;
        if (title !== "") meta.appendChild(el("h1", "audio-player-title", title));
        const status = el("div", "audio-player-status");
        const spin = el("span", "player-next-spinner");
        spin.innerHTML = spinnerIcon();
        status.appendChild(spin);
        shell.append(frame, meta, status);
        screen.appendChild(shell);
        screen.focus({ preventScroll: true });
    };

    const renderError = (view: Extract<AudiobookPlaybackView, { phase: "error" }>): void => {
        scroller.stop();
        currentMenu = undefined;
        activeDom = undefined;
        loadingButton = undefined;
        phaseGroup = "error";
        screen.innerHTML = "";
        const shell = el("div", "audio-player-shell is-centered");
        const frame = el("div", "audio-player-art-frame");
        mountArtwork(frame, view.posterUrl);
        const meta = el("div", "audio-player-meta");
        if (view.title !== "") meta.appendChild(el("h1", "audio-player-title", view.title));
        meta.appendChild(el("p", "audio-player-error-message", view.message));

        const actionsRow = el("div", "audio-player-error-actions");
        errorButtons = [];
        if (view.retryable) {
            const retryBtn = el("button", "audio-player-option-btn", translate("common.retry"));
            retryBtn.type = "button";
            retryBtn.dataset.key = "retry";
            retryBtn.addEventListener("click", () => deps.controller.retry());
            errorButtons.push(retryBtn);
            actionsRow.appendChild(retryBtn);
        }
        const doneBtn = el("button", "audio-player-option-btn", translate("common.done"));
        doneBtn.type = "button";
        doneBtn.dataset.key = "done";
        doneBtn.addEventListener("click", () => deps.onClose());
        errorButtons.push(doneBtn);
        actionsRow.appendChild(doneBtn);

        shell.append(frame, meta, actionsRow);
        screen.appendChild(shell);
        focusZoneKey({ zone: "error", key: view.retryable ? "retry" : "done" });
    };

    const ensureActiveDom = (): NonNullable<typeof activeDom> => {
        if (activeDom !== undefined && phaseGroup === "active") return activeDom;
        scroller.stop();
        currentMenu = undefined;
        loadingButton = undefined;
        errorButtons = [];
        phaseGroup = "active";
        screen.innerHTML = "";
        const shell = el("div", "audio-player-shell");
        const artFrame = el("div", "audio-player-art-frame");
        const { img, fallback } = mountArtwork(artFrame, undefined);
        const main = el("div", "audio-player-main");
        const meta = el("div", "audio-player-meta");
        const eyebrow = el("p", "audio-player-eyebrow", translate("audiobook.player.label"));
        const titleEl = el("h1", "audio-player-title");
        const authorEl = el("p", "audio-player-author");
        const chapterEl = el("p", "audio-player-chapter");
        meta.append(eyebrow, titleEl, authorEl, chapterEl);

        const progress = el("div", "audio-player-progress");
        const scrubberEl = el("div", "audio-player-scrubber");
        scrubberEl.tabIndex = 0;
        scrubberEl.setAttribute("role", "slider");
        scrubberEl.setAttribute("aria-label", translate("audiobook.player.playbackPosition"));
        scrubberEl.setAttribute("aria-valuemin", "0");
        scrubberEl.dataset.zone = "scrubber";
        scrubberEl.dataset.key = "scrubber";
        const fillEl = el("div", "audio-player-scrubber-fill");
        const pendingEl = el("div", "audio-player-scrubber-pending");
        const ticksHost = el("div", "audio-player-scrubber-ticks");
        scrubberEl.append(ticksHost, fillEl, pendingEl);
        const times = el("div", "audio-player-times");
        const elapsedEl = el("span", "audio-player-elapsed");
        const remainingEl = el("span", "audio-player-remaining");
        times.append(elapsedEl, remainingEl);
        progress.append(scrubberEl, times);

        const transport = el("div", "audio-player-transport");
        transport.dataset.zone = "transport";
        const mkTransport = (key: string, label: string, icon: string, click: () => void, primary = false): HTMLButtonElement => {
            const btn = el("button", primary ? "audio-player-transport-btn is-primary" : "audio-player-transport-btn");
            btn.type = "button";
            btn.dataset.zone = "transport";
            btn.dataset.key = key;
            btn.setAttribute("aria-label", label);
            btn.innerHTML = icon;
            btn.addEventListener("click", click);
            return btn;
        };
        const prevBtn = mkTransport("prev-chapter", translate("audiobook.transport.previousChapter"), prevChapterIcon(), () => deps.controller.previousChapter());
        const skipBackBtn = mkTransport("skip-back", translate("player.skip.back", { seconds: 10 }), skipIcon("backward", 10), () => deps.controller.skip("backward"));
        const playPauseBtn = mkTransport("play-pause", translate("player.audio.pause"), pauseIcon(), () => deps.controller.togglePlayPause(), true);
        const skipForwardBtn = mkTransport("skip-forward", translate("player.skip.forward", { seconds: 30 }), skipIcon("forward", 30), () => deps.controller.skip("forward"));
        const nextBtn = mkTransport("next-chapter", translate("audiobook.transport.nextChapter"), nextChapterIcon(), () => deps.controller.nextChapter());
        transport.append(prevBtn, skipBackBtn, playPauseBtn, skipForwardBtn, nextBtn);

        const options = el("div", "audio-player-options");
        options.dataset.zone = "options";
        const mkOption = (key: string, click: () => void): HTMLButtonElement => {
            const btn = el("button", "audio-player-option-btn");
            btn.type = "button";
            btn.dataset.zone = "options";
            btn.dataset.key = key;
            btn.addEventListener("click", click);
            return btn;
        };
        const speedBtn = mkOption("speed", () => openMenu("speed", "speed"));
        speedBtn.setAttribute("aria-label", translate("audiobook.speed.title"));
        const sleepBtn = mkOption("sleep", () => openMenu("sleep", "sleep"));
        sleepBtn.setAttribute("aria-label", translate("audiobook.sleepTimer.title"));
        const chaptersBtn = mkOption("chapters", () => {
            if (hasBookChapters()) openMenu("chapters", "chapters");
        });
        chaptersBtn.innerHTML = `${chaptersListIcon()}<span>${translate("audiobook.chapters.open")}</span>`;
        const stopBtn = mkOption("stop", () => deps.onStop());
        stopBtn.innerHTML = `${stopIcon()}<span>${translate("audiobook.player.stopListening")}</span>`;
        options.append(speedBtn, sleepBtn, chaptersBtn, stopBtn);

        main.append(meta, progress, transport, options);
        shell.append(artFrame, main);
        screen.appendChild(shell);

        activeDom = {
            artFrame, img, fallback, loadedPoster: "__unset__",
            titleEl, authorEl, chapterEl,
            scrubberEl, fillEl, pendingEl, ticksKey: "", ticksHost, elapsedEl, remainingEl,
            prevBtn, skipBackBtn, skipBackInterval: 10, playPauseBtn, isPausedIcon: undefined,
            skipForwardBtn, skipForwardInterval: 30, nextBtn,
            chaptersBtn, speedBtn, speedText: "", sleepBtn, sleepKey: "", stopBtn,
        };
        focusZoneKey({ zone: "transport", key: "play-pause" });
        return activeDom;
    };

    const updateActive = (view: ActiveView): void => {
        const dom = ensureActiveDom();
        if (dom.loadedPoster !== view.posterUrl) {
            dom.loadedPoster = view.posterUrl;
            const resolved = artworkUrl(view.posterUrl, deps.baseUrl);
            if (resolved === undefined) {
                dom.img.hidden = true;
                dom.fallback.hidden = false;
                applyPalette(DEFAULT_AUDIO_COVER_PALETTE);
            } else {
                dom.img.hidden = false;
                dom.fallback.hidden = true;
                dom.img.onload = () => { if (!destroyed) applyPalette(extractCoverPalette(dom.img)); };
                dom.img.onerror = () => {
                    dom.img.hidden = true;
                    dom.fallback.hidden = false;
                    applyPalette(DEFAULT_AUDIO_COVER_PALETTE);
                };
                dom.img.src = resolved;
            }
        }

        dom.titleEl.textContent = view.title;
        dom.authorEl.hidden = view.authorLine === undefined;
        dom.authorEl.textContent = view.authorLine ?? "";

        const hasChapters = view.chapters.length > 0;
        if (hasChapters && view.currentChapter !== undefined) {
            const chapterEntry = view.chapters[view.currentChapter.index];
            const name = chapterEntry === undefined ? "" : localizedChapterName(chapterEntry);
            const prefix = translate("detail.audiobook.chapterOf", {
                number: localizeNumerals(String(view.currentChapter.index + 1)),
                total: localizeNumerals(String(view.chapters.length)),
            });
            dom.chapterEl.textContent = `${prefix} · ${name}`;
            dom.chapterEl.hidden = false;
        } else {
            dom.chapterEl.hidden = true;
            dom.chapterEl.textContent = "";
        }

        const displayPos = view.bufferedTarget ?? view.position;
        const duration = Math.max(0, view.duration);
        const fraction = duration > 0 ? Math.max(0, Math.min(1, view.position / duration)) : 0;
        dom.fillEl.style.width = `${(fraction * 100).toFixed(3)}%`;
        if (view.bufferedTarget !== undefined && duration > 0) {
            const pendingFraction = Math.max(0, Math.min(1, view.bufferedTarget / duration));
            dom.pendingEl.hidden = false;
            dom.pendingEl.style.left = `${(pendingFraction * 100).toFixed(3)}%`;
        } else {
            dom.pendingEl.hidden = true;
        }
        dom.scrubberEl.setAttribute("aria-valuemax", String(Math.round(duration)));
        dom.scrubberEl.setAttribute("aria-valuenow", String(Math.round(displayPos)));
        dom.scrubberEl.setAttribute("aria-valuetext", formatHMS(displayPos));
        dom.elapsedEl.textContent = formatHMS(displayPos);
        dom.remainingEl.textContent = duration > 0 ? `-${formatHMS(Math.max(0, duration - displayPos))}` : formatHMS(0);

        const ticksKey = `${duration}:${view.chapters.map(c => c.start).join(",")}`;
        if (ticksKey !== dom.ticksKey) {
            dom.ticksKey = ticksKey;
            dom.ticksHost.innerHTML = "";
            if (view.chapters.length > 1 && duration > 0) {
                for (const chapter of view.chapters) {
                    if (chapter.start <= 0 || chapter.start >= duration) continue;
                    const tick = el("span", "audio-player-scrubber-tick");
                    tick.style.left = `${((chapter.start / duration) * 100).toFixed(3)}%`;
                    dom.ticksHost.appendChild(tick);
                }
            }
        }

        const paused = view.phase === "paused";
        if (dom.isPausedIcon !== paused) {
            dom.isPausedIcon = paused;
            dom.playPauseBtn.innerHTML = paused ? playIcon() : pauseIcon();
            dom.playPauseBtn.setAttribute("aria-label", translate(paused ? "player.audio.play" : "player.audio.pause"));
        }
        if (dom.skipBackInterval !== view.seekIntervals.backward) {
            dom.skipBackInterval = view.seekIntervals.backward;
            dom.skipBackBtn.innerHTML = skipIcon("backward", view.seekIntervals.backward);
            dom.skipBackBtn.setAttribute("aria-label", translate("player.skip.back", { seconds: view.seekIntervals.backward }));
        }
        if (dom.skipForwardInterval !== view.seekIntervals.forward) {
            dom.skipForwardInterval = view.seekIntervals.forward;
            dom.skipForwardBtn.innerHTML = skipIcon("forward", view.seekIntervals.forward);
            dom.skipForwardBtn.setAttribute("aria-label", translate("player.skip.forward", { seconds: view.seekIntervals.forward }));
        }

        for (const btn of [dom.prevBtn, dom.nextBtn, dom.chaptersBtn]) {
            if (hasChapters) btn.removeAttribute("aria-disabled");
            else btn.setAttribute("aria-disabled", "true");
        }

        const rateText = `${localizeNumerals(String(view.playbackRate))}×`;
        if (dom.speedText !== rateText) {
            dom.speedText = rateText;
            dom.speedBtn.innerHTML = `${speedIcon()}<span>${rateText}</span>`;
        }

        const sleepActive = view.sleepTimer.active;
        dom.sleepBtn.classList.toggle("is-active", sleepActive);
        const sleepLabel = sleepActive ? formatHMS(view.sleepTimer.remainingSeconds) : translate("audiobook.sleepTimer.button");
        const sleepKey = `${sleepActive ? 1 : 0}:${sleepLabel}`;
        if (dom.sleepKey !== sleepKey) {
            dom.sleepKey = sleepKey;
            dom.sleepBtn.innerHTML = `${sleepActive ? moonFilledIcon() : moonIcon()}<span>${sleepLabel}</span>`;
        }
    };

    const render = (view: AudiobookPlaybackView): void => {
        if (destroyed || stopping) return;
        lastView = view;
        if (view.phase !== "idle") {
            lastBook = { title: view.title, posterUrl: view.posterUrl };
        }
        if (view.phase === "idle") {
            closeMenu();
            scroller.stop();
            phaseGroup = "none";
            activeDom = undefined;
            loadingButton = undefined;
            errorButtons = [];
            screen.innerHTML = "";
        } else if (view.phase === "loading") {
            renderLoading(view);
        } else if (view.phase === "error") {
            renderError(view);
        } else {
            updateActive(view);
        }
        if (selectHeld !== undefined && (!selectHeld.element?.isConnected || document.activeElement !== selectHeld.element || disabledControl(selectHeld.element) || selectHeld.context !== selectContext())) {
            endSelect();
        }
    };

    const moveMenu = (delta: -1 | 1): void => {
        if (currentMenu === undefined || currentMenu.buttons.length === 0) return;
        const previous = currentMenu.buttons[currentMenu.focusedIndex];
        const next = Math.max(0, Math.min(currentMenu.buttons.length - 1, currentMenu.focusedIndex + delta));
        currentMenu.focusedIndex = next;
        const target = currentMenu.buttons[next];
        focusButton(target);
        if (target !== undefined) scroller.reveal(target, currentMenu.list, previous);
    };

    const moveRow = (buttons: HTMLButtonElement[], currentKey: string, delta: -1 | 1, zone: FocusTarget["zone"]): void => {
        const index = buttons.findIndex(btn => btn.dataset.key === currentKey);
        const next = index === -1 ? 0 : Math.max(0, Math.min(buttons.length - 1, index + delta));
        const btn = buttons[next];
        if (btn === undefined) return;
        currentFocus = { zone, key: btn.dataset.key ?? "" };
        focusButton(btn);
    };

    const handleMedia = (key: RemoteKey): boolean => {
        switch (key) {
            case "play_pause": deps.controller.togglePlayPause(); return true;
            case "play": deps.controller.play(); return true;
            case "pause": deps.controller.pause(); return true;
            case "stop": deps.onStop(); return true;
            case "rewind": deps.controller.skip("backward"); return true;
            case "fast_forward": deps.controller.skip("forward"); return true;
            default: return false;
        }
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        if (destroyed) return;
        if (stopping) {
            event.preventDefault();
            event.stopImmediatePropagation();
            endSelect();
            return;
        }
        if (currentMenu !== undefined && event.key === "Tab") {
            event.preventDefault();
            event.stopImmediatePropagation();
            endSelect();
            if (currentMenu.buttons.length > 0) {
                const previous = currentMenu.buttons[currentMenu.focusedIndex];
                const next = (currentMenu.focusedIndex + (event.shiftKey ? -1 : 1) + currentMenu.buttons.length) % currentMenu.buttons.length;
                currentMenu.focusedIndex = next;
                const target = currentMenu.buttons[next];
                focusButton(target);
                if (target !== undefined) scroller.reveal(target, currentMenu.list, previous);
            }
            return;
        }
        const rawKey = physicalKey(event);
        if (rawKey !== "enter") endSelect();
        if (rawKey === undefined) return;

        if (handleMedia(rawKey)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (rawKey === "back") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (event.repeat) return;
            if (currentMenu !== undefined) closeMenu();
            else deps.onClose();
            return;
        }
        if (rawKey === "enter") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (isFreshSelect()) {
                const target = document.activeElement;
                selectHeld = disabledControl(target) ? undefined : { element: target, context: selectContext() };
            }
            return;
        }
        if (lastView.phase === "error") {
            event.preventDefault();
            event.stopImmediatePropagation();
            const key = remoteKey(event, screen);
            if (key === "left" || key === "right") {
                moveRow(errorButtons, currentFocus.key, key === "left" ? -1 : 1, "error");
            }
            return;
        }
        if (lastView.phase === "loading") {
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (currentMenu !== undefined) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (rawKey === "up") moveMenu(-1);
            else if (rawKey === "down") moveMenu(1);
            return;
        }

        const hasChapters = hasBookChapters();
        if (currentFocus.zone === "scrubber" && (rawKey === "left" || rawKey === "right")) {
            event.preventDefault();
            event.stopImmediatePropagation();
            deps.controller.skip(rawKey === "left" ? "backward" : "forward");
            return;
        }
        if (currentFocus.zone === "transport" && (rawKey === "left" || rawKey === "right")) {
            event.preventDefault();
            event.stopImmediatePropagation();
            moveRow(transportButtons(hasChapters), currentFocus.key, rawKey === "left" ? -1 : 1, "transport");
            return;
        }
        const key = remoteKey(event, screen);
        if (key === undefined) return;
        if (key === "up") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (currentFocus.zone === "options") focusZoneKey({ zone: "transport", key: "play-pause" });
            else if (currentFocus.zone === "transport") focusZoneKey({ zone: "scrubber", key: "scrubber" });
            return;
        }
        if (key === "down") {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (currentFocus.zone === "scrubber") focusZoneKey({ zone: "transport", key: "play-pause" });
            else if (currentFocus.zone === "transport") focusZoneKey({ zone: "options", key: "speed" });
            return;
        }
        if ((key === "left" || key === "right") && currentFocus.zone === "options") {
            event.preventDefault();
            event.stopImmediatePropagation();
            moveRow(optionButtons(hasChapters), currentFocus.key, key === "left" ? -1 : 1, "options");
        }
    };

    const onKeyUp = (event: KeyboardEvent): void => {
        if (destroyed) return;
        if (physicalKey(event) !== "enter") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const held = selectHeld;
        selectHeld = undefined;
        if (stopping || held === undefined || document.hidden) return;
        const active = document.activeElement;
        if (held.context !== selectContext() || active !== held.element || disabledControl(active)) return;

        if (currentMenu === undefined && active === activeDom?.scrubberEl) {
            deps.controller.togglePlayPause();
            return;
        }
        if (!(active instanceof HTMLButtonElement)) return;
        if (lastView.phase === "error") {
            if (errorButtons.includes(active)) active.click();
            return;
        }
        if (lastView.phase === "loading") {
            if (active === loadingButton) active.click();
            return;
        }
        if (currentMenu !== undefined) {
            if (currentMenu.buttons.includes(active)) active.click();
            return;
        }
        const chapters = hasBookChapters();
        if (transportButtons(chapters).includes(active) || optionButtons(chapters).includes(active)) {
            active.click();
        }
    };

    const onFocusIn = (event: FocusEvent): void => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (currentMenu !== undefined) {
            if (target instanceof HTMLButtonElement) {
                const index = currentMenu.buttons.indexOf(target);
                if (index >= 0) currentMenu.focusedIndex = index;
            }
            return;
        }
        if (target === activeDom?.scrubberEl) {
            currentFocus = { zone: "scrubber", key: "scrubber" };
            return;
        }
        if (target === loadingButton) {
            currentFocus = { zone: "loading", key: "cancel" };
            return;
        }
        if (target instanceof HTMLButtonElement) {
            if (errorButtons.includes(target)) {
                currentFocus = { zone: "error", key: target.dataset.key ?? "" };
                return;
            }
            const zone = target.dataset.zone;
            if (zone === "transport" || zone === "options") {
                currentFocus = { zone, key: target.dataset.key ?? "" };
            }
        }
    };

    const onFocusOut = (event: FocusEvent): void => {
        if (selectHeld !== undefined && event.target === selectHeld.element) {
            endSelect();
        }
    };

    const onVisibility = (): void => {
        if (document.hidden) endSelect();
    };

    // selectRelease must register before screen capture listeners so isFreshSelect() updates first.
    listenSelectRelease();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", endSelect);
    screen.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = deps.controller.subscribe(render);

    return {
        setStopping(): void {
            if (destroyed || stopping) return;
            stopping = true;
            endSelect();
            renderStopping();
        },
        destroy(): void {
            if (destroyed) return;
            destroyed = true;
            swallowSelect();
            endSelect();
            scroller.stop();
            window.removeEventListener("keydown", onKeyDown, true);
            window.removeEventListener("keyup", onKeyUp, true);
            window.removeEventListener("blur", endSelect);
            screen.removeEventListener("focusin", onFocusIn);
            document.removeEventListener("focusout", onFocusOut, true);
            document.removeEventListener("visibilitychange", onVisibility);
            unsubscribe();
            screen.remove();
        },
    };
}
