// The Skyline page wash sampled from the backdrop, against silo-apple 1a7ccee
// `Components/HeroBackdropPalette.swift` (sample, normalize, dominantHue). Expected values were computed
// independently from those formulas.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
    backdropFrame,
    coverFrame,
    cssColor,
    hsv,
    resolveHeroArtwork,
    sampleCorners,
    samplePalette,
    sampleThumbhash,
    washBackground,
    type HeroArtwork,
    type RGB,
} from "../../src/ui/heroBackdrop.ts";

const close = (actual: RGB, expected: readonly [number, number, number], what: string): void => {
    for (const [index, channel] of (["r", "g", "b"] as const).entries()) {
        assert.ok(Math.abs(actual[channel] - (expected[index] ?? Number.NaN)) < 1e-6, `${what}.${channel}: ${actual[channel]} vs ${expected[index]}`);
    }
};
const px = (r: number, g: number, b: number): RGB => ({ r, g, b });

test("detail surfaces retain a uniform dimmed base beneath the shared accent and shadow", () => {
    const flat = px(0, 0, 0);
    const tints = { base: px(0.4, 0.3, 0.2), accent: px(0.5, 0.2, 0.1), shadow: px(0.1, 0.05, 0), corners: { topLeading: flat, topTrailing: flat, bottomTrailing: flat, bottomLeading: flat } };
    const detail = washBackground(tints, true);
    assert.equal(detail.includes("240.64deg"), false);
    assert.ok(detail.includes("rgba(102,77,51,0.42)"));
    assert.equal(detail.match(/radial-gradient/g)?.length, 2);
    assert.ok(washBackground(tints).includes("linear-gradient"), "root pages preserve their diagonal base wash");
    assert.equal(washBackground(undefined), "#000");
    assert.ok(washBackground(undefined, true).includes("rgba(10,31,36,0.42)"));
});

const CASES: readonly (readonly [string, readonly RGB[], readonly [number, number, number][]])[] = [
    ["a vivid red keeps its hue; its shadow drops to luminance 0.07", Array(4).fill(px(1, 0, 0)), [[1, 0, 0], [1, 0, 0], [0.329257, 0, 0]]],
    ["grey art has no accent hue, so the accent is the base", Array(4).fill(px(0.5, 0.5, 0.5)), [[0.22, 0.22, 0.22], [0.22, 0.22, 0.22], [0.07, 0.07, 0.07]]],
    ["black stays black", Array(4).fill(px(0, 0, 0)), [[0, 0, 0], [0, 0, 0], [0, 0, 0]]],
    ["a very dark tint is lifted, but too dark to count as an accent", Array(4).fill(px(0, 0, 0.1)), [[0, 0, 0.44], [0, 0, 0.44], [0, 0, 0.14]]],
    ["one vivid pixel outweighs three grey ones for the accent", [px(0.5, 0.5, 0.5), px(0.5, 0.5, 0.5), px(0.5, 0.5, 0.5), px(0, 1, 0)], [[0.148971, 0.248285, 0.148971], [0, 0.307606, 0], [0.07, 0.07, 0.07]]],
    ["mixed art: mean base, strongest-hue accent, darkest-quarter shadow", [px(0.9, 0.5, 0.1), px(0.2, 0.6, 0.6), px(0.05, 0.05, 0.08), px(0.6, 0.6, 0.6)], [[0.22341, 0.22341, 0.176175], [0.356013, 0.197785, 0.039557], [0.067094, 0.067094, 0.10735]]],
];

for (const [name, pixels, [base, accent, shadow]] of CASES) {
    test(`palette: ${name}`, () => {
        const tints = samplePalette(pixels, 2, 2);
        assert.ok(tints !== undefined);
        close(tints.base, base as [number, number, number], "base");
        close(tints.accent, accent as [number, number, number], "accent");
        close(tints.shadow, shadow as [number, number, number], "shadow");
    });
}

test("palette: no pixels gives no tints, so the page stays flat black", () => {
    assert.equal(samplePalette([], 0, 0), undefined);
});

test("css colours round each channel to a byte", () => {
    assert.equal(cssColor(px(0.148971, 0.248285, 1), 0.5), "rgba(38,63,255,0.5)");
});

test("the art frame is 64% of the width and 70% of the 16:9 height, in the top-right corner (TVBackdropArtworkLayout)", () => {
    assert.deepEqual(backdropFrame(1920), { left: 691.2, top: 0, width: 1228.8, height: 756 });
});

// --- Corners: HeroBackdropPalette.sampleCorners, silo-apple c5453eae (#1218). The first two cases are its HeroBackdropPaletteTests;
// the rest follow its scoring (coverage and saturation per hue bucket, neutral -40, yellow-green -60, the neighbour's hue -30) and
// its tint (value capped at 0.2 for the top-leading corner and 0.4 elsewhere, saturation lifted to 0.6 when above 0.18). ---

const hue = (rgb: RGB): number => hsv(rgb).hue;

test("each corner takes its colour from the same quarter of the art", () => {
    const red = px(0.8, 0.1, 0.1), blue = px(0.1, 0.2, 0.8), orange = px(0.9, 0.5, 0.1), purple = px(0.5, 0.1, 0.7), gray = px(0.4, 0.4, 0.4);
    const corners = sampleCorners([
        red, gray, blue, blue,
        red, red, gray, blue,
        orange, orange, purple, gray,
        gray, orange, purple, purple,
    ], 4, 4);
    assert.ok(corners !== undefined);
    assert.ok(Math.abs(hue(corners.topLeading) - hue(red)) < 0.02);
    assert.ok(Math.abs(hue(corners.topTrailing) - hue(blue)) < 0.02);
    assert.ok(Math.abs(hue(corners.bottomLeading) - hue(orange)) < 0.02);
    assert.ok(Math.abs(hue(corners.bottomTrailing) - hue(purple)) < 0.02);
});

test("grey art gives grey corners", () => {
    const pixels = Array.from({ length: 16 }, (_, index) => { const value = 0.2 + index / 30; return px(value, value, value); });
    const corners = sampleCorners(pixels, 4, 4);
    assert.ok(corners !== undefined);
    for (const corner of [corners.topLeading, corners.topTrailing, corners.bottomTrailing, corners.bottomLeading]) assert.ok(Math.abs(hsv(corner).saturation) < 0.001);
});

const CORNER_CASES: readonly (readonly [string, readonly RGB[], readonly [number, number, number], readonly [number, number, number]])[] = [
    // [name, every pixel, top-leading, the other three]
    ["a vivid red is capped at value 0.2 behind the title and 0.4 elsewhere", Array(16).fill(px(1, 0, 0)), [0.2, 0, 0], [0.4, 0, 0]],
    ["grey stays grey, only darkened", Array(16).fill(px(0.5, 0.5, 0.5)), [0.2, 0.2, 0.2], [0.4, 0.4, 0.4]],
    ["a pale colour is lifted to saturation 0.6", Array(16).fill(px(0.5, 0.35, 0.35)), [0.2, 0.08, 0.08], [0.4, 0.16, 0.16]],
    ["a dark tint below the cap is kept, saturation lifted", Array(16).fill(px(0.1, 0.05, 0.05)), [0.1, 0.04, 0.04], [0.1, 0.04, 0.04]],
    ["near-white is not a colour the art is about, so it gives black", Array(16).fill(px(1, 1, 1)), [0, 0, 0], [0, 0, 0]],
];
for (const [name, pixels, leading, others] of CORNER_CASES) {
    test(`corners: ${name}`, () => {
        const corners = sampleCorners(pixels, 4, 4);
        assert.ok(corners !== undefined);
        close(corners.topLeading, leading, "topLeading");
        for (const [corner, rgb] of Object.entries({ topTrailing: corners.topTrailing, bottomTrailing: corners.bottomTrailing, bottomLeading: corners.bottomLeading })) close(rgb, others, corner);
    });
}

/** A 4 x 4 image whose four 2 x 2 quarters are `topLeading`, `topTrailing`, `bottomLeading` and `bottomTrailing`, row by row. */
function quarters(topLeading: readonly RGB[], topTrailing: readonly RGB[], bottomLeading: readonly RGB[], bottomTrailing: readonly RGB[]): RGB[] {
    const at = (quarter: readonly RGB[], index: number): RGB => quarter[index] ?? px(0, 0, 0);
    return [0, 1, 2, 3].flatMap(row => [0, 1, 2, 3].map(column => at(row < 2 ? (column < 2 ? topLeading : topTrailing) : (column < 2 ? bottomLeading : bottomTrailing), (row % 2) * 2 + (column % 2))));
}
const grey = px(0.5, 0.5, 0.5), blue = px(0, 0, 1), red = px(1, 0, 0), green = px(0, 1, 0);

test("corners: a small patch of real colour wins over a larger grey area, since coverage counts as a square root", () => {
    const corners = sampleCorners(quarters([grey, grey, grey, blue], [grey, grey, grey, grey], [grey, grey, grey, grey], [grey, grey, grey, grey]), 4, 4);
    assert.ok(corners !== undefined);
    // Blue: 100 x sqrt(1/4) + 120 = 170. Grey: 100 x sqrt(3/4) - 40 = 46.6.
    assert.ok(Math.abs(hue(corners.topLeading) - 2 / 3) < 1e-9);
});

test("corners: a hue within 15 degrees of the neighbour's loses 30 points", () => {
    // Top-trailing: two red and two blue score 70.7 + 120 each; red is also the top-leading hue, so it loses 30 and blue wins.
    const corners = sampleCorners(quarters([red, red, red, red], [red, red, blue, blue], [grey, grey, grey, grey], [grey, grey, grey, grey]), 4, 4);
    assert.ok(corners !== undefined);
    assert.ok(Math.abs(hue(corners.topTrailing) - 2 / 3) < 1e-9);
});

test("corners: yellow-green and green lose 60 points, so a smaller blue patch wins", () => {
    // Green: 100 x sqrt(3/4) + 120 - 60 = 146.6; blue: 100 x sqrt(1/4) + 120 = 170.
    const corners = sampleCorners(quarters([green, green, green, blue], [grey, grey, grey, grey], [grey, grey, grey, grey], [grey, grey, grey, grey]), 4, 4);
    assert.ok(corners !== undefined);
    assert.ok(Math.abs(hue(corners.topLeading) - 2 / 3) < 1e-9);
});

test("corners: a bottom-trailing pick avoids the bottom-leading hue, not the top-leading one", () => {
    // Bottom-leading is blue. Bottom-trailing: two blue and two red; blue loses 30 against bottom-leading, so red wins.
    const corners = sampleCorners(quarters([red, red, red, red], [grey, grey, grey, grey], [blue, blue, blue, blue], [blue, blue, red, red]), 4, 4);
    assert.ok(corners !== undefined);
    assert.ok(Math.abs(hue(corners.bottomTrailing) - 0) < 1e-9);
});

test("corners: art too small to split into quarters gives none", () => {
    assert.equal(sampleCorners([grey], 1, 1), undefined);
    assert.equal(sampleCorners([grey, grey, grey], 2, 2), undefined);
    assert.equal(samplePalette([grey], 1, 1), undefined);
});

test("corners: a card's ThumbHash, the tint before the image is sampled, splits into quarters too", () => {
    const tints = sampleThumbhash("1QcSHQRnh493V4dIh4eXh1h4kJUI");
    assert.ok(tints !== undefined, "a ThumbHash's decoded size must match its pixel count");
    for (const corner of Object.values(tints.corners)) assert.ok(hsv(corner).value <= 0.4 + 1e-9);
    assert.ok(hsv(tints.corners.topLeading).value <= 0.2 + 1e-9, "the top-leading corner stays darkest");
    assert.equal(sampleThumbhash(undefined), undefined);
});

test("hero artwork selection waits on detail before falling back to a framed cover (TVHeroArtworkResolverTests)", () => {
    const poster: HeroArtwork = { url: "https://example.test/poster.jpg", thumbhash: "poster", coverAspect: "poster" };
    const sectionBackdrop: HeroArtwork = { url: "https://example.test/section-backdrop.jpg", thumbhash: "section" };
    const detailBackdrop: HeroArtwork = { url: "https://example.test/detail-backdrop.jpg", thumbhash: "detail" };

    assert.equal(resolveHeroArtwork({
        sectionBackdrop: undefined, fallback: poster, prefersEnrichedBackdrop: true,
        canLoadEnrichment: true, enrichmentState: "loading", enrichedBackdrop: undefined,
    }), undefined);
    assert.deepEqual(resolveHeroArtwork({
        sectionBackdrop: undefined, fallback: poster, prefersEnrichedBackdrop: true,
        canLoadEnrichment: true, enrichmentState: "completed", enrichedBackdrop: detailBackdrop,
    }), detailBackdrop);
    assert.deepEqual(resolveHeroArtwork({
        sectionBackdrop: undefined, fallback: poster, prefersEnrichedBackdrop: true,
        canLoadEnrichment: true, enrichmentState: "completed", enrichedBackdrop: undefined,
    }), poster);
    assert.deepEqual(resolveHeroArtwork({
        sectionBackdrop, fallback: poster, prefersEnrichedBackdrop: false,
        canLoadEnrichment: true, enrichmentState: "loading", enrichedBackdrop: undefined,
    }), sectionBackdrop);
    assert.deepEqual(resolveHeroArtwork({
        sectionBackdrop: undefined, fallback: poster, prefersEnrichedBackdrop: true,
        canLoadEnrichment: false, enrichmentState: "notStarted", enrichedBackdrop: undefined,
    }), poster);
    assert.deepEqual(resolveHeroArtwork({
        sectionBackdrop: undefined, fallback: poster, prefersEnrichedBackdrop: true,
        canLoadEnrichment: true, enrichmentState: "failed", enrichedBackdrop: undefined,
    }), poster);
});

test("framed cover geometry matches TVRootHeroBackdrop in both layout directions", () => {
    const ltrPoster = coverFrame("poster", false);
    assert.ok(Math.abs(ltrPoster.width - 380 * 2 / 3) < 0.01);
    assert.equal(ltrPoster.height, 380);
    assert.equal(ltrPoster.top, 170);
    assert.ok(Math.abs(ltrPoster.left + ltrPoster.width - (1920 - 150)) < 0.01);
    assert.equal(ltrPoster.radius, 14);
    assert.deepEqual(coverFrame("poster", true), { ...ltrPoster, left: 150 });
    assert.deepEqual(coverFrame("square", false), { left: 1920 - 150 - 380, top: 170, width: 380, height: 380, radius: 14 });
    assert.deepEqual(coverFrame("square", true), { left: 150, top: 170, width: 380, height: 380, radius: 14 });
});
