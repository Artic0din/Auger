// Apple's WatchPartyHubView on tvOS: the create-or-join entry and, once a room is open, the lobby and the
// pages it opens (watchPartyLobby.ts, watchPartyPicker.ts). Metrics are Apple's tvOS values at 1920x1080.

import { translate } from "../i18n/translate.ts";
import type { FocusItem, View } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { el } from "./screen.ts";
import { banner, enabled, eyebrow, pill, plusIcon } from "./watchPartyParts.ts";
import { endView, inviteView, lobbyView, optionsView } from "./watchPartyLobby.ts";
import { choiceView, episodesView, pickerView, searchView } from "./watchPartyPicker.ts";
import { noticeText, type WatchPartyHub } from "./watchPartyHub.ts";

/** What a route keeps across renders: the hub, and the text fields so a focused field is never rebuilt. */
export interface WatchPartyScreen {
    readonly hub: WatchPartyHub;
    readonly input: HTMLInputElement;
    readonly searchInput: HTMLInputElement;
}

export function watchPartyScreen(hub: WatchPartyHub): WatchPartyScreen {
    const input = el("input", "browse-input watch-party-input");
    input.type = "text";
    input.setAttribute("data-focus", "code");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "characters");
    input.spellcheck = false;
    const searchInput = el("input", "browse-input watch-party-search-input");
    searchInput.type = "search";
    searchInput.setAttribute("data-focus", "picker-search-input");
    searchInput.setAttribute("autocomplete", "off");
    searchInput.spellcheck = false;
    return { hub, input, searchInput };
}

/** The IME Done key on the Tizen keyboard. */
const IME_DONE = 65376;

export function watchPartyView(screen: WatchPartyScreen, back: () => void, baseUrl: string): View {
    const { hub } = screen;
    const room = hub.state.room;
    if (room === undefined) return entryView(screen, back);
    const context = { hub, baseUrl };
    const page = hub.state.page;
    switch (page.kind) {
        case "options": return optionsView(context, room);
        case "end": return endView(context, room);
        case "invite": return inviteView(context, room);
        case "picker": return pickerView(context);
        case "search": return searchView(context, screen.searchInput);
        case "choice": return choiceView(context, page.choice);
        case "episodes": return episodesView(context, page.series, page.season);
        case "lobby": return lobbyView(context, room, back);
    }
}

function entryView({ hub, input }: WatchPartyScreen, back: () => void): View {
    // The field outlives a redraw so a focused field is never rebuilt, so its words are set here, in the language this draw reads.
    input.placeholder = translate("watchParty.hub.codeField");
    input.setAttribute("aria-label", translate("watchParty.hub.codeField"));
    const { supported, checking, busy, error } = hub.state;
    const unusable = !supported;
    // Apple disables Start a party, vote and Join party while a request runs, and while the server cannot host a party.
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
    const joinable = (): boolean => !locked && input.value.trim() !== "";
    const join = pill(actionButton("join", translate("watchParty.code.joinParty"), () => { if (joinable()) void hub.join(input.value); }), "secondary", !joinable());
    const retry = unusable ? pill(actionButton("retry", translate("watchParty.page.checkAgain"), () => { if (!checking) void hub.check(); }), "secondary", checking) : undefined;

    const host = el("div", "watch-party-section");
    host.append(eyebrow(translate("watchParty.hub.hostSection")), create.element, vote.element);
    const joinSection = el("div", "watch-party-section");
    joinSection.append(eyebrow(translate("watchParty.hub.joinSection")), input, join.element, ...(retry === undefined ? [] : [retry.element]));
    // A disabled button takes no focus, as on tvOS. Typing must not rebuild the page, which would drop the field's focus,
    // so the one control that depends on the text enters and leaves this list as it changes.
    const items: FocusItem[] = [];
    const listItems = (): void => {
        join.element.setAttribute("aria-disabled", String(!joinable()));
        items.splice(0, items.length, ...[create, vote, { key: "code", element: input }, join, ...(retry === undefined ? [] : [retry])].filter(enabled));
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
        focus: { zone: "party", key: [create, retry].find(item => item !== undefined && enabled(item))?.key ?? "code" },
        back,
    };
}
