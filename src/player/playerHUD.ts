import type { PlayerChapter } from "../contracts/v2/chapters.ts";
import type { AudioTrackInfo, PlaybackPlan, SubtitleTrack } from "../contracts/v2/playback.ts";
import { audioInfoLine, audioStatsLine, subtitleSingleLine, subtitleStatsLine } from "./trackLabels.ts";
import type { ItemDetail } from "../contracts/v2/catalog.ts";
import { integerText } from "../i18n/numbers.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";

/** `TVPlayerInfoHUD` (`InfoCurrentChapterRow` / `ChaptersView`): chapter's title, else localized "Chapter N". */
export function chapterTitle(chapter: PlayerChapter, index: number): string {
    const title = chapter.title?.trim();
    return title !== undefined && title !== "" ? title : translate("options.chapterNumbered", { number: integerText(index + 1) });
}

export function currentChapter(chapters: readonly PlayerChapter[], seconds: number): number {
    for (let index = chapters.length - 1; index >= 0; index--) if (chapters[index]!.seconds <= seconds) return index;
    return -1;
}

export const DISPLAY_MODES = { Fit: "PLAYER_DISPLAY_MODE_LETTER_BOX", Stretch: "PLAYER_DISPLAY_MODE_FULL_SCREEN" } as const;
export type PlayerAspect = keyof typeof DISPLAY_MODES;

const ASPECT_KEYS = { Fit: "player.aspect.fit", Stretch: "player.aspect.stretch" } as const satisfies Readonly<Record<PlayerAspect, MessageKey>>;
/** The aspect's name in the shown language; `Fit` and `Stretch` stay the ids the screen and AVPlay use. */
export function aspectLabel(aspect: PlayerAspect): string {
    return translate(ASPECT_KEYS[aspect]);
}

const STAT_KEYS: Readonly<Record<string, MessageKey>> = {
    Video: "player.hud.video", Audio: "player.hud.audio", Subtitles: "player.hud.subtitles", Playback: "player.hud.playback",
    "Dynamic range": "player.stats.dynamicRange", "Playback rate": "player.stats.playbackRate", "Playback status": "player.stats.playbackStatus",
    "Network throughput": "player.stats.networkThroughput", Delivery: "player.stats.delivery", Source: "player.stats.source", Diagnostics: "player.settings.diagnostics",
};
/** A stats or Info row's label in the shown language where Apple has the same text; the rest keep their English. */
export function statLabel(label: string): string {
    const key = STAT_KEYS[label];
    return key === undefined ? label : translate(key);
}

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

export type PlaybackStatus = "Loading" | "Playing" | "Paused" | "Seeking" | "Rebuffering" | "Stalled" | "Reconnecting" | "Ended" | "Error";

/** What the plan cannot say: the selected tracks, the chosen speed, the playback phase, AVPlay's measured throughput and the media host. */
export interface LiveStats {
    readonly audio: { readonly track: AudioTrackInfo; readonly ordinal: number } | undefined;
    /** Undefined while subtitles are off. `generated` names an AI track by its result. */
    readonly subtitle: { readonly entry: SubtitleTrack; readonly generated: string | undefined } | undefined;
    readonly speed: number | undefined;
    readonly status: PlaybackStatus;
    readonly host: string | undefined;
    /** Positive bits per second from `AVPlay.getStreamingProperty("CURRENT_BANDWIDTH")`; omitted when unavailable or zero. */
    readonly networkThroughputBps?: number | undefined;
}

// AetherPlaybackStatsSourceMetadata.playMethodLabel and deliveryLabel.
const PLAY_METHODS: Readonly<Record<PlaybackPlan["delivery"], MessageKey | undefined>> = { original_http: "player.stats.playMethodDirectPlay", server_remux_progressive: "player.stats.playMethodRemuxed", server_remux_hls: "player.stats.playMethodRemuxed", server_transcode_hls: "player.stats.playMethodTranscoded", unknown: undefined };
const DELIVERIES: Readonly<Record<PlaybackPlan["delivery"], MessageKey | undefined>> = { original_http: "player.stats.deliveryOriginalHttp", server_remux_progressive: "player.stats.deliveryServerRemux", server_remux_hls: "player.stats.deliveryServerRemuxHls", server_transcode_hls: "player.stats.deliveryServerTranscodeHls", unknown: undefined };
// AetherPlaybackStatsProjection.phaseLabel: the status stays its English id in the view state and reads the catalog here.
const PHASES: Readonly<Record<PlaybackStatus, MessageKey>> = {
    Loading: "common.loading",
    Playing: "player.stats.phasePlaying",
    Paused: "player.stats.phasePaused",
    Seeking: "player.stats.phaseSeeking",
    Rebuffering: "player.stats.phaseRebuffering",
    Stalled: "player.stats.phaseStalled",
    Reconnecting: "player.stats.phaseReconnecting",
    Ended: "player.stats.phaseEnded",
    Error: "player.stats.phaseError",
};
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
    const methodKey = PLAY_METHODS[plan.delivery];
    const deliveryKey = DELIVERIES[plan.delivery];
    const playMethod = methodKey === undefined ? undefined : translate(methodKey);
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
    const range = !picture ? undefined : from !== to && sourceRange !== undefined && outputRange !== undefined ? `${sourceRange} → ${outputRange}` : sourceRange ?? outputRange;
    const audioInfo = live.audio === undefined ? undefined : audioInfoLine(live.audio.track, live.audio.ordinal);
    // Apple reads the decoded stream's track: the selected track's language with the format the recipe delivers. A recipe
    // without a channel count leaves the layout out rather than borrow the source's.
    const audioStats = live.audio === undefined ? undefined : audioStatsLine(recipe === undefined ? live.audio.track : { ...live.audio.track, codec: recipe.audioCodec, channels: recipe.audioChannels });
    const subtitleInfo = live.subtitle === undefined ? translate("player.tracks.subtitlesOff") : live.subtitle.generated ?? subtitleSingleLine(live.subtitle.entry, live.subtitle.entry.combinedIndex);
    const subtitleStats = live.subtitle === undefined ? translate("player.tracks.subtitlesOff") : live.subtitle.generated ?? subtitleStatsLine(live.subtitle.entry);
    const container = source.container === undefined ? undefined : CONTAINERS[source.container.toLowerCase()] ?? source.container;
    const reason = plan.decisionReason?.replaceAll("_", " ");
    // The reason and the warnings share one label; only the first row carries it.
    const notes = [reason === undefined ? undefined : reason.charAt(0).toUpperCase() + reason.slice(1), ...plan.warnings.map(warning => warning.message)].filter((note): note is string => note !== undefined && note.trim() !== "");
    const throughputKbps = live.networkThroughputBps !== undefined && Number.isFinite(live.networkThroughputBps) && live.networkThroughputBps > 0
        ? live.networkThroughputBps / 1000
        : undefined;
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
        stream: rows([["Playback status", translate(PHASES[live.status])], ["Network throughput", throughputKbps === undefined ? undefined : bitrate(throughputKbps)]]),
        engine: rows([["Delivery", deliveryKey === undefined ? undefined : translate(deliveryKey)], ["Source", live.host]]),
    };
}
