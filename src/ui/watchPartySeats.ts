// Apple's WatchPartySeat and WatchPartySeatsRow: each member as an avatar disc whose ring encodes state.
// Dashed grey is here but not ready, solid white with a tick is ready, dotted and dimmed is disconnected.

import type { Room, RoomMember } from "../contracts/v2/watchTogether.ts";
import { translate, type MessageKey } from "../i18n/translate.ts";
import type { FocusItem } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { el } from "./screen.ts";
import { eyebrow, icon, SVG } from "./watchPartyParts.ts";
import { presenceSummary, seatState, type SeatState } from "./watchPartyPolicy.ts";

const STATUS_KEY: Partial<Record<SeatState, MessageKey>> = { notReady: "watchParty.seat.notReady", away: "watchParty.seat.reconnecting", syncing: "watchParty.seat.syncing", buffering: "watchParty.seat.buffering", joining: "watchParty.seat.joining" };

/** Host first, then this viewer, then by name. */
function ordered(members: readonly RoomMember[]): RoomMember[] {
    return [...members].sort((a, b) => a.isHost !== b.isHost ? (a.isHost ? -1 : 1) : a.isSelf !== b.isSelf ? (a.isSelf ? -1 : 1) : a.displayName.localeCompare(b.displayName));
}

const PALETTE: readonly (readonly [string, string])[] = [["#5A4A8A", "#2B2450"], ["#8A5A3A", "#4A2C1C"], ["#3A7A6A", "#1C3F36"], ["#7A3A5A", "#3F1C30"], ["#4A6A8A", "#213546"], ["#7A6A2A", "#3F3616"]];

/** WatchPartySeat.avatarGradient: djb2 over the id's scalars, in Swift's wrapping Int. */
export function avatarColors(id: string): readonly [string, string] {
    let hash = 5381n;
    for (const scalar of id) hash = BigInt.asIntN(64, hash * 33n + BigInt(scalar.codePointAt(0) ?? 0));
    const index = Number((hash < 0n ? -hash : hash) % BigInt(PALETTE.length));
    return PALETTE[index] ?? PALETTE[0] as readonly [string, string];
}

function seat(member: RoomMember, phase: Room["phase"]): HTMLElement {
    const state = seatState(member, phase);
    const node = el("div", "watch-party-seat");
    node.dataset.state = state;
    const [from, to] = avatarColors(member.userId);
    const disc = el("span", "watch-party-seat-disc", member.displayName.trim().slice(0, 1).toUpperCase());
    disc.style.background = `linear-gradient(135deg, ${from}, ${to})`;
    const ring = document.createElementNS(SVG, "svg");
    ring.setAttribute("viewBox", "0 0 146 146");
    ring.setAttribute("class", "watch-party-seat-ring");
    ring.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS(SVG, "circle");
    circle.setAttribute("cx", "73"); circle.setAttribute("cy", "73"); circle.setAttribute("r", "70.75");
    circle.setAttribute("fill", "none");
    if (state === "away") circle.setAttribute("stroke-dasharray", "0.1 13.5");
    else if (state !== "ready" && state !== "watching") circle.setAttribute("stroke-dasharray", "13.5 9.9");
    ring.appendChild(circle);
    const avatar = el("span", "watch-party-seat-avatar");
    avatar.append(disc, ring);
    if (state === "ready" || state === "watching") {
        const tick = el("span", "watch-party-seat-tick");
        tick.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7"/></svg>';
        avatar.appendChild(tick);
    }
    const status = STATUS_KEY[state];
    const statusText = status === undefined ? undefined : translate(status);
    const detail = [member.isHost ? translate("watchParty.seat.host") : undefined, member.isSelf ? translate("watchParty.seat.you") : undefined, statusText].filter((part): part is string => part !== undefined).join(" · ");
    node.append(avatar, el("span", "watch-party-seat-name", member.displayName), ...(detail === "" ? [] : [el("span", "watch-party-seat-detail", detail)]));
    // WatchPartySeat.accessibilityText: the name, then you, host and the state, in the order Apple joins them.
    const stateText = statusText ?? translate(state === "watching" ? "watchParty.seat.a11yWatching" : "watchParty.seat.a11yReady");
    node.setAttribute("aria-label", [member.displayName, member.isSelf ? translate("watchParty.seat.youLower") : "", member.isHost ? translate("watchParty.seat.a11yHost") : "", stateText].filter(part => part !== "").join(", "));
    return node;
}

/** WatchPartyInviteSeatLabel: the dashed "+" seat that opens the invitation. */
function inviteSeat(onInvite: () => void): FocusItem {
    const item = actionButton("invite", "", onInvite);
    item.element.classList.add("watch-party-seat", "watch-party-seat-invite");
    item.element.setAttribute("aria-label", translate("watchParty.invite.friends"));
    const avatar = el("span", "watch-party-seat-avatar");
    avatar.append(icon("M12 4v16M4 12h16"));
    item.element.append(avatar, el("span", "watch-party-seat-name", translate("watchParty.seat.invite")));
    return item;
}

/** "Here now" and the room's presence summary over a seat for every member, then the Invite seat. */
export function seatsRow(members: readonly RoomMember[], phase: Room["phase"], onInvite: () => void): { readonly node: HTMLElement; readonly invite: FocusItem } {
    const heading = el("div", "watch-party-here-heading");
    heading.append(eyebrow(translate("watchParty.seats.hereNow")), el("span", "watch-party-presence", presenceSummary(members, phase)));
    const invite = inviteSeat(onInvite);
    const seats = el("div", "watch-party-seats");
    seats.append(...ordered(members).map(member => seat(member, phase)), invite.element);
    const node = el("div", "watch-party-here");
    node.setAttribute("role", "group");
    node.setAttribute("aria-label", translate("watchParty.seats.members"));
    node.append(heading, seats);
    return { node, invite };
}
