// DOM for item pages (movie, series, episode) and a season's episode list.

import type { Episode, ItemDetail, Season } from "../contracts/v2/catalog.ts";
import type { Credit, Person } from "../contracts/v2/details.ts";
import type { Card } from "../contracts/v2/catalog.ts";
import type { Destination } from "./browseModel.ts";
import type { DetailsState } from "./detailsState.ts";
import { type DescriptionTranslationStatus } from "./descriptionTranslation.ts";
import type { FocusItem, View, Zone } from "./browseFocus.ts";
import { artworkUrl, clockTime, episodeLabel, playChoices, seriesPlayback, withStartAudioLanguage, type PlayRequest } from "./browseModel.ts";
import { trailerCards, type TrailerCard } from "./trailerRail.ts";
import { actionButton, artwork, cardItem, heading, lines, mediaItem, type ViewContext, zoneNode } from "./browseViews.ts";
import { boxSetMovieRow, type BoxSetRowState } from "./boxSetRow.ts";
import { blurEpisodeStill, episodeDetailPresentation, hidesEpisodeListStill } from "./episodeSpoilers.ts";
import { personMetadataBadges, personPortrait } from "./personHero.ts";
import { el, onDecoded } from "./screen.ts";
import { detailAction, detailPanel } from "./detailsActions.ts";
import { defaultSubtitle, initialSubtitle, matchesSubtitle } from "../player/preplaySubtitles.ts";
import { audioTitle as trackAudioTitle, languageName, orderSubtitles, subtitlePillSummary, titleIndicatesHearingImpaired } from "../player/trackLabels.ts";
import type { SubtitleSignature } from "../contracts/v2/preplaySubtitles.ts";
import { seasonName, seriesEpisodesView } from "./seriesEpisodesView.ts";
import { shownLanguage } from "../i18n/language.ts";
import { durationText } from "../i18n/duration.ts";
import { integerText } from "../i18n/numbers.ts";
import { textLanguage, translate } from "../i18n/translate.ts";
import { heroBackdrop, type Tints } from "./heroBackdrop.ts";
import { detailDate, episodeAirDate, episodeRuntime } from "./episodeCaption.ts";
import { TMDB_LOGO_PATH } from "./acknowledgements.ts";
import { spinner } from "./marquee.ts";
import { defaultArtwork } from "./defaultArtwork.ts";
import { centredDialog } from "./confirmationDialog.ts";
import { choiceFromDetail } from "./watchPartyChoice.ts";

export const detailPalette = new Map<string, Tints>();
/** TVDecodedLogoTitle's easeInOut(duration: 0.2). */
const LOGO_CROSSFADE_MS = 200;
/** Logo URLs that have decoded on a visible Details page. Later paints of the same visit seed that image, as TVDecodedLogoTitle does from the pipeline cache (silo-apple e28300c61f044a9322f588203c8819d6f06e6197, TVDetailHero.swift). */
const decodedTitleLogos = new Set<string>();

interface RetainedBlock {
    readonly key: string;
    readonly deps: readonly unknown[];
    readonly content: readonly HTMLElement[];
    readonly zones: readonly Zone[];
}

interface DetailsDomCache {
    currentContext?: ViewContext | undefined;
    currentPlay?: ((request: PlayRequest) => void) | undefined;
    hero?: {
        readonly backdropKey: string;
        readonly wash: HTMLElement;
        readonly layout: HTMLElement;
        readonly background: HTMLElement;
    } | undefined;
    title?: {
        readonly key: string;
        readonly element: HTMLElement;
        readonly armed: boolean;
        readonly guard: (() => boolean) | undefined;
    } | undefined;
    cast?: RetainedBlock | undefined;
    trailers?: RetainedBlock | undefined;
    boxSet?: RetainedBlock | undefined;
    related?: RetainedBlock | undefined;
    facts?: RetainedBlock | undefined;
}

const retainedDetails = new WeakMap<DetailsState, DetailsDomCache>();

function clearRetainedNodes(nodes: readonly HTMLElement[]): void {
    for (const node of nodes) {
        node.inert = false;
        node.removeAttribute("aria-hidden");
    }
}

function clearHeroLoadingState(hero: HTMLElement): void {
    hero.removeAttribute("tabindex");
    delete hero.dataset.focus;
    hero.removeAttribute("aria-busy");
    hero.removeAttribute("aria-label");
}

function sameDeps(left: readonly unknown[], right: readonly unknown[]): boolean {
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

function useRetained(
    cache: DetailsDomCache | undefined,
    slot: "cast" | "trailers" | "boxSet" | "related" | "facts",
    key: string,
    deps: readonly unknown[],
    build: () => { readonly content: readonly HTMLElement[]; readonly zones: readonly Zone[] },
): { readonly content: readonly HTMLElement[]; readonly zones: readonly Zone[]; readonly prepare?: (() => void) | undefined } {
    const existing = cache?.[slot];
    if (existing !== undefined && existing.key === key && sameDeps(existing.deps, deps)) {
        return { ...existing, prepare: () => clearRetainedNodes(existing.content) };
    }
    const fresh = build();
    if (cache !== undefined) cache[slot] = { key, deps, ...fresh };
    return fresh;
}

/** OverlayData.advisoryAgeBadgeLabel at silo-apple e28300c6. */
function advisoryAgeBadgeLabel(age: number | undefined, source: string | undefined): string | undefined {
    if (age === undefined || age <= 0) return undefined;
    const named = source?.toLowerCase() === "commonsense" ? "Common Sense" : source?.toLowerCase() === "mdblist" ? "MDBList" : undefined;
    return [named, `${age}+`].filter(part => part !== undefined).join(" ");
}

/** TVHeroMetadata fact tokens. Series omits runtime; an episode uses its air date. */
function factTokens(detail: ItemDetail, state: DetailsState | undefined, episode: Episode | undefined): string[] {
    if (episode !== undefined) {
        const playback = state?.nextEpisodeState;
        const selectedFile = playback?.detail.versions.find(file => file.fileId === playChoices(playback.detail, playback.selectedFileId, playback.preferredQuality)?.fromStart.fileId);
        const minutes = selectedFile?.durationSeconds ? Math.round(selectedFile.durationSeconds / 60) : episode.runtimeMinutes;
        return [episodeAirDate(episode.airDate), episodeRuntime(minutes)].filter((token): token is string => token !== undefined);
    }
    const tokens: string[] = [];
    if (detail.type === "episode") {
        const aired = episodeAirDate(detail.airDate);
        if (aired !== undefined) tokens.push(aired);
    } else if (detail.year !== undefined && detail.year > 0) tokens.push(integerText(detail.year));
    if (detail.type !== "series" && detail.runtimeMinutes !== undefined && detail.runtimeMinutes > 0) {
        const file = detail.versions.find(version => version.fileId === playChoices(detail, state?.selectedFileId, state?.preferredQuality)?.fromStart.fileId);
        const minutes = file?.durationSeconds ? Math.round(file.durationSeconds / 60) : detail.runtimeMinutes;
        tokens.push(durationText(minutes, true));
    }
    const count = state?.series?.seasons.filter(season => !season.isSpecials && season.seasonNumber !== 0).length;
    if (detail.type === "series" && count) tokens.push(translate("catalog.seasons", { count }));
    return tokens;
}

/** Genres are one source token. A focused series episode splits season and episode. */
function sourceTokens(detail: ItemDetail, episode: Episode | undefined): string[] {
    if (episode !== undefined) return [seasonName(episode.seasonNumber), translate("detail.episode", { number: integerText(episode.episodeNumber) })];
    if (detail.type === "episode") {
        const season = detail.seasonNumber === undefined ? undefined : seasonName(detail.seasonNumber);
        const number = detail.episodeNumber !== undefined && detail.episodeNumber > 0 ? integerText(detail.episodeNumber) : undefined;
        if (season !== undefined && number !== undefined) return [translate("detail.episodeEyebrow", { season, episode: number })];
        return [season, number === undefined ? undefined : translate("detail.episode", { number })].filter((token): token is string => token !== undefined);
    }
    return detail.genres.length === 0 ? [] : [detail.genres.slice(0, 2).join(", ")];
}

/** TVSeriesDetailView's Play and Resume titles: "Play S1:E2", or the episode's own title when it has no season and episode number. */
function episodePlayLabel(resume: boolean, target: { readonly seasonNumber?: number | undefined; readonly episodeNumber?: number | undefined; readonly title: string }): string {
    const { seasonNumber, episodeNumber } = target;
    if (seasonNumber !== undefined && seasonNumber !== 0 && episodeNumber !== undefined) return translate(resume ? "detail.resumeEpisode" : "detail.playEpisode", { season: String(seasonNumber), episode: String(episodeNumber) });
    return `${translate(resume ? "detail.resume" : "common.play")} ${episodeLabel(seasonNumber, episodeNumber) ?? target.title}`;
}

function metadataRow(detail: ItemDetail, state: DetailsState | undefined, episode: Episode | undefined): HTMLElement | undefined {
    const chips: { text: string; advisory: boolean }[] = [];
    const ratingChip = detail.contentRating?.trim();
    if (ratingChip) chips.push({ text: ratingChip, advisory: false });
    if (state?.showAdvisoryAge) {
        const advisory = advisoryAgeBadgeLabel(detail.advisoryAge, detail.advisorySource);
        if (advisory !== undefined) chips.push({ text: advisory, advisory: true });
    }
    const facts = factTokens(detail, state, episode);
    const ratings = (episode === undefined ? detail.extra?.ratings : state?.nextEpisodeState?.detail.extra?.ratings) ?? [];
    const sources = sourceTokens(detail, episode);
    if (chips.length === 0 && facts.length === 0 && ratings.length === 0 && sources.length === 0) return undefined;
    const row = el("p", "browse-meta");
    for (const chip of chips) {
        const badge = el("span", "details-rating-badge", chip.text);
        if (chip.advisory) badge.dataset.advisoryAge = chip.text;
        row.append(badge);
    }
    for (const fact of facts) row.append(el("span", "details-fact", fact));
    for (const rating of ratings) {
        const badge = el("span", "details-external-rating");
        badge.setAttribute("aria-label", `${rating.name} ${rating.display}`);
        if (rating.name.toUpperCase() === "TMDB") {
            const logo = el("img", "skyline-rating-logo");
            logo.src = TMDB_LOGO_PATH;
            logo.alt = "TMDB";
            // The logo has no width until it loads, so the row is measured again then.
            logo.addEventListener("load", () => fitRatings(row));
            badge.append(logo);
        } else badge.append(el("span", "", rating.name));
        badge.append(el("span", "details-rating-score", rating.display));
        row.append(badge);
    }
    const namedGenres = episode === undefined && detail.type !== "episode";
    for (const source of sources) row.append(el("span", namedGenres ? "details-genres" : "details-source", source));
    return row;
}

function overviewText(overview: string, status: DescriptionTranslationStatus | undefined): HTMLElement {
    const text = el("p", "browse-text browse-overview", overview);
    if (status !== undefined) text.classList.add("has-translation-status");
    if (status?.kind === "translating") text.classList.add("is-translating");
    return text;
}

function translationStatus(status: DescriptionTranslationStatus): HTMLElement {
    const line = el("p", "description-translation-status");
    line.dataset.translationStatus = status.kind;
    // SF Symbol "translate", drawn as the More menu's Translate Description icon.
    line.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 5H14M8 2V5M5 5C5 11 10 14 14 15M12 5C12 11 7 14 3 15M13 22 18 10 23 22M15 18H21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    line.append(el("span", "", status.text));
    return line;
}

/** TVHeroTitle.split: the first of ": ", " — ", " – " or " - " whose trimmed halves are both non-empty. */
export function titleParts(raw: string): { primary: string; subtitle: string | undefined } {
    for (const separator of [": ", " \u2014 ", " \u2013 ", " - "]) {
        const at = raw.indexOf(separator);
        if (at < 0) continue;
        const head = raw.slice(0, at).trim(), tail = raw.slice(at + separator.length).trim();
        if (head !== "" && tail !== "") return { primary: head, subtitle: tail };
    }
    return { primary: raw, subtitle: undefined };
}

/**
 * TVDecodedLogoTitle: the text title stays until the logo has decoded, then the logo cross-fades in over 0.2 s.
 * A logo already decoded this visit, or Reduce Motion, swaps at once.
 */
export function decodedLogoTitle(holder: HTMLElement, logo: string | undefined, alt: string, allowed: () => boolean, showText: () => void, logoClass: string): void {
    showText();
    if (logo === undefined || !allowed()) return;
    const image = el("img", logoClass);
    image.alt = alt;
    image.referrerPolicy = "no-referrer";
    const cached = decodedTitleLogos.has(logo);
    onDecoded(image, () => {
        if (!allowed() || !holder.isConnected || holder.closest("[hidden]") !== null) return;
        decodedTitleLogos.add(logo);
        if (image.parentElement === holder) return;
        const outgoing = Array.from(holder.childNodes);
        holder.replaceChildren(image);
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        image.classList.add("details-logo-enter");
        const exit = el("span", "details-title-exit");
        exit.setAttribute("aria-hidden", "true");
        exit.append(...outgoing);
        holder.append(exit);
        setTimeout(() => exit.remove(), LOGO_CROSSFADE_MS);
    });
    image.addEventListener("error", () => {
        if (image.parentElement !== holder) return;
        decodedTitleLogos.delete(logo);
        showText();
    });
    image.src = logo;
    // A logo that already decoded this visit is in the title before the repaint connects, so the text fallback does not paint again.
    if (cached) holder.replaceChildren(image);
}

/** TVPlaybackSelectionSummaryView: a long value tightens, then shrinks to 0.75 of its size before it truncates. */
const READOUT_MIN_SCALE = 0.75;
function fitReadout(readout: HTMLElement): void {
    for (const value of Array.from(readout.querySelectorAll<HTMLElement>("span"))) {
        if (value.textContent === "" || value.scrollWidth <= value.clientWidth) continue;
        const size = parseFloat(getComputedStyle(value).fontSize);
        value.style.letterSpacing = "-0.5px";
        if (value.scrollWidth <= value.clientWidth) continue;
        value.style.fontSize = `${size * Math.max(READOUT_MIN_SCALE, value.clientWidth / value.scrollWidth)}px`;
    }
}

/** TVDetailHero factsRow's ViewThatFits: whole ratings drop from the end once genres have given way. */
function fitRatings(row: HTMLElement): void {
    while (row.scrollWidth > row.clientWidth + 0.5) {
        const last = Array.from(row.querySelectorAll(".details-external-rating")).at(-1);
        if (last === undefined) return;
        last.remove();
    }
}

/** TVPlaybackSelectionSummaryView: what Version, Audio and Subtitles are set to, each already in the shown language. */
interface PlaybackReadout {
    readonly version: string;
    readonly audio: string;
    readonly subtitles: string;
}

function retainedTitle(detail: ItemDetail, context: ViewContext, state: DetailsState | undefined, cache: DetailsDomCache | undefined): HTMLElement {
    const logo = artworkUrl(detail.extra?.logoUrl, context.baseUrl);
    const live = state?.generationGuard();
    const isLive = live?.() ?? false;
    const titleArt = context.titleArt?.() ?? false;
    const key = JSON.stringify([detail.title, logo ?? null, titleArt]);
    const existing = cache?.title;
    if (
        existing !== undefined && existing.key === key
        && (logo === undefined || !titleArt || existing.element.querySelector(".details-logo") !== null || (existing.armed ? existing.guard?.() === true : !isLive))
    ) {
        return existing.element;
    }
    const title = heading(detail.title);
    title.classList.add("requests-detail-title");
    const parts = titleParts(detail.title);
    const primary = el("span", "requests-title-primary", parts.primary);
    const secondary = parts.subtitle === undefined ? undefined : el("span", "requests-title-secondary", parts.subtitle);
    const showText = (): void => {
        title.replaceChildren(primary);
        if (secondary !== undefined) title.appendChild(secondary);
    };
    if (cache !== undefined) cache.title = { key, element: title, armed: Boolean(titleArt && logo !== undefined && isLive), guard: live };
    decodedLogoTitle(title, logo, detail.title, () => (live?.() ?? false) && (context.titleArt?.() ?? false) && (cache?.title === undefined || cache.title.element === title), showText, "details-logo");
    return title;
}

function retainedHero(detail: ItemDetail, context: ViewContext, hideBackdrop: boolean, info: HTMLElement, cache: DetailsDomCache | undefined): { readonly wash: HTMLElement; readonly layout: HTMLElement; readonly prepare: () => void } {
    const backdrop = artworkUrl(detail.backdropUrl, context.baseUrl) ?? "";
    const backdropKey = JSON.stringify([detail.type, backdrop, detail.backdropThumbhash ?? "", hideBackdrop]);
    const lift = detail.type === "series" && (context.posterScale?.() ?? 1) > 1 ? 32 : 0;
    const height = detail.type === "series" ? `${690 - lift}px` : "";
    if (detail.type === "series") info.style.paddingTop = `${116 - lift}px`;
    if (cache?.hero !== undefined && cache.hero.backdropKey === backdropKey) {
        const { wash, layout, background } = cache.hero;
        return {
            wash,
            layout,
            prepare: () => {
                clearRetainedNodes([wash, layout]);
                clearHeroLoadingState(layout);
                if (layout.style.height !== height) layout.style.height = height;
                if (layout.firstElementChild !== background) {
                    layout.replaceChildren(background, info);
                } else {
                    while (layout.children.length > 1) layout.lastElementChild?.remove();
                    layout.appendChild(info);
                }
            },
        };
    }
    const layout = el("div", "details-hero");
    layout.dataset.mediaType = detail.type;
    const background = heroBackdrop(backdrop, detail.backdropThumbhash, detailPalette, true, true);
    const frame = background.querySelector<HTMLElement>(".skyline-art-frame");
    if (hideBackdrop && frame !== null) blurEpisodeStill(frame);
    const wash = background.querySelector<HTMLElement>(".skyline-tint-wash")!;
    wash.classList.add("details-page-wash");
    wash.remove();
    if (layout.style.height !== height) layout.style.height = height;
    layout.replaceChildren(background, info);
    if (cache !== undefined) cache.hero = { backdropKey, wash, layout, background };
    return { wash, layout, prepare: () => undefined };
}

function detailHeader(detail: ItemDetail, context: ViewContext, actions: readonly FocusItem[], state?: DetailsState, summary?: PlaybackReadout, showsSummary = true, cache?: DetailsDomCache): { readonly content: readonly HTMLElement[]; readonly prepare: () => void } {
    const nodes: HTMLElement[] = [];
    const label = episodeLabel(detail.seasonNumber, detail.episodeNumber);
    if (detail.type === "episode" && (detail.seriesTitle !== undefined || label !== undefined)) {
        nodes.push(el("p", "browse-kicker", [detail.seriesTitle, label].filter((part) => part !== undefined).join(" · ")));
    }
    nodes.push(retainedTitle(detail, context, state, cache));
    const episode = state?.series?.episodes?.find(item => item.id === state.heroEpisodeId);
    const playback = state?.nextEpisodeState;
    const row = metadataRow(detail, state, episode);
    if (row !== undefined) nodes.push(row);
    const presentation = episodeDetailPresentation(detail, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false }, state?.values.get("watched"));
    const episodeOverview = episode === undefined ? undefined : episodeDetailPresentation({ type: "episode", overview: episode.overview || playback?.detail.overview, watch: { played: episode.played, isInProgress: episode.isInProgress, positionSeconds: episode.positionSeconds } }, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false }).overview;
    const overview = episode === undefined ? presentation.overview : [playback?.detail.title ?? episode.title, episodeOverview].filter(Boolean).join(" · ");
    const translation = state?.descriptions?.status(episode, playback?.detail);
    if (overview !== undefined && overview !== "") {
        nodes.push(overviewText(overview, translation));
        if (translation !== undefined) nodes.push(translationStatus(translation));
    }
    const directors = detail.extra?.crew.filter(credit => credit.role.toLowerCase() === "director").map(credit => credit.name);
    const credit = detail.type === "movie" ? directors?.length ? translate("detail.directedBy", { names: directors.slice(0, 2).join(", ") }) : undefined : detail.extra?.cast.length ? translate("detail.starring", { names: detail.extra.cast.slice(0, 3).map(person => person.name).join(", ") }) : undefined;
    if (credit !== undefined) nodes.push(el("p", "details-director", credit));
    // TVPlaybackSelectionSummaryView always keeps its labels; a value it does not know yet is a quiet bar.
    const readout = el("div", "details-playback-summary");
    for (const [name, label] of [["version", translate("detail.readout.version")], ["audio", translate("detail.readout.audio")], ["subtitles", translate("detail.readout.subtitles")]] as const) {
        const field = el("div", ""); field.dataset.trackSummary = name;
        field.append(el("strong", "", label), el("span", "", summary?.[name] ?? ""));
        readout.appendChild(field);
    }
    if (!showsSummary) { readout.style.opacity = "0"; readout.setAttribute("aria-hidden", "true"); }
    nodes.push(readout);
    // FocusHost places the view synchronously, so both are laid out by the next microtask.
    queueMicrotask(() => {
        if (row !== undefined) fitRatings(row);
        fitReadout(readout);
    });
    const info = el("div", "details-editorial");
    if (detail.type === "series") {
        const editorial = el("div", "details-series-editorial");
        const primary = el("div", "details-series-primary");
        const disclosure = el("div", "details-series-disclosure");
        primary.append(...nodes.filter(node => !node.matches(".details-director, .details-playback-summary")));
        disclosure.append(nodes.find(node => node.matches(".details-director")) ?? el("div", "details-director"), readout);
        editorial.append(primary, disclosure);
        info.appendChild(editorial);
    } else info.append(...nodes);
    info.appendChild(zoneNode("browse-actions", actions));
    // TVMovieDetailView.actionColumn: a movie's pill sits under the action row. A series draws it in the episode block.
    const status = detail.type === "series" ? undefined : trailerStatus(state);
    if (status !== undefined) info.append(status);
    const hero = retainedHero(detail, context, presentation.hideBackdrop, info, cache);
    return { content: [hero.wash, hero.layout], prepare: hero.prepare };
}

function trailerStatus(state: DetailsState | undefined): HTMLElement | undefined {
    if (state?.trailers.message === undefined) return undefined;
    const status = el("p", "details-trailer-status", state.trailers.message);
    status.setAttribute("role", "status");
    status.setAttribute("aria-busy", String(state.trailers.fetching));
    const indicator = state.trailers.fetching ? spinner() : el("span", "", "ⓘ");
    indicator.setAttribute("aria-hidden", "true");
    status.prepend(indicator);
    return status;
}

export function itemView(detail: ItemDetail, seasons: readonly Season[], context: ViewContext, play: (request: PlayRequest) => void, back: () => void, state?: DetailsState, boxSet?: BoxSetRowState): View {
    detail = state === undefined ? detail : { ...detail, versions: state.detail.versions };
    let cache = state === undefined ? undefined : retainedDetails.get(state);
    if (state !== undefined && cache === undefined) {
        cache = {};
        retainedDetails.set(state, cache);
    }
    if (cache !== undefined) {
        cache.currentContext = context;
        cache.currentPlay = play;
    }
    const deferredContext: ViewContext = cache === undefined ? context : {
        ...context,
        open: destination => (cache.currentContext ?? context).open(destination),
        ...(context.quickActions === undefined ? {} : {
            quickActions: (card, options) => (cache.currentContext ?? context).quickActions?.(card, options),
        }),
    };
    const deferredPlay = (request: PlayRequest): void => (cache?.currentPlay ?? play)(request);
    const tracks = state?.nextEpisodeState ?? state;
    const playbackDetail = tracks?.detail ?? detail;
    const playbackChoices = playChoices(playbackDetail, tracks?.selectedFileId, tracks?.preferredQuality);
    const preferences = state?.unsettledEpisode ?? tracks;
    const actions: FocusItem[] = [];
    let waitingForPlaybackTarget = false;
    const notes: string[] = [];
    if (preferences?.audioPreference.pending) notes.push("Saving audio preference…");
    if (preferences?.subtitlePreference.pending) notes.push("Saving subtitle preference…");
    if (preferences?.subtitlePreference.failed) notes.push("Subtitle preference could not be confirmed.");
    if (preferences?.audioPreference.failed) notes.push("Could not confirm the audio preference. Check before playing.");
    // Apple's row has no preference-check buttons, so Play re-sends an unconfirmed save before it plays.
    const retriedPreference = (): boolean => {
        if (state === undefined || preferences === undefined) return false;
        const failed = (["subtitles", "audio"] as const).filter(kind => (kind === "audio" ? preferences.audioPreference : preferences.subtitlePreference).failed);
        for (const kind of failed) state.retryPreference(kind, preferences);
        return failed.length > 0;
    };
    const savePending = [preferences, tracks].some(owner => owner?.audioPreference.pending === true || owner?.subtitlePreference.pending === true);
    // deferPlay keeps a press that raced a shared preference save; Play starts it once the save confirms.
    if (tracks?.failedPlay !== undefined && !savePending) notes.push("Press Play again to start playback.");
    const choices = playChoices(detail, state?.selectedFileId, state?.preferredQuality);
    const choose = (request: PlayRequest): void => {
        if (retriedPreference()) return;
        const audioTrackId = state?.audioTrackId(true);
        const next = { ...request, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(state === undefined ? {} : { subtitle: state.subtitleIntent() }) };
        play(withStartAudioLanguage(next, detail.versions.find(file => file.fileId === next.fileId)));
    };
    if (choices?.resume !== undefined) {
        const resume = choices.resume;
        actions.push(actionButton("resume", translate("detail.resumeAt", { time: clockTime(resume.startSeconds ?? 0) }), () => choose(resume)));
        actions.push(actionButton("play", translate("detail.startOver"), () => choose(choices.fromStart)));
    } else if (choices !== undefined) {
        actions.push(actionButton("play", translate("common.play"), () => choose(choices.fromStart)));
    } else if (detail.type === "movie" || detail.type === "episode") {
        // Apple keeps Play in the row; with no file to hand AVPlay it stays disabled beside this note.
        const play = actionButton("play", translate("common.play"), () => undefined);
        play.element.setAttribute("aria-disabled", "true");
        actions.push(play);
        notes.push("This title has no file this TV can play.");
    }
    const next = state?.series === undefined ? state?.playbackTargetId ?? detail.playContentId : state.playbackTargetId;
    if ((detail.type === "series" || detail.type === "season") && next !== undefined) {
        const target = state?.nextEpisode;
        const targetChoices = playbackChoices;
        const summary = state?.series?.railEpisodes?.find(episode => episode.id === next);
        const playNext = (startOver = false): void => {
            if (retriedPreference() || state?.episodePreferencesBlocked) return;
            if (target === undefined) { context.playEpisode?.(next, summary?.title ?? detail.title, startOver); return; }
            if (targetChoices === undefined) return;
            const audioTrackId = tracks?.audioTrackId(true);
            const request = { ...(targetChoices.resume ?? targetChoices.fromStart), startSeconds: startOver ? 0 : targetChoices.resume?.startSeconds, ...(audioTrackId === undefined ? {} : { audioTrackId }), ...(tracks === undefined ? {} : { subtitle: tracks.subtitleIntent() }) };
            play(withStartAudioLanguage(seriesPlayback(request, detail, summary), target.versions.find(file => file.fileId === request.fileId)));
        };
        const labelTarget = summary ?? target;
        const canResume = targetChoices?.resume !== undefined || target === undefined && summary?.inProgress === true;
        const failed = state?.nextEpisodeFailed === true;
        waitingForPlaybackTarget = labelTarget === undefined && !failed;
        // TVDetailActionRow: "Loading episodes…" while the list loads, else "Play" with no episode to name.
        const label = labelTarget === undefined ? failed ? translate("common.play") : translate("detail.episodes.loading") : episodePlayLabel(canResume, labelTarget);
        // A failed episode read still plays through the episode route, which loads its own detail.
        const primary = actionButton("next-episode", label, () => { if (primary.element.getAttribute("aria-disabled") !== "true") playNext(); });
        // After a failed read, Play still knows the episode id, so it plays through the episode route.
        const unplayable = waitingForPlaybackTarget || targetChoices === undefined && (state?.offline === true || target !== undefined);
        primary.element.setAttribute("aria-disabled", String(savePending || unplayable));
        actions.push(primary);
        if (canResume) actions.push(actionButton("start-over-episode", translate("detail.startOver"), () => playNext(true)));
        if (target !== undefined && targetChoices === undefined) notes.push("This episode has no file this TV can play.");
    }
    const seriesContext: ViewContext = { ...context, playEpisode: (id, title, startOver) => {
        const cached = state?.cachedEpisode(id);
        if (state?.episodePreferencesBlocked || cached?.audioPreference.pending || cached?.audioPreference.failed || cached?.subtitlePreference.pending || cached?.subtitlePreference.failed) return;
        const audioTrackId = cached?.audioTrackId(true);
        context.playEpisode?.(id, title, startOver, cached === undefined ? undefined : { ...(cached.selectedFileId === undefined ? {} : { fileId: cached.selectedFileId }), ...(audioTrackId === undefined ? {} : { audioTrackId }), subtitle: cached.subtitleIntent() });
    } };
    const series = state?.series === undefined ? undefined : seriesEpisodesView(state.series, seriesContext, id => state.focusEpisode(id), next, id => state.blurEpisode(id));
    const seasonItems = series?.zones[0]?.items ?? (detail.type === "series" ? seasons.map((season) => seasonItem(detail.id, detail.title, season, context)) : []);
    const overview = episodeDetailPresentation(detail, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false }, state?.values.get("watched")).overview;
    const file = playbackDetail.versions.find(file => file.fileId === playbackChoices?.fromStart.fileId);
    const autoLabel = translate("detail.auto");
    const compactVersion = file?.compactLabel ?? autoLabel;
    const versionValue = tracks?.selectedFileId === undefined && compactVersion !== autoLabel ? translate("detail.autoValue", { value: compactVersion }) : compactVersion;
    const audio = file?.audio ?? [];
    const selectedAudio = tracks?.audioTrackId(true);
    const explicitAudio = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
    const effectiveAudio = explicitAudio >= 0 ? explicitAudio : file?.effectiveAudioTrackIndex ?? audio.findIndex(track => track.isDefault);
    const resolvedAudioTrack = audio[effectiveAudio] ?? audio[0];
    const subtitle = tracks?.subtitleIntent();
    const subtitleLabel = (track: SubtitleSignature): string => subtitlePillSummary(track, "Unknown language");
    const selectedSubtitleLabel = subtitle?.kind === "track" ? subtitleLabel(subtitle.signature) : subtitle?.kind === "off" ? translate("detail.off") : autoLabel;
    const startDefault = defaultSubtitle(file?.subtitles ?? []);
    // Apple orders the Details preview as the start request does, externals first, so a forced fallback names the track that plays; ids stay catalog offsets.
    const autoSubtitle = file?.effectiveSubtitle === undefined ? undefined : initialSubtitle({ kind: "auto" }, (file.subtitles ?? []).map((track, index) => ({ ...track, trackId: String(index), combinedIndex: index, delivery: "unknown" as const, url: undefined, streamIndex: undefined, containerTrackId: undefined, nativeSelectable: undefined, hlsRendition: undefined })).sort((a, b) => Number(b.source === "external") - Number(a.source === "external")), { ...file.effectiveSubtitle, audioLanguage: resolvedAudioTrack?.language }, startDefault === undefined ? undefined : String(file.subtitles?.indexOf(startDefault)));
    const autoSubtitleTrack = autoSubtitle === undefined ? undefined : file?.subtitles?.[Number(autoSubtitle)];
    const subtitleSummary = subtitle?.kind === "track" || subtitle?.kind === "off" ? selectedSubtitleLabel : translate("detail.autoValue", { value: autoSubtitleTrack === undefined ? translate("detail.none") : subtitleLabel(autoSubtitleTrack) });
    const audioDetails = (index: number): string => {
        const track = audio[index];
        const rawLayout = track?.layout?.replace(/\(.*\)/, '').trim();
        const layout = /stereo/i.test(rawLayout ?? '') ? translate("detail.stereo") : /mono/i.test(rawLayout ?? '') ? translate("detail.mono") : rawLayout || (track?.channels === 6 ? '5.1' : track?.channels === 8 ? '7.1' : track?.channels === 2 ? translate("detail.stereo") : track?.channels === 1 ? translate("detail.mono") : track?.channels === undefined ? undefined : `${track.channels}ch`);
        return [track?.codec?.toUpperCase(), layout].filter(Boolean).join(' · ');
    };
    const audioTitle = (index: number): string => {
        const track = audio[index];
        const embedded = track?.embeddedTitle?.trim();
        const meaningful = embedded && !/^(?:ATSC|AC-?3|E-?AC-?3|AAC|DTS|FLAC|PCM|OPUS|MP3|VORBIS)(?:\b|$)/i.test(embedded) ? embedded : undefined;
        return meaningful ?? languageName(track?.language) ?? translate("detail.track", { number: integerText(index + 1) });
    };
    // TrackLabels.name: the language leads the popover row; a track's own title moves to its detail line.
    const audioRowTitle = (index: number): string => languageName(audio[index]?.language) ?? trackAudioTitle(audio[index]?.title, audio[index]?.language) ?? translate("detail.track", { number: integerText(index + 1) });
    const audioLabel = (index: number): string => [languageName(audio[index]?.language), audioDetails(index)].filter(Boolean).join(' · ') || audioTitle(index);
    // TVPlaybackActionSelectors stay mounted and disable until a version is known.
    if (state !== undefined) {
        const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
        const version = actionButton("version", `${translate("detail.version")}: ${versionValue}`, () => state.showPanel("version"));
        // TVPlaybackSelectorRow.isVersionDisabled: Versions opens only with more than one version to choose. Tizen shows no Edition
        // selector, so every version is in the choice (Apple's DetailPlaybackFormatting.versionSelectorVersions without editions).
        version.element.setAttribute("aria-disabled", String(playbackChoices === undefined || playbackDetail.versions.length < 2));
        version.element.setAttribute("aria-haspopup", "dialog");
        actions.push(version);
        const trigger = actionButton("audio", `${translate("detail.audio")}: ${ordinal === -1 ? autoLabel : audioLabel(ordinal)}`, () => state.showPanel("audio"));
        trigger.element.setAttribute("aria-disabled", String(playbackChoices === undefined || audio.length === 0));
        trigger.element.setAttribute("aria-haspopup", "dialog");
        trigger.element.setAttribute("aria-expanded", String(state.audioOpen));
        actions.push(trigger);
        const subtitles = actionButton("subtitles", `${translate("detail.subtitles")}: ${selectedSubtitleLabel}`, () => state.showPanel("subtitles"));
        subtitles.element.setAttribute("aria-disabled", String(playbackChoices === undefined));
        subtitles.element.setAttribute("aria-haspopup", "dialog");
        subtitles.element.setAttribute("aria-expanded", String(state.panel === "subtitles"));
        actions.push(subtitles);
    }
    if (actions.length === 0 && seasonItems.length === 0) {
        actions.push(actionButton("back", translate("common.back"), back));
    }
    const personal = state === undefined ? undefined : personalControls(state, true);
    if (state !== undefined) {
        // Watchlist shows while membership loads or fails; only a server or item that has no lists drops it.
        if (state.personalSupported !== false) actions.push(watchlistButton(state));
        const more = actionButton("more", translate("detail.more"), () => state.showPanel("more"));
        more.element.setAttribute("aria-haspopup", "dialog");
        actions.push(more);
    }
    const ordinal = audio.findIndex((_track, index) => selectedAudio === `file:${file?.fileId}:audio:${index}`);
    const resolvedAudio = audio[effectiveAudio] === undefined ? audio.length ? audioLabel(0) : translate("detail.unknown") : audioLabel(effectiveAudio);
    // Values stay empty until the focused episode's full versions arrive.
    const summary: PlaybackReadout | undefined = playbackChoices === undefined ? undefined : { version: versionValue, audio: ordinal === -1 ? translate("detail.autoValue", { value: resolvedAudio }) : resolvedAudio, subtitles: subtitleSummary };
    // TVSeriesDetailView shows the readout while episodes load or while it has a target episode. Tizen reads a target's
    // playback detail only for the next-up episode, so the readout also hides once nothing is loading and no values came.
    const showsSummary = (detail.type !== "series" && detail.type !== "season") || state?.series === undefined || state.series.loading || state.nextEpisodeLoading || summary !== undefined;
    const header = detailHeader(detail, context, actions.map(detailAction), state, summary, showsSummary, cache);
    const content = [...header.content, ...lines(notes), ...personal?.notes ?? []];
    const prepareSteps: (() => void)[] = [header.prepare];
    // A save in flight holds Play; a failed one leaves Play live so pressing it re-sends the save.
    for (const action of actions.filter(action => ["play", "resume", "next-episode", "start-over-episode"].includes(action.key))) {
        if (playbackChoices !== undefined) action.element.setAttribute("aria-disabled", String(savePending));
    }
    // Disabled controls stay in the row but take no focus (TVDisabledDetailActionsKey). One that disables under
    // focus keeps it until the viewer moves, so a repaint never moves focus by itself.
    const held = document.activeElement?.closest(".details-editorial .browse-actions") ? document.activeElement.getAttribute("data-focus") : null;
    const focusable = actions.filter(action => action.element.getAttribute("aria-disabled") !== "true" || action.key === held);
    for (const action of focusable) {
        if (action.element.getAttribute("aria-disabled") !== "true") continue;
        action.element.addEventListener("focusout", () => { const index = focusable.indexOf(action); if (index >= 0) focusable.splice(index, 1); }, { once: true });
    }
    if (state?.nextEpisodeFailed === true && !state.offline) content.push(...lines(["Could not load the next episode."], "error"));
    // TVSeriesDetailView.episodeExperience: the trailer pill is the episode block's last line, under the rail.
    const seriesStatus = detail.type === "series" ? trailerStatus(state) : undefined;
    if (series !== undefined) content.push(...series.content);
    else if (seasonItems.length > 0) {
        content.push(el("h2", "browse-section-title", "Seasons"), zoneNode("browse-row", seasonItems));
    }
    if (seriesStatus !== undefined) { seriesStatus.classList.add("details-trailer-status-series"); content.push(seriesStatus); }
    const zones: Zone[] = [
        { id: "actions", layout: "row", items: focusable, restoreEntry: focusable.find(action => ["resume", "play", "next-episode"].includes(action.key))?.key ?? "watchlist" },
        ...series?.zones ?? [{ id: "seasons", layout: "row" as const, items: seasonItems }],
    ];
    const language = shownLanguage();
    const catalogLanguage = textLanguage();
    const posterScale = context.posterScale?.() ?? 1;
    const spoilers = context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false };
    const credits = detail.extra?.cast ?? [];
    const castBlock = useRetained(cache, "cast", JSON.stringify([context.baseUrl, language, catalogLanguage]), [credits], () => {
        if (credits.length === 0) return { content: [], zones: [] };
        const occurrences = new Map<string, number>();
        const people = credits.slice(0, 24).map(credit => {
            const item = creditCard(credit, deferredContext);
            // Always key by identity/role/occurrence, including singleton credits.
            // A conditional key format used to rename a focused card when another
            // role for the same person appeared or disappeared, so FocusHost could
            // not restore it after trailer discovery refreshed the detail. Apple's
            // rail keys by index; Tizen keeps identity so a reorder of the same set
            // can still restore focus.
            const identity = `${credit.id ?? credit.name}\u001f${credit.role}`;
            const occurrence = occurrences.get(identity) ?? 0;
            occurrences.set(identity, occurrence + 1);
            // encodeURIComponent keeps the key CSS-selectable and free of JSON quotes.
            const key = `credit:${encodeURIComponent(credit.id ?? credit.name)}:${encodeURIComponent(credit.role)}:${occurrence}`;
            item.element.dataset.focus = key;
            return { ...item, key };
        });
        return {
            content: [el("h2", "browse-section-title", translate("detail.cast")), zoneNode("browse-row details-people", people)],
            // TVDetailCastRail.swift:37-38: tvDefaultFocus lands every entry on the first person.
            zones: [{ id: "people", layout: "row", items: people, entry: people[0]?.key }],
        };
    });
    content.push(...castBlock.content);
    zones.push(...castBlock.zones);
    if (castBlock.prepare !== undefined) prepareSteps.push(castBlock.prepare);
    if (state !== undefined && (detail.type === "movie" || detail.type === "series")) {
        const trailersBlock = useRetained(
            cache,
            "trailers",
            JSON.stringify([detail.type, state.extraPending ?? null, state.extraFailed ?? null, context.baseUrl, language, catalogLanguage]),
            [detail.extras, detail.videos],
            () => {
                // Hide unplayable remote YouTube cards until a Samsung YouTube handoff is proven (TVTrailersRail.swift:259-265).
                const extras = trailerCards(detail.extras, detail.videos, false).map(card => trailerCard(card, deferredContext, state, deferredPlay));
                if (extras.length === 0) return { content: [], zones: [] };
                const nodes = [
                    el("h2", "browse-section-title", translate("detail.trailers")),
                    zoneNode("browse-row details-extras", extras),
                    ...(state.extraPending !== undefined ? lines(["Loading extra…"]) : []),
                    ...(state.extraFailed !== undefined ? lines(["Could not load extra. Select its card to retry."], "error") : []),
                ];
                // TVTrailersRail is a focus section with user-initiated default focus
                // on the first card, so every entry lands there, as in Cast and Related.
                return { content: nodes, zones: [{ id: "extras", layout: "row", items: extras, entry: extras[0]?.key }] };
            },
        );
        content.push(...trailersBlock.content);
        zones.push(...trailersBlock.zones);
        if (trailersBlock.prepare !== undefined) prepareSteps.push(trailersBlock.prepare);
    } else if (cache !== undefined) cache.trailers = undefined;
    // TVMovieDetailView.swift:107-119: Cast, Trailers & More, then the box set.
    const overlaySnapshot = context.cardOverlays?.();
    const boxSetBlock = useRetained(
        cache,
        "boxSet",
        JSON.stringify([detail.id, context.baseUrl, posterScale, spoilers.hidesImages, spoilers.hidesOverviews, context.overlays ?? null, overlaySnapshot ?? null, context.seriesYears ?? null, context.continueWatching ?? null, language, catalogLanguage]),
        [boxSet, boxSet?.detail],
        () => {
            const movieRow = boxSet === undefined ? undefined : boxSetMovieRow(boxSet, detail.id, deferredContext);
            return movieRow === undefined ? { content: [], zones: [] } : { content: movieRow.content, zones: [movieRow.zone] };
        },
    );
    content.push(...boxSetBlock.content);
    zones.push(...boxSetBlock.zones);
    if (boxSetBlock.prepare !== undefined) prepareSteps.push(boxSetBlock.prepare);
    if (state !== undefined) {
        const relatedBlock = useRetained(
            cache,
            "related",
            JSON.stringify([detail.type, state.offline, state.relatedFailed, context.baseUrl, posterScale, spoilers.hidesImages, spoilers.hidesOverviews, context.seriesYears ?? null, language, catalogLanguage]),
            [state.related],
            () => {
                // TVSimilarRail passes neither overlayData nor userState to TVMediaCard.
                // AppRouter.openRelatedTitle: a related pick replaces a page that a related pick opened.
                const openRelated = (destination: Destination): void => (cache?.currentContext ?? context).open(destination.kind === "item" ? { ...destination, fromRelated: true } : destination);
                const related = titleCards((state.related ?? []).map(card => ({ ...card, played: undefined, episodesLeft: undefined })), { ...deferredContext, open: openRelated, overlays: undefined, cardOverlays: () => undefined });
                if ((state.offline && state.related === undefined) || state.relatedFailed || (state.related !== undefined && related.length === 0)) {
                    return { content: [], zones: [] };
                }
                const section = zoneNode("browse-row", related);
                section.setAttribute("data-detail-section", "related");
                // TVSimilarRail.swift:96-111: four untitled 220x330 cards while it loads; every entry lands on the first card.
                if (state.related === undefined) {
                    for (let index = 0; index < 4; index++) { const placeholder = el("div", "details-related-placeholder"); placeholder.setAttribute("aria-hidden", "true"); section.append(placeholder); }
                }
                return {
                    content: [el("h2", "browse-section-title", translate(detail.type === "movie" ? "detail.relatedMovies" : "detail.recommendedSeries")), section],
                    zones: state.related === undefined ? [] : [{ id: "related", layout: "row", items: related, entry: related[0]?.key }],
                };
            },
        );
        content.push(...relatedBlock.content);
        zones.push(...relatedBlock.zones);
        if (relatedBlock.prepare !== undefined) prepareSteps.push(relatedBlock.prepare);
    }
    const factsBlock = useRetained(cache, "facts", JSON.stringify([language, catalogLanguage]), [detail.extra?.crew, detail.extra?.facts], () => {
        const facts: { label: string; value: string }[] = [];
        const crew = detail.extra?.crew ?? [];
        const directors = creditLine(crew, ["director"]);
        if (directors !== undefined) facts.push({ label: translate("detail.director"), value: directors });
        const writers = creditLine(crew, ["writer", "screenplay", "story"]);
        if (writers !== undefined) facts.push({ label: writerFactLabel(crew), value: writers });
        facts.push(...(detail.extra?.facts ?? []).map(fact => ({ label: translate(fact.label), value: "date" in fact ? detailDate(fact.date) : fact.value })));
        // TVDetailFactsSection: the "Details" header always shows; only the facts grid hides when empty.
        const factsPanel = el("div", "details-facts");
        factsPanel.setAttribute("aria-label", translate("detail.details"));
        factsPanel.appendChild(el("h2", "browse-section-title", translate("detail.details")));
        const outZones: Zone[] = [];
        if (facts.length > 0) {
            const table = el("dl", "details-facts-table");
            for (const fact of facts) { const row = el("div", "details-fact-row"); row.append(el("dt", "", fact.label.toLocaleUpperCase(language)), el("dd", "", fact.value)); table.append(row); }
            table.tabIndex = -1; table.dataset.focus = "fact:0"; factsPanel.append(table);
            outZones.push({ id: "facts", layout: "column", items: [{ key: "fact:0", element: table }] });
        }
        return { content: [factsPanel], zones: outZones };
    });
    content.push(...factsBlock.content);
    zones.push(...factsBlock.zones);
    if (factsBlock.prepare !== undefined) prepareSteps.push(factsBlock.prepare);
    const first = focusable[0] ?? seasonItems[0];
    // TVDetailActions.entryAction (TVDetailActions.swift:720-727): Watchlist stands in while episodes load;
    // once Play gets a title, FocusHost.settlePrimaryFocus claims it once unless the viewer moved or selected.
    const waitingForEntryEpisode = detail.type === "series" && (
        state?.series?.loading === true && state.series.episodes === undefined
        || waitingForPlaybackTarget
    );
    const loadingWatchlist = waitingForEntryEpisode ? focusable.find(item => item.key === "watchlist") : undefined;
    const loading = waitingForEntryEpisode && loadingWatchlist === undefined
        ? content.find(node => node.classList.contains("details-hero"))
        : undefined;
    if (loading !== undefined) {
        prepareSteps.push(() => {
            loading.tabIndex = -1;
            loading.dataset.focus = "loading";
            loading.setAttribute("aria-busy", "true");
            loading.setAttribute("aria-label", translate("detail.episodes.loading"));
        });
        zones[0] = zones[0] === undefined ? { id: "actions", layout: "row", items: [{ key: "loading", element: loading }] } : { ...zones[0], items: [{ key: "loading", element: loading }, ...zones[0].items] };
    }
    const focus = loadingWatchlist !== undefined
        ? { zone: "actions", key: loadingWatchlist.key }
        : loading !== undefined ? { zone: "actions", key: "loading" }
        : first === undefined ? undefined : { zone: focusable[0] === undefined ? "seasons" : "actions", key: first.key };
    const view: View = { name: `item:${detail.id}`, content, zones, focus, back, prepare: () => { for (const step of prepareSteps) step(); } };
    if (state?.panel === "audio") {
        const options = [undefined, ...audio.map((_track, index) => index)].map(ordinal => {
            const item = actionButton(`audio:${ordinal ?? "auto"}`, ordinal === undefined ? autoLabel : audioRowTitle(ordinal), () => { if (tracks !== undefined) state.noteEpisodePreference(tracks.detail.id); tracks?.selectAudio(ordinal); if (tracks !== state) state.closePanel(); });
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(ordinal === undefined ? selectedAudio === undefined : ordinal === (effectiveAudio >= 0 ? effectiveAudio : 0)));
            if (ordinal !== undefined) {
                // DetailPlaybackFormatting.audioDetail: the track's own title leads unless it only repeats the name or layout.
                const qualifier = trackAudioTitle(audio[ordinal]?.title, audio[ordinal]?.language);
                const layout = audioDetails(ordinal).split(" · ").at(-1);
                const shownTitle = qualifier !== undefined && ![audioRowTitle(ordinal), layout].some(value => value?.toLowerCase() === qualifier.toLowerCase()) ? qualifier : undefined;
                const flags = [shownTitle, audioDetails(ordinal), audio[ordinal]?.isDefault ? translate("detail.trackDefault") : undefined, ordinal === file?.effectiveAudioTrackIndex ? translate("detail.trackPreferred") : undefined].filter(Boolean).join(" · ");
                if (flags) item.element.append(el("small", "details-option-subtext", flags));
            }
            return item;
        });
        return detailPanel(view, state, translate("detail.audio"), options);
    }
    if (state?.panel === "version") {
        const options = [undefined, ...playbackDetail.versions].map(version => {
            const item = actionButton(`version:${version?.fileId ?? "auto"}`, version?.label || autoLabel, () => { tracks?.select(version?.fileId); state.closePanel(); });
            if (version?.detailLabel) item.element.append(el("small", "details-option-subtext", version.detailLabel));
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(version?.fileId === tracks?.selectedFileId));
            return item;
        });
        return detailPanel(view, state, translate("detail.version"), options);
    }
    if (state?.panel === "subtitles") {
        // Rows keep their wire index; only the display position follows the player's shared order.
        const ordered = orderSubtitles((file?.subtitles ?? []).map((track, index) => ({ track, index })), file?.effectiveSubtitle?.language, ({ track }) => ({ language: track.language, codec: track.codec, forced: track.forced, hearingImpaired: track.hearingImpaired || titleIndicatesHearingImpaired(track.label), isDefault: track.isDefault === true }));
        const choices = [undefined, "off" as const, ...ordered.map(item => item.index)];
        const options = choices.map(choice => {
            const track = typeof choice === "number" ? file?.subtitles?.[choice] : undefined;
            // DetailPlaybackFormatting.subtitleOptions: an embedded track with no codec is a format the server cannot deliver,
            // and a sidecar with no stream index cannot be chosen here; both stay listed, dimmed and unfocusable.
            const unsupported = track !== undefined && track.source !== "external" && (track.codec?.trim() ?? "") === "";
            const selectable = track === undefined || track.selectionIndex !== undefined && !unsupported;
            const item = actionButton(`subtitle:${choice ?? "auto"}`, track === undefined ? choice === "off" ? translate("detail.off") : autoLabel : languageName(track.language) ?? track.label ?? translate("detail.track", { number: integerText(Number(choice) + 1) }), () => { if (!selectable) return; if (tracks !== undefined) state.noteEpisodePreference(tracks.detail.id); tracks?.selectSubtitle(choice); if (tracks !== state) state.closePanel(); });
            if (track !== undefined) {
                const codec = /subrip|srt/i.test(track.codec ?? '') ? 'SRT' : track.codec?.toUpperCase();
                const label = track.label && ![track.codec?.toUpperCase(), codec, languageName(track.language)?.toUpperCase(), 'SDH', 'CC'].includes(track.label.toUpperCase()) ? track.label : undefined;
                const hearingImpaired = track.hearingImpaired || /\b(SDH|CC)\b/i.test(track.label ?? '');
                const availability = unsupported ? translate("subtitle.trackUnsupportedFormat") : !selectable ? translate("detail.trackAvailableInPlayer") : undefined;
                item.element.append(el('small', 'details-option-subtext', [label, codec, track.forced ? translate("detail.trackForced") : undefined, hearingImpaired ? translate("detail.trackSdh") : undefined, track.isDefault ? translate("detail.trackDefault") : undefined, track.source === 'external' ? translate("detail.trackExternal") : undefined, availability].filter(Boolean).join(' · ')));
                if (!selectable) item.element.setAttribute('aria-disabled', 'true');
            }
            item.element.setAttribute("role", "radio");
            item.element.setAttribute("aria-checked", String(track === undefined ? subtitle?.kind === (choice === "off" ? "off" : "auto") : subtitle?.kind === "track" && matchesSubtitle(track, subtitle.signature)));
            if (choice === "off") item.element.append(el("small", "details-option-subtext", translate("detail.offDetail")));
            return item;
        });
        return detailPanel(view, state, translate("detail.subtitles"), options);
    }
    if (state?.panel === "more") {
        const menuNotes = [...personal?.notes ?? []];
        const items = personal?.items.filter(item => item.key !== "watchlist") ?? [];
        items.sort((a, b) => Number(b.key === "favorites") - Number(a.key === "favorites"));
        for (const item of items) {
            const value = state.values.get(item.key as "favorites" | "watched");
            const change = state.changes.get(item.key as "favorites" | "watched");
            if (value !== undefined && !change?.pending) {
                item.element.textContent = item.key === "favorites" ? value ? translate("detail.more.removeFavorite") : translate("detail.more.addFavorite")
                    : detail.type === "series" ? value ? translate("detail.more.markSeriesUnwatched") : translate("detail.more.markSeriesWatched")
                    : detail.type === "season" ? value ? translate("detail.more.markSeasonUnwatched") : translate("detail.more.markSeasonWatched")
                    : value ? translate("detail.more.markUnwatched") : translate("detail.more.markWatched");
            }
            item.element.addEventListener("click", () => { if (!state.busy && (item.key !== "favorites" || value !== undefined)) state.closePanel(); }, { capture: true });
        }
        const seasonState = state.series?.seasonNumber === undefined ? undefined : state.seasonStates.get(state.series.seasonNumber);
        if (seasonState !== undefined) {
            const value = seasonState.values.get("watched");
            const change = seasonState.changes.get("watched");
            if (value !== undefined) {
                const item = actionButton("season-watched", change?.pending ? "Updating season…" : value ? translate("detail.more.markSeasonUnwatched") : translate("detail.more.markSeasonWatched"), () => {
                    if (state.busy) return;
                    state.closePanel();
                    seasonState.change("watched", change?.failed ? change.target : !value, change?.failed);
                });
                item.element.setAttribute("aria-disabled", String(state.busy));
                items.push(item);
            }
        }
        if (detail.type === "series" && state.focusedEpisodeId !== undefined) items.unshift(actionButton("series-overview", translate("detail.more.showSeriesInfo"), () => state.showSeriesOverview()));
        // TVSeriesDetailView.moreMenu: shuffle leads, the season on screen before the series. Each keeps its label and is only
        // disabled while a shuffle starts.
        if (detail.type === "series" && state.shuffleSupported && seasons.reduce((count, season) => count + season.episodeCount, 0) >= 2) {
            const shuffle = actionButton("shuffle-series", translate("detail.more.shuffleSeries"), () => state.startShuffle(play));
            shuffle.element.setAttribute("aria-disabled", String(state.shuffleStarting));
            items.unshift(shuffle);
        }
        const shuffleSeason = detail.type === "series" ? seasonToShuffle(state) : undefined;
        if (shuffleSeason !== undefined) {
            const name = shuffleSeason.isSpecials === true || shuffleSeason.seasonNumber === 0 ? shuffleSeason.title || translate("detail.specials") : seasonName(shuffleSeason.seasonNumber);
            const shuffle = actionButton("shuffle-season", translate("detail.more.shuffleSeason", { season: name }), () => state.startShuffle(play, shuffleSeason));
            shuffle.element.setAttribute("aria-disabled", String(state.shuffleStarting));
            items.unshift(shuffle);
        }
        if (detail.type === "movie" || detail.type === "series") items.push(actionButton("find-trailers", translate("detail.more.findTrailers"), () => { state.trailers.start(state.detail); state.closePanel(); }));
        if (state.descriptions?.offers() === true) items.push(actionButton("translate-description", translate("detail.more.translate"), () => { state.descriptions?.translate(); state.closePanel(); }));
        // TVMovieDetailView / TVSeriesDetailView: after the translation row, before Watch Party.
        const notInterested = state.notInterested;
        if (notInterested !== undefined) {
            const item = actionButton("not-interested", translate(notInterested ? "cardMenu.showInRecommendations" : "cardMenu.notInterested"), () => { state.closePanel(); state.toggleNotInterested(); });
            item.element.setAttribute("aria-disabled", String(state.notInterestedPending));
            items.push(item);
        }
        // WatchPartyEntry.isAvailable: last, and only while the experimental switch is on and the server can host a party.
        // A series offers the episode its hero shows.
        const partyTitle = detail.type === "series" ? state.nextEpisode : detail.type === "movie" || detail.type === "episode" ? state.detail : undefined;
        if (context.watchParty?.offered() === true && partyTitle !== undefined) {
            items.push(actionButton("watch-party", context.watchParty.label(), () => { state.closePanel(); context.watchParty?.open(choiceFromDetail(partyTitle)); }));
        }
        return detailPanel(view, state, translate("detail.more"), items.length ? items : [actionButton("close-more", translate("rowPage.close"), () => state.closePanel())], menuNotes);
    }
    return view;
}

/** A failure Details shows as Apple's system alert: centred over the page, one OK, and Back dismisses it. */
export function withDetailsAlert(view: View, state: DetailsState | undefined): View {
    // Any season's owner can fail, including one the viewer moved away from while its write was in flight.
    const seasonOwner = state?.alert === undefined ? [...state?.seasonStates.values() ?? []].find(owner => owner.alert !== undefined) : undefined;
    const alert = state?.alert ?? seasonOwner?.alert;
    if (state === undefined || alert === undefined) return view;
    const dismiss = (): void => { seasonOwner?.dismissAlert(); state.dismissAlert(); };
    const ok = actionButton("alert-ok", translate("detail.watchedError.ok"), dismiss);
    // PersonalStateNoticeAlert: a held change adds the destructive Discard Held Change before OK.
    const discard = alert.held === undefined ? undefined : actionButton("alert-discard", "Discard Held Change", () => state.discardHeld());
    const buttons = discard === undefined ? [ok] : [discard, ok];
    // The page behind may hold cached nodes (the episode rail) that later renders reuse, so it is only made inert and
    // covered by a dim layer; centredDialog's own treatment strips focus keys and disables buttons for good.
    const prepare = (): void => {
        view.prepare?.();
        for (const node of view.content) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
    };
    const dialog = centredDialog({ style: "alert", id: alert.id, title: alert.title, message: alert.message, buttons: buttons.map(item => item.element), ...(discard === undefined ? {} : { destructive: discard.element }), behind: [] });
    return { name: `${view.name}:alert`, content: [...view.content, el("div", "details-alert-dim"), ...dialog], zones: [{ id: "alert", layout: buttons.length > 1 ? "column" : "row", items: buttons }], focus: { zone: "alert", key: ok.key }, back: dismiss, prepare };
}

/** TVSeriesDetailView.shuffleSeason: the season on screen, outside the series overview, once it has two episodes with files. */
function seasonToShuffle(state: DetailsState): Season | undefined {
    const series = state.series;
    if (!state.shuffleSeasonSupported || series === undefined || series.loading || series.seasonNumber === undefined) return undefined;
    if (state.focusedEpisodeId === undefined && !series.selectionOwnsHero) return undefined;
    const playable = (series.episodes ?? []).filter(episode => episode.seasonNumber === series.seasonNumber && (episode.files?.length ?? 0) > 0);
    return playable.length >= 2 ? series.seasons.find(season => season.seasonNumber === series.seasonNumber) : undefined;
}

function trailerCard(card: TrailerCard, context: ViewContext, state: DetailsState, play: (request: PlayRequest) => void): FocusItem {
    let title = card.title;
    let key = card.id;
    switch (card.role) {
        case "local":
            title = state.extraPending === card.extra.contentId ? "Loading extra…" : state.extraFailed === card.extra.contentId ? `${translate("common.retry")} ${card.title}` : card.title;
            key = `extra:${card.extra.contentId}`;
            break;
        case "remote":
            break;
        default: {
            const unexpected: never = card;
            return unexpected;
        }
    }
    const local = card.role === "local" ? card.extra : undefined;
    const element = el("button", "browse-card details-extra");
    element.type = "button";
    element.tabIndex = -1;
    element.dataset.focus = key;
    const still = artwork("browse-art browse-still", card.stillUrl, context.baseUrl, filmMark());
    still.append(playMark());
    element.append(still, el("span", "browse-card-title", title));
    const pending = card.role === "local" && (state.extraPending === card.extra.contentId || state.extraFailed === card.extra.contentId);
    if (card.caption !== undefined && !pending) element.append(el("span", "browse-card-subtitle", card.caption));
    if (local !== undefined) {
        element.setAttribute("aria-disabled", String(state.extraPending !== undefined));
        element.addEventListener("click", () => state.playExtra(local, play));
    }
    return { key, element };
}

/** Stand-in for SF Symbol film at 48pt, used when a local extra has no still. */
function filmMark(): SVGSVGElement {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 48 48");
    icon.setAttribute("width", "48");
    icon.setAttribute("height", "48");
    icon.setAttribute("aria-hidden", "true");
    const frame = document.createElementNS(icon.namespaceURI, "rect");
    frame.setAttribute("x", "6");
    frame.setAttribute("y", "10");
    frame.setAttribute("width", "36");
    frame.setAttribute("height", "28");
    frame.setAttribute("rx", "3");
    frame.setAttribute("fill", "none");
    frame.setAttribute("stroke", "currentColor");
    frame.setAttribute("stroke-width", "2");
    icon.append(frame);
    return icon;
}

/** The existing Play glyph, drawn at the trailer's 24pt play.fill size. */
function playMark(): HTMLElement {
    const badge = el("span", "details-extra-play");
    badge.setAttribute("aria-hidden", "true");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(icon.namespaceURI, "path");
    shape.setAttribute("d", "M8 4 21 12 8 20Z");
    shape.setAttribute("fill", "#fff");
    icon.appendChild(shape);
    badge.appendChild(icon);
    return badge;
}

/** TVCircleActionButton for Watchlist: always "Watchlist"; the icon fill and spoken label carry the state. */
function watchlistButton(state: DetailsState): FocusItem {
    const value = state.values.get("watchlist");
    const change = state.changes.get("watchlist");
    const item = actionButton("watchlist", value ? translate("detail.watchlistRemove") : translate("detail.watchlistAdd"), () => {
        if (value === undefined) { if (state.personalFailed && !state.busy) state.loadPersonal(); return; }
        state.change("watchlist", change?.failed ? change.target : !value, change?.failed);
    });
    // aria-pressed stays off until membership is known.
    const pressed = change?.pending ? change.target : value;
    if (pressed !== undefined) item.element.setAttribute("aria-pressed", String(pressed));
    return item;
}

/** `alerts`: Details presents a failed change as Apple's alert, so the control keeps its label and adds no note. */
export function personalControls(state: DetailsState, alerts = false): { items: FocusItem[]; notes: HTMLElement[] } {
    const items: FocusItem[] = [];
    const notes: HTMLElement[] = [];
    for (const kind of ["watched", "favorites", "watchlist"] as const) {
        if (kind !== "watched" && state.personalSupported === false) continue;
        const value = state.values.get(kind);
        if (value === undefined) {
            // TVMovieDetailView.swift:213-236: Apple's More lists Favorite before membership loads. Like Watchlist, the press waits for it.
            if (kind === "favorites" && state.personalSupported === undefined && !state.personalFailed) items.push(actionButton(kind, translate("detail.more.addFavorite"), () => undefined));
            continue;
        }
        const change = state.changes.get(kind);
        const label = kind === "watched" ? `${state.detail.type === "series" || state.detail.type === "season" ? "Mark all" : "Mark"} ${value ? "unwatched" : "watched"}` : kind === "watchlist" ? value ? translate("detail.watchlistRemove") : translate("detail.watchlistAdd") : value ? "Remove favorite" : "Add favorite";
        const item = actionButton(kind, change?.pending ? `Updating ${kind}…` : change?.failed && !alerts ? `Retry ${kind}` : label, () => state.change(kind, change?.failed ? change.target : !value, change?.failed));
        item.element.setAttribute("aria-pressed", String(value));
        item.element.setAttribute("aria-disabled", String(state.busy));
        items.push(item);
        if (change?.failed && !alerts) notes.push(...lines([`Could not update ${kind}.`], "error"));
    }
    if (state.personalFailed) items.push(actionButton("retry-personal", "Retry personal actions", () => { if (!state.busy) state.loadPersonal(); }));
    // Apple shows no loading text in the action row or More (TVDetailActions.swift:485-545, TVMovieDetailView.swift:213-236).
    if (state.personalFailed && state.personalSupported === undefined && !state.offline) notes.push(...lines(["Could not load personal actions."], "error"));
    return { items, notes };
}

function creditCard(credit: Credit, context: ViewContext): FocusItem {
    const key = credit.id ? `person:${credit.id}` : `credit:${credit.name}:${credit.role}`;
    // A credit without a server person_id has facts, but no invented person route.
    const element = el(credit.id ? "button" : "div", "browse-card details-person");
    element.setAttribute("data-focus", key);
    element.tabIndex = -1;
    const id = credit.id;
    if (id) element.addEventListener("click", () => context.open({ kind: "person", id, title: credit.name }));
    element.appendChild(artwork("browse-art details-photo", credit.photoUrl, context.baseUrl, credit.name));
    element.appendChild(el("span", "browse-card-title", credit.name));
    // TVDetailCastRail.swift:96: no character, no role line.
    if (credit.role.trim() !== "") element.appendChild(el("span", "browse-card-subtitle", credit.role));
    return { key, element };
}

function titleCards(cards: readonly Card[], context: ViewContext): FocusItem[] {
    const items: FocusItem[] = [];
    for (const card of cards) {
        const { preview: _preview, ...titlesContext } = context;
        const item = cardItem(card, titlesContext);
        if (item !== undefined) items.push(item);
    }
    return items;
}

/**
 * `DetailFacts.creditNames` at silo-apple `2ef3a171`: unique names in Unicode
 * order, three of them, then an ellipsis when more remain.
 */
export function creditLine(crew: readonly Credit[], jobs: readonly string[]): string | undefined {
    const wanted = new Set(jobs);
    const names = [...new Set(crew.filter(credit => wanted.has(credit.role.toLowerCase())).map(credit => credit.name))];
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (names.length === 0) return undefined;
    const shown = names.slice(0, 3).join(", ");
    return names.length > 3 ? `${shown}, …` : shown;
}

/** A screenplay credit uses "Writer". Every other writing credit uses "Written by". */
export function writerFactLabel(crew: readonly Credit[]): string {
    return translate(crew.some(credit => credit.role.toLowerCase() === "screenplay") ? "detail.writer" : "detail.writtenBy");
}

export function personHero(person: Person, baseUrl: string, metadataLoading = false): HTMLElement {
    const hero = el("div", "browse-detail details-person-hero");
    hero.appendChild(personPortrait(person, baseUrl));
    const info = el("div", "browse-detail-info");
    info.appendChild(heading(person.name));
    const facts = personMetadataBadges(person, new Date());
    if (facts.length > 0 || metadataLoading) {
        const row = el("div", "person-facts");
        for (const fact of facts) row.appendChild(el("span", "person-fact", fact));
        if (metadataLoading) {
            const loading = el("span", "person-fact person-metadata-loading");
            loading.setAttribute("role", "status");
            loading.append(spinner(), el("span", "person-metadata-loading-text", translate("person.loadingMetadata")));
            row.appendChild(loading);
        }
        info.appendChild(row);
    }
    const bio = person.bio?.trim();
    if (bio) info.appendChild(el("p", "browse-text browse-overview", bio));
    hero.appendChild(info);
    return hero;
}

function seasonItem(seriesId: string, seriesTitle: string, season: Season, context: ViewContext): FocusItem {
    const key = `season:${season.seasonNumber}`;
    const element = el("button", "browse-card");
    element.type = "button";
    element.setAttribute("data-focus", key);
    element.appendChild(artwork("browse-art", season.posterUrl, context.baseUrl, season.title));
    element.appendChild(el("span", "browse-card-title", season.title));
    element.appendChild(el("span", "browse-card-subtitle", translate("detail.episodeCount", { count: season.episodeCount, count_text: integerText(season.episodeCount) })));
    element.addEventListener("click", () => context.open({ kind: "season", id: season.id, seriesId, seasonNumber: season.seasonNumber, title: `${seriesTitle} · ${season.title}` }));
    return mediaItem({ key, element }, { id: season.id, title: season.title, type: "season" }, context);
}

export function seasonView(name: string, title: string, episodes: readonly Episode[], context: ViewContext, back: () => void, play: (request: PlayRequest) => void, detail?: ItemDetail, state?: DetailsState): View {
    const items = episodes.map((episode): FocusItem => {
        const element = el("button", "browse-episode");
        element.type = "button";
        element.setAttribute("data-focus", episode.id);
        const art = artwork("browse-art browse-still", episode.stillUrl, context.baseUrl, defaultArtwork("tv"));
        if (hidesEpisodeListStill(episode, context.spoilers?.() ?? { hidesImages: false, hidesOverviews: false })) blurEpisodeStill(art);
        element.appendChild(art);
        const info = el("span", "browse-episode-info");
        info.appendChild(el("span", "browse-card-title", `${episode.episodeNumber}. ${episode.title}`));
        const runtime = episode.runtimeMinutes > 0 ? `${episode.runtimeMinutes} min` : "";
        info.appendChild(el("span", "browse-card-subtitle", runtime));
        if (episode.played) {
            const badge = el("span", "browse-watched");
            badge.appendChild(el("span", "silo-sr-only", translate("detail.watched")));
            element.firstElementChild?.appendChild(badge);
        }
        element.appendChild(info);
        element.addEventListener("click", () => context.playEpisode === undefined ? context.open({ kind: "item", id: episode.id, title: episode.title }) : context.playEpisode(episode.id, episode.title));
        return mediaItem({ key: episode.id, element }, { id: episode.id, title: episode.title, type: "episode", played: episode.played }, context);
    });
    const header = detail === undefined ? undefined : itemView(detail, [], context, play, back, state);
    const heroEnd = (header?.content.findIndex(node => node.classList.contains("details-hero")) ?? -1) + 1;
    const content = [...(header?.content.slice(0, heroEnd) ?? [heading(title)]), ...(items.length === 0 ? lines(["This season has no episodes yet."]) : []), zoneNode("browse-episodes", items), ...header?.content.slice(heroEnd) ?? []];
    const fallback = items.length === 0 ? [actionButton("back", translate("common.back"), back)] : [];
    if (fallback.length > 0) {
        content.push(zoneNode("browse-actions", fallback));
    }
    if (header !== undefined && state?.panel !== undefined) {
        return {
            ...header,
            content,
            prepare: () => {
                header.prepare?.();
                for (const node of content) if (!node.matches(".skyline-selector, .skyline-dropdown-scrim")) { node.inert = true; node.setAttribute("aria-hidden", "true"); }
            },
        };
    }
    const zones: Zone[] = [
        { id: "episodes", layout: "column", items },
        { id: "status", layout: "row", items: fallback },
    ];
    const first = items[0] ?? fallback[0];
    return { name, content, zones: [...header?.zones.filter((zone) => zone.id === "actions") ?? [], ...zones, ...header?.zones.filter((zone) => zone.id !== "actions") ?? []], focus: first === undefined ? undefined : { zone: items[0] === undefined ? "status" : "episodes", key: first.key }, back, ...(header?.prepare === undefined ? {} : { prepare: header.prepare }) };
}
