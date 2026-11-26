import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserLibrary } from "../../src/contracts/v2/catalog.ts";
import { applies, browseMediaType, browseQuery, DEFAULT_FILTER, directionLabel, effectiveOrder, facetsFor, options, SORT_KEYS, sortKeysFor, sortLabel, sortMediaType, toggled, withSort, withValidSort, reset, BrowsePrefs, type BrowseMediaType, type SortKey } from "../../src/ui/libraryBrowse.ts";
import { panelFocus } from "../../src/ui/libraryBrowseViews.ts";
import { discoveryState } from "../../src/ui/libraryDiscovery.ts";

const library: UserLibrary = { id: "12", name: "Movies", type: "movies", sortOrder: 0 };

test("a fresh library opens on Recommended even when Browse has a saved sort", () => {
    // TVLibraryTypeTabView.swift:6-18 and TVMainTabView.swift:994-997 at 7baff3ef: cold start is Recommended.
    // CatalogFilterState.swift:102-136 and CatalogSortKey.swift:65-96: Browse's untouched sort is Title, A–Z.
    // BrowsePrefsStore.swift:19-23,44-52: that sort is remembered only for Browse, and the mode itself is not stored.
    const fresh = discoveryState();
    assert.equal(fresh.mode, "Recommended");
    assert.deepEqual(fresh.filter, DEFAULT_FILTER);
    assert.equal(effectiveOrder(fresh.filter), "asc");
    assert.equal(directionLabel(fresh.filter.sort, "asc"), "A–Z");
    const values = new Map<string, string>();
    const prefs = new BrowsePrefs({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, "server-profile");
    assert.equal(prefs.preserve(library), true);
    prefs.save(library, withSort(DEFAULT_FILTER, "year"));
    const again = discoveryState();
    assert.equal(again.mode, "Recommended");
    assert.deepEqual(again.filter, DEFAULT_FILTER);
    assert.equal(prefs.saved(library)?.sort, "year");
});

const keysFor = (type: string, shown: readonly string[] = [], current?: SortKey): readonly SortKey[] => sortKeysFor(type, new Set(shown), current).map(entry => entry.key);

// CatalogSortKey.swift at silo-apple 6eea7cf7 (CaseIterable order is the list's order).
test("Browse lists Apple's sorts for a movie library, in Apple's order, without a rating source the server hides", () => {
    assert.deepEqual(keysFor("movies"), ["title", "added_at", "release_date", "year", "content_rating", "runtime", "rating_imdb", "rating_tmdb", "resolution", "bitrate", "progress", "date_viewed", "plays"]);
    assert.deepEqual(keysFor("movies", ["imdb", "tmdb"]), keysFor("movies"));
});

test("Browse lists RT Critic and RT Audience only while the server shows that source", () => {
    assert.deepEqual(keysFor("movies", ["rt_critic"]), ["title", "added_at", "release_date", "year", "content_rating", "runtime", "rating_imdb", "rating_tmdb", "rating_rt_critic", "resolution", "bitrate", "progress", "date_viewed", "plays"]);
    assert.deepEqual(keysFor("movies", ["rt_audience"]), ["title", "added_at", "release_date", "year", "content_rating", "runtime", "rating_imdb", "rating_tmdb", "rating_rt_audience", "resolution", "bitrate", "progress", "date_viewed", "plays"]);
    assert.deepEqual(keysFor("movies", ["rt_critic", "rt_audience"]), ["title", "added_at", "release_date", "year", "content_rating", "runtime", "rating_imdb", "rating_tmdb", "rating_rt_critic", "rating_rt_audience", "resolution", "bitrate", "progress", "date_viewed", "plays"]);
});

test("a series library adds the two episode sorts and lists up to Apple's 17", () => {
    assert.deepEqual(keysFor("series", ["rt_critic", "rt_audience"]), ["title", "added_at", "release_date", "last_air_date", "latest_episode_added", "year", "content_rating", "runtime", "rating_imdb", "rating_tmdb", "rating_rt_critic", "rating_rt_audience", "resolution", "bitrate", "progress", "date_viewed", "plays"]);
});

test("an audiobook library lists title, the per-profile sorts and Author, Narrator and Series, and no rating or resolution sorts", () => {
    assert.deepEqual(keysFor("audiobooks", ["rt_critic", "rt_audience"]), ["title", "added_at", "release_date", "year", "runtime", "bitrate", "progress", "date_viewed", "plays", "author", "narrator", "series"]);
});

test("a mixed library lists what orders movies and series alike, with no episode sorts", () => {
    assert.deepEqual(keysFor("mixed"), ["title", "added_at", "release_date", "year", "content_rating", "runtime", "rating_imdb", "rating_tmdb", "resolution", "bitrate", "progress", "date_viewed", "plays"]);
});

test("the sort in use is always listed, so a saved sort stays visible and can be changed", () => {
    assert.deepEqual(keysFor("movies", [], "rating_rt_critic"), ["title", "added_at", "release_date", "year", "content_rating", "runtime", "rating_imdb", "rating_tmdb", "rating_rt_critic", "resolution", "bitrate", "progress", "date_viewed", "plays"]);
    assert.ok(keysFor("movies", [], "author").includes("author"));
    assert.ok(keysFor("movies", [], "last_air_date").includes("last_air_date"));
});

test("a library type maps to Apple's media type: music is read as movies and unknown types as movies", () => {
    const types: readonly [string, BrowseMediaType][] = [["movies", "movie"], ["series", "series"], ["mixed", "mixed"], ["audiobooks", "audiobook"], ["music", "movie"]];
    for (const [type, expected] of types) assert.equal(browseMediaType(type), expected, type);
});

test("applies matches CatalogSortKey.applies(to:) for every key and media type", () => {
    const expected: Readonly<Record<SortKey, readonly BrowseMediaType[]>> = {
        title: ["movie", "series", "audiobook", "mixed"], added_at: ["movie", "series", "audiobook", "mixed"], release_date: ["movie", "series", "audiobook", "mixed"],
        year: ["movie", "series", "audiobook", "mixed"], runtime: ["movie", "series", "audiobook", "mixed"], bitrate: ["movie", "series", "audiobook", "mixed"],
        progress: ["movie", "series", "audiobook", "mixed"], date_viewed: ["movie", "series", "audiobook", "mixed"], plays: ["movie", "series", "audiobook", "mixed"],
        last_air_date: ["series"], latest_episode_added: ["series"],
        content_rating: ["movie", "series", "mixed"], rating_imdb: ["movie", "series", "mixed"], rating_tmdb: ["movie", "series", "mixed"],
        rating_rt_critic: ["movie", "series", "mixed"], rating_rt_audience: ["movie", "series", "mixed"], resolution: ["movie", "series", "mixed"],
        author: ["audiobook"], narrator: ["audiobook"], series: ["audiobook"],
    };
    for (const [key, types] of Object.entries(expected) as [SortKey, readonly BrowseMediaType[]][]) {
        for (const type of ["movie", "series", "audiobook", "mixed"] as const) assert.equal(applies(key, type), types.includes(type), `${key} for ${type}`);
    }
});

test("every sort starts in Apple's direction and a pick of the active key flips only that key", () => {
    const ascending: readonly SortKey[] = ["title", "content_rating", "author", "narrator", "series"];
    assert.equal(SORT_KEYS.length, 20);
    for (const sort of SORT_KEYS) {
        assert.equal(sort.order, ascending.includes(sort.key) ? "asc" : "desc", sort.key);
        const chosen = sort.key === "title" ? DEFAULT_FILTER : withSort(DEFAULT_FILTER, sort.key);
        assert.equal(browseQuery(chosen, library, 100).sort, sort.key);
        assert.equal(browseQuery(chosen, library, 100).order, sort.order);
        assert.equal(browseQuery(withSort(chosen, sort.key), library, 100).order, sort.order === "asc" ? "desc" : "asc");
    }
});

test("directionLabel matches CatalogSortKey.directionLabel in both directions, including Fewest and Most for Plays", () => {
    const labels: readonly [readonly SortKey[], string, string][] = [
        [["title", "content_rating", "author", "narrator", "series"], "A–Z", "Z–A"],
        [["added_at", "release_date", "last_air_date", "latest_episode_added", "year", "date_viewed"], "Oldest", "Newest"],
        [["runtime"], "Shortest", "Longest"],
        [["rating_imdb", "rating_tmdb", "rating_rt_critic", "rating_rt_audience", "resolution", "bitrate", "progress"], "Lowest", "Highest"],
        [["plays"], "Fewest", "Most"],
    ];
    for (const [keys, ascending, descending] of labels) {
        for (const key of keys) {
            assert.equal(directionLabel(key, "asc"), ascending, `${key} asc`);
            assert.equal(directionLabel(key, "desc"), descending, `${key} desc`);
        }
    }
    assert.equal(labels.flatMap(([keys]) => keys).length, SORT_KEYS.length);
});

test("sort labels come from Apple's catalog keys", () => {
    assert.deepEqual(SORT_KEYS.map(entry => sortLabel(entry.key)), [
        "Title", "Date Added", "Release Date", "Latest Episode Air Date", "Latest Episode Added", "Year", "Content Rating", "Duration", "IMDb Rating", "TMDB Rating",
        "RT Critic Rating", "RT Audience Rating", "Resolution", "Bitrate", "Progress", "Date Viewed", "Plays", "Author", "Narrator", "Series",
    ]);
});

test("a saved sort that applies to the library comes back even when its rating source is hidden, and one that does not apply falls back to Title", () => {
    const values = new Map<string, string>();
    const prefs = new BrowsePrefs({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, "server-profile");
    prefs.save(library, withSort(DEFAULT_FILTER, "rating_rt_critic"));
    assert.equal(prefs.saved(library)?.sort, "rating_rt_critic");
    prefs.save(library, withSort(DEFAULT_FILTER, "plays"));
    assert.equal(prefs.saved(library)?.sort, "plays");
    prefs.save(library, withSort(DEFAULT_FILTER, "latest_episode_added"));
    assert.equal(prefs.saved(library)?.sort, "title");
    prefs.save({ ...library, type: "series" }, withSort(DEFAULT_FILTER, "latest_episode_added"));
    assert.equal(prefs.saved({ ...library, type: "series" })?.sort, "latest_episode_added");
});

test("Browse composes prefix, sort, typed facet values and All/Any groups", () => {
    let filter = toggled(toggled(toggled(DEFAULT_FILTER, "genre", "Drama"), "genre", "Crime"), "decade", "1990");
    filter = toggled(toggled(filter, "dynamicRange", "hdr"), "watchStatus", "unwatched");
    filter = { ...withSort(filter, "added_at"), prefix: "#", matchAll: false };
    assert.deepEqual(browseQuery(filter, library, 100), {
        library_id: "12", type: "movie", limit: 100, sort: "added_at", order: "desc", match: "any", name_prefix: "#",
        groups: [
            { match: "any", rules: [{ field: "genre", op: "contains", value: "Crime" }, { field: "genre", op: "contains", value: "Drama" }] },
            { match: "any", rules: [{ field: "year", op: "between", value: [1990, 1999] }] },
            { match: "any", rules: [{ field: "hdr", op: "is", value: true }] },
            { match: "all", rules: [{ field: "watched", op: "is", value: false }] },
        ],
    });
    assert.deepEqual(reset(filter), { ...filter, matchAll: true, values: {} });
});

test("preserved Browse preferences keep filters but never the transient prefix", () => {
    const values = new Map<string, string>();
    const prefs = new BrowsePrefs({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, "server-profile");
    const filter = { ...toggled(DEFAULT_FILTER, "genre", "Drama"), prefix: "T" };
    prefs.save(library, filter);
    assert.deepEqual(prefs.saved(library), { ...filter, prefix: undefined });
    assert.equal(new BrowsePrefs(undefined, "other-owner").saved(library), undefined);
    prefs.setPreserve(library, false);
    assert.equal(prefs.saved(library), undefined);
});

test("Movies and Series slices of one library keep separate preferences and preserve choices", () => {
    const values = new Map<string, string>();
    const prefs = new BrowsePrefs({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, "server-profile");
    const series: UserLibrary = { ...library, type: "series" };
    const moviesFilter = withSort(DEFAULT_FILTER, "added_at"), seriesFilter = withSort(DEFAULT_FILTER, "year");
    prefs.save(library, moviesFilter); prefs.save(series, seriesFilter);
    assert.deepEqual(prefs.saved(library), moviesFilter);
    assert.deepEqual(prefs.saved(series), seriesFilter);
    prefs.setPreserve(series, false);
    assert.equal(prefs.saved(series), undefined);
    assert.deepEqual(prefs.saved(library), moviesFilter);
});

test("the preserve choice still works for the current session when optional storage is unavailable", () => {
    for (const storage of [undefined, { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); }, removeItem: () => { throw new Error("unavailable"); } }]) {
        const prefs = new BrowsePrefs(storage, "server-profile");
        prefs.setPreserve(library, false);
        assert.equal(prefs.preserve(library), false);
        prefs.save(library, withSort(DEFAULT_FILTER, "year"));
        assert.equal(prefs.saved(library), undefined);
        prefs.setPreserve(library, true);
        assert.equal(prefs.preserve(library), true);
    }
});

test("facets are chosen per library media type, itemType is single-select, and audiobook facets lower to server rules", () => {
    assert.deepEqual(facetsFor("movies").map(entry => entry.facet), ["genre", "decade", "watchStatus", "contentRating", "resolution", "dynamicRange", "studio", "network", "country", "audioLanguage", "subtitleLanguage", "originalLanguage"]);
    assert.deepEqual(facetsFor("series").map(entry => entry.facet), ["genre", "decade", "watchStatus", "contentRating", "resolution", "dynamicRange", "studio", "network", "country", "audioLanguage", "subtitleLanguage", "originalLanguage"]);
    assert.deepEqual(facetsFor("mixed").map(entry => entry.facet)[0], "itemType");
    for (const bookType of ["audiobooks", "audiobook"]) {
        assert.deepEqual(facetsFor(bookType).map(entry => entry.facet), ["genre", "author", "narrator", "series", "decade", "watchStatus"]);
    }

    assert.deepEqual(options("itemType", undefined), [{ value: "movie", label: "Movies" }, { value: "series", label: "Series" }]);
    const bookVocab = { genres: ["Fantasy"], studios: [], networks: [], countries: [], originalLanguages: [], contentRatings: [], authors: ["Brandon Sanderson"], narrators: ["Michael Kramer"], series: ["Stormlight"], technical: undefined };
    assert.deepEqual(options("author", bookVocab), [{ value: "Brandon Sanderson", label: "Brandon Sanderson" }]);
    assert.deepEqual(options("narrator", bookVocab), [{ value: "Michael Kramer", label: "Michael Kramer" }]);
    assert.deepEqual(options("series", bookVocab), [{ value: "Stormlight", label: "Stormlight" }]);

    const movieScope = toggled(DEFAULT_FILTER, "itemType", "movie");
    assert.deepEqual(movieScope.values.itemType, ["movie"]);
    const seriesScope = toggled(movieScope, "itemType", "series");
    assert.deepEqual(seriesScope.values.itemType, ["series"]);
    assert.deepEqual(toggled(seriesScope, "itemType", "series").values.itemType, []);

    const mixedLibrary = { id: "9", name: "Mixed", type: "mixed" as const, sortOrder: 0 };
    assert.equal(sortMediaType("mixed", DEFAULT_FILTER), "mixed");
    assert.equal(sortMediaType("mixed", seriesScope), "series");
    const narrowedAll = toggled(seriesScope, "genre", "Drama");
    assert.equal(sortMediaType("mixed", narrowedAll), "series");
    const narrowedAny = { ...narrowedAll, matchAll: false };
    assert.equal(sortMediaType("mixed", narrowedAny), "mixed");
    assert.equal(sortKeysFor("mixed", undefined, undefined, seriesScope).some(entry => entry.key === "last_air_date"), true);
    assert.equal(sortKeysFor("mixed", undefined, undefined, narrowedAny).some(entry => entry.key === "last_air_date"), false);

    assert.equal(browseQuery(DEFAULT_FILTER, mixedLibrary, 100).type, undefined);
    const mixedQuery = browseQuery(seriesScope, mixedLibrary, 100);
    assert.equal(mixedQuery.type, undefined);
    assert.deepEqual(mixedQuery.groups, [{ match: "all", rules: [{ field: "type", op: "is", value: "series" }] }]);

    const bookFilter = toggled(toggled(toggled(DEFAULT_FILTER, "author", "Brandon Sanderson"), "narrator", "Michael Kramer"), "series", "Stormlight");
    const bookQuery = browseQuery(bookFilter, { id: "14", name: "Books", type: "audiobooks", sortOrder: 0 }, 100);
    assert.equal(bookQuery.type, undefined);
    assert.deepEqual(bookQuery.groups, [
        { match: "any", rules: [{ field: "author", op: "is", value: "Brandon Sanderson" }] },
        { match: "any", rules: [{ field: "narrator", op: "is", value: "Michael Kramer" }] },
        { match: "any", rules: [{ field: "series", op: "is", value: "Stormlight" }] },
    ]);

    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
    const prefs = new BrowsePrefs(storage, "server-profile");
    prefs.setPreserve(mixedLibrary, true);
    prefs.save(mixedLibrary, withSort(seriesScope, "last_air_date"));
    assert.equal(prefs.saved(mixedLibrary)?.sort, "last_air_date");
    const moviesLibrary = { id: "12", name: "Movies", type: "movies" as const, sortOrder: 1 };
    store.set('server-profile.["12","movies"].state', JSON.stringify({
        sort: "last_air_date", order: "desc", matchAll: true,
        values: { itemType: ["series"], author: ["X"], watchStatus: ["watched", "bad"], genre: ["Drama"] },
    }));
    const restored = prefs.saved(moviesLibrary);
    assert.equal(restored?.sort, "title");
    assert.equal(restored?.order, undefined);
    assert.deepEqual(restored?.values, { watchStatus: ["watched"], genre: ["Drama"] });

    const seriesSorted = withSort(seriesScope, "last_air_date");
    assert.equal(withValidSort("mixed", seriesSorted).sort, "last_air_date");
    assert.deepEqual(withValidSort("mixed", reset(seriesSorted)), { ...reset(seriesSorted), sort: "title", order: undefined });
    assert.deepEqual(withValidSort("mixed", toggled(seriesSorted, "itemType", "series")), { ...toggled(seriesSorted, "itemType", "series"), sort: "title", order: undefined });
    assert.deepEqual(withValidSort("mixed", { ...toggled(seriesSorted, "genre", "Drama"), matchAll: false }).sort, "title");
    assert.equal(withValidSort("mixed", withSort(DEFAULT_FILTER, "rating_imdb")).sort, "rating_imdb");
});

test("panelFocus selects first selected option, else first option, else facet-back, and picks first per-type facet", () => {
    const filters = { genres: ["Drama", "Comedy"], studios: ["HBO"], networks: [], countries: [], originalLanguages: [], contentRatings: [], authors: ["Frank Herbert"], narrators: [], series: [], technical: undefined };
    const data = { sections: [], collections: undefined, filters };
    const base = { ...discoveryState(), mode: "Browse" as const };
    assert.deepEqual(panelFocus({ ...base, data, panel: { kind: "filter", draft: DEFAULT_FILTER, facet: undefined, lastFacet: undefined } }, "mixed"), { zone: "panel", key: "facet:itemType" });
    assert.deepEqual(panelFocus({ ...base, data, panel: { kind: "filter", draft: DEFAULT_FILTER, facet: undefined, lastFacet: undefined } }, "audiobooks"), { zone: "panel", key: "facet:genre" });
    assert.deepEqual(panelFocus({ ...base, data, panel: { kind: "filter", draft: DEFAULT_FILTER, facet: "genre", lastFacet: "genre" } }, "movies"), { zone: "panel", key: "value:Drama" });
    const selectedComedy = toggled(DEFAULT_FILTER, "genre", "Comedy");
    assert.deepEqual(panelFocus({ ...base, data, panel: { kind: "filter", draft: selectedComedy, facet: "genre", lastFacet: "genre" } }, "movies"), { zone: "panel", key: "value:Comedy" });
    assert.deepEqual(panelFocus({ ...base, data: undefined, panel: { kind: "filter", draft: DEFAULT_FILTER, facet: "genre", lastFacet: "genre" } }, "movies"), { zone: "panel", key: "facet-back" });
});
