import type { RequestSpec } from "./http.ts";
import { decodeAppearance, type SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import { decodeSubtitlePreferences, type SubtitlePreferences } from "../contracts/v2/preplaySubtitles.ts";
import { decodeSyncEnvelope, decodeSyncList, decodeSyncStatus, IDENTITY_TIMING, type SubtitleSyncState, type SubtitleSyncStatus } from "../contracts/v2/subtitleSync.ts";

const syncPath = (fileId: string, key: string): string => `/subtitles/${encodeURIComponent(fileId)}/sync/${encodeURIComponent(key)}`;

export const subtitleOperations = {
    preplaySubtitlePreferences: (contentId: string, fileId: string, audioId: string | undefined): RequestSpec<SubtitlePreferences> => ({ method: "GET", path: `/watch/${encodeURIComponent(contentId)}?file_id=${encodeURIComponent(fileId)}`, retry: "safe", decode: value => decodeSubtitlePreferences(value, contentId, fileId, audioId) }),
    subtitleAppearance: (profile: string): RequestSpec<SubtitleAppearance> => ({ method: "GET", path: "/settings/subtitle-appearance/effective", retry: "safe", decode: value => decodeAppearance(value, profile) }),
    subtitleSync: (): RequestSpec<number> => ({ method: "GET", path: "/settings/values/effective?keys=player.subtitle_sync_ms", retry: "safe", decode: value => {
        if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) throw new Error("Invalid subtitle timing");
        const rows: unknown[] = value.items;
        const row = rows.find((row): row is { key: string; value: unknown } => typeof row === "object" && row !== null && "key" in row && row.key === "player.subtitle_sync_ms" && "value" in row);
        if (row === undefined || typeof row.value !== "number" || !Number.isInteger(row.value) || Math.abs(row.value) > 10000) throw new Error("Invalid subtitle timing");
        return row.value;
    } }),
    /** getSubtitleSyncStatus: whether the server can align subtitles to audio, and this viewer may. */
    subtitleSyncStatus: (): RequestSpec<SubtitleSyncStatus> => ({ method: "GET", path: "/subtitles/sync/status", retry: "safe", decode: decodeSyncStatus }),
    /** listSubtitleSync: every syncable subtitle of the file, by sync key. */
    subtitleSyncList: (fileId: string): RequestSpec<readonly SubtitleSyncState[]> => ({ method: "GET", path: `/subtitles/${encodeURIComponent(fileId)}/sync`, retry: "safe", decode: decodeSyncList }),
    /** getSubtitleSync. `onEtag` receives the validator a timing write must send back. */
    subtitleSyncRead: (fileId: string, key: string, onEtag?: (etag: string | undefined) => void): RequestSpec<SubtitleSyncState> => ({ method: "GET", path: syncPath(fileId, key), retry: "safe", decode: decodeSyncEnvelope, ...(onEtag === undefined ? {} : { onEtag }) }),
    /** startSubtitleSync: starts a sync, or returns the subtitle with its active job. */
    subtitleSyncStart: (fileId: string, key: string): RequestSpec<SubtitleSyncState> => ({ method: "POST", path: syncPath(fileId, key), retry: "never", decode: decodeSyncEnvelope }),
    /** setSubtitleTiming with the identity: Reset Timing. A change made since the read wins (412). */
    subtitleTimingReset: (fileId: string, key: string, etag: string): RequestSpec<SubtitleSyncState> => ({ method: "PUT", path: `${syncPath(fileId, key)}/timing`, retry: "never", headers: { "If-Match": etag }, body: { offset_ms: IDENTITY_TIMING.offsetMs, scale: IDENTITY_TIMING.scale }, decode: decodeSyncEnvelope }),
};
