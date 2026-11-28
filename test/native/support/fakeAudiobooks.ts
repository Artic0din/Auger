import { FakeDetails } from "./fakeDetails.ts";
import type { FakePlayback } from "./fakePlayback.ts";
import { problem, type Reply } from "./fakeSilo.ts";

export interface RecordedSyncProgressWrite {
    readonly profileId: string | undefined;
    readonly mediaItemId: string;
    readonly positionMs: number;
    readonly durationMs: number;
    readonly forceOverwrite: boolean;
}

const LIBRARY = "14";
/** Taller than the 1080 px viewport at the About size, so the description overlay scrolls across passages and paragraphs. */
export const OVERSIZED_OVERVIEW = Array.from({ length: 12 }, (_, index) =>
    `Paragraph ${index + 1}: the house is a maze of halls and statues, and the tides climb its lower floors with steady patience.`.repeat(4),
).join("\n\n");

/** An owner household with an audiobook library: square covers on Home, a library and a detail page per book. */
export class FakeAudiobooks extends FakeDetails {
    readonly progressWrites: RecordedSyncProgressWrite[] = [];
    syncProgressReply: Reply | ((writes: readonly RecordedSyncProgressWrite[]) => Reply) | undefined;
    private readonly profileProgress = new Map<string, number>();

    constructor() {
        super(12);
        const books = [
            { id: "audiobook:tide", title: "Stormlight Archive 5 - The Tide Owes (5 of 5)", year: 2024 },
            { id: "audiobook:dune", title: "Dune", year: 1965 },
            { id: "audiobook:hail", title: "Project Hail Mary", year: 2021 },
            { id: "audiobook:fresh", title: "Piranesi", year: 2020 },
        ] as const;
        for (const book of books) this.add({ ...book, type: "audiobook", libraryId: LIBRARY });
        this.progress.set("audiobook:tide", 4112);
        this.progress.set("audiobook:dune", 40);
        const home = this.households.get("p-owner");
        if (home === undefined) throw new Error("Missing synthetic household");
        home.sections = [
            { id: "listen", sectionType: "continue_watching", title: "Continue Listening", items: ["audiobook:tide"] },
            { id: "shelf", sectionType: "recently_added", title: "Recently Added Audiobooks", items: books.map(book => book.id) },
            ...home.sections.filter(row => row.id === "recently_added"),
        ];
        home.librarySections = [{ id: "library-picks", sectionType: "recently_added", title: "Audiobook Picks", items: books.map(book => book.id) }];
    }

    registerAudiobookMediaFiles(playback: FakePlayback): void {
        const audio = (codec: string) => [{ default: true, language: "en", codec, channels: 2, layout: "stereo" }];
        playback.files.set("af-1", { id: "af-1", audio: audio("aac"), inventory: [] });
        playback.files.set("af-m1", { id: "af-m1", audio: audio("aac"), inventory: [] });
        playback.files.set("af-m2", { id: "af-m2", audio: audio("aac"), inventory: [] });
        playback.files.set("af-p1", { id: "af-p1", audio: audio("mp3"), inventory: [] });
    }

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://fake.invalid");
        if (method === "POST" && url.pathname === "/sync/progress") {
            const rawItems = Array.isArray(body?.items) ? body.items : undefined;
            if (rawItems === undefined) return problem(422, "validation_failed", "items array is required");
            const batch: RecordedSyncProgressWrite[] = [];
            for (const entry of rawItems) {
                if (typeof entry !== "object" || entry === null) return problem(422, "validation_failed", "invalid item");
                const item = entry as Record<string, unknown>;
                const mediaItemId = typeof item.media_item_id === "string" ? item.media_item_id : "";
                const positionMs = typeof item.position_ms === "number" ? item.position_ms : -1;
                const durationMs = typeof item.duration_ms === "number" ? item.duration_ms : -1;
                const forceOverwrite = item.force_overwrite === true;
                if (mediaItemId.trim() === "" || positionMs < 0 || durationMs < 0) return problem(422, "validation_failed", "invalid sync item");
                const write: RecordedSyncProgressWrite = { profileId, mediaItemId, positionMs, durationMs, forceOverwrite };
                batch.push(write);
                this.progressWrites.push(write);
            }
            if (this.syncProgressReply !== undefined) {
                return typeof this.syncProgressReply === "function" ? this.syncProgressReply(batch) : this.syncProgressReply;
            }
            for (const write of batch) {
                this.profileProgress.set(`${profileId ?? "p-owner"}:${write.mediaItemId}`, write.positionMs / 1000);
                if (profileId === "p-owner" || profileId === undefined) this.progress.set(write.mediaItemId, write.positionMs / 1000);
                if (write.durationMs > 0 && write.positionMs > 0 && write.positionMs >= write.durationMs - 5000) {
                    this.personalMembers(profileId, "watched").add(write.mediaItemId);
                } else if (write.forceOverwrite) {
                    this.personalMembers(profileId, "watched").delete(write.mediaItemId);
                }
            }
            return {
                status: 200,
                body: {
                    items: batch.map((write, index) => ({ index, media_item_id: write.mediaItemId, status: "success" })),
                    summary: { total: batch.length, succeeded: batch.length, failed: 0 },
                },
            };
        }
        const watchedMatch = /^\/watched\/([^/]+)$/.exec(url.pathname);
        if (watchedMatch?.[1] !== undefined && (method === "POST" || method === "DELETE")) {
            this.profileProgress.delete(`${profileId ?? "p-owner"}:${decodeURIComponent(watchedMatch[1])}`);
        }
        const id = /^\/catalog\/items\/(audiobook[^/]*)$/.exec(url.pathname)?.[1];
        const decodedId = id === undefined ? undefined : decodeURIComponent(id);
        let reply = super.route(method, path, profileId, body);
        if (reply?.status === 404 && method === "GET" && (decodedId === "audiobook:multipart" || decodedId === "audiobook:plain")) {
            reply = {
                status: 200,
                body: {
                    content_id: decodedId,
                    type: "audiobook",
                    title: decodedId === "audiobook:multipart" ? "Way of Kings" : "Short Story",
                    year: 2023,
                    genres: ["Fantasy"],
                    poster_url: `/art/${encodeURIComponent(decodedId)}.svg`,
                    cast: [],
                    crew: [],
                    ratings: [],
                    subtitles: [],
                    keywords: [],
                    status: "matched",
                    user_data: { played: this.personalMembers(profileId, "watched").has(decodedId) },
                },
            };
        }
        if (reply?.status !== 200 || method === "DELETE") return reply;
        const found = decodedId !== undefined && method === "GET" ? this.book(decodedId, reply.body as Record<string, unknown>, profileId) : reply.body;
        return { status: 200, body: plain(found) };
    }

    private book(id: string, base: Record<string, unknown>, profileId: string | undefined): Record<string, unknown> {
        const key = `${profileId ?? "p-owner"}:${id}`;
        const position = this.profileProgress.has(key)
            ? this.profileProgress.get(key) ?? 0
            : (profileId === undefined || profileId === "p-owner" ? this.progress.get(id) ?? 0 : 0);
        const played = Boolean((base.user_data as { played?: boolean } | undefined)?.played) || this.personalMembers(profileId, "watched").has(id);
        const chapters = (titles: readonly string[], step = 3600): Record<string, unknown>[] => titles.map((title, index) => ({
            index, title, start_seconds: index * step, end_seconds: (index + 1) * step, source: "embedded",
        }));
        const versions = id === "audiobook:multipart"
            ? [
                { file_id: "af-m2", presentation_kind: "audiobook_part", presentation_part_index: 2, duration: 1800, codec_audio: "aac", container: "m4b", chapters: chapters(["Part 2 Arrival", ""], 900) },
                { file_id: "af-m1", presentation_kind: "audiobook_part", presentation_part_index: 1, duration: 1200, codec_audio: "aac", container: "m4b", chapters: chapters(["Part 1 Opening", "Into the Storm"], 600) },
            ]
            : id === "audiobook:plain"
                ? [{ file_id: "af-p1", presentation_kind: "audiobook_part", presentation_part_index: 1, duration: 600, codec_audio: "mp3", container: "mp3", file_name: "Plain Book.mp3", chapters: [] }]
                : [{ file_id: "af-1", presentation_kind: "audiobook_part", presentation_part_index: 1, duration: 10800, codec_audio: "aac", container: "m4b", chapters: chapters(["Opening", "What the Tide Owes", ""]) }];
        const totalDurationSeconds = id === "audiobook:multipart" ? 3000 : id === "audiobook:plain" ? 600 : 10800;
        return {
            ...base,
            content_id: id, type: "audiobook", genres: ["Fantasy", "Epic"],
            ...(id === "audiobook:tide" ? { release_date: "2024-12-06" } : {}),
            overview: id === "audiobook:fresh" ? OVERSIZED_OVERVIEW : "The war for Roshar reaches its last turn, and the oaths that bound the Radiants are tested one more time.",
            user_data: { played, position_seconds: position },
            versions,
            audiobook: {
                authors: [{ name: "Brandon Sanderson" }],
                narrators: [{ name: "Michael Kramer" }, { name: "Kate Reading" }],
                publisher: "Tor Books",
                total_duration_seconds: totalDurationSeconds,
                series: { name: "The Stormlight Archive", entries: [
                    { content_id: "audiobook:dune", title: "The Stormlight Archive 1 - The Way of Kings", year: 2010, series_index: 1, poster_url: "/art/audiobook%3Adune.svg" },
                    { content_id: "audiobook:hail", title: "Words of Radiance", year: 2014, series_index: 2, poster_url: "/art/audiobook%3Ahail.svg" },
                    { content_id: id, title: "The Tide Owes", year: 2024, series_index: 5, poster_url: `/art/${encodeURIComponent(id)}.svg` },
                ] },
                other_narrations: [{ content_id: "audiobook:fresh", title: "The Tide Owes", year: 2025, narrators: ["Steven Pacey"] }],
                related: { also_by_author: [{ content_id: "audiobook:hail", title: "Mistborn", year: 2006, poster_url: "/art/audiobook%3Ahail.svg" }], similar: Array.from({ length: 12 }, (_, index) => ({ content_id: `audiobook:similar${index}`, title: `Similar ${index}`, year: 2000 + index, poster_url: `/art/audiobook%3Asimilar${index}.svg` })) },
            },
        };
    }
}

/** The vendored movie fixtures carry a genre, runtime and cast; a book has none of them on a card. */
function plain(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    const mapped = Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, plain(entry)]));
    if (record.type !== "audiobook" || typeof record.content_id !== "string") return mapped;
    const { runtime, rating_imdb, rating_tmdb, cast, crew, ...rest } = mapped;
    void runtime; void rating_imdb; void rating_tmdb;
    return { ...rest, genres: ["Fantasy"], ...(Array.isArray(cast) ? { cast: [] } : {}), ...(Array.isArray(crew) ? { crew: [] } : {}) };
}
