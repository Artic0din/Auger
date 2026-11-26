// Apple TV's library Browse grid state for video libraries: sort, filter facets and the A–Z name
// prefix, and the catalog query they lower to (CatalogSortKey, CatalogFilterState,
// CatalogFacets and CatalogQueryBuilder at the pinned silo-apple source).

import type { UserLibrary } from "../contracts/v2/catalog.ts";
import { localizeNumerals } from "../i18n/format.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";
import type { CatalogFilters, CatalogQueryRequest, FilterGroup, FilterRule, Order } from "../contracts/v2/discovery.ts";
import { scopeOf } from "./browseModel.ts";

export type SortKey = "title" | "added_at" | "release_date" | "last_air_date" | "latest_episode_added" | "year" | "content_rating" | "runtime" | "rating_imdb" | "rating_tmdb" | "rating_rt_critic" | "rating_rt_audience" | "resolution" | "bitrate" | "progress" | "date_viewed" | "plays" | "author" | "narrator" | "series";
/** BrowseMediaType: the media family of a library, which selects its sort vocabulary. */
export type BrowseMediaType = "movie" | "series" | "audiobook" | "mixed";

/**
 * CatalogSortKey (CatalogSortKey.swift at silo-apple 6eea7cf7): every sort in the enum's order, which is the list's order,
 * with its label's catalog key (CatalogSortKey.label) and the direction a newly picked sort starts in (defaultOrder).
 * The key is the server's `sort` field.
 */
export const SORT_KEYS: readonly { readonly key: SortKey; readonly name: MessageKey; readonly order: Order }[] = [
    { key: "title", name: "catalog.sort.title", order: "asc" },
    { key: "added_at", name: "catalog.sort.added", order: "desc" },
    { key: "release_date", name: "catalog.sort.released", order: "desc" },
    { key: "last_air_date", name: "catalog.sort.latestEpisodeAirDate", order: "desc" },
    { key: "latest_episode_added", name: "catalog.sort.latestEpisodeAdded", order: "desc" },
    { key: "year", name: "catalog.sort.year", order: "desc" },
    { key: "content_rating", name: "catalog.sort.contentRating", order: "asc" },
    { key: "runtime", name: "catalog.sort.duration", order: "desc" },
    { key: "rating_imdb", name: "catalog.sort.imdbRating", order: "desc" },
    { key: "rating_tmdb", name: "catalog.sort.tmdbRating", order: "desc" },
    { key: "rating_rt_critic", name: "catalog.sort.rtCriticRating", order: "desc" },
    { key: "rating_rt_audience", name: "catalog.sort.rtAudienceRating", order: "desc" },
    { key: "resolution", name: "catalog.sort.resolution", order: "desc" },
    { key: "bitrate", name: "catalog.sort.bitrate", order: "desc" },
    { key: "progress", name: "catalog.sort.progress", order: "desc" },
    { key: "date_viewed", name: "catalog.sort.dateViewed", order: "desc" },
    { key: "plays", name: "catalog.sort.plays", order: "desc" },
    { key: "author", name: "catalog.sort.author", order: "asc" },
    { key: "narrator", name: "catalog.sort.narrator", order: "asc" },
    { key: "series", name: "catalog.sort.series", order: "asc" },
];

/** BrowseMediaType.from(libraryType:); a music library reads as movies, as Apple's does. */
export function browseMediaType(libraryType: string): BrowseMediaType {
    return libraryType === "mixed" ? "mixed" : libraryType === "audiobooks" || libraryType === "audiobook" ? "audiobook" : libraryType === "series" ? "series" : "movie";
}

/** CatalogSortKey.applies(to:): whether the key orders a library of this media type, as the web client decides. */
export function applies(key: SortKey, mediaType: BrowseMediaType): boolean {
    switch (key) {
        case "last_air_date": case "latest_episode_added": return mediaType === "series";
        case "content_rating": case "rating_imdb": case "rating_tmdb": case "rating_rt_critic": case "rating_rt_audience": case "resolution": return mediaType !== "audiobook";
        case "author": case "narrator": case "series": return mediaType === "audiobook";
        default: return true;
    }
}

/** CatalogSortKey.ratingSource: the rating source a rating sort needs the server to show. */
function ratingSource(key: SortKey): string | undefined {
    return key === "rating_rt_critic" ? "rt_critic" : key === "rating_rt_audience" ? "rt_audience" : undefined;
}

const NO_SOURCES: ReadonlySet<string> = new Set();

/**
 * The media a sort list is for (CatalogSortKey.sortMediaType): a mixed library narrowed by Type sorts as that type
 * while Match All holds or Type is the only active facet.
 */
export function sortMediaType(libraryType: string, filter: BrowseFilter): BrowseMediaType {
    const mediaType = browseMediaType(libraryType);
    if (mediaType !== "mixed" || (!filter.matchAll && activeFacetCount(filter) > 1)) return mediaType;
    const scope = selected(filter, "itemType")[0];
    return scope === "series" ? "series" : scope === "movie" ? "movie" : "mixed";
}

/**
 * CatalogSortKey.available: the sorts a library of this type offers, in Apple's order. A rating sort is listed only while the
 * server shows its source, and `current`, the sort in use, is always listed so a saved sort stays visible and can be changed.
 */
export function sortKeysFor(libraryType: string, shownRatingSources: ReadonlySet<string> = NO_SOURCES, current?: SortKey, filter?: BrowseFilter): typeof SORT_KEYS {
    const mediaType = filter === undefined ? browseMediaType(libraryType) : sortMediaType(libraryType, filter);
    return SORT_KEYS.filter(entry => {
        const source = ratingSource(entry.key);
        return entry.key === current || applies(entry.key, mediaType) && (source === undefined || shownRatingSources.has(source));
    });
}

export type Facet = "itemType" | "genre" | "decade" | "watchStatus" | "contentRating" | "resolution" | "dynamicRange" | "studio" | "network" | "country" | "audioLanguage" | "subtitleLanguage" | "originalLanguage" | "author" | "narrator" | "series";
const FACET_NAMES: Readonly<Record<Facet, MessageKey>> = {
    itemType: "filters.facet.itemType", genre: "filters.facet.genre", decade: "filters.facet.decade", watchStatus: "filters.facet.watchStatus",
    contentRating: "filters.facet.contentRating", resolution: "filters.facet.resolution", dynamicRange: "filters.facet.dynamicRange",
    studio: "filters.facet.studio", network: "filters.facet.network", country: "filters.facet.country",
    audioLanguage: "filters.facet.audioLanguage", subtitleLanguage: "filters.facet.subtitleLanguage", originalLanguage: "filters.facet.originalLanguage",
    author: "filters.facet.author", narrator: "filters.facet.narrator", series: "filters.facet.series",
};
const VIDEO_FACET_ORDER: readonly Facet[] = ["genre", "decade", "watchStatus", "contentRating", "resolution", "dynamicRange", "studio", "network", "country", "audioLanguage", "subtitleLanguage", "originalLanguage"];
const AUDIOBOOK_FACET_ORDER: readonly Facet[] = ["genre", "author", "narrator", "series", "decade", "watchStatus"];
const MIXED_FACET_ORDER: readonly Facet[] = ["itemType", ...VIDEO_FACET_ORDER];
const ALL_FACETS: readonly Facet[] = [...VIDEO_FACET_ORDER, "itemType", "author", "narrator", "series"];
/** Every filter facet with its catalog key (CatalogFacet.title), keeping genre/decade/watchStatus first. */
export const FACETS: readonly { readonly facet: Facet; readonly name: MessageKey }[] = ALL_FACETS.map(facet => ({ facet, name: FACET_NAMES[facet] }));

/** CatalogFacet.available(for:) in Apple's display order for the library's media type. */
export function facetsFor(libraryType: string): readonly { readonly facet: Facet; readonly name: MessageKey }[] {
    const mediaType = browseMediaType(libraryType);
    const order = mediaType === "audiobook" ? AUDIOBOOK_FACET_ORDER : mediaType === "mixed" ? MIXED_FACET_ORDER : VIDEO_FACET_ORDER;
    return order.map(facet => ({ facet, name: FACET_NAMES[facet] }));
}

const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960];
/** WatchStatusFilter: the stored value, its label's catalog key and the server rule it lowers to. */
const WATCH_STATUS: readonly (readonly [string, MessageKey, string])[] = [
    ["unwatched", "filters.value.unwatched", "watched"], ["inProgress", "filters.value.inProgress", "in_progress"], ["watched", "filters.value.watched", "watched"],
    ["favorited", "filters.value.favorited", "favorited"], ["watchlist", "filters.value.watchlist", "in_watchlist"],
];

export interface BrowseFilter {
    readonly sort: SortKey;
    /** Undefined: the key's natural order. */
    readonly order: Order | undefined;
    readonly matchAll: boolean;
    readonly values: Readonly<Partial<Record<Facet, readonly string[]>>>;
    /** The A–Z rail's prefix ("#" for non-letters); a jump, not a facet. */
    readonly prefix: string | undefined;
}

export const DEFAULT_FILTER: BrowseFilter = { sort: "title", order: undefined, matchAll: true, values: {}, prefix: undefined };

export function sortKey(key: SortKey): (typeof SORT_KEYS)[number] {
    return SORT_KEYS.find(entry => entry.key === key) ?? SORT_KEYS[0] as (typeof SORT_KEYS)[number];
}

/** A sort's name in the shown language. */
export function sortLabel(key: SortKey): string {
    return translate(sortKey(key).name);
}

/** A facet's title in the shown language. */
export function facetTitle(facet: Facet): string {
    return translate(FACET_NAMES[facet]);
}

export function effectiveOrder(filter: BrowseFilter): Order {
    return filter.order ?? sortKey(filter.sort).order;
}

/** CatalogSortKey.directionLabel. */
export function directionLabel(key: SortKey, order: Order): string {
    const asc = order === "asc";
    switch (key) {
        case "title": case "content_rating": case "author": case "narrator": case "series": return translate(asc ? "library.direction.az" : "library.direction.za");
        case "added_at": case "release_date": case "last_air_date": case "latest_episode_added": case "year": case "date_viewed": return translate(asc ? "library.direction.oldest" : "library.direction.newest");
        case "runtime": return translate(asc ? "library.direction.shortest" : "library.direction.longest");
        case "plays": return translate(asc ? "library.direction.fewest" : "library.direction.most");
        case "rating_imdb": case "rating_tmdb": case "rating_rt_critic": case "rating_rt_audience": case "resolution": case "bitrate": case "progress": return translate(asc ? "library.direction.lowest" : "library.direction.highest");
    }
}

/** Picking the active key flips its order; another key starts at its natural order. */
export function withSort(filter: BrowseFilter, key: SortKey): BrowseFilter {
    if (filter.sort === key) return { ...filter, order: effectiveOrder(filter) === "asc" ? "desc" : "asc" };
    return { ...filter, sort: key, order: undefined };
}

export function selected(filter: BrowseFilter, facet: Facet): readonly string[] {
    return filter.values[facet] ?? [];
}

/** Watch status and Type are single-select; every other facet is multi-select. */
export function toggled(filter: BrowseFilter, facet: Facet, value: string): BrowseFilter {
    const current = selected(filter, facet);
    const next = current.includes(value) ? current.filter(item => item !== value) : facet === "watchStatus" || facet === "itemType" ? [value] : [...current, value];
    return { ...filter, values: { ...filter.values, [facet]: next } };
}

export function cleared(filter: BrowseFilter, facet: Facet): BrowseFilter {
    return { ...filter, values: { ...filter.values, [facet]: [] } };
}

/** Facets and matching back to defaults; sort and prefix stay. */
export function reset(filter: BrowseFilter): BrowseFilter {
    return { ...filter, matchAll: true, values: {} };
}

export function activeFacetCount(filter: BrowseFilter): number {
    return FACETS.filter(({ facet }) => selected(filter, facet).length > 0).length;
}

export function canReset(filter: BrowseFilter): boolean {
    return activeFacetCount(filter) > 0 || !filter.matchAll;
}

/** CatalogFacets.optionPairs: fixed vocabularies for derived facets, the server's otherwise. */
export function options(facet: Facet, vocabulary: CatalogFilters | undefined): readonly { readonly value: string; readonly label: string }[] {
    const plain = (values: readonly string[] | undefined): { value: string; label: string }[] => (values ?? []).map(value => ({ value, label: value }));
    switch (facet) {
        case "itemType": return [{ value: "movie", label: translate("filters.value.movie") }, { value: "series", label: translate("filters.value.series") }];
        case "decade": return DECADES.map(year => ({ value: String(year), label: translate("filters.decade", { year: localizeNumerals(String(year)) }) }));
        case "dynamicRange": return [{ value: "hdr", label: translate("filters.value.hdr") }, { value: "dolby_vision", label: translate("filters.value.dolby_vision") }];
        case "watchStatus": return WATCH_STATUS.map(([value, name]) => ({ value, label: translate(name) }));
        case "genre": return plain(vocabulary?.genres);
        case "contentRating": return plain(vocabulary?.contentRatings);
        case "studio": return plain(vocabulary?.studios);
        case "network": return plain(vocabulary?.networks);
        case "country": return plain(vocabulary?.countries);
        case "originalLanguage": return plain(vocabulary?.originalLanguages);
        case "resolution": return plain(vocabulary?.technical?.resolutions);
        case "audioLanguage": return plain(vocabulary?.technical?.audioLanguages);
        case "subtitleLanguage": return plain(vocabulary?.technical?.subtitleLanguages);
        case "author": return plain(vocabulary?.authors);
        case "narrator": return plain(vocabulary?.narrators);
        case "series": return plain(vocabulary?.series);
    }
}

/** "Any", the one chosen value's label, or "N selected". */
export function facetSummary(filter: BrowseFilter, facet: Facet, vocabulary: CatalogFilters | undefined): string {
    const values = selected(filter, facet);
    if (values.length === 0) return translate("filters.any");
    if (values.length > 1) return translate("filters.selected", { count: values.length });
    return options(facet, vocabulary).find(option => option.value === values[0])?.label ?? values[0] ?? "";
}

/** CatalogQueryBuilder.build for a movie or series library, page one of `limit`. */
export function browseQuery(filter: BrowseFilter, library: UserLibrary, limit: number): CatalogQueryRequest {
    const groups: FilterGroup[] = [];
    const any = (field: string, op: string, values: readonly string[]): void => {
        if (values.length > 0) groups.push({ match: "any", rules: [...values].sort().map(value => ({ field, op, value })) });
    };
    const itemType = selected(filter, "itemType")[0];
    if (browseMediaType(library.type) === "mixed" && itemType !== undefined) groups.push({ match: "all", rules: [{ field: "type", op: "is", value: itemType }] });
    any("genre", "contains", selected(filter, "genre"));
    any("studio", "is", selected(filter, "studio"));
    any("network", "is", selected(filter, "network"));
    any("country", "is", selected(filter, "country"));
    any("content_rating", "is", selected(filter, "contentRating"));
    any("resolution", "is", selected(filter, "resolution"));
    any("audio_language", "is", selected(filter, "audioLanguage"));
    any("subtitle_language", "is", selected(filter, "subtitleLanguage"));
    any("original_language", "is", selected(filter, "originalLanguage"));
    const decades = selected(filter, "decade").map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    if (decades.length > 0) groups.push({ match: "any", rules: decades.map(start => ({ field: "year", op: "between", value: [start, start + 9] })) });
    const range: FilterRule[] = selected(filter, "dynamicRange").filter(value => value === "hdr" || value === "dolby_vision").sort().map(field => ({ field, op: "is", value: true }));
    if (range.length > 0) groups.push({ match: "any", rules: range });
    const status = WATCH_STATUS.find(([value]) => value === selected(filter, "watchStatus")[0]);
    if (status !== undefined) groups.push({ match: "all", rules: [{ field: status[2], op: "is", value: status[0] !== "unwatched" }] });
    any("author", "is", selected(filter, "author"));
    any("narrator", "is", selected(filter, "narrator"));
    any("series", "is", selected(filter, "series"));
    const libraryMedia = browseMediaType(library.type);
    const omitType = libraryMedia === "audiobook" || libraryMedia === "mixed";
    return {
        library_id: library.id, ...(omitType ? {} : { type: scopeOf(library) }), limit,
        sort: filter.sort, order: effectiveOrder(filter), match: filter.matchAll ? "all" : "any",
        ...(filter.prefix === undefined ? {} : { name_prefix: filter.prefix }),
        ...(groups.length === 0 ? {} : { groups }),
    };
}

/**
 * BrowsePrefsStore: per server, profile and library (and a mixed library's tab type), Browse remembers its
 * committed sort and filters while "Preserve sort & filters" is on (the default); the A–Z prefix is never
 * kept. Turning it off drops what was kept. Storage failures leave Browse working unremembered.
 */
export class BrowsePrefs {
    private readonly storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void } | undefined;
    private readonly base: string;
    private readonly choices = new Map<string, boolean>();

    constructor(storage: BrowsePrefs["storage"], base: string) {
        this.storage = storage;
        this.base = base;
    }

    private key(library: { readonly id: string; readonly type: string }): string {
        return `${this.base}.${JSON.stringify([library.id, library.type])}`;
    }

    preserve(library: Parameters<BrowsePrefs["key"]>[0]): boolean {
        try { return this.choices.get(this.key(library)) ?? (this.storage?.getItem(`${this.key(library)}.preserve`) !== "false"); } catch { return true; }
    }

    setPreserve(library: Parameters<BrowsePrefs["key"]>[0], enabled: boolean): void {
        this.choices.set(this.key(library), enabled);
        try {
            this.storage?.setItem(`${this.key(library)}.preserve`, String(enabled));
            if (!enabled) this.storage?.removeItem(`${this.key(library)}.state`);
        } catch { /* The choice applies for this session. */ }
    }

    saved(library: Parameters<BrowsePrefs["key"]>[0]): BrowseFilter | undefined {
        if (!this.preserve(library)) return undefined;
        let raw: string | null | undefined;
        try { raw = this.storage?.getItem(`${this.key(library)}.state`); } catch { return undefined; }
        if (raw == null) return undefined;
        try {
            const value = JSON.parse(raw) as Partial<BrowseFilter>;
            const matchAll = value.matchAll !== false;
            const values: Partial<Record<Facet, readonly string[]>> = {};
            for (const { facet } of facetsFor(library.type)) {
                const chosen = (value.values as Record<string, unknown> | undefined)?.[facet];
                if (!Array.isArray(chosen)) continue;
                const strings = chosen.filter((entry): entry is string => typeof entry === "string");
                const normalized = facet === "itemType"
                    ? strings.filter(entry => entry === "movie" || entry === "series").slice(0, 1)
                    : facet === "watchStatus"
                        ? strings.filter(entry => WATCH_STATUS.some(([known]) => known === entry)).slice(0, 1)
                        : strings;
                if (normalized.length > 0) values[facet] = normalized;
            }
            const mediaType = sortMediaType(library.type, { ...DEFAULT_FILTER, matchAll, values });
            const matchedSort = SORT_KEYS.find(entry => entry.key === value.sort && applies(entry.key, mediaType));
            const sort = matchedSort?.key ?? "title";
            const order = matchedSort !== undefined && (value.order === "asc" || value.order === "desc") ? value.order : undefined;
            return { sort, order, matchAll, values, prefix: undefined };
        } catch { return undefined; }
    }

    save(library: Parameters<BrowsePrefs["key"]>[0], filter: BrowseFilter): void {
        if (!this.preserve(library)) return;
        try { this.storage?.setItem(`${this.key(library)}.state`, JSON.stringify({ ...filter, prefix: undefined })); } catch { /* Kept for this session only. */ }
    }
}
