// HoldSeekIndicator.swift (silo-apple main 3289bedb): floating preview, rate capsule, 520px progress line, and hint row.
import type { Clock } from "../api/clock.ts";
import { localizeNumerals } from "../i18n/format.ts";
import { translate } from "../i18n/translate.ts";
import { el } from "../ui/screen.ts";
import type { PlayerControls } from "./controller.ts";
import { arrowsLeftRightIcon, backwardFillIcon, circleFillIcon, forwardFillIcon, uturnBackwardIcon } from "./playerIcons.ts";
import { createSeekTileRenderer } from "./seekThumbnailView.ts";

const PREVIEW_WIDTH = 480;
const PREVIEW_HEIGHT = 270;

export interface HoldSeekIndicatorView {
    show(rate: number, previewTime: number, duration: number, clockText: (seconds: number) => string): void;
    refreshLabels(): void;
    clear(): void;
}

function hintItem(icon: string): { readonly item: HTMLElement; readonly label: HTMLElement } {
    const item = el("span", "player-hold-seek-hint-item");
    const glyph = el("span", "player-hold-seek-hint-icon");
    glyph.setAttribute("aria-hidden", "true");
    glyph.innerHTML = icon;
    const label = el("span", "player-hold-seek-hint-label");
    item.append(glyph, label);
    return { item, label };
}

export function mountHoldSeekIndicator(parent: HTMLElement, controls: PlayerControls, clock: Clock): HoldSeekIndicatorView {
    const root = el("div", "player-hold-seek");
    root.setAttribute("aria-hidden", "true");
    root.hidden = true;

    const preview = el("div", "player-hold-seek-preview");
    preview.hidden = true;

    const chip = el("div", "player-hold-seek-chip");
    chip.setAttribute("dir", "ltr");
    const icon = el("span", "player-hold-seek-icon");
    const rateLabel = el("span", "player-hold-seek-rate");
    const timeLabel = el("span", "player-hold-seek-time");
    chip.append(icon, rateLabel, timeLabel);

    const progress = el("div", "player-hold-seek-progress");
    progress.setAttribute("dir", "ltr");
    const progressFill = el("div", "player-hold-seek-progress-fill");
    progress.append(progressFill);
    progress.hidden = true;

    const hint = el("div", "player-hold-seek-hint");
    const speedHint = hintItem(arrowsLeftRightIcon());
    const playHint = hintItem(circleFillIcon());
    const cancelHint = hintItem(uturnBackwardIcon());
    hint.append(speedHint.item, playHint.item, cancelHint.item);

    root.append(preview, chip, progress, hint);
    parent.appendChild(root);

    const renderer = createSeekTileRenderer(preview, controls, clock, PREVIEW_WIDTH, PREVIEW_HEIGHT, (loaded) => {
        preview.hidden = !loaded;
    });

    const refreshLabels = (): void => {
        speedHint.label.textContent = translate("player.settings.speed");
        playHint.label.textContent = translate("player.audio.play");
        cancelHint.label.textContent = translate("common.cancel");
    };
    refreshLabels();

    let lastDirection: "forward" | "backward" | undefined;
    let lastRequestedSecond: number | undefined;

    return {
        show(rate, previewTime, duration, clockText) {
            root.hidden = false;
            const direction = rate >= 0 ? "forward" : "backward";
            if (lastDirection !== direction) {
                lastDirection = direction;
                root.dataset.direction = direction;
                icon.innerHTML = direction === "forward" ? forwardFillIcon() : backwardFillIcon();
            }
            rateLabel.textContent = `${localizeNumerals(String(Math.abs(rate)))}×`;
            timeLabel.textContent = clockText(previewTime);
            if (duration > 0) {
                progress.hidden = false;
                const fraction = Math.min(Math.max(previewTime / duration, 0), 1);
                progressFill.style.width = `${fraction * 100}%`;
            } else {
                progress.hidden = true;
            }
            const rounded = Math.floor(previewTime);
            if (lastRequestedSecond !== rounded) {
                lastRequestedSecond = rounded;
                renderer.request(previewTime);
            }
        },
        refreshLabels,
        clear() {
            lastDirection = undefined;
            lastRequestedSecond = undefined;
            delete root.dataset.direction;
            renderer.clear();
            preview.hidden = true;
            root.hidden = true;
        },
    };
}
