export interface AudioCoverPalette {
    readonly top: string;
    readonly mid: string;
    readonly bottom: string;
}

export const DEFAULT_AUDIO_COVER_PALETTE: AudioCoverPalette = {
    top: "#1d2635",
    mid: "#131720",
    bottom: "#0a0c10",
};

function clampChannel(value: number, min: number, max: number): number {
    return Math.round(Math.min(max, Math.max(min, value)));
}

function rgb(r: number, g: number, b: number): string {
    return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Produces a 3-stop dark backdrop palette from an RGB cover sample, scaling down bright covers
 * so white typography and scrubber ticks always keep high contrast.
 */
export function paletteFromRgbSample(r: number, g: number, b: number): AudioCoverPalette {
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
        return DEFAULT_AUDIO_COVER_PALETTE;
    }
    const max = Math.max(r, g, b, 1);
    const scale = max > 110 ? 110 / max : 1;
    const sr = clampChannel(r * scale, 16, 110);
    const sg = clampChannel(g * scale, 18, 110);
    const sb = clampChannel(b * scale, 22, 116);
    return {
        top: rgb(sr, sg, sb),
        mid: rgb(clampChannel(sr * 0.56, 12, 64), clampChannel(sg * 0.56, 14, 64), clampChannel(sb * 0.62, 18, 72)),
        bottom: rgb(clampChannel(sr * 0.24, 8, 28), clampChannel(sg * 0.24, 9, 28), clampChannel(sb * 0.28, 11, 34)),
    };
}

/** Extracts a dark backdrop palette from a loaded `<img>`, falling back cleanly on cross-origin taint or errors. */
export function extractCoverPalette(img: HTMLImageElement): AudioCoverPalette {
    try {
        if (!img.complete || img.naturalWidth === 0 || img.naturalHeight === 0) {
            return DEFAULT_AUDIO_COVER_PALETTE;
        }
        const canvas = img.ownerDocument.createElement("canvas");
        canvas.width = 16;
        canvas.height = 16;
        const ctx = canvas.getContext("2d");
        if (ctx === null) return DEFAULT_AUDIO_COVER_PALETTE;
        ctx.drawImage(img, 0, 0, 16, 16);
        const data = ctx.getImageData(0, 0, 16, 16).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
            if ((data[i + 3] ?? 0) < 32) continue;
            r += data[i] ?? 0;
            g += data[i + 1] ?? 0;
            b += data[i + 2] ?? 0;
            count++;
        }
        if (count === 0) return DEFAULT_AUDIO_COVER_PALETTE;
        return paletteFromRgbSample(r / count, g / count, b / count);
    } catch {
        return DEFAULT_AUDIO_COVER_PALETTE;
    }
}
