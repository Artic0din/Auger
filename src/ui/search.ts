import { boxSetOperations, BOX_SET_SEARCH_LIMIT } from "../api/boxSetOperations.ts";
import { systemClock, type Clock } from "../api/clock.ts";
import { detailOperations } from "../api/detailOperations.ts";
import { ApiError } from "../api/errors.ts";
import { operations, type TextSearchScope } from "../api/operations.ts";
import { requestOperations } from "../api/requestOperations.ts";
import type { CatalogBoxSet } from "../contracts/v2/boxSets.ts";
import type { CatalogPage } from "../contracts/v2/catalog.ts";
import type { Person } from "../contracts/v2/details.ts";
import type { RequestTitle } from "../contracts/v2/requests.ts";
import type { NativeSession } from "../session/session.ts";
import { createForegroundRunner, idleFocusReader, type Arrival, type FocusReader, type ForegroundRunner, type ForegroundSlot, type Paint, type RouteEntry } from "./browseEnv.ts";
import type { FocusTarget } from "./browseFocus.ts";
import { searchScope, type SearchFilter } from "./browseModel.ts";
import { errorState, failureBody, failureText, type ErrorState } from "./errorState.ts";

/** Apple's SearchViewModel.pageSize: each read adds this many titles to the one grid. */
export const SEARCH_PAGE_SIZE = 60;
/** SearchViewModel.onQueryChanged waits 300 ms before starting the replacement search. */
export const SEARCH_DELAY_MS = 300;

const REFUSAL_PROBLEMS = new Set(["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"]);

export interface SearchOptions {
    readonly session: NativeSession;
    readonly clock?: Clock;
    readonly focus?: FocusReader;
    readonly foreground?: ForegroundRunner;
    readonly audiobooksEnabled: () => boolean;
    readonly requestsEnabled: () => boolean;
    readonly onBoxSetsCapability?: (supported: boolean) => void;
    readonly onRequestsRefused?: () => void;
    readonly onChange?: (paint?: Paint) => void;
}

export interface SearchSnapshot {
    readonly query: string;
    readonly resultsFor: string;
    readonly filter: SearchFilter | undefined;
    readonly audiobooksEnabled: boolean;
    readonly status: "idle" | "searching" | "ready" | "failed";
    readonly page: CatalogPage | undefined;
    /** Stable identity key across `loadMore()` appends; rotates on every fresh or restarted search. */
    readonly feedKey: object | undefined;
    readonly busy: boolean;
    readonly slow: boolean;
    readonly failure: string | undefined;
    readonly error: ErrorState | undefined;
    readonly people: readonly Person[];
    readonly peoplePending: boolean;
    readonly peopleFailure: boolean;
    readonly boxSets: readonly CatalogBoxSet[];
    readonly boxSetsPending: boolean;
    readonly requests: readonly RequestTitle[] | undefined;
    readonly waitingForSupplement: boolean;
}

export interface SearchModule extends RouteEntry {
    readonly kind: "search";
    snapshot(): SearchSnapshot;
    setQuery(text: string): void;
    submit(text: string, fromDoneKey?: boolean): void;
    blurInput(): void;
    setFilter(filter: SearchFilter | undefined): void;
    loadMore(): void;
    retry(): void;
    retryPeople(): void;
    invalidateRequests(visible: boolean): void;
    clearRequests(): void;
    refreshRequestsIfEnabled(): void;
}

export function createSearch(options: SearchOptions): SearchModule {
    const { session, audiobooksEnabled, requestsEnabled } = options;
    const clock = options.clock ?? systemClock;
    const focusReader = options.focus ?? idleFocusReader;
    const foreground = options.foreground ?? createForegroundRunner(clock);

    let query = "";
    let resultsFor = "";
    let filter: SearchFilter | undefined;
    let resultsFilter: SearchFilter | undefined;
    let searching = false;
    let page: CatalogPage | undefined;
    let committedIndex = 0;
    let cursors: (string | undefined)[] = [undefined];
    let feedKey: object | undefined;
    let appending = false;
    let restarted = false;

    let searchType: TextSearchScope | undefined;
    let peopleSupported = false;
    let boxSetsSupported = false;

    let people: readonly Person[] = [];
    let peoplePending = false;
    let peopleFailure = false;
    let boxSets: readonly CatalogBoxSet[] = [];
    let boxSetsPending = false;
    let requests: readonly RequestTitle[] | undefined;
    let requestsFor: string | undefined;

    let peopleController: AbortController | undefined;
    let boxSetController: AbortController | undefined;
    let requestsController: AbortController | undefined;
    let cancelDebounce: () => void = () => undefined;
    let titlesSlot: ForegroundSlot | undefined;
    let returnFocus: FocusTarget | undefined;

    let failure: string | undefined;
    let error: ErrorState | undefined;
    let slow = false;
    let stale = false;
    let active = false;
    let retired = false;

    const notify = (paint?: Paint): void => {
        if (!retired && active) options.onChange?.(paint);
    };

    const clearDebounce = (): void => {
        cancelDebounce();
        cancelDebounce = () => undefined;
    };

    const stopSupplements = (): void => {
        peopleController?.abort();
        peopleController = undefined;
        boxSetController?.abort();
        boxSetController = undefined;
        requestsController?.abort();
        requestsController = undefined;
    };

    const scopeFor = (base: TextSearchScope): TextSearchScope | SearchFilter | undefined =>
        searchScope(filter, audiobooksEnabled(), base === "video_with_episodes");

    const startRequests = (): void => {
        const trimmed = query.trim();
        // RequestSearchSectionViewModel.onQueryChanged: a query of one character clears matches; longer ones keep them until answered.
        if (!requestsEnabled() || trimmed.length <= 1) {
            requests = trimmed.length === 0 ? undefined : [];
            requestsFor = undefined;
            return;
        }
        if (requestsFor === trimmed) return;
        requestsController?.abort();
        const controller = new AbortController();
        requestsController = controller;
        requestsFor = trimmed;
        controller.signal.onabort = () => {
            requestsFor = undefined;
        };
        const owns = (): boolean => !retired && !controller.signal.aborted && active && query.trim() === trimmed;
        void session.call({ ...requestOperations.search(trimmed, 1), profileScoped: true, signal: controller.signal }).then(found => {
            if (!owns()) return;
            requestsController = undefined;
            requests = found.results.filter(title => (title.mediaType === "movie" || title.mediaType === "series") && title.availability !== "available").slice(0, 12);
            let nextFocus = focusReader.focused();
            if (returnFocus !== undefined) {
                if (requests.some(title => `${title.mediaType}:${title.tmdbId}` === returnFocus?.key)) {
                    nextFocus = returnFocus;
                }
                returnFocus = undefined;
            }
            notify({ focus: nextFocus });
        }, (err: unknown) => {
            if (!owns()) return;
            requestsController = undefined;
            requestsFor = undefined;
            requests = [];
            returnFocus = undefined;
            notify({ focus: focusReader.focused() });
            if (err instanceof ApiError && REFUSAL_PROBLEMS.has(err.problemId ?? "")) {
                options.onRequestsRefused?.();
            }
        });
    };

    const startPeople = (type: TextSearchScope | SearchFilter | undefined): void => {
        peopleController?.abort();
        peopleFailure = false;
        // SearchViewModel.startPeopleSearch: the shown people stay until this lookup answers.
        if (!peopleSupported) {
            people = [];
            peoplePending = false;
            return;
        }
        const reqQuery = query;
        const controller = new AbortController();
        peopleController = controller;
        peoplePending = true;
        const owns = (): boolean => !retired && !controller.signal.aborted && active && query === reqQuery;
        void session.call({ ...detailOperations.people(reqQuery.trim(), type), profileScoped: true, signal: controller.signal }).then(found => {
            if (!owns()) return;
            peopleController = undefined;
            people = found;
            peoplePending = false;
            notify({ focus: focusReader.focused() });
        }, () => {
            if (!owns()) return;
            peopleController = undefined;
            // SearchViewModel.matchingPeople answers none on failure, replacing the shown people.
            people = [];
            peoplePending = false;
            peopleFailure = true;
            notify({ focus: focusReader.focused() });
        });
    };

    const startBoxSets = (): void => {
        boxSetController?.abort();
        const wants = boxSetsSupported && (filter === undefined || filter === "movie");
        const trimmed = query.trim();
        if (!wants || trimmed === "") {
            boxSetController = undefined;
            boxSets = [];
            boxSetsPending = false;
            return;
        }
        const controller = new AbortController();
        boxSetController = controller;
        boxSetsPending = true;
        const owns = (): boolean => !retired && !controller.signal.aborted && active && query.trim() === trimmed && (filter === undefined || filter === "movie");
        const miss = (): void => {
            if (!owns()) return;
            boxSetController = undefined;
            boxSets = [];
            boxSetsPending = false;
            notify({ focus: focusReader.focused() });
        };
        // search() throws before a request exists; keep the miss local so the title search still runs.
        let spec: ReturnType<typeof boxSetOperations.search>;
        try {
            spec = boxSetOperations.search(trimmed, BOX_SET_SEARCH_LIMIT);
        } catch {
            miss();
            return;
        }
        void session.call({ ...spec, profileScoped: true, signal: controller.signal }).then(found => {
            if (!owns()) return;
            boxSetController = undefined;
            boxSets = found.slice(0, BOX_SET_SEARCH_LIMIT);
            boxSetsPending = false;
            notify({ focus: focusReader.focused() });
        }, miss);
    };

    const clearResults = (): void => {
        if (titlesSlot?.active()) foreground.abort();
        titlesSlot = undefined;
        stopSupplements();
        searching = false;
        page = undefined;
        committedIndex = 0;
        cursors = [undefined];
        feedKey = undefined;
        resultsFor = "";
        resultsFilter = undefined;
        people = [];
        peoplePending = false;
        peopleFailure = false;
        boxSets = [];
        boxSetsPending = false;
        requests = undefined;
        requestsFor = undefined;
        failure = undefined;
        error = undefined;
        slow = false;
    };

    const loadTitles = (append: boolean, quiet: boolean): void => {
        const reqQuery = query;
        const reqFilter = filter;
        const shownPage = page;
        const shownIndex = committedIndex;
        const shownCursors = cursors;
        // A quiet reread of the answered query and filter keeps every loaded page.
        const depth = quiet && !append && shownPage !== undefined && resultsFor === reqQuery && resultsFilter === reqFilter ? shownIndex + 1 : 1;
        appending = append;
        slow = false;
        const slot = foreground.begin({
            quiet: quiet || shownPage !== undefined,
            onSlow: () => {
                if (titlesSlot === slot && active && !retired) {
                    slow = true;
                    notify();
                }
            },
        });
        titlesSlot = slot;

        void (async (): Promise<{ page: CatalogPage; startsOver: boolean; cursors?: (string | undefined)[]; skipped?: (string | undefined)[] }> => {
            if (append && shownPage !== undefined) {
                const cursor = shownCursors[shownIndex + 1];
                const scope = scopeFor(searchType ?? "video");
                const first = (): Promise<CatalogPage> => session.call({ ...operations.listCatalogItems({ q: reqQuery.trim(), type: scope, limit: SEARCH_PAGE_SIZE, cursor: undefined }), profileScoped: true, signal: slot.signal });
                let rejected: unknown;
                try {
                    const seen = new Set(shownPage.items.map(item => item.id));
                    const skipped: (string | undefined)[] = [];
                    for (let next = cursor; ;) {
                        const fetched = await session.call({ ...operations.listCatalogItems({ q: reqQuery.trim(), type: scope, limit: SEARCH_PAGE_SIZE, cursor: next }), profileScoped: true, signal: slot.signal });
                        if (fetched.nextCursor !== undefined && (shownCursors.includes(fetched.nextCursor) || skipped.includes(fetched.nextCursor))) {
                            rejected = new ApiError({ kind: "invalid_response", path: "search.page.next_cursor" });
                            break;
                        }
                        // The end observer asks again only when cards are added, so a page of cards already shown reads on.
                        if (fetched.nextCursor === undefined || fetched.items.some(item => !seen.has(item.id))) {
                            return { page: fetched, startsOver: false, skipped };
                        }
                        skipped.push(fetched.nextCursor);
                        next = fetched.nextCursor;
                    }
                } catch (err) {
                    if (slot.signal.aborted || !(err instanceof ApiError) || err.problemId !== "invalid_cursor") throw err;
                    rejected = err;
                }
                // Restart once; a restarted list whose cursor is rejected again shows the error until Try Again.
                if (restarted) throw rejected;
                return { page: await first(), startsOver: true };
            }

            let baseType = searchType;
            if (baseType === undefined) {
                const capability = await session.call({ ...operations.getCatalogSearchCapabilities(), profileScoped: true, signal: slot.signal });
                baseType = capability.allowed && capability.state === "available" && capability.videoWithEpisodesScope === true
                    ? "video_with_episodes" : "video";
                if (!slot.signal.aborted && active && !retired && query === reqQuery) {
                    searchType = baseType;
                    peopleSupported = capability.allowed && capability.state === "available" && capability.peopleMediaScope === true;
                    boxSetsSupported = capability.boxSets === true;
                    options.onBoxSetsCapability?.(boxSetsSupported);
                }
            }
            if (slot.signal.aborted || !active || retired || query !== reqQuery) {
                throw new DOMException("Aborted", "AbortError");
            }
            const scope = scopeFor(baseType);
            startPeople(scope);
            startBoxSets();
            let fetched = await session.call({ ...operations.listCatalogItems({ q: reqQuery.trim(), type: scope, limit: SEARCH_PAGE_SIZE, cursor: undefined }), profileScoped: true, signal: slot.signal });
            const nextCursors: (string | undefined)[] = [undefined, fetched.nextCursor];
            const items = [...fetched.items];
            const seen = new Set(items.map(item => item.id));
            while (nextCursors.length - 1 < depth && fetched.nextCursor !== undefined) {
                try {
                    fetched = await session.call({ ...operations.listCatalogItems({ q: reqQuery.trim(), type: scope, limit: SEARCH_PAGE_SIZE, cursor: fetched.nextCursor }), profileScoped: true, signal: slot.signal });
                } catch (err) {
                    // The list changed under the refresh: keep the fresh pages read so far.
                    if (slot.signal.aborted || !(err instanceof ApiError) || err.problemId !== "invalid_cursor") throw err;
                    break;
                }
                if (fetched.nextCursor !== undefined && nextCursors.includes(fetched.nextCursor)) {
                    throw new ApiError({ kind: "invalid_response", path: "search.page.next_cursor" });
                }
                for (const item of fetched.items) {
                    if (!seen.has(item.id)) {
                        seen.add(item.id);
                        items.push(item);
                    }
                }
                nextCursors.push(fetched.nextCursor);
            }
            return { page: { ...fetched, items }, startsOver: true, cursors: nextCursors };
        })().then(result => {
            if (!slot.active() || retired) return;
            slot.finish();
            titlesSlot = undefined;
            slow = false;
            failure = undefined;
            error = undefined;
            stale = false;
            appending = false;
            // A restarted list keeps its guard until a new search or Try Again.
            restarted = append && (result.startsOver || restarted);
            resultsFor = reqQuery;
            resultsFilter = reqFilter;
            if (result.startsOver || shownPage === undefined) {
                page = result.page;
                committedIndex = (result.cursors?.length ?? 2) - 2;
                cursors = result.cursors ?? [undefined, result.page.nextCursor];
                feedKey = {};
            } else {
                const seen = new Set(shownPage.items.map(item => item.id));
                page = { ...result.page, items: [...shownPage.items, ...result.page.items.filter(item => !seen.has(item.id))] };
                committedIndex = shownIndex + 1 + (result.skipped?.length ?? 0);
                cursors = [...shownCursors, ...(result.skipped ?? []), result.page.nextCursor];
            }
            notify();
        }, (err: unknown) => {
            if (slot.signal.aborted) {
                if (titlesSlot === slot) titlesSlot = undefined;
                return;
            }
            if (!slot.active() || retired) return;
            slot.finish();
            titlesSlot = undefined;
            slow = false;
            if (err instanceof ApiError && err.problemId === "invalid_cursor") {
                page = undefined;
                committedIndex = 0;
                cursors = [undefined];
                feedKey = undefined;
                module.focus = undefined;
            }
            const text = failureText(err, { kind: "search" });
            if (text === undefined) {
                clock.schedule(() => { throw err; }, 0);
            }
            failure = text ?? "Something went wrong. Try again.";
            const state = errorState(err);
            const body = failureBody(err, { kind: "search" });
            error = body === undefined ? state : { ...state, route: body };
            // SearchViewModel.performSearch: a failed new search clears its titles, people and box sets; a failed next page keeps them.
            if (!appending) {
                searching = true;
                page = undefined;
                committedIndex = 0;
                cursors = [undefined];
                feedKey = undefined;
                peopleController?.abort();
                peopleController = undefined;
                boxSetController?.abort();
                boxSetController = undefined;
                people = [];
                peoplePending = false;
                boxSets = [];
                boxSetsPending = false;
            }
            appending = false;
            notify();
        });
    };

    const execute = (quiet: boolean, focus?: FocusTarget): void => {
        clearDebounce();
        stopSupplements();
        failure = undefined;
        error = undefined;
        if (query.trim() === "") {
            clearResults();
            notify();
            return;
        }
        startRequests();
        searching = true;
        loadTitles(false, quiet);
        notify(focus === undefined ? undefined : { focus });
    };

    const module: SearchModule = {
        kind: "search",
        focus: undefined,

        hasData() {
            return page !== undefined;
        },

        markStale() {
            stale = true;
        },

        snapshot(): SearchSnapshot {
            const busy = foreground.busy();
            const status: SearchSnapshot["status"] = failure !== undefined
                ? "failed"
                : !searching && page === undefined
                    ? "idle"
                    : page === undefined
                        ? "searching"
                        : "ready";
            const titleCount = page?.items.length ?? 0;
            const waitingForSupplement = failure === undefined && titleCount === 0 && people.length === 0 && boxSets.length === 0
                && (busy || peoplePending || boxSetsPending);
            return {
                query,
                resultsFor,
                filter,
                audiobooksEnabled: audiobooksEnabled(),
                status,
                page,
                feedKey,
                busy,
                slow,
                failure,
                error,
                people,
                peoplePending,
                peopleFailure,
                boxSets,
                boxSetsPending,
                requests,
                waitingForSupplement,
            };
        },

        arrive(_why: Arrival, focus?: FocusTarget) {
            if (retired) return;
            active = true;
            returnFocus = focus?.zone === "search-requests" && requests === undefined ? focus : undefined;
            if (peoplePending && searchType !== undefined && query === resultsFor) {
                startPeople(scopeFor(searchType));
            }
            if (boxSetsPending && boxSetsSupported && query === resultsFor) {
                startBoxSets();
            }
            if (requests === undefined) requestsFor = undefined;
            startRequests();
            const queryChanged = query !== resultsFor || filter !== resultsFilter;
            if (!module.hasData() || stale || failure !== undefined || queryChanged) {
                if (query.trim() !== "" || failure !== undefined || searching) {
                    execute(module.hasData() && !queryChanged);
                } else {
                    stale = false;
                }
            }
        },

        cover() {
            active = false;
            clearDebounce();
            stopSupplements();
            if (titlesSlot?.active()) {
                foreground.abort();
                titlesSlot = undefined;
            }
            slow = false;
        },

        retire() {
            retired = true;
            module.cover();
        },

        setQuery(text: string) {
            if (retired || !active) return;
            returnFocus = undefined;
            if (titlesSlot?.active()) foreground.abort();
            titlesSlot = undefined;
            slow = false;
            query = text;
            clearDebounce();
            // Only the replacement request is debounced; an obsolete read stops immediately, and what it replaces stays shown.
            stopSupplements();
            if (query.trim() === "") clearResults();
            else if (query.trim().length <= 1) startRequests();
            notify({ focus: focusReader.focused() });
            if (query.trim() !== "") {
                cancelDebounce = clock.schedule(() => execute(false), SEARCH_DELAY_MS);
            }
        },

        submit(text: string, fromDoneKey = false) {
            if (retired || !active || text === "") return;
            returnFocus = undefined;
            query = text;
            // Done closes the Samsung keyboard; leaving Apple's keyboard lands on the selected filter.
            execute(false, fromDoneKey ? { zone: "search-filters", key: `search-filter:${filter ?? "all"}` } : undefined);
        },

        blurInput() {
            returnFocus = undefined;
        },

        setFilter(nextFilter: SearchFilter | undefined) {
            if (retired || !active || filter === nextFilter) return;
            foreground.abort();
            titlesSlot = undefined;
            filter = nextFilter;
            execute(false);
        },

        loadMore() {
            if (retired || !active || foreground.busy() || failure !== undefined || query !== resultsFor || filter !== resultsFilter || page?.nextCursor === undefined) return;
            loadTitles(true, true);
            notify({ focus: focusReader.focused() });
        },

        retry() {
            if (retired || !active) return;
            failure = undefined;
            error = undefined;
            execute(false);
        },

        retryPeople() {
            if (retired || !active || searchType === undefined || query.trim() === "") return;
            startPeople(scopeFor(searchType));
            notify({ focus: focusReader.focused() });
        },

        invalidateRequests(visible: boolean) {
            requestsController?.abort();
            requestsController = undefined;
            requestsFor = undefined;
            if (!visible) {
                requests = undefined;
            } else if (active && !retired) {
                startRequests();
            }
        },

        clearRequests() {
            requestsController?.abort();
            requestsController = undefined;
            requests = [];
            requestsFor = undefined;
        },

        refreshRequestsIfEnabled() {
            if (active && !retired && requestsEnabled()) {
                startRequests();
            }
        },
    };

    return module;
}
