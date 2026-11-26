// The collection poster card (silo-apple TVCollectionPosterCard.swift), shared by a library's Collections tab and by a
// row of collections on Home and library pages (TVCollectionsRow.swift).
import type { Card, HomeSection, SectionCollectionCard, UserLibrary } from "../contracts/v2/catalog.ts";
import { groupedCount, shownLocale } from "../i18n/format.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";
import type { FocusItem } from "./browseFocus.ts";
import { artworkUrl } from "./browseModel.ts";
import { actionButton, artwork, surfaceArtwork, type ViewContext } from "./browseViews.ts";
import { el } from "./screen.ts";

/** What a collection card draws: its poster (empty when it has none), optional ThumbHash, name and title count. */
export interface CollectionFace { readonly id: string; readonly title: string; readonly posterUrl: string | undefined; readonly posterThumbhash?: string | undefined; readonly itemCount: number }

/** TVCollectionPosterCard.countText: the content noun for a known type, else the neutral items, in capitals. Management types such as manual/smart use the neutral one. */
export function countLine(count: number, type: string | undefined): string {
    const key = ((): MessageKey => {
        switch (type?.toLowerCase()) {
            case "movie":
            case "movies":
                return "library.collectionCard.movies";
            case "series":
            case "show":
            case "shows":
            case "tvshows":
                return "library.collectionCard.shows";
            case "album":
            case "albums":
                return "library.collectionCard.albums";
            case "audiobook":
            case "audiobooks":
            case "book":
            case "books":
                return "library.collectionCard.books";
            default:
                return "collections.itemCount";
        }
    })();
    return translate(key, { count, count_text: groupedCount(count) }).toLocaleUpperCase(shownLocale());
}

const ID_ENCODER = new TextEncoder();

/** The poster with ThumbHash/surface states, or the stacked-cards symbol on a colour taken from the collection's id when empty (TVCollectionPosterCard.swift:69-100). */
export function collectionArt(face: CollectionFace, className: string, baseUrl: string): HTMLElement {
    const poster = face.posterUrl?.trim();
    if (poster !== undefined && poster !== "" && artworkUrl(poster, baseUrl) !== undefined) {
        return artwork(className, poster, baseUrl, surfaceArtwork("film"), face.posterThumbhash);
    }
    const fallback = el("span", "collection-stack");
    fallback.setAttribute("data-symbol", "square.stack.fill");
    fallback.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="8.5" y="1.6" width="7" height="2" rx="1"/><rect x="5.8" y="4.6" width="12.4" height="2.2" rx="1.1"/><rect x="3.5" y="8" width="17" height="14.2" rx="3.2"/></svg>';
    const art = artwork(className, "", baseUrl, fallback);
    let hash = 2166136261;
    for (const byte of ID_ENCODER.encode(face.id)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    art.style.background = `linear-gradient(to bottom right, hsl(${hash % 360} 33.3333% 31.5%), hsl(${hash % 360} 19.0476% 18.48%))`;
    return art;
}

export function collectionSpoken(face: CollectionFace): string {
    return face.itemCount > 0 ? translate("library.collectionCard.spokenCount", { count: face.itemCount, count_text: groupedCount(face.itemCount), name: face.title }) : translate("library.collectionCard.spoken", { name: face.title });
}

/** What the Skyline hero previews while a collection card is focused: the backdrop when the server sent one, else the poster. */
export function collectionPreview(card: CollectionFace & { readonly backdropUrl?: string | undefined }): Card {
    return { id: card.id, type: "movie", title: card.title, overview: translate("library.titleCount", { count: card.itemCount, count_text: groupedCount(card.itemCount) }), backdropUrl: card.backdropUrl ?? card.posterUrl, posterUrl: card.posterUrl, year: undefined, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined };
}

/**
 * A row card's hero preview (TVSkylineSectionFeed.marqueeContent(for: SectionCollectionCard)): the meta line holds the item
 * count and, for another profile's shared collection, "by Name"; there is no synopsis. The backdrop is the server's when it sent one.
 */
export function collectionRowPreview(card: SectionCollectionCard, owner: string | undefined): Card {
    const parts: string[] = [];
    if (card.itemCount > 0) parts.push(translate("collections.itemCount", { count: card.itemCount, count_text: groupedCount(card.itemCount) }));
    if (owner !== undefined) parts.push(translate("collections.card.byOwner", { owner }));
    return { ...collectionPreview(card), overview: undefined, metaParts: parts, collection: card };
}

export interface CollectionRowHandlers {
    readonly context: ViewContext;
    /** Opens the card: a server collection in its library (`library` is the page's own, when it has one), a personal one on its page. */
    readonly openCollection: (card: SectionCollectionCard, library: UserLibrary | undefined) => void;
}

/** The cards of a row of collections, each focus-keyed by `rowKey` so Back restores the card, not a position (a server and a personal collection can share an id). */
export function collectionRowCards(section: HomeSection, rowTitle: string, handlers: CollectionRowHandlers, library?: UserLibrary): FocusItem[] {
    return (section.collections ?? []).map(card => {
        const item = actionButton(`collection:${card.source}:${card.id}`, "", () => handlers.openCollection(card, library));
        item.element.classList.add("browse-card", "collection-poster");
        item.element.setAttribute("aria-label", collectionSpoken(card));
        item.element.append(collectionArt(card, "browse-art", handlers.context.baseUrl), el("span", "browse-card-title", card.title));
        if (card.itemCount > 0) item.element.append(el("span", "browse-card-subtitle", countLine(card.itemCount, undefined)));
        item.element.addEventListener("focus", () => handlers.context.preview?.(collectionRowPreview(card, handlers.context.ownerName?.(card.creatorProfileId)), rowTitle, false, false, false));
        return item;
    });
}
