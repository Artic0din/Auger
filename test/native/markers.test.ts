import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMarkers, markerAt, type TimelineMarker } from "../../src/contracts/v2/markers.ts";
import { operations } from "../../src/api/operations.ts";
import { chapterTickFractions, markerBands } from "../../src/player/scrubberMarkers.ts";

test("segment window includes its start, excludes its end, uses source seconds, and never skips previews", () => {
    const markers: readonly TimelineMarker[] = [
        { kind: "recap", startSeconds: 0, endSeconds: 12.5 },
        { kind: "intro", startSeconds: 20, endSeconds: 60 },
        { kind: "preview", startSeconds: 100, endSeconds: 120 },
        { kind: "credits", startSeconds: 900, endSeconds: 960 },
    ];
    for (const [seconds, index] of [[0, 0], [12.499, 0], [20, 1], [59.999, 1], [900, 3], [959.9, 3]] as const) {
        assert.equal(markerAt(markers, seconds), markers[index]);
    }
    for (const seconds of [-1, 12.5, 19.999, 60, 100, 110, 960, NaN, Infinity]) assert.equal(markerAt(markers, seconds), undefined);
    assert.equal(markerAt([], 20), undefined);
});

test("file marker read encodes the identity and decodes intro, recap, credits, and preview occurrences", () => {
    const spec = operations.fileMarkers("file/42");
    assert.equal(spec.path, "/markers/files/file%2F42");
    assert.equal(spec.method, "GET");
    const raw = { file_id: "file/42", marker_segments: [
        { kind: "intro", start_seconds: 20, end_seconds: 60 },
        { kind: "preview", start_seconds: 100, end_seconds: 120 },
        { kind: "preview", start_seconds: 125, end_seconds: 125 },
        { kind: "unknown", start_seconds: 130, end_seconds: 140 },
        { kind: "recap", start_seconds: 200, end_seconds: 210 },
    ] };
    assert.deepEqual(spec.decode(raw), [
        { kind: "intro", startSeconds: 20, endSeconds: 60 },
        { kind: "preview", startSeconds: 100, endSeconds: 120 },
        { kind: "recap", startSeconds: 200, endSeconds: 210 },
    ]);
    assert.throws(() => decodeMarkers(raw, "different-file"));
    for (const marker_segments of [null, [{ kind: "intro", start_seconds: -1, end_seconds: 5 }],
        [{ kind: "intro", start_seconds: 5, end_seconds: 5 }], [{ kind: "credits", start_seconds: 5, end_seconds: Infinity }],
        [{ kind: "recap", start_seconds: "0", end_seconds: 5 }]]) {
        assert.throws(() => decodeMarkers({ ...raw, marker_segments }, "file/42"));
    }
});

test("markerBands and chapterTickFractions clamp to duration and omit chapter-0 at x=0", () => {
    const markers: readonly TimelineMarker[] = [
        { kind: "intro", startSeconds: 30, endSeconds: 90 },
        { kind: "preview", startSeconds: 500, endSeconds: 700 },
        { kind: "credits", startSeconds: 580, endSeconds: 650 },
    ];
    assert.deepEqual(markerBands(markers, 0), []);
    assert.deepEqual(markerBands(markers, undefined), []);
    assert.deepEqual(markerBands(markers, 600), [
        { kind: "intro", start: 0.05, end: 0.15 },
        { kind: "preview", start: 500 / 600, end: 1 },
        { kind: "credits", start: 580 / 600, end: 1 },
    ]);
    assert.deepEqual(chapterTickFractions([
        { title: "Opening", seconds: 0 },
        { title: "Tiny", seconds: 0.5 },
        { title: "Act 1", seconds: 150 },
        { title: "Act 2", seconds: 300 },
    ], 600), [0.25, 0.5]);
});
