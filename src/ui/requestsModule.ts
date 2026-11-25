import { systemClock, type Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { requestOperations } from "../api/requestOperations.ts";
import type { MediaRequest, MyRequests, RequestPage as RequestSearchPage, RequestsCapability, RequestTitle, RequestsHub } from "../contracts/v2/requests.ts";
import { WireError } from "../contracts/v2/wire.ts";
import { translate } from "../i18n/translate.ts";
import type { NativeSession } from "../session/session.ts";
import { createForegroundRunner, idleFocusReader, type Arrival, type FocusReader, type ForegroundRunner, type ForegroundSlot, type Paint, type RouteEntry } from "./browseEnv.ts";
import type { FocusTarget } from "./browseFocus.ts";
import type { BrowseSignal } from "./browseSignals.ts";
import { errorState, failureBody, failureText, unconfirmedWriteMessage, writeFailureMessage, writeMayHaveApplied, type ErrorState, type RequestWrite } from "./errorState.ts";
import { orderRequests, requestProgress } from "./requestProgress.ts";

/** Apple MyRequestsViewModel clears a notice after three seconds. */
export const REQUEST_NOTICE_MS = 3000;

const REFUSAL_PROBLEMS = new Set(["capability_disabled", "capability_not_configured", "capability_unsupported", "permission_denied"]);

const removedNotice = (): string => translate("requests.notice.removed");
const unconfirmedRemoveMessage = (): string => translate("requests.notice.unconfirmedRemove");
const removeConflictMessage = (): string => translate("requests.notice.removeConflict");
const unconfirmedCancelMessage = (): string => translate("requests.notice.unconfirmedCancel");

function isRemovable(record: MediaRequest): boolean {
    return record.outcome === "failed" && !(record.targets ?? []).some(target => target.status === "completed");
}

function isCancelable(record: MediaRequest): boolean {
    return requestProgress(record)?.display === "pending";
}

function canAct(id: string, actingId: string | undefined, heldIds: readonly string[]): boolean {
    return actingId === undefined && !heldIds.includes(id);
}

function canCancel(record: MediaRequest, actingId: string | undefined, heldIds: readonly string[]): boolean {
    return isCancelable(record) && canAct(record.id, actingId, heldIds);
}

function canRemove(record: MediaRequest, removeFailedSupported: boolean, actingId: string | undefined, heldIds: readonly string[]): boolean {
    return removeFailedSupported && isRemovable(record) && canAct(record.id, actingId, heldIds);
}

function visibleMineRequests(records: readonly MediaRequest[], actingId: string | undefined, heldIds: readonly string[]): MediaRequest[] {
    const ordered = orderRequests(records);
    const keep = new Set<string>([...(actingId !== undefined ? [actingId] : []), ...heldIds]);
    if (keep.size === 0) return ordered;
    const seen = new Set(ordered.map(item => item.id));
    const missing = records.filter(item => keep.has(item.id) && !seen.has(item.id));
    return missing.length === 0 ? ordered : [...ordered, ...missing];
}

function neighborKey(keys: readonly string[], removed: string): string | undefined {
    const index = keys.indexOf(removed);
    const rest = keys.filter(key => key !== removed);
    if (rest.length === 0) return undefined;
    if (index < 0) return rest[0];
    return rest[Math.min(index, rest.length - 1)];
}

function browsable(mediaType: string): boolean {
    return mediaType === "movie" || mediaType === "series";
}

function focusAfterRemoval(data: RequestsHub | MyRequests, removedId: string): FocusTarget {
    if ("sections" in data) {
        const before = orderRequests(data.mine.items).map(item => item.id);
        const next = neighborKey(before, removedId);
        if (next !== undefined) return { zone: "mine", key: next };
        for (const section of data.sections) {
            const title = section.results.find(item => browsable(item.mediaType));
            if (title !== undefined) return { zone: `row:${section.key}`, key: `${title.mediaType}:${title.tmdbId}` };
        }
        return { zone: "page", key: "requests-page" };
    }
    const next = neighborKey(data.items.map(item => item.id), removedId);
    return next === undefined ? { zone: "actions", key: "refresh" } : { zone: "mine", key: next };
}

/** The one list action Apple's MyRequestsViewModel runs at a time, plus holds and tombstones. */
class ActionGate {
    actingId: string | undefined;
    notice: string | undefined;
    private unconfirmed: "remove" | "cancel" | undefined;
    private message: string | undefined;
    readonly held = new Map<string, number>();
    readonly removed = new Set<string>();
    epoch = 0;
    private token = 0;
    private actingToken = 0;
    private holdSerial = 0;

    get listMessage(): string | undefined {
        return this.unconfirmed === undefined ? this.message : this.unconfirmed === "remove" ? unconfirmedRemoveMessage() : unconfirmedCancelMessage();
    }

    set listMessage(text: string | undefined) {
        this.unconfirmed = undefined;
        this.message = text;
    }

    holdMessage(kind: "remove" | "cancel"): void {
        this.message = undefined;
        this.unconfirmed = kind;
    }

    heldIds(): readonly string[] {
        return [...this.held.keys()];
    }

    begin(id: string): number | undefined {
        if (!canAct(id, this.actingId, this.heldIds())) return undefined;
        this.token += 1;
        this.actingToken = this.token;
        this.actingId = id;
        this.listMessage = undefined;
        this.notice = undefined;
        return this.token;
    }

    release(token: number): void {
        if (this.actingToken === token) this.actingId = undefined;
    }

    hold(id: string): number {
        this.holdSerial += 1;
        this.held.set(id, this.holdSerial);
        return this.holdSerial;
    }

    cover(): number {
        return this.holdSerial;
    }

    releaseHolds(through: number): void {
        for (const [id, serial] of this.held) if (serial <= through) this.held.delete(id);
        this.clearListMessageIfIdle();
    }

    releaseHold(id: string): void {
        this.held.delete(id);
        this.clearListMessageIfIdle();
    }

    drop(id: string): void {
        this.removed.add(id);
        this.epoch += 1;
    }

    private clearListMessageIfIdle(): void {
        if (this.held.size === 0 && this.unconfirmed !== undefined) this.listMessage = undefined;
    }

    filter<T extends { readonly id: string }>(items: readonly T[]): T[] {
        return items.filter(item => !this.removed.has(item.id));
    }
}

export type RequestsSource =
    | { readonly kind: "hub" }
    | { readonly kind: "search"; query: string; page: number }
    | { readonly kind: "mine"; cursor: string | undefined }
    | { readonly kind: "media"; title: RequestTitle }
    | { readonly kind: "request"; id: string };

export interface RecordActions {
    readonly cancel: boolean;
    readonly remove: boolean;
}

export interface RequestPageSnapshot {
    readonly source: RequestsSource;
    readonly data: RequestsHub | RequestSearchPage | MyRequests | RequestTitle | MediaRequest | undefined;
    readonly visibleMine: readonly MediaRequest[];
    readonly detail: RequestTitle | undefined;
    readonly detailFailed: boolean;
    readonly capability: RequestsCapability;
    readonly profileId: string;
    readonly busy: boolean;
    readonly writing: boolean;
    readonly uncertain: boolean;
    readonly action: RequestWrite | undefined;
    readonly unconfirmed: boolean;
    readonly actionMessage: string | undefined;
    readonly actingId: string | undefined;
    readonly heldIds: readonly string[];
    readonly notice: string | undefined;
    readonly listMessage: string | undefined;
    readonly slow: boolean;
    readonly failure: string | undefined;
    readonly error: ErrorState | undefined;
}

export interface RequestPage extends RouteEntry {
    readonly kind: "requests";
    readonly root: boolean;
    readonly source: RequestsSource;
    admissible(): boolean;
    snapshot(): RequestPageSnapshot;
    rowActions(record: MediaRequest): RecordActions;
    retry(): void;
    editSearch(query: string): void;
    submitSearch(): void;
    nextPage(value: number | string): void;
    write(action: RequestWrite): void;
    beginMenu(record: MediaRequest): RecordActions | undefined;
    cancelRecord(record: MediaRequest, origin: FocusTarget): Promise<void>;
    removeRecord(record: MediaRequest, origin: FocusTarget): Promise<void>;
}

export interface RequestsOptions {
    readonly session: NativeSession;
    readonly clock?: Clock;
    readonly focus?: FocusReader;
    readonly foreground?: ForegroundRunner;
    readonly isPaintBlocked?: () => boolean;
    readonly onEnsurePresentation?: () => void;
    readonly onCapabilityChange?: (capability: RequestsCapability, options: { readonly refreshSearch: boolean; readonly fromProbe: boolean }) => void;
    readonly onStale?: () => void;
    readonly onChange?: (page: RequestPage, paint?: Paint) => void;
}

export interface RequestsModule {
    readonly capability: RequestsCapability;
    probe(options?: { readonly refreshSearch?: boolean }): Promise<RequestsCapability>;
    open(source: RequestsSource): RequestPage;
    setVisible(page: RequestPage | undefined): void;
    dispose(): void;
}

interface PageInternal {
    source: RequestsSource;
    data: RequestsHub | RequestSearchPage | MyRequests | RequestTitle | MediaRequest | undefined;
    detail: RequestTitle | undefined;
    detailFailed: boolean;
    writing: boolean;
    uncertain: boolean;
    action: RequestWrite | undefined;
    unconfirmed: boolean;
    actionMessage: string | undefined;
    slow: boolean;
    failure: string | undefined;
    error: ErrorState | undefined;
    stale: boolean;
    retired: boolean;
    slot: ForegroundSlot | undefined;
    handle: RequestPage;
    load(quiet: boolean): void;
}

const once = <T>(spec: RequestSpec<T>): RequestSpec<T> => ({ ...spec, retry: "never" });
const isRefusal = (error: unknown): boolean => error instanceof ApiError && REFUSAL_PROBLEMS.has(error.problemId ?? "");

export function createRequests(options: RequestsOptions): RequestsModule {
    const { session } = options;
    const clock = options.clock ?? systemClock;
    const focusReader = options.focus ?? idleFocusReader;
    const foreground = options.foreground ?? createForegroundRunner(clock);
    const paintBlocked = options.isPaintBlocked ?? (() => false);

    let capability: RequestsCapability = { enabled: false, follow: false, removeFailed: false };
    let probeOrdinal = 0;
    let writePending = false;
    let rereadGeneration = 0;
    let disposed = false;
    let clearNoticeTimer: () => void = () => undefined;
    const lifecycle = new AbortController();
    const gate = new ActionGate();
    const livePages = new Set<PageInternal>();
    let visiblePage: PageInternal | undefined;

    const read = <T>(spec: RequestSpec<T>, signal: AbortSignal): Promise<T> =>
        session.call({ ...spec, profileScoped: true, signal });

    const readMyRequests = async (signal: AbortSignal): Promise<MyRequests> => {
        const maxPages = 100;
        const pageSize = 50;
        const items: MediaRequest[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
            signal.throwIfAborted();
            const page = await read(once(requestOperations.mine(cursor, pageSize)), signal);
            signal.throwIfAborted();
            items.push(...page.items);
            if (page.cursor === undefined) return { items, cursor: undefined };
            if (cursors.has(page.cursor)) throw new WireError("requests.mine.page.next_cursor", "an advancing cursor");
            cursors.add(page.cursor);
            cursor = page.cursor;
        }
        throw new WireError("requests.mine.page", `a list of at most ${maxPages} pages`);
    };

    const notify = (page: PageInternal, paint?: Paint): void => {
        if (disposed || page.retired || visiblePage !== page || paintBlocked()) return;
        options.onChange?.(page.handle, paint);
    };

    const dismissNotice = (): void => {
        clearNoticeTimer();
        clearNoticeTimer = () => undefined;
        gate.notice = undefined;
    };

    const publishNotice = (text: string): void => {
        clearNoticeTimer();
        gate.notice = text;
        clearNoticeTimer = clock.schedule(() => {
            clearNoticeTimer = () => undefined;
            if (gate.notice !== text || disposed) return;
            gate.notice = undefined;
            if (visiblePage !== undefined && !paintBlocked()) {
                notify(visiblePage, { focus: focusReader.focused() });
            }
        }, REQUEST_NOTICE_MS);
    };

    const acceptCapability = (next: RequestsCapability, refreshSearch: boolean, fromProbe: boolean): void => {
        capability = next;
        options.onCapabilityChange?.(next, { refreshSearch, fromProbe });
    };

    const probe = async (probeOptions?: { readonly refreshSearch?: boolean }): Promise<RequestsCapability> => {
        const refreshSearch = probeOptions?.refreshSearch ?? true;
        const ordinal = ++probeOrdinal;
        try {
            const next = await read(requestOperations.status(), lifecycle.signal);
            if (disposed || ordinal !== probeOrdinal) return capability;
            acceptCapability(next, refreshSearch, true);
            return next;
        } catch {
            // A transient probe failure keeps the last confirmed capability.
            return capability;
        }
    };

    const focusSurvives = (page: PageInternal, target: FocusTarget | undefined): boolean => {
        if (target === undefined) return false;
        const data = page.data;
        const held = gate.heldIds();
        if (data !== undefined && "sections" in data) {
            if (visibleMineRequests(data.mine.items, gate.actingId, held).some(item => item.id === target.key)) return true;
            return data.sections.some(section => section.results.some(item => `${item.mediaType}:${item.tmdbId}` === target.key));
        }
        if (data !== undefined && "items" in data && page.source.kind === "mine") {
            return visibleMineRequests(data.items, gate.actingId, held).some(item => item.id === target.key);
        }
        return true;
    };

    const showList = (page: PageInternal, focus: FocusTarget, revision: number): void => {
        const moved = focusReader.inputRevision() !== revision ? focusReader.focused() : undefined;
        // Keep moved focus only when that target still exists after cancel/remove paint; otherwise use the captured neighbor.
        const next = moved !== undefined && focusSurvives(page, moved) ? moved : focus;
        page.handle.focus = next;
        if (visiblePage !== page || paintBlocked()) return;
        notify(page, { focus: next });
    };

    const listFocusAfter = (page: PageInternal, id: string, fallback: FocusTarget): FocusTarget => {
        const data = page.data;
        if (data !== undefined && ("sections" in data || (page.source.kind === "mine" && "items" in data))) {
            return focusAfterRemoval(data, id);
        }
        return fallback;
    };

    const visibleOrOrigin = (origin: PageInternal): PageInternal => visiblePage ?? origin;

    const showVisibleList = (origin: PageInternal, focus: FocusTarget, revision: number): PageInternal => {
        const target = visibleOrOrigin(origin);
        showList(target, target === origin ? focus : (target.handle.focus ?? focus), revision);
        return target;
    };

    const rereadList = async (page: PageInternal): Promise<boolean> => {
        const source = page.source;
        if (source.kind !== "hub" && source.kind !== "mine") return false;
        const generation = ++rereadGeneration;
        const startedEpoch = gate.epoch;
        const covered = gate.cover();
        const isCurrent = (): boolean => !disposed && generation === rereadGeneration && startedEpoch === gate.epoch;
        try {
            if (source.kind === "hub") {
                const [sections, mine] = await Promise.all([
                    read(once(requestOperations.discover()), lifecycle.signal),
                    readMyRequests(lifecycle.signal),
                ]);
                if (!isCurrent()) return false;
                page.data = { sections, mine: { ...mine, items: gate.filter(mine.items) } };
            } else {
                const fetched = await read(requestOperations.mine(source.cursor), lifecycle.signal);
                if (!isCurrent()) return false;
                page.data = { ...fetched, items: gate.filter(fetched.items) };
            }
            page.failure = undefined;
            page.error = undefined;
            gate.releaseHolds(covered);
            return true;
        } catch (err) {
            if (!isCurrent() || (err instanceof ApiError && err.aborted)) return false;
            if (isRefusal(err)) void probe();
            return false;
        }
    };

    const dropRemoved = (id: string): void => {
        gate.drop(id);
        for (const page of livePages) {
            const data = page.data;
            if (data !== undefined && "sections" in data) {
                page.data = { ...data, mine: { ...data.mine, items: gate.filter(data.mine.items) } };
            } else if (data !== undefined && "items" in data && page.source.kind === "mine") {
                page.data = { ...data, items: gate.filter(data.items) };
            }
            if (page !== visiblePage) page.stale = true;
        }
    };

    const paintRecord = (updated: MediaRequest): void => {
        for (const page of livePages) {
            const data = page.data;
            if (data !== undefined && "sections" in data) {
                page.data = { ...data, mine: { ...data.mine, items: data.mine.items.map(item => item.id === updated.id ? updated : item) } };
            } else if (data !== undefined && "items" in data && page.source.kind === "mine") {
                page.data = { ...data, items: data.items.map(item => item.id === updated.id ? updated : item) };
            }
        }
    };

    const settleVisible = async (origin: PageInternal, focus: FocusTarget, revision: number): Promise<void> => {
        const target = showVisibleList(origin, focus, revision);
        const kind = target.source.kind;
        if (kind === "hub" || kind === "mine") {
            await rereadList(target);
            showVisibleList(origin, focus, revision);
            return;
        }
        if (visiblePage !== target || disposed) return;
        target.uncertain = true;
        target.load(true);
    };

    const finishRemoval = async (page: PageInternal, id: string, fallback: FocusTarget, revision: number): Promise<void> => {
        // Neighbor focus must be taken from the pre-removal list.
        const focus = listFocusAfter(page, id, fallback);
        dropRemoved(id);
        publishNotice(removedNotice());
        await settleVisible(page, focus, revision);
    };

    const runListRemove = async (page: PageInternal, record: MediaRequest, origin: FocusTarget): Promise<void> => {
        if (writePending || disposed) return;
        dismissNotice();
        const token = gate.begin(record.id);
        if (token === undefined) return;
        const revision = focusReader.inputRevision();
        showVisibleList(page, origin, revision);
        try {
            await session.call({ ...requestOperations.remove(record.id), profileScoped: true, replayAfterRefresh: false });
            await finishRemoval(page, record.id, origin, revision);
        } catch (err) {
            if (disposed) return;
            if (err instanceof ApiError && err.problemId === "not_found") {
                await finishRemoval(page, record.id, origin, revision);
                return;
            }
            if (writeMayHaveApplied(err)) {
                gate.hold(record.id);
                gate.release(token);
                const focus = listFocusAfter(visibleOrOrigin(page), record.id, origin);
                if (!(err instanceof ApiError && err.aborted)) await settleVisible(page, focus, revision);
                if (gate.held.has(record.id)) gate.holdMessage("remove");
                showVisibleList(page, focus, revision);
                return;
            }
            const message = err instanceof ApiError && err.problemId === "conflict" ? removeConflictMessage() : writeFailureMessage(err);
            if (isRefusal(err)) void probe();
            await settleVisible(page, origin, revision);
            gate.listMessage = message;
            showVisibleList(page, origin, revision);
        } finally {
            gate.release(token);
            if (!disposed) showVisibleList(page, page.handle.focus ?? origin, revision);
        }
    };

    const runListCancel = async (page: PageInternal, record: MediaRequest, origin: FocusTarget): Promise<void> => {
        if (writePending || disposed) return;
        dismissNotice();
        const token = gate.begin(record.id);
        if (token === undefined) return;
        const revision = focusReader.inputRevision();
        showVisibleList(page, origin, revision);
        try {
            const updated: unknown = await session.call({ ...requestOperations.cancel(record.id), profileScoped: true, replayAfterRefresh: false });
            const listed = visibleOrOrigin(page);
            const focus = listFocusAfter(listed, record.id, origin);
            // Tombstone + epoch so an ordinary hub/mine load started before this cancel cannot put the pending row back.
            gate.drop(record.id);
            if (typeof updated === "object" && updated !== null && "id" in updated && "outcome" in updated) {
                paintRecord(updated as MediaRequest);
            }
            // Apple's hub applies the cancel result in place and does not reload (RequestsHubViewModel.applyRequestUpdate).
            const kind = listed.source.kind;
            if (kind === "hub" || kind === "mine") showList(listed, focus, revision);
            else await settleVisible(page, focus, revision);
        } catch (err) {
            if (disposed) return;
            if (writeMayHaveApplied(err)) {
                gate.hold(record.id);
                gate.release(token);
                const focus = listFocusAfter(visibleOrOrigin(page), record.id, origin);
                if (!(err instanceof ApiError && err.aborted)) await settleVisible(page, focus, revision);
                if (gate.held.has(record.id)) gate.holdMessage("cancel");
                showVisibleList(page, focus, revision);
                return;
            }
            if (isRefusal(err)) void probe();
            gate.listMessage = writeFailureMessage(err);
            showVisibleList(page, origin, revision);
        } finally {
            gate.release(token);
            if (!disposed) showVisibleList(page, page.handle.focus ?? origin, revision);
        }
    };

    const open = (initialSource: RequestsSource): RequestPage => {
        const internal: PageInternal = {
            source: initialSource,
            data: undefined,
            detail: undefined,
            detailFailed: false,
            writing: false,
            uncertain: false,
            action: undefined,
            unconfirmed: false,
            actionMessage: undefined,
            slow: false,
            failure: undefined,
            error: undefined,
            stale: false,
            retired: false,
            slot: undefined,
            handle: undefined as unknown as RequestPage,
            load(quiet: boolean) {
                if (disposed || internal.retired) return;
                options.onEnsurePresentation?.();
                const source = internal.source;
                const capabilityOrdinal = ++probeOrdinal;
                const entryRevision = focusReader.inputRevision();
                const enterResults = !quiet && internal.data === undefined && source.kind !== "search";
                internal.slow = false;
                const slot = foreground.begin({
                    quiet,
                    onSlow: () => {
                        if (internal.slot === slot && visiblePage === internal && !disposed) {
                            internal.slow = true;
                            notify(internal);
                        }
                    },
                });
                internal.slot = slot;

                void (async () => {
                    const startedEpoch = gate.epoch;
                    const coveredHolds = gate.cover();
                    const cap = await read(source.kind === "hub" ? once(requestOperations.status()) : requestOperations.status(), slot.signal);
                    if (!cap.enabled) return { capability: cap, data: undefined, detail: undefined, detailFailed: false, startedEpoch, coveredHolds };
                    const hub = source.kind === "hub"
                        ? await Promise.allSettled([read(once(requestOperations.discover()), slot.signal), readMyRequests(slot.signal)])
                        : undefined;
                    for (const result of hub ?? []) {
                        if (result.status === "rejected" && isRefusal(result.reason)) throw result.reason;
                    }
                    // Apple's hub reads both together: either failing fails the load (RequestsHubViewModel.load).
                    const answered = <T>(result: PromiseSettledResult<T>): T => {
                        if (result.status === "rejected") throw result.reason;
                        return result.value;
                    };
                    const data = hub !== undefined ? { sections: answered(hub[0]), mine: answered(hub[1]) }
                        : source.kind === "mine" ? await read(requestOperations.mine(source.cursor), slot.signal)
                        : source.kind === "media" ? await read(requestOperations.detail(source.title), slot.signal)
                        : source.kind === "request" ? await read(requestOperations.request(source.id), slot.signal)
                        : source.kind !== "search" || source.query.trim() === "" ? undefined
                        : await read(requestOperations.search(source.query.trim(), source.page), slot.signal);
                    let detail: RequestTitle | undefined;
                    let detailFailed = false;
                    if (source.kind === "request" && data !== undefined && "tmdbId" in data) {
                        try { detail = await read(requestOperations.detail(data), slot.signal); }
                        catch (err) { if (isRefusal(err)) throw err; detailFailed = true; }
                    }
                    return { capability: cap, data, detail, detailFailed, startedEpoch, coveredHolds };
                })().then(result => {
                    if (!slot.active() || disposed || internal.retired) return;
                    slot.finish();
                    internal.slot = undefined;
                    internal.slow = false;
                    internal.failure = undefined;
                    internal.error = undefined;
                    internal.stale = false;
                    if (capabilityOrdinal === probeOrdinal) {
                        acceptCapability(result.capability, false, false);
                    }
                    if (!capability.enabled) return;
                    let data: PageInternal["data"] = result.data;
                    // Apple's hub leaves a removed or cancelled request out of every answer. A My Requests read started before the tombstone does not put it back.
                    if (data !== undefined && "sections" in data) {
                        data = { ...data, mine: { ...data.mine, items: gate.filter(data.mine.items) } };
                    } else if (source.kind === "mine" && data !== undefined && "items" in data) {
                        data = result.startedEpoch === gate.epoch ? { ...data, items: gate.filter(data.items) } : internal.data;
                    }
                    if ((source.kind === "hub" || source.kind === "mine") && result.startedEpoch === gate.epoch) {
                        gate.releaseHolds(result.coveredHolds);
                    }
                    // A successful request detail read settles that row's uncertain cancel hold without clearing unrelated holds.
                    if (source.kind === "request" && data !== undefined && "id" in data) {
                        gate.releaseHold(data.id);
                    }
                    internal.data = data;
                    internal.detail = result.detail;
                    internal.detailFailed = result.detailFailed;
                    internal.uncertain = false;
                    // The server's answer now decides the action (RequestDetailViewModel.swift:250).
                    if (!internal.writing) {
                        internal.action = undefined;
                        if (internal.unconfirmed) internal.actionMessage = undefined;
                        internal.unconfirmed = false;
                    }
                    const enterContent = enterResults && focusReader.inputRevision() === entryRevision;
                    const nextFocus = focusReader.inputRevision() === entryRevision ? internal.handle.focus : focusReader.focused();
                    notify(internal, enterContent ? { focus: nextFocus, enter: true } : { focus: nextFocus });
                }, (err: unknown) => {
                    if (slot.signal.aborted) {
                        if (internal.slot === slot) internal.slot = undefined;
                        return;
                    }
                    if (!slot.active() || disposed || internal.retired) return;
                    slot.finish();
                    internal.slot = undefined;
                    internal.slow = false;
                    const text = failureText(err, { kind: "requests" });
                    if (text === undefined) {
                        clock.schedule(() => { throw err; }, 0);
                    }
                    internal.failure = text ?? "Something went wrong. Try again.";
                    const state = errorState(err);
                    const body = failureBody(err, { kind: "requests" });
                    internal.error = body === undefined ? state : { ...state, route: body };
                    if (!internal.unconfirmed && !internal.writing) internal.action = undefined;
                    if (isRefusal(err)) void probe();
                    notify(internal);
                });

                notify(internal, { focus: internal.handle.focus });
            },
        };

        const rowActions = (record: MediaRequest): RecordActions => {
            const held = gate.heldIds();
            return {
                cancel: canCancel(record, gate.actingId, held),
                remove: canRemove(record, capability.removeFailed, gate.actingId, held),
            };
        };

        const handle: RequestPage = {
            kind: "requests",
            root: initialSource.kind === "hub",
            get source() { return internal.source; },
            focus: undefined,

            hasData() {
                return internal.data !== undefined;
            },

            admissible() {
                return capability.enabled;
            },

            markStale() {
                internal.stale = true;
            },

            onSignal(signal: BrowseSignal) {
                if (signal.kind === "requests.changed" || signal.kind === "catalog.changed" || signal.kind === "playback.resumed" || (signal.kind === "title.notInterested" && signal.current !== handle)) {
                    internal.stale = true;
                }
            },

            snapshot(): RequestPageSnapshot {
                const held = gate.heldIds();
                const rawMine = internal.data === undefined
                    ? []
                    : "sections" in internal.data
                        ? internal.data.mine.items
                        : "items" in internal.data
                            ? internal.data.items
                            : [];
                return {
                    source: internal.source,
                    data: internal.data,
                    visibleMine: visibleMineRequests(rawMine, gate.actingId, held),
                    detail: internal.detail,
                    detailFailed: internal.detailFailed,
                    capability,
                    profileId: session.activeProfile?.id ?? "",
                    busy: foreground.busy() || writePending || gate.actingId !== undefined,
                    writing: internal.writing,
                    uncertain: internal.uncertain,
                    action: internal.action,
                    unconfirmed: internal.unconfirmed,
                    actionMessage: internal.actionMessage,
                    actingId: gate.actingId,
                    heldIds: held,
                    notice: gate.notice,
                    listMessage: gate.listMessage,
                    slow: internal.slow,
                    failure: internal.failure,
                    error: internal.error,
                };
            },

            rowActions,

            arrive(why: Arrival) {
                if (disposed || internal.retired) return;
                visiblePage = internal;
                if (why === "reveal") internal.stale = true;
                if (!handle.hasData() || internal.stale || internal.failure !== undefined) {
                    internal.load(handle.hasData());
                }
            },

            cover() {
                if (visiblePage === internal) visiblePage = undefined;
                if (internal.slot?.active()) {
                    foreground.abort();
                    internal.slot = undefined;
                }
                internal.slow = false;
            },

            retire() {
                internal.retired = true;
                handle.cover();
                livePages.delete(internal);
            },

            retry() {
                if (disposed || internal.retired) return;
                handle.focus = focusReader.focused();
                // The hub's Try Again only exists with no rows, and Apple's retry returns to the loading page.
                if (internal.source.kind === "hub") internal.data = undefined;
                internal.failure = undefined;
                internal.error = undefined;
                notify(internal);
                internal.load(false);
            },

            editSearch(query: string) {
                if (disposed || internal.retired || visiblePage !== internal || internal.source.kind !== "search") return;
                internal.source.query = query;
                foreground.abort();
                internal.slot = undefined;
                internal.data = undefined;
                internal.failure = undefined;
                internal.error = undefined;
                notify(internal, { focus: { zone: "search", key: "query" } });
            },

            submitSearch() {
                if (disposed || internal.retired || visiblePage !== internal || internal.source.kind !== "search") return;
                internal.source.page = 1;
                internal.data = undefined;
                internal.failure = undefined;
                internal.error = undefined;
                handle.focus = { zone: "search", key: "query" };
                notify(internal);
                internal.load(false);
            },

            nextPage(value: number | string) {
                if (disposed || internal.retired) return;
                const source = internal.source;
                if (source.kind === "mine" && typeof value === "string") source.cursor = value;
                else if (source.kind === "search" && typeof value === "number") source.page = value;
                else return;
                internal.data = undefined;
                internal.failure = undefined;
                internal.error = undefined;
                handle.focus = undefined;
                notify(internal);
                internal.load(false);
            },

            beginMenu(record: MediaRequest): RecordActions | undefined {
                if (disposed || internal.retired || visiblePage !== internal || paintBlocked() || writePending || gate.actingId !== undefined) return undefined;
                const actions = rowActions(record);
                if (!actions.cancel && !actions.remove) return undefined;
                foreground.abort();
                internal.slot = undefined;
                return actions;
            },

            cancelRecord(record: MediaRequest, origin: FocusTarget): Promise<void> {
                return runListCancel(internal, record, origin);
            },

            removeRecord(record: MediaRequest, origin: FocusTarget): Promise<void> {
                return runListRemove(internal, record, origin);
            },

            write(action: RequestWrite) {
                const data = internal.data;
                if (disposed || internal.retired || visiblePage !== internal || writePending || gate.actingId !== undefined || internal.writing || internal.uncertain || foreground.busy() || data === undefined || !capability.enabled) return;
                const title = "request" in data ? data : internal.detail;
                const spec = action === "cancel" && "id" in data ? requestOperations.cancel(data.id)
                    : title === undefined || action === "cancel" ? undefined
                    : action === "create" ? requestOperations.create(title)
                    : requestOperations.follow(title, action === "follow");
                if (spec === undefined) return;
                // Claim the list gate for Cancel so a hub menu cannot start a second POST for the same request.
                const cancelId = action === "cancel" && "id" in data ? data.id : undefined;
                const gateToken = cancelId !== undefined ? gate.begin(cancelId) : undefined;
                if (cancelId !== undefined && gateToken === undefined) return;
                // The ended record is no longer the page's subject: a new request belongs to the title.
                const followTitle = (): void => {
                    if (action === "create" && title !== undefined && internal.source.kind === "request") {
                        internal.source = { kind: "media", title };
                    }
                };
                const releaseGate = (): void => { if (gateToken !== undefined) gate.release(gateToken); };
                writePending = true;
                internal.writing = true;
                internal.uncertain = true;
                internal.action = action;
                internal.unconfirmed = false;
                internal.actionMessage = undefined;
                internal.failure = undefined;
                internal.error = undefined;
                notify(internal, { focus: focusReader.focused() });
                handle.focus = focusReader.focused();
                const writeRevision = focusReader.inputRevision();
                const keepMovedFocus = (target: PageInternal): void => {
                    if (focusReader.inputRevision() !== writeRevision) {
                        target.handle.focus = focusReader.focused() ?? target.handle.focus;
                    }
                };
                // A write belongs to session Authority, not route lifetime. Leaving never replays it.
                session.call({ ...spec, profileScoped: true, replayAfterRefresh: false }).then(() => {
                    writePending = false;
                    internal.writing = false;
                    releaseGate();
                    if (disposed) return;
                    followTitle();
                    for (const page of livePages) page.stale = true;
                    options.onStale?.();
                    if (visiblePage !== undefined) {
                        keepMovedFocus(visiblePage);
                        visiblePage.uncertain = true;
                        visiblePage.load(true);
                    }
                }, (err: unknown) => {
                    writePending = false;
                    internal.writing = false;
                    if (disposed) { releaseGate(); return; }
                    const unconfirmed = writeMayHaveApplied(err);
                    // Match list cancel: an uncertain Cancel stays held until a successful list/detail read settles it.
                    if (unconfirmed && cancelId !== undefined) {
                        gate.hold(cancelId);
                        releaseGate();
                        if (gate.held.has(cancelId)) gate.holdMessage("cancel");
                    } else {
                        releaseGate();
                    }
                    if (unconfirmed) followTitle();
                    internal.uncertain = unconfirmed;
                    internal.unconfirmed = unconfirmed;
                    internal.actionMessage = unconfirmed ? unconfirmedWriteMessage(action) : writeFailureMessage(err);
                    if (!unconfirmed) internal.action = undefined;
                    for (const page of livePages) page.stale = true;
                    options.onStale?.();
                    if (isRefusal(err)) void probe();
                    const visible = visiblePage;
                    if (visible !== undefined) keepMovedFocus(visible);
                    if (visible === internal) {
                        // Apple reads back an unconfirmed write, unless the answer was lost to a change of owner.
                        if (unconfirmed && !(err instanceof ApiError && err.aborted)) internal.load(true);
                        notify(internal, { focus: handle.focus });
                    } else if (visible !== undefined) {
                        visible.uncertain = true;
                        visible.load(true);
                    }
                });
            },
        };

        internal.handle = handle;
        livePages.add(internal);
        return handle;
    };

    return {
        get capability() { return capability; },
        probe,
        open,
        setVisible(page: RequestPage | undefined) {
            visiblePage = page === undefined ? undefined : [...livePages].find(entry => entry.handle === page);
        },
        dispose() {
            disposed = true;
            lifecycle.abort();
            dismissNotice();
            for (const page of [...livePages]) page.handle.retire();
            livePages.clear();
            visiblePage = undefined;
        },
    };
}
