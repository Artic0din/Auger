// The audiobook detail page, full description screen and chapter picker, after silo-apple TVAudiobookDetailView,
// TVAudiobookDetailSections, TVAudiobookDescriptionView and TVAudiobookChaptersView (198a3e9). Playback is a later
// change: Play and Start Over are drawn and focusable but inert (aria-disabled) until the player can open an audiobook.

import type { Audiobook } from "../contracts/v2/audiobooks.ts";
import { audiobookPage, descriptionPassages, formatRuntime, type AudiobookPage, type PickerRow } from "./audiobookDetail.ts";
import { detailAction } from "./detailsActions.ts";
import type { DetailsState } from "./detailsState.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl } from "./browseModel.ts";
import { actionButton, artwork, cardItem, type ViewContext, zoneNode } from "./browseViews.ts";
import { artworkSymbol, defaultArtwork } from "./defaultArtwork.ts";
import { el } from "./screen.ts";
import { isolated } from "../i18n/direction.ts";
import { percentText } from "../i18n/format.ts";
import { integerText } from "../i18n/numbers.ts";
import { textLanguage, translate } from "../i18n/translate.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
    play: "M8 4 21 12 8 20Z",
    restart: "M4 12a8 8 0 1 0 2.3-5.6L4 8.7M4 4v4.7h4.7",
    chapters: "M8 6H21M8 12H21M8 18H21M3 6H4M3 12H4M3 18H4",
} as const;

function glyph(name: keyof typeof ICONS): SVGSVGElement {
    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("fill", name === "play" ? "currentColor" : "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    const shape = document.createElementNS(SVG_NS, "path");
    shape.setAttribute("d", ICONS[name]);
    icon.appendChild(shape);
    return icon;
}

/** Stand-in for SF Symbol person.wave.2 beside an alternate narration row (TVAudiobookDetailSections.swift:172). */
function narratorIcon(): SVGSVGElement {
    const icon = document.createElementNS(SVG_NS, "svg");
    icon.setAttribute("viewBox", "0 0 28 24");
    icon.setAttribute("aria-hidden", "true");
    icon.dataset.symbol = "person.wave.2";
    icon.classList.add("audiobook-row-icon");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.9");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    const head = document.createElementNS(SVG_NS, "circle");
    head.setAttribute("cx", "9");
    head.setAttribute("cy", "7.5");
    head.setAttribute("r", "3.5");
    const body = document.createElementNS(SVG_NS, "path");
    body.setAttribute("d", "M3 19.5c0-3.2 2.7-5 6-5s6 1.8 6 5");
    const waves = document.createElementNS(SVG_NS, "path");
    waves.setAttribute("d", "M18.5 8.2a4.6 4.6 0 0 1 0 5.6M22 5.5a8.5 8.5 0 0 1 0 11");
    icon.append(head, body, waves);
    return icon;
}

/** The pill Apple draws for Resume, Chapters and Start Over. */
function pill(key: string, label: string, icon: keyof typeof ICONS, onPress: (() => void) | undefined, variant: "primary" | "secondary"): FocusItem {
    const item = actionButton(key, label, onPress ?? (() => undefined));
    item.element.classList.add("audiobook-pill", `audiobook-pill-${variant}`);
    item.element.replaceChildren(glyph(icon), el("span", "audiobook-pill-label", label));
    if (onPress === undefined) item.element.setAttribute("aria-disabled", "true");
    return item;
}

/** TVAudiobookDetailView.swift:359-371 — reuses Details circle button and Favorites state. */
function favoriteButton(details: DetailsState | undefined): FocusItem {
    const value = details?.values.get("favorites");
    const change = details?.changes.get("favorites");
    const pressed = details === undefined ? false : change?.pending ? change.target : value;
    const item = actionButton("favorite", translate(pressed === true ? "detail.more.removeFavorite" : "detail.more.addFavorite"), () => {
        if (details === undefined) return;
        if (value === undefined) {
            if (details.personalFailed && !details.busy) details.loadPersonal();
            return;
        }
        details.change("favorites", change?.failed ? change.target : !value, change?.failed);
    });
    if (pressed !== undefined) item.element.setAttribute("aria-pressed", String(pressed));
    return detailAction(item);
}

/** TVAudiobookDetailView.swift:373-385 — reuses Details circle button and watched state. */
function finishedButton(book: Audiobook, details: DetailsState | undefined): FocusItem {
    const value = details?.values.get("watched") ?? book.played;
    const change = details?.changes.get("watched");
    const pressed = change?.pending ? change.target : value;
    const item = actionButton("finished", translate(pressed ? "detail.audiobook.markNotFinished" : "detail.audiobook.markFinished"), () => {
        details?.change("watched", change?.failed ? change.target : !value, change?.failed);
    });
    item.element.setAttribute("aria-pressed", String(pressed));
    return detailAction(item);
}

function ring(fraction: number, label: string): HTMLElement {
    const node = el("div", "audiobook-ring");
    node.style.setProperty("--audiobook-ring", `${Math.round(Math.min(1, Math.max(0, fraction)) * 360)}deg`);
    node.append(el("span", "audiobook-ring-label", label));
    return node;
}

function stateCluster(page: AudiobookPage): HTMLElement {
    const lines = el("div", "audiobook-state-lines");
    lines.append(el("p", "audiobook-state-line", page.state.line1));
    if (page.state.line2 !== undefined) lines.append(el("p", "audiobook-state-detail", page.state.line2));
    const cluster = el("div", "audiobook-state");
    cluster.dataset.state = page.state.kind;
    if (page.state.kind === "inProgress") cluster.append(ring(page.state.fraction, percentText(page.state.percent)));
    else if (page.state.kind === "finished") cluster.append(ring(1, percentText(100)));
    cluster.append(lines);
    return cluster;
}

function credits(page: AudiobookPage): HTMLElement | undefined {
    if (page.credits === undefined) return undefined;
    const { author, narrator } = page.credits;
    // One catalog message with the names restyled in place, so a translation can reorder it (TVAudiobookDetailView.creditsText).
    const message = author !== undefined && narrator !== undefined ? translate("detail.audiobook.byAuthorReadBy", { author: isolated(author), narrator: isolated(narrator) })
        : author !== undefined ? translate("detail.audiobook.byAuthor", { author: isolated(author) }) : translate("detail.audiobook.readBy", { narrator: isolated(narrator ?? "") });
    const line = el("p", "audiobook-credits");
    const names = [author, narrator].filter((name): name is string => name !== undefined && name !== "").sort((a, b) => b.length - a.length);
    const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    // Every occurrence: an author who narrates appears twice.
    for (const piece of escaped.length === 0 ? [message] : message.split(new RegExp(`(${escaped.join("|")})`))) {
        line.append(names.includes(piece) ? el("strong", "", piece) : piece);
    }
    return line;
}

function cover(book: Audiobook, context: ViewContext): HTMLElement {
    return artwork("audiobook-cover", book.posterUrl, context.baseUrl, defaultArtwork(artworkSymbol("audiobook")));
}

export function backdrop(posterUrl: string | undefined, baseUrl: string): HTMLElement {
    const wash = el("div", "audiobook-backdrop");
    wash.setAttribute("aria-hidden", "true");
    const source = artworkUrl(posterUrl, baseUrl);
    if (source !== undefined) {
        const image = el("img", "audiobook-backdrop-image");
        image.alt = "";
        image.referrerPolicy = "no-referrer";
        image.addEventListener("error", () => image.remove());
        image.src = source;
        wash.append(image);
    }
    return wash;
}

function sectionTitle(text: string): HTMLElement {
    return el("h2", "audiobook-section-title", text);
}

/** About, other narrations and the discovery rails below the fold. */
function sections(page: AudiobookPage, handlers: AudiobookHandlers): { content: HTMLElement[]; zones: Zone[] } {
    const { context } = handlers;
    const body = page.sections;
    const content: HTMLElement[] = [];
    const zones: Zone[] = [];
    if (body.about !== undefined || body.facts.length > 0) {
        // TVAudiobookDetailSections.aboutSection: heading sits above a single full-width focus stop holding clamped overview + facts.
        const block = el("section", "audiobook-section");
        block.append(sectionTitle(translate("detail.audiobook.about")));
        let overviewNode: HTMLElement | undefined;
        let moreTag: HTMLElement | undefined;
        const truncated = (): boolean => overviewNode !== undefined && overviewNode.scrollHeight > overviewNode.clientHeight + 1;
        const stop = actionButton("about", "", () => {
            if (body.about !== undefined && truncated()) handlers.setDescription?.(true);
        });
        stop.element.classList.add("audiobook-about-stop");
        stop.element.setAttribute("aria-label", translate("detail.audiobook.about"));
        const columns = el("div", "audiobook-about-columns");
        if (body.about !== undefined) {
            const overviewCol = el("div", "audiobook-about-overview");
            overviewNode = el("p", "audiobook-about", body.about);
            moreTag = el("span", "audiobook-about-more", translate("detail.overviewMore"));
            moreTag.hidden = true;
            overviewCol.append(overviewNode, moreTag);
            columns.append(overviewCol);
            queueMicrotask(() => {
                if (overviewNode === undefined || moreTag === undefined || !overviewNode.isConnected) return;
                const cut = truncated();
                moreTag.hidden = !cut;
                if (cut) {
                    stop.element.dataset.truncated = "true";
                    stop.element.setAttribute("aria-haspopup", "dialog");
                }
            });
        }
        if (body.facts.length > 0) {
            const list = el("dl", body.about === undefined ? "audiobook-facts audiobook-facts-alone" : "audiobook-facts");
            for (const fact of body.facts) {
                const row = el("div", "audiobook-fact");
                row.append(
                    el("dt", "audiobook-fact-label", fact.label.toLocaleUpperCase(textLanguage())),
                    el("dd", "audiobook-fact-value", fact.value),
                );
                list.append(row);
            }
            columns.append(list);
        }
        stop.element.append(columns);
        block.append(stop.element);
        content.push(block);
        zones.push({ id: "about", layout: "column", spatial: true, items: [stop] });
    }
    if (body.narrations.length > 0) {
        const items = body.narrations.map(narration => {
            const row = actionButton(`narration:${narration.id}`, "", () => context.open({ kind: "audiobook", id: narration.id, title: narration.label }));
            row.element.classList.add("audiobook-row");
            row.element.append(narratorIcon(), el("span", "audiobook-row-title", narration.label));
            if (narration.year !== undefined) row.element.append(el("span", "audiobook-row-detail", integerText(narration.year)));
            return row;
        });
        const block = el("section", "audiobook-section");
        block.append(sectionTitle(translate("detail.audiobook.narrations")), zoneNode("audiobook-rows", items));
        content.push(block);
        zones.push({ id: "narrations", layout: "column", spatial: true, items });
    }
    body.rails.forEach((rail, index) => {
        const items = rail.items.flatMap(entry => {
            const card = cardItem(
                { id: entry.id, type: "audiobook", title: entry.title, year: entry.year, posterUrl: entry.posterUrl, seriesId: undefined, seriesTitle: undefined, seasonNumber: undefined, episodeNumber: undefined },
                { ...context, cardLayout: "square", homeCaptions: false },
            );
            if (card === undefined) return [];
            if (entry.caption !== undefined) {
                card.element.querySelector(".browse-card-subtitle")?.remove();
                card.element.append(el("span", "browse-card-subtitle", entry.caption));
            }
            return [card];
        });
        const block = el("section", "audiobook-section");
        block.append(sectionTitle(rail.title), zoneNode("browse-row audiobook-rail", items));
        content.push(block);
        zones.push({ id: `rail:${index}`, layout: "row", spatial: true, entry: items[0]?.key, items });
    });
    return { content, zones };
}

export interface AudiobookHandlers {
    readonly context: ViewContext;
    readonly details?: DetailsState | undefined;
    readonly pickerOpen: boolean;
    readonly setPicker: (open: boolean) => void;
    readonly descriptionOpen?: boolean | undefined;
    readonly setDescription?: ((open: boolean) => void) | undefined;
    readonly back: () => void;
}

/** The page, its description screen and its Chapters picker carry no marquee: nothing previews an audiobook on focus. */
function withoutPreview(context: ViewContext): ViewContext {
    const { preview, ...rest } = context;
    void preview;
    return rest;
}

export function audiobookView(book: Audiobook, given: AudiobookHandlers): View {
    const handlers = { ...given, context: withoutPreview(given.context) };
    const page = audiobookPage(book);
    if (handlers.pickerOpen && page.showsChapters) return pickerView(book, page, handlers);
    if (handlers.descriptionOpen === true && page.sections.about !== undefined) return descriptionView(book, page, handlers);
    return detailView(book, page, handlers);
}

function detailView(book: Audiobook, page: AudiobookPage, handlers: AudiobookHandlers): View {
    const { context, details } = handlers;
    const actions: FocusItem[] = [pill("play", page.primary.label, page.primary.icon, undefined, "primary")];
    if (page.showsChapters) actions.push(pill("chapters", translate("detail.audiobook.chapters"), "chapters", () => handlers.setPicker(true), "secondary"));
    if (page.resumeSeconds !== undefined) actions.push(pill("start-over", translate("detail.startOver"), "restart", undefined, "secondary"));
    if (details?.personalSupported !== false) actions.push(favoriteButton(details));
    actions.push(finishedButton(book, details));

    const identity = el("div", "audiobook-identity");
    const eyebrow = el("p", "audiobook-eyebrow");
    eyebrow.append(el("span", "audiobook-eyebrow-rule"), page.eyebrow);
    identity.append(eyebrow, el("h1", "audiobook-title", page.title));
    if (page.seriesLine !== undefined) identity.append(el("p", "audiobook-series", page.seriesLine.toLocaleUpperCase(textLanguage())));
    const byline = credits(page);
    if (byline !== undefined) identity.append(byline);
    const actionRow = zoneNode("audiobook-actions", actions);
    actionRow.dataset.scrollTop = "true";
    identity.append(stateCluster(page), actionRow);

    const hero = el("section", "audiobook-hero");
    hero.append(cover(book, context), identity);
    const below = sections(page, handlers);
    const root = el("div", "audiobook-page");
    root.dataset.mediaType = "audiobook";
    root.append(backdrop(book.posterUrl, context.baseUrl), hero);
    if (below.content.length > 0) {
        const rest = el("div", "audiobook-sections");
        rest.append(...below.content);
        root.append(rest);
    }
    return {
        name: `audiobook:${book.id}`,
        content: [root],
        zones: [{ id: "actions", layout: "row", spatial: true, restoreEntry: "play", items: actions }, ...below.zones],
        focus: { zone: "actions", key: "play" },
        back: handlers.back,
    };
}

/** TVAudiobookDescriptionView: sticky cover + title beside focusable description passages. */
function descriptionView(book: Audiobook, page: AudiobookPage, handlers: AudiobookHandlers): View {
    const overview = page.sections.about ?? "";
    const identity = el("div", "audiobook-description-identity");
    identity.append(cover(book, handlers.context), el("h1", "audiobook-description-title", page.title));
    if (page.seriesLine !== undefined) identity.append(el("p", "audiobook-description-series", page.seriesLine.toLocaleUpperCase(textLanguage())));

    const passageItems = descriptionPassages(overview).map(passage => {
        const item = actionButton(`passage:${passage.id}`, passage.text, () => undefined);
        item.element.classList.add("audiobook-passage");
        if (passage.startsParagraph && passage.id > 0) item.element.classList.add("audiobook-passage-paragraph");
        return item;
    });

    const body = el("div", "audiobook-description-body");
    body.dataset.scrollKey = "audiobook-description";
    body.append(sectionTitle(translate("detail.audiobook.about")), zoneNode("audiobook-passages", passageItems));

    const layout = el("div", "audiobook-description-layout");
    layout.append(identity, body);

    const scrim = el("div", "audiobook-description-scrim");
    scrim.setAttribute("aria-hidden", "true");

    const root = el("div", "audiobook-description");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", translate("detail.audiobook.about"));
    root.append(backdrop(book.posterUrl, handlers.context.baseUrl), scrim, layout);

    return {
        name: `audiobook:${book.id}:description`,
        content: [root],
        zones: [{ id: "passages", layout: "column", items: passageItems }],
        focus: passageItems[0] === undefined ? undefined : { zone: "passages", key: passageItems[0].key },
        back: () => handlers.setDescription?.(false),
    };
}

function rowNode(row: PickerRow): FocusItem {
    const item = actionButton(row.id, "", () => undefined);
    item.element.classList.add("audiobook-row", "audiobook-chapter");
    item.element.dataset.current = String(row.isCurrent);
    item.element.dataset.done = String(row.isDone);
    const aria = [`${integerText(row.number)}. ${row.title}`, formatRuntime(row.duration), row.isCurrent ? translate("detail.audiobook.nowBadge") : undefined, row.isDone ? translate("detail.audiobook.finished") : undefined].filter(Boolean).join(", ");
    item.element.setAttribute("aria-label", aria);
    item.element.append(el("span", "audiobook-chapter-number", integerText(row.number)), el("span", "audiobook-row-title", row.title));
    if (row.isDone) item.element.append(el("span", "audiobook-chapter-done", "✓"));
    if (row.isCurrent) item.element.append(el("span", "audiobook-chapter-now", translate("detail.audiobook.nowBadge")));
    item.element.append(el("span", "audiobook-row-detail", formatRuntime(row.duration)));
    if (row.isCurrent && row.progress !== undefined && row.progress > 0) {
        const underline = el("span", "audiobook-chapter-progress");
        underline.style.width = `${Math.round(row.progress * 1000) / 10}%`;
        item.element.append(underline);
    }
    return item;
}

function pickerView(book: Audiobook, page: AudiobookPage, handlers: AudiobookHandlers): View {
    const items = page.picker.rows.map(rowNode);
    const header = el("header", "audiobook-picker-header");
    const titles = el("div", "audiobook-picker-titles");
    titles.append(el("h1", "audiobook-picker-title", translate("detail.audiobook.chapters")), el("p", "audiobook-picker-subline", page.picker.subline));
    header.append(cover(book, handlers.context), titles);
    const root = el("div", "audiobook-picker");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", translate("detail.audiobook.chapters"));
    root.append(header, zoneNode("audiobook-rows", items));
    return {
        name: `audiobook:${book.id}:chapters`,
        content: [root],
        zones: [{ id: "chapters", layout: "column", items }],
        focus: { zone: "chapters", key: page.picker.defaultRowId ?? items[0]?.key ?? "" },
        back: () => handlers.setPicker(false),
    };
}
