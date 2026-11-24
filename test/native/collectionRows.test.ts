// A Home or library row of collections (section_type collection_posters; silo-apple 6eea7cf7 Networking/Models.swift
// SectionCollectionCard and ResolvedSection): its cards decode from `collections`, a card that cannot be opened is left out
// and the rest of the row stays, and such a row is never featured.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeHomeSections } from "../../src/contracts/v2/catalog.ts";

const server = { id: "c1", source: "library", title: "Franchises", poster_url: "https://s3.example.test/c1.jpg", poster_thumbhash: "abc", backdrop_url: "https://s3.example.test/b1.jpg", backdrop_thumbhash: "def", item_count: 6, library_id: "12" };
const personal = { id: "u1", source: "user", title: "Rainy day", poster_url: "", item_count: 3, creator_profile_id: "p-kid" };
const row = (collections: unknown[], extra: Record<string, unknown> = {}): unknown => ({ sections: [{ id: "picks", section_type: "collection_posters", title: "Collections", items: [], collections, ...extra }] });

test("a row of collections decodes its server and personal cards in order", () => {
    const [section] = decodeHomeSections(row([server, personal]));
    assert.deepEqual(section?.collections, [
        { id: "c1", source: "library", title: "Franchises", posterUrl: "https://s3.example.test/c1.jpg", posterThumbhash: "abc", backdropUrl: "https://s3.example.test/b1.jpg", backdropThumbhash: "def", itemCount: 6, libraryId: "12", creatorProfileId: undefined },
        { id: "u1", source: "user", title: "Rainy day", posterUrl: undefined, posterThumbhash: undefined, backdropUrl: undefined, backdropThumbhash: undefined, itemCount: 3, libraryId: undefined, creatorProfileId: "p-kid" },
    ]);
    assert.deepEqual(section?.items, []);
});

test("a card the viewer cannot open is left out and the rest of the row stays", () => {
    const cards = decodeHomeSections(row([
        { ...server, id: "no-library", library_id: undefined },
        { ...server, id: "future", source: "family" },
        { ...server, id: "untitled", title: 7 },
        personal,
    ]))[0]?.collections;
    assert.deepEqual(cards?.map(card => card.id), ["u1"]);
});

test("a malformed backdrop leaves the card without one instead of dropping it", () => {
    const card = decodeHomeSections(row([{ ...server, backdrop_url: 5, backdrop_thumbhash: ["x"] }]))[0]?.collections?.[0];
    assert.equal(card?.id, "c1");
    assert.equal(card?.backdropUrl, undefined);
    assert.equal(card?.backdropThumbhash, undefined);
});

test("a row of collections is never featured, and other rows hold no collections", () => {
    assert.equal(decodeHomeSections(row([server], { featured: true }))[0]?.featured, false);
    const title = decodeHomeSections({ sections: [{ id: "recent", section_type: "recently_added", title: "Recent", featured: true, items: [] }] })[0];
    assert.equal(title?.featured, true);
    assert.deepEqual(title?.collections, []);
});

test("a library page's Movies or Series narrowing and Home's card removal leave a row of collections as it is", async () => {
    const { refillSection } = await import("../../src/ui/libraryDiscovery.ts");
    const { removingDismissed } = await import("../../src/ui/browseViews.ts");
    const section = decodeHomeSections(row([server, personal]))[0];
    assert.ok(section);
    let pages = 0;
    const scoped = await refillSection(section, "movie", async () => { pages++; return { items: [], next: undefined }; });
    assert.equal(scoped.section, section);
    assert.equal(scoped.incomplete, false);
    assert.equal(pages, 0, "no title page is read for a row of collections");
    assert.deepEqual(removingDismissed([section], { id: "movie:1", type: "movie", seriesId: undefined }), [section]);
});
