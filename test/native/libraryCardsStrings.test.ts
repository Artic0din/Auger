// Card captions and the library screens on the resolver: Apple's catalog keys shown in the chosen language, and the
// source language's text for what a language lacks (silo-apple tvOS/Components/TVFocusMarquee.swift,
// Components/EpisodeCardCaption.swift, Components/CardYears.swift, Shared/LocaleFormat.swift,
// Screens/Browse/Filtering/CatalogSortKey.swift and CatalogFilterState.swift, tvOS/Screens/Libraries/*).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Card } from "../../src/contracts/v2/catalog.ts";
import { groupedCount } from "../../src/i18n/format.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { resolveMessage, translate, type Catalogs, type MessageKey } from "../../src/i18n/translate.ts";
import { cardYears, homeCaption, marqueeMeta, runtimeText } from "../../src/ui/cardPresentation.ts";
import { episodeAirDate, episodeRuntime } from "../../src/ui/episodeCaption.ts";
import { DEFAULT_FILTER, directionLabel, facetSummary, facetTitle, FACETS, options, sortKeysFor, sortLabel, SORT_KEYS, toggled } from "../../src/ui/libraryBrowse.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const file = (tag: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

const episode: Card = { id: "episode:e", type: "episode", title: "Fire Drill", year: 2026, posterUrl: undefined, seriesId: "series:s", seriesTitle: "Abbott", seasonNumber: 2, episodeNumber: 7, durationSeconds: 1290, positionSeconds: 450 };
const series: Card = { id: "series:s", type: "series", title: "Abbott", year: 2021, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined };

test("a card's caption, marquee line and years read in German", () => {
    inLanguage("de", () => {
        assert.deepEqual(marqueeMeta(episode, true), { lead: ["S2 F7", "Fire Drill", "22min"], trailing: [translate("home.timeLeft", { time: "14min" })] });
        assert.equal(translate("home.timeLeft", { time: "14min" }), "Noch 14min");
        assert.deepEqual(marqueeMeta({ ...episode, episodeNumber: undefined }, false).lead.slice(0, 1), ["Staffel 2"]);
        assert.deepEqual(homeCaption(episode, false), { title: "Abbott", line: "S02F07 · Fire Drill" });
        assert.deepEqual(homeCaption({ ...episode, title: "abbott" }, false), { title: "Abbott", line: "S02F07" });
        assert.equal(cardYears({ ...series, showStatus: "returning" }), "2021 – heute");
        assert.equal(cardYears({ ...series, showStatus: "ended", lastAirDate: "2023-05-28" }), "2021 – 2023");
        assert.equal(cardYears({ ...series, showStatus: "ended", lastAirDate: "2021-05-28" }), "2021");
    });
    assert.deepEqual(marqueeMeta(episode, true), { lead: ["S2 E7", "Fire Drill", "22m"], trailing: ["14m left"] });
    assert.equal(cardYears({ ...series, showStatus: "returning" }), "2021 – Present");
});

test("an air date reads as the shown language writes it, and Aired follows it", () => {
    assert.equal(inLanguage("de", () => episodeAirDate("2026-03-12")), "12.03.2026");
    assert.equal(inLanguage("de", () => translate("home.airedOn", { date: episodeAirDate("2026-03-12") ?? "" })), "Ausgestrahlt am 12.03.2026");
    // English keeps its month name; the order of day and month follows the device's region.
    assert.match(inLanguage("en", () => episodeAirDate("2026-03-12")) ?? "", /^(12 Mar|Mar 12),? 2026$/);
    assert.equal(inLanguage("en", () => translate("home.airedOn", { date: "12 Mar 2026" })), "Aired 12 Mar 2026");
});

test("the library's sort and filter labels read in German and keep Apple's order", () => {
    inLanguage("de", () => {
        assert.deepEqual(SORT_KEYS.map(entry => sortLabel(entry.key)), ["Titel", "Hinzugefügt am", "Erscheinungsdatum", "Sendedatum der neuesten Folge", "Neueste Folge hinzugefügt", "Jahr", "Altersfreigabe", "Dauer", "IMDb-Bewertung", "TMDB-Bewertung", "RT-Kritikerbewertung", "RT-Publikumsbewertung", "Auflösung", "Bitrate", "Fortschritt", "Zuletzt angesehen", "Wiedergaben", "Autor", "Sprecher", "Serie"]);
        assert.equal(directionLabel("plays", "asc"), translate("library.direction.fewest"));
        assert.equal(directionLabel("plays", "desc"), translate("library.direction.most"));
        assert.equal(directionLabel("title", "asc"), "A–Z");
        assert.equal(directionLabel("added_at", "desc"), translate("library.direction.newest"));
        assert.equal(translate("library.direction.newest"), "Neueste");
        assert.equal(directionLabel("runtime", "desc"), translate("library.direction.longest"));
        assert.equal(directionLabel("rating_imdb", "desc"), translate("library.direction.highest"));
        assert.equal(translate("library.sortPill", { name: sortLabel("year") }), "Sortieren · Jahr");
        assert.equal(facetSummary(DEFAULT_FILTER, "genre", undefined), "Beliebig");
        const two = toggled(toggled(DEFAULT_FILTER, "genre", "Drama"), "genre", "Comedy");
        assert.equal(facetSummary(two, "genre", undefined), "2 ausgewählt");
        assert.equal(facetSummary(toggled(DEFAULT_FILTER, "watchStatus", "inProgress"), "watchStatus", undefined), translate("filters.value.inProgress"));
        assert.deepEqual(options("decade", undefined).slice(0, 2).map(option => option.label), ["2020er", "2010er"]);
        assert.deepEqual(options("dynamicRange", undefined).map(option => option.label), ["HDR", "Dolby Vision"]);
    });
    // A series' author, narrator and series sorts are A–Z, as Apple's CatalogSortKey.directionLabel has them.
    for (const key of ["author", "narrator", "series"] as const) assert.equal(directionLabel(key, "asc"), "A–Z");
    assert.deepEqual(sortKeysFor("audiobooks").map(entry => sortLabel(entry.key)), ["Title", "Date Added", "Release Date", "Year", "Duration", "Bitrate", "Progress", "Date Viewed", "Plays", "Author", "Narrator", "Series"]);
    assert.deepEqual(sortKeysFor("movies").map(entry => sortLabel(entry.key)), ["Title", "Date Added", "Release Date", "Year", "Content Rating", "Duration", "IMDb Rating", "TMDB Rating", "Resolution", "Bitrate", "Progress", "Date Viewed", "Plays"]);
    assert.deepEqual(FACETS.map(entry => facetTitle(entry.facet)).slice(0, 3), ["Genre", "Decade", "Watch Status"]);
});

test("counts are grouped in the shown language", () => {
    assert.equal(groupedCount(1234, "en-AU"), "1,234");
    assert.equal(groupedCount(1234, "de"), "1.234");
});

/** Every key this pull request reads, so each one is held to every shipped language and to the source text. */
const KEYS: readonly MessageKey[] = [
    "home.seasonEpisode", "home.seasonOnly", "home.episodeOnly", "home.timeLeft", "home.airedOn", "shell.card.yearsToPresent", "shell.card.yearRange",
    "catalog.episodeTag", "detail.episodeCard.title", "cardMenu.removeContinueWatching", "cardMenu.removeNextUp", "home.updateFailed.title",
    "home.updateFailed.message", "home.updateFailed.ok", "detail.more.markSeasonWatched", "detail.more.markSeasonUnwatched", "home.forYou.loading",
    "forYou.empty", "forYou.emptyBody", "library.loadingNamed", "library.loadingCollections", "library.emptyNamed", "library.emptyNamedBody", "library.noTitlesForTab",
    "library.noTitlesForTabBody", "library.error.someShelvesTitle", "library.error.someShelvesOpenBrowse", "library.empty", "library.emptyBody", "library.noMatches",
    "library.clearFilters", "library.sortPill", "library.filterPill", "library.shufflePill", "library.sortBy", "library.startsWithLetter", "library.startsWithSymbol",
    "library.collectionCard.movies", "library.collectionCard.shows", "library.collectionCard.albums", "library.collectionCard.books", "library.collectionCard.spoken",
    "library.collectionCard.spokenCount", "library.titleCount", "collections.empty", "collections.emptyBody", "collections.itemCount", "collections.itemCountMore",
    "collections.emptyItemsTitle", "collections.emptyItemsBody", "catalog.letters.all", "common.loading", "common.back", "common.tryAgain", "shuffle.failedTitle",
    "shuffle.ok", "shuffle.failed", "shuffle.notFound", "shuffle.nothingToPlay", "filters.any", "filters.selected", "filters.none", "filters.match", "filters.matchAll",
    "filters.matchAny", "filters.options", "filters.preserve", "filters.reset", "filters.done", "filters.allFilters", "filters.clearFacet", "filters.title",
    "filters.eyebrowList", "filters.eyebrowValues", "filters.decade", "filters.value.hdr", "filters.value.dolby_vision", "filters.value.unwatched", "filters.value.inProgress",
    "filters.value.watched", "filters.value.favorited", "filters.value.watchlist", "library.direction.az", "library.direction.za", "library.direction.oldest",
    "library.direction.newest", "library.direction.shortest", "library.direction.longest", "library.direction.lowest", "library.direction.highest",
    "library.direction.fewest", "library.direction.most",
    ...SORT_KEYS.map(entry => entry.name), ...FACETS.map(entry => entry.name),
];
const ARGS = { season: "2", episode: "7", time: "14m", date: "12 Mar", first: "2021", last: "2023", code: "S02E07", title: "Pilot", name: "Movies", facet: "Genre", letter: "A", count: 3, count_text: "3", year: "2020" };

test("each language reads its own text for these keys, and the source text for one it lacks", () => {
    const english = file("en");
    for (const key of KEYS) {
        assert.ok(english[key] !== undefined, `${key} is in the English catalog`);
        for (const language of SHIPPED_LANGUAGES.filter(tag => tag !== "en")) {
            assert.ok(file(language)[key] !== undefined, `${language} holds ${key}; run npm run sync:translations`);
        }
        const catalogs: Catalogs = { en: english, de: file("de"), xx: {} };
        assert.equal(resolveMessage(catalogs, key, "xx", ARGS), resolveMessage(catalogs, key, "en", ARGS), `${key} falls back to English`);
    }
    // German differs from English for the lines whose wording is the point of the pull request.
    const catalogs: Catalogs = { en: english, de: file("de") };
    for (const key of ["home.seasonEpisode", "home.timeLeft", "library.noMatches", "filters.matchAll", "cardMenu.removeNextUp"] as const) {
        assert.notEqual(resolveMessage(catalogs, key, "de", ARGS), resolveMessage(catalogs, key, "en", ARGS), `${key} is translated in German`);
    }
});
