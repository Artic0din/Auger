// A shuffle's next pick after its current item finishes (silo-apple 1a7ccee: SiloAPI.advanceShuffle, then
// the player opens the new current item). The server advances only while the finished item is still
// current, so a retried advance after a lost answer changes nothing.
import { operations } from "../api/operations.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { startVersion } from "../contracts/v2/versions.ts";
import type { PlayRequest } from "./controller.ts";
import type { Shuffle } from "../contracts/v2/shuffle.ts";

type Read = <T>(spec: RequestSpec<T>) => Promise<T>;

export type AdvanceShuffleResult =
    | { readonly kind: "ok"; readonly next: PlayRequest | undefined }
    | { readonly kind: "lookup_failed"; readonly shuffle: Shuffle; readonly cause: unknown };

/** Undefined when the shuffle has nothing else to play (its scope holds one playable item). */
export async function nextShuffle(read: Read, shuffleId: string, finishedContentId: string, quality?: string): Promise<PlayRequest | undefined> {
    const shuffle = await read(operations.advanceShuffle(shuffleId, finishedContentId));
    if (shuffle.id !== shuffleId) throw new ApiError({ kind: "invalid_response", path: "shuffle.id" });
    if (shuffle.current.id === finishedContentId) return undefined;
    return shufflePick(read, shuffle, quality);
}

/** Advances the shuffle and distinguishes a failed /advance from a failed /watch/{current} lookup after /advance succeeded. */
export async function advanceShufflePick(read: Read, shuffleId: string, finishedContentId: string, quality?: string): Promise<AdvanceShuffleResult> {
    const shuffle = await read(operations.advanceShuffle(shuffleId, finishedContentId));
    if (shuffle.id !== shuffleId) throw new ApiError({ kind: "invalid_response", path: "shuffle.id" });
    if (shuffle.current.id === finishedContentId) return { kind: "ok", next: undefined };
    try {
        return { kind: "ok", next: await shufflePick(read, shuffle, quality) };
    } catch (cause) {
        return { kind: "lookup_failed", shuffle, cause };
    }
}

/** Re-checks a shuffle via GET /shuffles/{id} and resolves its announced `next` pick (Apple refreshShufflePick). */
export async function refreshShuffle(read: Read, shuffleId: string, quality?: string): Promise<{ readonly next: PlayRequest | undefined; readonly scopeLabel?: string | undefined }> {
    const shuffle = await read(operations.getShuffle(shuffleId));
    if (shuffle.id !== shuffleId) throw new ApiError({ kind: "invalid_response", path: "shuffle.id" });
    if (shuffle.next.id === shuffle.current.id) return { next: undefined, ...(shuffle.scopeLabel === undefined ? {} : { scopeLabel: shuffle.scopeLabel }) };
    const next = await shufflePickItem(read, shuffle, shuffle.next.id, quality);
    return { next, ...(shuffle.scopeLabel === undefined ? {} : { scopeLabel: shuffle.scopeLabel }) };
}

export type SkipShuffleResult =
    | { readonly kind: "ok"; readonly next: PlayRequest | undefined; readonly scopeLabel?: string | undefined }
    | { readonly kind: "lookup_failed"; readonly scopeLabel?: string | undefined; readonly cause: unknown };

/** Pick Another: replaces `nextContentId` via POST /shuffles/{id}/skip and resolves the replacement `next` pick. */
export async function skipShuffle(read: Read, shuffleId: string, nextContentId: string, quality?: string): Promise<SkipShuffleResult> {
    const shuffle = await read(operations.skipShuffleItem(shuffleId, nextContentId));
    if (shuffle.id !== shuffleId) throw new ApiError({ kind: "invalid_response", path: "shuffle.id" });
    const scope = shuffle.scopeLabel === undefined ? {} : { scopeLabel: shuffle.scopeLabel };
    if (shuffle.next.id === shuffle.current.id) return { kind: "ok", next: undefined, ...scope };
    try {
        const next = await shufflePickItem(read, shuffle, shuffle.next.id, quality);
        return { kind: "ok", next, ...scope };
    } catch (cause) {
        return { kind: "lookup_failed", ...scope, cause };
    }
}

// Apple starts every pick from its beginning, not from saved progress (silo-apple 27cf4a2 PlayerViewModel.loadShufflePick).
export async function shufflePick(read: Read, shuffle: Shuffle, quality?: string): Promise<PlayRequest | undefined> {
    return shufflePickItem(read, shuffle, shuffle.current.id, quality);
}

async function shufflePickItem(read: Read, shuffle: Shuffle, contentId: string, quality?: string): Promise<PlayRequest | undefined> {
    const detail = await read(operations.watchDetail(contentId));
    if (detail.id !== contentId || (detail.type !== "movie" && detail.type !== "episode")) throw new ApiError({ kind: "invalid_response", path: "shuffle.current" });
    const preferred = startVersion(detail.versions, detail.watch?.lastFileId, quality);
    const version = firstPart(preferred, detail.versions) ?? preferred;
    if (version === undefined) return undefined;
    return {
        contentId: detail.id,
        fileId: version.fileId,
        title: detail.title,
        startSeconds: 0,
        shuffleId: shuffle.id,
        ...(shuffle.scopeLabel === undefined ? {} : { shuffleScopeLabel: shuffle.scopeLabel }),
        ...(detail.type === "episode" ? { episode: true as const, seasonNumber: detail.seasonNumber, episodeNumber: detail.episodeNumber } : {}),
    };
}

/** The part after the playing file in its group, played before the shuffle advances (Apple nextShufflePart + playShufflePart). */
export async function nextShufflePart(read: Read, request: PlayRequest, playingFileId: string): Promise<PlayRequest | undefined> {
    const detail = await read(operations.watchDetail(request.contentId));
    if (detail.id !== request.contentId) throw new ApiError({ kind: "invalid_response", path: "shuffle.part" });
    const playing = detail.versions.find(version => version.fileId === playingFileId);
    const next = playing === undefined ? undefined : partAfter(playing, detail.versions);
    if (next === undefined) return undefined;
    // Apple loads the part fresh: no carried-over audio, subtitle or saved position.
    const { audioTrackId: _audio, subtitle: _subtitle, subtitleTracks: _tracks, subtitlePreferences: _preferences, watch: _watch, ...kept } = request;
    return { ...kept, fileId: next.fileId, startSeconds: 0 };
}

interface Part {
    readonly resolution?: string;
    readonly presentationGroupKey: string | undefined;
    readonly presentationPartIndex: number | undefined;
}

// Apple PlayerMultipartPolicy: a part of an empty or absent group key is no part; the same resolution wins, else the first candidate.
function part<T extends Part>(index: number, like: T, versions: readonly T[]): T | undefined {
    const group = like.presentationGroupKey;
    if (group === undefined || group === "") return undefined;
    const candidates = versions.filter(candidate => candidate.presentationGroupKey === group && candidate.presentationPartIndex === index);
    return candidates.find(candidate => candidate.resolution === like.resolution) ?? candidates[0];
}

function firstPart<T extends Part>(selected: T | undefined, versions: readonly T[]): T | undefined {
    const index = selected?.presentationPartIndex;
    return selected === undefined || index === undefined || index <= 1 ? undefined : part(1, selected, versions);
}

function partAfter<T extends Part>(current: T, versions: readonly T[]): T | undefined {
    const index = current.presentationPartIndex;
    return index === undefined ? undefined : part(index + 1, current, versions);
}
