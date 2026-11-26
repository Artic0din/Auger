import type { CatalogPage } from "../contracts/v2/catalog.ts";
import type { View, Zone } from "./browseFocus.ts";
import { actionButton, errorView, FAILURE_ICON, failureError, recoveryActions, searchState, zoneNode, type ViewContext } from "./browseViews.ts";
import { pageLoadingView } from "./browseRoutes.ts";
import { feedGrid } from "./catalogFeed.ts";
import { personHero } from "./browseDetails.ts";
import { groupedCount } from "../i18n/format.ts";
import { translate } from "../i18n/translate.ts";
import { errorHeadline, errorMessage } from "./errorState.ts";
import { el } from "./screen.ts";
import { personQuery, type PersonModule } from "./person.ts";

export { personQuery };

const LOAD_MORE_ROWS = 8;
const MIN_FILMOGRAPHY_HEIGHT_PX = 420;
/** SF Symbol film.stack: a film frame with sprocket strips and a centre divider, two cards stacked behind it. */
const FILM_STACK_ICON = '<svg viewBox="0 0 48 44"><g fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M12 1.5h24M7 7.5h34"/><rect x="1.5" y="13.5" width="45" height="29" rx="4"/><path d="M11 28h26"/></g><path fill="currentColor" fill-rule="evenodd" d="M1.5 17.5a4 4 0 0 1 4-4H11v29H5.5a4 4 0 0 1-4-4ZM37 13.5h5.5a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H37ZM5 16.5h3.5V20H5ZM5 23h3.5v3.5H5ZM5 29.5h3.5V33H5ZM5 36h3.5v3.5H5ZM39.5 16.5H43V20h-3.5ZM39.5 23H43v3.5h-3.5ZM39.5 29.5H43V33h-3.5ZM39.5 36H43v3.5h-3.5Z"/></svg>';

export interface PersonViewNav {
    readonly context: ViewContext;
    readonly gridColumns: number;
    readonly back: () => void;
    readonly signIn: (() => void) | undefined;
}

/** Apple's `personFilmographyCountLabel` (`PersonDetailView.swift:886-894`): exact total uses `library.titleCount`; estimates defer to loaded items and `library.titleCountMore` while more pages remain. */
export function filmographyCountLabel(page: CatalogPage): string | undefined {
    if (page.totalExact && page.total !== undefined) {
        return translate("library.titleCount", { count: page.total, count_text: groupedCount(page.total) });
    }
    const loaded = page.items.length;
    if (loaded <= 0) return undefined;
    return translate(page.nextCursor !== undefined ? "library.titleCountMore" : "library.titleCount", { count: loaded, count_text: groupedCount(loaded) });
}

export function personFilmographyView(module: PersonModule, nav: PersonViewNav): View {
    const snapshot = module.snapshot();
    // Apple rootContent (PersonDetailView.swift:358-359): with no person, the failed read is the whole page's ErrorView.
    if (snapshot.person === undefined && snapshot.metadataFailure !== undefined) {
        return errorView(`person:${snapshot.id}`, failureError(snapshot.metadataFailure, snapshot.metadataError), () => module.retry(), nav.back, nav.signIn);
    }
    // Apple rootContent (PersonDetailView.swift:360-361): blank focus-owning loading page until person arrives.
    if (snapshot.person === undefined) {
        return pageLoadingView(`person:${snapshot.id}`, translate("common.loading"), nav.back);
    }
    const empty = (snapshot.page?.items.length ?? 0) === 0;
    const filters = snapshot.availableFilters.map(filter => {
        const item = actionButton(`filter:${filter}`, translate(filter === "video" ? "person.filter.all" : filter === "movie" ? "person.filter.movies" : "person.filter.series"), () => module.setFilter(filter));
        item.element.setAttribute("aria-pressed", String(snapshot.filter === filter));
        return item;
    });
    const title = el("div", "person-filmography-heading");
    title.appendChild(el("h2", "browse-section-title", translate("person.filmography")));
    const page = snapshot.page;
    const count = page === undefined ? undefined : filmographyCountLabel(page);
    if (count !== undefined) title.appendChild(el("span", "person-title-count", count));
    const content = [personHero(snapshot.person, nav.context.baseUrl, snapshot.heroLoading), title, zoneNode("skyline-pills person-filmography-filters", filters)];
    const zones: Zone[] = [{ id: "filters", layout: "row", spatial: "aligned", items: filters }];
    if (snapshot.failure !== undefined && empty) {
        // Apple ErrorView(state:onRetry:) in the Filmography area, at least 420pt tall (PersonDetailView.swift:414-416).
        const error = failureError(snapshot.failure, snapshot.error);
        const state = searchState(errorHeadline(error), errorMessage(error), "details-failure person-filmography-failure", FAILURE_ICON);
        state.setAttribute("role", "alert");
        state.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
        const actions = recoveryActions(error, actionButton("retry", translate("shell.errorView.tryAgain"), () => module.retry()), actionButton("go-back", translate("player.goBack"), nav.back),
            nav.signIn === undefined ? undefined : actionButton("sign-in", translate("settings.accounts.signInAgain"), nav.signIn));
        state.appendChild(zoneNode("browse-actions", actions));
        content.push(state);
        zones.push({ id: "status", layout: "column", items: actions });
    }
    if (page !== undefined) {
        const columns = nav.gridColumns;
        if (page.items.length === 0 && snapshot.failure === undefined) {
            // Apple EmptyStateView(icon: "film.stack"), at least 420pt tall (PersonDetailView.swift:417-423).
            const state = searchState(translate("person.empty"), translate("person.emptyBody"), "person-filmography-empty", FILM_STACK_ICON);
            state.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
            content.push(state);
        }
        const grid = feedGrid(snapshot.feedKey, page, { ...nav.context, seriesYears: true }, LOAD_MORE_ROWS * columns, snapshot.busy, () => module.loadMore(), columns);
        const scale = nav.context.posterScale?.() ?? 1;
        const node = grid.content[0];
        node?.classList.add("catalog-grid");
        node?.style.setProperty("--grid-columns", String(columns));
        node?.style.setProperty("--poster-scale", String(scale));
        node?.style.setProperty("--grid-lift", String((390 * scale + 38) / (390 * scale)));
        content.push(...grid.content);
        zones.push(...grid.zones.map(zone => zone.id === "grid" ? { ...zone, columns, spatial: true as const } : zone));
    } else if (snapshot.busy || snapshot.failure === undefined) {
        const loading = el("div", "person-filmography-state");
        loading.style.minHeight = `${MIN_FILMOGRAPHY_HEIGHT_PX}px`;
        loading.setAttribute("role", "status");
        loading.setAttribute("aria-label", "Loading titles");
        content.push(loading);
    }
    const first = zones.find(zone => zone.id === "grid")?.items[0];
    return { name: `person:${snapshot.id}`, content, zones,
        focus: first === undefined ? { zone: "filters", key: `filter:${snapshot.filter}` } : { zone: "grid", key: first.key }, back: nav.back };
}
