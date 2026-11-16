import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRecommendations, decodeRecommendationRow } from "../../src/contracts/v2/recommendations.ts";
import { operations } from "../../src/api/operations.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { sectionTitle } from "../../src/ui/browseViews.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const card = { content_id: "movie:1", type: "movie", title: "A film" };
test("recommendations share catalog cards, omit empty rows and stably put For You first", () => {
    const rows = decodeRecommendations({ items: [
        { type: "popular", title: "Popular", kind: "popular", items: [card] },
        { type: "cluster", title: "FOR YOU", kind: "cluster", key: "1", items: [card] },
        { type: "genre", title: "Drama", kind: "genre", key: "Drama", items: [card] },
        { type: "genre", title: "Empty", items: [] },
    ] });
    assert.deepEqual(rows.map(row => row.title), ["FOR YOU", "Popular", "Drama"]);
    assert.equal(rows[0]?.items[0]?.id, "movie:1");
    assert.equal(new Set(rows.map(row => row.id)).size, 3);
    assert.ok(rows.every(row => row.id.startsWith("recommendation:")));
});

test("only supported complete recommendation locators are kept", () => {
    for (const extra of [{}, { kind: "future" }, { kind: "cluster" }, { kind: "genre", key: " " }]) {
        assert.equal(decodeRecommendationRow({ type: "cluster", title: "A row", items: [card], ...extra }).locator, undefined);
    }
    const row = decodeRecommendationRow({ type: "genre", title: "Drama", kind: "genre", key: "Drama & Crime/TV", items: [card] });
    assert.deepEqual(row.locator, { kind: "genre", key: "Drama & Crime/TV" });
    assert.equal("recommendationSection" in operations, false, "Apple's For You has no row page to read");
    assert.equal(operations.recommendations().path, "/recommendations/discover?image_size=small");
});

test("recommendations reject malformed row, card and locator values", () => {
    for (const value of [null, {}, { items: null }, { items: [{}] }, { items: [{ type: "x", title: "x", items: null }] }, { items: [{ type: "x", title: "x", kind: ["genre"], items: [card] }] }, { items: [{ type: "x", title: "x", items: [{}] }] }]) {
        assert.throws(() => decodeRecommendations(value));
    }
});

test("rows with unknown expansion kinds retain distinct content identities", () => {
    const rows = decodeRecommendations({ items: [
        { type: "future", title: "First", kind: "future", items: [card] },
        { type: "future", title: "Second", kind: "future", items: [{ ...card, content_id: "movie:2" }] },
    ] });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]?.id, rows[1]?.id);
    assert.ok(rows.every(row => row.locator === undefined));
});

test("a recommendation row keeps the catalog key and arguments the server sent, and shows them in the chosen language", () => {
    // APIv2DiscoverRow carries titleKey and titleArgs as home sections do; a malformed extra shows the server's title.
    const keyed = decodeRecommendationRow({ type: "popular", title: "Popular on This Server", kind: "popular", title_key: "home.section.popularOnServer", items: [card] });
    assert.equal(keyed.titleKey, "home.section.popularOnServer");
    assert.equal(keyed.titleArgs, undefined);
    const withArgs = decodeRecommendationRow({ type: "genre", title: "Drama", kind: "genre", key: "Drama", title_key: "home.section.recentlyAddedIn", title_args: { library: "Movies" }, items: [card] });
    assert.deepEqual(withArgs.titleArgs, { library: "Movies" });
    const malformed = decodeRecommendationRow({ type: "popular", title: "Popular", title_key: 7, title_args: { library: 1 }, items: [card] });
    assert.equal(malformed.titleKey, undefined);
    assert.equal(malformed.titleArgs, undefined);
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    try {
        assert.equal(sectionTitle(keyed), "Beliebt auf diesem Server");
        assert.equal(sectionTitle(decodeRecommendationRow({ type: "cluster", title: "For You", title_key: "home.section.forYou", items: [card] })), "Für dich");
        assert.equal(sectionTitle(malformed), "Popular", "no key: the server's text");
    } finally { setAppLanguage(null); }
    assert.equal(sectionTitle(keyed), "Popular on This Server", "English shows the server's text as sent");
});
