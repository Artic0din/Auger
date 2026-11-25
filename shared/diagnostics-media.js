export const PROTOCOLS = ["http", "https", "http_progressive", "hls", "dash"];
export const CONTAINERS = ["mkv", "matroska", "mp4", "m4v", "mov", "quicktime", "ts", "mpegts", "mpeg-ts", "m2ts", "avi", "webm", "fmp4", "hls"];
export const VIDEO_CODECS = ["h264", "h.264", "h.265", "avc", "avc1", "hevc", "h265", "hvc1", "hev1", "av1", "av01", "vp9", "vp09", "vp8", "mpeg2", "mpeg2video", "mpeg4", "vc1"];
export const DYNAMIC_RANGES = ["sdr", "hdr", "hdr10plus", "dv", "hdr10", "hdr10_plus", "hdr10+", "hlg", "dolby_vision"];

export const DISPLAY_CODECS = ["HEVC", "H265", "H.265", "HVC1", "HEV1", "H264", "H.264", "AVC", "AVC1", "AVC3", "AV1", "AV01", "VP9", "VP09", "VP8", "MPEG2", "MPEG-2", "MPEG2VIDEO", "MPEG4", "MPEG-4", "VC1", "VC-1"];
const RANGE_LABEL = String.raw`(?:SDR|HDR10\+?|HLG|Dolby Vision(?: Profile \d{1,2}(?:\.\d)?)?)`;
const HUD_RANGE = new RegExp(String.raw`^${RANGE_LABEL}(?: → (?:${RANGE_LABEL}|Profile 8\.1))?(?: \(unconfirmed\))?$`);
const HUD_METHOD = /^(?:Direct play|Direct Play|Direct stream|Remuxed|Remuxed by the server|Transcoded|Transcoded by the server)(?: · (?:MKV|MP4|M4V|MOV|MPEG-TS|TS|AVI|WEBM))?$/;

export function publicHudVideo(raw) {
  if (typeof raw !== "string" || raw.length > 140) return undefined;
  return raw.split(" · ").every(part => DISPLAY_CODECS.includes(part) || /^\d{2,5}[×x]\d{2,5}$/.test(part)
    || /^\d{1,3}(?:\.\d{1,3})? fps$/.test(part) || /^\d{1,6}(?:\.\d{1,2})? (?:Mbps|Kbps)$/.test(part)) ? raw : undefined;
}

export function publicHudRange(raw) {
  return typeof raw === "string" && HUD_RANGE.test(raw) ? raw : undefined;
}

export function publicHudMethod(raw) {
  return typeof raw === "string" && HUD_METHOD.test(raw) ? raw : undefined;
}
