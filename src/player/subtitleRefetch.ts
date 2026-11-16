import { sleep, type Clock } from "../api/clock.ts";
import { abortedError, SubtitleTruncated } from "../api/http.ts";

/** Apple's `AetherEngine.sidecarTruncationRetryDelaysSeconds`: a server still extracting the track serves each refetch more of it. */
export const SUBTITLE_REFETCH_DELAYS_MS = [2000, 5000, 10000, 10000, 10000];

/**
 * Apple's `decodeSidecarRetryingTruncation`. Fetches until a download arrives whole. After one ends
 * early the cues it held go to `showPartial` (only when more than the ones already shown) and the
 * file is fetched again after each delay, a refetch that fails outright included. Returns the
 * largest partial once the refetches are spent. A first fetch that never got going throws.
 */
export async function downloadSubtitle<Cue>(
    clock: Clock,
    signal: AbortSignal,
    fetchText: () => Promise<string>,
    decode: (text: string) => readonly Cue[],
    showPartial: (cues: readonly Cue[]) => void,
): Promise<readonly Cue[]> {
    let best: readonly Cue[] | undefined;
    for (let attempt = 0; ; attempt++) {
        let failure: unknown;
        try {
            return decode(await fetchText());
        } catch (error) {
            failure = error;
        }
        if (signal.aborted) throw failure;
        if (failure instanceof SubtitleTruncated) {
            const partial = decode(failure.text);
            if (partial.length > (best?.length ?? -1)) {
                best = partial;
                showPartial(partial);
            }
        }
        if (best === undefined) throw failure;
        const delay = SUBTITLE_REFETCH_DELAYS_MS[attempt];
        if (delay === undefined) return best;
        await sleep(clock, delay, signal, abortedError);
    }
}
