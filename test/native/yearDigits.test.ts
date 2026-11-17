// A year is an integer in the shown language's digits and never grouped, as silo-apple formats it with
// `LocaleFormat.integer`: tvOS/Components/TVFocusMarquee.swift, tvOS/Screens/Detail/TVDetailHero.swift,
// WatchParty/WatchPartyLobbyState.swift and tvOS/Screens/Requests/TVRequestsPage.swift (Shared/LocaleFormat.swift).
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCard, decodeItemDetail } from "../../src/contracts/v2/catalog.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { lobbyItemFromDetail, choiceFromCard } from "../../src/ui/watchPartyChoice.ts";
import { requestMetadata } from "../../src/ui/requestsScene.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";
import { fixture } from "./support/fakeSilo.ts";

registerSourceCatalogs();

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

const card = decodeCard({ content_id: "movie:m0004", type: "movie", title: "Title", year: 1994, runtime: 126 }, "card");
const detail = decodeItemDetail({ ...fixture("get_catalog_item_ok"), year: 1994 });

test("a Watch Party title's year reads in Arabic digits, and English is unchanged", () => {
    inLanguage("ar", () => {
        assert.equal(choiceFromCard(card).lobby.facts[0], "١٩٩٤");
        assert.equal(lobbyItemFromDetail(detail).facts[0], "١٩٩٤");
    });
    assert.equal(choiceFromCard(card).lobby.facts[0], "1994");
    assert.equal(lobbyItemFromDetail(detail).facts[0], "1994");
});

test("a request's metadata line reads its year in Arabic digits, and English is unchanged", () => {
    const title = { year: 2023, mediaType: "movie" } as Parameters<typeof requestMetadata>[0];
    assert.equal(inLanguage("ar", () => requestMetadata(title)).startsWith("٢٠٢٣ · "), true);
    assert.equal(requestMetadata(title).startsWith("2023 · "), true);
});
