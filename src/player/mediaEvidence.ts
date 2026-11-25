import type { AudioFormatEvidence } from "../diagnosticsIncident.ts";
import type { AVPlay } from "./avplay.ts";

const CODEC_KEYS = ["fourCC", "codec", "codec_name"] as const;

/**
 * The AUDIO row AVPlay reports for the open stream, from `getCurrentStreamInfo` `extra_info`. This is what the player
 * demuxes for decoding, not a server plan; which keys a given firmware fills is unconfirmed until a TV is probed.
 * Undefined when the call is missing, refused in this state, or names neither a codec nor a channel count.
 */
export function readAvplayAudio(avplay: AVPlay): AudioFormatEvidence | undefined {
    try {
        const row = avplay.getCurrentStreamInfo?.().find(track => track.type === "AUDIO");
        if (row === undefined) return undefined;
        const extra: unknown = JSON.parse(row.extra_info);
        if (typeof extra !== "object" || extra === null || Array.isArray(extra)) return undefined;
        let codec: string | undefined;
        for (const key of CODEC_KEYS) {
            const value: unknown = Reflect.get(extra, key);
            if (typeof value === "string" && value.trim() !== "") {
                // AVPlay names codecs MIME-style in the S95C captures the fakes copy, e.g. `audio/x-eac3`.
                codec = value.trim().toLowerCase().replace(/^audio\//, "").replace(/^x-/, "");
                break;
            }
        }
        const rawChannels: unknown = Reflect.get(extra, "channels");
        const channels = typeof rawChannels === "number" && Number.isInteger(rawChannels)
            ? rawChannels
            : typeof rawChannels === "string" && /^\d{1,2}$/.test(rawChannels.trim()) ? Number(rawChannels.trim()) : undefined;
        return codec === undefined && channels === undefined ? undefined : { codec, channels };
    } catch {
        return undefined;
    }
}
