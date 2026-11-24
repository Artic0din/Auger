import { shownLocale } from "../i18n/format.ts";
import { translate } from "../i18n/translate.ts";
import type { PlaybackPlan, SelectedTracks, SubtitleTrack, TrackIdentity } from "../contracts/v2/playback.ts";
import type { CatalogSubtitleTrack, SubtitleIntent, SubtitlePreferences } from "../contracts/v2/preplaySubtitles.ts";
import type { AVPlayTrackInfo } from "./avplay.ts";
import { defaultSubtitle, matchesSubtitle, startSubtitleTrackId } from "./preplaySubtitles.ts";
import type { TrackChoice } from "./subtitleTypes.ts";
import { canonicalLanguageKey, orderSubtitles, subtitleRow } from "./trackLabels.ts";

/** Normalized AVPlay TEXT track row; hides raw `extra_info` JSON parsing inside the transport adapter. */
export interface NativeTextTrack {
    readonly index: number;
    readonly language: string | undefined;
}

export interface SubtitleStartInput {
    readonly fileId: string;
    readonly subtitle?: SubtitleIntent;
    readonly subtitleTracks?: readonly CatalogSubtitleTrack[];
    readonly subtitlePreferences?: SubtitlePreferences;
}

/** Apple's `PlayerTrack.unsupportedFormatLabel`. */
export const unsupportedFormat = (): string => translate("detail.trackUnsupported");

const orderedInventories = new WeakMap<
    readonly SubtitleTrack[],
    { readonly language: string | undefined; readonly locale: string; readonly ordered: readonly SubtitleTrack[] }
>();

/**
 * The plan's subtitle rows in display order, sorted once per inventory, preferred language and shown locale
 * (names collate in it): the view is rebuilt on every playback tick. The inventory carries no default flag.
 */
export function orderedInventory(inventory: readonly SubtitleTrack[], language: string | undefined): readonly SubtitleTrack[] {
    const cached = orderedInventories.get(inventory);
    const locale = shownLocale();
    if (cached !== undefined && cached.language === language && cached.locale === locale) return cached.ordered;
    const ordered = orderSubtitles(inventory, language, entry => ({
        language: entry.language,
        codec: entry.codec,
        forced: entry.forced,
        hearingImpaired: entry.hearingImpaired,
        isDefault: false,
    }));
    orderedInventories.set(inventory, { language, locale, ordered });
    return ordered;
}

/** A subtitle the catalog can already name. Off and an unresolved Auto stay omitted. */
export function subtitleStart(request: SubtitleStartInput): { readonly subtitle_track_id: string } | Record<string, never> {
    const subtitleTrackId = startSubtitleTrackId(request.fileId, request.subtitle, request.subtitleTracks, request.subtitlePreferences);
    return subtitleTrackId === undefined ? {} : { subtitle_track_id: subtitleTrackId };
}

/**
 * The plan row of the file's default (else forced) subtitle that Apple's start freezes; the plan inventory carries no default flag.
 * The catalog rows describe the requested file only, so another version keeps its plan's selection. Rows the plan flags unplayable
 * are skipped, as Apple skips rows the server cannot deliver.
 */
export function startingDefault(request: Pick<SubtitleStartInput, "fileId" | "subtitleTracks">, plan: PlaybackPlan): string | undefined {
    if (plan.effectiveMediaFileId !== request.fileId) return undefined;
    const unplayable = plan.subtitle.inventory.filter(entry => entry.unplayable === true);
    const catalog = request.subtitleTracks === undefined
        ? undefined
        : defaultSubtitle(request.subtitleTracks.filter(track => !unplayable.some(entry => matchesSubtitle(entry, track))));
    if (catalog === undefined) return undefined;
    const rows = plan.subtitle.inventory.filter(entry => matchesSubtitle(entry, catalog));
    return rows.length === 1 ? rows[0]?.trackId : undefined;
}

export function subtitleChoice(entry: SubtitleTrack, generated: string | undefined): TrackChoice {
    const choice: TrackChoice = generated === undefined
        ? { id: entry.trackId, ...subtitleRow(entry, entry.combinedIndex) }
        : { id: entry.trackId, label: generated };
    if (entry.unplayable !== true) return choice;
    return {
        ...choice,
        detail: choice.detail === undefined || choice.detail === "" ? unsupportedFormat() : `${choice.detail} · ${unsupportedFormat()}`,
        unavailable: true,
    };
}

/** The shown subtitle; `off` means none even when the plan still names a track. */
export function selectedSubtitle(plan: PlaybackPlan): string | undefined {
    return plan.subtitle.mode === "off" ? undefined : plan.subtitle.trackId;
}

export function selectableSubtitle(plan: PlaybackPlan, trackId: string): boolean {
    return plan.subtitle.inventory.some((entry) => entry.trackId === trackId && entry.unplayable !== true);
}

/** The identity of a plan's drawn subtitle file, as caption loading keys its read. */
export function captionKeyOf(plan: PlaybackPlan): string | undefined {
    const artifact = plan.subtitle.mode === "render" || plan.subtitle.mode === "convert" ? plan.subtitle.artifact : undefined;
    return artifact === undefined ? undefined : `${artifact.format} ${artifact.origin} ${artifact.url}`;
}

export function textSubtitle(codec: string | undefined): boolean {
    return codec !== undefined && ["srt", "subrip", "webvtt", "vtt", "ass", "ssa", "mov_text", "text"].includes(codec.toLowerCase());
}

/** The format a sidecar's URL names, when the app can draw it. */
export function secondaryFormat(row: SubtitleTrack): string | undefined {
    if (row.url === undefined) return undefined;
    try {
        const extension = new URL(row.url, "https://sidecar.invalid").pathname.split(".").pop()?.toLowerCase();
        return extension === "vtt" || extension === "srt" || extension === "ass" || extension === "ssa" ? extension : undefined;
    } catch {
        // The inventory is the server's; a URL that cannot be parsed is not a track the app can draw.
        return undefined;
    }
}

/** Text sidecars the app can draw as the second line, primary included (it is listed dimmed, as Apple lists it). */
export function secondaryRows(plan: PlaybackPlan): readonly SubtitleTrack[] {
    return plan.subtitle.inventory.filter(row => row.delivery === "sidecar" && row.unplayable !== true && textSubtitle(row.codec) && secondaryFormat(row) !== undefined);
}

/** A listed HLS rendition, or Off while one is showing. Burn-in is not a rendition switch. */
export function renditionSwitch(plan: PlaybackPlan, trackId: string | undefined): boolean {
    if (plan.streamProtocol !== "hls") return false;
    if (trackId === undefined) return plan.subtitle.hlsRendition !== undefined || plan.subtitle.inventory.some((row) => row.hlsRendition !== undefined);
    return plan.subtitle.inventory.find((row) => row.trackId === trackId)?.hlsRendition !== undefined;
}

/** Direct Play asks for embedded text as files the app draws (#538), so choosing one replans for its file; AVPlay's copy is only the fallback when the file fails. */
export function loadsEmbeddedFile(plan: PlaybackPlan, trackId: string | undefined): boolean {
    if (trackId === undefined || plan.delivery !== "original_http" || plan.streamProtocol === "hls") return false;
    const row = plan.subtitle.inventory.find(entry => entry.trackId === trackId);
    return row !== undefined && inStreamCandidate(plan, row);
}

export function inStreamCandidate(plan: PlaybackPlan, row: SubtitleTrack): boolean {
    if (row.delivery === "burn_in_only" || row.source === "external" || row.source === "downloaded") return false;
    if (plan.streamProtocol === "hls") return row.hlsRendition !== undefined;
    return plan.delivery === "original_http" && row.source === "embedded" && textSubtitle(row.codec);
}

export function parseAVPlayTextTracks(tracks: readonly AVPlayTrackInfo[]): readonly NativeTextTrack[] {
    return tracks
        .filter((track) => track.type === "TEXT")
        .map((track) => ({ index: track.index, language: trackLanguage(track) }));
}

function trackLanguage(track: AVPlayTrackInfo): string | undefined {
    try {
        const extra: unknown = JSON.parse(track.extra_info);
        if (typeof extra !== "object" || extra === null || !("track_lang" in extra)) return undefined;
        const language = extra.track_lang;
        return typeof language === "string" ? language.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

export function textTrackIndex(tracks: readonly NativeTextTrack[], row: SubtitleTrack, languageOnly: boolean): number | undefined {
    const ordinal = row.hlsRendition?.index;
    const published = ordinal === undefined ? undefined : tracks[ordinal - 1];
    if (!languageOnly && published !== undefined) return published.index;
    // An original file's TEXT rows are numbered by the file's stream index, which the server publishes as `stream_index`
    // (the S95C selected English SDH, artifact 9.vtt, as TEXT 12 after one video and two audio streams). A file can hold several tracks in one language.
    const language = canonicalLanguageKey(row.language);
    if (languageOnly && row.streamIndex !== undefined) {
        const stream = tracks.find(track => track.index === row.streamIndex);
        // A row in another known language means AVPlay numbers this file differently: match by language instead.
        const other = stream === undefined ? undefined : canonicalLanguageKey(stream.language);
        if (stream !== undefined && (language === undefined || other === undefined || other === language)) return stream.index;
    }
    if (language !== undefined) {
        const matches = tracks.filter((track) => canonicalLanguageKey(track.language) === language);
        const match = matches.length === 1 ? matches[0] : undefined;
        if (match !== undefined) return match.index;
    }
    if (languageOnly) return undefined;
    return ordinal === undefined ? undefined : tracks[ordinal - 1]?.index;
}

export function streamRenditionAnswer(plan: PlaybackPlan, id: string | undefined): boolean {
    if (id === undefined) return plan.subtitle.mode === "off";
    const row = plan.subtitle.inventory.find((entry) => entry.trackId === id);
    return row?.hlsRendition !== undefined && plan.subtitle.mode !== "burn_in" && plan.subtitle.mode !== "off" && plan.subtitle.mode !== "unknown";
}

/**
 * Same original file and stream path. AVPlay cannot send headers, so a renewed `st` is still
 * this picture. A sidecar or Off draws here. An audio change, a burn-in, a native row with no
 * artifact, or a different native embedded selection does not.
 */
export function sameDirectTransport(current: PlaybackPlan, next: PlaybackPlan, requested?: SelectedTracks): boolean {
    if (!sameDirectStreamUrl(current.streamUrl, next.streamUrl) || current.delivery !== "original_http" || next.delivery !== "original_http") return false;
    if (current.effectiveMediaFileId !== next.effectiveMediaFileId || current.streamProtocol !== next.streamProtocol) return false;
    if (current.timeline.streamOriginSeconds !== next.timeline.streamOriginSeconds || current.timeline.timelineOffsetSeconds !== next.timeline.timelineOffsetSeconds) return false;
    if (!samePlanAudio(current.selectedTracks.audio, next.selectedTracks.audio)) return false;
    if (requestedAudioChanges(current.selectedTracks.audio, requested?.audio)) return false;
    if (current.subtitle.mode === "burn_in" || next.subtitle.mode === "burn_in" || current.subtitle.mode === "unknown" || next.subtitle.mode === "unknown") return false;
    if ((next.subtitle.mode === "render" || next.subtitle.mode === "convert") && next.subtitle.artifact === undefined) return false;
    if (nativeEmbeddedSelection(current) !== nativeEmbeddedSelection(next)) return false;
    if ((current.recipe !== undefined || next.recipe !== undefined) && !sameRecipe(current.recipe, next.recipe)) return false;
    return true;
}

/** Same path and query, ignoring a renewed `st`. A different path or any other query value is a new stream. */
export function sameDirectStreamUrl(current: string, next: string): boolean {
    if (current === next) return true;
    let left: URL;
    let right: URL;
    try {
        left = new URL(current, "https://stream.invalid");
        right = new URL(next, "https://stream.invalid");
    } catch {
        return false;
    }
    if (left.protocol !== right.protocol || left.host !== right.host || left.pathname !== right.pathname || left.hash !== right.hash) return false;
    const keys = new Set<string>();
    for (const key of left.searchParams.keys()) keys.add(key);
    for (const key of right.searchParams.keys()) keys.add(key);
    for (const key of keys) {
        if (key === "st") continue;
        const leftValues = left.searchParams.getAll(key);
        const rightValues = right.searchParams.getAll(key);
        if (leftValues.length !== rightValues.length || leftValues.some((value, index) => value !== rightValues[index])) return false;
    }
    return true;
}

function samePlanAudio(current: TrackIdentity | undefined, next: TrackIdentity | undefined): boolean {
    return current?.id === next?.id && current?.index === next?.index;
}

/** The viewer asked for different audio. Apple reloads on that change even when the answer keeps the previous track. */
function requestedAudioChanges(current: TrackIdentity | undefined, requested: TrackIdentity | undefined): boolean {
    if (requested === undefined) return false;
    if (requested.id !== current?.id) return true;
    return requested.index !== undefined && requested.index !== current?.index;
}

/**
 * The native embedded text this direct-play plan binds, or none when the overlay draws a sidecar.
 * Apple reloads when this identity changes: `subtitle.embedded`, or a render/convert row with no artifact.
 */
function nativeEmbeddedSelection(plan: PlaybackPlan): string | undefined {
    if (plan.subtitle.embedded !== undefined) return `embedded:${plan.subtitle.embedded.streamIndex}`;
    if ((plan.subtitle.mode !== "render" && plan.subtitle.mode !== "convert") || plan.subtitle.artifact !== undefined) return undefined;
    const id = plan.subtitle.trackId;
    if (id === undefined) return undefined;
    const row = plan.subtitle.inventory.find((entry) => entry.trackId === id);
    if (row === undefined || !inStreamCandidate(plan, row)) return undefined;
    return `${id}\n${row.streamIndex ?? ""}\n${row.nativeSelectable === true ? "1" : "0"}`;
}

export function keepsHlsTransport(current: PlaybackPlan, next: PlaybackPlan): boolean {
    return current.streamProtocol === "hls"
        && next.streamProtocol === "hls"
        && current.streamUrl === next.streamUrl
        && current.delivery === next.delivery
        && current.effectiveMediaFileId === next.effectiveMediaFileId
        && current.expiresAt !== undefined
        && current.expiresAt === next.expiresAt
        && current.timeline.streamOriginSeconds === next.timeline.streamOriginSeconds
        && current.timeline.timelineOffsetSeconds === next.timeline.timelineOffsetSeconds
        && sameRecipe(current.recipe, next.recipe)
        && current.selectedTracks.audio?.id === next.selectedTracks.audio?.id
        && current.selectedTracks.audio?.index === next.selectedTracks.audio?.index
        && sameRenditions(current, next);
}

function sameRecipe(left: PlaybackPlan["recipe"], right: PlaybackPlan["recipe"]): boolean {
    return left !== undefined && right !== undefined
        && left.videoCodec === right.videoCodec
        && left.audioCodec === right.audioCodec
        && left.width === right.width
        && left.height === right.height
        && left.bitrateKbps === right.bitrateKbps;
}

function sameRenditions(left: PlaybackPlan, right: PlaybackPlan): boolean {
    const current = renditionSlots(left);
    const next = renditionSlots(right);
    const keys = Object.keys(current);
    return keys.length > 0 && keys.length === Object.keys(next).length && keys.every((key) => current[key] === next[key]);
}

function renditionSlots(plan: PlaybackPlan): Record<string, string> {
    const slots: Record<string, string> = {};
    for (const row of plan.subtitle.inventory) {
        const rendition = row.hlsRendition;
        if (rendition !== undefined) slots[row.trackId] = `${rendition.groupId}\n${rendition.name}\n${rendition.index}`;
    }
    return slots;
}
