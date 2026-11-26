// Details and Search read their text from the catalog (silo-apple tvOS keys). German is the language the
// first capture uses; a key it lacks shows English, with English's plural rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import english from "../../src/i18n/catalog/en.json" with { type: "json" };
import { parseMessage, type MessageNode } from "../../src/i18n/icu.ts";
import { formattingLocale } from "../../src/i18n/language.ts";
import { integerText } from "../../src/i18n/numbers.ts";
import { resolveMessage, type Catalogs } from "../../src/i18n/translate.ts";

/** The tvOS keys the Details and Search screens use, grouped by the file that reads them. */
const SCREEN_KEYS: Readonly<Record<string, readonly string[]>> = {
    "src/ui/browseDetails.ts": [
        "catalog.seasons", "common.back", "common.play", "detail.audio", "detail.auto", "detail.autoValue", "detail.cast", "detail.details",
        "detail.director", "detail.directedBy", "detail.episode", "detail.episodeEyebrow", "detail.episodes.loading", "detail.mono", "detail.more", "detail.more.addFavorite", "detail.more.findTrailers",
        "detail.more.markSeasonUnwatched", "detail.more.markSeasonWatched", "detail.more.markSeriesUnwatched", "detail.more.markSeriesWatched", "detail.more.markUnwatched", "detail.more.markWatched",
        "detail.more.removeFavorite", "detail.more.shuffleSeason", "detail.more.shuffleSeries", "detail.more.showSeriesInfo", "detail.more.translate", "detail.none", "detail.off", "detail.offDetail", "detail.playEpisode",
        "detail.readout.audio", "detail.readout.subtitles", "detail.readout.version", "detail.recommendedSeries", "detail.relatedMovies", "detail.resume", "detail.resumeAt", "detail.resumeEpisode",
        "detail.specials", "detail.starring", "detail.startOver", "detail.stereo", "detail.subtitles", "detail.track", "detail.trackAvailableInPlayer", "detail.trackDefault",
        "detail.trackExternal", "detail.trackForced", "detail.trackPreferred", "detail.trackSdh", "detail.trailers", "detail.unknown", "detail.version", "detail.watchedError.ok", "detail.watchlistAdd",
        "detail.watchlistRemove", "detail.writer", "detail.writtenBy", "subtitle.trackUnsupportedFormat",
    ],
    "src/ui/detailsActions.ts": ["detail.autoAudio", "detail.autoSubtitles", "detail.autoVersion", "detail.startOver", "detail.subtitles", "detail.watchlist"],
    "src/ui/detailsLoading.ts": ["detail.loadingDetails", "detail.loadingDetailsFor", "detail.readout.audio", "detail.readout.subtitles", "detail.readout.version"],
    "src/ui/detailsState.ts": ["detail.watchedError.body", "detail.watchedError.title", "shuffle.failed", "shuffle.failedTitle", "shuffle.nothingToPlay", "shuffle.notFound"],
    "src/ui/trailerFetch.ts": ["detail.trailerFetch.cooldown", "detail.trailerFetch.disabled", "detail.trailerFetch.failed", "detail.trailerFetch.finding", "detail.trailerFetch.notFound", "detail.trailerFetch.rateLimited"],
    "src/ui/trailerRail.ts": ["catalog.extra.behind_the_scenes", "catalog.extra.bloopers", "catalog.extra.clip", "catalog.extra.deleted_scene", "catalog.extra.featurette", "catalog.extra.otherExtra", "catalog.extra.teaser", "catalog.extra.trailer"],
    "src/ui/seriesEpisodesView.ts": ["common.retry", "detail.episodes.empty", "detail.episodes.loadMoreFailed", "detail.episodes.title", "detail.error.loadEpisodes", "detail.season", "detail.specials", "detail.watched"],
    "src/ui/descriptionTranslation.ts": ["detail.translation.translated", "detail.translation.translating"],
    "src/ui/boxSetRow.ts": ["boxSets.thisFilmTag"],
    "src/contracts/v2/details.ts": ["detail.aired", "detail.country", "detail.firstAired", "detail.lastAired", "detail.network", "detail.released", "detail.studio"],
    "src/ui/globalSearch.ts": [
        "boxSets.eyebrow", "boxSets.searchHeading", "requests.search.availableSubtitle", "requests.search.availableTitle", "search.filter.all", "search.filter.audiobooks", "search.filter.movies", "search.filter.series", "search.people", "search.resultCount",
    ],
    "src/ui/browseViews.ts": ["search.empty", "search.emptyBody", "search.initial", "search.initialBodyPeople", "search.searchingAccessibility"],
    "src/ui/browse.ts": ["search.fieldPrompt.audiobooks", "search.fieldPrompt.video", "search.title", "watchParty.entry.suggest", "watchParty.entry.watchParty"],
};

test("each Details and Search screen names its Apple keys, and every one is in the catalog", () => {
    const missing: string[] = [];
    for (const [file, keys] of Object.entries(SCREEN_KEYS)) {
        const source = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
        for (const key of keys) {
            assert.ok(key in english, `${key} is not an Apple key`);
            if (!source.includes(`"${key}"`)) missing.push(`${file}: ${key}`);
        }
    }
    assert.deepEqual(missing, []);
});

// Real German from silo-translations a0142c1a (catalog/de.arb), for the keys a German TV shows first.
const GERMAN: Readonly<Record<string, string>> = {
    "boxSets.eyebrow": "Filmreihe",
    "catalog.seasons": "{count, plural, one {# Staffel} other {# Staffeln}}",
    "common.play": "Abspielen",
    "detail.autoValue": "Auto · {value}",
    "detail.cast": "Besetzung & Crew",
    "detail.directedBy": "Regie: {names}",
    "detail.episodeCount": "{count, plural, one {{count_text} Folge} other {{count_text} Folgen}}",
    "detail.episodeEyebrow": "{season} · Folge {episode}",
    "detail.more": "Mehr",
    "detail.more.addFavorite": "Zu Favoriten hinzufügen",
    "detail.more.markSeasonWatched": "Staffel als gesehen markieren",
    "detail.more.shuffleSeason": "{season} zufällig wiedergeben",
    "detail.resumeAt": "Ab {time} fortsetzen",
    "detail.season": "Staffel {number}",
    "detail.startOver": "Von vorne beginnen",
    "detail.subtitles": "Untertitel",
    "detail.trackForced": "Erzwungen",
    "detail.watchedError.title": "Gesehen-Status konnte nicht aktualisiert werden",
    "requests.search.availableSubtitle": "Noch nicht in der Mediathek · zum Anfragen tippen",
    "requests.search.availableTitle": "Zum Anfragen verfügbar",
    "search.empty": "Keine Ergebnisse",
    "search.emptyBody": "Versuche es mit einem anderen Suchbegriff",
    "search.fieldPrompt.video": "Filme und Serien suchen…",
    "search.filter.all": "Alle",
    "search.filter.movies": "Filme",
    "search.filter.series": "Serien",
    "search.people": "Personen",
    "search.resultCount": "{count, plural, one {{count_text} Ergebnis} other {{count_text} Ergebnisse}}",
};
const catalogs: Catalogs = { en: english, de: GERMAN };
const german = (key: string, args?: Record<string, string | number>): string => resolveMessage(catalogs, key, "de", args, "de-DE");

const argumentNames = (nodes: readonly MessageNode[]): string[] =>
    nodes.flatMap(node => node.kind === "argument" ? [node.name] : node.kind === "plural" ? [node.name, ...Object.values(node.forms).flatMap(argumentNames)] : []);

test("German keeps the arguments each English message takes", () => {
    for (const [key, message] of Object.entries(GERMAN)) {
        const wanted = new Set(argumentNames(parseMessage(english[key as keyof typeof english])));
        assert.deepEqual(new Set(argumentNames(parseMessage(message))), wanted, key);
    }
});

test("German replaces the Details and Search text, with its own plural forms", () => {
    assert.equal(german("boxSets.eyebrow"), "Filmreihe");
    assert.equal(german("detail.more.addFavorite"), "Zu Favoriten hinzufügen");
    assert.equal(german("detail.resumeAt", { time: "1:02:03" }), "Ab 1:02:03 fortsetzen");
    assert.equal(german("detail.more.shuffleSeason", { season: "Staffel 2" }), "Staffel 2 zufällig wiedergeben");
    assert.equal(german("catalog.seasons", { count: 1 }), "1 Staffel");
    assert.equal(german("catalog.seasons", { count: 3 }), "3 Staffeln");
    assert.equal(german("search.resultCount", { count: 1234, count_text: integerText(1234, "de-DE") }), "1234 Ergebnisse");
    assert.equal(german("search.fieldPrompt.video"), "Filme und Serien suchen…");
});

test("a key German lacks shows English, counted by English's rules", () => {
    assert.equal(german("detail.more.markSeriesWatched"), "Mark Series Watched");
    assert.equal(german("detail.episodes.empty"), "No episodes available");
    assert.equal(german("detail.editionVersionCount", { count: 1 }), "1 version");
    assert.equal(german("detail.editionVersionCount", { count: 2 }), "2 versions");
});

test("episode and result counts read in the shown language's digits and are never grouped", () => {
    assert.equal(integerText(1234, "de-DE"), "1234");
    assert.equal(integerText(1234, "en-AU"), "1234");
    assert.equal(integerText(12, formattingLocale("ar", undefined)), "١٢");
});
