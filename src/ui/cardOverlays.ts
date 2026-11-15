// Poster badges (`ui.card_overlays`): the document parser, the badge registry and the layout renderer.
// Ported (AGPL-3.0-or-later) from silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940:
// iosApp/iosApp/Overlays/{OverlayTypes,OverlaySchema,OverlayRegistry,OverlayExtractors,OverlayPresets,CardOverlays,OverlayIcon}.swift.
// Positions, presets, style overrides, layout, uploaded images and the CardWatchStatus corner follow silo-apple
// 5780c84f4a9c1e2bff006e653dd787e01ca24480 (#1117); the presets themselves are in overlayPresets.ts.
// Generic icon ids follow silo-apple 08ff656ff2c35bca13f40901cfe9ed83b8f84d7e
// OverlayRegistry.swift:90-100, :115-249, :300-318, :349-382, :436-455.
// Inline SVGs substitute for SF Symbols; the measured tv glyph keeps its secondary screen fill.
// Wordmarks are text and Dolby Vision a drawn ring in both.

import type { Card } from "../contracts/v2/catalog.ts";
import { artworkUrl } from "./browseModel.ts";
import { resolutionLabel, runtimeText } from "./cardPresentation.ts";
import { applyStyle, css, hexColor, type OverlayStyle, parseStyle, type Preset, PRESET_STYLES, type PresetId, PRESETS, readableText, type Rgba, type Shadow } from "./overlayPresets.ts";
import { el } from "./screen.ts";
import { menuIcon } from "./navigationIcon.ts";

/** OverlayTypes.swift:44-65: the top-right corner belongs to the watch status, so badges use the side rails. */
type Position = "top-left" | "bottom-left" | "bottom-right" | "left-edge" | "right-edge";
type SymbolIcon = "clock" | "tv" | "film" | "ribbon" | "subtitles" | "languages" | "building" | "shield" | "users" | "layout" | "monitor" | "volume" | "globe";
type Icon = SymbolIcon | "HDR" | "HDR10" | "DV" | "ATMOS" | "AV1";

interface ItemConfig {
    readonly enabled: boolean; readonly position: Position; readonly accentColor: string | undefined; readonly showIcon: boolean | undefined;
    /** OverlayTypes.swift:87-91: an uploaded image ref drawn in the icon's place, and refs by value key that replace the whole badge. */
    readonly image: string | undefined; readonly valueImages: Readonly<Record<string, string>>;
}
/** OverlayTypes.swift:269-275: a listed badge image, its server-relative URL and width over height. */
export interface OverlayImageAsset { readonly url: string; readonly aspect: number }
export interface CardOverlayPrefs {
    readonly preset: PresetId; readonly style?: OverlayStyle | undefined; readonly order: readonly string[]; readonly items: ReadonlyMap<string, ItemConfig>;
    /** The overlay-config image list by ref; a ref it does not list draws nothing (OverlaySchema.swift:195-206). */
    readonly images?: ReadonlyMap<string, OverlayImageAsset> | undefined;
}

interface OverlayDef {
    readonly id: string;
    readonly position: Position;
    readonly enabled: boolean;
    readonly accent?: string;
    readonly iconCapable: boolean;
    /** The static icon; `icon` below overrides it. */
    readonly staticIcon?: Icon;
    readonly icon?: (card: Card) => Icon | undefined;
    readonly value: (card: Card) => string | undefined;
    /** A rating's source mark ("IMDb") and bare score, for presets that draw the mark as a chip (OverlayTypes.swift:194-197). */
    readonly sourceMark?: string;
    readonly score?: (card: Card) => string | undefined;
    /** The key a `valueImages` entry matches: the value as the API sends it; absent for badges without per-value images. */
    readonly valueKey?: (card: Card) => string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value === "" ? undefined : value;
}
const oneDecimal = (value: number): string => (Math.round(value * 10) / 10).toFixed(1);
const decimalScore = (value: number | undefined): string | undefined => value === undefined ? undefined : oneDecimal(value);
const percentScore = (value: number | undefined): string | undefined => value === undefined ? undefined : `${value}%`;
/** OverlayRegistry.swift:271-293: a rating's label is its source mark and score, "IMDb 8.5". */
function rating(id: string, mark: string, accent: string, score: (card: Card) => string | undefined): OverlayDef {
    return { id, position: "left-edge", enabled: false, accent, iconCapable: false, sourceMark: mark, score, value: card => { const value = score(card); return value === undefined ? undefined : `${mark} ${value}`; } };
}

/** OverlayRegistry.swift:63-69, web's `compactHdrSuffix`. */
function compactHdrSuffix(value: string | undefined): string | undefined {
    if (nonEmpty(value) === undefined) return undefined;
    return value?.includes("DV") ? "DV" : value?.includes("HDR10+") ? "HDR10+" : "HDR";
}

/** OverlayRegistry.swift:85-88: the combined labels already say HDR, so only the Dolby Vision mark is worth adding. */
const combinedHdrIcon = (card: Card): Icon | undefined => card.overlay?.hdr?.includes("DV") ? "DV" : undefined;

function hdrIcon(value: string | undefined): Icon | undefined {
    if (nonEmpty(value) === undefined) return undefined;
    if (value?.includes("DV")) return "DV";
    return value === "HDR10" ? "HDR10" : value === "HDR" ? "HDR" : undefined;
}

/** OverlayRegistry.swift:391-434: the English status every client recognises, which is also the value key, or the value itself. */
function showStatus(value: string | undefined): string | undefined {
    const raw = nonEmpty(value);
    if (raw === undefined) return undefined;
    const lowered = raw.toLowerCase();
    if (["returning", "returning series", "continuing", "in_production", "in production"].includes(lowered)) return "Returning";
    if (lowered === "ended") return "Ended";
    if (lowered === "cancelled" || lowered === "canceled") return "Cancelled";
    return lowered === "upcoming" || lowered === "planned" ? "Upcoming" : raw;
}

/** OverlayRegistry.swift:109-113: the parts the item has, joined by a space. */
function joinedKey(parts: readonly (string | undefined)[]): string | undefined {
    const key = parts.filter((part): part is string => part !== undefined && part !== "").join(" ");
    return key === "" ? undefined : key;
}

export function languageName(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    try {
        const name = new Intl.DisplayNames(["en"], { type: "language" }).of(trimmed);
        if (name !== undefined && name !== trimmed) return name.replace(/\b\w/g, letter => letter.toUpperCase());
    } catch { /* an invalid tag falls back to its code */ }
    return trimmed.toUpperCase();
}

const firstNonEmpty = (values: readonly string[] | undefined): string | undefined => values?.find(value => value !== "");

/** Registry order is the default render order within a corner. */
const REGISTRY: readonly OverlayDef[] = [
    { id: "resolution", position: "top-left", enabled: true, iconCapable: true, staticIcon: "monitor", value: card => resolutionLabel(card.overlay?.resolution), valueKey: card => nonEmpty(card.overlay?.resolution) },
    { id: "hdr", position: "top-left", enabled: true, iconCapable: true, icon: card => hdrIcon(card.overlay?.hdr), value: card => nonEmpty(card.overlay?.hdr), valueKey: card => nonEmpty(card.overlay?.hdr) },
    { id: "resolution_hdr", position: "top-left", enabled: false, iconCapable: true, icon: combinedHdrIcon, value: card => {
        const resolution = resolutionLabel(card.overlay?.resolution);
        const hdr = compactHdrSuffix(card.overlay?.hdr);
        return resolution === undefined ? undefined : hdr === undefined ? resolution : `${resolution} ${hdr}`;
    }, valueKey: card => nonEmpty(card.overlay?.resolution) === undefined ? undefined : joinedKey([card.overlay?.resolution, card.overlay?.hdr]) },
    // OverlayRegistry.swift:154-173 (silo-apple #1016): the parts the file has, so one without a resolution still shows its audio.
    { id: "resolution_hdr_audio", position: "top-left", enabled: false, iconCapable: true, icon: combinedHdrIcon, value: card => {
        const parts = [resolutionLabel(card.overlay?.resolution), compactHdrSuffix(card.overlay?.hdr), nonEmpty(card.overlay?.audio)].filter((part): part is string => part !== undefined && part !== "");
        return parts.length === 0 ? undefined : parts.join(" ");
    }, valueKey: card => joinedKey([card.overlay?.resolution, card.overlay?.hdr, card.overlay?.audio]) },
    // OverlayRegistry.swift:90-96: the ATMOS wordmark only for a value it fully expresses, so "TrueHD Atmos" keeps its label.
    { id: "audio", position: "top-left", enabled: true, iconCapable: true, icon: card => nonEmpty(card.overlay?.audio) === undefined ? undefined : card.overlay?.audio?.toLowerCase() === "atmos" ? "ATMOS" : "volume", value: card => nonEmpty(card.overlay?.audio), valueKey: card => nonEmpty(card.overlay?.audio) },
    { id: "audio_channels", position: "top-left", enabled: false, iconCapable: true, staticIcon: "volume", value: card => nonEmpty(card.overlay?.audioChannels), valueKey: card => nonEmpty(card.overlay?.audioChannels) },
    { id: "video_codec", position: "top-left", enabled: false, iconCapable: true, staticIcon: "film", icon: card => nonEmpty(card.overlay?.videoCodec) === undefined ? undefined : card.overlay?.videoCodec === "AV1" ? "AV1" : "film", value: card => nonEmpty(card.overlay?.videoCodec), valueKey: card => nonEmpty(card.overlay?.videoCodec) },
    { id: "container", position: "bottom-left", enabled: false, iconCapable: false, value: card => nonEmpty(card.overlay?.container), valueKey: card => nonEmpty(card.overlay?.container) },
    { id: "aspect_ratio", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "layout", value: card => nonEmpty(card.overlay?.aspectRatio), valueKey: card => nonEmpty(card.overlay?.aspectRatio) },
    { id: "release_type", position: "bottom-left", enabled: true, iconCapable: false, value: card => nonEmpty(card.overlay?.releaseType), valueKey: card => nonEmpty(card.overlay?.releaseType) },
    { id: "edition", position: "bottom-left", enabled: false, iconCapable: false, value: card => nonEmpty(card.overlay?.edition), valueKey: card => nonEmpty(card.overlay?.edition) },
    { id: "multi_audio", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "languages", value: card => card.overlay?.multiAudio === true ? "Multi-Audio" : undefined },
    { id: "multi_sub", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "subtitles", value: card => card.overlay?.multiSub === true ? "CC" : undefined },
    rating("rating_imdb", "IMDb", "#f5c518", card => decimalScore(card.ratingImdb)),
    rating("rating_tmdb", "TMDB", "#01b4e4", card => decimalScore(card.ratingTmdb)),
    rating("rating_rt", "RT", "#fa320a", card => percentScore(card.ratingRtCritic)),
    rating("rating_rt_audience", "RT Audience", "#fa6400", card => percentScore(card.ratingRtAudience)),
    { id: "content_rating", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "shield", value: card => card.contentRating, valueKey: card => nonEmpty(card.contentRating) },
    { id: "advisory_age", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "users", value: card => card.advisoryAge !== undefined && card.advisoryAge > 0 ? `${card.advisoryAge}+` : undefined },
    { id: "year", position: "bottom-left", enabled: false, iconCapable: false, value: card => card.year !== undefined && card.year > 0 ? String(card.year) : undefined },
    { id: "runtime", position: "bottom-left", enabled: false, iconCapable: true, staticIcon: "clock", value: card => runtimeText(card.runtimeMinutes) },
    { id: "original_language", position: "bottom-left", enabled: false, iconCapable: true, staticIcon: "globe", value: card => languageName(card.originalLanguage), valueKey: card => nonEmpty(card.originalLanguage) },
    { id: "studio", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "building", value: card => firstNonEmpty(card.studios), valueKey: card => firstNonEmpty(card.studios) },
    { id: "network", position: "bottom-right", enabled: false, iconCapable: true, staticIcon: "tv", value: card => firstNonEmpty(card.networks), valueKey: card => firstNonEmpty(card.networks) },
    { id: "show_status", position: "right-edge", enabled: false, iconCapable: true, staticIcon: "tv", value: card => showStatus(card.showStatus), valueKey: card => showStatus(card.showStatus) },
    // Ribbons whose data the server does not send yet; kept so stored documents keep their entries.
    { id: "imdb_top_250", position: "right-edge", enabled: false, accent: "#f5c518", iconCapable: true, staticIcon: "ribbon", value: () => undefined },
    { id: "rt_certified_fresh", position: "right-edge", enabled: false, accent: "#fa320a", iconCapable: false, value: () => undefined },
];

const POSITIONS: readonly Position[] = ["top-left", "bottom-left", "bottom-right", "left-edge", "right-edge"];

/** OverlayTypes.swift:58-64: a badge stored at top-right, from before that corner held watch status, draws on the right rail. */
function storedPosition(value: unknown): Position | undefined {
    return value === "top-right" ? "right-edge" : POSITIONS.find(position => position === value);
}

function registryDefaults(): Map<string, ItemConfig> {
    return new Map(REGISTRY.map(def => [def.id, { enabled: def.enabled, position: def.position, accentColor: undefined, showIcon: undefined, image: undefined, valueImages: {} }]));
}

/** OverlaySchema.swift:188-191: an uploaded image's content reference, as overlay-config lists it. */
const isImageRef = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}\.webp$/.test(value);
const MAX_VALUE_IMAGES = 32;
const MAX_VALUE_KEY_LENGTH = 64;

/** OverlaySchema.swift:156-166: sorted, so a document over the cap keeps the same entries every parse; the length counts code points. */
function valueImages(raw: unknown): Readonly<Record<string, string>> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
    const entries = raw as Record<string, unknown>;
    const valid = Object.keys(entries).sort().filter(key => key !== "" && [...key].length <= MAX_VALUE_KEY_LENGTH && isImageRef(entries[key]));
    return Object.fromEntries(valid.slice(0, MAX_VALUE_IMAGES).map(key => [key, entries[key] as string]));
}

function patch(base: ItemConfig, raw: unknown): ItemConfig {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return base;
    const entry = raw as Record<string, unknown>;
    return {
        enabled: typeof entry.enabled === "boolean" ? entry.enabled : base.enabled,
        position: storedPosition(entry.position) ?? base.position,
        accentColor: typeof entry.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(entry.accentColor) ? entry.accentColor : undefined,
        showIcon: typeof entry.showIcon === "boolean" ? entry.showIcon : undefined,
        image: isImageRef(entry.image) ? entry.image : undefined,
        valueImages: valueImages(entry.valueImages),
    };
}

/**
 * The profile's stored document (a JSON object) or the administrator's baseline (a JSON string); anything
 * unreadable is the registry defaults. Unknown ids are dropped; version 1 flat documents are migrated.
 */
export function parseOverlayPrefs(raw: unknown): CardOverlayPrefs {
    let doc = raw;
    if (typeof raw === "string") {
        try { doc = raw === "" ? undefined : JSON.parse(raw); } catch { doc = undefined; }
    }
    const items = registryDefaults();
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return { preset: "classic", order: [], items };
    const obj = doc as Record<string, unknown>;
    // OverlaySchema.swift:51-56: version 2, or at least a preset and an items object.
    const v2 = obj.version === 2 || (typeof obj.preset === "string" && typeof obj.items === "object" && obj.items !== null && !Array.isArray(obj.items));
    const patches = v2 ? obj.items : obj;
    if (typeof patches === "object" && patches !== null) {
        for (const [id, base] of items) items.set(id, patch(base, (patches as Record<string, unknown>)[id]));
    }
    return {
        preset: (v2 && PRESETS.find(preset => preset === obj.preset)) || "classic",
        style: v2 ? parseStyle(obj.style) : undefined,
        order: v2 && Array.isArray(obj.order) ? obj.order.filter((id): id is string => typeof id === "string" && REGISTRY.some(def => def.id === id)) : [],
        items,
    };
}

/** OverlayRegistry.swift:19-30: an enabled combined badge hides the badges whose information it already shows. */
const COMBINED_BADGES: readonly (readonly [string, readonly string[]])[] = [
    ["resolution_hdr_audio", ["resolution", "hdr", "audio", "resolution_hdr"]],
    ["resolution_hdr", ["resolution", "hdr"]],
];
const suppressed = (id: string, prefs: CardOverlayPrefs): boolean => COMBINED_BADGES.some(([combined, covers]) => covers.includes(id) && prefs.items.get(combined)?.enabled === true);

/** Enabled badges for a corner, in the document's order. */
function enabledAt(position: Position, prefs: CardOverlayPrefs): OverlayDef[] {
    const candidates = REGISTRY.filter(def => {
        const config = prefs.items.get(def.id);
        return config !== undefined && config.enabled && config.position === position && !suppressed(def.id, prefs);
    });
    if (prefs.order.length === 0) return candidates;
    const rank = (id: string): number => { const index = prefs.order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index; };
    return candidates.map((def, index) => ({ def, index })).sort((a, b) => rank(a.def.id) - rank(b.def.id) || a.index - b.index).map(entry => entry.def);
}

/** CardOverlays.swift:29-38: lengths are points at the 185pt web poster; wide (Continue Watching) badges stay at 1. */
const POSTER_REFERENCE_WIDTH = 185;
const EDGE_INSET = 8;
const EDGE_GAP = 8;
/** CardWatchStatus.size: the top row stops short of the watch-status corner on poster cards. */
const WATCH_STATUS_SIZE = 22;
const MAX_BADGES_PER_CORNER = 3;
const MAX_BADGES_PER_RAIL = 4;
const RAIL_MAX_WIDTH = "60%";
/** Wide cards leave room under the badges for a title block or progress bar (CardOverlays.swift:137-144). */
const WIDE_BOTTOM_INSET = 24;

/** CardWatchStatus.swift:17: Tailwind's `emerald-500` as Apple writes it, sRGB (0, 0.737, 0.49). */
const WATCHED_FILL = `rgb(0,${0.737 * 255},${0.49 * 255})`;
/** CardWatchStatus.swift:43: the episodes-left count's point size at the reference width. */
const EPISODES_LEFT_FONT_SIZE = 11;

/**
 * CardWatchStatus (silo-apple 5780c84 `Overlays/CardWatchStatus.swift:11-81`): the poster's top-right corner, a
 * check on a watched title or the episodes a started series or season has left, scaled from the card width the same
 * way the badges are. Shown whether or not badges are on; wide cards keep their own check.
 */
export function watchStatus(card: Card, artWidth: number): HTMLElement | undefined {
    const left = card.played === true ? undefined : card.episodesLeft;
    if (card.played !== true && left === undefined) return undefined;
    const scale = artWidth / POSTER_REFERENCE_WIDTH;
    const px = (value: number): string => `${Math.round(value * scale * 100) / 100}px`;
    const node = el("span", "card-watch-status");
    node.style.top = node.style.right = px(EDGE_INSET);
    node.style.height = node.style.minWidth = px(WATCH_STATUS_SIZE);
    if (left === undefined) {
        node.classList.add("card-watch-status-played");
        node.style.backgroundColor = WATCHED_FILL;
        node.appendChild(watchedCheck(px(WATCH_STATUS_SIZE * 0.62)));
        // The host card's own label says "Watched" there (TVMediaCard.swift:286-288).
        node.appendChild(el("span", "silo-sr-only", "Watched"));
        return node;
    }
    node.setAttribute("aria-hidden", "true");
    node.textContent = left.toLocaleString();
    node.style.fontSize = `calc(${px(EPISODES_LEFT_FONT_SIZE)} * var(--silo-sf-cap-scale))`;
    node.style.padding = `0 ${px(EPISODES_LEFT_FONT_SIZE * 0.4)}`;
    node.style.letterSpacing = px(interShortfall(EPISODES_LEFT_FONT_SIZE * scale, 700) * EPISODES_LEFT_FONT_SIZE);
    return node;
}

/** The web's check, Lucide's in a 24-unit box, stroked 3.25 units with round ends (CardWatchStatus.swift:33-38, :68-81). */
function watchedCheck(size: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.style.width = svg.style.height = size;
    const line = document.createElementNS(svg.namespaceURI, "polyline");
    line.setAttribute("points", "20 6 9 17 4 12");
    svg.appendChild(line);
    return svg;
}

type Rail = "left" | "right";
/** `mark` is a drawn icon: a wordmark, the Dolby Vision ring or a symbol. */
interface Resolved {
    readonly label: string; readonly mark: Icon | undefined; readonly accent: Rgba | undefined;
    /** The rating's source mark and bare score, when it has both (CardOverlays.swift:171-173, :192-193). */
    readonly sourceMark: string | undefined; readonly score: string | undefined;
    /** Uploaded images, resolved against the server: one in the icon's place, or one for the whole badge (:168-170, :190-191). */
    readonly image?: OverlayImageAsset | undefined; readonly valueImage?: OverlayImageAsset | undefined;
}

function resolve(card: Card, prefs: CardOverlayPrefs, preset: Preset, position: Position, limit: number, baseUrl: string): Resolved[] {
    const asset = (ref: string | undefined): OverlayImageAsset | undefined => {
        const listed = ref === undefined ? undefined : prefs.images?.get(ref);
        const url = listed === undefined ? undefined : artworkUrl(listed.url, baseUrl);
        return listed === undefined || url === undefined ? undefined : { url, aspect: listed.aspect };
    };
    return enabledAt(position, prefs).flatMap(def => {
        const label = def.value(card);
        if (label === undefined) return [];
        const config = prefs.items.get(def.id);
        const icon = def.icon?.(card) ?? def.staticIcon;
        const showIcon = icon !== undefined && def.iconCapable && (config?.showIcon ?? preset.preferIcon);
        const accent = config?.accentColor ?? def.accent;
        const score = def.score?.(card);
        const key = def.valueKey?.(card);
        const image = asset(config?.image), valueImage = asset(key === undefined ? undefined : config?.valueImages[key]);
        return [{ label, mark: showIcon ? icon : undefined, accent: accent === undefined ? undefined : hexColor(accent), sourceMark: score === undefined ? undefined : def.sourceMark, score,
            ...(image === undefined ? {} : { image }), ...(valueImage === undefined ? {} : { valueImage }) }];
    }).slice(0, limit);
}

/** The badge layer for one card's artwork, or undefined when no badge has a value. */
export function overlayLayer(card: Card, prefs: CardOverlayPrefs, variant: "poster" | "wide", artWidth: number, baseUrl: string): HTMLElement | undefined {
    const preset = applyStyle(PRESET_STYLES[prefs.preset], prefs.style);
    const band = preset.layout === "band";
    // CardOverlays.swift:74-78: a filled badge on a rail is a tab flush against the edge; minimal and band keep the inset.
    const flushRails = !band && preset.id !== "minimal";
    const scale = variant === "poster" ? artWidth / POSTER_REFERENCE_WIDTH : 1;
    const px = (value: number): string => `${Math.round(value * scale * 100) / 100}px`;
    const at = (position: Position, limit: number): Resolved[] => resolve(card, prefs, preset, position, limit, baseUrl);
    const layer = el("span", "card-overlays");
    layer.setAttribute("aria-hidden", "true");
    const stack = (name: string, badges: readonly Resolved[], align: "flex-start" | "flex-end" | "stretch", rail?: Rail): HTMLElement => {
        const node = el("span", `card-overlay-stack card-overlay-${name}`);
        node.style.gap = px(preset.gap);
        node.style.alignItems = align;
        for (const badge of badges) node.appendChild(badgeNode(badge, preset, scale, px, rail));
        return layer.appendChild(node);
    };
    const topTrailing = variant === "poster" ? EDGE_INSET + WATCH_STATUS_SIZE + EDGE_GAP : EDGE_INSET;
    const topLeft = at("top-left", MAX_BADGES_PER_CORNER);
    if (topLeft.length > 0 && band) {
        layer.appendChild(bandStrip(topLeft, "top", `${px(EDGE_INSET)} ${px(topTrailing)} ${px(EDGE_INSET * 3)} ${px(EDGE_INSET)}`, preset, scale, px));
    } else if (topLeft.length > 0) {
        const node = stack("top-left", topLeft, "flex-start");
        node.style.top = px(EDGE_INSET);
        node.style.left = px(EDGE_INSET);
        node.style.right = px(topTrailing);
    }
    for (const side of ["left", "right"] as const) {
        const badges = at(`${side}-edge`, MAX_BADGES_PER_RAIL);
        if (badges.length === 0) continue;
        const node = stack(`${side}-edge`, badges, side === "left" ? "flex-start" : "flex-end", flushRails ? side : undefined);
        node.style.setProperty(side, flushRails ? "0" : px(EDGE_INSET));
        node.style.maxWidth = RAIL_MAX_WIDTH;
    }
    const left = at("bottom-left", MAX_BADGES_PER_CORNER);
    const right = at("bottom-right", MAX_BADGES_PER_CORNER);
    const levels = Math.max(left.length, right.length);
    const bottom = variant === "wide" ? `${WIDE_BOTTOM_INSET}px` : px(EDGE_INSET);
    if (levels > 0 && band) {
        // CardOverlays.swift:107-114: one centred strip for the whole bottom edge, left corner first.
        layer.appendChild(bandStrip([...left, ...right], "bottom", `${px(EDGE_INSET * 3)} ${px(EDGE_INSET)} ${bottom} ${px(EDGE_INSET)}`, preset, scale, px));
    } else if (levels > 0) {
        // BottomRows: one row per level from the bottom up, the shorter corner aligned with the bottom; a pair too wide wraps.
        const node = stack("bottom", [], "stretch");
        node.style.left = px(EDGE_INSET);
        node.style.right = px(EDGE_INSET);
        node.style.bottom = bottom;
        for (let level = 0; level < levels; level += 1) {
            const row = node.appendChild(el("span", "card-overlay-row"));
            row.style.columnGap = px(EDGE_GAP);
            row.style.rowGap = px(preset.gap);
            const leading = left[left.length - levels + level];
            const trailing = right[right.length - levels + level];
            if (leading !== undefined) row.appendChild(badgeNode(leading, preset, scale, px));
            if (trailing !== undefined) row.appendChild(badgeNode(trailing, preset, scale, px)).classList.add("card-overlay-trailing");
        }
    }
    return layer.childElementCount === 0 ? undefined : layer;
}

/**
 * BandMarks (CardOverlays.swift:295-330) over the band scrim (:146-157): one row of marks with 1pt dividers between
 * them. The row keeps the marks that fit whole, in order, and drops the rest; only a first mark too wide truncates.
 * The row wraps and shows its first line, so a mark that does not fit leaves with its divider.
 */
function bandStrip(badges: readonly Resolved[], edge: "top" | "bottom", padding: string, preset: Preset, scale: number, px: (value: number) => string): HTMLElement {
    const strip = el("span", `card-overlay-band card-overlay-band-${edge}`);
    strip.style.padding = padding;
    strip.style.backgroundImage = `linear-gradient(to ${edge === "top" ? "bottom" : "top"}, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0) 100%)`;
    const row = strip.appendChild(el("span", "card-overlay-band-row"));
    row.style.justifyContent = edge === "top" ? "flex-start" : "center";
    row.style.height = px(Math.max(...badges.map(badge => badgeHeight(badge, preset))));
    badges.forEach((badge, index) => {
        const item = row.appendChild(el("span", "card-overlay-band-item"));
        if (index > 0) {
            const divider = item.appendChild(el("span", "card-overlay-band-divider"));
            divider.style.height = px(preset.fontSize * 0.9);
            divider.style.margin = `0 ${px(preset.gap)}`;
        }
        item.appendChild(badgeNode(badge, preset, scale, px));
    });
    return strip;
}

/** A badge's height in points: its tallest part, the padding and the border (CardOverlays.swift:377-398, :443-449). */
function badgeHeight(badge: Resolved, preset: Preset): number {
    if (badge.valueImage !== undefined) return valueImageHeight(preset);
    const chip = preset.sourceChips && badge.image === undefined && badge.sourceMark !== undefined ? preset.fontSize * 1.3 : 0;
    const icon = badge.mark === undefined && badge.image === undefined ? 0 : preset.iconSize;
    return Math.max(preset.fontSize, chip, icon) + 2 * (preset.padY + (preset.border ?? 0));
}

const cssShadow = (shadow: Shadow, px: (value: number) => string): string => `0 ${px(shadow.y)} ${px(shadow.blur)} ${css(shadow.color)}`;

/** CardOverlays.swift:336-338, :351-353: an image that replaces a badge is 1.6 times the text badge's height. */
const VALUE_IMAGE_SCALE = 1.6;
const valueImageHeight = (preset: Preset): number => (preset.fontSize + preset.padY * 2) * VALUE_IMAGE_SCALE;

/**
 * An uploaded image at `height` points and the image's own aspect. One that does not load (an administrator deleted
 * it) puts back what the badge draws without it (CardOverlays.swift:344-362, :451-464).
 */
function uploadedImage(asset: OverlayImageAsset, height: number, px: (value: number) => string, fallback: () => HTMLElement, replace: () => HTMLElement): HTMLImageElement {
    const image = el("img", "card-overlay-image");
    image.alt = "";
    image.style.height = px(height);
    image.style.width = px(height * asset.aspect);
    image.addEventListener("error", () => {
        const shown = replace();
        const next = fallback();
        // overlayLayer marks a bottom-right badge after building it; the fallback keeps that corner.
        if (shown.classList.contains("card-overlay-trailing")) next.classList.add("card-overlay-trailing");
        shown.replaceWith(next);
    }, { once: true });
    image.src = asset.url;
    return image;
}

/** OverlayBadgeView (CardOverlays.swift:350-357): a value image stands for the whole badge; otherwise the text badge. */
function badgeNode(badge: Resolved, preset: Preset, scale: number, px: (value: number) => string, rail?: Rail): HTMLElement {
    if (badge.valueImage === undefined) return textBadge(badge, preset, scale, px, rail);
    const holder = el("span", "card-overlay card-overlay-value-image");
    holder.appendChild(uploadedImage(badge.valueImage, valueImageHeight(preset), px, () => badgeNode({ ...badge, valueImage: undefined }, preset, scale, px, rail), () => holder));
    return holder;
}

/** CardOverlays.swift:364-439: padding, then the border outside it; a rail tab is open on its flush side. */
function textBadge(badge: Resolved, preset: Preset, scale: number, px: (value: number) => string, rail?: Rail): HTMLElement {
    const paint = preset.paint(badge.accent);
    const node = el("span", "card-overlay");
    const style = node.style;
    const border = preset.border ?? 0;
    const bar = rail === "left" || paint.bar === undefined ? 0 : preset.bar ?? 0;
    // Apple's point size times --silo-sf-cap-scale, as Home's other text (Typography rule in theme.css).
    style.fontSize = `calc(${px(preset.fontSize)} * var(--silo-sf-cap-scale))`;
    // The web's leading-none: the line is as tall as the font size, so padding alone sets the height.
    style.lineHeight = px(preset.fontSize);
    style.fontWeight = String(preset.weight);
    // The border sits outside the padding and the leading side takes the wider of it and the accent bar.
    style.padding = `${px(preset.padY + border)} ${px(preset.padX + (rail === "right" ? 0 : border))} ${px(preset.padY + border)} ${px(preset.padX + (rail === "left" ? 0 : Math.max(border, bar)))}`;
    if (border > 0) {
        // Drawn as a ring, not a CSS border, which Chromium snaps to whole pixels.
        node.classList.add("card-overlay-framed");
        if (rail !== undefined) node.classList.add(`card-overlay-tab-${rail}`);
        style.setProperty("--card-overlay-border", px(border));
        style.setProperty("--card-overlay-border-color", css(paint.border ?? paint.foreground));
    }
    const radius = preset.radius === undefined ? "999px" : px(preset.radius);
    style.borderRadius = rail === "left" ? `0 ${radius} ${radius} 0` : rail === "right" ? `${radius} 0 0 ${radius}` : radius;
    style.backgroundColor = css(paint.background);
    if (bar > 0 && paint.bar !== undefined) style.backgroundImage = `linear-gradient(to right, ${css(paint.bar)} ${px(bar)}, transparent ${px(bar)})`;
    style.color = css(paint.foreground);
    if (!preset.uppercase) style.textTransform = "none";
    if (preset.boxShadow !== undefined) style.boxShadow = cssShadow(preset.boxShadow, px);
    // CardOverlays.swift:196-202: a label that says what its wordmark spells is dropped ("HDR10 HDR10"); DV has no wordmark.
    const wordmark = badge.mark === "HDR" || badge.mark === "HDR10" || badge.mark === "ATMOS" || badge.mark === "AV1" ? badge.mark : undefined;
    // CardOverlays.swift:367-372: an uploaded image beside a rating stands for its source, so the label drops the mark;
    // without one, plate draws the mark as a chip. The image replaces the icon.
    const chip = badge.image === undefined && preset.sourceChips ? badge.sourceMark : undefined;
    const scoreOnly = (badge.image !== undefined || chip !== undefined) && badge.score !== undefined;
    const label = scoreOnly ? badge.score ?? "" : wordmark !== undefined && badge.label.trim().toLowerCase() === wordmark.toLowerCase() ? "" : badge.label;
    const tracking = px((preset.tracking + interShortfall(preset.fontSize * scale, preset.weight)) * preset.fontSize);
    if (badge.image !== undefined) {
        const image = node.appendChild(uploadedImage(badge.image, preset.iconSize, px, () => textBadge({ ...badge, image: undefined }, preset, scale, px, rail), () => node));
        if (label !== "") image.style.marginRight = px(preset.iconGap);
    } else if (chip !== undefined) {
        // :441-449: the mark in the badge's type, readable on its accent, padded 0.35 × 0.15 of the font size.
        const accent = badge.accent ?? [255, 255, 255, 1];
        const chipNode = node.appendChild(el("span", "card-overlay-chip", chip));
        chipNode.style.letterSpacing = tracking;
        chipNode.style.color = css(readableText(accent));
        chipNode.style.backgroundColor = css(accent);
        chipNode.style.padding = `${px(preset.fontSize * 0.15)} ${px(preset.fontSize * 0.35)}`;
        chipNode.style.borderRadius = px(preset.fontSize * 0.2);
        if (label !== "") chipNode.style.marginRight = px(preset.iconGap);
    } else if (badge.mark !== undefined && wordmark === undefined && badge.mark !== "DV" && badge.mark !== "tv") {
        const frame = el("span", "card-overlay-symbol");
        frame.style.cssText = "display:inline-flex;align-items:center;justify-content:center;flex:none";
        frame.style.minWidth = frame.style.height = px(preset.iconSize);
        if (label !== "") frame.style.marginRight = px(preset.iconGap);
        const measured = badge.mark === "monitor" || badge.mark === "volume" ? BADGE_SYMBOLS[badge.mark] : undefined;
        const glyph = measured === undefined ? menuIcon(badge.mark === "users" ? "switch-profile" : badge.mark) : measuredBadgeSymbol(measured);
        glyph.setAttribute("class", "card-overlay-icon");
        glyph.style.fill = measured === undefined ? "none" : "currentColor";
        glyph.style.stroke = measured !== undefined || badge.mark === "users" ? "none" : "currentColor";
        // OverlayIcon.swift:29-36: semibold symbols at 85%, inside a minimum iconSize-wide frame.
        glyph.setAttribute("stroke-width", "2.5");
        glyph.setAttribute("stroke-linecap", "round");
        glyph.setAttribute("stroke-linejoin", "round");
        const widthRatio = measured?.width ?? (badge.mark === "users" ? 32 / 24 : badge.mark === "languages" ? 26 / 24 : 1);
        if (badge.mark === "users") glyph.setAttribute("viewBox", "-4 0 32 24");
        if (badge.mark === "languages") glyph.setAttribute("viewBox", "0 0 26 24");
        glyph.style.width = px(preset.iconSize * TV_SYMBOL_SCALE * widthRatio);
        glyph.style.height = px(preset.iconSize * TV_SYMBOL_SCALE * (measured?.height ?? 1));
        frame.appendChild(glyph);
        node.appendChild(frame);
    }
    if (badge.image === undefined && badge.mark === "tv") {
        const glyph = tvIcon();
        // OverlayIcon.swift:29-36: the symbol at 85% of iconSize in an iconSize-high frame. "tv" is wider than the
        // frame's minimum width and a little taller than it, so the frame keeps the symbol's width and iconSize's height.
        const height = preset.iconSize * TV_SYMBOL_SCALE * TV_SYMBOL_HEIGHT;
        glyph.style.width = px(preset.iconSize * TV_SYMBOL_SCALE * TV_SYMBOL_WIDTH);
        glyph.style.height = px(height);
        glyph.style.marginTop = glyph.style.marginBottom = px((preset.iconSize - height) / 2);
        if (label !== "") glyph.style.marginRight = px(preset.iconGap);
        node.appendChild(glyph);
    }
    if (badge.image === undefined && badge.mark === "DV") {
        const ring = dolbyVisionMark();
        ring.style.width = ring.style.height = px(preset.iconSize);
        if (label !== "") ring.style.marginRight = px(preset.iconGap);
        node.appendChild(ring);
    }
    if (badge.image === undefined && wordmark !== undefined) {
        // OverlayIcon.swift:15-24: 10-unit black text in a 12-unit-high box; ATMOS is 9 units spaced half a unit apart.
        const units = wordmark === "ATMOS" ? 9 : 10;
        const points = preset.iconSize * units / 12;
        const mark = el("span", "card-overlay-mark", wordmark);
        mark.style.fontSize = `calc(${px(points)} * var(--silo-sf-cap-scale))`;
        mark.style.height = mark.style.lineHeight = px(preset.iconSize);
        mark.style.letterSpacing = px((wordmark === "ATMOS" ? preset.iconSize * 0.5 / 12 : 0) + wordmarkShortfall(wordmark, points * scale) * points);
        if (label !== "") mark.style.marginRight = px(preset.iconGap);
        node.appendChild(mark);
    }
    if (label !== "") {
        const text = node.appendChild(el("span", "card-overlay-label", label));
        // A cut score ("6.") misleads, so a bare score never truncates (CardOverlays.swift:386-388).
        if (scoreOnly) text.classList.add("card-overlay-score");
        // Set on the label itself: theme.css gives every element its own tracking, so it would not inherit.
        text.style.letterSpacing = tracking;
        // The text shadow lifts the label only, not the icon (CardOverlays.swift:385-390).
        if (preset.textShadow !== undefined) text.style.textShadow = cssShadow(preset.textShadow, px);
    }
    return node;
}

/**
 * Inter's per-letter shortfall against SF Pro Text at badge sizes, in em of Apple's point size. SF Pro Text spaces
 * small sizes wider than Inter at the cap-scaled size: measured with CoreText (macOS SF Pro) against InterVariable
 * over twelve badge labels from 8 to 14pt, fitted within 0.002em. Regular and heavy keep the semibold and bold slope,
 * offset by their measured difference from semibold over the same labels. Larger text uses theme.css's tracking instead.
 */
const INTER_SHORTFALL_AT_10: Readonly<Record<number, number>> = { 400: 0.0325, 600: 0.044, 700: 0.051, 800: 0.063 };
function interShortfall(points: number, weight: number): number {
    return Math.max(0, (INTER_SHORTFALL_AT_10[weight] ?? 0.044) - 0.0062 * (points - 10));
}

/**
 * Inter 900's per-letter shortfall against SF Pro black for each wordmark, in em of Apple's point size, at 10pt:
 * CoreText SF Pro black advances against InterVariable 900 at the cap-scaled size, 8 to 12pt. Each falls 0.006em a point.
 */
const WORDMARK_SHORTFALL: Readonly<Record<"HDR" | "HDR10" | "ATMOS" | "AV1", number>> = { HDR: 0.0965, HDR10: 0.0973, ATMOS: 0.0511, AV1: 0.0662 };
function wordmarkShortfall(mark: "HDR" | "HDR10" | "ATMOS" | "AV1", points: number): number {
    return Math.max(0, WORDMARK_SHORTFALL[mark] - 0.006 * (points - 10));
}

/**
 * OverlayIcon.swift:60-83, the web's Dolby Vision mark in a 16-unit box: a 6-unit disc with the left half of a
 * 4.5-unit disc cut out (even-odd), a ring whose right half is filled.
 */
function dolbyVisionMark(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "card-overlay-icon");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("d", "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8ZM8 3.5A4.5 4.5 0 0 0 8 12.5Z");
    svg.appendChild(path);
    return svg;
}

/** OverlayIcon draws a generic symbol at this share of the icon size. */
const TV_SYMBOL_SCALE = 0.85;

// tvOS 27.3 ImageRenderer, 8x, 10.2pt semibold: layout width/height divided by point size.
// Original drawings use the same symbols measured at 48pt; their semibold outlines are 5pt thick.
const BADGE_SYMBOLS = {
    monitor: { width: 14.75 / 10.2, height: 12.25 / 10.2, viewBox: "0 0 69.75 57.625",
        fill: `${roundedRect(6, 4.125, 57.625, 40.5, 5.8)} ${roundedRect(11, 9.125, 47.625, 30.5, 0.8)} M27 44.625H42.625V49.375H27Z ${roundedRect(24.875, 49.375, 20, 4, 2)}` },
    volume: { width: 15.125 / 10.2, height: 10.875 / 10.2, viewBox: "0 0 70.625 50.625",
        fill: "M10 17.125H18.5L31.75 4.875Q36.625 1.875 36.625 7V43.625Q36.625 48.75 31.75 45.75L18.5 33.5H10Q7.375 33.5 7.375 30.875V19.75Q7.375 17.125 10 17.125Z" },
} as const;

function measuredBadgeSymbol(symbol: typeof BADGE_SYMBOLS[keyof typeof BADGE_SYMBOLS]): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", symbol.viewBox);
    svg.setAttribute("aria-hidden", "true");
    const fill = document.createElementNS(svg.namespaceURI, "path");
    fill.setAttribute("d", symbol.fill);
    fill.setAttribute("fill-rule", "evenodd");
    svg.appendChild(fill);
    const detail = document.createElementNS(svg.namespaceURI, "path");
    if (symbol === BADGE_SYMBOLS.monitor) {
        detail.setAttribute("d", roundedRect(11, 9.125, 47.625, 30.5, 0.8));
        detail.setAttribute("fill-opacity", String(TV_SCREEN_FILL));
    } else {
        detail.setAttribute("d", "M45.75 14.125C50 19.25 50 31.25 45.75 36.375M55.875 10C62.25 18 62.25 32.625 55.875 40.625");
        detail.setAttribute("fill", "none");
        detail.setAttribute("stroke", "currentColor");
        detail.setAttribute("stroke-width", "5");
        detail.setAttribute("stroke-linecap", "round");
    }
    svg.appendChild(detail);
    return svg;
}

/**
 * SF Symbol "tv" layout box divided by the font point size (`OverlayIcon` at 48pt
 * is 73×58).
 */
const TV_SYMBOL_WIDTH = 73 / 48;
const TV_SYMBOL_HEIGHT = 58 / 48;

/**
 * SF Symbol "tv" at 48pt semibold, in its 73×58 layout box. Measured from
 * SwiftUI `Image(systemName: "tv").foregroundStyle(.white)`: the screen outline
 * is a 5pt stroke (outer origin 6, 4.688, size 60.062×40.812, corner 10), the
 * screen fill is the secondary layer at 63/255, and the foot sits below the gap.
 */
const TV_SCREEN = { x: 6, y: 4.688, width: 60.062, height: 40.812, radius: 10 } as const;
const TV_STROKE = 5;
const TV_SCREEN_FILL = 63 / 255;
const TV_FOOT = { x: 21.562, y: 49.188, width: 28.875, height: 4.625, radius: 2.312 } as const;

function tvIcon(): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "card-overlay-icon");
    svg.setAttribute("viewBox", "0 0 73 58");
    svg.setAttribute("aria-hidden", "true");
    const inner = {
        x: TV_SCREEN.x + TV_STROKE,
        y: TV_SCREEN.y + TV_STROKE,
        width: TV_SCREEN.width - TV_STROKE * 2,
        height: TV_SCREEN.height - TV_STROKE * 2,
        radius: TV_SCREEN.radius - TV_STROKE,
    };
    const fill = document.createElementNS(svg.namespaceURI, "path");
    fill.setAttribute("fill-opacity", String(TV_SCREEN_FILL));
    fill.setAttribute("d", roundedRect(inner.x, inner.y, inner.width, inner.height, inner.radius));
    const outline = document.createElementNS(svg.namespaceURI, "path");
    outline.setAttribute("fill-rule", "evenodd");
    outline.setAttribute("d", [
        roundedRect(TV_SCREEN.x, TV_SCREEN.y, TV_SCREEN.width, TV_SCREEN.height, TV_SCREEN.radius),
        roundedRect(inner.x, inner.y, inner.width, inner.height, inner.radius),
        roundedRect(TV_FOOT.x, TV_FOOT.y, TV_FOOT.width, TV_FOOT.height, TV_FOOT.radius),
    ].join(""));
    svg.append(fill, outline);
    return svg;
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number): string {
    const r = Math.min(radius, width / 2, height / 2);
    return `M${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${y + height - r}A${r} ${r} 0 0 1 ${x + width - r} ${y + height}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + height - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}
