// The audiobook detail's decisions, after silo-apple TVAudiobookViewModel, TVAudiobookDetailSections,
// TVAudiobookChaptersView, TVAudiobookDescriptionView and AudiobookDetailFormatting, kept free of the DOM so Node can test them.

import { currentChapterIndex, isFinished, resumePosition, type Audiobook, type AudiobookChapter, type AudiobookRelatedItem } from "../contracts/v2/audiobooks.ts";
import { detailDate } from "./episodeCaption.ts";
import { isolated } from "../i18n/direction.ts";
import { durationText } from "../i18n/duration.ts";
import { localizeNumerals, percentText } from "../i18n/format.ts";
import { integerText } from "../i18n/numbers.ts";
import { textLanguage, translate } from "../i18n/translate.ts";

// --- AudiobookDetailFormatting ---

const TRIM_EDGES = /^[\s\-–—:·,]+|[\s\-–—:·,]+$/g;
const TRAILING_VOLUME = [/\s*\(\s*\d+\s+of\s+\d+\s*\)$/i, /\s*\(\s*book\s+\d+\s*\)$/i, /\s*\(\s*vol(?:ume)?\.?\s*\d+\s*\)$/i];

function withoutArticle(text: string): string {
    const lower = text.toLowerCase();
    for (const article of ["the ", "a ", "an "]) if (lower.startsWith(article)) return text.slice(article.length);
    return text;
}

/** Drops a leading "<Series>[ N][ -:–] " prefix when the title opens with the series name, at a word boundary. */
function withoutSeriesPrefix(title: string, seriesName: string): string {
    const core = withoutArticle(seriesName).trim();
    if (core === "") return title;
    const haystack = withoutArticle(title);
    if (!haystack.toLowerCase().startsWith(core.toLowerCase())) return title;
    const rest = Array.from(haystack.slice(core.length));
    if (rest[0] !== undefined && /\p{L}/u.test(rest[0])) return title;
    let skip = 0;
    while (skip < rest.length && /[\s\d\-–—:#]/.test(rest[skip] ?? "")) skip++;
    const candidate = rest.slice(skip).join("").trim();
    // Consuming the whole title means the prefix was the title.
    return candidate === "" ? title : candidate;
}

/** Lifts a series name and trailing volume locator out of a raw title. */
export function cleanTitle(rawTitle: string, seriesName: string | undefined): string {
    const original = rawTitle.trim();
    let title = original;
    if (seriesName !== undefined && seriesName !== "") title = withoutSeriesPrefix(title, seriesName);
    for (const pattern of TRAILING_VOLUME) title = title.replace(pattern, "");
    title = title.replace(TRIM_EDGES, "");
    return title === "" ? original : title;
}

/** The trailing "(N of M)" locator, the most reliable source of a series total. */
export function volumeIn(rawTitle: string): { index: number | undefined; total: number | undefined } {
    const match = /\(\s*(\d+)\s+of\s+(\d+)\s*\)\s*$/i.exec(rawTitle);
    return match === null ? { index: undefined, total: undefined } : { index: Number(match[1]), total: Number(match[2]) };
}

/** "The Stormlight Archive · Book 5 of 5" / "… · Book 5" / "…". */
export function seriesLine(name: string | undefined, index: number | undefined, total: number | undefined): string | undefined {
    const trimmed = name?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    if (index === undefined || index <= 0) return isolated(trimmed);
    const series = isolated(trimmed);
    if (total !== undefined && total >= index && total > 1) return translate("detail.audiobook.seriesLineOf", { series, number: integerText(index), total: integerText(total) });
    return translate("detail.audiobook.seriesLine", { series, number: integerText(index) });
}

function naturalJoin(names: readonly string[]): string {
    if (names.length <= 2) return names.join(" & ");
    return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** Keeps the first `visible` names and rolls the rest into "& N more"; a server may send a cast as one comma-joined string. */
export function peopleSummary(names: readonly string[], visible = 2): string | undefined {
    const cleaned = names.flatMap(name => name.split(",")).map(name => name.trim()).filter(name => name !== "");
    if (cleaned.length === 0) return undefined;
    if (cleaned.length <= visible + 1) return naturalJoin(cleaned);
    return translate("detail.audiobook.peopleMore", { count: cleaned.length - visible, names: isolated(cleaned.slice(0, visible).join(", ")) });
}

// --- PlayerTimeFormatter ---

/** "1h 42m" / "42m" / "" for an unknown length, in the shown language's units and digits (Apple's `LocaleFormat.duration`). */
export function formatRuntime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    return durationText(Math.floor(Math.floor(seconds) / 60), false);
}

/** "m:ss" or "h:mm:ss". */
export function formatHMS(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
    const pad = (value: number): string => String(value).padStart(2, "0");
    return localizeNumerals(hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`);
}

// --- AudiobookProgress ---

function chapterDuration(chapters: readonly AudiobookChapter[], index: number, total: number): number {
    const chapter = chapters[index];
    if (chapter === undefined) return 0;
    const end = chapters[index + 1]?.start ?? total;
    return Math.max(0, end - chapter.start);
}

// --- The page ---

export type AudiobookState =
    | { readonly kind: "inProgress"; readonly fraction: number; readonly percent: number; readonly line1: string; readonly line2: string | undefined }
    | { readonly kind: "notStarted"; readonly line1: string; readonly line2: string | undefined }
    | { readonly kind: "finished"; readonly line1: string; readonly line2: string | undefined };

export interface PickerRow {
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly duration: number;
    /** Whole-book seconds. */
    readonly startSeconds: number;
    readonly isCurrent: boolean;
    readonly isDone: boolean;
    /** Fraction listened within the current chapter. */
    readonly progress: number | undefined;
}

export interface RailItem { readonly id: string; readonly title: string; readonly year: number | undefined; readonly posterUrl: string | undefined; readonly caption: string | undefined }

export interface AudiobookFact { readonly label: string; readonly value: string }

export interface AudiobookPage {
    readonly title: string;
    readonly eyebrow: string;
    readonly seriesLine: string | undefined;
    readonly credits: { readonly author: string | undefined; readonly narrator: string | undefined } | undefined;
    readonly state: AudiobookState;
    readonly primary: { readonly label: string; readonly icon: "play" | "restart" };
    /** Whole-book seconds Resume starts at. */
    readonly resumeSeconds: number | undefined;
    readonly showsChapters: boolean;
    readonly picker: { readonly rows: readonly PickerRow[]; readonly defaultRowId: string | undefined; readonly subline: string };
    readonly sections: {
        readonly hasContent: boolean;
        readonly about: string | undefined;
        readonly facts: readonly AudiobookFact[];
        readonly narrations: readonly { readonly id: string; readonly label: string; readonly year: number | undefined }[];
        readonly rails: readonly { readonly title: string; readonly items: readonly RailItem[] }[];
    };
}

function railItem(item: AudiobookRelatedItem, seriesName?: string): RailItem {
    return {
        id: item.id,
        title: seriesName !== undefined && seriesName !== "" ? cleanTitle(item.title, seriesName) : item.title,
        year: item.year,
        posterUrl: item.posterUrl,
        caption: item.seriesIndex === undefined ? undefined : translate("detail.audiobook.bookNumber", { number: integerText(item.seriesIndex) }),
    };
}

function personCount(names: readonly string[]): number {
    return names.flatMap(name => name.split(",")).filter(name => name.trim() !== "").length;
}

/** DetailFacts.audiobookFacts (PhoneDetailFactsSection.swift:147-202). */
function audiobookFacts(book: Audiobook): AudiobookFact[] {
    const facts: AudiobookFact[] = [];
    const authors = book.detail.authors.map(person => person.name);
    const authorNames = peopleSummary(authors, 3);
    if (authorNames !== undefined) facts.push({ label: translate("detail.facts.author", { count: personCount(authors) }), value: authorNames });
    const narrators = book.detail.narrators.map(person => person.name);
    const narratorNames = peopleSummary(narrators, 3);
    if (narratorNames !== undefined) facts.push({ label: translate("detail.facts.narrator", { count: personCount(narrators) }), value: narratorNames });
    const publisher = book.detail.publisher?.trim();
    if (publisher !== undefined && publisher !== "") facts.push({ label: translate("detail.facts.publisher"), value: publisher });
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(book.releaseDate?.trim() ?? "");
    if (dateMatch !== null) facts.push({ label: translate("detail.released"), value: detailDate(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`) });
    else if (book.year !== undefined && book.year > 0) facts.push({ label: translate("detail.released"), value: integerText(book.year) });
    const length = formatRuntime(book.duration);
    if (length !== "") facts.push({ label: translate("detail.facts.length"), value: length });
    if (book.parts.length > 0) {
        const format = [
            book.audioFormat?.codec?.trim().toUpperCase(),
            book.audioFormat?.container?.trim().toUpperCase(),
            book.parts.length > 1 ? translate("detail.audiobook.partCount", { count: book.parts.length, count_text: integerText(book.parts.length) }) : undefined,
        ].filter((token): token is string => token !== undefined && token !== "");
        if (format.length > 0) facts.push({ label: translate("detail.facts.format"), value: format.join(" · ") });
    }
    return facts;
}

// --- TVAudiobookDescriptionView.DescriptionPassage ---

export const DESCRIPTION_PASSAGE_TARGET = 420;

export interface DescriptionPassage {
    readonly id: number;
    readonly text: string;
    readonly startsParagraph: boolean;
}

function wordRuns(sentence: string): string[] {
    const pieces: string[] = [];
    for (const raw of sentence.split(" ")) {
        const word = `${raw} `;
        const chars = Array.from(word);
        if (chars.length <= DESCRIPTION_PASSAGE_TARGET) {
            pieces.push(word);
        } else {
            for (let start = 0; start < chars.length; start += DESCRIPTION_PASSAGE_TARGET) {
                pieces.push(chars.slice(start, start + DESCRIPTION_PASSAGE_TARGET).join(""));
            }
        }
    }
    return pieces;
}

function passageChunks(paragraph: string): string[] {
    if (paragraph.length <= DESCRIPTION_PASSAGE_TARGET) return [paragraph];
    let sentences: string[];
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
        const segmenter = new Intl.Segmenter(textLanguage(), { granularity: "sentence" });
        sentences = Array.from(segmenter.segment(paragraph), entry => entry.segment);
    } else {
        sentences = paragraph.match(/[^.!?]+(?:[.!?]+|\s|$)/g) ?? [paragraph];
    }
    if (sentences.length === 0) sentences = [paragraph];
    const pieces = sentences.flatMap(sentence => sentence.length > DESCRIPTION_PASSAGE_TARGET ? wordRuns(sentence) : [sentence]);
    const chunks: string[] = [];
    let current = "";
    for (const piece of pieces) {
        if (current !== "" && current.length + piece.length > DESCRIPTION_PASSAGE_TARGET) {
            chunks.push(current.trim());
            current = "";
        }
        current += piece;
    }
    if (current.trim() !== "") chunks.push(current.trim());
    return chunks;
}

/** Splits a full description into paragraphs and <= 420-character passages for focusable scrolling. */
export function descriptionPassages(text: string): DescriptionPassage[] {
    const passages: DescriptionPassage[] = [];
    const paragraphs = text.split(/\r?\n/).map(line => line.trim()).filter(line => line !== "");
    for (const paragraph of paragraphs) {
        passageChunks(paragraph).forEach((chunk, index) => {
            passages.push({ id: passages.length, text: chunk, startsParagraph: index === 0 });
        });
    }
    return passages;
}

export function audiobookPage(book: Audiobook): AudiobookPage {
    const detail = book.detail;
    const total = book.duration;
    const position = Math.max(0, book.position);
    const resume = resumePosition(position, total);
    const finished = isFinished(book.played, position, total);
    const chapters = book.chapters;
    const current = currentChapterIndex(chapters, position);
    const fraction = total > 0 ? Math.min(1, Math.max(0, position / total)) : 0;
    const percent = Math.floor(fraction * 100 + 0.5);
    const runtime = formatRuntime(total);
    const chapterTitle = (index: number): string => chapters[index]?.title || translate("detail.audiobook.chapter", { number: integerText(index + 1) });

    const genre = book.genres[0];
    const volume = volumeIn(book.title);
    const index = detail.series?.entries.find(entry => entry.id === book.id)?.seriesIndex ?? volume.index;
    const author = peopleSummary(detail.authors.map(person => person.name), 2);
    const narrator = peopleSummary(detail.narrators.map(person => person.name), 2);

    let state: AudiobookState;
    if (resume !== undefined) {
        const line1 = current !== undefined && chapters[current] !== undefined
            ? translate("detail.audiobook.currentChapter", { number: integerText(current + 1), title: isolated(chapterTitle(current)) })
            : formatRuntime(position) === "" ? translate("detail.audiobook.inProgress") : translate("detail.audiobook.listened", { time: formatRuntime(position) });
        const pieces: string[] = [];
        if (current !== undefined && chapters[current] !== undefined) pieces.push(translate("detail.audiobook.intoChapter", { time: formatHMS(Math.max(0, position - (chapters[current]?.start ?? 0))) }));
        const left = formatRuntime(Math.max(0, total - position));
        if (left !== "") pieces.push(translate("detail.audiobook.leftInBook", { time: left }));
        state = { kind: "inProgress", fraction, percent, line1, line2: pieces.length === 0 ? undefined : pieces.join(" · ") };
    } else if (finished) {
        state = { kind: "finished", line1: translate("detail.audiobook.finished"), line2: runtime === "" ? undefined : runtime };
    } else {
        const pieces: string[] = [];
        if (runtime !== "") pieces.push(runtime);
        if (chapters.length > 0) pieces.push(translate("detail.audiobook.chapterCount", { count: chapters.length, count_text: integerText(chapters.length) }));
        state = { kind: "notStarted", line1: translate("detail.audiobook.notStarted"), line2: pieces.length === 0 ? undefined : pieces.join(" · ") };
    }

    const rows: PickerRow[] = chapters.length === 0
        ? book.parts.map((part, partIndex) => ({ id: `part-${partIndex}`, number: partIndex + 1, title: part.fileName !== undefined && part.fileName !== "" ? part.fileName : translate("detail.audiobook.part", { number: integerText(partIndex + 1) }), duration: part.duration, startSeconds: part.offset, isCurrent: false, isDone: false, progress: undefined }))
        : chapters.map((chapter, chapterIndex) => {
            const duration = chapterDuration(chapters, chapterIndex, total);
            const isCurrent = current === chapterIndex;
            return {
                id: `chapter-${chapterIndex}`, number: chapterIndex + 1, title: chapterTitle(chapterIndex), duration, startSeconds: chapter.start, isCurrent,
                isDone: finished || chapter.start + duration <= position,
                progress: isCurrent && duration > 0 ? Math.min(1, Math.max(0, position - chapter.start) / duration) : undefined,
            };
        });
    const subline: string[] = [];
    if (resume !== undefined) {
        subline.push(percentText(percent));
        if (current !== undefined && chapters.length > 0) subline.push(translate("detail.audiobook.chapterOf", { number: integerText(current + 1), total: integerText(chapters.length) }));
        const left = formatRuntime(Math.max(0, total - position));
        if (left !== "") subline.push(translate("detail.audiobook.timeLeft", { time: left }));
    } else {
        if (chapters.length > 0) subline.push(translate("detail.audiobook.chapterCount", { count: chapters.length, count_text: integerText(chapters.length) }));
        else if (book.parts.length > 1) subline.push(translate("detail.audiobook.partCount", { count: book.parts.length, count_text: integerText(book.parts.length) }));
        if (runtime !== "") subline.push(runtime);
    }

    const trimmedOverview = book.overview?.trim();
    const about = trimmedOverview === undefined || trimmedOverview === "" ? undefined : trimmedOverview;
    const facts = audiobookFacts(book);
    const rails: { title: string; items: RailItem[] }[] = [];
    if (detail.series !== undefined && detail.series.entries.length > 0) {
        rails.push({ title: detail.series.name ?? translate("detail.audiobook.series"), items: detail.series.entries.map(entry => railItem(entry, detail.series?.name)) });
    }
    if (detail.alsoByAuthor.length > 0) rails.push({ title: translate("detail.audiobook.moreByAuthor"), items: detail.alsoByAuthor.map(entry => railItem(entry)) });
    if (detail.similar.length > 0) rails.push({ title: translate("detail.audiobook.related"), items: detail.similar.map(entry => railItem(entry)) });
    const narrations = detail.otherNarrations.map(narration => ({ id: narration.id, label: narration.narrators.length === 0 ? narration.title : narration.narrators.join(", "), year: narration.year }));

    return {
        title: cleanTitle(book.title, detail.series?.name),
        eyebrow: genre === undefined || genre === "" ? translate("detail.audiobook.label") : translate("detail.audiobook.labelWithGenre", { genre: genre.toUpperCase() }),
        seriesLine: seriesLine(detail.series?.name, index, volume.total),
        credits: author === undefined && narrator === undefined ? undefined : { author, narrator },
        state,
        primary: resume !== undefined ? { label: translate("detail.resume"), icon: "play" } : finished ? { label: translate("detail.playAgain"), icon: "restart" } : { label: translate("common.play"), icon: "play" },
        resumeSeconds: resume,
        showsChapters: chapters.length > 0 || book.parts.length > 1,
        picker: { rows, defaultRowId: rows.find(row => row.isCurrent)?.id ?? rows[0]?.id, subline: subline.join(" · ") },
        sections: {
            hasContent: about !== undefined || facts.length > 0 || narrations.length > 0 || rails.length > 0,
            about,
            facts,
            narrations, rails,
        },
    };
}
