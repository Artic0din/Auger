// Pieces the Watch Party screens share: Apple's WatchPartyEyebrow, WatchPartyBanner, WatchPartyButtonStyle,
// WatchPartyBackdrop and the circle action button. Metrics are Apple's tvOS values at 1920x1080 (WatchPartyMetrics).

import type { FocusItem } from "./browseFocus.ts";
import { actionButton, artwork } from "./browseViews.ts";
import { el } from "./screen.ts";

export const SVG = "http://www.w3.org/2000/svg";

export function eyebrow(text: string): HTMLElement { return el("p", "watch-party-eyebrow", text); }

export function banner(message: string, warning: boolean): HTMLElement {
    const node = el("div", `watch-party-banner${warning ? " watch-party-banner-warning" : ""}`);
    node.setAttribute("role", "alert");
    node.append(el("span", "watch-party-banner-dot"), el("span", "watch-party-banner-text", message));
    return node;
}

export function icon(path: string): SVGSVGElement {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "watch-party-icon");
    svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(SVG, "path");
    shape.setAttribute("d", path);
    svg.appendChild(shape);
    return svg;
}

export const plusIcon = (): SVGSVGElement => icon("M12 3v18M3 12h18");
export const playIcon = (): SVGSVGElement => { const svg = icon("M7 4.5v15l12-7.5z"); svg.classList.add("watch-party-icon-solid"); return svg; };
export const checkIcon = (): SVGSVGElement => icon("M5 12.5 10 17.5 19 7");
export const closeIcon = (): SVGSVGElement => icon("M6 6 18 18M18 6 6 18");
export const listBulletIcon = (): SVGSVGElement => icon("M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01");
export const searchIcon = (): SVGSVGElement => {
    const svg = icon("m15.5 15.5 5 5");
    const ring = document.createElementNS(SVG, "circle");
    ring.setAttribute("cx", "10.5"); ring.setAttribute("cy", "10.5"); ring.setAttribute("r", "6.5");
    svg.prepend(ring);
    return svg;
};

/** Apple's film.stack symbol for WatchPartyMediaPicker.tvEmptyState. */
export const FILM_STACK_ICON = '<svg viewBox="0 0 48 48" fill="none"><rect x="6" y="14" width="36" height="24" rx="4" stroke="currentColor" stroke-width="3.2"/><path d="M12 8h24M14 14v24M34 14v24M6 22h8M34 22h8M6 30h8M34 30h8" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>';

export function pill(item: FocusItem, kind: "primary" | "secondary", disabled = false): FocusItem {
    item.element.classList.add("watch-party-button", `watch-party-${kind}`);
    item.element.setAttribute("aria-disabled", String(disabled));
    return item;
}

export const enabled = (item: FocusItem): boolean => item.element.getAttribute("aria-disabled") !== "true";

/** A pill button with an optional leading icon. */
export function labelled(key: string, label: string, kind: "primary" | "secondary", onPress: () => void, lead?: SVGSVGElement): FocusItem {
    const item = pill(actionButton(key, label, onPress), kind);
    if (lead !== undefined) item.element.prepend(lead);
    return item;
}

/** TVCircleActionButton: a round icon that opens into a labelled pill on focus. */
export function circleButton(key: string, label: string, glyph: SVGSVGElement, onPress: () => void): FocusItem {
    const item = actionButton(key, "", onPress);
    item.element.classList.add("watch-party-circle");
    item.element.setAttribute("aria-label", label);
    item.element.append(glyph, el("span", "watch-party-circle-label", label));
    return item;
}

export const ellipsisIcon = (): SVGSVGElement => {
    const svg = icon("");
    svg.replaceChildren(...[5, 12, 19].map(x => { const dot = document.createElementNS(SVG, "circle"); dot.setAttribute("cx", String(x)); dot.setAttribute("cy", "12"); dot.setAttribute("r", "2"); return dot; }));
    svg.classList.add("watch-party-icon-solid");
    return svg;
};

/** WatchPartyBackdrop: the film is the room, so its backdrop (or a blurred poster) tints the whole screen. */
export function backdrop(reference: string | undefined, baseUrl: string, poster = false): HTMLElement {
    const node = el("div", `watch-party-backdrop${poster ? " watch-party-backdrop-poster" : ""}`);
    node.setAttribute("aria-hidden", "true");
    if (reference !== undefined) node.appendChild(artwork("watch-party-backdrop-art", reference, baseUrl, ""));
    node.appendChild(el("div", "watch-party-backdrop-shade"));
    return node;
}

/** A party code in Apple's code pill: "JOIN WITH", the code and a QR mark. */
export function codeText(code: string): HTMLElement { return el("span", "watch-party-code", code); }
