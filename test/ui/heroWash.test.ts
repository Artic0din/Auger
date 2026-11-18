import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "./support/tv.ts";

let browser: Browser;
let bundle = "";
before(async () => {
    browser = await launchBrowser();
    const fixture = await build({ entryPoints: [new URL("../../src/ui/heroBackdrop.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HeroFixture", target: "chrome108", write: false });
    bundle = fixture.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

async function page(): Promise<Page> {
    const tab = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await tab.setContent("<html><body style='margin:0;background:#000'></body></html>");
    await tab.addScriptTag({ content: bundle });
    return tab;
}

const flat = (r: number, g: number, b: number): { r: number; g: number; b: number } => ({ r, g, b });
const TINTS = [
    { base: flat(0.09, 0.1, 0.08), accent: flat(0.39, 0.18, 0.11), shadow: flat(0.02, 0.04, 0.07), corners: { topLeading: flat(0.2, 0.08, 0.08), topTrailing: flat(0.08, 0.16, 0.4), bottomTrailing: flat(0.4, 0.2, 0.05), bottomLeading: flat(0.28, 0.1, 0.4) } },
    { base: flat(0.22, 0.05, 0.05), accent: flat(0.22, 0.2, 0.02), shadow: flat(0.07, 0.01, 0.01), corners: { topLeading: flat(0.2, 0, 0), topTrailing: flat(0.4, 0.08, 0), bottomTrailing: flat(0.1, 0.4, 0.34), bottomLeading: flat(0.4, 0.4, 0.4) } },
    { base: flat(0.03, 0.12, 0.2), accent: flat(0.05, 0.22, 0.12), shadow: flat(0, 0.03, 0.07), corners: { topLeading: flat(0.2, 0.2, 0.2), topTrailing: flat(0, 0.12, 0.4), bottomTrailing: flat(0, 0, 0), bottomLeading: flat(0.05, 0.4, 0.2) } },
];

/**
 * The wash as Chromium draws TVHeroAmbientRenderer's layers from CSS (silo-apple c5453eae): black, then each corner's colour at full strength
 * fading to nothing over 4/3 of the screen's width and height (TVBackdropCornerWash.reach), bottom-trailing first and top-leading last,
 * against the bitmap, compared pixel by pixel in the page.
 */
async function washDifference(tab: Page, index: number | undefined): Promise<{ max: number; mean: number; over2: number; bias: number }> {
    const shoot = async (): Promise<string> => (await tab.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } })).toString("base64");
    await tab.evaluate(([index, tints]) => {
        const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
        const chosen = index === undefined ? undefined : tints[index];
        const css = document.createElement("div");
        css.id = "css";
        // CSS lists the topmost layer first.
        const corner = (rgb: { r: number; g: number; b: number }, at: string): string => `radial-gradient(2560px 1440px at ${at}, ${fixture.cssColor(rgb, 1)}, ${fixture.cssColor(rgb, 0)})`;
        const layers = chosen === undefined ? [] : [corner(chosen.corners.topLeading, "0% 0%"), corner(chosen.corners.topTrailing, "100% 0%"), corner(chosen.corners.bottomLeading, "0% 100%"), corner(chosen.corners.bottomTrailing, "100% 100%")];
        css.style.cssText = `position:fixed;left:0;top:0;width:1920px;height:1080px;background:${[...layers, "#000"].join(", ")}`;
        document.body.replaceChildren(css);
    }, [index, TINTS] as const);
    const css = await shoot();
    await tab.evaluate(([index, tints]) => {
        const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
        const chosen = index === undefined ? undefined : tints[index];
        const wash = new fixture.HeroWash({ now: () => Date.now(), schedule: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); } });
        wash.element.style.cssText = "position:fixed;left:0;top:0;width:1920px;height:1080px";
        wash.show(chosen, false);
        document.body.replaceChildren(wash.element);
    }, [index, TINTS] as const);
    const bitmap = await shoot();
    return tab.evaluate(async ([a, b]) => {
        const read = async (data: string): Promise<Uint8ClampedArray> => {
            const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d");
            if (context === null) throw new Error("no canvas");
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, canvas.width, canvas.height).data;
        };
        const [first, second] = [await read(a), await read(b)];
        let max = 0, total = 0, over2 = 0, signed = 0;
        for (let i = 0; i < first.length; i += 4) for (let channel = 0; channel < 3; channel++) {
            const signedDifference = (second[i + channel] ?? 0) - (first[i + channel] ?? 0);
            const difference = Math.abs(signedDifference);
            max = Math.max(max, difference);
            if (difference > 2) over2++;
            total += difference;
            signed += signedDifference;
        }
        const values = first.length / 4 * 3;
        return { max, mean: total / values, over2: over2 / values, bias: signed / values };
    }, [css, bitmap] as const);
}

// Four stacked 8-bit layers on a bitmap at half the resolution, against Chromium's CSS gradients, differ by rounding: the bitmap runs about 0.4 to
// 0.5 of a level darker on average (the same in every part of the screen, so it is not geometry), within 4 levels, and under 0.4% of channel values
// are more than 2 apart. The bounds leave a little room; a wrong reach, order or centre is tens of levels, which the mutation checks in #669 showed.
const MAX_LEVELS = 4;
const MAX_BIAS = 0.6;
const MAX_MEAN = 0.75;
const MAX_OVER_2 = 0.005;
for (const index of [undefined, 0, 1, 2]) test(`the bitmap wash draws the four corner glows' pixels (${index === undefined ? "no tint" : `tint ${index}`})`, async () => {
    const tab = await page();
    try {
        const difference = await washDifference(tab, index);
        assert.ok(difference.max <= MAX_LEVELS && difference.over2 < MAX_OVER_2 && difference.mean < MAX_MEAN && Math.abs(difference.bias) <= MAX_BIAS, `largest channel difference ${difference.max}, over 2 ${difference.over2}, mean ${difference.mean.toFixed(3)}, bias ${difference.bias.toFixed(3)}`);
    } finally { await tab.context().close(); }
});

/**
 * Right to left (Codex P2 on #675). TVHeroAmbientWash draws the wash as a bitmap with `Image(decorative:)` at the corners' unit-square centres, and
 * neither the bitmap nor those numbers mirror: rendering that image under `\.layoutDirection = .rightToLeft` on macOS leaves its physical left
 * on the left (the SwiftUI `EllipticalGradient` beneath it does mirror, but the opaque bitmap covers it). So in Arabic the top-leading corner and
 * its 0.2 cap stay at the physical top-left, while the art and the marquee move right; this pins that, so a later change cannot mirror the wash
 * by accident. It is a reading of Apple's source and a macOS render, not an Apple TV capture.
 */
test("the wash keeps its physical corners in a right-to-left page, as Apple's bitmap does", async () => {
    const tab = await page();
    try {
        const shoot = async (direction: "ltr" | "rtl"): Promise<readonly number[]> => {
            await tab.evaluate(([direction, tints]) => {
                document.documentElement.dir = direction;
                const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
                const wash = new fixture.HeroWash({ now: () => 0, schedule: () => () => undefined });
                wash.element.style.cssText = "position:fixed;left:0;top:0;width:1920px;height:1080px";
                wash.show(tints[0], false);
                document.body.replaceChildren(wash.element);
            }, [direction, TINTS] as const);
            const png = (await tab.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } })).toString("base64");
            // The top-left and top-right corners, and the screen's middle, as RGB triples.
            return tab.evaluate(async data => {
                const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
                const canvas = document.createElement("canvas");
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext("2d");
                if (context === null) throw new Error("no canvas");
                context.drawImage(image, 0, 0);
                return [[2, 2], [1917, 2], [960, 540]].flatMap(([x, y]) => Array.from(context.getImageData(x ?? 0, y ?? 0, 1, 1).data).slice(0, 3));
            }, png);
        };
        const [left, right] = [await shoot("ltr"), await shoot("rtl")];
        assert.deepEqual(right, left, "the same pixels in a right-to-left page");
        assert.notDeepEqual(left.slice(0, 3), left.slice(3, 6), "the two top corners carry different colours, so the check can tell them apart");
        // The top-leading corner is the darkest (value 0.2) and sits at the physical left.
        assert.ok(Math.max(...left.slice(0, 3)) < Math.max(...left.slice(3, 6)), "the darker top-leading colour is at the physical left");
    } finally { await tab.context().close(); }
});

test("a new wash fades in over the old one, which stays until it is opaque", async () => {
    const tab = await page();
    try {
        const layers = await tab.evaluate(async ([tints]) => {
            const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
            let release: (() => void) | undefined;
            const delays: number[] = [];
            const wash = new fixture.HeroWash({ now: () => 0, schedule: (run, ms) => { delays.push(ms); release = run; return () => { release = undefined; }; } });
            document.body.appendChild(wash.element);
            const count = (): number => wash.element.querySelectorAll("canvas").length;
            wash.show(tints[0], false);
            const first = count();
            wash.show(tints[1], true);
            const fading = count();
            const entering = wash.element.lastElementChild?.classList.contains("skyline-wash-enter") === true;
            release?.();
            const settled = count();
            wash.show(tints[2], false);
            return { first, fading, entering, settled, snapped: count(), delays };
        }, [TINTS] as const);
        // The blend runs 0.7 s (marqueeWashCrossfadeDuration, not the art's 0.24 s); the old bitmap goes once the new one is at 0.98 opacity, at 630 ms,
        // because two full-screen bitmaps cost the TV frames for as long as both are up (#674).
        assert.deepEqual(layers, { first: 1, fading: 2, entering: true, settled: 1, snapped: 1, delays: [630] });
    } finally { await tab.context().close(); }
});

test("a swap mid-fade bakes the blend under way into the bitmap below, so the colours carry on without a jump", async () => {
    const tab = await page();
    try {
        // The fade follows CSS ease-in-out: 0.5 of the way at 350 ms and 0.8708 at 525 ms.
        for (const [elapsed, alpha] of [[350, 0.5], [525, 0.8708]] as const) {
            const result = await tab.evaluate(([tints, elapsed]) => {
                const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
                let time = 0;
                const wash = new fixture.HeroWash({ now: () => time, schedule: () => () => undefined });
                document.body.replaceChildren(wash.element);
                const canvases = (): HTMLCanvasElement[] => Array.from(wash.element.querySelectorAll("canvas"));
                // The middle and the two corners where the tints differ most, as RGB triples.
                const centre = (canvas: HTMLCanvasElement | undefined): number[] => [[480, 270], [40, 40], [920, 500]].flatMap(([x, y]) => Array.from(canvas?.getContext("2d")?.getImageData(x ?? 0, y ?? 0, 1, 1).data ?? []).slice(0, 3));
                wash.show(tints[0], false);
                const under = centre(canvases()[0]);
                wash.show(tints[1], true);
                const entering = centre(canvases()[1]);
                time = elapsed;
                wash.show(tints[2], true);
                return { count: canvases().length, baked: centre(canvases()[0]), under, entering };
            }, [TINTS, elapsed] as const);
            assert.equal(result.count, 2, "the blend is baked in, so the new bitmap fades over one bitmap, not two");
            for (const channel of Array.from({ length: 9 }, (_, index) => index)) {
                const expected = (1 - alpha) * (result.under[channel] ?? 0) + alpha * (result.entering[channel] ?? 0);
                assert.ok(Math.abs((result.baked[channel] ?? 0) - expected) <= 2, `after ${elapsed} ms value ${channel}: ${result.baked[channel]} against ${expected.toFixed(1)}`);
            }
        }
    } finally { await tab.context().close(); }
});

test("a steady roll never keeps more than two bitmaps: the one fading in and the one under it", async () => {
    const tab = await page();
    try {
        const peak = await tab.evaluate(([tints]) => {
            const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
            // The timer never fires: each swap comes sooner than the crossfade ends.
            const wash = new fixture.HeroWash({ now: () => 0, schedule: () => () => undefined });
            document.body.appendChild(wash.element);
            let most = 0;
            for (let swap = 0; swap < 12; swap++) { wash.show(tints[swap % 3], swap > 0); most = Math.max(most, wash.element.querySelectorAll("canvas").length); }
            return most;
        }, [TINTS] as const);
        assert.ok(peak <= 2, `${peak} bitmaps`);
    } finally { await tab.context().close(); }
});
