// Text the Skyline marquee and Home cards show for a catalog card, from the card's own fields only.
// Ported (AGPL-3.0-or-later) from silo-apple 1a7cceeaf3b2bfc4f889c00487d19b2c6f843940:
// iosApp/iosApp/Components/MediaTextFormatting.swift, Components/EpisodeCardCaption.swift and
// tvOS/Components/TVFocusMarquee.swift (TVMarqueeContent) and Components/Ratings/DisplayRating.swift.

import type { Card, CardOverlay } from "../contracts/v2/catalog.ts";
import { durationText, localizeNumerals } from "../i18n/format.ts";
import { translate } from "../i18n/translate.ts";

/** "45m", "1h 0m" or "2h 15m" ("2h 15min" in German); nothing for a missing or non-positive runtime. */
export function runtimeText(minutes: number | undefined): string | undefined {
    return durationText(minutes);
}

/** The metadata runtime, else the file duration the card carries. */
function lengthText(card: Card): string | undefined {
    const runtime = runtimeText(card.runtimeMinutes);
    if (runtime !== undefined || card.durationSeconds === undefined || card.durationSeconds <= 0) return runtime;
    return runtimeText(Math.round(card.durationSeconds / 60));
}

/** "23m left" for a genuinely started item that is not nearly finished. */
function timeLeftText(position: number | undefined, duration: number | undefined): string | undefined {
    if (position === undefined || duration === undefined || duration <= 0 || position <= 0 || position >= duration || position / duration >= 0.95) return undefined;
    const left = runtimeText(Math.max(Math.ceil((duration - position) / 60), 1));
    return left === undefined ? undefined : translate("home.timeLeft", { time: left });
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function resolutionLabel(value: string | undefined): string | undefined {
    const raw = nonEmpty(value);
    if (raw === undefined) return undefined;
    const lowered = raw.toLowerCase();
    if (["2160p", "4k", "uhd"].includes(lowered)) return "4K";
    if (["4320p", "8k"].includes(lowered)) return "8K";
    return /^[0-9]+p$/.test(lowered) ? lowered : raw.toUpperCase();
}

/** Resolution, dynamic range and audio chips (`4K · DOLBY VISION · ATMOS`). */
export function marqueeBadges(overlay: CardOverlay | undefined): string[] {
    if (overlay === undefined) return [];
    const badges: string[] = [];
    const resolution = resolutionLabel(overlay.resolution);
    if (resolution !== undefined) badges.push(resolution);
    const hdr = nonEmpty(overlay.hdr);
    if (hdr !== undefined) badges.push(/dv|dolby/i.test(hdr) ? "DOLBY VISION" : hdr.toUpperCase());
    const audio = nonEmpty(overlay.audio);
    if (audio !== undefined) badges.push(/atmos/i.test(audio) ? "ATMOS" : audio.toUpperCase());
    return badges;
}

/** TVFocusMarquee.episodeToken: a code's numbers are ASCII, a lone number takes the language's digits. */
function episodeToken(season: number | undefined, episode: number | undefined): string | undefined {
    if (season !== undefined && episode !== undefined) return translate("home.seasonEpisode", { season: String(season), episode: String(episode) });
    if (season !== undefined) return translate("home.seasonOnly", { season: localizeNumerals(String(season)) });
    return episode === undefined ? undefined : translate("home.episodeOnly", { episode: localizeNumerals(String(episode)) });
}

/** Episodes headline with their series; the episode moves to the meta line. */
export function marqueeTitle(card: Card): string {
    return card.type === "episode" ? card.seriesTitle ?? card.title : card.title;
}

/** `year · genre · runtime` or `S2 E7 · episode title · 45m`; Continue Watching trails `23m left` after the rating. */
export function marqueeMeta(card: Card, continuing: boolean): { lead: string[]; trailing: string[] } {
    const lead: string[] = [];
    if (card.type === "episode") {
        const token = episodeToken(card.seasonNumber, card.episodeNumber);
        if (token !== undefined) lead.push(token);
        lead.push(card.title);
    } else {
        if (card.year !== undefined && card.year > 0) lead.push(String(card.year));
        const genre = card.genres?.find(value => value !== "");
        if (genre !== undefined) lead.push(genre);
    }
    const length = lengthText(card);
    if (length !== undefined) lead.push(length);
    const left = continuing ? timeLeftText(card.positionSeconds, card.durationSeconds) : undefined;
    return { lead, trailing: left === undefined ? [] : [left] };
}

/** The card's one external rating (IMDb, else TMDB, each out of 10); never for episodes (DisplayRating.primaryCard). */
export function marqueeRating(card: Card): { name: string; display: string } | undefined {
    if (card.type === "episode") return undefined;
    const usable = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0 && value <= 10;
    const [name, value] = usable(card.ratingImdb) ? ["IMDb", card.ratingImdb] : usable(card.ratingTmdb) ? ["TMDB", card.ratingTmdb] : [undefined, undefined];
    return name === undefined || value === undefined ? undefined : { name, display: (Math.round(value * 10) / 10).toFixed(1) };
}

/** The episode's own title, unless it is empty or merely repeats the series name. */
function episodeTitle(card: Card): string | undefined {
    const title = nonEmpty(card.title);
    if (card.type !== "episode" || title === undefined) return undefined;
    const series = nonEmpty(card.seriesTitle);
    return series !== undefined && series.toLowerCase() === title.toLowerCase() ? undefined : title;
}

/** EpisodeCardCaption.line: "S01E02 · Pilot", or whichever part exists; nothing for non-episodes. */
function episodeLine(card: Card): string | undefined {
    const pad = (value: number): string => String(value).padStart(2, "0");
    const code = card.type === "episode" && card.seasonNumber !== undefined && card.episodeNumber !== undefined
        ? translate("catalog.episodeTag", { season: pad(card.seasonNumber), episode: pad(card.episodeNumber) })
        : undefined;
    const title = episodeTitle(card);
    return code !== undefined && title !== undefined ? translate("detail.episodeCard.title", { code, title }) : code ?? title;
}

/**
 * Home card caption: episodes are captioned with their series and an `S01E02 · Pilot` line.
 * Every thumbnail row titles a card `seriesTitle ?? title`, its second line the item title when a series title
 * exists (EpisodeThumbCard.swift:269-285 at silo-apple 85679e7).
 */
/**
 * Apple CardYears.caption (Components/CardYears.swift:19-35): a series shows the years it ran, "2019 – 2023" once it
 * has ended and "2021 – Present" while it is returning; everything else, or a series that doesn't say, shows its year.
 */
export function cardYears(card: Card): string | undefined {
    if (card.year === undefined) return undefined;
    const first = String(card.year);
    if (card.type !== "series") return first;
    if (card.showStatus === "returning") return `${first} – Present`;
    if (card.showStatus !== "ended" && card.showStatus !== "cancelled") return first;
    const last = Number.parseInt(card.lastAirDate?.slice(0, 4) ?? "", 10);
    return Number.isInteger(last) && last > card.year ? `${first} – ${last}` : first;
}

/** `years` uses the series range (CardYears) instead of the bare year, as Apple's catalog grids do. */
export function homeCaption(card: Card, thumbnail: boolean, years = false): { title: string; line: string | undefined } {
    const series = nonEmpty(card.seriesTitle);
    const title = card.type === "episode" && series !== undefined ? series : thumbnail ? card.seriesTitle ?? card.title : card.title;
    const year = years ? cardYears(card) : card.year === undefined ? undefined : String(card.year);
    const line = episodeLine(card) ?? (thumbnail && card.seriesTitle !== undefined ? card.title : year);
    return { title, line };
}
