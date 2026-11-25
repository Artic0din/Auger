// Apple's WatchPartyMediaPicker, WatchPartySearchPage, WatchPartyEpisodePicker and WatchPartyMediaChoiceView on tvOS:
// the host chooses a title (or anyone suggests in a vote room) from group picks, watchlists, Home discovery rows,
// recently added movies/series, or catalog search; a series opens its episodes, and a confirmation page stages or suggests it.

import type { Card, Episode, Season } from "../contracts/v2/catalog.ts";
import type { MemberWatchState, PickerEntry } from "../contracts/v2/watchTogether.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { errorHeadline, errorMessage } from "./browseRoutes.ts";
import { actionButton, artwork, cardItem, searchLoading, searchState, thumbnailProgress, zoneNode } from "./browseViews.ts";
import { feedGrid } from "./catalogFeed.ts";
import { defaultArtwork } from "./defaultArtwork.ts";
import { episodeAirDate, episodeRuntime } from "./episodeCaption.ts";
import { blurEpisodeStill, type EpisodeSpoilerSettings, hidesEpisodeListStill, hidesEpisodeOverview } from "./episodeSpoilers.ts";
import { el } from "./screen.ts";
import { backdrop, banner, checkIcon, closeIcon, eyebrow, FILM_STACK_ICON, labelled, listBulletIcon, plusIcon, searchIcon } from "./watchPartyParts.ts";
import { choiceFromCard, choiceFromEpisode, choiceFromNextUp, type MediaChoice } from "./watchPartyChoice.ts";
import { type LobbyPage, noticeText, type WatchPartyHub } from "./watchPartyHub.ts";
import { runtimeText } from "./cardPresentation.ts";

export interface PickerContext { readonly hub: WatchPartyHub; readonly baseUrl: string; readonly spoilers?: EpisodeSpoilerSettings }

const NO_SPOILERS: EpisodeSpoilerSettings = { hidesImages: false, hidesOverviews: false };

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
        if (event.keyCode !== IME_DONE && event.key !== "Enter") return;
        event.preventDefault();
        event.stopPropagation();
        const trimmed = searchInput.value.trim();
        if (firstCard !== undefined && trimmed !== "" && trimmed === search.completedQuery && search.hasSearched && !search.searching) {
            firstCard.element.focus();
            return;
        }
        void hub.searchNow(searchInput.value);
    };

    const focus = { zone: "picker-search-field", key: field.key };
    return { name: "watchParty:search", content, zones, focus, back: () => hub.back() };
}

/** Apple's WatchPartyMediaChoiceView.historyLabel. */
function historyLabel(state: MemberWatchState | undefined): string {
    if (state === undefined) return translate("watchParty.whoSeen.noHistory");
    let label: string;
    switch (state.state) {
        case "watched":
        case "completed":
        case "played":
            label = translate("watchParty.whoSeen.watched");
            break;
        case "in_progress":
        case "inprogress":
            label = translate("watchParty.whoSeen.inProgress");
            break;
        default:
            label = translate("watchParty.whoSeen.notWatched");
            break;
    }
    return state.onWatchlist ? translate("watchParty.whoSeen.watchlist", { state: label }) : label;
}

/** WatchPartyMediaChoiceView: title, primary confirm button, optional "See all episodes", and "Who's seen it". */
export function choiceView({ hub, baseUrl }: PickerContext, choice: MediaChoice, from?: LobbyPage): View {
    const room = hub.state.room;
    const suggesting = hub.state.pickerPurpose === "suggest";
    const staged = room?.phase === "lobby" && hub.state.capabilities?.stagedSelection === true;
    const confirm = suggesting
        ? labelled("confirm", translate("watchParty.confirm.addSuggestion"), "primary", () => { void hub.suggest(choice); }, plusIcon())
        : labelled("confirm", translate(staged ? "watchParty.confirm.choose" : "watchParty.confirm.playForEveryone"), "primary", () => { void hub.stage(choice); }, checkIcon());
    const browseSeries = choice.seriesLink === undefined ? undefined : labelled(
        "browse-series",
        translate("watchParty.confirm.allEpisodes"),
        "secondary",
        () => { void hub.openEpisodes(choice.seriesLink!, choice.seasonNumber, false, { kind: "choice", choice, ...(from === undefined ? {} : { from }) }, choice.contentId); },
        listBulletIcon(),
    );
    const poster = artwork("watch-party-choice-poster", choice.posterUrl, baseUrl, "");
    const text = el("div", "watch-party-choice-text");
    const facts = [choice.subtitle(), ...choice.facts()].filter((fact): fact is string => fact !== undefined && fact !== "");
    text.append(eyebrow(translate(suggesting ? "watchParty.picker.suggestToParty" : "watchParty.picker.watchTogether")), el("h1", "watch-party-choice-title", choice.title), ...(facts.length === 0 ? [] : [el("p", "watch-party-choice-facts", facts.join(" · "))]));
    const head = el("div", "watch-party-choice-head");
    head.append(poster, text);
    const page = el("div", "watch-party-choice watch-party-ui");
    page.append(head);
    if (choice.overview !== undefined && choice.overview !== "") page.appendChild(el("p", "watch-party-choice-overview", choice.overview));
    const choiceActions = el("div", "watch-party-choice-actions");
    choiceActions.append(confirm.element, ...(browseSeries === undefined ? [] : [browseSeries.element]));
    page.appendChild(choiceActions);
    if (hub.state.capabilities?.memberState === true) {
        const seen = el("div", "watch-party-who-seen");
        seen.appendChild(eyebrow(translate("watchParty.whoSeen.title")));
        if (hub.state.memberStateLoading) {
            const checking = el("p", "watch-party-who-seen-checking", translate("watchParty.whoSeen.checking"));
            checking.setAttribute("role", "status");
            seen.appendChild(checking);
        } else {
            const item = hub.state.memberState?.items.find(candidate => candidate.contentId === choice.contentId);
            if (item !== undefined) {
                for (const member of room?.members ?? []) {
                    const state = item.members.find(entry => entry.userId === member.userId && entry.profileId === member.profileId);
                    const row = el("div", "watch-party-who-seen-row");
                    row.append(el("span", "watch-party-who-seen-name", member.displayName), el("span", "watch-party-who-seen-state", historyLabel(state)));
                    seen.appendChild(row);
                }
            }
        }
        page.appendChild(seen);
    }
    const warning = hub.state.error ?? hub.state.memberStateError;
    if (warning !== undefined) page.appendChild(banner(noticeText(warning), true));
    const items = browseSeries === undefined ? [confirm] : [confirm, browseSeries];
    return {
        name: "watchParty:choice",
        content: [backdrop(choice.backdropUrl ?? choice.posterUrl, baseUrl, choice.backdropUrl === undefined), page],
        zones: [{ id: "choice", layout: "column", items }],
        focus: { zone: "choice", key: "confirm" },
        back: () => hub.back(),
    };
}

function episodeLine(episode: Episode): string {
    const parts = [translate("watchParty.episodes.line", { season: String(episode.seasonNumber), episode: String(episode.episodeNumber) })];
    if (episode.title.trim() !== "") parts.push(episode.title);
    const runtime = runtimeText(episode.runtimeMinutes);
    if (runtime !== undefined) parts.push(runtime);
    return parts.join(" · ");
}

function episodeOverview(series: Card, episode: Episode | undefined, spoilers: EpisodeSpoilerSettings): string {
    if (episode === undefined) return series.overview ?? "";
    const watch = {
        played: episode.played,
        ...(episode.isInProgress === undefined ? {} : { isInProgress: episode.isInProgress }),
        ...(episode.positionSeconds === undefined ? {} : { positionSeconds: episode.positionSeconds }),
    };
    if (hidesEpisodeOverview(spoilers, watch)) return "";
    return episode.overview ?? series.overview ?? "";
}

function preferredResumeEpisode(episodes: readonly Episode[], initialEpisodeId: string | undefined): Episode | undefined {
    if (initialEpisodeId !== undefined) {
        const initial = episodes.find(episode => episode.id === initialEpisodeId);
        if (initial !== undefined) return initial;
    }
    return episodes.find(episode => episode.isInProgress === true || (episode.positionSeconds !== undefined && episode.positionSeconds > 0 && !episode.played))
        ?? episodes.find(episode => !episode.played)
        ?? episodes[0];
}

function episodeCard(series: Card, episode: Episode, baseUrl: string, spoilers: EpisodeSpoilerSettings, onPress: () => void, onFocus: () => void): FocusItem {
    const item = actionButton(episode.id, "", onPress);
    item.element.classList.add("watch-party-episode");
    const art = artwork("watch-party-episode-still", episode.stillUrl, baseUrl, defaultArtwork("tv"));
    if (hidesEpisodeListStill(episode, spoilers)) blurEpisodeStill(art);
    if (episode.played) art.appendChild(el("span", "details-episode-dim"));
    const position = episode.positionSeconds, duration = episode.durationSeconds;
    if (position !== undefined && duration !== undefined && duration > 0 && position > 0 && position < duration) {
        art.appendChild(thumbnailProgress(position / duration));
    }
    if (episode.played) {
        const badge = el("span", "browse-watched");
        badge.setAttribute("aria-label", translate("detail.watched"));
        art.appendChild(badge);
    }
    const title = episode.title.trim() === "" ? translate("detail.episode", { number: integerText(episode.episodeNumber) }) : episode.title;
    const caption = el("span", "watch-party-episode-title", translate("watchParty.episodes.numbered", { number: integerText(episode.episodeNumber), title }));
    const meta = [episodeAirDate(episode.airDate), episodeRuntime(episode.runtimeMinutes)].filter(Boolean).join("  ·  ");
    item.element.append(art, caption, ...(meta === "" ? [] : [el("span", "watch-party-episode-meta", meta)]));
    item.element.setAttribute("aria-label", `${series.title}, season ${episode.seasonNumber}, episode ${episode.episodeNumber}`);
    item.element.addEventListener("focus", onFocus);
    return item;
}

const seasonLabel = (season: Season): string => season.isSpecials === true ? translate("detail.specials") : season.title;

/** WatchPartyEpisodePicker on tvOS: series hero, season tabs, and 400-wide 16:9 episode rail. */
export function episodesView({ hub, baseUrl, spoilers = NO_SPOILERS }: PickerContext, series: Card, season: Season | undefined, from?: LobbyPage, initialEpisodeId?: string): View {
    const { seasons, episodes, browseLoading, browseError } = hub.state;
    const list = episodes ?? [];
    const initial = preferredResumeEpisode(list, initialEpisodeId);
    const tabs = (seasons ?? []).map(candidate => {
        const tab = actionButton(`season:${candidate.seasonNumber}`, seasonLabel(candidate), () => { if (candidate.seasonNumber !== season?.seasonNumber) void hub.openEpisodes(series, candidate); });
        tab.element.classList.add("watch-party-season-tab");
        tab.element.setAttribute("aria-pressed", String(candidate.seasonNumber === season?.seasonNumber));
        return tab;
    });
    const lineNode = el("p", "watch-party-episodes-line", initial !== undefined ? episodeLine(initial) : (series.year !== undefined && series.year > 0 ? integerText(series.year) : ""));
    const overviewNode = el("p", "watch-party-episodes-overview", episodeOverview(series, initial, spoilers));
    const cards = list.map(episode => episodeCard(
        series, episode, baseUrl, spoilers,
        () => { hub.show({ kind: "choice", choice: choiceFromEpisode(series, episode), from: { kind: "episodes", series, season, ...(from === undefined ? {} : { from }), initialEpisodeId: episode.id } }); },
        () => { lineNode.textContent = episodeLine(episode); overviewNode.textContent = episodeOverview(series, episode, spoilers); },
    ));
    const page = el("div", "watch-party-episodes watch-party-ui");
    const hero = el("div", "watch-party-episodes-hero");
    hero.append(el("h1", "watch-party-episodes-title", series.title), lineNode, overviewNode);
    page.append(eyebrow(translate(hub.state.pickerPurpose === "suggest" ? "watchParty.eyebrow.suggestEpisode" : "watchParty.eyebrow.chooseEpisode")), hero);
    const zones: Zone[] = [];
    if (tabs.length > 0) {
        zones.push({ id: "seasons", layout: "row", items: tabs });
        page.appendChild(zoneNode("browse-row watch-party-season-tabs", tabs));
    }
    const railSlot = el("div", "watch-party-episodes-slot");
    let loadingOwner: FocusItem | undefined;
    let retry: FocusItem | undefined;
    if (cards.length > 0) {
        zones.push({ id: "episode-rail", layout: "row", items: cards });
        railSlot.appendChild(zoneNode("browse-row watch-party-episode-rail", cards));
    } else if (browseLoading) {
        const loading = searchLoading();
        loading.setAttribute("aria-label", translate("watchParty.episodes.loading"));
        if (tabs.length === 0) {
            loading.tabIndex = -1;
            loading.setAttribute("data-focus", "episodes-loading");
            loadingOwner = { key: "episodes-loading", element: loading };
            zones.push({ id: "episodes-loading", layout: "row", items: [loadingOwner] });
        }
        railSlot.appendChild(loading);
    } else {
        const empty = el("div", "watch-party-episodes-empty");
        empty.appendChild(el("h2", "watch-party-empty-title", translate("watchParty.episodes.empty")));
        if (browseError !== undefined) empty.appendChild(banner(browseError, true));
        retry = labelled("episodes-retry", translate("watchParty.episodes.reload"), "secondary", () => { void hub.openEpisodes(series, season, true); });
        empty.appendChild(retry.element);
        zones.push({ id: "episodes-retry", layout: "row", items: [retry] });
        railSlot.appendChild(empty);
    }
    page.appendChild(railSlot);
    const initialCard = initial === undefined ? undefined : cards.find(card => card.key === initial.id);
    const first = initialCard ?? cards[0] ?? tabs.find(tab => tab.key === `season:${season?.seasonNumber}`) ?? retry ?? loadingOwner;
    const zone = first === undefined ? "seasons" : (zones.find(candidate => candidate.items.includes(first))?.id ?? zones[0]?.id ?? "seasons");
    return {
        name: "watchParty:episodes",
        content: [backdrop(series.backdropUrl ?? series.posterUrl, baseUrl, series.backdropUrl === undefined), page],
        zones, focus: first === undefined ? undefined : { zone, key: first.key }, back: () => hub.back(),
    };
}
