import type { MediaRequest, RequestsCapability, RequestTitle } from "../contracts/v2/requests.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, FAILURE_ICON, lines, recoveryActions, searchState, zoneNode } from "./browseViews.ts";
import { requestPosterUrl } from "./browseModel.ts";
import { detailsLoadingView } from "./detailsLoading.ts";
import { el } from "./screen.ts";
import { requestProgress, type RequestProgress } from "./requestProgress.ts";
import { requestFollowTarget, type RequestPage, type RequestPageSnapshot, type RequestsSource } from "./requestsModule.ts";
import { cullToRailBounds, requestActionSpinner, requestBellIcon, requestBellSlashIcon, requestHero, requestPlusIcon, requestPosterBadge, requestsLoadingPage, requestStatusLabel, requestXmarkIcon, TRAY_ICON } from "./requestsScene.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";
import { errorHeadline, errorMessage, failureState, type RequestWrite } from "./errorState.ts";

export type { RequestWrite, RequestsSource };

export interface RequestsViewNav {
    readonly baseUrl: string;
    readonly back: () => void;
    readonly signIn: (() => void) | undefined;
    readonly open: (source: RequestsSource) => void;
    readonly openCatalog: (id: string, title: string) => void;
    /** Apple's card context menu. Hub and My Requests records only. */
    readonly menu?: (record: MediaRequest) => void;
}

const previews = new WeakMap<RequestPage, RequestTitle | MediaRequest>();
const searchHeads = new WeakMap<RequestPage, { readonly head: readonly HTMLElement[]; readonly items: readonly FocusItem[] }>();

export function requestCard(title: RequestTitle | MediaRequest, baseUrl: string, open: () => void, preview?: (title: RequestTitle | MediaRequest) => void): FocusItem {
    const key = "id" in title ? title.id : `${title.mediaType}:${title.tmdbId}`;
    const progress = requestProgress(title), label = `${title.title} · ${progress?.short ?? "Not requested"}`;
    const item = actionButton(key, label, open);
    item.element.className = "browse-card requests-card";
    item.element.setAttribute("aria-label", label);
    const art = artwork("browse-art", requestPosterUrl(title.posterPath), baseUrl, title.title);
    if ("request" in title && progress !== undefined) { const badge = requestPosterBadge(progress); if (badge !== undefined) art.appendChild(badge); }
    const subtitle = el("span", "browse-card-subtitle");
    if (!("request" in title) && progress !== undefined) subtitle.appendChild(requestStatusLabel(progress));
    else subtitle.textContent = title.year === undefined ? "" : integerText(title.year);
    item.element.replaceChildren(art, el("span", "browse-card-title", title.title), subtitle);
    if (preview !== undefined) item.element.addEventListener("focus", () => preview(title));
    return item;
}

const browsable = (title: RequestTitle): boolean => title.mediaType === "movie" || title.mediaType === "series";

/** Apple RequestDetailViewModel.canFollow: notify toggle only applies to another viewer's pending or in-flight request. */
export function canFollowRequest(capability: RequestsCapability, title: RequestTitle, progress: RequestProgress | undefined): boolean {
    return capability.follow
        && title.request.reason === "already_requested"
        && title.request.requestedByViewer === false
        && (progress?.display === "pending" || progress?.display === "onTheWay");
}

/** Apple TVPageFocusOwner: an inert page holds focus with no highlight, so the remote always has a target. */
function pageOwner(page: HTMLElement, label: string): FocusItem {
    page.tabIndex = -1;
    page.setAttribute("role", "status");
    page.setAttribute("aria-label", label);
    page.setAttribute("data-focus", "requests-page");
    return { key: "requests-page", element: page };
}

/** Apple ErrorView.recoveryPlan: a 401 offers sign-in, a 403 or 404 prefers leaving when there is somewhere to go, and otherwise leaving is the remote's Back. */
function errorPlaceholder(state: RequestPageSnapshot, page: RequestPage, nav: RequestsViewNav, name: string, goBack?: () => void): View {
    const error = state.error ?? failureState(state.failure ?? "");
    const node = searchState(errorHeadline(error), errorMessage(error), "requests-state requests-failure", FAILURE_ICON);
    node.setAttribute("role", "alert");
    const items = recoveryActions(
        error,
        actionButton("retry", translate("shell.errorView.tryAgain"), () => page.retry()),
        goBack === undefined ? undefined : actionButton("go-back", translate("player.goBack"), goBack),
        nav.signIn === undefined ? undefined : actionButton("sign-in", translate("settings.accounts.signInAgain"), nav.signIn),
    );
    node.appendChild(zoneNode("browse-actions", items));
    return { name, content: [node], zones: [{ id: "status", layout: "column", items }], focus: { zone: "status", key: items[0]?.key ?? "retry" }, back: nav.back };
}

/** Apple TVRequestsPage.placeholder: the whole hub while it has no rows to show. */
function hubPlaceholder(state: RequestPageSnapshot, page: RequestPage, nav: RequestsViewNav): View | undefined {
    const data = state.data;
    if (data !== undefined && "sections" in data && (state.visibleMine.length > 0 || data.sections.some(section => section.results.some(browsable)))) return undefined;
    const placeholder = (content: HTMLElement, zone: Zone): View => ({ name: "requests:hub", content: [content], zones: [zone], focus: { zone: zone.id, key: zone.items[0]?.key ?? "" }, back: nav.back });
    if (state.failure !== undefined) {
        return errorPlaceholder(state, page, nav, "requests:hub");
    }
    const node = data === undefined ? requestsLoadingPage() : searchState(translate("requests.empty"), translate("requests.emptyBody"), "requests-state requests-empty", TRAY_ICON);
    return placeholder(node, { id: "page", layout: "row", items: [pageOwner(node, translate(data === undefined ? "requests.loadingSpoken" : "requests.empty"))] });
}

/** Apple's detail action row (`RequestDetailView.tvActions`): primary morphing pill plus Notify Me / Cancel Request. */
function detailActions(data: RequestTitle | MediaRequest, state: RequestPageSnapshot, page: RequestPage, nav: RequestsViewNav): { readonly items: FocusItem[]; readonly row: HTMLElement } | undefined {
    const actions: FocusItem[] = [];
    const inert = state.writing || state.uncertain || state.busy;
    const progress = requestProgress(data);
    // Apple's primary action: one button whose label and style morph, so focus stays put (RequestDetailView.swift:11).
    const requestAction = (again = false): FocusItem => {
        const idleKey = again ? "requests.action.requestAgain" : "requests.action.request";
        const request = actionButton("create", translate(idleKey), () => { if (!inert) page.write("create"); });
        request.element.classList.add("requests-primary-action");
        const label = translate(state.action !== "create" ? idleKey : state.unconfirmed ? "requests.reason.request_unconfirmed" : "requests.action.requesting");
        request.element.setAttribute("aria-label", label);
        if (state.action !== "create") { request.element.classList.add("requests-interactive-action"); request.element.prepend(requestPlusIcon()); }
        else if (state.unconfirmed) request.element.replaceChildren(requestStatusLabel({ display: "unavailable", short: label, long: label, completed: 0, current: undefined }));
        else request.element.replaceChildren(requestActionSpinner(), el("span", "", label));
        return request;
    };
    const secondaryAction = (key: string, label: string, icon: SVGSVGElement, onPress: () => void): FocusItem => {
        const item = actionButton(key, label, onPress);
        item.element.classList.add("requests-secondary-action");
        item.element.setAttribute("aria-label", label);
        item.element.replaceChildren(icon, el("span", "", label));
        return item;
    };
    if ("request" in data && data.request.requestable) actions.push(requestAction());
    const followTitle = requestFollowTarget(data, state.detail);
    if (followTitle !== undefined && canFollowRequest(state.capability, followTitle, requestProgress(followTitle))) {
        const following = followTitle.request.following;
        const label = translate(following ? "requests.action.stopNotify" : "requests.action.notify");
        actions.push(secondaryAction("follow", label, following ? requestBellSlashIcon() : requestBellIcon(), () => { if (!inert) page.write(following ? "unfollow" : "follow"); }));
    }
    if (!("request" in data)) {
        // Apple's canCancel hides Cancel while it runs and until a read settles an unconfirmed one. A list cancel owns the same gate.
        if (data.profileId === state.profileId && data.outcome === "active" && data.status === "pending" && state.action !== "cancel" && state.actingId === undefined) {
            actions.push(secondaryAction("cancel", translate("requests.action.cancel"), requestXmarkIcon(), () => { if (!inert) page.write("cancel"); }));
        }
    }
    // A request that ended no longer blocks a new one once the fresh title says so (RequestDetailViewModel.primaryAction, endedRequest).
    const requestAgain = !("request" in data) && state.detail?.request.requestable === true && (progress?.display === "unavailable" || progress?.display === "needsAttention");
    if (requestAgain) {
        const isEnded = progress?.display === "needsAttention" && (state.detail?.request.id === undefined || state.detail.request.id === data.id);
        actions.unshift(requestAction(isEnded));
    } else if (progress !== undefined) {
        const catalogId = data.libraryContentId;
        const inLibrary = progress.display === "inLibrary" && !!catalogId;
        const primary = actionButton("status", inLibrary ? translate("requests.action.openInLibrary") : progress.long, () => { if (inLibrary && !inert) nav.openCatalog(catalogId, data.title); });
        primary.element.classList.add("requests-primary-action");
        if (inLibrary) primary.element.classList.add("requests-interactive-action");
        primary.element.dataset.requestDisplay = progress.display;
        primary.element.replaceChildren(inLibrary ? el("span", "", translate("requests.action.openInLibrary")) : requestStatusLabel(progress, progress.long));
        primary.element.setAttribute("aria-label", inLibrary ? translate("requests.action.openInLibrary") : progress.long);
        actions.unshift(primary);
    }
    // Disabled buttons leave the focus graph, so Apple keeps both primary and secondary actions focusable and ignores presses (RequestDetailView.swift:301-306, 449-456).
    if (inert) for (const action of actions) action.element.setAttribute("aria-disabled", "true");
    if (actions.length === 0) return undefined;
    const row = zoneNode("browse-actions requests-detail-actions", actions);
    // Apple shows an unconfirmed write's message once its read has answered.
    if (state.actionMessage !== undefined && !(state.unconfirmed && state.busy)) {
        const message = el("p", "requests-action-message", state.actionMessage);
        message.setAttribute("role", "alert");
        row.appendChild(message);
    }
    return { items: actions, row };
}

export function requestsView(page: RequestPage, nav: RequestsViewNav): View {
    const state = page.snapshot();
    const source = state.source;
    const data = state.data;
    const baseUrl = nav.baseUrl;
    const hub = source.kind === "hub";
    const detailPage = source.kind === "media" || source.kind === "request";
    // Detail keeps the unconfirmed copy beside the action; the list banner is for hub/mine only.
    const bannerText = detailPage ? state.notice : (state.listMessage ?? state.notice);
    const withNotice = (view: View): View => {
        if (bannerText === undefined) return view;
        const banner = el("p", "requests-list-notice", bannerText);
        banner.setAttribute("role", "status");
        return { ...view, content: [...view.content, banner] };
    };
    // Apple RequestDetailView: with no page to keep, a failed read is the whole screen, and loading uses TVItemDetailLoadingView.
    const placeholder = hub ? hubPlaceholder(state, page, nav) : detailPage && data === undefined && state.failure !== undefined ? errorPlaceholder(state, page, nav, `requests:${source.kind}`, nav.back) : undefined;
    if (placeholder !== undefined) return withNotice(placeholder);
    if (detailPage && data === undefined) {
        return withNotice(detailsLoadingView(
            { id: source.kind === "request" ? source.id : `${source.title.mediaType}:${source.title.tmdbId}`, title: "" },
            { baseUrl: nav.baseUrl },
            nav.back,
            "requests:loading",
        ));
    }
    const content: HTMLElement[] = [];
    const zones: Zone[] = [];
    const openCard = (title: RequestTitle | MediaRequest): void => {
        if (requestProgress(title)?.display === "inLibrary" && title.libraryContentId) nav.openCatalog(title.libraryContentId, title.title);
        else nav.open("id" in title ? { kind: "request", id: title.id } : { kind: "media", title });
    };
    const preview = el("div", "requests-preview");
    const paint = (title: RequestTitle | MediaRequest): void => { previews.set(page, title); preview.replaceChildren(requestHero(title, baseUrl)); };
    const add = (id: string, items: FocusItem[], grid = false, into: HTMLElement[] = content): void => {
        if (items.length === 0) return;
        into.push(zoneNode(grid ? hub ? "browse-row requests-rail" : "requests-grid" : "browse-actions", items));
        const enabled = items.filter(item => !(item.element instanceof HTMLButtonElement) || !item.element.disabled);
        if (enabled.length > 0) zones.push({ id, layout: grid && !hub ? "grid" : "row", ...(grid && !hub ? { columns: 4 } : {}), ...(grid && hub ? { spatial: true } : {}), items: enabled });
    };
    /** Apple's rowView: the eyebrow, heading and rail scroll as one view-aligned target. */
    const hubRow = (id: string, head: readonly HTMLElement[], items: FocusItem[]): void => {
        const nodes = [...head];
        add(id, items, true, nodes);
        const row = el("section", "requests-row");
        row.setAttribute("data-section", id);
        row.append(...nodes);
        content.push(row);
    };
    const card = (title: RequestTitle | MediaRequest, open: () => void): FocusItem => requestCard(title, baseUrl, open, hub ? paint : undefined);
    /** Apple TVRequestsPage.card: Cancel Request and Remove Request live on the record's context menu. */
    const ownCard = (record: MediaRequest): FocusItem => {
        const item = card(record, () => openCard(record));
        const actions = page.rowActions(record);
        if (state.actingId === record.id) item.element.dataset.busy = "true";
        const offered = [actions.cancel ? "cancel" : undefined, actions.remove ? "remove" : undefined].filter((name): name is string => name !== undefined);
        if (offered.length === 0) return item;
        item.element.dataset.requestActions = offered.join(" ");
        return nav.menu === undefined ? item : { ...item, quickAction: () => nav.menu?.(record) };
    };
    const titleItems = (titles: readonly RequestTitle[]): FocusItem[] => titles.filter(browsable).map(title => card(title, () => openCard(title)));
    if (source.kind === "search") {
        let search = searchHeads.get(page);
        if (search === undefined) {
            const input = el("input", "browse-input") as HTMLInputElement;
            input.type = "search";
            input.setAttribute("aria-label", "Search requests");
            input.value = source.query;
            input.addEventListener("input", () => page.editSearch(input.value));
            input.addEventListener("keydown", event => {
                if (event.key === "Enter" || event.keyCode === 65376) {
                    event.preventDefault();
                    event.stopPropagation();
                    page.submitSearch();
                }
            });
            const items = [{ key: "query", element: input }, actionButton("submit", "Search", () => page.submitSearch())];
            search = { head: [el("h1", "browse-title", translate("requests.title")), zoneNode("browse-actions", items)], items };
            searchHeads.set(page, search);
        }
        content.push(...search.head);
        zones.push({ id: "search", layout: "row", items: [...search.items] });
    } else if (!hub && source.kind !== "media" && source.kind !== "request") {
        content.push(el("h1", "browse-title", translate(source.kind === "mine" ? "requests.myRequests" : "requests.title")));
    }
    if (hub) content.push(preview);
    // A hub with rows keeps them through a failed or running refresh, as Apple's does; a detail's held action says why itself.
    if (!hub && state.failure !== undefined && state.actionMessage === undefined) content.push(...lines([state.failure], "error"));
    if (!hub && state.busy && !(detailPage && data !== undefined)) content.push(...lines([translate("requests.loading")], "info"));
    if (data !== undefined) {
        if ("sections" in data) {
            const mine = state.visibleMine;
            const titles = [...mine, ...data.sections.flatMap(section => section.results)];
            const identity = (title: RequestTitle | MediaRequest): string => "id" in title ? title.id : `${title.mediaType}:${title.tmdbId}`;
            const previous = previews.get(page);
            const initial = (previous === undefined ? undefined : titles.find(title => identity(title) === identity(previous))) ?? titles[0];
            if (initial !== undefined) paint(initial);
            if (mine.length > 0) hubRow("mine", [el("h2", "requests-heading", translate("requests.yourRequests"))], mine.map(ownCard));
            let eyebrow = true;
            for (const section of data.sections) {
                if (!section.results.some(browsable)) continue;
                hubRow(`row:${section.key}`, [...(eyebrow ? [el("p", "requests-discover", translate("requests.hub.discover"))] : []), el("h2", "requests-heading", section.title)], titleItems(section.results));
                eyebrow = false;
            }
        } else if ("results" in data) {
            add("results", titleItems(data.results), true);
            if (data.results.length === 0) content.push(...lines(["No titles found."], "info"));
            add("pages", [...(data.page > 1 ? [actionButton("previous", "Previous page", () => page.nextPage(data.page - 1))] : []), ...(data.nextPage <= data.totalPages ? [actionButton("next", "Next page", () => page.nextPage(data.nextPage))] : [])]);
        } else if ("items" in data) {
            const mine = state.visibleMine;
            add("mine", mine.map(ownCard), true);
            if (mine.length === 0) content.push(...lines(["No requests yet."], "info"));
            if (data.cursor !== undefined) { const cursor = data.cursor; add("pages", [actionButton("next", "Next page", () => page.nextPage(cursor))]); }
        } else if ("title" in data) {
            const metadata = "request" in data ? data : state.detail;
            const hero = requestHero(data, baseUrl, metadata, true);
            content.push(hero);
            if (state.detailFailed) content.push(...lines(["Could not load title information. Refresh to try again."], "error"));
            const builtActions = detailActions(data, state, page, nav);
            if (builtActions !== undefined) {
                (hero.querySelector(".requests-hero-copy") ?? hero).appendChild(builtActions.row);
                zones.push({ id: "mutations", layout: "row", spatial: true, items: builtActions.items });
            }
            if ((metadata?.recommendations?.length ?? 0) > 0) {
                content.push(el("h2", "requests-heading", translate("requests.moreLikeThis")));
                const items = titleItems(metadata?.recommendations ?? []);
                const rail = zoneNode("browse-row requests-rail", items);
                cullToRailBounds(rail);
                content.push(rail);
                zones.push({ id: "related", layout: "row", spatial: true, items });
            }
        }
    }
    // Apple's detail has no controls below More like this; these recover failures and hold focus while none is otherwise available.
    const recovering = state.failure !== undefined || state.detailFailed || zones.length === 0 || (state.uncertain && !state.writing && !state.busy);
    if (!hub && (!detailPage || recovering)) add("actions", [actionButton("refresh", state.failure !== undefined ? translate("common.retry") : "Refresh", () => page.retry()), actionButton("back", translate("common.back"), nav.back)]);
    return withNotice({ name: `requests:${source.kind}`, content, zones, focus: { zone: zones[0]?.id ?? "actions", key: zones[0]?.items[0]?.key ?? "back" }, back: nav.back });
}
