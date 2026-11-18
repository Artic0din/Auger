// Not interested on movie and series cards (silo-apple 29c0dd43): the mark reads from `user_state.not_interested`, is written
// with PUT or DELETE /not-interested/{id}, and a newly marked title leaves the recommendation and discovery rows the server filters.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeHomeSections, type Card, type HomeSection } from "../../src/contracts/v2/catalog.ts";
import { detailOperations } from "../../src/api/detailOperations.ts";
import { removingNotInterested, removingNotInterestedFromAll } from "../../src/ui/browseViews.ts";

const wire = (state: Record<string, unknown> | undefined): unknown => ({ sections: [{ id: "r", section_type: "recommended_for_you", title: "R", items: [{ content_id: "movie:1", type: "movie", title: "One", ...(state === undefined ? {} : { user_state: state }) }] }] });

test("a card reads the profile's Not interested mark, and an older server leaves it unknown", () => {
    const marked = decodeHomeSections(wire({ played: false, is_favorite: false, in_watchlist: false, not_interested: true }))[0]?.items[0];
    const clear = decodeHomeSections(wire({ played: false, is_favorite: false, in_watchlist: false, not_interested: false }))[0]?.items[0];
    const older = decodeHomeSections(wire({ played: false, is_favorite: false, in_watchlist: false }))[0]?.items[0];
    const none = decodeHomeSections(wire(undefined))[0]?.items[0];
    assert.deepEqual([marked?.notInterested, clear?.notInterested, older?.notInterested, none?.notInterested], [true, false, undefined, undefined]);
});

test("the adapter marks with PUT and clears with DELETE on /not-interested/{id}, once and never replayed", () => {
    const mark = detailOperations.setNotInterested("movie:1", true);
    const clear = detailOperations.setNotInterested("series:2", false);
    assert.deepEqual([mark.method, mark.path, mark.retry], ["PUT", "/not-interested/movie%3A1", "never"]);
    assert.deepEqual([clear.method, clear.path, clear.retry], ["DELETE", "/not-interested/series%3A2", "never"]);
});

const card = (id: string): Card => ({ id, type: "movie", title: id, year: undefined, posterUrl: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined });
const row = (sectionType: string, ...ids: string[]): HomeSection => ({ id: sectionType, sectionType, title: sectionType, items: ids.map(card) });

test("a newly marked title leaves the recommendation and discovery rows, and the rows that are about what is new, in progress or saved keep it", () => {
    const sections = [
        row("recommended_for_you", "a", "b"), row("TRENDING_ON_SERVER", "a"), row("short_watches", "a", "c"),
        row("recently_added", "a", "b"), row("continue_watching", "a"), row("next_up", "a"), row("watchlist", "a"), row("future_valid_row", "a"),
    ];
    const kept = removingNotInterested(sections, "a");
    assert.deepEqual(kept.map(section => [section.sectionType, section.items.map(item => item.id)]), [
        ["recommended_for_you", ["b"]], ["short_watches", ["c"]],
        ["recently_added", ["a", "b"]], ["continue_watching", ["a"]], ["next_up", ["a"]], ["watchlist", ["a"]], ["future_valid_row", ["a"]],
    ], "TRENDING_ON_SERVER lost its only card and left; the rows of the other kinds are untouched");
    assert.equal(removingNotInterested(sections, "unknown").length, sections.length, "an id no row shows changes nothing");
});

test("a row of collections is never touched by a mark", () => {
    const collections: HomeSection = { id: "picks", sectionType: "collection_posters", title: "Picks", items: [], collections: [{ id: "c", source: "library", title: "C", posterUrl: undefined, posterThumbhash: undefined, backdropUrl: undefined, backdropThumbhash: undefined, itemCount: 1, libraryId: "1", creatorProfileId: undefined }] };
    assert.deepEqual(removingNotInterested([collections], "c"), [collections]);
    assert.deepEqual(removingNotInterestedFromAll([collections], "c"), [collections]);
});

test("For You's rows are all server-filtered recommendation lists, so a mark leaves every one", () => {
    const rows = removingNotInterestedFromAll([row("recommended_for_you", "a", "b"), row("recently_added", "a"), row("popular", "c", "a")], "a");
    assert.deepEqual(rows.map(section => [section.sectionType, section.items.map(item => item.id)]), [["recommended_for_you", ["b"]], ["popular", ["c"]]]);
});
