// Apple's WatchPartyLobbyPolicy: seat states, the presence summary, the host's hint and the lobby's one action.

import type { Room, RoomMember, WatchTogetherCapabilities } from "../contracts/v2/watchTogether.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";

export type SeatState = "ready" | "notReady" | "away" | "watching" | "joining" | "buffering" | "syncing";

/** WatchPartyLobbyPolicy.seatState. The host starts playback, so the host never has to mark ready. */
export function seatState(member: RoomMember, phase: Room["phase"]): SeatState {
    if (!member.connected) return "away";
    if (phase === "lobby") return member.isHost || member.lobbyReady ? "ready" : "notReady";
    if (member.isBuffering) return "buffering";
    if (member.isSyncing) return "syncing";
    return member.isReady ? "watching" : "joining";
}

/** WatchPartyLobbyPolicy.presenceSummary: "2 of 3 ready". */
export function presenceSummary(members: readonly RoomMember[], phase: Room["phase"]): string {
    const here = members.filter(member => member.connected);
    if (here.length <= 1) return translate(here.length === 1 ? "watchParty.presence.onlyYou" : "watchParty.presence.nobody");
    const wanted: SeatState = phase === "lobby" ? "ready" : "watching";
    const count = integerText(here.filter(member => seatState(member, phase) === wanted).length);
    return phase === "lobby" ? translate("watchParty.presence.ready", { ready: count, total: here.length }) : translate("watchParty.presence.watching", { watching: count, total: here.length });
}

/** WatchPartyLobbyPolicy.waitingNames: connected guests who have not marked ready, for the host's advisory hint. */
export function waitingNames(members: readonly RoomMember[]): string[] {
    return members.filter(member => member.connected && !member.isHost && !member.lobbyReady).map(member => member.displayName);
}

/**
 * The one action the lobby foregrounds, WatchPartyLobbyPolicy.primaryAction. `canStart` is
 * WatchPartySession.canStartPlayback. `selectionUnavailable` is a title hidden from this profile: a guest
 * has nothing to ready up for or return to. A vote room's host starts the winner, or suggests while
 * nobody has voted; a guest marks Ready when the server takes lobby readiness.
 */
export type PrimaryAction = "chooseTitle" | "start" | "waitingForVotes" | "ready" | "returnToPlayback" | "returnToLobby" | "none";

export function primaryAction(room: Room, capabilities: WatchTogetherCapabilities | undefined, canStart: boolean, selectionUnavailable = false, playbackEnded = false): PrimaryAction {
    if (room.phase === "playing") {
        if (playbackEnded) return room.selfCanManageRoom && capabilities?.stopPlayback === true ? "returnToLobby" : "none";
        return selectionUnavailable && !room.selfCanManageRoom ? "none" : "returnToPlayback";
    }
    if (room.phase !== "lobby") return "none";
    if (selectionUnavailable && !room.selfCanManageRoom) return "none";
    if (room.selfCanManageRoom) {
        if (room.selectionMode === "vote") return canStart ? "start" : "waitingForVotes";
        if (room.selectedContentId === undefined) return "chooseTitle";
        return canStart ? "start" : "chooseTitle";
    }
    return capabilities?.lobbyReady === true && room.members.some(member => member.isSelf) ? "ready" : "none";
}
