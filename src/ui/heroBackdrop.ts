// The Skyline page backdrop behind Home, For You and library landings. Ported (AGPL-3.0-or-later) from
// silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940 `tvOS/Components/TVRootHeroBackdrop.swift`
// (TVBackdropArtworkLayout, TVBackdropArtworkFadeMask, TVBackdropTintWash, the 190pt top scrim) and
// `Components/HeroBackdropPalette.swift` (the sampled base, accent and shadow tints):
// - The art is a 64% x 70% block in the top-right corner, fading toward the leading edge and the bottom.
// - The rest of the page carries colours sampled from that art over black, never a uniform black wash.
// - Apple samples a 64px decode redrawn at 24 x 24; Tizen samples the backdrop it already loaded the same
//   way, else the card's backdrop ThumbHash, else the page stays black (Apple's fallback when sampling fails).
// - Home and library pages wash each screen corner with a colour from the same quarter of the art, as silo-apple
//   c5453eae (#1218) does (`HeroBackdropPalette.sampleCorners`, `TVBackdropCornerWash`, `TVHeroAmbientRenderer`); item
//   details keep the base, accent and shadow wash.

import { decodeThumbhash } from "./thumbhash.ts";
import { el, onDecoded } from "./screen.ts";
import { artworkMark } from "./defaultArtwork.ts";
import type { Clock } from "../api/clock.ts";
import { documentIsRightToLeft } from "../i18n/direction.ts";

export interface RGB { readonly r: number; readonly g: number; readonly b: number }
/** One colour for each screen corner, taken from the same quarter of the art. */
export interface Corners { readonly topLeading: RGB; readonly topTrailing: RGB; readonly bottomTrailing: RGB; readonly bottomLeading: RGB }
export interface Tints { readonly base: RGB; readonly accent: RGB; readonly shadow: RGB; readonly corners: Corners }

const SAMPLE_EDGE = 24;
const PALETTE_MAX_PIXEL = 64;
const BASE_LUMINANCE = 0.22;
const ACCENT_LUMINANCE = 0.22;
const SHADOW_LUMINANCE = 0.07;
const HUE_BINS = 12;

const luminance = (p: RGB): number => 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;

function mean(pixels: readonly RGB[]): RGB {
    let r = 0, g = 0, b = 0;
    for (const p of pixels) { r += p.r; g += p.g; b += p.b; }
    return { r: r / pixels.length, g: g / pixels.length, b: b / pixels.length };
}

/** Dims bright samples and lifts very dark ones so the wash sits on black without overpowering the rows. */
function normalize(p: RGB, target: number): RGB {
    const value = luminance(p);
    const scale = value <= 0.001 ? 0 : value > target ? target / value : Math.max(1, target / Math.max(value, 0.05));
    return { r: Math.min(1, p.r * scale), g: Math.min(1, p.g * scale), b: Math.min(1, p.b * scale) };
}

/** Mean colour of the strongest hue bucket, each pixel weighted by (saturation x value)^2; none for grey art. */
function dominantHue(pixels: readonly RGB[]): RGB | undefined {
    const weights = new Array<number>(HUE_BINS).fill(0);
    const sums = Array.from({ length: HUE_BINS }, () => ({ r: 0, g: 0, b: 0 }));
    for (const p of pixels) {
        const max = Math.max(p.r, p.g, p.b);
        const chroma = max - Math.min(p.r, p.g, p.b);
        if (!(max > 0.15 && chroma > 0)) continue;
        const saturation = chroma / max;
        if (!(saturation > 0.2)) continue;
        let hue = max === p.r ? (p.g - p.b) / chroma : max === p.g ? (p.b - p.r) / chroma + 2 : (p.r - p.g) / chroma + 4;
        hue = (hue / 6) % 1;
        if (hue < 0) hue += 1;
        const bin = Math.min(HUE_BINS - 1, Math.floor(hue * HUE_BINS));
        const weight = (saturation * max) ** 2;
        weights[bin] = (weights[bin] ?? 0) + weight;
        const sum = sums[bin];
        if (sum !== undefined) { sum.r += p.r * weight; sum.g += p.g * weight; sum.b += p.b * weight; }
    }
    let best = 0;
    for (let bin = 1; bin < HUE_BINS; bin++) if ((weights[bin] ?? 0) > (weights[best] ?? 0)) best = bin;
    const weight = weights[best] ?? 0;
    const sum = sums[best];
    if (sum === undefined || weight < pixels.length * 0.01) return undefined;
    return { r: sum.r / weight, g: sum.g / weight, b: sum.b / weight };
}

/** `HeroBackdropPalette.RGB.hsv`: hue in 0..<1, and saturation and value in 0...1. */
export function hsv(p: RGB): { readonly hue: number; readonly saturation: number; readonly value: number } {
    const value = Math.max(p.r, p.g, p.b);
    const chroma = value - Math.min(p.r, p.g, p.b);
    if (!(chroma > 0)) return { hue: 0, saturation: 0, value };
    let hue = value === p.r ? (p.g - p.b) / chroma : value === p.g ? (p.b - p.r) / chroma + 2 : (p.r - p.g) / chroma + 4;
    hue = (hue / 6) % 1;
    if (hue < 0) hue += 1;
    return { hue, saturation: chroma / value, value };
}

/** `HeroBackdropPalette.RGB.init(hue:saturation:value:)`. */
function fromHsv(hue: number, saturation: number, value: number): RGB {
    const sector = (hue * 6) % 6;
    const chroma = value * saturation;
    const x = chroma * (1 - Math.abs((sector % 2) - 1));
    const [r, g, b] = ([[chroma, x, 0], [x, chroma, 0], [0, chroma, x], [0, x, chroma], [x, 0, chroma]] as const)[Math.trunc(sector)] ?? [chroma, 0, x];
    const offset = value - chroma;
    return { r: r + offset, g: g + offset, b: b + offset };
}

/** Brightest a corner may be (HSV value); the top-leading corner sits behind the marquee's title, so it stays darkest. */
const TOP_LEADING_VALUE_CEILING = 0.2;
const CORNER_VALUE_CEILING = 0.4;
/** A corner with any real colour is pushed to at least this saturation, so it reads as a colour on the dark page. */
const CORNER_MINIMUM_SATURATION = 0.6;
/** Below this saturation (or `NEUTRAL_VALUE`) a pixel counts as neutral. */
const NEUTRAL_SATURATION = 0.18;
const NEUTRAL_VALUE = 0.12;
const NEUTRAL_BUCKET = -1;

/** Distance in degrees around the hue circle. */
function hueDistance(a: number, b: number): number {
    const difference = Math.abs(a - b) % 1;
    return Math.min(difference, 1 - difference) * 360;
}

/**
 * `HeroBackdropPalette.cornerPick`: the quarter's most telling colour. Pixels fall into twelve hue buckets plus a neutral one, and each bucket's
 * mean is scored on how much of the quarter it covers and how saturated it is, so a modest patch of real colour wins over a larger grey area.
 * `hue` is undefined when the pick is neutral, and an all-white quarter gives black.
 */
function cornerPick(pixels: readonly RGB[], avoided: number | undefined): { readonly color: RGB; readonly hue: number | undefined } {
    const buckets = new Map<number, RGB[]>();
    for (const pixel of pixels) {
        const { hue, saturation, value } = hsv(pixel);
        // Near-white is usually a blown-out sky or a backdrop's plain field, not a colour the art is about.
        if (value > 0.97 && saturation < 0.05) continue;
        const key = saturation > NEUTRAL_SATURATION && value > NEUTRAL_VALUE ? Math.min(HUE_BINS - 1, Math.floor(hue * HUE_BINS)) : NEUTRAL_BUCKET;
        const members = buckets.get(key);
        if (members === undefined) buckets.set(key, [pixel]); else members.push(pixel);
    }
    let total = 0;
    for (const members of buckets.values()) total += members.length;
    let best: { score: number; color: RGB; hue: number | undefined } = { score: Number.NEGATIVE_INFINITY, color: { r: 0, g: 0, b: 0 }, hue: undefined };
    for (const [key, members] of buckets) {
        const color = mean(members);
        const { hue, saturation } = hsv(color);
        let score = 100 * Math.sqrt(members.length / total) + (saturation >= 0.5 ? 120 : 240 * saturation);
        if (key === NEUTRAL_BUCKET) score -= 40;
        else {
            // Darkened yellow-greens and greens turn olive and sickly.
            if (hue >= 0.22 && hue <= 0.4) score -= 60;
            if (avoided !== undefined && hueDistance(hue, avoided) < 15) score -= 30;
        }
        if (score > best.score) best = { score, color, hue: key === NEUTRAL_BUCKET ? undefined : hue };
    }
    return best;
}

/** `HeroBackdropPalette.cornerTint`: caps brightness and lifts saturation so a corner is a deep colour that rows and text stay legible over. */
function cornerTint(color: RGB, valueCeiling: number): RGB {
    const { hue, saturation, value } = hsv(color);
    return fromHsv(hue, saturation > NEUTRAL_SATURATION ? Math.max(saturation, CORNER_MINIMUM_SATURATION) : saturation, Math.min(value, valueCeiling));
}

/**
 * `HeroBackdropPalette.sampleCorners`: one colour per corner, each from that quarter of a `width` x `height` row-major bitmap with row 0 at
 * the top. The top-trailing and bottom-leading corners avoid the top-leading hue, and the bottom-trailing corner the bottom-leading one, so
 * neighbours differ when the art allows it. Undefined when the bitmap cannot be split into quarters.
 */
export function sampleCorners(pixels: readonly RGB[], width: number, height: number): Corners | undefined {
    if (width < 2 || height < 2 || pixels.length !== width * height) return undefined;
    const midX = Math.floor(width / 2), midY = Math.floor(height / 2);
    const quarter = (left: number, right: number, top: number, bottom: number): RGB[] => {
        const picked: RGB[] = [];
        for (let row = top; row < bottom; row++) for (let column = left; column < right; column++) picked.push(pixels[row * width + column] ?? { r: 0, g: 0, b: 0 });
        return picked;
    };
    const topLeading = cornerPick(quarter(0, midX, 0, midY), undefined);
    const topTrailing = cornerPick(quarter(midX, width, 0, midY), topLeading.hue);
    const bottomLeading = cornerPick(quarter(0, midX, midY, height), topLeading.hue);
    const bottomTrailing = cornerPick(quarter(midX, width, midY, height), bottomLeading.hue);
    return {
        topLeading: cornerTint(topLeading.color, TOP_LEADING_VALUE_CEILING),
        topTrailing: cornerTint(topTrailing.color, CORNER_VALUE_CEILING),
        bottomTrailing: cornerTint(bottomTrailing.color, CORNER_VALUE_CEILING),
        bottomLeading: cornerTint(bottomLeading.color, CORNER_VALUE_CEILING),
    };
}

/** HeroBackdropPalette.sample: base (mean), accent (strongest hue) and shadow (darkest quarter) tints, and the four corners of a `width` x `height` bitmap. */
export function samplePalette(pixels: readonly RGB[], width: number, height: number): Tints | undefined {
    if (pixels.length === 0) return undefined;
    const corners = sampleCorners(pixels, width, height);
    if (corners === undefined) return undefined;
    const base = normalize(mean(pixels), BASE_LUMINANCE);
    const darkest = [...pixels].sort((a, b) => luminance(a) - luminance(b)).slice(0, Math.max(1, Math.floor(pixels.length / 4)));
    const shadow = normalize(mean(darkest), SHADOW_LUMINANCE);
    const hue = dominantHue(pixels);
    return { base, accent: hue === undefined ? base : normalize(hue, ACCENT_LUMINANCE), shadow, corners };
}

export function cssColor(p: RGB, alpha = 1): string {
    const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
    return `rgba(${byte(p.r)},${byte(p.g)},${byte(p.b)},${alpha})`;
}

/** TVBackdropArtworkLayout: 64% of the width and 70% of the 16:9 height, anchored top-right. */
export function backdropFrame(viewportWidth: number): { left: number; top: number; width: number; height: number } {
    const width = Math.round(viewportWidth * 0.64 * 10) / 10;
    const height = Math.round(viewportWidth * 9 / 16 * 0.7 * 10) / 10;
    return { left: Math.round((viewportWidth - width) * 10) / 10, top: 0, width, height };
}

function rgbaPixels(data: ArrayLike<number>): RGB[] {
    const pixels: RGB[] = [];
    for (let index = 0; index + 2 < data.length; index += 4) pixels.push({ r: (data[index] ?? 0) / 255, g: (data[index + 1] ?? 0) / 255, b: (data[index + 2] ?? 0) / 255 });
    return pixels;
}

/** Samples a loaded image as Apple does (a 64px decode redrawn at 24 x 24); undefined when the canvas is tainted. */
export function sampleImage(image: HTMLImageElement): Tints | undefined {
    const width = image.naturalWidth, height = image.naturalHeight;
    if (width <= 0 || height <= 0) return undefined;
    try {
        const scale = Math.min(1, PALETTE_MAX_PIXEL / Math.max(width, height));
        const thumb = document.createElement("canvas");
        thumb.width = Math.max(1, Math.round(width * scale));
        thumb.height = Math.max(1, Math.round(height * scale));
        thumb.getContext("2d")?.drawImage(image, 0, 0, thumb.width, thumb.height);
        const edge = document.createElement("canvas");
        edge.width = SAMPLE_EDGE;
        edge.height = SAMPLE_EDGE;
        const context = edge.getContext("2d");
        if (context === null) return undefined;
        context.drawImage(thumb, 0, 0, SAMPLE_EDGE, SAMPLE_EDGE);
        return samplePalette(rgbaPixels(context.getImageData(0, 0, SAMPLE_EDGE, SAMPLE_EDGE).data), SAMPLE_EDGE, SAMPLE_EDGE);
    } catch {
        // A server that sends no CORS headers for artwork leaves the canvas tainted on some runtimes.
        return undefined;
    }
}

export function sampleThumbhash(encoded: string | undefined): Tints | undefined {
    const decoded = decodeThumbhash(encoded);
    return decoded === undefined ? undefined : samplePalette(rgbaPixels(decoded.rgba), decoded.width, decoded.height);
}

/** A ThumbHash preview drawn at its decoded size; CSS stretches it. */
export function thumbhashCanvas(encoded: string | undefined, className: string): HTMLCanvasElement | undefined {
    const decoded = decodeThumbhash(encoded);
    if (decoded === undefined) return undefined;
    const canvas = el("canvas", className);
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    canvas.setAttribute("aria-hidden", "true");
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    context.putImageData(new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height), 0, 0);
    return canvas;
}

/** Details keep TVDetailPageSurface's uniform base; root pages carry the diagonal tint beneath the same accent and shadow. */
export function washBackground(tints: Tints | undefined, detail = false): string {
    if (tints === undefined) {
        if (!detail) return "#000";
        const fallback = { r: 0.04, g: 0.12, b: 0.14 };
        tints = { base: fallback, accent: fallback, shadow: fallback, corners: { topLeading: fallback, topTrailing: fallback, bottomTrailing: fallback, bottomLeading: fallback } };
    }
    // SwiftUI's topTrailing-to-bottomLeading axis is the 1920 x 1080 diagonal: 180deg + atan(1920 / 1080).
    return [
        `radial-gradient(806.4px 453.6px at 0% 100%, ${cssColor(tints.shadow, 0.55)}, ${cssColor(tints.shadow, 0)})`,
        `radial-gradient(576px 324px at 70% 100%, ${cssColor(tints.accent, 0.3)}, ${cssColor(tints.accent, 0)})`,
        detail ? `linear-gradient(${cssColor(tints.base, 0.42)}, ${cssColor(tints.base, 0.42)})` : `linear-gradient(240.64deg, ${cssColor(tints.base)} 0%, ${cssColor(tints.base, 0.5)} 45%, ${cssColor(tints.base, 0.18)} 100%)`,
        "#000",
    ].join(", ");
}

const WASH_WIDTH = 1920;
const WASH_HEIGHT = 1080;
/** `TVHeroAmbientRenderer.pointsPerPixel` (silo-apple 6eea7cf7): the wash is one bitmap at two screen points per pixel. */
const WASH_POINTS_PER_PIXEL = 2;
/**
 * `SiloTheme.Skyline.marqueeWashCrossfadeDuration` (silo-apple 648091a7): a new wash blends in over the old one for 0.7 s, longer than
 * the art's 0.24 s swap, so a change of focus drifts the page colours. `.skyline-wash-enter` (browse.css) runs the same 0.7 s.
 */
const WASH_CROSSFADE_MILLISECONDS = 700;

/** `TVBackdropCornerWash.reach`: how far each corner's colour reaches before it is fully faded, as a fraction of the screen's width and height. */
const WASH_REACH = 4 / 3;

/**
 * The root wash as one small bitmap, with the layers and geometry of `TVHeroAmbientRenderer.render` (silo-apple c5453eae): black, then each
 * corner's colour fading from full strength to nothing across an ellipse of `WASH_REACH` times the screen, drawn bottom-trailing, bottom-leading,
 * top-trailing and top-leading last, which is the darkest and sits behind the marquee's title. The compositor stretches it, so a new tint costs
 * one small canvas draw instead of a software raster of 1920 x 1080 gradients on the TV (#515); four ellipses replace the earlier base, accent
 * and shadow layers, so the draw does not grow.
 */
function drawWash(canvas: HTMLCanvasElement, tints: Tints | undefined): void {
    canvas.width = WASH_WIDTH / WASH_POINTS_PER_PIXEL;
    canvas.height = WASH_HEIGHT / WASH_POINTS_PER_PIXEL;
    const context = canvas.getContext("2d");
    if (context === null) { canvas.style.background = "#000"; return; }
    context.scale(1 / WASH_POINTS_PER_PIXEL, 1 / WASH_POINTS_PER_PIXEL);
    context.fillStyle = "#000";
    context.fillRect(0, 0, WASH_WIDTH, WASH_HEIGHT);
    if (tints === undefined) return;
    const ellipse = (color: RGB, centerX: number, centerY: number): void => {
        context.save();
        context.translate(centerX * WASH_WIDTH, centerY * WASH_HEIGHT);
        context.scale(WASH_REACH * WASH_WIDTH, WASH_REACH * WASH_HEIGHT);
        const fade = context.createRadialGradient(0, 0, 0, 0, 0, 1);
        fade.addColorStop(0, cssColor(color, 1));
        fade.addColorStop(1, cssColor(color, 0));
        context.fillStyle = fade;
        context.fillRect(-1, -1, 2, 2);
        context.restore();
    };
    ellipse(tints.corners.bottomTrailing, 1, 1);
    ellipse(tints.corners.bottomLeading, 0, 1);
    ellipse(tints.corners.topTrailing, 1, 0);
    ellipse(tints.corners.topLeading, 0, 0);
}

function washBitmap(tints: Tints | undefined): HTMLCanvasElement {
    const canvas = el("canvas", "skyline-wash-bitmap");
    canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%";
    drawWash(canvas, tints);
    return canvas;
}

/**
 * The one tint wash a root page keeps while its backdrops come and go (`TVHeroAmbientWash`): a new bitmap fades in over
 * the ones on screen, which stay fully opaque until it is, and a change that does not fade replaces them.
 */
export class HeroWash {
    readonly element = el("div", "skyline-wash");
    private readonly clock: Clock;
    private cancel = (): void => undefined;

    constructor(clock: Clock) {
        this.clock = clock;
        this.element.setAttribute("aria-hidden", "true");
    }

    show(tints: Tints | undefined, fade: boolean): void {
        this.cancel();
        // A swap sooner than the crossfade leaves the timer to the next one; what lies under the two newest bitmaps is covered.
        for (const covered of Array.from(this.element.children).slice(0, -2)) covered.remove();
        const below = Array.from(this.element.children);
        const next = washBitmap(tints);
        this.element.appendChild(next);
        const drop = (): void => { for (const old of below) old.remove(); };
        if (!fade || below.length === 0) { drop(); return; }
        next.classList.add("skyline-wash-enter");
        this.cancel = this.clock.schedule(drop, WASH_CROSSFADE_MILLISECONDS);
    }

    /** Redraws the newest bitmap with the tint sampled from its image, in place, so a fade under way carries on. */
    update(tints: Tints | undefined): void {
        const newest = this.element.lastElementChild;
        if (newest instanceof HTMLCanvasElement) drawWash(newest, tints);
        else this.show(tints, false);
    }
}

/** Where a shared wash takes one backdrop's tint: first the cached or ThumbHash tint, then the one sampled from the image. */
export type WashSink = (tints: Tints | undefined, sampled: boolean) => void;

/** The artwork frame's box (browse.css `.skyline-art-frame`): its bitmaps keep this shape. */
const ART_FRAME_WIDTH = 1228.8;
const ART_FRAME_HEIGHT = 756;
const PLACEHOLDER_WIDTH = 512;

/** `layer` under the art's own fade (`TVBackdropArtworkFadeMask`, browse.css): opaque to 32% from the artwork's edge, then clear. */
function fadedLayer(width: number, height: number, rtl: boolean, draw: (context: CanvasRenderingContext2D) => void): HTMLCanvasElement | undefined {
    const layer = document.createElement("canvas");
    layer.width = width;
    layer.height = height;
    const context = layer.getContext("2d");
    if (context === null) return undefined;
    draw(context);
    const ramp = context.createLinearGradient(rtl ? 0 : width, 0, rtl ? width : 0, 0);
    ramp.addColorStop(0, "#000");
    ramp.addColorStop(0.32, "#000");
    ramp.addColorStop(1, "rgba(0,0,0,0)");
    context.globalCompositeOperation = "destination-in";
    context.fillStyle = ramp;
    context.fillRect(0, 0, width, height);
    return layer;
}

/**
 * Home's frame placeholder (AsyncImageView's `.surface`): the #0E0F12 backing and the ThumbHash, each under the art's fade
 * and one over the other, drawn once into one bitmap. The stylesheet draws them as two masked layers, and every masked layer
 * is a full-layer draw on the TV for each swap (#310); the pixels are the same. A ThumbHash fills the frame as `object-fit:
 * cover` did. Undefined where no 2D canvas can be made, so the frame keeps the stylesheet's layers.
 */
export function heroPlaceholder(encoded: string | undefined, rtl: boolean): HTMLCanvasElement | undefined {
    const width = PLACEHOLDER_WIDTH;
    const height = Math.round(width * ART_FRAME_HEIGHT / ART_FRAME_WIDTH);
    const canvas = el("canvas", "hero-art-bitmap");
    canvas.width = width;
    canvas.height = height;
    canvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;z-index:-1";
    canvas.setAttribute("aria-hidden", "true");
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    const backing = fadedLayer(width, height, rtl, layer => { layer.fillStyle = "#0e0f12"; layer.fillRect(0, 0, width, height); });
    if (backing !== undefined) context.drawImage(backing, 0, 0);
    const decoded = decodeThumbhash(encoded);
    if (decoded === undefined) return canvas;
    const source = document.createElement("canvas");
    source.width = decoded.width;
    source.height = decoded.height;
    source.getContext("2d")?.putImageData(new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height), 0, 0);
    const scale = Math.max(width / decoded.width, height / decoded.height);
    const preview = fadedLayer(width, height, rtl, layer => layer.drawImage(source, (width - decoded.width * scale) / 2, (height - decoded.height * scale) / 2, decoded.width * scale, decoded.height * scale));
    if (preview !== undefined) context.drawImage(preview, 0, 0);
    return canvas;
}

/**
 * The backdrop for one marquee selection: the tint wash, the masked art block and the top scrim. Tints
 * already sampled for the URL apply at once; otherwise they follow the image's load.
 * `surface` is AsyncImageView's .surface placeholder (Details): the ThumbHash, else #0E0F12, while loading;
 * that surface with a film mark at .3 after a failure; and a 0.12 s fade-in unless the image was cached.
 */
export function heroBackdrop(url: string, thumbhash: string | undefined, cache: Map<string, Tints>, detail = false, surface = false, sink?: WashSink): HTMLElement {
    const root = el("div", "skyline-hero-backdrop");
    const wash = el("div", "skyline-tint-wash");
    const paint = (tints: Tints | undefined, sampled = false): void => { if (sink === undefined) wash.style.background = washBackground(tints, detail); else sink(tints, sampled); };
    paint(cache.get(url) ?? sampleThumbhash(thumbhash));
    if (sink === undefined) root.appendChild(wash);
    if (url === "") return root;
    const frame = el("div", "skyline-art-frame");
    const image = el("img", "skyline-backdrop");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => {
        if (cache.has(url)) return;
        const apply = (tints: Tints | undefined): void => {
            if (tints === undefined) return;
            cache.set(url, tints);
            paint(tints, true);
        };
        const local = sampleImage(image);
        if (local !== undefined) { apply(local); return; }
        // Keep the visible image credential-free and usable when the server refuses CORS sampling.
        const sample = new Image();
        sample.crossOrigin = "anonymous";
        sample.referrerPolicy = "no-referrer";
        sample.addEventListener("load", () => apply(sampleImage(sample)));
        sample.src = url;
    });
    if (surface) {
        frame.classList.add("hero-art-surface");
        if (sink === undefined) {
            const preview = thumbhashCanvas(thumbhash, "hero-art-thumbhash");
            if (preview !== undefined) frame.appendChild(preview);
        } else {
            // Home: the backing and the ThumbHash are one bitmap, so a swap draws one masked layer fewer.
            const baked = heroPlaceholder(thumbhash, documentIsRightToLeft());
            if (baked !== undefined) {
                frame.classList.add("hero-art-baked");
                frame.appendChild(baked);
            } else {
                const preview = thumbhashCanvas(thumbhash, "hero-art-thumbhash");
                if (preview !== undefined) frame.appendChild(preview);
            }
        }
        frame.dataset.art = "loading";
        onDecoded(image, () => { frame.dataset.art = "loaded"; });
        image.addEventListener("error", () => { frame.dataset.art = "failed"; image.remove(); const missing = el("div", "hero-art-missing"); missing.appendChild(artworkMark("film", "hero-art-glyph")); frame.appendChild(missing); });
    } else image.addEventListener("error", () => { image.remove(); frame.remove(); root.querySelector(".skyline-top-scrim")?.remove(); });
    image.src = url;
    // A decoded image paints at once, as AsyncImageView's cached path does.
    if (surface && image.complete && image.naturalWidth > 0) frame.dataset.art = "cached";
    frame.appendChild(image);
    root.appendChild(frame);
    if (!detail && sink === undefined) root.appendChild(el("div", "skyline-top-scrim"));
    return root;
}
