// What the Watch Party lobby and picker show of a title: Apple's WatchPartyMediaChoice and
// WatchPartySelectedItem. An episode never shows its own still or description, so the lobby and
// picker cannot spoil it; Apple blurs them by the viewer's spoiler setting, which this client lacks.
// A title is kept for as long as a room page shows it, and a language file can land meanwhile, so every
// label that comes from the catalog (episode codes, the fallback episode title, runtimes, years) is a
// function read when the page draws, never text built when the title was chosen.

import type { Card, Episode, ItemDetail } from "../contracts/v2/catalog.ts";
import { runtimeText } from "./cardPresentation.ts";
import { isolated } from "../i18n/direction.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";

/** The title as the lobby hero draws it. */
export interface LobbyItem {
    readonly contentId: string;
    readonly title: () => string;
    readonly subtitle: () => string | undefined;
    readonly posterUrl: string | undefined;
    readonly backdropUrl: string | undefined;
    readonly overview: string | undefined;
    /** "2024 · 2h 46m". */
    readonly facts: () => readonly string[];
    /** Outlined quality chips: "4K", "HDR". */
    readonly chips: readonly string[];
}

/** A title the host can choose, as the picker's confirmation page shows it. */
export interface MediaChoice {
    readonly contentId: string;
    readonly type: string;
    readonly title: string;
    readonly subtitle: () => string | undefined;
    readonly posterUrl: string | undefined;
    readonly backdropUrl: string | undefined;
    readonly overview: string | undefined;
    readonly facts: () => readonly string[];
    readonly lobby: LobbyItem;
    /** Series to open when the viewer chooses "See all episodes" from an episode or next-up choice. */
    readonly seriesLink?: Card;
    readonly seasonNumber?: number;
}

/** `LocaleFormat.codeNumber`: a season or episode number in a code is ASCII digits in every language. */
const codeArgs = (season: number, episode: number): { season: string; episode: string } => ({ season: String(season), episode: String(episode) });

/** "S1 · E2" (Apple's watchParty.episodes.line) and "S1:E2" (watchParty.facts.episodeCode), in the shown language. */
const episodeLine = (season: number | undefined, episode: number | undefined): string | undefined =>
    season === undefined || episode === undefined ? undefined : translate("watchParty.episodes.line", codeArgs(season, episode));
const episodeCode = (season: number | undefined, episode: number | undefined): string | undefined =>
    season === undefined || episode === undefined ? undefined : translate("watchParty.facts.episodeCode", codeArgs(season, episode));
const episodeFallback = (episode: number): string => translate("detail.episode", { number: integerText(episode) });

const joined = (parts: readonly (string | undefined)[]): string | undefined => parts.filter(part => part !== undefined).join(" · ") || undefined;

function yearAndRuntime(year: number | undefined, minutes: number | undefined): string[] {
    return [year !== undefined && year > 0 ? integerText(year) : undefined, runtimeText(minutes)].filter((fact): fact is string => fact !== undefined);
}

/** Apple's WatchPartyMediaChoice(item:), or an episode card as a resume row gives it. */
export function choiceFromCard(card: Card): MediaChoice {
    const episode = card.type === "episode";
    // An episode's card carries its still as the backdrop; the series art is the safe one.
    const backdropUrl = episode ? card.seriesBackdropUrl : card.backdropUrl;
    return {
        contentId: card.id,
        type: card.type,
        title: episode ? card.seriesTitle ?? card.title : card.title,
        subtitle: () => episode ? joined([episodeLine(card.seasonNumber, card.episodeNumber), card.seriesTitle === undefined ? undefined : isolated(card.title)]) : undefined,
        posterUrl: card.posterUrl,
        backdropUrl,
        overview: episode ? undefined : card.overview,
        facts: () => [...yearAndRuntime(card.year, card.runtimeMinutes), card.contentRating, card.genres?.[0]].filter((fact): fact is string => fact !== undefined && fact !== ""),
        lobby: {
            contentId: card.id,
            title: () => card.title,
            subtitle: () => episode ? joined([card.seriesTitle === undefined ? undefined : isolated(card.seriesTitle), episodeCode(card.seasonNumber, card.episodeNumber)]) : undefined,
            posterUrl: card.posterUrl,
            backdropUrl,
            overview: episode ? undefined : card.overview,
            facts: () => yearAndRuntime(card.year, card.runtimeMinutes),
            chips: [],
        },
    };
}

/** Apple's WatchPartyMediaChoice(series:episode:): the series poster and art, with the episode's own title. */
export function choiceFromEpisode(series: Card, episode: Episode): MediaChoice {
    const title = (): string => episode.title === "" ? episodeFallback(episode.episodeNumber) : episode.title;
    const facts = (): readonly string[] => { const runtime = runtimeText(episode.runtimeMinutes); return runtime === undefined ? [] : [runtime]; };
    return {
        contentId: episode.id,
        type: "episode",
        title: series.title,
        subtitle: () => `${episodeLine(episode.seasonNumber, episode.episodeNumber)} · ${isolated(title())}`,
        posterUrl: series.posterUrl,
        backdropUrl: series.backdropUrl,
        overview: undefined,
        facts,
        seriesLink: series,
        seasonNumber: episode.seasonNumber,
        lobby: {
            contentId: episode.id,
            title,
            subtitle: () => `${isolated(series.title)} · ${episodeCode(episode.seasonNumber, episode.episodeNumber)}`,
            posterUrl: series.posterUrl,
            backdropUrl: series.backdropUrl,
            overview: undefined,
            facts,
            chips: [],
        },
    };
}

/** Apple's WatchPartyMediaChoice(series:nextUp:), for a series the group is part-way through. */
export function choiceFromNextUp(series: Card, nextUp: { readonly contentId: string; readonly seasonNumber: number; readonly episodeNumber: number; readonly title: string | undefined }): MediaChoice {
    return {
        contentId: nextUp.contentId,
        type: "episode",
        title: series.title,
        subtitle: () => `${episodeLine(nextUp.seasonNumber, nextUp.episodeNumber)}${nextUp.title === undefined ? "" : ` · ${isolated(nextUp.title)}`}`,
        posterUrl: series.posterUrl,
        backdropUrl: series.backdropUrl,
        overview: undefined,
        facts: () => [],
        seriesLink: series,
        seasonNumber: nextUp.seasonNumber,
        lobby: {
            contentId: nextUp.contentId,
            title: () => nextUp.title ?? episodeFallback(nextUp.episodeNumber),
            subtitle: () => `${isolated(series.title)} · ${episodeCode(nextUp.seasonNumber, nextUp.episodeNumber)}`,
            posterUrl: series.posterUrl, backdropUrl: series.backdropUrl, overview: undefined, facts: () => [], chips: [],
        },
    };
}

/** The room's selected title from the catalog read (Apple's WatchPartySelectedItem(detail)). */
export function lobbyItemFromDetail(detail: ItemDetail): LobbyItem {
    const episode = detail.type === "episode";
    const file = detail.versions[0];
    const resolution = file?.resolution?.toLowerCase() ?? "";
    const chips = [resolution.includes("2160") || resolution.includes("4k") ? "4K" : resolution.includes("1080") ? "1080p" : resolution.includes("720") ? "720p" : undefined, /hdr/i.test(file?.compactLabel ?? "") ? "HDR" : undefined]
        .filter((chip): chip is string => chip !== undefined);
    return {
        contentId: detail.id,
        title: () => detail.title,
        subtitle: () => episode ? joined([detail.seriesTitle === undefined ? undefined : isolated(detail.seriesTitle), episodeCode(detail.seasonNumber, detail.episodeNumber)]) : detail.seriesTitle,
        posterUrl: detail.posterUrl,
        // A backdrop that is an episode still is left out, as the lobby cannot know the viewer's spoiler setting.
        backdropUrl: episode && detail.backdropIsEpisodeStill !== false ? undefined : detail.backdropUrl,
        overview: episode ? undefined : detail.overview,
        facts: () => yearAndRuntime(detail.year, detail.runtimeMinutes),
        chips,
    };
}

/** A title chosen from its own Details page (Apple's WatchPartySelectedItem(previewing:)). */
export function choiceFromDetail(detail: ItemDetail): MediaChoice {
    const lobby = lobbyItemFromDetail(detail);
    return { contentId: detail.id, type: detail.type, title: detail.title, subtitle: lobby.subtitle, posterUrl: lobby.posterUrl, backdropUrl: lobby.backdropUrl, overview: lobby.overview, facts: lobby.facts, lobby };
}
