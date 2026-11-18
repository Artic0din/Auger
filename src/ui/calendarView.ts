import type { CalendarEvent, CalendarFilter } from "../contracts/v2/calendar.ts";
import type { FocusItem, FocusTarget, View, Zone } from "./browseFocus.ts";
import { actionButton, artwork, FAILURE_ICON, mediaItem, searchState, zoneNode, type ViewContext } from "./browseViews.ts";
import { calendarDateLabel, calendarDestination, calendarEventKeys, calendarWeek, CalendarTimezoneError, dayDate, eventTime, localDateKey, shiftDay, type CalendarState } from "./calendarState.ts";
import { el } from "./screen.ts";
import { artworkSymbol, defaultArtwork } from "./defaultArtwork.ts";
import { shownLocale } from "../i18n/format.ts";
import { integerText } from "../i18n/numbers.ts";
import { abbreviatedWeekday } from "../i18n/weekdays.ts";
import { markEnglishOnly } from "../i18n/direction.ts";
import { translate } from "../i18n/translate.ts";
import { errorHeadline, errorMessage, failureState } from "./errorState.ts";

export interface CalendarHandlers {
    readonly now: number;
    readonly busy: boolean;
    readonly failure: string | undefined;
    readonly context: ViewContext;
    readonly change: (step: -1 | 0 | 1 | CalendarFilter) => void;
    readonly focus: (target: FocusTarget) => void;
    readonly retry: () => void;
    readonly back: () => void;
}
const FILTERS = ["following", "trending", "everything"] as const;
const filterLabel = (filter: CalendarFilter): string => translate(filter === "following" ? "calendar.filter.following" : filter === "trending" ? "calendar.filter.trending" : "calendar.filter.all");
const badgeLabel = (badge: string): string | undefined => badge === "series_premiere" ? translate("calendar.badge.series_premiere") : badge === "season_premiere" ? translate("calendar.badge.season_premiere") : badge === "finale" ? translate("calendar.badge.finale") : undefined;
const CALENDAR_ICON = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3"><rect x="5" y="9" width="38" height="34" rx="4"/><path d="M5 19h38M15 3v12M33 3v12M24 25v8m0 4v1"/></svg>';
const MOON_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 18A9 9 0 0 1 7 4a9 9 0 1 0 13 12zM18 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/></svg>';

function eventCard(event: CalendarEvent, key: string, timezone: string, context: ViewContext): FocusItem {
    const destination = calendarDestination(event);
    const item = actionButton(key, "", () => { if (destination !== undefined) context.open(destination); });
    item.element.className = "browse-card calendar-event";
    const art = artwork("browse-art", event.posterUrl, context.baseUrl, defaultArtwork(artworkSymbol(event.type)));
    const time = eventTime(event, timezone);
    const badges = event.badges.map(badgeLabel).filter(label => label !== undefined);
    const releases = el("span", "calendar-releases");
    for (const badge of badges) releases.appendChild(el("span", "calendar-release", badge));
    art.appendChild(releases);
    if (event.watched) {
        const watched = el("span", "calendar-watched", "✓");
        watched.setAttribute("aria-label", translate("calendar.watched"));
        art.appendChild(watched);
    }
    if (time !== undefined) art.appendChild(el("span", "calendar-time", time));
    item.element.appendChild(art);
    item.element.appendChild(el("span", "browse-card-title", event.title));
    const number = event.seasonNumber === undefined ? undefined : event.type === "season_premiere" ? translate("calendar.season", { season: integerText(event.seasonNumber) }) : event.type === "episode" && event.episodeNumber !== undefined ? translate("catalog.episodeCaption", { season: String(event.seasonNumber), episode: String(event.episodeNumber) }) : undefined;
    const metadata = [number, event.type === "episode" ? event.episodeTitle : undefined, event.type === "movie" ? translate("calendar.movie") : undefined, destination === undefined ? "Details unavailable for this event type" : undefined].filter(value => value !== undefined && value !== "");
    item.element.appendChild(el("span", "browse-card-subtitle", metadata.join(" · ")));
    item.element.setAttribute("aria-label", [event.title, ...metadata, time, ...badges, event.watched ? translate("calendar.watched") : undefined].filter(Boolean).join(" · "));
    if (destination === undefined) item.element.setAttribute("aria-disabled", "true");
    item.element.setAttribute("data-content-id", event.contentId);
    const type = event.type === "season_premiere" ? "season" : event.type === "movie" || event.type === "episode" ? event.type : "unknown";
    return mediaItem(item, { id: event.contentId, title: event.title, type, played: event.watched }, context);
}

export function calendarView(state: CalendarState, handlers: CalendarHandlers): View {
    try { return calendarContent(state, handlers); }
    catch (error) {
        if (!(error instanceof CalendarTimezoneError)) throw error;
        return calendarContent({ ...state, start: undefined, data: undefined, error: failureState(error.message) }, { ...handlers, busy: false, failure: error.message });
    }
}
function calendarContent(state: CalendarState, handlers: CalendarHandlers): View {
    const { busy, failure, context, change, focus, retry, back } = handlers;
    const today = localDateKey(new Date(handlers.now));
    const dates = state.start === undefined ? [] : Array.from({ length: 7 }, (_, i) => shiftDay(state.start ?? today, i));
    const controls = [actionButton("previous-week", translate("calendar.previousWeek"), () => change(-1)), actionButton("next-week", translate("calendar.nextWeek"), () => change(1))];
    for (const [i, control] of controls.entries()) {
        control.element.setAttribute("aria-label", translate(i === 0 ? "calendar.previousWeek" : "calendar.nextWeek"));
        // Original drawing sized to SF chevron.backward/forward at 24pt semibold (CalendarWeekStrip.swift:193).
        control.element.innerHTML = `<svg viewBox="0 0 19 26" aria-hidden="true" focusable="false"><path d="${i === 0 ? "M12.1 4.5 3.1 13.5 12.1 22.5" : "M6.1 4.5 15.1 13.5 6.1 22.5"}" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
        control.element.classList.add("calendar-chevron");
    }
    if (state.start !== undefined && state.start !== calendarWeek(new Date(handlers.now))[0]) {
        const todayControl = actionButton("today", translate("calendar.today"), () => change(0));
        todayControl.element.setAttribute("aria-label", translate("calendar.jumpToToday"));
        controls.push(todayControl);
    }
    const filters = FILTERS.map(value => {
        const item = actionButton(`filter:${value}`, filterLabel(value), () => change(value));
        item.element.setAttribute("aria-pressed", String(state.filter === value));
        return item;
    });
    const zones: Zone[] = [{ id: "filters", layout: "row", items: filters, entry: `filter:${state.filter}` }];
    const content = [zoneNode("browse-actions calendar-filters", filters)];
    const status = el("div", "calendar-status");
    status.setAttribute("data-calendar-busy", String(busy));
    const shelves = dates.map(date => {
        const day = state.data?.days.find(day => day.date === date);
        const keys = calendarEventKeys(day?.items ?? []);
        return { date, items: (day?.items ?? []).map((event, i) => {
            return eventCard(event, keys[i] ?? "", state.data?.query.timezone ?? "", context);
        }) };
    });
    const days = dates.map(date => {
        const label = calendarDateLabel(date, "short");
        const item = actionButton(`day:${date}`, label, () => {
            state.selectedDay = date;
            const shelf = shelves.find(shelf => shelf.date >= date && shelf.items.length > 0) ?? [...shelves].reverse().find(shelf => shelf.date < date && shelf.items.length > 0);
            const first = shelf?.items[0];
            if (shelf !== undefined && first !== undefined) {
                state.alignDay = shelf.date;
                focus({ zone: shelf.date, key: first.key });
            } else focus({ zone: "days", key: `day:${date}` });
        });
        item.element.classList.add("calendar-day");
        item.element.setAttribute("aria-label", label);
        item.element.textContent = "";
        item.element.append(el("span", "calendar-weekday", abbreviatedWeekday(dayDate(date))), el("span", "calendar-day-number", new Intl.DateTimeFormat(shownLocale(), { day: "numeric" }).format(dayDate(date))));
        if (state.data !== undefined) {
            const hasEvents = shelves.some(shelf => shelf.date === date && shelf.items.length > 0);
            item.element.setAttribute("data-has-events", String(hasEvents));
            // Apple always lays out the 8pt dot, clear when the day has no events, so the digit stays put.
            const dot = el("span", hasEvents ? "calendar-day-mark calendar-event-dot" : "calendar-day-mark");
            dot.setAttribute("aria-hidden", "true");
            item.element.appendChild(dot);
        }
        item.element.setAttribute("aria-pressed", String(state.selectedDay === date));
        if (date === today) item.element.setAttribute("aria-current", "date");
        return item;
    });
    const stripItems = [...controls.slice(0, 1), ...days, ...controls.slice(1)];
    const strip = zoneNode("calendar-week", stripItems);
    if (dates[3] !== undefined) strip.appendChild(el("span", "calendar-month", new Intl.DateTimeFormat(shownLocale(), { month: "long", year: "numeric" }).format(dayDate(dates[3]))));
    strip.setAttribute("data-scroll-top", "");
    content[0]?.setAttribute("data-scroll-top", "");
    content.push(strip, status);
    const dayZone: Zone = { id: "days", layout: "row", items: stripItems, get entry() { return `day:${state.selectedDay ?? dates[0]}`; } };
    zones.push(dayZone);
    if (state.data === undefined) {
        if (failure !== undefined) {
            const error = state.error ?? failureState(failure);
            const page = searchState(errorHeadline(error), errorMessage(error), "calendar-failure", FAILURE_ICON);
            page.setAttribute("role", "alert");
            const action = actionButton("retry", translate("shell.errorView.tryAgain"), retry);
            page.appendChild(zoneNode("browse-actions", [action]));
            content.push(page);
            zones.push({ id: "status", layout: "row", items: [action] });
        } else {
            const page = el("div", "calendar-loading");
            page.tabIndex = -1;
            page.setAttribute("data-focus", "calendar-page");
            page.setAttribute("aria-label", "Loading Calendar");
            page.setAttribute("role", "status");
            content.push(page);
            zones.push({ id: "status", layout: "row", items: [{ key: "calendar-page", element: page }] });
        }
    }
    const empty = state.data !== undefined && !busy && failure === undefined && shelves.every(shelf => shelf.items.length === 0);
    if (empty) {
        const copy = state.filter === "following" ? [translate("calendar.empty.following"), translate("calendar.empty.followingBody")] : state.filter === "trending" ? [translate("calendar.empty.trending"), translate("calendar.empty.trendingBody")] : [translate("calendar.empty.everything"), translate("calendar.empty.everythingBody")];
        const panel = searchState(copy[0] ?? "", copy[1] ?? "", "calendar-empty", CALENDAR_ICON);
        const links = FILTERS.filter(value => value !== state.filter).map(value => actionButton(`empty:${value}`, filterLabel(value), () => { state.emptyLinkFocus = true; change(value); }));
        panel.appendChild(zoneNode("calendar-empty-links", links));
        content.push(panel);
        zones.push({ id: "empty", layout: "row", items: links });
    }
    for (const shelf of empty || state.data === undefined ? [] : shelves) {
        const section = el("section", "calendar-shelf");
        section.style.setProperty("--calendar-scale", String(context.posterScale?.() ?? 1));
        section.setAttribute("data-section", shelf.date);
        section.setAttribute("data-scroll-align", "bottom");
        if (state.alignDay === shelf.date) {
            section.setAttribute("data-scroll-anchor", "top");
            delete state.alignDay;
        }
        const heading = shelf.date === today ? translate("calendar.today") : shelf.date === shiftDay(today, 1) ? translate("calendar.tomorrow") : new Intl.DateTimeFormat(shownLocale(), { weekday: "long", month: "long", day: "numeric" }).format(dayDate(shelf.date));
        section.appendChild(el("h2", "browse-section-title", heading));
        section.classList.toggle("calendar-shelf-empty", shelf.items.length === 0);
        section.appendChild(shelf.items.length === 0 ? el("p", "browse-text", translate("calendar.nothingScheduled")) : zoneNode("browse-row", shelf.items));
        if (shelf.items.length === 0) {
            const icon = el("span", "calendar-moon");
            icon.setAttribute("aria-hidden", "true");
            icon.innerHTML = MOON_ICON;
            section.lastElementChild?.prepend(icon);
        }
        content.push(section);
        zones.push({ id: shelf.date, layout: "row", items: shelf.items, spatial: true });
    }
    if (failure !== undefined && state.data !== undefined) {
        // A failed quiet refresh retains its cards, as CalendarViewModel.load does.
        const action = actionButton("retry", translate("shell.errorView.tryAgain"), retry);
        status.setAttribute("role", "alert");
        const note = el("p", "browse-text", state.error === undefined ? failure : errorMessage(state.error));
        markEnglishOnly(note, note.textContent ?? "");
        status.appendChild(note);
        content.push(zoneNode("browse-actions", [action]));
        zones.push({ id: "status", layout: "row", items: [action] });
    }
    const first = days.find(day => day.key === `day:${state.selectedDay}`) ?? days[0];
    let initial = first === undefined ? { zone: "status", key: failure === undefined ? "calendar-page" : "retry" } : { zone: "filters", key: `filter:${state.filter}` };
    if (state.emptyLinkFocus) {
        if (empty) initial = { zone: "empty", key: `empty:${FILTERS.find(value => value !== state.filter)}` };
        else if (state.data === undefined) initial = { zone: "status", key: failure === undefined ? "calendar-page" : "retry" };
        if (state.data !== undefined) state.emptyLinkFocus = false;
    }
    return { name: "calendar", content, zones, focus: initial, back };
}
