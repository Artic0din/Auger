// Apple's WatchPartyBallot and WatchPartyLobbySuggestions on tvOS:
// - In a vote room's lobby, every suggestion as a 220x330 poster card with its tally badge, tick, leader outline,
//   long-press context menu (Start this one, Remove suggestion), and the dashed Suggest a title card.
// - In a host-pick lobby, guest suggestions appear on the right as 120x180 poster cards (host clicks to queue/play,
//   long-press removes removable suggestions).

import type { Room, Suggestion } from "../contracts/v2/watchTogether.ts";
import { isolated } from "../i18n/direction.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";
import type { FocusItem } from "./browseFocus.ts";
import { actionButton, artwork } from "./browseViews.ts";
import { artworkUrl } from "./browseModel.ts";
import { el } from "./screen.ts";
import { checkIcon, eyebrow, plusIcon } from "./watchPartyParts.ts";
import type { WatchPartyHub } from "./watchPartyHub.ts";

/** The card's label, as Apple's accessibility label: what pressing it does. */
function voteLabel(suggestion: Suggestion, voted: boolean | undefined): string {
    if (voted === undefined) return translate("watchParty.ballot.loadingVote");
    return translate(voted ? "watchParty.ballot.removeVote" : "watchParty.ballot.vote", { title: isolated(suggestion.title) });
}

/**
 * A suggestion's poster is whatever the suggesting member's client sent (the server does not check it), so every TV in
 * the room would load it. Only artwork on this server is drawn; anything else shows the blank poster.
 */
export function serverPoster(reference: string, baseUrl: string): string | undefined {
    const url = artworkUrl(reference, baseUrl);
    return url !== undefined && new URL(url).origin === new URL(baseUrl).origin ? url : undefined;
}

/** WatchPartyCandidateCard. Apple disables the card until this profile's vote is known or while a change runs; it stays focusable here so focus never drops, and a press then does nothing. */
function candidate(hub: WatchPartyHub, suggestion: Suggestion, leader: boolean, baseUrl: string): FocusItem {
    const voted = hub.state.votes.voted(suggestion.id);
    const usable = voted !== undefined && !hub.state.busy && hub.state.connection === "connected";
    const item = actionButton(`suggestion:${suggestion.id}`, "", () => { if (usable && voted !== undefined) void hub.vote(suggestion.id, !voted); });
    item.element.classList.add("watch-party-candidate");
    if (leader) item.element.classList.add("watch-party-candidate-leader");
    item.element.setAttribute("aria-disabled", String(!usable));
    item.element.setAttribute("aria-pressed", String(voted === true));
    item.element.setAttribute("aria-label", voteLabel(suggestion, voted));
    const poster = el("span", "watch-party-candidate-poster");
    poster.appendChild(artwork("watch-party-candidate-art", serverPoster(suggestion.posterUrl, baseUrl), baseUrl, ""));
    const badge = el("span", "watch-party-vote-badge");
    // The button's name is Apple's action; the tally and the leader are its description, as an aria-label on the badge alone would not reach the button.
    badge.id = `watch-party-vote-${encodeURIComponent(suggestion.id)}`;
    badge.setAttribute("aria-label", translate(leader ? "watchParty.ballot.candidateLeading" : "watchParty.ballot.candidate", { title: isolated(suggestion.title), count: suggestion.voteCount }));
    item.element.setAttribute("aria-describedby", badge.id);
    badge.append(el("span", "watch-party-vote-count", integerText(suggestion.voteCount)), el("span", "watch-party-vote-label", translate("watchParty.ballot.votesLabel", { count: suggestion.voteCount })));
    poster.appendChild(badge);
    if (voted === true) {
        const tick = el("span", "watch-party-candidate-tick");
        tick.appendChild(checkIcon());
        poster.appendChild(tick);
    }
    const line = suggestion.note !== "" ? translate("watchParty.ballot.note", { note: suggestion.note }) : suggestion.subtitle;
    item.element.append(poster, el("span", "watch-party-candidate-title", suggestion.title), el("span", "watch-party-candidate-line", line === "" ? " " : line));
    if (hub.canStartSuggestion(suggestion) || hub.canRemoveSuggestion(suggestion)) {
        const quickAction = (): void => { hub.show({ kind: "suggestionMenu", suggestion }); };
        item.element.addEventListener("contextmenu", event => { event.preventDefault(); item.element.focus({ preventScroll: true }); quickAction(); });
        return { ...item, quickAction };
    }
    return item;
}

/** WatchPartySuggestCardLabel: the dashed card that opens the picker to suggest a title. */
function suggestCard(hub: WatchPartyHub): FocusItem {
    const item = actionButton("ballot-suggest", "", () => { if (!hub.state.busy) void hub.openPicker("suggest"); });
    item.element.classList.add("watch-party-candidate", "watch-party-suggest-card");
    item.element.setAttribute("aria-label", translate("watchParty.button.suggestTitle"));
    const poster = el("span", "watch-party-candidate-poster");
    poster.appendChild(plusIcon());
    item.element.append(poster, el("span", "watch-party-candidate-title", translate("watchParty.button.suggestTitle")), el("span", "watch-party-candidate-line", translate("watchParty.ballot.addCaption")));
    return item;
}

/** The ballot row and its cards, keyed by suggestion id so focus stays on a card while tallies change. */
export function ballotRow(hub: WatchPartyHub, baseUrl: string): { readonly node: HTMLElement; readonly items: readonly FocusItem[] } {
    const leader = hub.winner()?.id;
    const items = [...hub.state.votes.rows.map(row => candidate(hub, row, row.id === leader, baseUrl)), suggestCard(hub)];
    // A browse-row scrolls sideways to reveal the focused card, as every shelf does.
    const node = el("div", "browse-row watch-party-ballot");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", "Suggestions");
    node.append(...items.map(item => item.element));
    return { node, items };
}

/** Apple's WatchPartyLobbySuggestions on tvOS: 120x180 poster strip on the right side of a host-pick lobby. */
export function hostPickSuggestions(hub: WatchPartyHub, room: Room, baseUrl: string): { readonly node: HTMLElement; readonly items: readonly FocusItem[] } {
    const rows = hub.state.votes.rows;
    const queuesSelection = hub.state.capabilities?.stagedSelection === true;
    const canHostAct = room.selfCanManageRoom && !hub.state.busy && hub.state.connection === "connected";
    const head = el("div", "watch-party-strip-head");
    head.append(
        eyebrow(translate("watchParty.strip.titleCount", { count: rows.length })),
        el("span", "watch-party-strip-subtitle", translate(room.selfCanManageRoom ? "watchParty.strip.manager" : "watchParty.strip.guest")),
    );
    const strip = el("div", "browse-row watch-party-strip");
    strip.setAttribute("role", "group");
    strip.setAttribute("aria-label", translate("watchParty.strip.titleCount", { count: rows.length }));
    const items: FocusItem[] = [];
    for (const suggestion of rows) {
        const queued = suggestion.contentId === room.selectedContentId;
        const canQueue = canHostAct && !queued;
        const canRemove = hub.canRemoveSuggestion(suggestion);
        const poster = el("span", "watch-party-strip-poster");
        poster.appendChild(artwork("watch-party-strip-art", serverPoster(suggestion.posterUrl, baseUrl), baseUrl, ""));
        const title = el("span", "watch-party-strip-title", suggestion.title);
        if (canQueue || canRemove) {
            const button = actionButton(`host-suggestion:${suggestion.id}`, "", () => { if (canQueue) void hub.queueSuggestion(suggestion); });
            button.element.classList.add("watch-party-strip-card");
            button.element.setAttribute("aria-label", canQueue
                ? translate(queuesSelection ? "watchParty.suggestion.queueTitle" : "watchParty.suggestion.playTitle", { title: isolated(suggestion.title) })
                : suggestion.title);
            button.element.append(poster, title);
            if (canRemove) {
                const quickAction = (): void => { hub.show({ kind: "suggestionMenu", suggestion }); };
                button.element.addEventListener("contextmenu", event => { event.preventDefault(); button.element.focus({ preventScroll: true }); quickAction(); });
                items.push({ ...button, quickAction });
            } else {
                items.push(button);
            }
            strip.appendChild(button.element);
        } else {
            const passive = el("div", "watch-party-strip-card watch-party-strip-card-passive");
            passive.setAttribute("aria-label", suggestion.title);
            passive.append(poster, title);
            strip.appendChild(passive);
        }
    }
    const node = el("div", "watch-party-lobby-suggestions");
    node.append(head, strip);
    return { node, items };
}
