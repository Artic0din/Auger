import { CAPTION_FAILED, type PlaybackView } from "./controller.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";

export function mountSubtitles(parent: HTMLElement): (view: PlaybackView) => void {
    const viewport = document.createElement("div");
    Object.assign(viewport.style, { position: "absolute", inset: "0", width: "1920px", height: "1080px", pointerEvents: "none", transformOrigin: "0 0" });
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
    status.textContent = CAPTION_FAILED;
    viewport.appendChild(status);
    return view => {
        viewport.style.transform = (view.phase === "playing" || view.phase === "paused") && view.upNext !== undefined ? "translate(180px, 112px) scale(0.3958333333333333)" : "none";
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

export function applySubtitleAppearance(layer: HTMLElement, text: HTMLElement, style: SubtitleAppearance, secondary = false): void {
        // AetherSubtitleOverlay.defaultPlacement: the second line's inset is 17% at the top and bottom and 36% in the lower third.
        layer.style.top = style.position === "top" ? (secondary ? "17%" : "8%") : "auto";
        layer.style.bottom = style.position === "top" ? "auto" : style.position === "lower-third" ? (secondary ? "36%" : "25%") : secondary ? "17%" : "8%";
        // AetherSubtitleOverlay draws the generic families semibold and a named family at its own weight.
        // Samsung's generic sans-serif face has no semibold, so sans-serif uses the bundled Inter (theme.css).
        const bundledSans = style.fontFamily === "sans-serif";
        const generic = bundledSans || style.fontFamily === "serif" || style.fontFamily === "monospace";
        text.style.fontFamily = `${bundledSans ? "Inter" : style.fontFamily}, sans-serif`;
        text.style.fontWeight = generic ? "600" : "";
        text.style.fontSize = `${{ small: 28, medium: 36, large: 44, xlarge: 54, xxlarge: 64 }[style.fontSize]}px`;
        const rgba = (color: string, opacity: number): string => `rgba(${parseInt(color.slice(1, 3), 16)},${parseInt(color.slice(3, 5), 16)},${parseInt(color.slice(5, 7), 16)},${opacity / 100})`;
        text.style.color = rgba(style.fontColor, style.textOpacity);
        text.style.backgroundColor = style.backgroundStyle === "box" ? rgba(style.backgroundColor, style.backgroundOpacity) : "transparent";
        const outline = style.textOutline || style.backgroundStyle === "outline";
        text.style.textShadow = outline ? `-2px -2px 0 ${style.textOutlineColor},2px -2px 0 ${style.textOutlineColor},-2px 2px 0 ${style.textOutlineColor},2px 2px 0 ${style.textOutlineColor}` : style.backgroundStyle === "shadow" ? `2px 2px 4px ${rgba(style.backgroundColor, style.backgroundOpacity)}` : "none";
}
