// Apple's WatchPartyHubView on tvOS: the create-or-join entry and, once a room is open, the lobby and the
// pages it opens (watchPartyLobby.ts, watchPartyPicker.ts). Metrics are Apple's tvOS values at 1920x1080.

import { translate } from "../i18n/translate.ts";
import type { FocusItem, View } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import type { EpisodeSpoilerSettings } from "./episodeSpoilers.ts";
import { spinner } from "./marquee.ts";
import { el } from "./screen.ts";
import { backdrop, banner, enabled, eyebrow, pill, plusIcon, reloadIcon } from "./watchPartyParts.ts";
import { endView, inviteView, lobbyView, optionsView, suggestionMenuView } from "./watchPartyLobby.ts";
import { choiceView, episodesView, pickerView, searchView } from "./watchPartyPicker.ts";
import { noticeText, type RecentRoom, type WatchPartyHub } from "./watchPartyHub.ts";
import type { LobbyItem } from "./watchPartyChoice.ts";

/** Retained search page containers so renders never detach or blur an active TV keyboard session or focused result card. */
export interface WatchPartySearchNodes {
    readonly header: HTMLDivElement;
    readonly title: HTMLHeadingElement;
    readonly input: HTMLInputElement;
    readonly body: HTMLDivElement;
    readonly count: HTMLParagraphElement;
}

/** What a route keeps across renders: the hub, and the retained containers/fields so focused controls are never rebuilt. */
export interface WatchPartyScreen {
    readonly hub: WatchPartyHub;
    readonly input: HTMLInputElement;
    readonly search: WatchPartySearchNodes;
}

export function watchPartyScreen(hub: WatchPartyHub): WatchPartyScreen {
    const input = el("input", "browse-input watch-party-input");
    input.type = "text";
    input.setAttribute("data-focus", "code");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "characters");
    input.spellcheck = false;
    const searchTitle = el("h1", "watch-party-search-title");
    const searchInput = el("input", "browse-input watch-party-search-input");
    searchInput.type = "search";
    searchInput.setAttribute("data-focus", "picker-search-input");
    searchInput.setAttribute("autocomplete", "off");
    searchInput.spellcheck = false;
    // Kept across renders so the field, TV keyboard, and retained result grid are never detached (matching browse.ts).
    const searchHeader = el("div", "watch-party-search-head watch-party-ui");
    searchHeader.append(searchTitle, searchInput);
    const search: WatchPartySearchNodes = {
        header: searchHeader,
        title: searchTitle,
        input: searchInput,
        body: el("div", "watch-party-search-body watch-party-ui"),
        count: el("p", "watch-party-search-count"),
    };
    return { hub, input, search };
}

/** The IME Done key on the Tizen keyboard. */
const IME_DONE = 65376;

export function watchPartyView(screen: WatchPartyScreen, back: () => void, baseUrl: string, spoilers?: EpisodeSpoilerSettings): View {
    const { hub } = screen;
    if (hub.state.startingPreview !== undefined) return startingView(hub.state.startingPreview, back, baseUrl);
    const room = hub.state.room;
    if (room === undefined) return entryView(screen, back);
    const context = { hub, baseUrl, ...(spoilers === undefined ? {} : { spoilers }) };
    const page = hub.state.page;
    switch (page.kind) {
        case "options": return optionsView(context, room);
        case "end": return endView(context, room);
        case "invite": return inviteView(context, room);
        case "suggestionMenu": return suggestionMenuView(context, room, page.suggestion);
        case "picker": return pickerView(context);
        case "search": return searchView(context, screen.search);
        case "choice": return choiceView(context, page.choice, page.from);
        case "episodes": return episodesView(context, page.series, page.season, page.from, page.initialEpisodeId);
        case "lobby": return lobbyView(context, room, back);
    }
}

/** WatchPartyHubView.swift:20-38: starting from a title holds on its artwork with a focused spinner instead of flashing the entry page. */
function startingView(preview: LobbyItem, back: () => void, baseUrl: string): View {
    const owner = el("div", "watch-party-starting");
    owner.tabIndex = 0;
    owner.setAttribute("data-focus", "starting");
    owner.setAttribute("role", "progressbar");
    owner.setAttribute("aria-label", translate("watchParty.page.starting"));
    owner.append(spinner());
    return {
        name: "watchParty:starting",
        content: [backdrop(preview.backdropUrl ?? preview.posterUrl, baseUrl, preview.backdropUrl === undefined), owner],
        zones: [{ id: "party", layout: "row", items: [{ key: "starting", element: owner }] }],
        focus: { zone: "party", key: "starting" },
        back,
    };
}

function rejoinLabel(recent: RecentRoom, wasReplaced: boolean): string {
    if (wasReplaced) return translate("watchParty.rejoin.continueHere");
    if (recent.selectedTitle !== undefined && recent.selectedTitle !== "") return translate("watchParty.rejoin.title", { title: recent.selectedTitle });
    return translate("watchParty.rejoin.recent");
}

function entryView({ hub, input }: WatchPartyScreen, back: () => void): View {
    // The field outlives a redraw so a focused field is never rebuilt, so its words are set here, in the language this draw reads.
    input.placeholder = translate("watchParty.hub.codeField");
    input.setAttribute("aria-label", translate("watchParty.hub.codeField"));
    const { supported, checking, busy, error, recentRoom, wasReplaced } = hub.state;
    const unusable = !supported;
    // Apple disables Start a party, vote, rejoin and Join party while a request runs, and while the server cannot host a party.
    const locked = unusable || busy;
    const message = error !== undefined ? noticeText(error) : (unusable ? translate(checking ? "watchParty.page.checking" : "watchParty.page.unavailable") : undefined);
    const intro = el("div", "watch-party-intro");
    const headline = el("div", "watch-party-headline");
    headline.append(eyebrow(translate("watchParty.title")), el("h1", "watch-party-title", translate("watchParty.page.headline")), el("p", "watch-party-body", translate("watchParty.page.body")));
    intro.append(headline);
    if (message !== undefined) intro.append(banner(message, error !== undefined));

    const create = pill(actionButton("create", translate("watchParty.page.start"), () => { if (!locked) void hub.create("host_pick"); }), "primary", locked);
    create.element.prepend(plusIcon());
    const vote = pill(actionButton("vote", translate("watchParty.page.startVote"), () => { if (!locked) void hub.create("vote"); }), "secondary", locked);
    const rejoin = recentRoom === undefined ? undefined : pill(actionButton("rejoin", rejoinLabel(recentRoom, wasReplaced), () => { if (!locked) void hub.rejoinRecent(); }), "secondary", locked);
    if (rejoin !== undefined) {
        rejoin.element.classList.add("watch-party-rejoin");
        rejoin.element.prepend(reloadIcon());
    }
    const joinable = (): boolean => !locked && input.value.trim() !== "";
    const join = pill(actionButton("join", translate("watchParty.code.joinParty"), () => { if (joinable()) void hub.join(input.value); }), "secondary", !joinable());
    const retry = unusable ? pill(actionButton("retry", translate("watchParty.page.checkAgain"), () => { if (!checking) void hub.check(); }), "secondary", checking) : undefined;

    const host = el("div", "watch-party-section");
    host.append(eyebrow(translate("watchParty.hub.hostSection")), create.element, vote.element);
    if (rejoin !== undefined) {
        const recentGroup = el("div", "watch-party-rejoin-group");
        recentGroup.append(rejoin.element);
        if (wasReplaced) recentGroup.append(el("p", "watch-party-rejoin-note", translate("watchParty.rejoin.takeOver")));
        host.append(recentGroup);
    }
    const joinSection = el("div", "watch-party-section");
    joinSection.append(eyebrow(translate("watchParty.hub.joinSection")), input, join.element, ...(retry === undefined ? [] : [retry.element]));
    // A disabled button takes no focus, as on tvOS. Typing must not rebuild the page, which would drop the field's focus,
    // so the one control that depends on the text enters and leaves this list as it changes.
    const items: FocusItem[] = [];
    const listItems = (): void => {
        join.element.setAttribute("aria-disabled", String(!joinable()));
        items.splice(0, items.length, ...[create, vote, ...(rejoin === undefined ? [] : [rejoin]), { key: "code", element: input }, join, ...(retry === undefined ? [] : [retry])].filter(enabled));
    };
    listItems();
    input.oninput = listItems;
    input.onkeydown = event => {
        if (event.keyCode !== IME_DONE || !joinable()) return;
        event.preventDefault();
        event.stopPropagation();
        join.element.focus();
    };
    const actions = el("div", "watch-party-actions");
    actions.append(host, joinSection);
    const page = el("div", "watch-party watch-party-ui");
    page.append(intro, actions);

    return {
        name: "watchParty:hub",
        content: [page],
        zones: [{ id: "party", layout: "column", items }],
        focus: { zone: "party", key: [rejoin, create, retry].find(item => item !== undefined && enabled(item))?.key ?? "code" },
        back,
    };
}
