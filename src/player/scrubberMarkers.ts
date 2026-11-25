// PlayerMarkerTimeline.swift, PlayerMarkerBands.swift & TVPlayerScrubber.swift (silo-apple main 3289bedb):
// scrubber marker bands and chapter tick fractions.
import type { PlayerChapter } from "../contracts/v2/chapters.ts";
import type { MarkerKind, TimelineMarker } from "../contracts/v2/markers.ts";

export interface MarkerBand {
    readonly kind: MarkerKind;
    readonly start: number;
    readonly end: number;
}

/** `PlayerMarkerTimeline.bands(duration:)`: clamped [0, 1] fractions for every marker occurrence. */
export function markerBands(markers: readonly TimelineMarker[] | undefined, durationSeconds: number | undefined): MarkerBand[] {
    if (markers === undefined || markers.length === 0 || durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return [];
    }
    const bands: MarkerBand[] = [];
    for (const marker of markers) {
        const start = Math.min(Math.max(marker.startSeconds / durationSeconds, 0), 1);
        const end = Math.min(Math.max(marker.endSeconds / durationSeconds, 0), 1);
        if (end > start) bands.push({ kind: marker.kind, start, end });
    }
    return bands;
}

/** `TVPlayerScrubber.chapterTicks`: chapter positions as fractions, omitting chapter-0 at <= 0.001. */
export function chapterTickFractions(chapters: readonly PlayerChapter[] | undefined, durationSeconds: number | undefined): number[] {
    if (chapters === undefined || chapters.length === 0 || durationSeconds === undefined || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return [];
    }
    const ticks: number[] = [];
    for (const chapter of chapters) {
        const fraction = Math.min(Math.max(chapter.seconds / durationSeconds, 0), 1);
        if (fraction > 0.001) ticks.push(fraction);
    }
    return ticks;
}
