import { translate } from "../i18n/translate.ts";
import { textIsRightToLeft } from "../i18n/direction.ts";
import type { PlaybackView } from "./controller.ts";
import { UP_NEXT_PREVIEW, upNextPreviewLeft } from "./upNextPreview.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";

const SCREEN_WIDTH = 1920;

export function mountSubtitles(parent: HTMLElement): (view: PlaybackView) => void {
    const viewport = document.createElement("div");
    Object.assign(viewport.style, { position: "absolute", inset: "0", width: `${SCREEN_WIDTH}px`, height: "1080px", pointerEvents: "none", transformOrigin: "0 0" });
    parent.appendChild(viewport);
    const layer = document.createElement("div");
    layer.className = "player-captions";
    layer.setAttribute("aria-live", "off");
    const text = document.createElement("span");
    layer.appendChild(text);
    viewport.appendChild(layer);
    // SECONDARY: the second line, in the primary's style, further from the edge it hugs.
    const secondaryLayer = document.createElement("div");
    secondaryLayer.className = "player-captions-secondary";
    secondaryLayer.setAttribute("aria-live", "off");
    const secondaryText = document.createElement("span");
    secondaryLayer.appendChild(secondaryText);
    viewport.appendChild(secondaryLayer);
    // ASSSubtitleLayer.status: the failure stays over the video until the track loads or changes.
    const status = document.createElement("div");
    status.className = "player-caption-status";
    viewport.appendChild(status);
    return view => {
        // Apple's `player.subtitles.dataLoadFailed`, read on every draw so a language that lands later shows.
        status.textContent = translate("player.subtitles.dataLoadFailed");
        viewport.style.transform = (view.phase === "playing" || view.phase === "paused") && view.upNext !== undefined ? `translate(${upNextPreviewLeft(SCREEN_WIDTH, textIsRightToLeft())}px, ${UP_NEXT_PREVIEW.top}px) scale(${UP_NEXT_PREVIEW.width / SCREEN_WIDTH})` : "none";
        const captions = view.phase === "playing" || view.phase === "paused" ? view.captions : undefined;
        text.textContent = captions?.text ?? "";
        layer.hidden = !captions?.text;
        // Read on a TV to tell an empty layer apart: suppressed, no sidecar, loading, failed, or ready with no cue at this clock reading.
        layer.dataset.state = captions === undefined ? "suppressed" : captions.status ?? "none";
        layer.dataset.cues = String(captions?.cueCount ?? 0);
        layer.dataset.at = captions?.instant === undefined ? "" : captions.instant.toFixed(1);
        status.hidden = captions?.status !== "failed";
        secondaryText.textContent = captions?.secondaryText ?? "";
        secondaryLayer.hidden = !captions?.secondaryText;
        if (captions === undefined) return;
        applySubtitleAppearance(layer, text, captions.appearance);
        applySubtitleAppearance(secondaryLayer, secondaryText, captions.appearance, true);
    };
}

/** Apple's tvOS cue sizes in points on the 1080-line playfield (SubtitleAppearance.swift:38-45 at silo-apple 449ba47). */
const SUBTITLE_POINTS = { small: 43, medium: 51, large: 58, xlarge: 74, xxlarge: 88 } as const;

/**
 * A cue's CSS font size at `scale` of the playfield (the Settings preview is 0.5, SubtitleAppearancePreview.swift:21).
 * Apple draws the generic families in SF (AetherSubtitleOverlay.swift:571-590). Tizen's bundled Inter stands in for SF Pro, so
 * sans-serif takes the cap scale as every Inter text does; Samsung's serif and monospace faces and a named family are not SF
 * stand-ins, so they draw at raw points, as Apple draws a named family (#789).
 */
export function subtitleFontSize(style: SubtitleAppearance, scale = 1): string {
    const points = SUBTITLE_POINTS[style.fontSize] * scale;
    return style.fontFamily === "sans-serif" ? `calc(${points}px * var(--silo-sf-cap-scale))` : `${points}px`;
}

/**
 * `AetherSubtitleOverlay.decoratedText` (AetherSubtitleOverlay.swift:294-321, silo-apple 3289bedb):
 * four-corner outline thickness scales with the 1080p point size (`max(0.5, min(2, points * 0.03) * scale)`),
 * and drop shadow layers independently (`1.5px 2px 3px rgba(0, 0, 0, 0.85)` scaled by `scale`).
 */
export function subtitleTextShadow(style: SubtitleAppearance, scale = 1): string {
    const shadows: string[] = [];
    if (style.textOutline || style.backgroundStyle === "outline") {
        const edge = Math.max(0.5, Math.min(2, SUBTITLE_POINTS[style.fontSize] * 0.03) * scale);
        const px = `${Number(edge.toFixed(2))}px`;
        const color = style.textOutlineColor;
        shadows.push(
            `${px} ${px} 0 ${color}`,
            `-${px} ${px} 0 ${color}`,
            `${px} -${px} 0 ${color}`,
            `-${px} -${px} 0 ${color}`,
        );
    }
    if (style.backgroundStyle === "shadow") {
        const x = `${Number(Math.max(0.5, 1.5 * scale).toFixed(2))}px`;
        const y = `${Number(Math.max(0.5, 2 * scale).toFixed(2))}px`;
        const blur = `${Number(Math.max(1, 3 * scale).toFixed(2))}px`;
        shadows.push(`${x} ${y} ${blur} rgba(0, 0, 0, 0.85)`);
    }
    return shadows.length === 0 ? "none" : shadows.join(", ");
}

export function applySubtitleAppearance(layer: HTMLElement, text: HTMLElement, style: SubtitleAppearance, secondary = false, scale = 1): void {
        // AetherSubtitleOverlay.defaultPlacement (:376-434): the primary's inset is 8% at the top and bottom and 27% in the lower
        // third; the second line's is 17% and 36%. Apple places the two independently, so a tall primary can reach the second line.
        layer.style.top = style.position === "top" ? (secondary ? "17%" : "8%") : "auto";
        layer.style.bottom = style.position === "top" ? "auto" : style.position === "lower-third" ? (secondary ? "36%" : "27%") : secondary ? "17%" : "8%";
        // AetherSubtitleOverlay draws the generic families semibold and a named family at its own weight.
        // Samsung's generic sans-serif face has no semibold, so sans-serif uses the bundled Inter (theme.css).
        const bundledSans = style.fontFamily === "sans-serif";
        const generic = bundledSans || style.fontFamily === "serif" || style.fontFamily === "monospace";
        text.style.fontFamily = `${bundledSans ? "Inter" : style.fontFamily}, sans-serif`;
        text.style.fontWeight = generic ? "600" : "";
        text.style.fontSize = subtitleFontSize(style, scale);
        const rgba = (color: string, opacity: number): string => `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${opacity / 100})`;
        text.style.color = rgba(style.fontColor, style.textOpacity);
        text.style.backgroundColor = style.backgroundStyle === "box" ? rgba(style.backgroundColor, style.backgroundOpacity) : "transparent";
        text.style.textShadow = subtitleTextShadow(style, scale);
}
