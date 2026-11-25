import { object, nonEmptyString, WireError } from "./wire.ts";

export type MarkerKind = "intro" | "recap" | "credits" | "preview";

export interface TimelineMarker {
    readonly kind: MarkerKind;
    readonly startSeconds: number;
    readonly endSeconds: number;
}

export interface SkipMarker extends TimelineMarker {
    readonly kind: "intro" | "recap" | "credits";
}

export function decodeMarkers(value: unknown, fileId: string): readonly TimelineMarker[] {
    const obj = object(value, "markers");
    if (nonEmptyString(obj, "file_id", "markers") !== fileId) throw new WireError("markers.file_id", "the effective file");
    if (!Array.isArray(obj.marker_segments)) throw new WireError("markers.marker_segments", "an array");
    return obj.marker_segments.flatMap((entry: unknown): TimelineMarker[] => {
        const segment = object(entry, "marker");
        const kind = segment.kind;
        if (kind !== "intro" && kind !== "recap" && kind !== "credits" && kind !== "preview") return [];
        const start = segment.start_seconds;
        const end = segment.end_seconds;
        if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
            if (kind === "preview") return [];
            throw new WireError("marker.window", "finite increasing source seconds");
        }
        return [{ kind, startSeconds: start, endSeconds: end }];
    });
}

/** Active skippable marker at `seconds`. Preview segments are drawn on the timeline and never skipped. */
export function markerAt(markers: readonly TimelineMarker[], seconds: number): SkipMarker | undefined {
    for (const marker of markers) {
        if (marker.kind === "preview") continue;
        if (seconds >= marker.startSeconds && seconds < marker.endSeconds) return marker as SkipMarker;
    }
    return undefined;
}
