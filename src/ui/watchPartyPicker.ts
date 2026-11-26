// Apple's WatchPartyMediaPicker, WatchPartySearchPage, WatchPartyEpisodePicker and WatchPartyMediaChoiceView on tvOS:
// the host chooses a title (or anyone suggests in a vote room) from group picks, watchlists, Home discovery rows,
// recently added movies/series, or catalog search; a series opens its episodes, and a confirmation page stages or suggests it.

import type { Card, Episode, Season } from "../contracts/v2/catalog.ts";
import type { PickerEntry } from "../contracts/v2/watchTogether.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { errorHeadline, errorMessage } from "./browseRoutes.ts";
import { actionButton, artwork, cardItem, searchLoading, searchState, zoneNode } from "./browseViews.ts";
import { feedGrid } from "./catalogFeed.ts";
import { el } from "./screen.ts";
import { backdrop, banner, checkIcon, closeIcon, eyebrow, FILM_STACK_ICON, labelled, plusIcon, searchIcon } from "./watchPartyParts.ts";
import { choiceFromCard, choiceFromEpisode, choiceFromNextUp, type MediaChoice } from "./watchPartyChoice.ts";
import { type LobbyPage, noticeText, type WatchPartyHub } from "./watchPartyHub.ts";
import { runtimeText } from "./cardPresentation.ts";

export interface PickerContext { readonly hub: WatchPartyHub; readonly baseUrl: string }

/** The IME Done key on the Tizen keyboard, plus Enter for hardware keyboards. */
const IME_DONE = 65376;
const SEARCH_COLUMNS = 6;

function chromeIcon(key: string, label: string, glyph: SVGSVGElement, onPress: () => void): FocusItem {
    const item = actionButton(key, "", onPress);
    item.element.classList.add("watch-party-chrome-icon");
    item.element.setAttribute("aria-label", label);
    item.element.appendChild(glyph);
    return item;
}

/** Apple's tvChrome: same inset, height and capsule icons as the top bar; left is purpose, right is Search and Close. */
function chrome(hub: WatchPartyHub): { node: HTMLElement; search: FocusItem; close: FocusItem } {
    const search = chromeIcon("picker-search", translate("watchParty.picker.search"), searchIcon(), () => { hub.openSearch(); });
    const close = chromeIcon("picker-close", translate("watchParty.picker.close"), closeIcon(), () => { hub.show({ kind: "lobby" }); });
    const tools = el("div", "watch-party-picker-tools");
    tools.append(search.element, close.element);
    const node = el("div", "watch-party-picker-chrome watch-party-ui");
    node.append(el("span", "watch-party-picker-name", translate(hub.state.pickerPurpose === "suggest" ? "watchParty.picker.suggest" : "watchParty.picker.select")), tools);
    return { node, search, close };
}

/** Looks up a series' Continue Together next-up entry when opened from search or another shelf. */
function nextUpFor(hub: WatchPartyHub, contentId: string): PickerEntry["nextUp"] {
    for (const shelf of hub.state.shelves) {
        if (shelf.id !== "together") continue;
        const hit = shelf.entries.find(entry => entry.card.id === contentId);
        if (hit?.nextUp !== undefined) return hit.nextUp;
    }
    return undefined;
}

/** Select on a series the group is part-way through goes to its next episode; any other series opens its seasons. */
function open(hub: WatchPartyHub, card: Card, nextUp: Parameters<typeof choiceFromNextUp>[1] | undefined, from?: LobbyPage): void {
    if (card.type === "series") {
        if (nextUp !== undefined) hub.show({ kind: "choice", choice: choiceFromNextUp(card, nextUp), ...(from === undefined ? {} : { from }) });
        else void hub.openEpisodes(card, undefined, false, from);
    } else hub.show({ kind: "choice", choice: choiceFromCard(card), ...(from === undefined ? {} : { from }) });
}

export function pickerView({ hub, baseUrl }: PickerContext): View {
    const { shelves, shelvesLoading, shelvesError } = hub.state;
    const top = chrome(hub);
    const content: HTMLElement[] = [top.node];
    const zones: Zone[] = [{ id: "picker-top", layout: "row", items: [top.search, top.close] }];
    let firstShelf: FocusItem | undefined;
    for (const shelf of shelves) {
        // Each card opens its own shelf's entry: the same series can sit in both shelves, and only one has a next-up episode.
        const cards = shelf.entries.map(entry => cardItem(entry.card, {
            baseUrl, posterWidth: 220, seriesYears: true,
            cardDestination: card => ({ kind: "item" as const, id: card.id, title: card.title }),
            open: () => { open(hub, entry.card, entry.nextUp ?? nextUpFor(hub, entry.card.id)); },
        })).filter((card): card is FocusItem => card !== undefined);
        if (cards.length === 0) continue;
        firstShelf ??= cards[0];
        zones.push({ id: `shelf:${shelf.id}`, layout: "row", spatial: true, items: cards });
        const block = el("section", "browse-section watch-party-shelf watch-party-ui");
        block.append(el("h2", "browse-section-title", shelf.title()), zoneNode("browse-row", cards));
        content.push(block);
    }
    const notice = el("div", "watch-party-picker-empty watch-party-ui");
    if (shelves.length === 0) {
        if (shelvesLoading) {
            const loading = searchLoading();
            loading.classList.add("watch-party-picker-spinner");
            notice.appendChild(loading);
        } else {
            notice.appendChild(searchState(translate("watchParty.picker.emptyTitle"), translate("watchParty.picker.emptyBody"), "watch-party-picker-empty-state", FILM_STACK_ICON));
        }
    }
    if (shelvesError !== undefined) notice.appendChild(banner(shelvesError, true));
    if (notice.childElementCount > 0) content.push(notice);
    const first = firstShelf ?? top.search;
    const zone = zones.find(candidate => candidate.items.includes(first))?.id ?? "picker-top";
    // Shelves arriving is a new page for focus: the first title takes it, as the first card does on Home; empty/loading focuses Search.
    return { name: `watchParty:picker:${firstShelf === undefined ? "empty" : "shelves"}`, content, zones, focus: { zone, key: first.key }, back: () => hub.back() };
}

/** Apple's WatchPartySearchPage on tvOS: retained search field over a 6-column poster grid. */
export function searchView({ hub, baseUrl }: PickerContext, searchInput: HTMLInputElement): View {
    const { search, pickerPurpose } = hub.state;
    const prompt = translate("watchParty.picker.searchPromptTv");
    searchInput.placeholder = prompt;
    searchInput.setAttribute("aria-label", prompt);
    if (searchInput.value !== search.query) searchInput.value = search.query;

    const field: FocusItem = { key: "picker-search-input", element: searchInput };
    const header = el("div", "watch-party-search-head watch-party-ui");
    header.append(el("h1", "watch-party-search-title", translate("watchParty.picker.searchPage")), searchInput);

    const content: HTMLElement[] = [header];
    const zones: Zone[] = [{ id: "picker-search-field", layout: "row", items: [field] }];
    const body = el("div", "watch-party-search-body watch-party-ui");
    let firstCard: FocusItem | undefined;

    if (search.searching && search.results.length === 0) {
        body.appendChild(searchLoading());
    } else if (search.error !== undefined) {
        const retry = actionButton("search-retry", translate("shell.errorView.tryAgain"), () => { void hub.searchNow(); });
        const goBack = actionButton("search-back", translate("player.goBack"), () => { hub.back(); });
        const failure = searchState(errorHeadline(search.error), errorMessage(search.error), "search-failure");
        failure.setAttribute("role", "alert");
        failure.appendChild(zoneNode("browse-actions", [retry, goBack]));
        body.appendChild(failure);
        zones.push({ id: "picker-search-status", layout: "column", items: [retry, goBack] });
    } else if (search.hasSearched && search.results.length === 0) {
        body.appendChild(searchState(translate("watchParty.picker.noResults"), translate("watchParty.picker.noResultsBody"), "search-empty"));
    } else if (search.results.length === 0) {
        body.appendChild(searchState(translate(pickerPurpose === "suggest" ? "watchParty.picker.suggest" : "watchParty.picker.select"), translate("search.initialBody"), "search-prompt"));
    } else {
        body.appendChild(el("p", "watch-party-search-count", translate("requests.search.resultCount", { count: search.total, count_text: integerText(search.total) })));
        const page = { items: search.results, nextCursor: search.nextCursor, total: search.total, totalExact: true };
        const grid = feedGrid(
            search.feedKey,
            page,
            {
                baseUrl,
                seriesYears: true,
                open: destination => {
                    if (destination.kind !== "item") return;
                    const card = search.results.find(candidate => candidate.id === destination.id);
                    if (card !== undefined) open(hub, card, nextUpFor(hub, card.id), { kind: "search" });
                },
            },
            SEARCH_COLUMNS,
            search.searching,
            () => { void hub.loadMoreSearch(); },
            SEARCH_COLUMNS,
            220,
        );
        const gridZone = grid.zones[0];
        firstCard = gridZone?.items[0];
        if (gridZone !== undefined && gridZone.items.length > 0) {
            grid.content[0]?.classList.add("watch-party-search-grid");
            body.append(...grid.content);
            zones.push({ ...gridZone, id: "picker-search-grid" });
        }
    }
    content.push(body);

    searchInput.oninput = () => { hub.setSearchQuery(searchInput.value); };
    searchInput.onkeydown = event => {
        const done = event.keyCode === IME_DONE;
        if (!done && event.key !== "Enter") return;
        const trimmed = searchInput.value.trim();
        if (done) {
            event.preventDefault();
            event.stopPropagation();
            if (firstCard !== undefined && trimmed !== "" && trimmed === search.completedQuery && search.hasSearched && !search.searching) {
                firstCard.element.focus();
                return;
            }
            if (trimmed !== "") void hub.searchNow(searchInput.value);
            return;
        }
        // Leave Enter unhandled by preventDefault so the Samsung TV remote can always open the on-screen keyboard
        // to enter or edit a query (matching browse.ts); on a desktop keyboard, Enter still triggers an immediate
        // search when the text changed.
        if (trimmed !== "" && trimmed !== search.completedQuery) void hub.searchNow(searchInput.value);
    };

    const focus = { zone: "picker-search-field", key: field.key };
    return { name: "watchParty:search", content, zones, focus, back: () => hub.back() };
}

/** WatchPartyMediaChoiceView: the title, and the one button that stages it or adds it to the ballot. */
export function choiceView({ hub, baseUrl }: PickerContext, choice: MediaChoice): View {
    const room = hub.state.room;
    const suggesting = hub.state.pickerPurpose === "suggest";
    const staged = room?.phase === "lobby" && hub.state.capabilities?.stagedSelection === true;
    const confirm = suggesting
        ? labelled("confirm", translate("watchParty.confirm.addSuggestion"), "primary", () => { void hub.suggest(choice); }, plusIcon())
        : labelled("confirm", translate(staged ? "watchParty.confirm.choose" : "watchParty.confirm.playForEveryone"), "primary", () => { void hub.stage(choice); }, checkIcon());
    const poster = artwork("watch-party-choice-poster", choice.posterUrl, baseUrl, "");
    const text = el("div", "watch-party-choice-text");
    const facts = [choice.subtitle(), ...choice.facts()].filter((fact): fact is string => fact !== undefined && fact !== "");
    text.append(eyebrow(translate(suggesting ? "watchParty.picker.suggestToParty" : "watchParty.picker.watchTogether")), el("h1", "watch-party-choice-title", choice.title), ...(facts.length === 0 ? [] : [el("p", "watch-party-choice-facts", facts.join(" · "))]));
    const head = el("div", "watch-party-choice-head");
    head.append(poster, text);
    const page = el("div", "watch-party-choice watch-party-ui");
    page.append(head);
    if (choice.overview !== undefined && choice.overview !== "") page.appendChild(el("p", "watch-party-choice-overview", choice.overview));
    page.appendChild(confirm.element);
    if (hub.state.error !== undefined) page.appendChild(banner(noticeText(hub.state.error), true));
    return {
        name: "watchParty:choice",
        content: [backdrop(choice.backdropUrl ?? choice.posterUrl, baseUrl, choice.backdropUrl === undefined), page],
        zones: [{ id: "choice", layout: "row", items: [confirm] }],
        focus: { zone: "choice", key: "confirm" },
        back: () => hub.back(),
    };
}

function episodeCard(series: Card, episode: Episode, onPress: () => void): FocusItem {
    const item = actionButton(episode.id, "", onPress);
    item.element.classList.add("watch-party-episode");
    // The episode's own still can spoil it, and Apple's spoiler setting is not read here, so the tile is plain.
    const number = el("span", "watch-party-episode-number", `E${episode.episodeNumber}`);
    const caption = el("span", "watch-party-episode-title", translate("watchParty.episodes.numbered", { number: integerText(episode.episodeNumber), title: episode.title === "" ? translate("detail.episode", { number: integerText(episode.episodeNumber) }) : episode.title }));
    const meta = runtimeText(episode.runtimeMinutes);
    item.element.append(number, caption, ...(meta === undefined ? [] : [el("span", "watch-party-episode-meta", meta)]));
    item.element.setAttribute("aria-label", `${series.title}, season ${episode.seasonNumber}, episode ${episode.episodeNumber}`);
    return item;
}

const seasonLabel = (season: Season): string => season.isSpecials === true ? translate("detail.specials") : season.title;

/** WatchPartyEpisodePicker: the series' seasons as tabs over the chosen season's episodes. */
export function episodesView({ hub, baseUrl }: PickerContext, series: Card, season: Season | undefined, from?: LobbyPage): View {
    const { seasons, episodes, browseLoading, browseError } = hub.state;
    const back = actionButton("episodes-close", translate("watchParty.picker.close"), () => { hub.back(); });
    back.element.classList.add("watch-party-button", "watch-party-secondary");
    const tabs = (seasons ?? []).map(candidate => {
        const tab = actionButton(`season:${candidate.seasonNumber}`, seasonLabel(candidate), () => { if (candidate.seasonNumber !== season?.seasonNumber) void hub.openEpisodes(series, candidate); });
        tab.element.classList.add("watch-party-season-tab");
        tab.element.setAttribute("aria-pressed", String(candidate.seasonNumber === season?.seasonNumber));
        return tab;
    });
    const cards = (episodes ?? []).map(episode => episodeCard(series, episode, () => { hub.show({ kind: "choice", choice: choiceFromEpisode(series, episode), from: { kind: "episodes", series, season, ...(from === undefined ? {} : { from }) } }); }));
    const page = el("div", "watch-party-episodes watch-party-ui");
    const head = el("div", "watch-party-episodes-head");
    head.append(eyebrow(translate(hub.state.pickerPurpose === "suggest" ? "watchParty.eyebrow.suggestEpisode" : "watchParty.eyebrow.chooseEpisode")), back.element);
    page.append(head, el("h1", "watch-party-episodes-title", series.title));
    const zones: Zone[] = [{ id: "episodes-top", layout: "row", items: [back] }];
    if (tabs.length > 0) {
        zones.push({ id: "seasons", layout: "row", items: tabs });
        page.appendChild(zoneNode("browse-row watch-party-season-tabs", tabs));
    }
    const retry = actionButton("episodes-retry", translate("shell.errorView.tryAgain"), () => { void hub.openEpisodes(series, season, true); });
    if (cards.length > 0) {
        zones.push({ id: "episode-rail", layout: "row", items: cards });
        page.appendChild(zoneNode("browse-row watch-party-episode-rail", cards));
    } else if (browseLoading) {
        const loading = el("p", "watch-party-lead", translate("watchParty.episodes.loading"));
        loading.setAttribute("role", "status");
        page.appendChild(loading);
    } else {
        page.append(el("h2", "watch-party-empty-title", translate("watchParty.episodes.noneTitle")), el("p", "watch-party-lead", browseError ?? translate("watchParty.episodes.noneBody")));
        retry.element.classList.add("watch-party-button", "watch-party-secondary");
        zones.push({ id: "episodes-retry", layout: "row", items: [retry] });
        page.appendChild(retry.element);
    }
    const first = cards[0] ?? tabs.find(tab => tab.key === `season:${season?.seasonNumber}`) ?? (browseLoading ? back : retry);
    const zone = zones.find(candidate => candidate.items.includes(first))?.id ?? "episodes-top";
    return {
        name: "watchParty:episodes",
        content: [backdrop(series.backdropUrl ?? series.posterUrl, baseUrl, series.backdropUrl === undefined), page],
        zones, focus: { zone, key: first.key }, back: () => hub.back(),
    };
}
