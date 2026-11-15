// Style overrides against silo-apple 5780c84 Overlays/OverlaySchema.swift:129-154 and OverlayPresets.swift:229-323.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseOverlayPrefs } from "../../src/ui/cardOverlays.ts";
import { applyStyle, hexColor, parseStyle, PRESET_STYLES, type Rgba } from "../../src/ui/overlayPresets.ts";

const rounded = (color: Rgba | undefined): number[] | undefined => color?.map(channel => Math.round(channel * 1000) / 1000);

test("a style keeps the fields the contract accepts and drops each invalid one", () => {
    assert.deepEqual(parseStyle({ size: 1.25, shape: "rounded", background: "#11223344", textColor: "#abcdef", borderColor: "#00000080", borderWidth: 2, fontWeight: "extrabold", uppercase: false, shadow: true }),
        { size: 1.25, shape: "rounded", background: "#11223344", textColor: "#abcdef", borderColor: "#00000080", borderWidth: 2, fontWeight: "extrabold", uppercase: false, shadow: true });
    assert.deepEqual(parseStyle({ size: 2.5, shape: "blob", background: "#112233", textColor: "#11223344", borderColor: "red", borderWidth: 1.5, fontWeight: "bold", uppercase: "no", shadow: 1, extra: true, textColor2: "#fff" }), undefined, "every field invalid is no style");
    assert.deepEqual(parseStyle({ size: true, borderWidth: 4 }), undefined, "a boolean is not a size, and a border width runs 0 to 3");
    assert.deepEqual(parseStyle({ size: 0.75, borderWidth: 0 }), { size: 0.75, borderWidth: 0 });
    assert.equal(parseStyle([]), undefined);
    assert.equal(parseStyle(null), undefined);
});

test("the document carries its style, and a document with a preset and items reads as version 2", () => {
    assert.deepEqual(parseOverlayPrefs({ version: 2, preset: "plate", order: [], items: {}, style: { size: 1.5 } }).style, { size: 1.5 });
    const unversioned = parseOverlayPrefs({ preset: "band", items: { year: { enabled: true, position: "bottom-left" } } });
    assert.equal(unversioned.preset, "band", "OverlaySchema.swift:51-56");
    assert.equal(unversioned.items.get("year")?.enabled, true);
    assert.equal(parseOverlayPrefs({ year: { enabled: true, position: "top-left" } }).style, undefined, "a version 1 document has no style");
});

test("size scales the type, padding, icons and gaps; shape, border, weight, case and shadow replace the preset's", () => {
    const classic = applyStyle(PRESET_STYLES.classic, { size: 1.5, shape: "rounded", borderWidth: 3, fontWeight: "extrabold", uppercase: false, shadow: true });
    assert.equal(classic.fontSize, 15);
    assert.equal(classic.padX, 12);
    assert.equal(classic.padY, 3);
    assert.equal(classic.iconSize, 16.5);
    assert.equal(classic.iconGap, 6);
    assert.equal(classic.gap, 6);
    assert.equal(classic.radius, 6);
    assert.equal(classic.border, 3);
    assert.equal(classic.weight, 800, "extrabold is SwiftUI's heavy");
    assert.equal(classic.uppercase, false);
    assert.deepEqual(classic.boxShadow, { y: 2, blur: 6, color: [0, 0, 0, 0.35] }, "the style's shadow on a preset that has none");
    assert.equal(applyStyle(PRESET_STYLES.vibrant, { shape: "square", shadow: false }).boxShadow, undefined);
    assert.equal(applyStyle(PRESET_STYLES.vibrant, { shape: "square" }).radius, 2);
    assert.equal(applyStyle(PRESET_STYLES.plate, { shape: "pill" }).radius, undefined, "a capsule");
    assert.deepEqual(applyStyle(PRESET_STYLES.vibrant, { shadow: true }).boxShadow, PRESET_STYLES.vibrant.boxShadow, "a preset keeps its own shadow");
    assert.equal(applyStyle(PRESET_STYLES.classic, undefined), PRESET_STYLES.classic);
});

test("a fill or border gives bare presets room, and a solid fill drops the text shadow and picks readable text", () => {
    const minimal = applyStyle(PRESET_STYLES.minimal, { background: "#000000b3" });
    assert.equal(minimal.padX, 9 * 0.6, "framedPaddingInline");
    assert.ok(Math.abs(minimal.padY - 9 * 0.2) < 1e-9, "framedPaddingBlock");
    assert.equal(minimal.textShadow, undefined, "from half opacity a fill sits behind the text");
    assert.deepEqual(rounded(minimal.paint(undefined).foreground), [255, 255, 255, 1], "white on a dark fill");
    const faint = applyStyle(PRESET_STYLES.minimal, { background: "#00000040" });
    assert.notEqual(faint.textShadow, undefined, "a faint fill keeps the shadow");
    assert.deepEqual(rounded(faint.paint(undefined).foreground), [255, 255, 255, 0.85], "and the preset's text");
    const band = applyStyle(PRESET_STYLES.band, { borderWidth: 1 });
    assert.equal(band.padX, 12.5 * 0.6);
});

test("accents keep working through a custom style, as each preset paints them", () => {
    const yellow = hexColor("#f5c518");
    const white = applyStyle(PRESET_STYLES.band, { background: "#ffffffff" });
    // Yellow on white is under 3:1, so the band's text accent tints the fill instead and the text turns readable.
    assert.deepEqual(rounded(white.paint(yellow).background), rounded([0.3 * 245 + 0.7 * 255, 0.3 * 197 + 0.7 * 255, 0.3 * 24 + 0.7 * 255, 1]));
    assert.deepEqual(white.paint(yellow).foreground, [0, 0, 0, 1]);
    const black = applyStyle(PRESET_STYLES.band, { background: "#000000ff" });
    assert.deepEqual(black.paint(yellow).foreground, yellow, "yellow reads on black, so it stays the text");
    assert.deepEqual(black.paint(yellow).background, [0, 0, 0, 1]);
    const classic = applyStyle(PRESET_STYLES.classic, { background: "#102030ff", textColor: "#ff0000" });
    assert.deepEqual(rounded(classic.paint(yellow).background), rounded([0.3 * 245 + 0.7 * 16, 0.3 * 197 + 0.7 * 32, 0.3 * 24 + 0.7 * 48, 1]), "a filling preset tints the custom fill by the accent");
    assert.deepEqual(classic.paint(yellow).foreground, [255, 0, 0, 1]);
    const plate = applyStyle(PRESET_STYLES.plate, { borderColor: "#00ff00ff" });
    assert.deepEqual(plate.paint(undefined).border, [0, 255, 0, 1]);
    assert.deepEqual(rounded(plate.paint(yellow).border), [245, 197, 24, 0.45], "plate paints the accent on its border, so the accent wins there");
});
