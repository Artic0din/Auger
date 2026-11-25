// The places browse can show, what each holds, and which view each state shows: loading,
// failed, or its data (with a note when a refresh or page turn failed). Loading lives in browse.ts.

import type { RequestPage } from "./requestsModule.ts";
import type { Audiobook } from "../contracts/v2/audiobooks.ts";
import { audiobookView } from "./audiobookView.ts";
import type { CatalogPage, Episode, HomeSection, ItemDetail, Season, SectionCollectionCard, UserLibrary } from "../contracts/v2/catalog.ts";
import type { PersonModule } from "./person.ts";
import type { SearchModule } from "./search.ts";
import type { DetailsState } from "./detailsState.ts";
import type { FocusTarget, View } from "./browseFocus.ts";
import { itemView, seasonView, withDetailsAlert } from "./browseDetails.ts";
import { audiobookLoadingView } from "./audiobookLoading.ts";
import { detailsLoadingView } from "./detailsLoading.ts";
import type { EpisodeSelection, PlayRequest, SeriesContext, SeriesLine, DetailSeed } from "./browseModel.ts";
import type { CalendarState } from "./calendarState.ts";
import { calendarView, type CalendarHandlers } from "./calendarView.ts";
import { translate } from "../i18n/translate.ts";
import type { ErrorState } from "./errorState.ts";

export { errorHeadline, errorMessage, errorState, failureBody, failureState, failureText, unconfirmedWriteMessage, writeFailureMessage, writeMayHaveApplied, type ErrorBody, type ErrorKind, type ErrorState } from "./errorState.ts";
import { actionButton, homeView, lines, errorView, failureError, pagedGrid, sectionTitle, statusView, type ViewContext, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { discoveryState, type BrowseChange, type DiscoveryState, type LibraryMode, type LibrarySource } from "./libraryDiscovery.ts";
import { collectionRowCards } from "./collectionCards.ts";
import { discoveryView, resultsView } from "./libraryDiscoveryViews.ts";
import { personalView, type PersonalFilter, type PersonalSource, type PersonalListCapability } from "./personalLists.ts";
import type { RecommendationRow } from "../contracts/v2/recommendations.ts";
import { boxSetView } from "./boxSetView.ts";
import type { BoxSetRowState } from "./boxSetRow.ts";
import { boxSetNextMovie, type CatalogBoxSetDetail } from "../contracts/v2/boxSets.ts";
import { recommendationsView } from "./recommendationsView.ts";
import { watchPartyView, type WatchPartyScreen } from "./watchParty.ts";

/** Cards per catalog page: four grid rows. Only the shown page is kept. */
export const PAGE_SIZE = 24;

export interface Pages {
    page: CatalogPage | undefined;
    index: number;
    /** cursors[i] opens page i; page 0 has none. */
    cursors: (string | undefined)[];
}

export type RouteData =
    | { readonly kind: "for_you"; data: RecommendationRow[] | undefined }
    | { readonly kind: "requests"; readonly page: RequestPage; readonly anchor?: string }
    | { readonly kind: "watchParty"; readonly watchParty: WatchPartyScreen; readonly anchor?: string }
    | { readonly kind: "calendar"; readonly calendar: CalendarState }
    | { readonly kind: "personal"; readonly source: PersonalSource; readonly anchor?: string; filter: PersonalFilter; capability: PersonalListCapability | undefined; pages: Pages; pendingIndex: number | undefined; error?: ErrorState | undefined; elsewhere?: boolean }
    | { readonly kind: "home"; data: { libraries: UserLibrary[]; sections: HomeSection[] } | undefined }
    | { readonly kind: "homeSection"; readonly id: string; readonly title: string; readonly continuing: boolean; pages: Pages; pendingIndex: number | undefined }
    | { readonly kind: "resume"; readonly id: string; readonly title: string; readonly episode?: true; readonly startOver?: boolean; readonly selection?: EpisodeSelection; readonly seriesLine?: SeriesLine }
    | { readonly kind: "library"; readonly library: UserLibrary; pages: Pages; discovery?: DiscoveryState }
    | { readonly kind: "libraryResults"; readonly library: UserLibrary; readonly title: string; readonly source: LibrarySource; pages: Pages }
    | { readonly kind: "search"; readonly search: SearchModule }
    | { readonly kind: "audiobook"; readonly id: string; readonly title: string; readonly seed?: DetailSeed; data: Audiobook | undefined; /** The chapter picker covers the page. */ picker?: boolean }
    | { readonly kind: "boxSet"; readonly id: string; readonly libraryId: string; readonly title: string; data: CatalogBoxSetDetail | undefined }
    | { readonly kind: "item"; readonly id: string; readonly title: string; readonly seriesContext?: SeriesContext; readonly seed?: DetailSeed; readonly fromRelated?: boolean; error?: ErrorState; data: { detail: ItemDetail; seasons: Season[]; details?: DetailsState; boxSet?: BoxSetRowState } | undefined }
    | { readonly kind: "person"; readonly id: string; readonly title: string; readonly person: PersonModule }
    | { readonly kind: "season"; readonly seriesId: string; readonly seasonNumber: number; readonly title: string; readonly id?: string; readonly episodeId?: string; data: { episodes: Episode[]; detail: ItemDetail | undefined; details?: DetailsState } | undefined };

export type Route = RouteData & {
    /** Where focus was when another route covered this one. */
    focus: FocusTarget | undefined;
    failure: string | undefined;
    /** Apple ErrorState for the last failed read, which picks the error page's headline and buttons. */
    error?: ErrorState | undefined;
    slow: boolean;
    /** Shown data may be out of date (after playback): refresh it in place when shown. */
    stale: boolean;
};

export function newRoute(data: RouteData): Route {
    return { ...data, focus: undefined, failure: undefined, slow: false, stale: false };
}

export function newPages(): Pages {
    return { page: undefined, index: 0, cursors: [undefined] };
}

export function hasData(current: Route): boolean {
    switch (current.kind) {
        case "requests": return current.page.hasData();
        // The hub reads nothing to open: its support answer comes with the entry point.
        case "watchParty": return true;
        case "calendar":
            return current.calendar.data !== undefined;
        case "resume":
            return false;
        case "personal":
            return current.pages.page !== undefined || current.capability !== undefined;
        case "library":
            return current.discovery?.mode === "Browse" ? current.discovery.snapshot !== undefined : current.discovery?.data !== undefined;
        // A loaded filmography is kept; only a missing person is read again (Apple loadInitial: person == nil, items.isEmpty).
        case "person": return current.person.hasData();
        case "libraryResults":
        case "homeSection":
            return current.pages.page !== undefined;
        case "search":
            return current.search.hasData();
        case "boxSet":
            return current.data !== undefined;
        default:
            return current.data !== undefined;
    }
}

export interface RouteHandlers {
    readonly browse: (route: Extract<Route, { kind: "library" }>, change: BrowseChange) => void;
    readonly more: (route: Extract<Route, { kind: "library" }>) => void;
    readonly preserve: (route: Extract<Route, { kind: "library" }>) => boolean;
    readonly gridColumns: number;
    /** The rating sources the server shows (`GET /capabilities/ratings`); empty until it answers, so a hidden rating sort is never offered early. */
    readonly ratingSources: ReadonlySet<string>;
    readonly shuffle: { readonly starting: boolean; readonly failure: string | undefined; readonly start: (route: Extract<Route, { kind: "library" | "libraryResults" }>) => void; readonly dismiss: () => void } | undefined;
    readonly calendar: (route: Extract<Route, { kind: "calendar" }>) => CalendarHandlers;
    readonly personalFilter: (route: Extract<Route, { kind: "personal" }>, filter: PersonalFilter) => void;
    readonly audiobookPicker: (route: Extract<Route, { kind: "audiobook" }>, open: boolean) => void;
    readonly morePersonal: (route: Extract<Route, { kind: "personal" }>) => void;
    readonly signIn: (() => void) | undefined;
    readonly context: ViewContext;
    readonly focusDefault: () => void;
    /** A read is in flight. */
    readonly busy: boolean;
    readonly openSearch: () => void;
    readonly push: (route: Route) => void;
    /** Opens a card of a row of collections: a server collection in its library, a personal one on its own page. */
    readonly openCollection: (card: SectionCollectionCard, library: UserLibrary | undefined) => void;
    readonly pop: () => void;
    readonly play: (request: PlayRequest) => void;
    readonly chooseProfile: () => void;
    readonly manageServers?: (() => void) | undefined;
    readonly retry: (route: Route) => void;
    readonly turn: (route: Route, pages: Pages, step: -1 | 1) => void;
    readonly mode: (route: Extract<Route, { kind: "library" }>, mode: LibraryMode) => void;
}

export function routeView(current: Route, handlers: RouteHandlers): View {
    if (current.kind === "for_you") return recommendationsView(current, handlers);
    if (current.kind === "watchParty") return watchPartyView(current.watchParty, handlers.pop, handlers.context.baseUrl);
    const { context, pop } = handlers;
    if (current.kind === "calendar") return calendarView(current.calendar, handlers.calendar(current));
    const back = current.kind === "home" ? undefined : pop;
    const escape = back === undefined ? actionButton("profiles", translate("account.profiles"), handlers.chooseProfile) : actionButton("back", translate("common.back"), back);
    if (current.kind === "personal") return personalView(current, handlers);
    if (current.kind === "library") {
        if (current.library.type === "music") return statusView(`library:${current.library.id}`, translate("library.kind.music"), ["Music browsing is not available on this TV."], [escape], back);
        current.discovery ??= discoveryState();
        return discoveryView(current, current.discovery, handlers);
    }
    if (current.failure !== undefined && !hasData(current)) {
        return errorView(`${current.kind}:failed`, failureError(current.failure, current.error), () => handlers.retry(current), back, handlers.signIn, current.kind === "home" ? handlers.manageServers : undefined);
    }
    switch (current.kind) {
        case "home": {
            if (current.data === undefined) return pageLoadingView("home:loading", translate("home.loading"));
            const view = homeView(current.data.libraries, current.data.sections, context, {
                expand: section => handlers.push(newRoute({ kind: "homeSection", id: section.id, title: sectionTitle(section), continuing: section.sectionType === "continue_watching", pages: newPages(), pendingIndex: undefined })),
                search: handlers.openSearch,
                library: (library) => handlers.push(newRoute({ kind: "library", library, pages: newPages() })),
                chooseProfile: handlers.chooseProfile,
                collectionCards: (section, rowTitle) => collectionRowCards(section, rowTitle, handlers),
                dismisses: true,
            });
            // Apple tvOS HomeView shows only the feed while it has rows, whether a refresh is running or failed;
            // with no rows, a failure is the whole page.
            if (current.failure !== undefined && view.zones.every(zone => zone.id === "empty")) {
                return errorView("home:failed", failureError(current.failure, current.error), () => handlers.retry(current), back, handlers.signIn, handlers.manageServers);
            }
            return view;
        }
        case "homeSection":
            if (current.pages.page !== undefined) {
                const contents = grid(current, current.pages, current.pages.page, { ...handlers, context: { ...context, continueWatching: current.continuing } });
                const actions = [escape, ...(current.failure === undefined ? [] : [actionButton("retry", translate("common.tryAgain"), () => handlers.retry(current))])];
                return {
                    name: `homeSection:${current.id}`,
                    content: [el("h1", "browse-title", current.title), ...contents.content,
                        ...lines(current.failure === undefined ? (current.pages.page.items.length === 0 ? ["No titles available."] : []) : [current.failure], current.failure === undefined ? "info" : "error"), zoneNode("browse-actions", actions)],
                    zones: [...contents.zones, { id: "actions", layout: "row", items: actions }],
                    focus: contents.zones[0]?.items[0] === undefined ? { zone: "actions", key: "back" } : { zone: "grid", key: contents.zones[0].items[0].key }, back: pop,
                };
            }
            break;
        case "resume":
            break;
        case "libraryResults":
            if (current.pages.page !== undefined) {
                return resultsView(current, grid(current, current.pages, current.pages.page, handlers), handlers);
            }
            break;
        case "item":
            if (current.data !== undefined) {
                const episodeId = current.seriesContext?.episodeId;
                const view = itemView(current.data.details?.detail ?? current.data.detail, current.data.seasons, {
                    ...context, open: destination => context.open(destination.kind === "season" && episodeId !== undefined ? { ...destination, episodeId } : destination),
                }, handlers.play, pop, current.data.details, current.data.boxSet);
                return withDetailsAlert(withNote(view, current.failure), current.data.details);
            }
            break;
        case "audiobook":
            if (current.data !== undefined) {
                return withNote(audiobookView(current.data, { context, pickerOpen: current.picker === true, setPicker: open => handlers.audiobookPicker(current, open), back: pop }), current.failure);
            }
            break;
        case "boxSet":
            if (current.data !== undefined) {
                const detail = current.data;
                return boxSetView(detail, context, () => {
                    const next = boxSetNextMovie(detail);
                    if (next !== undefined) handlers.push(newRoute({ kind: "resume", id: next.id, title: next.title }));
                }, pop);
            }
            break;
        case "season":
            if (current.data !== undefined) {
                return withDetailsAlert(withNote(seasonView(`season:${current.seriesId}:${current.seasonNumber}`, current.title, current.data.episodes, context, pop, handlers.play, current.data.details?.detail ?? current.data.detail, current.data.details), current.failure), current.data.details);
            }
    }
    if (current.kind === "item") return detailsLoadingView(current, context, pop);
    if (current.kind === "audiobook") return audiobookLoadingView(current, context, pop);
    // Other routes keep the slow note. Home returned above: an empty page labelled "Loading home".
    const waiting = current.slow ? ["Still waiting for the server."] : [];
    return statusView(`${current.kind}:loading`, translate("common.loading"), waiting, [escape], back);
}

/** Apple tvOS HomeView and RecommendationsView while loading with nothing to show: a clear `tvPageFocusOwner` page that is only spoken. */
export function pageLoadingView(name: string, label: string): View {
    const page = el("div", "home-loading");
    page.tabIndex = 0;
    page.setAttribute("aria-label", label);
    page.setAttribute("data-focus", "loading");
    return {
        name,
        content: [page],
        zones: [{ id: "loading", layout: "row", items: [{ key: "loading", element: page }] }],
        focus: { zone: "loading", key: "loading" },
        back: undefined,
    };
}

function grid(current: Route, pages: Pages, page: CatalogPage, handlers: RouteHandlers): ReturnType<typeof pagedGrid> {
    return pagedGrid(
        {
            page,
            index: pages.index,
            pageSize: current.kind === "libraryResults" && current.source.kind === "collection" ? 60 : PAGE_SIZE,
            loading: handlers.busy,
            previous: () => handlers.turn(current, pages, -1),
            next: () => handlers.turn(current, pages, 1),
        },
        current.kind === "libraryResults" && current.source.kind === "collection"
            ? { ...handlers.context, seriesYears: true, overlays: handlers.context.cardOverlays?.(), posterWidth: 260 * (handlers.context.posterScale?.() ?? 1) }
            : { ...handlers.context, seriesYears: true },
    );
}

/** A failed refresh or page turn keeps what is shown and says why above it. */
function withNote(view: View, failure: string | undefined): View {
    if (failure === undefined) {
        return view;
    }
    const note = el("p", "browse-text browse-error", failure);
    note.setAttribute("role", "alert");
    return { ...view, content: [note, ...view.content] };
}
