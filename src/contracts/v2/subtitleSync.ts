import { boolean, integer, nonEmptyString, object, optionalString, string, WireError } from "./wire.ts";

// Subtitle sync (getSubtitleSyncStatus, listSubtitleSync, getSubtitleSync, startSubtitleSync, setSubtitleTiming): the server aligns a
// subtitle to its file's audio and stores a timing correction; it never changes the subtitle's bytes. A subtitle is named by an
// opaque sync key, `stored-{id}` or `external-{hash}`, which the playback plan's inventory publishes as `sync_key`.

/** Original time `t` plays at `t * scale + offsetMs`. */
export interface SubtitleTiming { readonly offsetMs: number; readonly scale: number }

export const IDENTITY_TIMING: SubtitleTiming = { offsetMs: 0, scale: 1 };

export function isIdentityTiming(timing: SubtitleTiming): boolean {
    return timing.offsetMs === 0 && timing.scale === 1;
}

/** `status` stays the wire string: one added later reads as "not in progress" instead of failing the whole listing. */
export interface SubtitleSyncJob {
    readonly id: string;
    readonly status: string;
    readonly trigger: string;
    readonly phase: string | undefined;
    /** While active: 0...1. */
    readonly progress: number | undefined;
    readonly failure: string | undefined;
    readonly result: SubtitleTiming | undefined;
}

export function jobInProgress(job: SubtitleSyncJob | undefined): boolean {
    return job?.status === "pending" || job?.status === "running";
}

export interface SubtitleSyncState {
    readonly key: string;
    readonly mediaFileId: string;
    readonly external: boolean;
    readonly timing: SubtitleTiming;
    readonly job: SubtitleSyncJob | undefined;
}

/** Usable only when the viewer is allowed and the state is available; `external` says whether sidecar files can be synced too. */
export interface SubtitleSyncStatus { readonly available: boolean; readonly external: boolean }

export function decodeSyncStatus(value: unknown): SubtitleSyncStatus {
    const row = object(value, "subtitle_sync_status");
    if (string(row, "revision", "subtitle_sync_status") === "") throw new WireError("subtitle_sync_status.revision", "a revision");
    const available = boolean(row, "allowed", "subtitle_sync_status") && string(row, "state", "subtitle_sync_status") === "available";
    return { available, external: available && boolean(row, "external", "subtitle_sync_status") };
}

function decodeTiming(value: unknown, path: string): SubtitleTiming {
    const row = object(value, path);
    const scale = row.scale;
    if (typeof scale !== "number" || !Number.isFinite(scale)) throw new WireError(`${path}.scale`, "a number");
    return { offsetMs: integer(row, "offset_ms", path), scale };
}

function decodeJob(value: unknown, path: string): SubtitleSyncJob {
    const row = object(value, path);
    const progress = row.progress;
    if (progress !== undefined && (typeof progress !== "number" || !Number.isFinite(progress))) throw new WireError(`${path}.progress`, "a number");
    return {
        id: nonEmptyString(row, "id", path),
        status: string(row, "status", path),
        trigger: string(row, "trigger", path),
        phase: optionalString(row, "phase", path),
        progress,
        failure: optionalString(row, "failure", path),
        result: row.result === undefined || row.result === null ? undefined : decodeTiming(row.result, `${path}.result`),
    };
}

export function decodeSyncState(value: unknown): SubtitleSyncState {
    const row = object(value, "subtitle_sync");
    return {
        key: nonEmptyString(row, "key", "subtitle_sync"),
        mediaFileId: nonEmptyString(row, "media_file_id", "subtitle_sync"),
        external: string(row, "source", "subtitle_sync") === "external",
        timing: decodeTiming(row.timing, "subtitle_sync.timing"),
        job: row.sync === undefined || row.sync === null ? undefined : decodeJob(row.sync, "subtitle_sync.sync"),
    };
}

export function decodeSyncList(value: unknown): readonly SubtitleSyncState[] {
    const subtitles = object(value, "subtitle_sync_list").subtitles;
    if (!Array.isArray(subtitles)) throw new WireError("subtitle_sync_list.subtitles", "an array");
    return subtitles.map((row: unknown) => decodeSyncState(row));
}

/** The `{subtitle}` body of getSubtitleSync, startSubtitleSync and setSubtitleTiming. */
export function decodeSyncEnvelope(value: unknown): SubtitleSyncState {
    return decodeSyncState(object(value, "subtitle_sync_envelope").subtitle);
}
