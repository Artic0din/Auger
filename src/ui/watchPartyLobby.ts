// Apple's WatchPartyLobbyView on tvOS, and the sheets it opens: Party options, the End confirmation and the
// invitation. The room socket keeps the lobby current: who is here and ready, the pick, the policy, the vote
// room's ballot (watchPartyBallot.ts) and the party ending.
// Metrics are Apple's tvOS values at 1920x1080 (WatchPartyMetrics).

import type { Room, Suggestion } from "../contracts/v2/watchTogether.ts";
import { isolated } from "../i18n/direction.ts";
import { translate } from "../i18n/translate.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { qrCode } from "./qr.ts";
import { el } from "./screen.ts";
import { backdrop, banner, checkIcon, circleButton, codeText, ellipsisIcon, eyebrow, labelled, playIcon, plusIcon } from "./watchPartyParts.ts";
import { ballotRow, hostPickSuggestions, serverPoster } from "./watchPartyBallot.ts";
import { inviteUrl } from "./watchPartyInvite.ts";
import { type PrimaryAction, primaryAction, waitingNames } from "./watchPartyPolicy.ts";
import { seatsRow } from "./watchPartySeats.ts";
import { noticeText, type WatchPartyHub } from "./watchPartyHub.ts";
import type { LobbyItem } from "./watchPartyChoice.ts";

export interface LobbyContext { readonly hub: WatchPartyHub; readonly baseUrl: string }

/** The host's name as the server sent it, isolated inside an Arabic sentence; Apple's "The host" when no member is the host. */
const hostName = (room: Room): string => {
    const host = room.members.find(member => member.isHost)?.displayName;
    return host === undefined ? translate("watchParty.theHost") : isolated(host);
};

/** WatchPartyLobbyView.connectionDot: the socket's state, and once connected who is here. */
function connection(hub: WatchPartyHub, room: Room): { text: string; tone: "ok" | "warn" | "wait" | "off" } {
    switch (hub.state.connection) {
        case "connected": {
            if (!room.hostConnected && room.selfRole !== "host") return { text: translate("watchParty.connection.hostAway"), tone: "warn" };
            const here = room.members.filter(member => member.connected).length;
            return { text: here <= 1 ? translate("watchParty.connection.open") : translate("watchParty.connection.here", { count: here }), tone: "ok" };
        }
        case "connecting": return { text: translate("watchParty.connection.connecting"), tone: "wait" };
        case "reconnecting": return { text: translate("watchParty.connection.reconnecting"), tone: "warn" };
        case "idle": return { text: translate("watchParty.connection.disconnected"), tone: "off" };
    }
}

function statusBanner(hub: WatchPartyHub, room: Room): HTMLElement | undefined {
    const { error, selectedUnavailable } = hub.state;
    if (error !== undefined) return banner(noticeText(error), true);
    if (selectedUnavailable) {
        return banner(room.selfCanManageRoom
            ? translate("watchParty.banner.unavailable.manager")
            : translate("watchParty.banner.unavailable.guest", { host: hostName(room) }), true);
    }
    if (!room.hostConnected && room.selfRole !== "host") return banner(translate("watchParty.banner.hostAway", { host: hostName(room) }), true);
    if (hub.state.connection === "reconnecting") return banner(translate("watchParty.banner.reconnecting"), false);
    return undefined;
}

/** Eyebrow, title and facts, as WatchPartyLobbyView.heroText. */
function heroText(room: Room, item: LobbyItem | undefined, hub: WatchPartyHub): HTMLElement {
    const hero = el("div", "watch-party-hero");
    const manage = room.selfCanManageRoom;
    const caption = (text: string): HTMLElement => el("p", "watch-party-caption", text);
    if (voting(room)) {
        const count = hub.state.votes.rows.length;
        hero.classList.add("watch-party-hero-vote");
        hero.append(eyebrow(translate("watchParty.eyebrow.voting", { count })), el("h1", "watch-party-hero-title", translate("watchParty.hero.voteTitle")),
            el("p", "watch-party-lead", manage ? translate("watchParty.hero.voteCaption.manager") : translate("watchParty.hero.voteCaption.guest", { host: hostName(room) })));
    } else if (item !== undefined) {
        const facts = el("p", "watch-party-facts");
        const parts = [item.subtitle(), ...item.facts()].filter((part): part is string => part !== undefined && part !== "");
        facts.append(...parts.flatMap((part, index) => index === 0 ? [part] : [el("span", "watch-party-facts-dot", "·"), part]));
        facts.append(...item.chips.map(chip => el("span", "watch-party-chip", chip)));
        hero.append(eyebrow(translate(room.phase === "playing" ? "watchParty.eyebrow.nowWatching" : "watchParty.eyebrow.upNext")), el("h1", "watch-party-hero-title", item.title()), facts,
            caption(chose(room)));
    } else if (room.selectedContentId !== undefined) {
        hero.append(eyebrow(translate(room.phase === "playing" ? "watchParty.eyebrow.nowWatching" : "watchParty.eyebrow.upNext")),
            el("h1", "watch-party-hero-title watch-party-hero-dim", translate(hub.state.selectedUnavailable ? "watchParty.hero.hidden" : "watchParty.hero.loading")),
            caption(chose(room)));
    } else {
        hero.append(eyebrow(translate("watchParty.eyebrow.open")), el("h1", "watch-party-hero-title", manage ? translate("watchParty.hero.pick") : translate("watchParty.hero.waiting", { host: hostName(room) })),
            el("p", "watch-party-lead", manage ? translate("watchParty.hero.pickCaption") : translate("watchParty.hero.waitingCaption", { host: hostName(room) })));
    }
    return hero;
}

const chose = (room: Room): string => room.selfRole === "host" ? translate("watchParty.hero.youChose") : translate("watchParty.hero.hostChose", { host: hostName(room) });

const voting = (room: Room): boolean => room.selectionMode === "vote" && room.phase === "lobby";

/** WatchPartyLobbyView.hint: advisory text under the buttons. */
function hint(hub: WatchPartyHub, room: Room): string | undefined {
    if (room.phase !== "lobby") return undefined;
    const winner = room.selectionMode === "vote" ? hub.winner() : undefined;
    if (room.selfCanManageRoom) {
        if (room.selectionMode === "vote" && winner === undefined) return translate(hub.state.votes.rows.length === 0 ? "watchParty.hint.suggestToStart" : "watchParty.hint.noVotes");
        if (room.selectedContentId === undefined && room.selectionMode === "host_pick") return undefined;
        const waiting = waitingNames(room.members);
        if (waiting.length === 0) return room.members.filter(member => member.connected).length > 1 ? translate("watchParty.hint.everyoneReady") : undefined;
        const [first = "", second = ""] = waiting.map(name => isolated(name));
        if (waiting.length === 1) return translate("watchParty.hint.notReady.oneName", { first });
        return translate(waiting.length === 2 ? "watchParty.hint.notReady.twoNames" : "watchParty.hint.notReady.moreNames", { first, second });
    }
    if (room.selectionMode === "vote") return winner === undefined ? translate("watchParty.hint.hostStartsTheWinner", { host: hostName(room) }) : translate("watchParty.hint.hostStartsWinner", { host: hostName(room), title: isolated(winner.title) });
    return room.selectedContentId === undefined ? undefined : translate("watchParty.hint.hostStarts", { host: hostName(room) });
}

/** Apple's I'm ready, and You're ready with tap to undo once the room says so. Dropped while the socket is not connected. */
function readyButton(hub: WatchPartyHub, room: Room): FocusItem {
    const ready = room.members.find(member => member.isSelf)?.lobbyReady === true;
    const connected = hub.state.connection === "connected";
    const button = labelled("ready", translate(ready ? "watchParty.button.youreReady" : "watchParty.button.imReady"), ready ? "secondary" : "primary", () => { if (connected) hub.setReady(!ready); }, ready ? checkIcon() : readyIcon());
    // tvOS draws Apple's outlined kind as the secondary pill.
    if (ready) button.element.append(el("span", "watch-party-undo", translate("watchParty.button.tapToUndo")));
    button.element.setAttribute("aria-pressed", String(ready));
    button.element.setAttribute("aria-disabled", String(!connected));
    return button;
}

/** checkmark.circle. */
function readyIcon(): SVGSVGElement {
    const svg = checkIcon();
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("cx", "12"); ring.setAttribute("cy", "12"); ring.setAttribute("r", "10");
    svg.prepend(ring);
    svg.querySelector("path")?.setAttribute("d", "M7.5 12.5 10.5 15.5 16.5 9");
    return svg;
}

const suggestButton = (hub: WatchPartyHub, label: string, kind: "primary" | "secondary"): FocusItem =>
    labelled("suggest", label, kind, () => { if (!hub.state.busy) void hub.openPicker("suggest"); }, plusIcon());

function primaryButton(hub: WatchPartyHub, room: Room, action: PrimaryAction): FocusItem | undefined {
    switch (action) {
        case "chooseTitle": return labelled("choose", translate(room.selectedContentId === undefined ? "watchParty.button.chooseTitle" : "watchParty.button.changeTitle"), "primary", () => { void hub.openPicker(); });
        case "start": {
            const winner = room.selectionMode === "vote" ? hub.winner() : undefined;
            const start = labelled("start", winner === undefined ? translate("watchParty.button.startForEveryone") : translate("watchParty.button.startWinner", { title: isolated(winner.title) }), "primary", () => { void hub.start(); }, playIcon());
            if (winner !== undefined) start.element.setAttribute("aria-disabled", String(!hub.ballotCurrent()));
            return start;
        }
        case "waitingForVotes": return suggestButton(hub, translate("watchParty.button.suggestTitle"), "primary");
        case "ready": return readyButton(hub, room);
        case "returnToPlayback": return labelled("resume", translate("watchParty.button.returnToPlayback"), "primary", () => { hub.resume(); }, playIcon());
        case "returnToLobby": return labelled("return-lobby", translate("watchParty.button.returnToLobby"), "primary", () => { void hub.stopPlayback(); });
        case "none": return undefined;
    }
}

function secondaryButton(hub: WatchPartyHub, room: Room, action: PrimaryAction): FocusItem | undefined {
    if (voting(room) && action === "start") return suggestButton(hub, translate("watchParty.button.suggest"), "secondary");
    if (voting(room) && !room.selfCanManageRoom) return suggestButton(hub, translate("watchParty.button.suggestTitle"), "secondary");
    if (room.selectionMode !== "host_pick" || !room.selfCanManageRoom) return undefined;
    if (room.phase === "lobby" && room.selectedContentId !== undefined && action === "start") return labelled("change", translate("watchParty.button.changeTitle"), "secondary", () => { void hub.openPicker(); });
    if (room.phase === "playing") return labelled("change", translate("watchParty.button.chooseSomethingElse"), "secondary", () => { void hub.openPicker(); });
    return undefined;
}

/** The lobby behind every room page. `interactive` is false behind an overlay, which owns focus. */
function lobbyPage(context: LobbyContext, room: Room, interactive: boolean): { node: HTMLElement; items: { top: FocusItem[]; ballot: readonly FocusItem[]; suggestions: readonly FocusItem[]; seats: FocusItem[]; actions: FocusItem[] }; defaultKey: string } {
    const { hub } = context;
    const item = hub.state.selected;
    const action = primaryAction(room, hub.state.capabilities, hub.canStart(), hub.state.selectedUnavailable);
    const page = el("div", "watch-party-room watch-party-ui");
    const state = connection(hub, room);
    const status = el("span", `watch-party-connection watch-party-connection-${state.tone}`);
    status.append(el("span", "watch-party-connection-dot"), state.text);
    const title = el("div", "watch-party-room-title");
    title.append(el("span", "watch-party-room-name", translate("watchParty.title")), status);

    const code = actionButton("lobby-code", "", () => { hub.show({ kind: "invite" }); });
    code.element.classList.add("watch-party-button", "watch-party-secondary", "watch-party-code-pill");
    code.element.setAttribute("aria-label", translate("watchParty.codePill.description", { code: [...room.code].join(" ") }));
    code.element.append(el("span", "watch-party-code-label", translate("watchParty.codePill.label")), codeText(room.code));
    const more = circleButton("options", translate("watchParty.options.button"), ellipsisIcon(), () => { hub.show({ kind: "options" }); });
    more.element.setAttribute("aria-label", translate("watchParty.options.title"));
    const header = el("div", "watch-party-room-header");
    const tools = el("div", "watch-party-room-tools");
    tools.append(code.element, more.element);
    header.append(title, tools);

    const body = el("div", "watch-party-room-body");
    const copy = el("div", "watch-party-room-copy");
    copy.appendChild(heroText(room, item, hub));
    const ballot = voting(room) ? ballotRow(hub, context.baseUrl) : undefined;
    const strip = room.phase === "lobby" && room.selectionMode === "host_pick" && hub.state.votes.rows.length > 0
        ? hostPickSuggestions(hub, room, context.baseUrl)
        : undefined;
    const overview = item?.overview;
    if (ballot !== undefined) {
        // The ballot takes the screen's width under the question, as Apple's tvLobby.
        body.classList.add("watch-party-room-body-vote");
        copy.appendChild(ballot.node);
    } else if (overview !== undefined && overview !== "") copy.appendChild(el("p", "watch-party-overview", overview));
    const notice = statusBanner(hub, room);
    if (notice !== undefined) copy.appendChild(notice);
    body.appendChild(copy);
    if (strip !== undefined) {
        body.classList.add("watch-party-room-body-split");
        body.appendChild(strip.node);
    }

    const seats = seatsRow(room.members, room.phase, () => { hub.show({ kind: "invite" }); });
    if (ballot !== undefined) seats.node.classList.add("watch-party-here-compact");
    const primary = primaryButton(hub, room, action);
    const secondary = secondaryButton(hub, room, action);
    const actions = el("div", "watch-party-room-actions");
    const buttons = el("div", "watch-party-room-buttons");
    for (const button of [secondary, primary]) if (button !== undefined) buttons.appendChild(button.element);
    const text = hint(hub, room);
    actions.append(buttons, ...(text === undefined ? [] : [el("p", "watch-party-hint", text)]));
    const footer = el("div", "watch-party-room-footer");
    footer.append(seats.node, actions);

    page.append(header, body, footer);
    if (!interactive) page.inert = true;
    return {
        node: page,
        items: { top: [code, more], ballot: ballot?.items ?? [], suggestions: strip?.items ?? [], seats: [seats.invite], actions: [secondary, primary].filter((button): button is FocusItem => button !== undefined) },
        defaultKey: primary?.key ?? "lobby-code",
    };
}

/** The chosen title's art; in a vote room with nothing chosen, the leading suggestion's poster, else the first one's. */
function roomBackdrop(context: LobbyContext): HTMLElement {
    const { hub } = context;
    const item = hub.state.selected;
    const reference = item?.backdropUrl ?? item?.posterUrl;
    if (reference === undefined && hub.state.room?.selectionMode === "vote") {
        const poster = (hub.winner() ?? hub.state.votes.rows[0])?.posterUrl;
        return backdrop(poster === undefined ? undefined : serverPoster(poster, context.baseUrl), context.baseUrl, true);
    }
    return backdrop(reference, context.baseUrl, item?.backdropUrl === undefined);
}

export function lobbyView(context: LobbyContext, room: Room, dismiss: () => void): View {
    const page = lobbyPage(context, room, true);
    const zones: Zone[] = [
        { id: "lobby-top", layout: "row", items: page.items.top },
        ...(page.items.ballot.length === 0 ? [] : [{ id: "lobby-ballot", layout: "row" as const, items: [...page.items.ballot] }]),
        ...(page.items.suggestions.length === 0 ? [] : [{ id: "lobby-suggestions", layout: "row" as const, items: [...page.items.suggestions] }]),
        { id: "lobby-seats", layout: "row", items: page.items.seats },
        ...(page.items.actions.length === 0 ? [] : [{ id: "lobby-actions", layout: "row" as const, items: page.items.actions }]),
    ];
    return { name: "watchParty:lobby", content: [roomBackdrop(context), page.node], zones, focus: { zone: page.items.actions.length === 0 ? "lobby-top" : "lobby-actions", key: page.defaultKey }, back: dismiss };
}

/** Long-press context menu for ballot cards ("Start this one", "Remove suggestion") and host-pick suggestion cards ("Remove suggestion"). */
export function suggestionMenuView(context: LobbyContext, room: Room, suggestion: Suggestion): View {
    const { hub } = context;
    const rows: FocusItem[] = [];
    if (room.selectionMode === "vote" && hub.canStartSuggestion(suggestion)) {
        rows.push(optionRow("suggestion-start", translate("watchParty.ballot.startThis"), undefined, false, () => { hub.show({ kind: "lobby" }); void hub.promoteSuggestion(suggestion.id); }));
    }
    if (hub.canRemoveSuggestion(suggestion)) {
        rows.push(optionRow("suggestion-remove", translate("watchParty.ballot.remove"), undefined, true, () => { hub.show({ kind: "lobby" }); void hub.deleteSuggestion(suggestion.id); }));
    }
    if (rows.length === 0) {
        rows.push(optionRow("close", translate("watchParty.options.close"), undefined, false, () => { hub.show({ kind: "lobby" }); }));
    }
    const card = el("div", "watch-party-sheet watch-party-options");
    card.append(el("h2", "watch-party-sheet-title", suggestion.title), ...rows.map(row => row.element));
    const scrim = el("div", "watch-party-scrim watch-party-ui");
    scrim.appendChild(card);
    const behind = lobbyPage(context, room, false);
    return {
        name: "watchParty:suggestionMenu",
        content: [roomBackdrop(context), behind.node, scrim],
        zones: [{ id: "suggestion-menu", layout: "column", items: rows }],
        focus: { zone: "suggestion-menu", key: rows[0]!.key },
        back: () => hub.show({ kind: "lobby" }),
    };
}

// --- Party options ---

function optionRow(key: string, title: string, value: string | undefined, destructive: boolean, onPress: () => void): FocusItem {
    const row = actionButton(key, "", onPress);
    row.element.classList.add("watch-party-option");
    if (destructive) row.element.classList.add("watch-party-option-destructive");
    row.element.append(el("span", "watch-party-option-title", title), ...(value === undefined ? [] : [el("span", "watch-party-option-value", value)]));
    return row;
}

/** WatchPartyHostControlsOverlay: the only focus owner while it is up; Back closes it. */
export function optionsView(context: LobbyContext, room: Room): View {
    const { hub } = context;
    const capabilities = hub.state.capabilities;
    const rows: FocusItem[] = [];
    if (room.selfCanManageRoom) {
        if (room.phase === "lobby" && capabilities?.selectionModeSwitch === true) {
            rows.push(optionRow("mode", translate("watchParty.options.whoChooses"), translate(room.selectionMode === "vote" ? "watchParty.options.everyoneVotes" : "watchParty.options.hostChooses"), false, () => { void hub.setMode(room.selectionMode === "vote" ? "host_pick" : "vote"); }));
        }
        rows.push(optionRow("policy", translate("watchParty.options.playbackControls"), translate(room.guestControlPolicy === "guest_play_pause" ? "watchParty.options.guestsPlayPause" : "watchParty.options.hostOnly"), false,
            () => { void hub.setPolicy(room.guestControlPolicy === "guest_play_pause" ? "host_only" : "guest_play_pause"); }));
        if (room.phase === "playing" && capabilities?.stopPlayback === true) {
            rows.push(optionRow("stop", translate("watchParty.options.returnToLobby"), undefined, false, () => { void hub.stopPlayback(); hub.show({ kind: "lobby" }); }));
        }
        rows.push(optionRow("end", translate("watchParty.options.end"), undefined, true, () => { hub.show({ kind: "end" }); }));
    }
    rows.push(optionRow("leave", translate("watchParty.options.leave"), undefined, true, () => { hub.leave(); }));
    const close = optionRow("close", translate("watchParty.options.close"), undefined, false, () => { hub.show({ kind: "lobby" }); });
    rows.push(close);
    const card = el("div", "watch-party-sheet watch-party-options");
    card.append(el("h2", "watch-party-sheet-title", translate("watchParty.options.title")), ...rows.map(row => row.element));
    const scrim = el("div", "watch-party-scrim watch-party-ui");
    scrim.appendChild(card);
    const behind = lobbyPage(context, room, false);
    return {
        name: "watchParty:options",
        content: [roomBackdrop(context), behind.node, scrim],
        zones: [{ id: "options", layout: "column", items: rows }],
        focus: { zone: "options", key: "close" },
        back: () => context.hub.show({ kind: "lobby" }),
    };
}

/** WatchPartyEndConfirmation. */
export function endView(context: LobbyContext, room: Room): View {
    const { hub } = context;
    const cancel = labelled("cancel", translate("common.cancel"), "secondary", () => { hub.show({ kind: "lobby" }); });
    const confirm = labelled("confirm-end", translate("watchParty.end.confirm"), "secondary", () => { hub.show({ kind: "lobby" }); void hub.endParty(); });
    const card = el("div", "watch-party-sheet watch-party-end");
    const row = el("div", "watch-party-end-actions");
    row.append(cancel.element, confirm.element);
    card.append(el("h2", "watch-party-sheet-title", translate("watchParty.end.confirmTitle")), row);
    const scrim = el("div", "watch-party-scrim watch-party-ui");
    scrim.appendChild(card);
    const behind = lobbyPage(context, room, false);
    return {
        name: "watchParty:end",
        content: [roomBackdrop(context), behind.node, scrim],
        zones: [{ id: "end", layout: "row", items: [cancel, confirm] }],
        focus: { zone: "end", key: "cancel" },
        back: () => context.hub.show({ kind: "lobby" }),
    };
}

// --- Invitation ---

/** WatchPartyInviteView on tvOS: the code, a QR for phones when the room has an invitation link, and Done. */
export function inviteView(context: LobbyContext, room: Room): View {
    const { hub, baseUrl } = context;
    const link = room.invitePath === undefined ? undefined : inviteUrl(room.invitePath, baseUrl);
    const done = labelled("done", translate("common.done"), "secondary", () => { hub.show({ kind: "lobby" }); });
    const text = el("div", "watch-party-invite-copy");
    text.append(eyebrow(translate("watchParty.invite.friends")), el("h1", "watch-party-invite-title", translate("watchParty.invite.title")),
        el("p", "watch-party-lead", translate("watchParty.invite.body")));
    const code = el("p", "watch-party-invite-code", room.code);
    code.setAttribute("aria-label", translate("watchParty.partyCode", { code: [...room.code].join(", ") }));
    text.appendChild(code);
    if (link !== undefined) text.appendChild(el("p", "watch-party-caption", translate("watchParty.invite.scan")));
    text.appendChild(done.element);
    const layout = el("div", "watch-party-invite watch-party-ui");
    layout.appendChild(text);
    const qr = link === undefined ? undefined : qrCode(link, translate("watchParty.invite.qrDescription"));
    if (qr !== undefined) {
        const card = el("div", "watch-party-qr");
        card.appendChild(qr);
        layout.appendChild(card);
    }
    return {
        name: "watchParty:invite",
        content: [roomBackdrop(context), layout],
        zones: [{ id: "invite", layout: "row", items: [done] }],
        focus: { zone: "invite", key: "done" },
        back: () => hub.show({ kind: "lobby" }),
    };
}
