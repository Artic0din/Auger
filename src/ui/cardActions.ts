// Apple's card long-press menu: the tvOS `.contextMenu` of MediaCard, EpisodeThumbCard, and TVEpisodeRail (silo-apple
// d74a30aa0a09042160e0d942b9a6b680e304b690, Components/MediaCard.swift:122-151,570-620; EpisodeThumbCard.swift:366-416;
// tvOS/Screens/Detail/TVEpisodeRail.swift:614-688). Rows follow MediaStateMenuItems order, while episode rails show Watch
// state (detail.more.markEpisode*) then Favorites and Watchlist. Failures show home.updateFailed on Home and
// MediaActionFeedback ("Couldn't Update Item" / "Your change wasn't saved. Please try again.") elsewhere.

import { operations } from "../api/operations.ts";
import { detailOperations, type HomeDismissal } from "../api/detailOperations.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { NativeSession } from "../session/session.ts";
import { markEnglishOnly } from "../i18n/direction.ts";
import { translate } from "../i18n/translate.ts";
import { centredDialog } from "./confirmationDialog.ts";
import { remoteKey } from "./keys.ts";
import { el } from "./screen.ts";
import { NotInterestedStore } from "./notInterestedStore.ts";
import { heldSelect, listenSelectRelease, moveSelect, releasedSelect, swallowSelect } from "./selectRelease.ts";

/** What the opener knows about the card. A field it does not know is read from the item before the menu opens. */
export type MenuCard = Pick<Card, "id" | "title" | "type"> & Partial<Pick<Card, "played" | "favorite" | "watchlist" | "notInterested" | "positionSeconds" | "seriesId">> & {
    /** A Details season pill, whose menu is Apple's season-only Mark Season Watched or Unwatched. */
    readonly seasonPill?: boolean;
};

export interface CardMenuOptions {
    /** Continue Watching's Play or Resume row (MediaRow.showsPlayInContextMenu). */
    readonly play?: (() => void) | undefined;
    /** Home's Continue Watching and Next Up rows offer Remove (SectionRow.offersHomeDismissal). */
    readonly dismissal?: HomeDismissal | undefined;
    /** Home injects its watched handler into every row and localizes its update failure alert (`home.updateFailed`). */
    readonly home?: boolean | undefined;
    /** Non-Home SectionRow shelf (For You, Library Recommended): opens from row state without reading item, uses generic alert. */
    readonly sectionRow?: boolean | undefined;
    /** Series/season TVEpisodeRail card: localized watched, favorite, and watchlist rows only (silo-apple#1253). */
    readonly episodeRail?: boolean | undefined;
    /** A wide still in a thumbnail row: Apple draws it as EpisodeThumbCard, whose menu has no Not Interested row. */
    readonly wide?: boolean | undefined;
}

export interface CardActionsHost {
    /** A change was applied; reread what shows it. `watched` is true for a landed watched change. */
    readonly applied: (id: string, watched: boolean) => void;
    /** The server accepted a new Not interested mark; drop the title from the rows that suggest it before the reread, as HomeViewModel.removeNotInterested does. */
    readonly markedNotInterested?: (card: MenuCard) => void;
    /** A Home dismissal was accepted; drop the card from the playback rows before the reread, as HomeViewModel does. */
    readonly dismissed?: (card: MenuCard) => void;
    /** The menu or alert took the screen; remember where focus returns. */
    readonly opened: () => void;
    /** The menu or alert closed; return focus. */
    readonly closed: () => void;
    /** A personal change from Details is still on its way; the menu's changes wait for it, as they did before. */
    readonly pendingElsewhere?: () => boolean;
    /** Whether an alert may take the screen now: not during playback, Settings or another menu. A refused alert waits. */
    readonly canAlert?: () => boolean;
}

type Row = { readonly key: string; readonly label: string; readonly icon: keyof typeof ICONS; readonly destructive?: boolean; readonly change?: boolean; readonly run: () => void };

/** SF Symbols the menu draws, on a 24 point grid. */
const ICONS = {
    "play.fill": '<path d="M7 4.5v15l12.5-7.5Z" fill="currentColor"/>',
    "checkmark.circle": '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m7.8 12.3 2.9 2.9 5.6-6.1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    "checkmark.circle.fill": '<circle cx="12" cy="12" r="9.5" fill="currentColor"/><path d="m7.8 12.3 2.9 2.9 5.6-6.1" fill="none" stroke="var(--icon-ink, #000)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    "circle": '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    "heart": '<path d="M12 20.3S3.5 15.1 3.5 9.1A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8.5 2.5c0 6-8.5 11.2-8.5 11.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    "heart.fill": '<path d="M12 20.3S3.5 15.1 3.5 9.1A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8.5 2.5c0 6-8.5 11.2-8.5 11.2Z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    "heart.slash": '<path d="M12 20.3S3.5 15.1 3.5 9.1A4.6 4.6 0 0 1 12 6.6a4.6 4.6 0 0 1 8.5 2.5c0 6-8.5 11.2-8.5 11.2Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m3.5 3.5 17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    "bookmark": '<path d="M6.5 3.5h11v17L12 16.6l-5.5 3.9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    "bookmark.fill": '<path d="M6.5 3.5h11v17L12 16.6l-5.5 3.9Z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    "bookmark.slash": '<path d="M6.5 3.5h11v17L12 16.6l-5.5 3.9Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m3.5 3.5 17 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    "hand.thumbsup": '<path d="M3.5 10.5h4v9.5h-4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M7.5 10.5 11 4.2c.5-.9 1.6-1.1 2.3-.5.5.4.7 1 .6 1.6l-.6 3.7h5c1.2 0 2.1 1.1 1.8 2.3l-1.3 6c-.2.9-1 1.6-2 1.6H7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
    "hand.thumbsdown": '<g transform="rotate(180 12 12)"><path d="M3.5 10.5h4v9.5h-4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M7.5 10.5 11 4.2c.5-.9 1.6-1.1 2.3-.5.5.4.7 1 .6 1.6l-.6 3.7h5c1.2 0 2.1 1.1 1.8 2.3l-1.3 6c-.2.9-1 1.6-2 1.6H7.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></g>',
    "xmark.circle": '<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m8.6 8.6 6.8 6.8m0-6.8-6.8 6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
} as const;

/**
 * Apple's context-menu preview, measured on the live tvOS Continue Watching capture (1920x1080, Spidey S01E25): the
 * 360 x 200 art at rest at (80, 673) is drawn at (86, 663), 396 x 220, while the menu is open. That is a 1.1 scale about
 * the art's centre, then a shift right of 24 px, a fifteenth of the art's width. browse.css draws the same transform.
 */
export const MENU_LIFT_SCALE = 1.1;
export const MENU_LIFT_SHIFT = 1 / 15;
/** The class that lifts the anchor card's art while its menu is open. */
export const MENU_LIFTED_CLASS = "card-menu-lifted";
/** The platter's rim sits 27 px right of the lifted art (art right 482, platter 509 on the same capture). */
const MENU_GAP = 27;
/** The safe area the menu stays inside. */
const MENU_MARGIN = 60;

export class CardActions {
    private panel: HTMLElement | undefined;
    private rows: HTMLButtonElement[] = [];
    private listening = false;
    /** The card drawn lifted while its menu is open, and its art's rest box measured before the lift. */
    private lifted: { readonly card: HTMLElement; readonly rest: Box } | undefined;
    /** A failure that arrived while the alert could not show; it shows once the screen is free. */
    private deferredAlert: { readonly home: boolean } | undefined;
    private reading: AbortController | undefined;
    /** The open menu, so a change landing behind it can redraw its rows. */
    private shown: { readonly card: MenuCard; readonly options: CardMenuOptions; readonly anchor: HTMLElement | undefined; readonly source: MenuCard } | undefined;
    /**
     * Changes the server accepted, keyed by the row's own card object. Until a reread replaces that object, reopening
     * its menu shows the accepted state rather than the row's stale one; fresh rows bring the server's state instead.
     */
    private readonly accepted = new WeakMap<MenuCard, Pick<MenuCard, "played" | "favorite" | "watchlist" | "notInterested">>();
    private readonly writes = new Map<string, AbortController>();
    private readonly container: HTMLElement;
    private readonly session: NativeSession;
    private readonly host: CardActionsHost;
    private readonly stopAuthority: () => void;

    private readonly notInterested: NotInterestedStore;
    /** The store's stamp when the open menu's card was taken, so a write answered while the menu is open reconciles its state. */
    private shownStamp = 0;
    private stopNotInterested: (() => void) | undefined;

    constructor(container: HTMLElement, session: NativeSession, notInterested: NotInterestedStore, host: CardActionsHost) {
        this.notInterested = notInterested;
        this.container = container;
        this.session = session;
        this.host = host;
        // A change sent for one profile must not land on, or alert over, the next.
        this.stopAuthority = session.onAuthorityChange(() => {
            this.abortAll();
            if (this.active) this.close();
        });
    }

    get active(): boolean { return this.panel !== undefined || this.reading !== undefined; }
    /** A change is still on its way; Details keeps its own personal writes locked meanwhile. */
    get pending(): boolean { return this.writes.size > 0; }

    open(card: MenuCard, options: CardMenuOptions = {}): void {
        if (this.active) return;
        this.shownStamp = this.notInterested.stamp();
        const anchor = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const known = card.played !== undefined && card.favorite !== undefined && card.watchlist !== undefined;
        const source = card;
        card = { ...card, ...this.accepted.get(source) };
        if (known || options.home === true || options.sectionRow === true) { this.show(card, options, anchor, source); return; }
        // Seasons, episode rails and the calendar hold no list membership; read it once, then open complete.
        const controller = new AbortController();
        this.reading = controller;
        this.capture();
        // Focus leaves the card while the read runs, so a fresh Select cannot activate the card underneath.
        const sink = el("div", "card-actions-scrim card-menu-loading");
        sink.tabIndex = -1;
        sink.setAttribute("aria-busy", "true");
        sink.setAttribute("aria-label", card.title);
        this.panel = sink;
        this.container.appendChild(sink);
        sink.focus({ preventScroll: true });
        const settle = (): void => {
            this.reading = undefined;
            sink.remove();
            if (this.panel === sink) this.panel = undefined;
            this.release();
        };
        this.session.call({ ...operations.getCatalogItem(card.id), profileScoped: true, signal: controller.signal }).then(detail => {
            if (this.reading !== controller) return;
            settle();
            if (detail.id !== card.id || detail.type !== card.type) {
                this.alert(false);
                if (this.deferredAlert !== undefined) this.host.closed();
                return;
            }
            this.show({ ...card, played: detail.played, favorite: detail.favorite, watchlist: detail.watchlist, notInterested: detail.notInterested }, options, anchor, source);
        }, () => {
            if (this.reading !== controller) return;
            settle();
            this.alert(false);
            if (this.deferredAlert !== undefined) this.host.closed();
        });
    }

    private show(card: MenuCard, options: CardMenuOptions, anchor: HTMLElement | undefined, source: MenuCard): void {
        const rows = this.menuRows(card, options, source);
        // Apple attaches no menu to a card without actions.
        if (rows.length === 0) {
            if (this.active || this.listening) this.dismiss();
            this.host.closed();
            return;
        }
        // While the menu is shown, a Not interested write for its card being answered, from here or from the page, draws it again.
        this.stopNotInterested ??= this.notInterested.subscribe(id => { if (id === this.shown?.card.id) this.refresh(); });
        const busy = this.writes.has(card.id) || this.notInterested.pending(card.id) !== undefined || this.host.pendingElsewhere?.() === true;
        const scrim = el("div", "card-actions-scrim card-menu-scrim");
        for (const type of ["click", "contextmenu"]) scrim.addEventListener(type, event => {
            if (event.target !== scrim) return;
            event.preventDefault();
            event.stopPropagation();
            this.close();
        });
        const menu = el("div", "card-menu");
        menu.setAttribute("role", "menu");
        menu.setAttribute("aria-label", card.title);
        this.rows = rows.map(row => {
            const button = el("button", row.destructive === true ? "card-menu-row card-menu-destructive" : "card-menu-row");
            button.type = "button";
            button.tabIndex = -1;
            button.setAttribute("role", "menuitem");
            button.setAttribute("data-focus", row.key);
            if (busy && row.change === true) button.setAttribute("aria-disabled", "true");
            const icon = el("span", "card-menu-icon");
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[row.icon]}</svg>`;
            button.append(menuLabel(row.label), icon);
            button.addEventListener("click", () => {
                if (button.getAttribute("aria-disabled") === "true") return;
                this.close();
                row.run();
            });
            return button;
        });
        menu.append(...this.rows);
        scrim.append(menu);
        if (this.panel === undefined) this.capture();
        this.panel = scrim;
        this.shown = { card, options, anchor, source };
        this.container.appendChild(scrim);
        // A redraw keeps the rest box measured before the lift; the lifted art would measure moved.
        const rest = this.lifted !== undefined && this.lifted.card === anchor ? this.lifted.rest : restArt(anchor);
        place(menu, anchor, rest);
        if (rest !== undefined && anchor !== undefined) { anchor.classList.add(MENU_LIFTED_CLASS); this.lifted = { card: anchor, rest }; }
        this.rows[0]?.focus({ preventScroll: true });
    }

    /** Something the rows depend on changed, such as a Details change finishing: redraw the open menu. */
    refresh(): void {
        if (this.shown !== undefined && this.panel !== undefined) this.redraw(this.shown.card);
    }

    /** Shows a failure alert that had to wait, once nothing else owns the screen. */
    showDeferredAlert(): void {
        if (this.deferredAlert === undefined || this.active || this.host.canAlert?.() === false) return;
        const { home } = this.deferredAlert;
        this.deferredAlert = undefined;
        this.alert(home);
    }

    /** A change for the open menu's card landed: show its new state with the rows enabled, keeping the focused row. */
    private redraw(next: MenuCard | undefined): void {
        const shown = this.shown;
        if (shown === undefined) return;
        if (next === undefined) {
            this.close();
            return;
        }
        const focused = document.activeElement?.getAttribute("data-focus");
        const press = heldSelect();
        const held = press !== undefined && press.element === document.activeElement ? press : undefined;
        this.panel?.remove();
        this.panel = undefined;
        this.show(next, shown.options, shown.anchor, shown.source);
        const kept = this.rows.find(row => row.getAttribute("data-focus") === focused);
        kept?.focus({ preventScroll: true });
        // A held Select stays with its row through the redraw, unless the redrawn row is disabled.
        if (held !== undefined && kept !== undefined) moveSelect(held, kept);
    }

    private menuRows(card: MenuCard, options: CardMenuOptions, source: MenuCard): Row[] {
        const rows: Row[] = [];
        const home = options.home === true;
        // TVSeriesDetailView.swift:632-643: a season pill's menu holds only Mark Season Watched or Unwatched.
        if (card.seasonPill === true) {
            if (card.played === undefined) return rows;
            const watched = card.played;
            rows.push({ change: true, key: "watched", label: translate(watched ? "detail.more.markSeasonUnwatched" : "detail.more.markSeasonWatched"), icon: watched ? "circle" : "checkmark.circle", run: () => this.send(card.id, detailOperations.setPersonal("watched", card.id, !watched), menu => ({ ...menu, played: !watched }), source, false) });
            return rows;
        }
        // TVEpisodeRail.swift:614-688 (post-silo-apple#1253): Watch state then Favorites and Watchlist alone.
        if (options.episodeRail === true) {
            if (card.played !== undefined) {
                const watched = card.played;
                rows.push({ change: true, key: "watched", label: translate(watched ? "detail.more.markEpisodeUnwatched" : "detail.more.markEpisodeWatched"), icon: watched ? "checkmark.circle.fill" : "checkmark.circle", run: () => this.send(card.id, detailOperations.setPersonal("watched", card.id, !watched), menu => ({ ...menu, played: !watched }), source, false) });
            }
            if (card.favorite !== undefined) {
                const favorite = card.favorite;
                rows.push({ change: true, key: "favorites", label: translate(favorite ? "detail.more.removeFavorite" : "detail.more.addFavorite"), icon: favorite ? "heart.fill" : "heart", run: () => this.send(card.id, detailOperations.setPersonal("favorites", card.id, !favorite), menu => ({ ...menu, favorite: !favorite }), source, false) });
            }
            if (card.watchlist !== undefined) {
                const watchlist = card.watchlist;
                rows.push({ change: true, key: "watchlist", label: translate(watchlist ? "detail.watchlistRemove" : "detail.watchlistAdd"), icon: watchlist ? "bookmark.fill" : "bookmark", run: () => this.send(card.id, detailOperations.setPersonal("watchlist", card.id, !watchlist), menu => ({ ...menu, watchlist: !watchlist }), source, false) });
            }
            return rows;
        }
        const play = options.play;
        if (play !== undefined) rows.push({ key: "card-play", label: (card.positionSeconds ?? 0) > 0 ? "Resume" : "Play", icon: "play.fill", run: play });
        // MediaCard.canSetWatched: SectionRow's handler, or a card with user state that is not a square audiobook cover.
        if (home || options.sectionRow === true || (card.played !== undefined && card.type !== "audiobook")) {
            const watched = card.played === true;
            rows.push({ change: true, key: "watched", label: watched ? "Mark as Unwatched" : "Mark as Watched", icon: watched ? "circle" : "checkmark.circle", run: () => this.send(card.id, detailOperations.setPersonal("watched", card.id, !watched), menu => ({ ...menu, played: !watched }), source, home) });
        }
        if (card.favorite !== undefined) {
            const favorite = card.favorite;
            rows.push({ change: true, key: "favorites", label: favorite ? "Remove from Favorites" : "Add to Favorites", icon: favorite ? "heart.slash" : "heart", run: () => this.send(card.id, detailOperations.setPersonal("favorites", card.id, !favorite), menu => ({ ...menu, favorite: !favorite }), source, home) });
        }
        if (card.watchlist !== undefined) {
            const watchlist = card.watchlist;
            rows.push({ change: true, key: "watchlist", label: watchlist ? "Remove from Watchlist" : "Add to Watchlist", icon: watchlist ? "bookmark.slash" : "bookmark", run: () => this.send(card.id, detailOperations.setPersonal("watchlist", card.id, !watchlist), menu => ({ ...menu, watchlist: !watchlist }), source, home) });
        }
        // MediaCardPersonalState.offersNotInterested on MediaCard and TVMediaCard: a movie or series from a server that sends the mark. EpisodeThumbCard's menu has none.
        if (options.wide !== true && card.notInterested !== undefined && (card.type === "movie" || card.type === "series")) {
            // A write still out for the title, from this menu or the page, shows the state it will leave.
            const marked = this.notInterested.state(card.id, card.notInterested, this.shownStamp);
            rows.push({ change: true, key: "not-interested", label: translate(marked ? "cardMenu.showInRecommendations" : "cardMenu.notInterested"), icon: marked ? "hand.thumbsup" : "hand.thumbsdown", run: () => this.send(card.id, detailOperations.setNotInterested(card.id, !marked), menu => ({ ...menu, notInterested: !marked }), source, home, marked ? undefined : () => this.host.markedNotInterested?.(card)) });
        }
        const dismissal = options.dismissal;
        if (dismissal !== undefined) {
            rows.push({ change: true, key: "remove", label: translate(dismissal.surface === "next_up" ? "cardMenu.removeNextUp" : "cardMenu.removeContinueWatching"), icon: "xmark.circle", destructive: true, run: () => this.send(card.id, detailOperations.dismissHomeItem(card.id, dismissal), () => undefined, source, home, () => this.host.dismissed?.(card)) });
        }
        return rows;
    }

    /** `landed` gives the card's state after the change, or undefined when the card leaves its row. */
    private send(id: string, spec: ReturnType<typeof detailOperations.setPersonal>, landed: (card: MenuCard) => MenuCard | undefined, source: MenuCard, home: boolean, accepted?: () => void): void {
        // HomeViewModel.pendingWatchedUpdates: one change per card at a time, and none beside a pending Details change.
        if (this.writes.has(id) || this.notInterested.pending(id) !== undefined || this.host.pendingElsewhere?.() === true) return;
        const controller = new AbortController();
        this.writes.set(id, controller);
        // Not interested goes through the one per-title store, so the page and other menus see this write while it is out.
        const target = spec.path.startsWith("/not-interested/") ? spec.method === "PUT" : undefined;
        if (target !== undefined) this.notInterested.start(id, target);
        this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: false, signal: controller.signal }).then(() => {
            if (target !== undefined) this.notInterested.finish(id, this.writes.get(id) === controller ? target : undefined);
            if (this.writes.get(id) !== controller) return;
            this.writes.delete(id);
            accepted?.();
            const now = landed({ ...source, ...this.accepted.get(source) });
            if (now !== undefined) this.accepted.set(source, { played: now.played, favorite: now.favorite, watchlist: now.watchlist, notInterested: now.notInterested });
            const shown = this.shown;
            if (shown !== undefined && shown.card.id === id) this.redraw(landed(shown.card));
            this.host.applied(id, spec.path.startsWith("/watched/"));
        }, () => {
            if (target !== undefined) this.notInterested.finish(id, this.writes.get(id) === controller ? !target : undefined);
            if (this.writes.get(id) !== controller) return;
            this.writes.delete(id);
            if (this.shown?.card.id === id) this.redraw(this.shown.card);
            this.alert(home);
            // Even a lost answer may have landed; reread once the alert closes so the rows show what the server holds.
            this.host.applied(id, false);
        });
    }

    /** HomeView's `.alert` (home.updateFailed) or MediaActionFeedback (PersonalStateNotice.failed(nil)) elsewhere. */
    private alert(home: boolean): void {
        // A reopened menu keeps its focus and Resume action until it closes.
        if (this.shown !== undefined || this.host.canAlert?.() === false) { this.deferredAlert = { home }; return; }
        if (this.active) this.dismiss();
        const ok = el("button", "card-alert-button", home ? translate("home.updateFailed.ok") : "OK");
        ok.type = "button";
        ok.setAttribute("data-focus", "card-alert-ok");
        ok.addEventListener("click", () => this.close());
        const title = home ? translate("home.updateFailed.title") : "Couldn't Update Item";
        const message = home ? translate("home.updateFailed.message") : "Your change wasn't saved. Please try again.";
        const nodes = centredDialog({ style: "alert", id: "card-update-failed", title, message, buttons: [ok], behind: [] });
        if (!home) {
            const dialog = nodes.find(node => node.classList.contains("signin-alert"));
            const heading = dialog?.querySelector<HTMLElement>(".signin-alert-title");
            const copy = dialog?.querySelector<HTMLElement>(".signin-alert-text");
            if (heading !== null && heading !== undefined) markEnglishOnly(heading, title);
            if (copy !== null && copy !== undefined) markEnglishOnly(copy, message);
            markEnglishOnly(ok, "OK");
        }
        const scrim = el("div", "card-actions-scrim card-alert-scrim");
        scrim.append(...nodes);
        this.capture();
        this.panel = scrim;
        this.shown = undefined;
        this.rows = [ok];
        this.container.appendChild(scrim);
        ok.focus({ preventScroll: true });
    }

    close(): void {
        const shown = this.active;
        this.dismiss();
        if (shown) this.host.closed();
    }

    private dismiss(): void {
        this.stopNotInterested?.();
        this.stopNotInterested = undefined;
        this.lifted?.card.classList.remove(MENU_LIFTED_CLASS);
        this.lifted = undefined;
        this.reading?.abort();
        this.reading = undefined;
        this.rows = [];
        this.shown = undefined;
        this.panel?.remove();
        this.panel = undefined;
        this.release();
    }

    private capture(): void {
        if (this.listening) return;
        this.listening = true;
        listenSelectRelease();
        this.host.opened();
        document.addEventListener("keydown", this.onKey, true);
        document.addEventListener("keyup", this.onRelease, true);
    }

    private release(): void {
        if (!this.listening) return;
        this.listening = false;
        // Select may still be down; the rest of that press must not reach what takes focus next.
        swallowSelect();
        document.removeEventListener("keydown", this.onKey, true);
        document.removeEventListener("keyup", this.onRelease, true);
    }

    private abortAll(): void {
        this.deferredAlert = undefined;
        for (const controller of this.writes.values()) controller.abort();
        this.writes.clear();
    }

    destroy(): void {
        this.abortAll();
        this.dismiss();
        this.stopAuthority();
    }

    private readonly onRelease = (event: KeyboardEvent): void => {
        if (remoteKey(event) !== "enter") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // The shared Select release names the row the press was made on, enabled and focused throughout; anything else runs nothing.
        const chosen = releasedSelect();
        if (chosen !== undefined && chosen === document.activeElement && this.rows.some(row => row === chosen)) chosen.click();
    };

    private readonly onKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (key === undefined && event.key !== "Tab") return;
        event.stopImmediatePropagation();
        event.preventDefault();
        if (key === "back") { this.close(); return; }
        if (this.panel === undefined) return;
        // The tvOS menu is a single column: Left and Right stay put.
        if (key === "up" || key === "down" || event.key === "Tab") {
            const index = this.rows.findIndex(row => row === document.activeElement);
            const step = key === "up" || event.shiftKey ? -1 : 1;
            this.rows[Math.max(0, Math.min(this.rows.length - 1, index + step))]?.focus({ preventScroll: true });
        }
        // Enter waits for its release (onRelease); the long press that opened the menu never names a row.
    };
}

/**
 * A row's label. tvOS balances a two-line label ("Remove from / Continue Watching"); Chromium 108 has no
 * `text-wrap: balance`, so the last two words stay together, which gives the same break for Apple's labels.
 */
function menuLabel(text: string): HTMLElement {
    const label = el("span", "card-menu-label");
    const words = text.split(" ");
    if (words.length < 3) { label.textContent = text; return label; }
    label.append(`${words.slice(0, -2).join(" ")} `, el("span", "card-menu-keep", words.slice(-2).join(" ")));
    return label;
}

/** The tvOS menu opens beside the focused card, inside the safe area. */
export interface Box { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

/** Where the art is drawn while lifted, from its rest box. */
export function liftedArt(art: Box): Box {
    const width = art.width * MENU_LIFT_SCALE, height = art.height * MENU_LIFT_SCALE;
    return { left: art.left + (art.width - width) / 2 + art.width * MENU_LIFT_SHIFT, top: art.top + (art.height - height) / 2, width, height };
}

/**
 * The platter's top-left: beside the lifted art (or the card, when it has none), centred on the card's button raised
 * by the lift, as Apple's platter centre is the button centre less the art's 10 px rise. Kept inside the safe area.
 */
export function menuPosition(card: Box, art: Box | undefined, menu: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }): { left: number; top: number } {
    const lifted = art === undefined ? card : liftedArt(art);
    const rise = art === undefined ? 0 : art.top - lifted.top;
    const right = lifted.left + lifted.width + MENU_GAP;
    const left = right + menu.width <= viewport.width - MENU_MARGIN ? right : Math.max(MENU_MARGIN, lifted.left - MENU_GAP - menu.width);
    const centre = card.top + card.height / 2 - rise;
    const top = Math.max(MENU_MARGIN, Math.min(viewport.height - MENU_MARGIN - menu.height, centre - menu.height / 2));
    return { left: Math.round(left), top: Math.round(top) };
}

/** The anchor card's art at rest: its layout size about its drawn centre, which the focus scale does not move. */
function restArt(anchor: HTMLElement | undefined): Box | undefined {
    const art = anchor?.querySelector(".browse-art");
    if (!(art instanceof HTMLElement) || art.offsetWidth === 0) return undefined;
    const drawn = art.getBoundingClientRect();
    return { left: drawn.left + drawn.width / 2 - art.offsetWidth / 2, top: drawn.top + drawn.height / 2 - art.offsetHeight / 2, width: art.offsetWidth, height: art.offsetHeight };
}

function place(menu: HTMLElement, anchor: HTMLElement | undefined, rest: Box | undefined): void {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const size = { width: menu.offsetWidth, height: menu.offsetHeight };
    const rect = anchor?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0) {
        menu.style.left = `${Math.round((viewport.width - size.width) / 2)}px`;
        menu.style.top = `${Math.round((viewport.height - size.height) / 2)}px`;
        return;
    }
    const position = menuPosition({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, rest, size, viewport);
    menu.style.left = `${position.left}px`;
    menu.style.top = `${position.top}px`;
}
