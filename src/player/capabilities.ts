// What this client tells the server it can play. The server plans the route from it
// (protocol v3 §3, §4); the client never chooses direct, remux or transcode itself.
//
// Conservative for every Samsung TV on Tizen 8.0 or later. The OS version does not fix the panel's
// decoder generation, so this keeps to Samsung's 2021 TV video specification, which lists
// H.264 and HEVC (MP4, MKV and TS), AAC, AC3, E-AC3 and MP3, and no DTS. Tizen offers no decoder
// enumeration, so the evidence tier is `declared`. The resolution cap is 2160p only when
// webapis.productinfo.isUdPanelSupported() returns true, and 1080p otherwise. HDR is
// claimed only when webapis.avinfo.isHdrTvSupport() returns true and the HDR setting is on.
// That call is one boolean. A true result claims HDR10 only. HDR10+ and HLG stay unclaimed:
// Samsung documents no per-format probe, and the year specifications do not list those formats
// for every TV on Tizen 8.0 or later. dolby_vision_profiles stays empty. Audio passthrough is never claimed.
// Original HTTP claims client_selected_audio_track_v1, as Apple TV 4K does: AVPlay plays the plan's
// audio ordinal with setSelectTrack, so a non-default track stays direct play (#507).
// Every subtitle capability
// uses the app's plain-text sidecar renderer for sidecars. Embedded text is selected with AVPlay setSelectTrack
// when the open stream lists a TEXT row; bitmap and ASS styling stay off. The progressive class
// is omitted (no proof AVPlay plays a forward-only chunked remux).

import type { ClientCapabilities, ClientPlaybackContext, DeliveryCapability, HdrDetails, VideoDecodeCapability } from "../contracts/v2/playback.ts";

/** What the panel reported. Dolby Vision stays false: Samsung does not document a probe for it. */
export interface HdrPanel {
    readonly hdr10: boolean;
    readonly hlg: boolean;
    readonly dolbyVision: boolean;
}

/** Effective `player.hdr_enabled`. Apple's default is on. Dolby Vision is not read. */
export interface HdrPreference {
    readonly hdrEnabled: boolean;
}

export interface HdrReport {
    readonly panel: HdrPanel;
    readonly preference: HdrPreference;
}

const NO_HDR: HdrPanel = { hdr10: false, hlg: false, dolbyVision: false };

function field(value: unknown, key: string): unknown {
    return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

/**
 * `webapis.avinfo.isHdrTvSupport()` (AvInfo API, since 2.3). True means the TV supports HDR.
 * A missing object, a non-boolean, or a throw is SDR. The method lists no privilege.
 *
 * The call is one boolean and does not name a format. Product info, AVPlay stream properties,
 * AVPlay track info and both system-info APIs do not either, and the year video specifications
 * do not list HDR10+ or HLG for every model on Tizen 8.0 or later. A true result reports HDR10
 * only. HLG stays false. Dolby Vision stays false. See docs/settings.md.
 */
export function probeHdrPanel(scope: unknown = globalThis): HdrPanel {
    return hdrPanelFor(probeHdr(scope));
}

/** What the probe observed: the TV answered true or false, or gave no usable answer. Only diagnostics tell the last two apart. */
export type HdrProbe = "hdr" | "sdr" | "unavailable";

/** Calls `webapis[api][method]()` with the API object as `this`. A missing method, a non-boolean, or a throw is undefined. */
function askPanel(scope: unknown, api: string, method: string): boolean | undefined {
    try {
        const target = field(field(scope, "webapis"), api);
        const read = field(target, method);
        if (typeof read !== "function") return undefined;
        const answer: unknown = read.call(target);
        return typeof answer === "boolean" ? answer : undefined;
    } catch {
        return undefined;
    }
}

export function probeHdr(scope: unknown = globalThis): HdrProbe {
    const supported = askPanel(scope, "avinfo", "isHdrTvSupport");
    return supported === undefined ? "unavailable" : supported ? "hdr" : "sdr";
}

/** An unavailable probe declares SDR, exactly as an observed false does. */
export function hdrPanelFor(probe: HdrProbe): HdrPanel {
    return probe === "hdr" ? { hdr10: true, hlg: false, dolbyVision: false } : NO_HDR;
}

/** What the panel answered: 4K/8K, Full HD, or no usable answer. */
export type UhdProbe = "uhd" | "fhd" | "unavailable";

/**
 * `webapis.productinfo.isUdPanelSupported()` (ProductInfo API). Samsung's 4K 8K UHD Video guide
 * names it as the 4K check: true for a 4K or 8K panel, false for Full HD. The `productinfo`
 * privilege is already declared for the model name.
 */
export function probeUhd(scope: unknown = globalThis): UhdProbe {
    const supported = askPanel(scope, "productinfo", "isUdPanelSupported");
    return supported === undefined ? "unavailable" : supported ? "uhd" : "fhd";
}

export type PanelResolution = "2160p" | "1080p";

/** An unavailable probe keeps 1080p, exactly as an observed false does. An 8K panel claims 2160p. */
export function resolutionFor(probe: UhdProbe): PanelResolution {
    return probe === "uhd" ? "2160p" : "1080p";
}

/**
 * ApplePlaybackV3Capabilities.swift:439-483. The wire object is hdr10, hdr10_plus, hlg and
 * dolby_vision_profiles. HDR10 and HLG need the HDR setting and a panel report, as Apple fills
 * them (lines 440-441). The probe reports HDR10 only, so HLG stays unclaimed. hdr10_plus stays
 * false: nothing reports HDR10+. Apple hardcodes hdr10Plus false (lines 479-480).
 * dolby_vision_profiles stays empty. Apple sends [5, 8] when Dolby Vision is on (line 482); this
 * client claims no profile. No claim omits hdr_details.
 */
export function hdrDetails(report: HdrReport): HdrDetails | undefined {
    const hdr10 = report.preference.hdrEnabled && report.panel.hdr10;
    const hlg = report.preference.hdrEnabled && report.panel.hlg;
    if (!hdr10 && !hlg) return undefined;
    return { hdr10, hdr10_plus: false, hlg, dolby_vision_profiles: [] };
}

const VIDEO_CODECS = ["h264", "hevc"];
const AUDIO_CODECS = ["aac", "ac3", "eac3", "mp3"];

const NO_SUBTITLES = {
    embedded_text: true,
    sidecar_text: true,
    ass_styling: false,
    embedded_bitmap: false,
    sidecar_bitmap: false,
    font_attachments: false,
};

/** Original HTTP only: packaged HLS already carries just the selected audio. */
const CLIENT_SELECTED_AUDIO_TRACK_CLAIM = "client_selected_audio_track_v1";

function delivery(containers: readonly string[], features: readonly string[], hdr?: HdrDetails, validatedClaims: readonly string[] = []): DeliveryCapability {
    return {
        enabled: true,
        supported_on_device: true,
        containers,
        video_codecs: VIDEO_CODECS,
        audio_decode_codecs: AUDIO_CODECS,
        audio_passthrough_codecs: [],
        subtitles: NO_SUBTITLES,
        features,
        // AVPlay cannot change a URL's credential without reopening it.
        auth_header_refresh: false,
        validated_claims: validatedClaims,
        transformations: [],
        ...(hdr === undefined ? {} : { hdr_details: hdr }),
    };
}

/** The server carries an embedded text track inside an HLS stream instead of a whole-file sidecar. */
export const HLS_SUBTITLE_RENDITIONS_FEATURE = "hls_subtitle_renditions_v1";
/** Same rendition on a copy remux, which `hls_subtitle_renditions_v1` does not cover. */
export const HLS_REMUX_SUBTITLE_RENDITIONS_FEATURE = "hls_remux_subtitle_renditions_v1";
/**
 * Every embedded text track is a rendition of the stream. Sent only after the server
 * advertises it, then repeated on every replan of that attempt.
 */
export const HLS_SUBTITLE_RENDITIONS_ALL_FEATURE = "hls_subtitle_renditions_all_v1";

/**
 * Lower quality when buffering. Sent only after the server advertises it, as Apple's start and
 * replans do, because it opts the request into `bandwidth_estimate_source` and `learned_limit`.
 */
export const BUFFERING_QUALITY_FEATURE = "buffering_quality_v1";

/** Start and replan send the same base features. Renditions-all and buffering quality follow the server. */
export const CLIENT_FEATURES: readonly string[] = [
    "playback_plan_v3",
    "embedded_subtitles_v1",
    HLS_SUBTITLE_RENDITIONS_FEATURE,
    HLS_REMUX_SUBTITLE_RENDITIONS_FEATURE,
];

export function clientFeatures(renditionsAll: boolean, bufferingQuality = false): readonly string[] {
    return [...CLIENT_FEATURES, ...(renditionsAll ? [HLS_SUBTITLE_RENDITIONS_ALL_FEATURE] : []), ...(bufferingQuality ? [BUFFERING_QUALITY_FEATURE] : [])];
}

const H264_FHD: VideoDecodeCapability = { codec: "h264", hardware: true, bit_depths: [8], max_width: 1920, max_height: 1080 };

/**
 * Apple pairs its resolution token with the same pixel box: 3840x2160 for 2160p, 1920x1080 for
 * 1080p (silo-apple d74a30aa, AppleDecodeCapabilities.swift:256-273, sent as `maxResolution` at
 * ApplePlaybackV3Capabilities.swift:208). Apple TV HD is Apple's only 1080p surface.
 *
 * On the declared tier these entries only narrow the flat lists, and a source passes when any entry for
 * its codec takes it. Samsung's 2024-2026 video specifications cap UHD H.264 at Level 5.1, which holds
 * 3840x2160 at 30 fps, so the UHD H.264 entry carries that frame rate. The server enforces
 * `max_frame_rate` absolutely on this tier, so the Full HD entry stays uncapped and 1080p60 H.264 keeps
 * playing. HEVC UHD is Level 5.1 or 5.2, which holds 3840x2160 at 60 fps.
 */
const VIDEO_DECODE: Readonly<Record<PanelResolution, readonly VideoDecodeCapability[]>> = {
    "2160p": [
        H264_FHD,
        { codec: "h264", hardware: true, bit_depths: [8], max_width: 3840, max_height: 2160, max_frame_rate: 30 },
        { codec: "hevc", hardware: true, bit_depths: [8, 10], max_width: 3840, max_height: 2160 },
    ],
    "1080p": [
        H264_FHD,
        { codec: "hevc", hardware: true, bit_depths: [8, 10], max_width: 1920, max_height: 1080 },
    ],
};

export const CLIENT_CAPABILITIES: ClientCapabilities = {
    video_evidence: "declared",
    audio_evidence: "declared",
    codecs_video: VIDEO_CODECS,
    codecs_video_hardware: VIDEO_CODECS,
    codecs_audio: AUDIO_CODECS,
    containers: ["mp4", "m4v", "mkv", "matroska", "m3u8", "hls"],
    max_resolution: "1080p",
    hdr: false,
    video_decode: VIDEO_DECODE["1080p"],
};

/** The 1080p SDR profile when the panel and the report claim nothing. Otherwise the same lists, resized for a 4K panel and with HDR details. */
export function clientCapabilities(report?: HdrReport, resolution: PanelResolution = "1080p"): ClientCapabilities {
    const details = report === undefined ? undefined : hdrDetails(report);
    const sized = resolution === "1080p" ? CLIENT_CAPABILITIES : { ...CLIENT_CAPABILITIES, max_resolution: resolution, video_decode: VIDEO_DECODE[resolution] };
    return details === undefined ? sized : { ...sized, hdr: true, hdr_details: details };
}

export function playbackContext(model: string, appVersion: string, report?: HdrReport): ClientPlaybackContext {
    const details = report === undefined ? undefined : hdrDetails(report);
    const original = delivery(["mp4", "m4v", "mkv", "matroska"], [], details, [CLIENT_SELECTED_AUDIO_TRACK_CLAIM]);
    const context: ClientPlaybackContext = {
        protocol_version: 3,
        form_factor: "tv",
        app_version: appVersion,
        device: { platform: "tizen", manufacturer: "Samsung", model },
        output: {},
        deliveries: {
            // No native embedded text: the app draws every text track from the server's artifact, so Delay and Appearance apply to it.
            // The S95C accepts AVPlay's setSubtitlePosition but its own text does not move, so AVPlay-drawn text could not follow Delay (#538).
            original_http: { ...original, subtitles: { ...original.subtitles, embedded_text: false } },
            // MPEG-TS segments for copy remuxes, as AVPlay HLS plays them.
            hls: delivery(["m3u8", "hls"], ["hls_copy_mpegts_v1"], details),
        },
    };
    if (details === undefined) return context;
    return { ...context, output: { hdr_details: details } };
}
