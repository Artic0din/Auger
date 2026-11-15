import type { CatalogSubtitleTrack, SubtitleIntent, SubtitlePreferences, SubtitleSignature } from "../contracts/v2/preplaySubtitles.ts";
import { titleIndicatesHearingImpaired } from "./trackLabels.ts";
import type { SubtitleTrack } from "../contracts/v2/playback.ts";

const normalized = (value: string | undefined): string => value?.trim().toLowerCase() ?? "";
function language(value: string | undefined): string {
    try { const locale = new Intl.Locale((value ?? "").replace(/_/g, "-")); return locale.language === "und" ? "" : locale.toString().toLowerCase(); }
    catch { return ""; }
}

export function matchesSubtitle(track: SubtitleSignature, signature: SubtitleSignature): boolean {
    return track.source === signature.source && language(track.language) === language(signature.language) && normalized(track.codec) === normalized(signature.codec)
        && (!signature.label || normalized(track.label) === normalized(signature.label)) && track.forced === signature.forced && track.hearingImpaired === signature.hearingImpaired;
}

/** Apple Details scoring requires a language or label hit before seeding a saved choice. */
export function preferredCatalogSubtitle(tracks: readonly SubtitleSignature[], signature: SubtitleSignature | undefined): SubtitleSignature | undefined {
    if (signature === undefined) return undefined;
    let best: SubtitleSignature | undefined;
    let bestScore = 0;
    for (const track of tracks) {
        if (track.source === "embedded" && !track.codec?.trim()) continue;
        const wanted = language(signature.language), actual = language(track.language);
        if (wanted && actual && wanted.split("-")[0] !== actual.split("-")[0]) continue;
        const languageHit = Boolean(wanted && actual && wanted.split("-")[0] === actual.split("-")[0]);
        const labelHit = Boolean(signature.label && normalized(track.label).includes(normalized(signature.label)));
        if (!languageHit && !labelHit) continue;
        const score = (languageHit ? 5 : 0) + (labelHit ? 2 : 0) + (signature.forced === track.forced ? 1 : 0)
            + (signature.hearingImpaired === track.hearingImpaired ? 1 : 0) + (signature.codec !== undefined && track.codec !== undefined && normalized(signature.codec) === normalized(track.codec) ? 1 : 0);
        if (score > bestScore) { best = track; bestScore = score; }
    }
    return best;
}

/** bestLanguageMatch(nil, …): renderable tracks before burn-in ones, then the first class that has a track (forced first when asked), embedded before external before downloaded, then list order. */
function bestAny(tracks: readonly SubtitleTrack[], preferForced: boolean): SubtitleTrack | undefined {
    const accessible = (track: SubtitleTrack): boolean => track.hearingImpaired || titleIndicatesHearingImpaired(track.label);
    const plain = (track: SubtitleTrack): boolean => !track.forced && !accessible(track);
    const classes: ((track: SubtitleTrack) => boolean)[] = preferForced
        ? [track => track.forced, track => !track.forced && accessible(track), plain, track => !track.forced, () => true]
        : [plain, track => !track.forced, track => track.forced, () => true];
    const sourceRank = (track: SubtitleTrack): number => track.source === "embedded" ? 0 : track.source === "external" ? 1 : 2;
    for (const burnIn of [false, true]) for (const wanted of classes) {
        const found = tracks.filter(track => (track.delivery === "burn_in_only") === burnIn && wanted(track)).reduce<SubtitleTrack | undefined>((best, track) => best === undefined || sourceRank(track) < sourceRank(best) ? track : best, undefined);
        if (found !== undefined) return found;
    }
    return undefined;
}

function preferred(tracks: readonly SubtitleTrack[], wanted: string | undefined, signature?: SubtitleSignature): SubtitleTrack | undefined {
    const tag = language(wanted);
    if (!tag) return undefined;
    const rank = (track: SubtitleTrack): number => {
        const candidate = language(track.language);
        if (!candidate || candidate.split("-")[0] !== tag.split("-")[0]) return Infinity;
        const languageRank = candidate === tag ? 0 : candidate.includes("-") ? 2 : 1;
        const priority = (track.delivery === "burn_in_only" ? 32 : 0) + (track.forced ? 16 : 0) + (track.hearingImpaired ? 8 : 0) + (track.source === "embedded" ? 0 : track.source === "external" ? 1 : 2);
        const likeness = signature === undefined ? 0 : (track.source === signature.source ? 4 : 0) + (track.forced === signature.forced ? 2 : 0) + (track.hearingImpaired === signature.hearingImpaired ? 2 : 0) + (normalized(track.codec) === normalized(signature.codec) ? 1 : 0) + (normalized(track.label) === normalized(signature.label) ? 1 : 0);
        return languageRank * 10000 - likeness * 100 + priority;
    };
    return tracks.filter(track => Number.isFinite(rank(track))).slice().sort((left, right) => rank(left) - rank(right))[0];
}

/**
 * Names a subtitle before start, the way Apple does once the version's rows are known.
 * The catalog lists every embedded row, then every external row, and omits downloaded rows.
 * The plan lists external, then embedded, then downloaded. Downloaded rows are a suffix, so
 * they do not move the earlier ordinals; a downloaded row has no stable catalog ordinal.
 * The plan inventory remains authoritative when this guess is not echoed.
 */
export function startSubtitleTrackId(fileId: string, intent: SubtitleIntent | undefined, tracks: readonly CatalogSubtitleTrack[] | undefined, preferences?: SubtitlePreferences): string | undefined {
    if (intent === undefined || intent.kind === "off" || tracks === undefined || tracks.length === 0) return undefined;
    // Catalog preferences decode with no audio id, so audioLanguage arrives blank.
    // Auto would then pick a full subtitle the matching audio does not need.
    if (intent.kind === "auto" && (preferences === undefined || preferences.audioLanguage === undefined || preferences.audioLanguage.trim() === "")) return undefined;
    // A saved downloaded choice has no catalog row; naming a catalog row would only force a track change.
    if (intent.kind !== "track" && preferences?.mode !== "off" && preferences?.signature?.source === "downloaded") return undefined;
    try {
        const ordered = combinedOrder(tracks);
        const inventory = provisionalInventory(fileId, ordered);
        const untouched = defaultSubtitle(tracks);
        const id = initialSubtitle(intent, inventory, preferences, untouched === undefined ? undefined : inventory[ordered.indexOf(untouched)]?.trackId);
        // A downloaded row's server ordinal follows created_at, which the catalog does not publish.
        if (inventory.find(track => track.trackId === id)?.source === "downloaded") return undefined;
        return id;
    } catch {
        return undefined;
    }
}

/** The combined ordinal order: externals, then embedded, then downloaded. Catalog array order is kept inside each source. */
function combinedOrder(tracks: readonly CatalogSubtitleTrack[]): readonly CatalogSubtitleTrack[] {
    return [
        ...tracks.filter(track => track.source === "external"),
        ...tracks.filter(track => track.source !== "external" && track.source !== "downloaded"),
        ...tracks.filter(track => track.source === "downloaded"),
    ];
}

/**
 * What Apple's start request freezes when Auto has no preference to apply (`.noChange`):
 * the file's default track, else a forced one, skipping a row the server cannot deliver.
 */
export function defaultSubtitle(tracks: readonly CatalogSubtitleTrack[]): CatalogSubtitleTrack | undefined {
    const routable = combinedOrder(tracks).filter(track => track.source === "external" || Boolean(track.codec?.trim()));
    return routable.find(track => track.isDefault === true) ?? routable.find(track => track.forced);
}

/** Combined ordinals before a plan exists, over `combinedOrder`. */
function provisionalInventory(fileId: string, ordered: readonly CatalogSubtitleTrack[]): readonly SubtitleTrack[] {
    return ordered.map((track, index): SubtitleTrack => ({
        trackId: `file:${fileId}:subtitle:${index}`,
        combinedIndex: index,
        source: track.source,
        delivery: "unknown",
        label: track.label,
        language: track.language,
        codec: track.codec,
        forced: track.forced,
        hearingImpaired: track.hearingImpaired,
        url: undefined,
        streamIndex: undefined,
        containerTrackId: undefined,
        nativeSelectable: undefined,
        hlsRendition: undefined,
    }));
}

/** Apple's `hasUnsupportedFormat` and the plan's `unplayable` flag: the server refuses or cannot deliver these rows. */
const deliverable = (track: SubtitleTrack): boolean => track.unplayable !== true && !(track.source === "embedded" && !track.codec?.trim());

/**
 * Apple's Details selector never seeds a saved choice the server cannot deliver, so the player resolves Auto instead.
 * A pick made on Details stays explicit and starts without subtitles.
 */
export function playableIntent(intent: SubtitleIntent, tracks: readonly SubtitleTrack[]): SubtitleIntent {
    if (intent.kind !== "track" || intent.saved !== true) return intent;
    const matches = tracks.filter(track => matchesSubtitle(track, intent.signature));
    return matches.length === 1 && matches[0] !== undefined && !deliverable(matches[0]) ? { kind: "auto" } : intent;
}

/** Only identities published by this plan may leave this resolver. `current` is what Auto keeps when no preference points anywhere (Apple's `.noChange`): the file's default before start, the plan's selection after. */
export function initialSubtitle(intent: SubtitleIntent, tracks: readonly SubtitleTrack[], preferences?: SubtitlePreferences, current?: string): string | undefined {
    if (intent.kind === "off") return undefined;
    if (intent.kind === "track") {
        const matches = tracks.filter(track => matchesSubtitle(track, intent.signature));
        if (matches.length !== 1) throw new Error("Selected subtitles are no longer uniquely available.");
        // Apple plays on without subtitles when the chosen row cannot be delivered.
        return matches[0] !== undefined && deliverable(matches[0]) ? matches[0].trackId : undefined;
    }
    const inventory = tracks.filter(deliverable);
    if (preferences === undefined) throw new Error("Subtitle preferences are unavailable.");
    const forced = (): string | undefined => preferences.showForced ? preferred(inventory.filter(track => track.forced), preferences.audioLanguage)?.trackId : undefined;
    if (preferences.mode === "off") return forced();
    if (preferences.mode === "always") {
        const signature = preferences.signature;
        const exact = signature === undefined ? [] : inventory.filter(track => matchesSubtitle(track, signature));
        if (exact.length === 1) return exact[0]?.trackId;
        // Apple's resolver with no language anywhere: `always` still shows the best track on offer.
        if (preferences.language === undefined) return bestAny(inventory, preferences.showForced)?.trackId;
        return preferred(inventory, preferences.language, preferences.signature)?.trackId;
    }
    if (preferences.language === "") return undefined;
    if (preferences.language === undefined) {
        const signature = preferences.signature;
        const exact = signature === undefined ? [] : inventory.filter(track => matchesSubtitle(track, signature));
        return exact.length === 1 ? exact[0]?.trackId : current;
    }
    const wanted = language(preferences.language);
    const audio = language(preferences.audioLanguage);
    if (!wanted || (audio && audio.split("-")[0] === wanted.split("-")[0])) return forced();
    return preferred(inventory, preferences.language, preferences.signature)?.trackId;
}
