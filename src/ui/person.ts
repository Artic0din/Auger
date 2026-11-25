import { sleep, systemClock, type Clock } from "../api/clock.ts";
import { detailOperations } from "../api/detailOperations.ts";
import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { CatalogPage } from "../contracts/v2/catalog.ts";
import type { Person } from "../contracts/v2/details.ts";
import type { CatalogQueryRequest, MediaScope } from "../contracts/v2/discovery.ts";
import type { NativeSession } from "../session/session.ts";
import { createForegroundRunner, idleFocusReader, type Arrival, type FocusReader, type ForegroundRunner, type ForegroundSlot, type Paint, type RouteEntry } from "./browseEnv.ts";
import type { FocusTarget } from "./browseFocus.ts";
import type { BrowseSignal } from "./browseSignals.ts";
import { errorState, failureBody, failureText, type ErrorState } from "./errorState.ts";

const PERSON_PAGE_SIZE = 60;
const REFRESH_WINDOW_MS = 120_000;
const POLL_INTERVAL_MS = 3_000;
const SETTLED_POLLS = 5;
const ALL_FILTERS: readonly MediaScope[] = ["video", "movie", "series"];

export function personQuery(id: string, filter: MediaScope, cursor?: string): CatalogQueryRequest {
    return { source: "person", person_id: id, type: filter, sort: "year", order: "desc", limit: PERSON_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }) };
}

function incompleteMetadata(person: Person): boolean {
    return [person.bio, person.photoUrl, person.birthDate].some(value => !value?.trim());
}

/** Visit-scoped metadata refresh poller absorbed into PersonModule; filter/page reads never own or restart it. */
class MetadataRefresh {
    private requested = false;
    private exhausted = false;
    private flight: AbortSignal | undefined;
    private readonly clock: Clock;
    private readonly current: () => Person | undefined;
    private readonly dispatch: (signal: AbortSignal) => Promise<undefined>;
    private readonly read: (signal: AbortSignal) => Promise<Person>;
    private readonly changed: (person?: Person) => void;

    constructor(
        clock: Clock,
        current: () => Person | undefined,
        dispatch: (signal: AbortSignal) => Promise<undefined>,
        read: (signal: AbortSignal) => Promise<Person>,
        changed: (person?: Person) => void,
    ) {
        this.clock = clock;
        this.current = current;
        this.dispatch = dispatch;
        this.read = read;
        this.changed = changed;
    }

    get refreshing(): boolean {
        return this.flight !== undefined && !this.flight.aborted;
    }

    start(signal: AbortSignal): void {
        const person = this.current();
        if (signal.aborted || this.refreshing || this.exhausted || person === undefined || !incompleteMetadata(person)) return;
        this.flight = signal;
        const dispatch = !this.requested;
        this.requested = true;
        this.changed();
        void this.run(signal, dispatch).finally(() => {
            if (this.flight !== signal) return;
            this.flight = undefined;
            if (!signal.aborted) this.exhausted = true;
            this.changed();
        });
    }

    private async run(signal: AbortSignal, dispatch: boolean): Promise<void> {
        if (dispatch) {
            try { await this.dispatch(signal); }
            catch (error) {
                if (signal.aborted) return;
                if (error instanceof ApiError && error.failure.kind !== "network" && error.failure.kind !== "timeout") {
                    const status = error.status;
                    const poll = error.failure.kind === "invalid_response" || (status !== undefined && ((status >= 200 && status < 300) || status === 429 || (status >= 500 && status <= 599 && status !== 503)));
                    if (!poll) return;
                }
            }
        }
        const deadline = this.clock.now() + REFRESH_WINDOW_MS;
        let unchanged = 0;
        while (!signal.aborted && this.clock.now() < deadline) {
            try { await sleep(this.clock, POLL_INTERVAL_MS, signal, () => new ApiError({ kind: "aborted" })); }
            catch { return; }
            try {
                const person = await this.read(signal);
                if (signal.aborted) return;
                if (JSON.stringify(person) === JSON.stringify(this.current())) {
                    if (++unchanged >= SETTLED_POLLS) return;
                    continue;
                }
                unchanged = 0;
                this.changed(person);
                if (!incompleteMetadata(person)) return;
            } catch {
                // A failed poll leaves the mounted person usable until the next bounded read.
            }
        }
    }
}

export interface PersonOptions {
    readonly id: string;
    readonly title: string;
    readonly session: NativeSession;
    readonly clock?: Clock;
    readonly focus?: FocusReader;
    readonly foreground?: ForegroundRunner;
    readonly onChange?: (paint?: Paint) => void;
}

export interface PersonSnapshot {
    readonly id: string;
    readonly title: string;
    readonly person: Person | undefined;
    readonly heroLoading: boolean;
    readonly metadataFailure: string | undefined;
    readonly metadataError: ErrorState | undefined;
    readonly filter: MediaScope;
    readonly availableFilters: readonly MediaScope[];
    readonly page: CatalogPage | undefined;
    /** Stable identity key for `feedGrid`; rotates when a filter change or cursor reset starts a fresh list. */
    readonly feedKey: object;
    readonly busy: boolean;
    readonly slow: boolean;
    readonly failure: string | undefined;
    readonly error: ErrorState | undefined;
}

export interface PersonModule extends RouteEntry {
    readonly kind: "person";
    readonly id: string;
    readonly title: string;
    snapshot(): PersonSnapshot;
    setFilter(filter: MediaScope): void;
    loadMore(): void;
    retry(): void;
}

export function createPerson(options: PersonOptions): PersonModule {
    const { id, title, session } = options;
    const clock = options.clock ?? systemClock;
    const focusReader = options.focus ?? idleFocusReader;
    const foreground = options.foreground ?? createForegroundRunner(clock);

    let person: Person | undefined;
    let metadataLoading = false;
    let metadataFailure: string | undefined;
    let metadataError: ErrorState | undefined;
    let availabilityLoading = false;
    let availableFilters: MediaScope[] | undefined;
    let filter: MediaScope = "video";
    let filterGeneration = 0;

    let page: CatalogPage | undefined;
    let committedIndex = 0;
    let cursors: (string | undefined)[] = [undefined];
    let pendingIndex: number | undefined;
    let feedKey: object = {};

    let failure: string | undefined;
    let error: ErrorState | undefined;
    let slow = false;
    let stale = false;
    let active = false;
    let retired = false;
    let creditsSlot: ForegroundSlot | undefined;
    let appearance: AbortController | undefined;

    const notify = (paint?: Paint): void => {
        if (!retired && active) options.onChange?.(paint);
    };

    const refresh = new MetadataRefresh(
        clock,
        () => person,
        signal => session.call({ ...detailOperations.refreshPerson(id), profileScoped: true, replayAfterRefresh: false, signal }),
        signal => session.call({ ...detailOperations.person(id), profileScoped: true, signal }),
        updated => {
            if (updated !== undefined) person = updated;
            notify({ focus: focusReader.focused() });
        },
    );

    const ensureAppearance = (): AbortSignal => {
        if (appearance === undefined || appearance.signal.aborted) {
            appearance = new AbortController();
        }
        const signal = appearance.signal;
        refresh.start(signal);
        return signal;
    };

    const readMetadata = (signal: AbortSignal): void => {
        metadataLoading = true;
        void session.call({ ...detailOperations.person(id), profileScoped: true, signal }).then(found => {
            if (signal.aborted || retired) return;
            person = found;
            metadataFailure = undefined;
            metadataError = undefined;
            refresh.start(signal);
        }, (err: unknown) => {
            if (signal.aborted || retired) return;
            metadataFailure = failureText(err, { kind: "person" }) ?? "Could not load metadata. Try again.";
            metadataError = errorState(err);
        }).finally(() => {
            if (signal.aborted || retired) return;
            metadataLoading = false;
            notify();
        });
    };

    const probeAvailability = (signal: AbortSignal): void => {
        availabilityLoading = true;
        const probedGeneration = filterGeneration;
        void Promise.resolve().then(() => Promise.all((["movie", "series"] as const).map(async type => {
            try {
                const probe = await session.call({ ...operations.queryCatalogItems({ ...personQuery(id, type), limit: 1 }), profileScoped: true, signal });
                return probe.items.length > 0 || (probe.total ?? 0) > 0;
            } catch {
                return undefined;
            }
        }))).then(([movies, series]) => {
            // A filter chosen while these probes were out keeps its chip (PersonDetailView.swift refreshAvailableFilters).
            if (signal.aborted || retired || probedGeneration !== filterGeneration) return;
            availableFilters = ["video", ...(movies === false ? [] : ["movie" as const]), ...(series === false ? [] : ["series" as const])];
            availabilityLoading = false;
            notify();
        });
    };

    const loadCredits = (targetIndex: number, quiet: boolean): void => {
        pendingIndex = targetIndex;
        const appearanceSignal = ensureAppearance();
        if (person === undefined && !metadataLoading) readMetadata(appearanceSignal);
        if (availableFilters === undefined && !availabilityLoading) probeAvailability(appearanceSignal);

        const effectiveQuiet = quiet || page !== undefined;
        slow = false;
        const slot = foreground.begin({
            quiet: effectiveQuiet,
            onSlow: () => {
                if (creditsSlot === slot && active && !retired) {
                    slow = true;
                    notify();
                }
            },
        });
        creditsSlot = slot;

        void (async () => {
            const append = targetIndex > committedIndex;
            let items = append ? [...(page?.items ?? [])] : [];
            const nextCursors = append ? cursors.slice(0, targetIndex + 1) : [undefined];
            let fetched: CatalogPage | undefined;
            let finalIndex = targetIndex;

            for (let position = append ? targetIndex : 0; position <= targetIndex; position++) {
                let startsOver = false;
                try {
                    fetched = await session.call({ ...operations.queryCatalogItems(personQuery(id, filter, nextCursors[position])), profileScoped: true, signal: slot.signal });
                } catch (err) {
                    if (slot.signal.aborted || position === 0 || !(err instanceof ApiError) || err.problemId !== "invalid_cursor") throw err;
                    // Apple nextCatalogPage replaces the list with a fresh first page once.
                    fetched = await session.call({ ...operations.queryCatalogItems(personQuery(id, filter)), profileScoped: true, signal: slot.signal });
                    startsOver = true;
                    position = 0;
                    items = [];
                    nextCursors.splice(0, nextCursors.length, undefined);
                }
                if (slot.signal.aborted || !slot.active() || retired) return;
                if (fetched.nextCursor !== undefined && nextCursors.includes(fetched.nextCursor)) {
                    throw new ApiError({ kind: "invalid_response", path: "personFilmography.page.next_cursor" });
                }
                const seen = new Set(items.map(item => item.id));
                items.push(...fetched.items.filter(item => {
                    if (seen.has(item.id)) return false;
                    seen.add(item.id);
                    return true;
                }));
                nextCursors[position + 1] = fetched.nextCursor;
                finalIndex = position;
                if (startsOver || fetched.nextCursor === undefined) break;
            }

            if (!slot.active() || retired) return;
            slot.finish();
            creditsSlot = undefined;
            slow = false;
            failure = undefined;
            error = undefined;
            stale = false;

            if (fetched !== undefined) {
                const currentFocus = focusReader.focused();
                const oldIndex = page?.items.findIndex(item => item.id === currentFocus?.key) ?? -1;
                const merged: CatalogPage = { ...fetched, items };
                const nearby = targetIndex === committedIndex && currentFocus?.zone === "grid" && oldIndex >= 0 && !merged.items.some(item => item.id === currentFocus.key)
                    ? merged.items[Math.min(oldIndex, merged.items.length - 1)]
                    : undefined;
                page = merged;
                committedIndex = finalIndex;
                cursors = nextCursors.slice(0, finalIndex + 2);
                pendingIndex = undefined;
                if (nearby !== undefined) {
                    notify({ focus: { zone: "grid", key: nearby.id } });
                } else {
                    notify(!effectiveQuiet ? { focus: focusReader.focused() } : undefined);
                }
            }
        })().catch((err: unknown) => {
            if (slot.signal.aborted) {
                if (creditsSlot === slot) {
                    creditsSlot = undefined;
                    pendingIndex = undefined;
                }
                return;
            }
            if (!slot.active() || retired) return;
            slot.finish();
            creditsSlot = undefined;
            slow = false;
            pendingIndex = undefined;

            if (err instanceof ApiError && err.problemId === "invalid_cursor") {
                page = undefined;
                committedIndex = 0;
                cursors = [undefined];
                feedKey = {};
                module.focus = undefined;
            }
            const text = failureText(err, { kind: "person" });
            if (text === undefined) {
                clock.schedule(() => { throw err; }, 0);
            }
            // Apple PersonDetailView: a failed later page keeps the cards; a stale failure would make Back read every loaded page again.
            if ((page?.items.length ?? 0) > 0 && text !== undefined) {
                failure = undefined;
                error = undefined;
                notify({ focus: focusReader.focused() });
                return;
            }
            failure = text ?? "Something went wrong. Try again.";
            const state = errorState(err);
            const body = failureBody(err, { kind: "person" });
            error = body === undefined ? state : { ...state, route: body };
            notify();
        });
    };

    const stopAppearance = (): void => {
        appearance?.abort();
        appearance = undefined;
        metadataLoading = false;
        availabilityLoading = false;
    };

    const module: PersonModule = {
        kind: "person",
        id,
        title,
        focus: undefined,

        hasData() {
            return person !== undefined || page !== undefined;
        },

        markStale() {
            stale = true;
        },

        onSignal(signal: BrowseSignal) {
            if (signal.kind === "catalog.changed" || signal.kind === "playback.resumed" || (signal.kind === "title.notInterested" && signal.current !== module)) {
                stale = true;
            }
        },

        snapshot(): PersonSnapshot {
            return {
                id,
                title,
                person,
                heroLoading: metadataLoading || refresh.refreshing || person === undefined,
                metadataFailure,
                metadataError,
                filter,
                availableFilters: availableFilters ?? ALL_FILTERS,
                page,
                feedKey,
                busy: foreground.busy(),
                slow,
                failure,
                error,
            };
        },

        arrive(why: Arrival) {
            if (retired) return;
            active = true;
            if (why === "reveal" && page === undefined) {
                stale = true;
            }
            if (!module.hasData() || stale || failure !== undefined) {
                loadCredits(pendingIndex ?? committedIndex, module.hasData());
                return;
            }
            // Returning to a loaded filmography resumes only metadata refresh and aborted metadata/availability probes.
            const signal = ensureAppearance();
            if (person === undefined && !metadataLoading) readMetadata(signal);
            if (availableFilters === undefined && !availabilityLoading) probeAvailability(signal);
        },

        cover() {
            active = false;
            pendingIndex = undefined;
            stopAppearance();
            if (creditsSlot?.active()) {
                foreground.abort();
                creditsSlot = undefined;
            }
            slow = false;
        },

        retire() {
            retired = true;
            module.cover();
        },

        setFilter(nextFilter: MediaScope) {
            if (retired || filter === nextFilter) return;
            filterGeneration += 1;
            filter = nextFilter;
            page = undefined;
            committedIndex = 0;
            cursors = [undefined];
            pendingIndex = undefined;
            failure = undefined;
            error = undefined;
            feedKey = {};
            loadCredits(0, true);
            notify({ focus: { zone: "filters", key: `filter:${nextFilter}` } });
        },

        loadMore() {
            if (retired || !active || foreground.busy() || page?.nextCursor === undefined) return;
            loadCredits(committedIndex + 1, true);
            notify({ focus: focusReader.focused() });
        },

        retry() {
            if (retired) return;
            failure = undefined;
            error = undefined;
            metadataFailure = undefined;
            metadataError = undefined;
            notify();
            loadCredits(pendingIndex ?? committedIndex, false);
        },
    };

    return module;
}
