// Badge visual recipes and the document's style overrides.
// Ported (AGPL-3.0-or-later) from silo-apple 5780c84f4a9c1e2bff006e653dd787e01ca24480:
// iosApp/iosApp/Overlays/{OverlayPresets,OverlayColor,OverlaySchema}.swift, which mirror the web's
// presets.ts and style.ts, so a preset looks the same on every client.

export type PresetId = "minimal" | "classic" | "vibrant" | "pill" | "square" | "plate" | "band";
export const PRESETS: readonly PresetId[] = ["minimal", "classic", "vibrant", "pill", "square", "plate", "band"];

/** A straight-alpha sRGB colour: channels 0–255, alpha 0–1 (OverlayColor.swift:6-26). */
export type Rgba = readonly [number, number, number, number];
export const css = ([r, g, b, a]: Rgba): string => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${Math.round(a * 1000) / 1000})`;
const WHITE: Rgba = [255, 255, 255, 1];
const BLACK: Rgba = [0, 0, 0, 1];
const CLEAR: Rgba = [0, 0, 0, 0];
const withAlpha = ([r, g, b]: Rgba, alpha: number): Rgba => [r, g, b, alpha];

/** OverlayColor.swift:28-40: `#RRGGBB` or `#RRGGBBAA`; undefined for anything else. */
export function hexColor(value: string): Rgba | undefined {
    if (!/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return undefined;
    const channel = (index: number): number => parseInt(value.slice(1 + index * 2, 3 + index * 2), 16);
    return [channel(0), channel(1), channel(2), value.length === 9 ? channel(3) / 255 : 1];
}

/** OverlayColor.swift:52-67, CSS `color-mix(in srgb, color share, other)` on premultiplied channels. */
export function mixed(color: Rgba, share: number, other: Rgba): Rgba {
    const rest = 1 - share;
    const alpha = color[3] * share + other[3] * rest;
    if (alpha <= 0) return CLEAR;
    const channel = (index: 0 | 1 | 2): number => (color[index] * color[3] * share + other[index] * other[3] * rest) / alpha;
    return [channel(0), channel(1), channel(2), alpha];
}

/** OverlayColor.swift:69-75: WCAG relative luminance, ignoring alpha. */
function luminance(color: Rgba): number {
    const linear = (value: number): number => { const channel = value / 255; return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

/** OverlayColor.swift:77-82: the WCAG contrast ratio. */
function contrast(a: Rgba, b: Rgba): number {
    const [lighter, darker] = [Math.max(luminance(a), luminance(b)), Math.min(luminance(a), luminance(b))];
    return (lighter + 0.05) / (darker + 0.05);
}

/** OverlayColor.swift:84-87: black or white, whichever reads better on this colour as a fill. */
export const readableText = (color: Rgba): Rgba => luminance(color) > 0.4 ? BLACK : WHITE;

/** An offset shadow in points at the reference width. CSS blur is twice SwiftUI's radius (CardOverlays.swift:501-519). */
export interface Shadow { readonly y: number; readonly blur: number; readonly color: Rgba }
/** OverlayTypes.swift:285-293: `border` undefined draws in the text colour; `bar` is square's left accent bar. */
export interface Paint { readonly background: Rgba; readonly foreground: Rgba; readonly border?: Rgba | undefined; readonly bar?: Rgba | undefined }
type AccentStrategy = "background" | "border" | "text";

/** OverlayTypes.swift:298-345. Lengths are points at the 185-point reference card width. */
export interface Preset {
    readonly id: PresetId;
    /** `band` draws each edge's badges as one strip of marks over a scrim. */
    readonly layout: "stack" | "band";
    /** A rating draws its source mark as an accent-coloured chip ahead of the score. */
    readonly sourceChips: boolean;
    readonly fontSize: number; readonly weight: number; readonly uppercase: boolean;
    /** Letter spacing as a share of the font size. */
    readonly tracking: number;
    readonly padX: number; readonly padY: number;
    /** Undefined is a capsule. */
    readonly radius: number | undefined;
    readonly border: number | undefined;
    /** The accent bar on the badge's left side. */
    readonly bar: number | undefined;
    readonly textShadow: Shadow | undefined; readonly boxShadow: Shadow | undefined;
    readonly iconSize: number; readonly iconGap: number; readonly preferIcon: boolean; readonly gap: number;
    readonly accentStrategy: AccentStrategy;
    readonly paint: (accent: Rgba | undefined) => Paint;
}

/** Tailwind's `tracking-wide` and `tracking-widest` (OverlayPresets.swift:26-28). */
const TRACKING_WIDE = 0.025;
const TRACKING_WIDEST = 0.1;
const WHITE_BORDER = withAlpha(WHITE, 0.15);
const BLACK_60 = withAlpha(BLACK, 0.6);
const PILL_BASE: Rgba = [20, 20, 30, 0.7];
/** SwiftUI's weights: regular, semibold, bold, heavy. */
const REGULAR = 400, SEMIBOLD = 600, BOLD = 700, HEAVY = 800;

/** OverlayPresets.swift:32-226, the web's numbers with its default theme's radii. */
export const PRESET_STYLES: Readonly<Record<PresetId, Preset>> = {
    minimal: { id: "minimal", layout: "stack", sourceChips: false, fontSize: 9, weight: SEMIBOLD, uppercase: true, tracking: TRACKING_WIDEST, padX: 4, padY: 0, radius: 8, border: undefined, bar: undefined, textShadow: { y: 1, blur: 2, color: withAlpha(BLACK, 0.85) }, boxShadow: undefined, iconSize: 10, iconGap: 4, preferIcon: false, gap: 2, accentStrategy: "text",
        paint: accent => ({ background: CLEAR, foreground: accent ?? withAlpha(WHITE, 0.85) }) },
    classic: { id: "classic", layout: "stack", sourceChips: false, fontSize: 10, weight: SEMIBOLD, uppercase: true, tracking: TRACKING_WIDE, padX: 8, padY: 2, radius: undefined, border: 1, bar: undefined, textShadow: undefined, boxShadow: undefined, iconSize: 11, iconGap: 4, preferIcon: false, gap: 4, accentStrategy: "background",
        paint: accent => ({ background: accent === undefined ? BLACK_60 : mixed(accent, 0.28, BLACK_60), foreground: WHITE, border: WHITE_BORDER }) },
    vibrant: { id: "vibrant", layout: "stack", sourceChips: false, fontSize: 10, weight: BOLD, uppercase: true, tracking: TRACKING_WIDE, padX: 8, padY: 2, radius: 10, border: undefined, bar: undefined, textShadow: undefined, boxShadow: { y: 1, blur: 2, color: withAlpha(BLACK, 0.25) }, iconSize: 12, iconGap: 4, preferIcon: true, gap: 4, accentStrategy: "background",
        paint: accent => ({ background: accent ?? [220, 220, 220, 0.95], foreground: accent === undefined ? BLACK : WHITE }) },
    pill: { id: "pill", layout: "stack", sourceChips: false, fontSize: 10, weight: SEMIBOLD, uppercase: true, tracking: TRACKING_WIDE, padX: 10, padY: 4, radius: undefined, border: 1, bar: undefined, textShadow: undefined, boxShadow: undefined, iconSize: 12, iconGap: 4, preferIcon: true, gap: 4, accentStrategy: "background",
        paint: accent => ({ background: accent === undefined ? PILL_BASE : mixed(accent, 0.2, PILL_BASE), foreground: WHITE, border: WHITE_BORDER }) },
    square: { id: "square", layout: "stack", sourceChips: false, fontSize: 9, weight: BOLD, uppercase: true, tracking: TRACKING_WIDEST, padX: 6, padY: 2, radius: 8, border: undefined, bar: 2, textShadow: undefined, boxShadow: undefined, iconSize: 10, iconGap: 4, preferIcon: false, gap: 2, accentStrategy: "border",
        paint: accent => ({ background: withAlpha(BLACK, 0.8), foreground: accent ?? WHITE, bar: accent }) },
    plate: { id: "plate", layout: "stack", sourceChips: true, fontSize: 12, weight: HEAVY, uppercase: true, tracking: TRACKING_WIDE, padX: 7, padY: 4, radius: 6, border: 1, bar: undefined, textShadow: undefined, boxShadow: { y: 2, blur: 6, color: withAlpha(BLACK, 0.35) }, iconSize: 13, iconGap: 5, preferIcon: true, gap: 4, accentStrategy: "border",
        paint: accent => ({ background: withAlpha(BLACK, 0.72), foreground: WHITE, border: accent === undefined ? withAlpha(WHITE, 0.1) : mixed(accent, 0.45, CLEAR) }) },
    band: { id: "band", layout: "band", sourceChips: false, fontSize: 12.5, weight: HEAVY, uppercase: true, tracking: TRACKING_WIDE, padX: 0, padY: 1, radius: 0, border: undefined, bar: undefined, textShadow: { y: 1, blur: 3, color: withAlpha(BLACK, 0.75) }, boxShadow: undefined, iconSize: 13, iconGap: 3, preferIcon: false, gap: 7, accentStrategy: "text",
        paint: accent => ({ background: CLEAR, foreground: accent ?? WHITE }) },
};

/** OverlayTypes.swift:94-125: overrides layered on the preset; each absent field keeps the preset's value. */
export interface OverlayStyle {
    readonly size?: number;
    readonly shape?: "pill" | "rounded" | "square";
    readonly background?: string;
    readonly textColor?: string;
    readonly borderColor?: string;
    readonly borderWidth?: number;
    readonly fontWeight?: "regular" | "semibold" | "extrabold";
    readonly uppercase?: boolean;
    readonly shadow?: boolean;
}

/** OverlaySchema.swift:129-154: keeps the fields the contract accepts; an invalid field is dropped, and an empty style is none. */
export function parseStyle(value: unknown): OverlayStyle | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const pick = <T extends string>(field: unknown, options: readonly T[]): T | undefined => options.find(option => option === field);
    const color = (field: unknown, digits: 6 | 8): string | undefined => typeof field === "string" && new RegExp(`^#[0-9a-fA-F]{${digits}}$`).test(field) ? field : undefined;
    const entries: [keyof OverlayStyle, unknown][] = [
        ["size", typeof raw.size === "number" && raw.size >= 0.75 && raw.size <= 2 ? raw.size : undefined],
        ["shape", pick(raw.shape, ["pill", "rounded", "square"] as const)],
        ["background", color(raw.background, 8)],
        ["textColor", color(raw.textColor, 6)],
        ["borderColor", color(raw.borderColor, 8)],
        ["borderWidth", typeof raw.borderWidth === "number" && Number.isInteger(raw.borderWidth) && raw.borderWidth >= 0 && raw.borderWidth <= 3 ? raw.borderWidth : undefined],
        ["fontWeight", pick(raw.fontWeight, ["regular", "semibold", "extrabold"] as const)],
        ["uppercase", typeof raw.uppercase === "boolean" ? raw.uppercase : undefined],
        ["shadow", typeof raw.shadow === "boolean" ? raw.shadow : undefined],
    ];
    const kept = entries.filter(([, field]) => field !== undefined);
    return kept.length === 0 ? undefined : Object.fromEntries(kept) as OverlayStyle;
}

/** OverlayPresets.swift:232-246. */
const STYLE_SHADOW: Shadow = { y: 2, blur: 6, color: withAlpha(BLACK, 0.35) };
const FRAMED_PADDING_INLINE = 0.6;
const FRAMED_PADDING_BLOCK = 0.2;
const SOLID_FILL_ALPHA = 0.5;
const ACCENT_TEXT_CONTRAST = 3;
const STYLE_WEIGHTS = { regular: REGULAR, semibold: SEMIBOLD, extrabold: HEAVY } as const;
const STYLE_RADII = { pill: undefined, rounded: 6, square: 2 } as const;

/**
 * OverlayPreset.applying (OverlayPresets.swift:248-323), the web's `applyOverlayStyle`: the preset with the style's
 * overrides. A custom fill is tinted by the accent in presets that fill with it; a custom text or border colour yields
 * to the accent where the preset paints it there; a solid fill without a text colour gets black or white text; and an
 * accent the preset writes as text that would not read on that fill tints the fill instead.
 */
export function applyStyle(preset: Preset, style: OverlayStyle | undefined): Preset {
    if (style === undefined) return preset;
    const scale = style.size ?? 1;
    const fontSize = preset.fontSize * scale;
    const background = style.background === undefined ? undefined : hexColor(style.background);
    const textColor = style.textColor === undefined ? undefined : hexColor(style.textColor);
    const borderColor = style.borderColor === undefined ? undefined : hexColor(style.borderColor);
    const fillAlpha = background?.[3] ?? 0;
    const framed = fillAlpha > 0 || (style.borderWidth ?? 0) > 0;
    const solidFill = fillAlpha >= SOLID_FILL_ALPHA ? background : undefined;
    const next: Preset = {
        ...preset,
        fontSize,
        padX: framed ? Math.max(preset.padX * scale, fontSize * FRAMED_PADDING_INLINE) : preset.padX * scale,
        padY: framed ? Math.max(preset.padY * scale, fontSize * FRAMED_PADDING_BLOCK) : preset.padY * scale,
        iconSize: preset.iconSize * scale, iconGap: preset.iconGap * scale, gap: preset.gap * scale,
        weight: style.fontWeight === undefined ? preset.weight : STYLE_WEIGHTS[style.fontWeight],
        uppercase: style.uppercase ?? preset.uppercase,
        radius: style.shape === undefined ? preset.radius : STYLE_RADII[style.shape],
        border: style.borderWidth ?? preset.border,
        boxShadow: style.shadow === false ? undefined : style.shadow === true ? preset.boxShadow ?? STYLE_SHADOW : preset.boxShadow,
        // A shadow drawn to lift text off the artwork only muddies it on a fill.
        textShadow: solidFill === undefined ? preset.textShadow : undefined,
    };
    if (background === undefined && textColor === undefined && borderColor === undefined && style.borderWidth === undefined) return next;
    const strategy = preset.accentStrategy;
    return {
        ...next,
        paint: accent => {
            const result = preset.paint(accent);
            const accentText = accent !== undefined && strategy === "text" && (solidFill === undefined || contrast(accent, solidFill) >= ACCENT_TEXT_CONTRAST);
            const accentFill = accent !== undefined && (strategy === "background" || (strategy === "text" && !accentText));
            const text = textColor ?? (solidFill === undefined ? undefined : readableText(solidFill));
            return {
                ...result,
                ...(background === undefined ? {} : { background: accentFill && accent !== undefined ? mixed(accent, 0.3, background) : background }),
                ...(text === undefined || accentText ? {} : { foreground: text }),
                ...(borderColor === undefined || (accent !== undefined && strategy === "border") ? {} : { border: borderColor }),
            };
        },
    };
}
