// Apple's WatchPartySession for the Watch Party hub: the support probe, Start a party, Join party and
// the open room. The host stages a title, starts and stops playback, sets who chooses and who controls,
// and ends the party; each answer is the room as it now stands. The room socket (watchPartySocket.ts)
// keeps the room current for everyone between those answers, as Apple's, which never polls. Guests mark
// Ready over the socket, and in a vote room everyone suggests and votes (watchPartyVotes.ts).

import { ApiError } from "../api/errors.ts";
import { type Clock, sleep, systemClock } from "../api/clock.ts";
import { errorState, type ErrorState, writeMayHaveApplied } from "./browseRoutes.ts";
import type { Card, Episode, Season } from "../contracts/v2/catalog.ts";
import type { CreatableSelectionMode, GuestControlPolicy, MemberState, PickerEntry, Room, RoomAccess, RoomSelection, WatchTogetherCapabilities } from "../contracts/v2/watchTogether.ts";
import type { PlayRequest } from "./browseModel.ts";
import { type LobbyItem, type MediaChoice, lobbyItemFromDetail } from "./watchPartyChoice.ts";
import { supportsSynchronizedParty, uuidV4, type WatchPartyApi, watchPartyFailureText } from "./watchPartyApi.ts";
import { browserSocket, type ConnectionStatus, RoomConnection, type RoomEnd, type RoomSocketFactory, RoomState } from "./watchPartySocket.ts";
import type { RoomServerMessage, Suggestion } from "../contracts/v2/watchTogether.ts";
import { RoomVotes, voteWinner } from "./watchPartyVotes.ts";
import type { MessageArgs } from "../i18n/icu.ts";
import { serverText, translate, type MessageKey } from "../i18n/translate.ts";

export { supportsSynchronizedParty, uuidV4, watchPartyApi, watchPartyFailureText, type WatchPartyApi } from "./watchPartyApi.ts";

const PLAYABLE_TYPES: readonly string[] = ["movie", "series", "episode"];
/** Apple's WatchPartyMediaPicker.skippedHomeSectionTypes: skip personal rows and per-library recently added rows. */
const SKIPPED_HOME_SECTION_TYPES: ReadonlySet<string> = new Set([
    "recently_added", "recently_released", "new_to_library", "continue_watching", "next_up",
    "next_in_series", "watchlist", "favorites", "profile_activity_feed", "because_you_watched",
    "recommended_for_you", "similar_users_liked", "taste_match", "forgotten_favorites",
]);
const MAX_HOME_SECTIONS = 4;
const SEARCH_DEBOUNCE_MS = 300;

/** The pages of one open room. Back steps through them in order. */
export type LobbyPage =
    | { readonly kind: "lobby" }
    | { readonly kind: "options" }
    | { readonly kind: "end" }
    | { readonly kind: "invite" }
    | { readonly kind: "picker" }
    | { readonly kind: "search" }
    | { readonly kind: "choice"; readonly choice: MediaChoice; readonly from?: LobbyPage }
    /** Apple's episode picker: the series' season tabs over the chosen season's episodes. */
    | { readonly kind: "episodes"; readonly series: Card; readonly season: Season | undefined; readonly from?: LobbyPage; readonly initialEpisodeId?: string };

/** `title` is read when the shelf is drawn, so a language that lands after the shelves load relabels them. */
export interface PickerShelf { readonly id: string; readonly title: () => string; readonly entries: readonly PickerEntry[] }

export interface PickerSearchState {
    query: string;
    /** The trimmed query that produced `results`; prevents Done from jumping into stale results during the debounce window. */
    completedQuery: string;
    /** Stable identity key for `feedGrid` across `loadMoreSearch()` appends; rotates on each fresh search. */
    feedKey: object;
    results: readonly Card[];
    total: number;
    nextCursor: string | undefined;
    searching: boolean;
    hasSearched: boolean;
    error: ErrorState | undefined;
}

const emptySearch = (): PickerSearchState => ({ query: "", completedQuery: "", feedKey: {}, results: [], total: 0, nextCursor: undefined, searching: false, hasSearched: false, error: undefined });

/** A notice is the server's own text, or a catalog message read when it is drawn, so a language file that lands later relabels it. */
export type Notice = string | { readonly key: MessageKey; readonly args?: MessageArgs };
export const noticeText = (notice: Notice): string => typeof notice === "string" ? notice : translate(notice.key, notice.args);

export interface WatchPartyState {
    supported: boolean;
    /** Apple isCheckingSupport: the hub's own check is running. */
    checking: boolean;
    /** A create, join or room change is running. */
    busy: boolean;
    /** Apple errorMessage, shown in the warning banner. */
    error: Notice | undefined;
    /** The open room, as the newest answer or socket snapshot left it. */
    room: Room | undefined;
    /** Apple's connection dot: the room socket while a room is open, idle otherwise. */
    connection: ConnectionStatus | "idle";
    /** What the server said it can do; read with the support check. */
    capabilities: WatchTogetherCapabilities | undefined;
    page: LobbyPage;
    /** The room's chosen title, from the host's pick until the catalog answers, then from the catalog. */
    selected: LobbyItem | undefined;
    /** The catalog refused the chosen title for this profile (Apple selectedItemUnavailable). */
    selectedUnavailable: boolean;
    shelves: readonly PickerShelf[];
    shelvesLoading: boolean;
    shelvesError: string | undefined;
    /** The seasons or episodes of the series being browsed. */
    seasons: readonly Season[] | undefined;
    episodes: readonly Episode[] | undefined;
    browseLoading: boolean;
    browseError: string | undefined;
    /** The vote-mode ballot: every suggestion with its tally, and this profile's own votes. */
    votes: RoomVotes;
    /** What the picker's confirmation does: stage the host's pick, or put the title on the ballot. */
    pickerPurpose: PickerPurpose;
    /** Apple's WatchPartySearchPage state inside the picker. */
    search: PickerSearchState;
    /** Apple's "Who's seen it" member watch history for the current choice. */
    memberState: MemberState | undefined;
    memberStateLoading: boolean;
    memberStateError: Notice | undefined;
}

export type PickerPurpose = "select" | "suggest";

export interface WatchPartyHubOptions {
    /** The answer the entry point was offered on. */
    readonly supported?: boolean;
    readonly onSupport?: (supported: boolean) => void;
    /** Back from the lobby: the entry opens afresh on its first control, not where focus moved while a request ran. */
    readonly onLeave?: () => void;
    /** The host started the party, or Return to playback: open the player on the room's file. There is no sync yet. */
    readonly onPlay?: (request: PlayRequest) => void;
    readonly describe?: (error: unknown) => string;
    readonly uuid?: () => string;
    /** The room socket's WebSocket and timers; tests pass a fake socket and a manual clock. */
    readonly socket?: RoomSocketFactory;
    readonly clock?: Clock;
}

/** Apple waits this long after a socket update before reading the ballot, so a burst of votes reads once. */
const SUGGESTIONS_REFRESH_MS = 200;
/** Reads the ballot this many times while socket updates keep overtaking it. */
const SUGGESTIONS_READ_ATTEMPTS = 3;
/** Failed ballot reads retried in the background before waiting for the next socket update. */
const SUGGESTIONS_REFRESH_RETRIES = 3;
const SUGGESTIONS_STALE = "The suggestions kept changing while they were read.";

const END_KEY: Record<RoomEnd, MessageKey> = { ended: "watchParty.ended.ended", expired: "watchParty.ended.expired", replaced: "watchParty.ended.replaced" };

const LOBBY: LobbyPage = { kind: "lobby" };

const isConflict = (error: unknown): boolean => error instanceof ApiError && error.failure.kind === "problem" && error.failure.problem.status === 409;
/** Apple isAccessRefusal: the profile cannot see the title at all. */
const isRefusal = (error: unknown): boolean => error instanceof ApiError && error.failure.kind === "problem" && (error.failure.problem.status === 403 || error.failure.problem.status === 404);

export class WatchPartyHub {
    readonly state: WatchPartyState;
    private readonly api: WatchPartyApi;
    private readonly notify: () => void;
    private readonly options: WatchPartyHubOptions;
    private readonly describe: (error: unknown) => string;
    private readonly controller = new AbortController();
    private stopped = false;
    /** The room's membership proof from the last answer; the picker sends it. Never logged or stored. */
    private roomToken = "";
    /** Counts rooms and picker reads, so a late answer for an older one is dropped. */
    private epoch = 0;
    /** Counts season and episode reads; leaving the page ends them. The picker's read is not tied to its page, so backing out does not strand it. */
    private browseEpoch = 0;
    /** Counts picker search requests and debounce timers so stale queries are dropped. */
    private searchEpoch = 0;
    /** Counts member-state reads for the Choice page so late answers for another title are dropped. */
    private memberStateEpoch = 0;
    private refocus = false;
    private ending = false;
    /** A lost change was not read back because the party was ending; a failed close reads it then. */
    private unreconciled = false;
    /** Which room answer is current; one per open room. */
    private rooms = new RoomState();
    private connection: RoomConnection | undefined;
    /** Settles when the running host change does, so End party can go after it. */
    private mutation: Promise<void> | undefined;
    /** Counts ballot reads; a vote, a suggestion or leaving the room drops the one that is running. */
    private suggestionsEpoch = 0;
    /** The notice the last failed ballot read raised, so the read that succeeds clears that notice and no other. */
    private refreshFailure: Notice | undefined;
    private suggestionsRefreshing = false;
    /** A ballot read was due while a change ran; it runs once that change finishes. */
    private refreshPending = false;

    constructor(api: WatchPartyApi, notify: () => void, options: WatchPartyHubOptions = {}) {
        this.api = api;
        this.notify = notify;
        this.options = options;
        this.describe = options.describe ?? watchPartyFailureText;
        this.state = {
            supported: options.supported ?? false, checking: false, busy: false, error: undefined, room: undefined, connection: "idle", capabilities: undefined,
            page: LOBBY, selected: undefined, selectedUnavailable: false, shelves: [], shelvesLoading: false, shelvesError: undefined,
            seasons: undefined, episodes: undefined, browseLoading: false, browseError: undefined, votes: new RoomVotes(), pickerPurpose: "select", search: emptySearch(),
            memberState: undefined, memberStateLoading: false, memberStateError: undefined,
        };
    }

    /** WatchPartySession.refreshCapabilities. A failed read keeps the last answer and says why. */
    async check(): Promise<void> {
        if (this.state.checking || this.stopped) return;
        this.state.checking = true;
        this.notify();
        await this.load();
        if (this.stopped) return;
        this.state.checking = false;
        this.notify();
    }

    async create(mode: CreatableSelectionMode): Promise<boolean> {
        return this.enter(signal => this.api.createRoom(this.options.uuid?.() ?? uuidV4(), mode, signal));
    }

    async join(invitation: string): Promise<void> {
        const value = invitation.trim();
        if (value === "") { this.fail({ key: "watchParty.error.codeRequired" }); return; }
        // The native contract joins by code only; invitation links come with the lobby work.
        if (value.includes("://")) { this.fail({ key: "watchParty.error.invalidInvitation" }); return; }
        await this.enter(signal => this.api.joinByCode(value, signal));
    }

    // --- Lobby state ---

    /** WatchPartySession.canStartPlayback: a vote room starts its winner; a host-pick room needs a staged selection, as on Apple. */
    canStart(): boolean {
        const { room, capabilities } = this.state;
        if (room?.selfCanManageRoom !== true || room.phase !== "lobby") return false;
        if (room.selectionMode === "vote") return this.winner() !== undefined;
        return room.selectionMode === "host_pick" && capabilities?.stagedSelection === true && room.selectedContentId !== undefined;
    }

    /** Connected, and the ballot has been read on this connection. */
    ballotCurrent(): boolean { return this.state.connection === "connected" && this.state.votes.current; }

    /** The suggestion with the most votes, or none while nobody has voted. */
    winner(): Suggestion | undefined { return voteWinner(this.state.votes.rows); }

    /** Whether the next render should drop the focus it carries: shelves that arrive claim focus for the first title, as Apple's picker does. */
    takeRefocus(): boolean {
        const refocus = this.refocus;
        this.refocus = false;
        return refocus;
    }

    show(page: LobbyPage): void {
        // Leaving a page ends its season, episode, and member-state reads: a late answer must not undo the move.
        this.browseEpoch++;
        this.memberStateEpoch++;
        this.state.browseLoading = false;
        this.state.memberStateLoading = false;
        this.state.memberStateError = undefined;
        this.state.page = page;
        if (page.kind === "choice" && this.state.capabilities?.memberState === true) {
            void this.refreshMemberState([page.choice.contentId]);
            return;
        }
        this.notify();
    }

    /** Apple's WatchPartySession.refreshMemberState: loads per-member watch history for "Who's seen it". */
    async refreshMemberState(contentIds: readonly string[]): Promise<void> {
        const room = this.state.room;
        if (room === undefined || this.state.capabilities?.memberState !== true || this.api.memberState === undefined || this.stopped) {
            this.notify();
            return;
        }
        const maxIds = this.state.capabilities.maxMemberStateIds > 0 ? Math.min(200, this.state.capabilities.maxMemberStateIds) : 200;
        const seen = new Set<string>();
        const ids: string[] = [];
        for (const id of contentIds) {
            if (id === "" || seen.has(id)) continue;
            seen.add(id);
            ids.push(id);
            if (ids.length === maxIds) break;
        }
        if (ids.length === 0) { this.notify(); return; }
        const epoch = ++this.memberStateEpoch;
        this.state.memberState = undefined;
        this.state.memberStateLoading = true;
        this.state.memberStateError = undefined;
        this.notify();
        try {
            const result = await this.api.memberState(room.roomId, this.roomToken, ids, this.controller.signal);
            if (this.stopped || epoch !== this.memberStateEpoch || this.state.room?.roomId !== room.roomId) return;
            this.state.memberState = result;
        } catch (error) {
            if (this.stopped || epoch !== this.memberStateEpoch || this.state.room?.roomId !== room.roomId) return;
            this.state.memberStateError = { key: "watchParty.whoSeen.error", args: { error: this.describe(error) } };
        }
        if (this.stopped || epoch !== this.memberStateEpoch) return;
        this.state.memberStateLoading = false;
        this.notify();
    }

    /** Back inside an open room: one page at a time; from the lobby returns false so the host dismisses without leaving. */
    back(): boolean {
        const page = this.state.page;
        switch (page.kind) {
            case "lobby": return false;
            case "search": this.show({ kind: "picker" }); return true;
            case "choice": this.show(page.from ?? { kind: "picker" }); return true;
            case "episodes": this.show(page.from ?? { kind: "picker" }); return true;
            default: this.show(LOBBY); return true;
        }
    }

    /** Apple's WatchPartySession.select: the staged call in a host-pick lobby, the live selection otherwise. */
    async stage(choice: MediaChoice): Promise<boolean> {
        const { room, capabilities } = this.state;
        if (room?.selectionMode !== "host_pick") return false;
        const selection: RoomSelection = { contentId: choice.contentId };
        const staged = room.phase === "lobby" && capabilities?.stagedSelection === true;
        const before = this.state.selected;
        const picked = this.mutate(
            signal => staged ? this.api.stageSelection(room.roomId, selection, signal) : this.api.selectItem(room.roomId, selection, signal),
            () => { this.state.selected = choice.lobby; this.state.selectedUnavailable = false; },
            // A live selection whose answer is lost has taken effect when the room holds the title at a higher selection revision:
            // the same title at the same revision may be the one that was already playing.
            staged ? undefined : now => now.selectedContentId === choice.contentId && now.selectionRevision > room.selectionRevision,
        );
        const done = await picked;
        if (!done && !this.stopped && this.state.selected?.contentId === choice.contentId) this.state.selected = before;
        if (done) {
            this.show(LOBBY);
            // Choosing for a party that is already playing starts it for everyone, as the button says.
            if (!staged && !this.ending) this.resume();
        }
        return done;
    }

    /** Start for everyone, or in a vote room Start the winner by promoting it. Opens the player when the server says the party is playing. */
    async start(): Promise<boolean> {
        if (!this.canStart()) return false;
        const roomId = this.requireRoom().roomId;
        const winner = this.state.room?.selectionMode === "vote" ? this.winner() : undefined;
        // A ballot from before an outage may name a stale winner, so a vote room starts only once this connection has read it.
        if (winner !== undefined && !this.ballotCurrent()) return false;
        const started = winner === undefined
            ? await this.mutate(signal => this.api.startPlayback(roomId, signal), undefined, room => room.phase === "playing")
            : await this.mutate(signal => this.api.promoteSuggestion(roomId, this.roomToken, winner.id, signal), undefined, room => room.phase === "playing" && room.selectedContentId === winner.contentId);
        if (started && !this.ending) this.resume();
        return started;
    }

    /** WatchPartySession.setLobbyReady: a frame on the room socket; the snapshot that follows shows it. Dropped while the socket is not open. */
    setReady(ready: boolean): boolean {
        if (this.state.room?.phase !== "lobby" || this.state.capabilities?.lobbyReady !== true) return false;
        return this.connection?.send({ type: "lobby_ready", ready }) === true;
    }

    /** Votes for a suggestion, or takes the vote back. Refused until this profile's vote on it is known. */
    async vote(suggestionId: string, voted: boolean): Promise<boolean> {
        if (this.state.votes.voted(suggestionId) === undefined) return false;
        return this.changeBallot(async (roomId, signal) => {
            await this.api.setVote(roomId, this.roomToken, suggestionId, voted, signal);
            // The server took the vote: keep it even if the read that follows fails, so the card does not offer the same vote again.
            this.state.votes.confirm(suggestionId, voted);
        });
    }

    /** Apple's Add suggestion: the picker's title goes on the ballot, and the lobby comes back. */
    async suggest(choice: MediaChoice): Promise<boolean> {
        if (choice.type !== "movie" && choice.type !== "episode") return false;
        // Read once, as it goes to the server: the label is the shown language's at this moment.
        const subtitle = choice.subtitle();
        const suggestion = {
            suggestionId: this.options.uuid?.() ?? uuidV4(), contentId: choice.contentId, contentType: choice.type, title: choice.title,
            ...(subtitle === undefined ? {} : { subtitle }), ...(choice.posterUrl === undefined ? {} : { posterUrl: choice.posterUrl }),
        } as const;
        const added = await this.changeBallot(async (roomId, signal) => { await this.api.addSuggestion(roomId, this.roomToken, suggestion, signal); });
        if (added) this.show(LOBBY);
        return added;
    }

    /** Return to playback: the player opens on the room's file, from the room's anchor. */
    resume(): void {
        const room = this.state.room;
        if (room?.phase !== "playing" || room.selectedContentId === undefined || room.selectedFileId === undefined) return;
        this.options.onPlay?.({ contentId: room.selectedContentId, fileId: room.selectedFileId, title: this.state.selected?.title() ?? translate("watchParty.title"), startSeconds: room.anchorPositionSeconds, allowAlternateVersions: false, watchParty: true });
    }

    async stopPlayback(): Promise<boolean> {
        if (this.state.capabilities?.stopPlayback !== true || this.state.room?.phase !== "playing") return false;
        return this.mutate(signal => this.api.stopPlayback(this.requireRoom().roomId, signal));
    }

    async setMode(mode: CreatableSelectionMode): Promise<boolean> {
        if (this.state.capabilities?.selectionModeSwitch !== true || this.state.room?.phase !== "lobby") return false;
        return this.mutate(signal => this.api.setSelectionMode(this.requireRoom().roomId, mode, signal));
    }

    async setPolicy(policy: Exclude<GuestControlPolicy, "unknown">): Promise<boolean> {
        return this.mutate(signal => this.api.setGuestControlPolicy(this.requireRoom().roomId, policy, signal));
    }

    /** WatchPartySession.endParty: closes the room for everyone, then leaves it with Apple's "This party has ended.". */
    async endParty(): Promise<void> {
        const room = this.state.room;
        if (room?.selfCanManageRoom !== true || this.ending || this.stopped) return;
        this.ending = true;
        try {
            // The confirmation has already closed, so a refused End would leave no feedback: wait for a running change instead, so the two never overlap.
            await this.mutation;
            if (this.stopped || this.state.room?.roomId !== room.roomId) return;
            this.state.busy = true;
            this.state.error = undefined;
            this.notify();
            await this.api.closeRoom(room.roomId, this.controller.signal).catch((error: unknown) => { if (!isConflict(error)) throw error; });
            if (this.stopped || this.state.room?.roomId !== room.roomId) return;
            this.state.busy = false;
            this.terminate("ended");
        } catch (error) {
            // The socket may have ended the party meanwhile; its reason stays.
            if (!this.stopped && this.state.room?.roomId === room.roomId) this.state.error = this.describe(error);
            // The party goes on, so the change that was not read back may have landed. Read it in the background: the failure shows and End can be retried meanwhile.
            if (this.unreconciled && !this.stopped) void this.readRoom(room.roomId).then(() => { if (!this.stopped) this.notify(); });
        } finally {
            this.ending = false;
            this.unreconciled = false;
            if (!this.stopped) { this.state.busy = false; this.notify(); }
        }
    }

    /** The picker: group picks, watchlists, Home discovery rows, and recently added movies/series. */
    async openPicker(purpose: PickerPurpose = "select"): Promise<void> {
        const epoch = ++this.epoch;
        this.state.page = { kind: "picker" };
        this.state.pickerPurpose = purpose;
        this.state.shelvesLoading = true;
        this.state.shelvesError = undefined;
        this.notify();
        const { shelves, error } = await this.loadShelves();
        if (this.stale(epoch)) return;
        if (shelves.length > 0 || error === undefined) this.state.shelves = shelves;
        this.state.shelvesError = error;
        this.state.shelvesLoading = false;
        this.refocus = this.state.page.kind === "picker" && this.state.shelves.length > 0;
        this.notify();
    }

    /** Apple's WatchPartySearchPage: opens catalog search scoped to playable movies and series. */
    openSearch(): void {
        this.searchEpoch++;
        this.state.search = emptySearch();
        this.show({ kind: "search" });
    }

    /** Updates the search query and schedules a debounced search, or resets to the initial state when cleared. */
    setSearchQuery(query: string): void {
        const epoch = ++this.searchEpoch;
        this.state.search.query = query;
        const trimmed = query.trim();
        if (trimmed === "") {
            this.state.search = emptySearch();
            this.notify();
            return;
        }
        this.state.search.error = undefined;
        void (async () => {
            try {
                await sleep(this.options.clock ?? systemClock, SEARCH_DEBOUNCE_MS, this.controller.signal, () => new Error("stopped"));
            } catch { return; }
            if (this.stopped || epoch !== this.searchEpoch) return;
            await this.runSearch(trimmed, undefined, epoch);
        })();
    }

    /** Runs the current picker search immediately without waiting for the debounce timer. */
    async searchNow(query?: string): Promise<void> {
        const next = query ?? this.state.search.query;
        const epoch = ++this.searchEpoch;
        this.state.search.query = next;
        const trimmed = next.trim();
        if (trimmed === "") {
            this.state.search = emptySearch();
            this.notify();
            return;
        }
        await this.runSearch(trimmed, undefined, epoch);
    }

    /** Loads the next page of picker search results when available. */
    async loadMoreSearch(): Promise<void> {
        const { query, nextCursor, searching } = this.state.search;
        const trimmed = query.trim();
        if (trimmed === "" || nextCursor === undefined || searching) return;
        await this.runSearch(trimmed, nextCursor, this.searchEpoch);
    }

    /** The series' seasons with one season's episodes: the one asked for, else the first that is not specials. A retry reads the seasons again only when there are none to show. */
    async openEpisodes(series: Card, wanted?: Season | number, retry = false, from?: LobbyPage, initialEpisodeId?: string): Promise<void> {
        const epoch = ++this.browseEpoch;
        const currentPage = this.state.page.kind === "episodes" ? this.state.page : undefined;
        const sameSeries = currentPage?.series.id === series.id;
        const origin = from ?? (sameSeries ? currentPage?.from : undefined);
        const episodeTarget = initialEpisodeId ?? (sameSeries ? currentPage?.initialEpisodeId : undefined);
        const wantedSeason = typeof wanted === "number" ? undefined : wanted;
        const wantedNumber = typeof wanted === "number" ? wanted : wanted?.seasonNumber;
        Object.assign(this.state, {
            page: { kind: "episodes", series, season: wantedSeason, ...(origin === undefined ? {} : { from: origin }), ...(episodeTarget === undefined ? {} : { initialEpisodeId: episodeTarget }) },
            episodes: undefined, browseLoading: true, browseError: undefined,
            ...(sameSeries && !(retry && (wantedNumber === undefined || this.state.seasons?.length === 0)) ? {} : { seasons: undefined }),
        });
        this.notify();
        await this.browse(epoch, async signal => {
            const seasons = this.state.seasons ?? await this.api.seasons(series.id, signal);
            if (this.staleBrowse(epoch)) return;
            this.state.seasons = seasons;
            const season = (wantedNumber === undefined ? undefined : seasons.find(candidate => candidate.seasonNumber === wantedNumber))
                ?? wantedSeason
                ?? seasons.find(candidate => candidate.isSpecials !== true)
                ?? seasons[0];
            if (season === undefined) return;
            this.state.page = { kind: "episodes", series, season, ...(origin === undefined ? {} : { from: origin }), ...(episodeTarget === undefined ? {} : { initialEpisodeId: episodeTarget }) };
            const episodes = await this.api.episodes(series.id, season.seasonNumber, signal);
            if (this.staleBrowse(epoch)) return;
            this.state.episodes = [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
        });
    }

    /**
     * Leave party: Apple's leaveRoom closes this viewer's socket and nothing else. A host who leaves is
     * away, and the server holds the party for them; End party is what ends it for everyone.
     */
    leave(): void {
        this.reset();
        this.state.error = undefined;
        this.options.onLeave?.();
        this.notify();
    }

    /** The page went away, or the account or profile changed: the socket closes and the room is left as Leave leaves it. */
    stop(): void {
        this.stopped = true;
        this.controller.abort();
        this.reset();
    }

    private requireRoom(): Room {
        if (this.state.room === undefined) throw new Error("No open room");
        return this.state.room;
    }

    private stale(epoch: number): boolean { return this.stopped || epoch !== this.epoch; }

    private staleBrowse(epoch: number): boolean { return this.stopped || epoch !== this.browseEpoch; }

    private reset(): void {
        this.epoch++;
        this.browseEpoch++;
        this.searchEpoch++;
        this.memberStateEpoch++;
        this.roomToken = "";
        this.connection?.close();
        this.connection = undefined;
        this.rooms = new RoomState();
        this.suggestionsEpoch++;
        this.suggestionsRefreshing = false;
        this.refreshPending = false;
        Object.assign(this.state, {
            room: undefined, connection: "idle", page: LOBBY, selected: undefined, selectedUnavailable: false, shelves: [], shelvesLoading: false, shelvesError: undefined,
            seasons: undefined, episodes: undefined, browseLoading: false, browseError: undefined, votes: new RoomVotes(), pickerPurpose: "select", search: emptySearch(),
            memberState: undefined, memberStateLoading: false, memberStateError: undefined,
        });
    }

    /** Takes the token an answer carries, and its room when that is still current (WatchPartySession.accept). */
    private accept(answer: RoomAccess, requestReceipt?: number): boolean {
        this.roomToken = answer.roomAccessToken;
        return this.take(answer.room, requestReceipt);
    }

    /** A room from an answer or a snapshot. An older one is dropped; an ended one ends the party. A new selection reloads the title; the pick the host just made shows until it lands. */
    private take(room: Room, requestReceipt?: number): boolean {
        const previous = this.state.room;
        if (!this.rooms.accept(room, requestReceipt)) return false;
        if (room.phase === "ended") { this.terminate("ended"); return false; }
        this.state.room = room;
        if (room.selectionMode === "vote" && previous !== undefined && previous.selectionMode !== "vote") this.refreshSuggestions();
        const id = room.selectedContentId;
        if (id === previous?.selectedContentId && (id === undefined || this.state.selected !== undefined)) return true;
        this.state.selectedUnavailable = false;
        if (id === undefined) { this.state.selected = undefined; return true; }
        if (this.state.selected?.contentId !== id) this.state.selected = undefined;
        void this.refreshSelected(room.roomId, id);
        return true;
    }

    /** WatchPartySession.terminate: the room is over for this viewer, who returns to the entry with the reason. */
    private terminate(reason: RoomEnd): void {
        this.reset();
        this.state.error = { key: END_KEY[reason] };
        this.options.onLeave?.();
        this.notify();
    }

    /** Opens the room socket for the room just entered (WatchPartySession.startConnection). */
    private connect(roomId: string): void {
        this.connection = new RoomConnection(roomId, this.api, {
            token: () => this.roomToken,
            receipt: () => this.rooms.receipt,
            access: (answer, receipt) => { if (this.accept(answer, receipt)) this.notify(); },
            message: message => { this.receive(message); },
            status: status => {
                this.state.connection = status;
                // Every connection reads the ballot afresh before its winner can be started.
                this.state.votes.current = false;
                if (status === "connected") this.state.error = undefined;
                this.notify();
                if (status === "connected") this.refreshSuggestions();
            },
            end: reason => { this.terminate(reason); },
        }, { socket: this.options.socket ?? browserSocket, clock: this.options.clock ?? systemClock });
    }

    /** WatchPartySession.receive for the lobby. Transport commands belong to synchronized playback. */
    private receive(message: RoomServerMessage): void {
        switch (message.type) {
            case "snapshot": if (this.take(message.room)) this.notify(); return;
            case "suggestions_update": {
                const roomId = this.state.room?.roomId;
                if (roomId === undefined || !message.suggestions.every(row => row.roomId === roomId)) return;
                this.state.votes.receive(message.suggestions);
                this.notify();
                this.refreshSuggestions();
                return;
            }
            case "room_closed": this.terminate("ended"); return;
            case "connection_replaced": this.terminate("replaced"); return;
            case "error":
                if (message.code === "connection_replaced") { this.terminate("replaced"); return; }
                // A bad_request refuses a playback report or attach; the lobby sends neither.
                if (message.code === "bad_request") return;
                this.state.error = message.message;
                this.notify();
                return;
            default: return;
        }
    }

    private async refreshSelected(roomId: string, contentId: string): Promise<void> {
        try {
            const item = lobbyItemFromDetail(await this.api.item(contentId, this.controller.signal));
            if (this.stopped || this.state.room?.roomId !== roomId || this.state.room.selectedContentId !== contentId) return;
            this.state.selected = item;
        } catch (error) {
            // The title's details are optional, but a refusal means this profile cannot see it and playback will be refused too.
            if (this.stopped || this.state.room?.roomId !== roomId || this.state.room.selectedContentId !== contentId || !isRefusal(error)) return;
            this.state.selectedUnavailable = true;
            this.state.selected = undefined;
        }
        this.notify();
    }

    /**
     * One host change at a time, as Apple's `mutate`: a second call while one runs is ignored, so the controls stay enabled
     * and focus is not thrown out. The answer replaces the room; a refusal shows the server's reason and keeps the room.
     */
    private async mutate(operation: (signal: AbortSignal) => Promise<RoomAccess>, begin?: () => void, applied?: (room: Room) => boolean): Promise<boolean> {
        const room = this.state.room;
        if (room?.selfCanManageRoom !== true || this.state.busy || this.ending || this.stopped) return false;
        const receipt = this.rooms.receipt;
        this.state.busy = true;
        this.state.error = undefined;
        let settle: () => void = () => undefined;
        this.mutation = new Promise<void>(resolve => { settle = resolve; });
        begin?.();
        this.notify();
        try {
            const answer = await operation(this.controller.signal);
            if (this.stopped || this.state.room?.roomId !== room.roomId) return false;
            this.accept(answer, receipt);
            return true;
        } catch (error) {
            if (this.stopped || this.state.room?.roomId !== room.roomId) return false;
            const failure = this.describe(error);
            this.state.error = failure;
            // A non-retryable change whose answer never came may have landed: read the room so the lobby does not stay behind it,
            // and count the change as done when the room proves it, so it is not sent a second time.
            if (applied !== undefined && !this.stopped && this.ending && writeMayHaveApplied(error)) this.unreconciled = true;
            else if (applied !== undefined && !this.stopped && writeMayHaveApplied(error)) {
                const now = await this.readRoom(room.roomId);
                if (now !== undefined && applied(now)) {
                    // Only this write's own failure goes; a socket error that arrived meanwhile stays.
                    if (this.state.error === failure) this.state.error = undefined;
                    return true;
                }
            }
            return false;
        } finally {
            settle();
            if (!this.stopped) { this.state.busy = false; this.notify(); this.runPendingRefresh(); }
        }
    }

    /**
     * WatchPartySession.mutateSuggestions: one ballot change at a time, from any member, in the lobby. The ballot is read
     * again afterwards for this profile's votes. A failed change is read back too, since a lost answer may have landed.
     */
    private async changeBallot(operation: (roomId: string, signal: AbortSignal) => Promise<void>): Promise<boolean> {
        const room = this.state.room;
        if (room?.phase !== "lobby" || this.state.busy || this.ending || this.stopped) return false;
        const epoch = ++this.suggestionsEpoch;
        this.suggestionsRefreshing = false;
        this.state.votes.invalidatePersonalReads();
        this.state.busy = true;
        this.state.error = undefined;
        // End party waits for this, as it does for a host change.
        let settle: () => void = () => undefined;
        this.mutation = new Promise<void>(resolve => { settle = resolve; });
        this.notify();
        const current = (): boolean => !this.stopped && this.state.room?.roomId === room.roomId && epoch === this.suggestionsEpoch;
        try {
            try {
                await operation(room.roomId, this.controller.signal);
            } catch (error) {
                if (!current()) return false;
                await this.loadSuggestions(room.roomId, epoch).catch(() => undefined);
                if (!this.stopped && this.state.room?.roomId === room.roomId) this.state.error = this.describe(error);
                return false;
            }
            if (!current()) return false;
            try {
                await this.loadSuggestions(room.roomId, epoch);
            } catch (error) {
                if (current()) this.state.error = { key: "watchParty.error.suggestionsSaved", args: { error: this.describe(error) } };
            }
            return !this.stopped && this.state.room?.roomId === room.roomId;
        } finally {
            settle();
            if (!this.stopped) { this.state.busy = false; this.notify(); this.runPendingRefresh(); }
        }
    }

    private runPendingRefresh(): void {
        if (!this.refreshPending) return;
        this.refreshPending = false;
        this.refreshSuggestions();
    }

    /**
     * WatchPartySession.refreshSuggestions: a vote room reads its ballot shortly after a socket update, one read at a time.
     * A failed read tries again after 1, 2 and 4 seconds, so new suggestions do not stay unvotable until the next update.
     */
    private refreshSuggestions(failures = 0): void {
        const room = this.state.room;
        if (room?.selectionMode !== "vote" || this.suggestionsRefreshing || this.stopped) return;
        // Apple skips the read while a change runs; this one runs it when the change finishes, so an update or the host's own switch to voting is not lost.
        if (this.state.busy) { this.refreshPending = true; return; }
        const epoch = ++this.suggestionsEpoch;
        this.suggestionsRefreshing = true;
        void (async () => {
            let retry = false;
            try {
                await sleep(this.options.clock ?? systemClock, failures === 0 ? SUGGESTIONS_REFRESH_MS : 1000 * 2 ** (failures - 1), this.controller.signal, () => new Error("stopped"));
                if (epoch !== this.suggestionsEpoch) return;
                await this.loadSuggestions(room.roomId, epoch);
                if (this.state.error === this.refreshFailure && epoch === this.suggestionsEpoch) { this.state.error = undefined; this.notify(); }
            } catch (error) {
                if (this.stopped || epoch !== this.suggestionsEpoch || this.state.room?.roomId !== room.roomId) return;
                this.refreshFailure = { key: "watchParty.error.suggestionsRefresh", args: { error: this.describe(error) } };
                this.state.error = this.refreshFailure;
                this.notify();
                retry = failures < SUGGESTIONS_REFRESH_RETRIES;
            } finally {
                if (epoch === this.suggestionsEpoch) this.suggestionsRefreshing = false;
            }
            if (retry) this.refreshSuggestions(failures + 1);
        })();
    }

    /** Every page of the ballot. A socket update or vote that lands meanwhile makes the read stale, so it reads again. */
    private async loadSuggestions(roomId: string, epoch: number): Promise<void> {
        const clock = this.options.clock ?? systemClock;
        for (let attempt = 0; attempt < SUGGESTIONS_READ_ATTEMPTS; attempt++) {
            const revision = this.state.votes.revision;
            const rows: Suggestion[] = [];
            const cursors = new Set<string>();
            let cursor: string | undefined;
            do {
                const page = await this.api.suggestions(roomId, this.roomToken, cursor, this.controller.signal);
                if (this.stopped || epoch !== this.suggestionsEpoch || this.state.room?.roomId !== roomId) return;
                if (!page.items.every(row => row.roomId === roomId)) throw new Error("The server sent suggestions for another room.");
                rows.push(...page.items);
                cursor = page.nextCursor;
                if (cursor !== undefined && cursors.has(cursor)) throw new Error("The server repeated a page of suggestions.");
                if (cursor !== undefined) cursors.add(cursor);
            } while (cursor !== undefined);
            if (this.state.votes.reconcile(rows, revision)) { this.notify(); return; }
            await sleep(clock, SUGGESTIONS_REFRESH_MS, this.controller.signal, () => new Error("stopped"));
            if (this.stopped || epoch !== this.suggestionsEpoch) return;
        }
        throw new Error(SUGGESTIONS_STALE);
    }

    private async readRoom(roomId: string): Promise<Room | undefined> {
        const receipt = this.rooms.receipt;
        try {
            const answer = await this.api.room(roomId, this.roomToken, this.controller.signal);
            if (this.stopped || this.state.room?.roomId !== roomId) return undefined;
            // A snapshot that arrived while this read ran is newer than the read, so it is the room to judge by.
            return this.accept(answer, receipt) ? answer.room : this.state.room;
        } catch {
            // The error from the change is already showing; the room stays as it was.
            return undefined;
        }
    }

    private async loadShelves(): Promise<{ readonly shelves: PickerShelf[]; readonly error: string | undefined }> {
        const room = this.requireRoom();
        const signal = this.controller.signal;
        const playable = (entry: PickerEntry): boolean => PLAYABLE_TYPES.includes(entry.card.type);
        const shelf = (id: string, title: () => string, entries: readonly PickerEntry[]): PickerShelf[] => {
            const shown = entries.filter(playable);
            return shown.length === 0 ? [] : [{ id, title, entries: shown }];
        };
        const toEntries = (cards: readonly Card[]): PickerEntry[] => cards.map(card => ({ card, members: [], nextUp: undefined }));
        let primaryError: string | undefined;
        let moviesError: string | undefined;

        const [primary, home, movies, series] = await Promise.all([
            (async (): Promise<PickerShelf[]> => {
                try {
                    if (this.state.capabilities?.picker === true) {
                        const picker = await this.api.picker(room.roomId, this.roomToken, signal);
                        return [
                            ...shelf("together", () => translate("watchParty.picker.continueTogether"), picker.continueTogether),
                            ...shelf("watchlist", () => translate("watchParty.picker.watchlists"), picker.watchlistUnion),
                        ];
                    }
                    const page = await this.api.watchlist(signal);
                    return shelf("watchlist", () => translate("watchParty.picker.watchlists"), toEntries(page.items));
                } catch (error) {
                    primaryError = this.describe(error);
                    return [];
                }
            })(),
            (async (): Promise<PickerShelf[]> => {
                if (this.api.homeSections === undefined) return [];
                try {
                    const sections = await this.api.homeSections(signal);
                    const rows: PickerShelf[] = [];
                    for (const section of sections) {
                        if (rows.length >= MAX_HOME_SECTIONS) break;
                        if (SKIPPED_HOME_SECTION_TYPES.has(section.sectionType.toLowerCase())) continue;
                        const items = section.items.filter(card => card.type === "movie" || card.type === "series");
                        if (items.length === 0) continue;
                        rows.push({ id: `home:${section.id}`, title: () => serverText(section.title, section.titleKey, section.titleArgs), entries: toEntries(items) });
                    }
                    return rows;
                } catch {
                    return [];
                }
            })(),
            (async (): Promise<PickerShelf[]> => {
                if (this.api.recentCatalog === undefined) return [];
                try {
                    const page = await this.api.recentCatalog("movie", signal);
                    return shelf("recent-movies", () => translate("watchParty.picker.recentMovies"), toEntries(page.items));
                } catch (error) {
                    moviesError = this.describe(error);
                    return [];
                }
            })(),
            (async (): Promise<PickerShelf[]> => {
                if (this.api.recentCatalog === undefined) return [];
                try {
                    const page = await this.api.recentCatalog("series", signal);
                    return shelf("recent-series", () => translate("watchParty.picker.recentSeries"), toEntries(page.items));
                } catch {
                    return [];
                }
            })(),
        ]);
        return { shelves: [...primary, ...home, ...movies, ...series], error: primaryError ?? moviesError };
    }

    private async runSearch(query: string, cursor: string | undefined, epoch: number): Promise<void> {
        if (this.api.searchCatalog === undefined) return;
        this.state.search.searching = true;
        this.state.search.error = undefined;
        if (cursor === undefined) {
            this.state.search.feedKey = {};
            this.state.search.completedQuery = "";
            this.state.search.results = [];
            this.state.search.nextCursor = undefined;
        }
        this.notify();
        try {
            const page = await this.api.searchCatalog(query, cursor, this.controller.signal);
            if (this.stopped || epoch !== this.searchEpoch) return;
            const playable = page.items.filter(card => PLAYABLE_TYPES.includes(card.type));
            if (cursor === undefined) {
                this.state.search.results = playable;
                this.state.search.total = page.total ?? playable.length;
            } else {
                const seen = new Set(this.state.search.results.map(card => card.id));
                const next = [...this.state.search.results, ...playable.filter(card => !seen.has(card.id))];
                this.state.search.results = next;
                this.state.search.total = page.total ?? next.length;
            }
            this.state.search.completedQuery = query;
            this.state.search.nextCursor = page.nextCursor;
            this.state.search.hasSearched = true;
        } catch (error) {
            if (this.stopped || epoch !== this.searchEpoch) return;
            this.state.search.error = errorState(error);
        }
        if (this.stopped || epoch !== this.searchEpoch) return;
        this.state.search.searching = false;
        this.notify();
    }

    private async browse(epoch: number, load: (signal: AbortSignal) => Promise<void>): Promise<void> {
        try {
            await load(this.controller.signal);
        } catch (error) {
            if (this.staleBrowse(epoch)) return;
            this.state.browseError = this.describe(error);
        }
        if (this.staleBrowse(epoch)) return;
        this.state.browseLoading = false;
        this.notify();
    }

    private fail(message: Notice): void {
        this.state.error = message;
        this.notify();
    }

    /** WatchPartySession.loadCapabilities. */
    private async load(): Promise<boolean> {
        try {
            const [room, playback] = await Promise.all([this.api.capabilities(this.controller.signal), this.api.playbackCapabilities(this.controller.signal)]);
            if (this.stopped) return false;
            this.state.supported = supportsSynchronizedParty(room, playback);
            this.state.capabilities = room;
            this.state.error = undefined;
            this.options.onSupport?.(this.state.supported);
            return true;
        } catch (error) {
            if (this.stopped) return false;
            this.state.error = { key: "watchParty.error.supportCheck", args: { error: this.describe(error) } };
            return false;
        }
    }

    /** WatchPartySession.enter: support is read again before every create or join. Returns true only when this call entered a room. */
    private async enter(operation: (signal: AbortSignal) => Promise<RoomAccess>): Promise<boolean> {
        if (this.state.busy || this.stopped) return false;
        this.state.busy = true;
        this.state.error = undefined;
        this.notify();
        try {
            if (!await this.load()) return false;
            if (!this.state.supported) { this.state.error = { key: "watchParty.error.unavailable" }; return false; }
            try {
                const entered = await operation(this.controller.signal);
                if (!this.stopped) {
                    this.reset();
                    if (this.accept(entered)) {
                        this.connect(entered.room.roomId);
                        return true;
                    }
                }
            } catch (error) {
                if (!this.stopped) this.state.error = this.describe(error);
            }
            return false;
        } finally {
            if (!this.stopped) { this.state.busy = false; this.notify(); }
        }
    }
}
