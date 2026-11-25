import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import { subtitleTextShadow } from "../../src/player/subtitleView.ts";

test("subtitle outline thickness follows AetherSubtitleOverlay fontSize * 0.03 clamped to [0.5, 2] at scale", () => {
    const base = { ...DEFAULT_APPEARANCE, backgroundStyle: "none" as const, textOutline: true, textOutlineColor: "#000000" };
    assert.equal(subtitleTextShadow({ ...base, fontSize: "small" }), "1.29px 1.29px 0 #000000, -1.29px 1.29px 0 #000000, 1.29px -1.29px 0 #000000, -1.29px -1.29px 0 #000000");
    assert.equal(subtitleTextShadow({ ...base, fontSize: "medium" }), "1.53px 1.53px 0 #000000, -1.53px 1.53px 0 #000000, 1.53px -1.53px 0 #000000, -1.53px -1.53px 0 #000000");
    assert.equal(subtitleTextShadow({ ...base, fontSize: "large" }), "1.74px 1.74px 0 #000000, -1.74px 1.74px 0 #000000, 1.74px -1.74px 0 #000000, -1.74px -1.74px 0 #000000");
    assert.equal(subtitleTextShadow({ ...base, fontSize: "xlarge" }), "2px 2px 0 #000000, -2px 2px 0 #000000, 2px -2px 0 #000000, -2px -2px 0 #000000");
    assert.equal(subtitleTextShadow({ ...base, fontSize: "xxlarge" }), "2px 2px 0 #000000, -2px 2px 0 #000000, 2px -2px 0 #000000, -2px -2px 0 #000000");
    assert.equal(subtitleTextShadow({ ...base, fontSize: "large" }, 0.5), "0.87px 0.87px 0 #000000, -0.87px 0.87px 0 #000000, 0.87px -0.87px 0 #000000, -0.87px -0.87px 0 #000000");
    assert.equal(subtitleTextShadow({ ...base, fontSize: "small" }, 0.2), "0.5px 0.5px 0 #000000, -0.5px 0.5px 0 #000000, 0.5px -0.5px 0 #000000, -0.5px -0.5px 0 #000000");
});

test("subtitle drop shadow uses Apple offsets/blur/opacity and layers alongside outline", () => {
    const shadowOnly = { ...DEFAULT_APPEARANCE, fontSize: "large" as const, backgroundStyle: "shadow" as const, textOutline: false };
    assert.equal(subtitleTextShadow(shadowOnly), "1.5px 2px 3px rgba(0, 0, 0, 0.85)");
    assert.equal(subtitleTextShadow(shadowOnly, 0.5), "0.75px 1px 1.5px rgba(0, 0, 0, 0.85)");

    const both = { ...shadowOnly, textOutline: true, textOutlineColor: "#112233" };
    assert.equal(
        subtitleTextShadow(both),
        "1.74px 1.74px 0 #112233, -1.74px 1.74px 0 #112233, 1.74px -1.74px 0 #112233, -1.74px -1.74px 0 #112233, 1.5px 2px 3px rgba(0, 0, 0, 0.85)",
    );

    const none = { ...DEFAULT_APPEARANCE, backgroundStyle: "none" as const, textOutline: false };
    assert.equal(subtitleTextShadow(none), "none");
});
