import type { CatalogBoxSet } from "../contracts/v2/boxSets.ts";
import { boxSetAccessibilityLabel, boxSetCardCaption, boxSetFilmCount, boxSetWatchedProgress } from "../contracts/v2/boxSets.ts";
import type { RequestTitle } from "../contracts/v2/requests.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, failureError, searchLoading, searchView, zoneNode, type SearchResults, type ViewContext } from "./browseViews.ts";
import { browseCardDestination, type SearchFilter } from "./browseModel.ts";
import { feedGrid } from "./catalogFeed.ts";
import { defaultArtwork } from "./defaultArtwork.ts";
import { requestCard } from "./requests.ts";
import { requestProgress } from "./requestProgress.ts";
import { el } from "./screen.ts";
import type { SearchModule } from "./search.ts";
import { searchRail } from "./searchRail.ts";
import { balanceTwoLineText, fitCentredLines } from "./textLayout.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";

/** TVCatalogGrid.prefetchRowsRemaining: the next page is read once a card this many rows from the end is on screen. */
const SEARCH_LOAD_ROWS = 8;

export interface SearchViewNav {
    readonly context: ViewContext;
    readonly gridColumns: number;
    readonly searchHead: readonly HTMLElement[];
    readonly input: HTMLInputElement;
    readonly back: () => void;
    readonly signIn: (() => void) | undefined;
    readonly openBoxSet: (id: string, libraryId: string, title: string) => void;
    readonly openRequestMedia: (title: RequestTitle) => void;
    readonly openCatalogItem: (id: string, title: string) => void;
}

/**
 * TVCatalogGrid: poster-wide columns 40 apart (TVCatalogGrid.swift:39), 260px apart at the standard size. The track is
 * the poster itself, so the TV's browser cannot grow a `minmax(0, 1fr)` column, and the grid is as wide as its columns.
 * The count is a literal so `repeat(var())` cannot drop the declaration.
 */
function lockSearchColumns(node: HTMLElement, columns: number): void {
    node.style.setProperty("--search-columns", String(columns));
    node.style.gridTemplateColumns = `repeat(${columns}, calc(220px * var(--poster-scale, 1)))`;
    node.style.width = "max-content";
    // A full row is wider than its cards' column in SwiftUI only when it cannot shrink; browse.css centres it then.
    // A short last row is its own HStack with flexible spacers, so it keeps the column's edge under the centred rows.
    const count = node.childElementCount, shortFrom = count >= columns && count % columns !== 0 ? count - (count % columns) : count;
    node.dataset.fullRow = String(count >= columns);
    for (const [index, card] of [...node.children].entries()) card.classList.toggle("search-last-row", index >= shortFrom);
}

export function searchRequestCatalogId(title: RequestTitle): string | undefined {
    return requestProgress(title)?.display === "inLibrary" && title.libraryContentId?.trim() ? title.libraryContentId : undefined;
}

/** Presentation boundary for the shared Requests card owner. No catalog identity is fabricated. */
export function searchRequestCard(title: RequestTitle, baseUrl: string, open: () => void): FocusItem {
    return requestCard(title, baseUrl, open);
}

/**
 * Search posters are 220pt (`SearchView` `cardWidth`) and carry overlay data, as `TVCatalogGrid` does.
 * Select opens the card's detail route. It does not use the shared episode play shortcut.
 */
function searchCards(context: ViewContext): ViewContext {
    return { ...context, cardDestination: browseCardDestination, seriesYears: true };
}

function searchResults(module: SearchModule, nav: SearchViewNav): SearchResults {
    const s = module.snapshot();
    if (s.failure !== undefined) {
        return { status: "failed", error: failureError(s.failure, s.error), retry: () => module.retry(), signIn: nav.signIn };
    }
    if (s.status === "idle") {
        return { status: "idle" };
    }
    if (s.page === undefined || s.feedKey === undefined) {
        return { status: "searching" };
    }
    // One grid for every loaded page (TVCatalogGrid), keyed by feedKey so a fresh answer starts a new grid.
    const feed = feedGrid(s.feedKey, s.page, searchCards(nav.context), SEARCH_LOAD_ROWS * nav.gridColumns, s.busy, () => module.loadMore(), nav.gridColumns, 220);
    // Search draws its own poster grid (browse.css `.search-scene > .browse-grid`), not the catalog grid's.
    feed.content[0]?.classList.remove("catalog-grid");
    return { status: "ready", query: s.resultsFor, grid: feed };
}

export function globalSearchView(module: SearchModule, nav: SearchViewNav): View {
    const s = module.snapshot();
    const view = searchView(nav.searchHead, nav.input, searchResults(module, nav), nav.back);
    const choices: readonly (readonly [SearchFilter | undefined, string])[] = [
        [undefined, translate("search.filter.all")],
        ["movie", translate("search.filter.movies")],
        ["series", translate("search.filter.series")],
        ...(s.audiobooksEnabled ? [["audiobook", translate("search.filter.audiobooks")] as const] : []),
    ];
    const filters = choices.map(([value, label]) => {
        const item = actionButton(`search-filter:${value ?? "all"}`, label, () => module.setFilter(value));
        item.element.addEventListener("focus", () => module.setFilter(value));
        item.element.setAttribute("aria-pressed", String(s.filter === value));
        return item;
    });
    const content = [...nav.searchHead], zones: Zone[] = view.zones.slice(0, 1);
    if (s.query.trim() !== "") {
        content.push(zoneNode("browse-actions search-filters", filters));
        zones.push({ id: "search-filters", layout: "row", items: filters });
    }
    const people = s.people;
    const boxSets = s.boxSets;
    if (s.waitingForSupplement && !view.content.some(node => node.classList.contains("search-progress"))) content.push(searchLoading());
    if (s.failure === undefined && boxSets.length > 0) {
        const items = boxSets.map(set => boxSetSearchCard(set, nav.context.baseUrl, () => nav.openBoxSet(set.id, set.libraryId, set.title)));
        const grid = zoneNode("browse-grid", items);
        grid.dataset.section = "search-box-sets";
        lockSearchColumns(grid, nav.gridColumns);
        content.push(el("h2", "browse-section-title search-box-sets-heading", translate("boxSets.searchHeading")), grid);
        zones.push({ id: "search-box-sets", layout: "grid", spatial: true, columns: nav.gridColumns, items });
    }
    if (s.failure === undefined && people.length > 0) {
        const items = people.map(person => {
            const item = actionButton(`person:${person.id}`, person.name, () => nav.context.open({ kind: "person", id: person.id, title: person.name }));
            item.element.className = "browse-card details-person";
            item.element.replaceChildren(artwork("browse-art details-photo", person.photoUrl, nav.context.baseUrl, ""), el("span", "browse-card-title", person.name));
            return item;
        });
        const rail = searchRail("details-people search-people-rail", items);
        rail.dataset.section = "search-people";
        requestAnimationFrame(() => {
            if (!rail.isConnected) return;
            for (const caption of rail.querySelectorAll<HTMLElement>(".browse-card-title")) balanceTwoLineText(caption);
        });
        content.push(el("h2", "browse-section-title search-people-heading", translate("search.people")), rail);
        zones.push({ id: "search-people", layout: "row", spatial: true, items });
    }
    const page = s.page;
    if (s.failure === undefined && page !== undefined && page.items.length > 0) {
        // SearchViewModel.total: the response total, or the loaded count when the server sends none (search.resultCount).
        const total = page.total ?? page.items.length;
        content.push(el("p", "browse-text search-count", translate("search.resultCount", { count: total, count_text: integerText(total) })));
    }
    content.push(...view.content.slice(nav.searchHead.length).filter(node => {
        if (node.classList.contains("search-empty") && (people.length > 0 || boxSets.length > 0 || s.waitingForSupplement)) return false;
        if (node.classList.contains("browse-grid")) lockSearchColumns(node, nav.gridColumns);
        return !(node.classList.contains("browse-grid") && node.childElementCount === 0);
    }));
    zones.push(...view.zones.slice(1).map(zone => zone.id === "grid" ? { ...zone, spatial: true, columns: nav.gridColumns } : zone));
    if ((s.requests?.length ?? 0) > 0) {
        const items = s.requests?.map(title => searchRequestCard(title, nav.context.baseUrl, () => {
            const id = searchRequestCatalogId(title);
            if (id === undefined) nav.openRequestMedia(title);
            else nav.openCatalogItem(id, title.title);
        })) ?? [];
        const heading = el("h2", "browse-section-title search-requests-heading", translate("requests.search.availableTitle"));
        const symbol = el("span", "search-requests-symbol");
        symbol.setAttribute("aria-hidden", "true");
        symbol.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="m14 0 2 9 6 3-6 3-2 9-2-9-6-3 6-3 2-9ZM4 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3ZM4 16l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z"/></svg>';
        heading.prepend(symbol);
        const rail = searchRail("requests-rail search-request-rail", items);
        rail.dataset.section = "search-requests";
        content.push(heading,
            el("p", "search-requests-description", translate("requests.search.availableSubtitle")), rail);
        zones.push({ id: "search-requests", layout: "row", spatial: true, items });
    }
    const grids = content.filter(node => node.classList.contains("browse-grid"));
    const fit = (): void => fitCentredLines(grids.filter(grid => grid.isConnected).flatMap(grid => [...grid.querySelectorAll<HTMLElement>(".browse-card-title, .browse-card-subtitle")]));
    requestAnimationFrame(() => {
        fit();
        if (document.fonts.status !== "loaded") void document.fonts.ready.then(fit);
    });
    return { ...view, content, zones };
}

/** A box set search result drawn with the title card, opening the box set page. */
function boxSetSearchCard(set: CatalogBoxSet, baseUrl: string, open: () => void): FocusItem {
    const item = actionButton(`box-set:${set.libraryId}:${set.id}`, set.title, open);
    item.element.className = "browse-card box-set-card";
    item.element.replaceChildren();
    item.element.setAttribute("aria-label", boxSetAccessibilityLabel(set));
    const sleeves = el("span", "box-set-sleeves");
    sleeves.setAttribute("aria-hidden", "true");
    sleeves.append(el("span", "box-set-sleeve box-set-sleeve-back"), el("span", "box-set-sleeve box-set-sleeve-front"));
    const art = artwork("browse-art", set.posterUrl, baseUrl, defaultArtwork("film"));
    const progress = boxSetWatchedProgress(set);
    if (progress !== undefined) {
        const bar = el("span", "skyline-progress");
        const fill = el("span", "skyline-progress-fill");
        fill.style.width = `${Math.min(100, progress * 100)}%`;
        bar.appendChild(fill);
        art.appendChild(bar);
    }
    const mark = el("span", "box-set-label", translate("boxSets.eyebrow"));
    const count = el("span", "box-set-count", boxSetFilmCount(set.movieCount));
    mark.setAttribute("aria-hidden", "true");
    count.setAttribute("aria-hidden", "true");
    art.append(mark, count);
    item.element.append(sleeves, art, el("span", "browse-card-title", set.title), el("span", "browse-card-subtitle", boxSetCardCaption(set)));
    return item;
}
