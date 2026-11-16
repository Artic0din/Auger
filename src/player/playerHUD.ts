import type { PlayerChapter } from "../contracts/v2/chapters.ts";
import type { AudioTrackInfo, PlaybackPlan, SubtitleTrack } from "../contracts/v2/playback.ts";
import { audioInfoLine, audioStatsLine, subtitleSingleLine, subtitleStatsLine } from "./trackLabels.ts";
import type { ItemDetail } from "../contracts/v2/catalog.ts";

export function currentChapter(chapters: readonly PlayerChapter[], seconds: number): number {
    for (let index = chapters.length - 1; index >= 0; index--) if (chapters[index]!.seconds <= seconds) return index;
    return -1;
}

export const DISPLAY_MODES = { Fit: "PLAYER_DISPLAY_MODE_LETTER_BOX", Stretch: "PLAYER_DISPLAY_MODE_FULL_SCREEN" } as const;
export type PlayerAspect = keyof typeof DISPLAY_MODES;

export function videoOptions(speed: boolean, aspect: boolean, protocol: string | undefined): { speeds: readonly number[]; aspects: readonly PlayerAspect[] } {
    return { speeds: speed && protocol === "http_progressive" ? [1, 2] : [], aspects: aspect ? ["Fit", "Stretch"] : [] };
}

export interface StatsRow {
    /** Empty on a row that continues the one above it. */
    readonly label: string;
    readonly value: string;
}

/** PlaybackStats (silo-apple e0337595, #1178): each fact once, in Apple's three sections, plus the Info pane's Now playing rows. */
export interface PlaybackStats {
    readonly nowPlaying: readonly StatsRow[];
    readonly playback: readonly StatsRow[];
    readonly stream: readonly StatsRow[];
    readonly engine: readonly StatsRow[];
}

export interface PlayerHUD {
    readonly metadata?: ItemDetail | undefined;
    readonly metadataFailed?: boolean;
    readonly chapters: readonly PlayerChapter[];
    readonly chapterState: "loading" | "ready" | "failed";
    readonly overview?: string | undefined;
    readonly stats: PlaybackStats;
    readonly speeds: readonly number[];
    readonly aspects: readonly PlayerAspect[];
    readonly speed: number | undefined;
    readonly aspect: PlayerAspect | undefined;
    readonly autoNext?: boolean | undefined;
    readonly busy: boolean;
    readonly message?: string | undefined;
}

/** What the plan cannot say: the selected tracks, the chosen speed, the playback phase and the media host. */
export interface LiveStats {
    readonly audio: { readonly track: AudioTrackInfo; readonly ordinal: number } | undefined;
    /** Undefined while subtitles are off. `generated` names an AI track by its result. */
    readonly subtitle: { readonly entry: SubtitleTrack; readonly generated: string | undefined } | undefined;
    readonly speed: number | undefined;
    readonly status: "Playing" | "Paused" | "Rebuffering";
    readonly host: string | undefined;
}

// AetherPlaybackStatsSourceMetadata.playMethodLabel and deliveryLabel.
const PLAY_METHODS: Readonly<Record<PlaybackPlan["delivery"], string | undefined>> = { original_http: "Direct play", server_remux_progressive: "Remuxed by the server", server_remux_hls: "Remuxed by the server", server_transcode_hls: "Transcoded by the server", unknown: undefined };
const DELIVERIES: Readonly<Record<PlaybackPlan["delivery"], string | undefined>> = { original_http: "Original HTTP", server_remux_progressive: "Server Remux", server_remux_hls: "Server Remux HLS", server_transcode_hls: "Server Transcode HLS", unknown: undefined };
const RANGES: Readonly<Record<string, string>> = { sdr: "SDR", hdr10: "HDR10", hdr10_plus: "HDR10+", "hdr10+": "HDR10+", hlg: "HLG", dolby_vision: "Dolby Vision" };
const VIDEO_CODECS: Readonly<Record<string, string>> = { hevc: "HEVC", h265: "HEVC", hvc1: "HEVC", hev1: "HEVC", h264: "H.264", avc: "H.264", avc1: "H.264", avc3: "H.264", av1: "AV1", av01: "AV1", vp9: "VP9", vp09: "VP9", mpeg2video: "MPEG-2", mpeg2: "MPEG-2", mpeg4: "MPEG-4", vc1: "VC-1" };
const CONTAINERS: Readonly<Record<string, string>> = { matroska: "MKV", mkv: "MKV", mpegts: "MPEG-TS", "mpeg-ts": "MPEG-TS", ts: "MPEG-TS", quicktime: "MOV", mov: "MOV", mp4: "MP4", m4v: "M4V" };
/** AetherPlaybackStatsProjection.resolutionClass: either dimension reaching a class is enough. */
const RESOLUTION_CLASSES = [[3800, 2100, "4K"], [2500, 1400, "1440p"], [1900, 1060, "1080p"], [1260, 700, "720p"]] as const;

const joined = (parts: readonly (string | undefined)[]): string | undefined => {
    const present = parts.filter((part): part is string => part !== undefined && part.trim() !== "").map(part => part.trim());
    return present.length === 0 ? undefined : present.join(" · ");
};

/** LocaleFormat.trimmed: at most `digits` decimals, no trailing zeros. */
const trimmed = (value: number, digits: number): string => value.toFixed(digits).replace(/\.(\d*?)0+$/, (_, kept: string) => kept === "" ? "" : `.${kept}`);

/** PlaybackStats.formatBitsPerSecond. */
const bitrate = (kbps: number): string => kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps.toFixed(0)} Kbps`;

const rangeLabel = (range: string | undefined, dvProfile: number | undefined): string | undefined => {
    const key = range?.trim().toLowerCase();
    if (key === "dolby_vision" && dvProfile !== undefined) return `Dolby Vision Profile ${dvProfile}`;
    return key === undefined ? undefined : RANGES[key];
};

/**
 * Apple's playback stats from what this client knows: the plan describes the file and the stream that reaches the TV
 * (`effective_recipe`, where Apple reads Aether's decoded stream), and `live` the rest. Rows Apple fills from Aether's
 * telemetry have no AVPlay source and are left out, never estimated.
 */
export function planStats(plan: PlaybackPlan, live: LiveStats): PlaybackStats {
    const recipe = plan.recipe;
    const source = plan.source;
    const width = recipe?.width ?? source.width ?? 0;
    const height = recipe?.height ?? source.height ?? 0;
    const picture = width > 0 && height > 0;
    const output = recipe?.dynamicRange ?? source.dynamicRange;
    const playMethod = PLAY_METHODS[plan.delivery];
    // A transcode names its output codec; a copy leaves the file's.
    const codec = recipe?.videoCodec ?? source.videoCodec;
    const frameRate = recipe?.frameRate ?? source.frameRate;
    const kbps = recipe?.bitrateKbps;
    const videoLine = joined([
        joined([picture && codec !== undefined ? VIDEO_CODECS[codec.toLowerCase()] ?? codec.toUpperCase() : undefined, picture ? `${width}×${height}` : undefined, frameRate !== undefined && frameRate > 0 ? `${trimmed(frameRate, 3)} fps` : undefined]),
        kbps !== undefined && kbps > 0 ? bitrate(kbps) : undefined,
    ]);
    const resolution = picture ? RESOLUTION_CLASSES.find(([w, h]) => width >= w || height >= h)?.[2] ?? `${height}p` : undefined;
    const summary = joined([resolution, picture && output !== undefined && output.toLowerCase() !== "sdr" ? rangeLabel(output, undefined) : undefined]);
    const from = source.dynamicRange?.trim().toLowerCase();
    const to = recipe?.dynamicRange?.trim().toLowerCase();
    const sourceRange = rangeLabel(from, source.dolbyVisionProfile);
    const outputRange = rangeLabel(to, undefined);
    const range = !picture ? undefined : from !== to && sourceRange !== undefined && outputRange !== undefined ? `${sourceRange} → ${outputRange}` : sourceRange;
    const audioInfo = live.audio === undefined ? undefined : audioInfoLine(live.audio.track, live.audio.ordinal);
    const audioStats = live.audio === undefined ? undefined : audioStatsLine(live.audio.track);
    const subtitleInfo = live.subtitle === undefined ? "Off" : live.subtitle.generated ?? subtitleSingleLine(live.subtitle.entry, live.subtitle.entry.combinedIndex);
    const subtitleStats = live.subtitle === undefined ? "Off" : live.subtitle.generated ?? subtitleStatsLine(live.subtitle.entry);
    const container = source.container === undefined ? undefined : CONTAINERS[source.container.toLowerCase()] ?? source.container;
    const reason = plan.decisionReason?.replaceAll("_", " ");
    // The reason and the warnings share one label; only the first row carries it.
    const notes = [reason === undefined ? undefined : reason.charAt(0).toUpperCase() + reason.slice(1), ...plan.warnings.map(warning => warning.message)].filter((note): note is string => note !== undefined && note.trim() !== "");
    const rows = (pairs: readonly (readonly [string, string | undefined])[]): StatsRow[] => pairs.flatMap(([label, value]) => value === undefined ? [] : [{ label, value }]);
    return {
        nowPlaying: rows([["Video", summary], ["Audio", audioInfo], ["Subtitles", subtitleInfo], ["Playback", playMethod]]),
        playback: [
            ...rows([
                ["Playback", joined([playMethod, container])], ["Video", videoLine], ["Dynamic range", range], ["Audio", audioStats], ["Subtitles", subtitleStats],
                // The speed is a stat only while it changes what the other rows mean.
                ["Playback rate", live.speed !== undefined && live.speed > 0 && Math.abs(live.speed - 1) > 0.001 ? `${trimmed(live.speed, 2)}×` : undefined],
            ]),
            ...notes.map((note, index) => ({ label: index === 0 ? "Diagnostics" : "", value: note })),
        ],
        stream: rows([["Playback status", live.status]]),
        engine: rows([["Delivery", DELIVERIES[plan.delivery]], ["Source", live.host]]),
    };
}
