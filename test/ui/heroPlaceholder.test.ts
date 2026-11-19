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

const THUMBHASHES = [undefined, "1QcSHQRnh493V4dIh4eXh1h4kJUI", "3OcRJYB4d3h/iIeHeEh3eIhw+j3A"];
const FRAME = { width: 1228.8, height: 756 };

/**
 * What "the same pixels" means for this check, the same for every variant. Both paths are 8-bit approximations of one ramp, and they round
 * differently: the bitmap is a little darker in the fade zone (a mean shift of -0.2 to -0.4 of 255 on macOS, never more than 4), which is
 * not visible on a dark placeholder under the art. The share of values more than 2 apart is 0.05% to 0.08% on macOS and 0.14% on the Linux
 * CI runner, whose raster rounds the masks a little differently. A fade on the wrong side or a wrong ramp is off by tens of levels over most
 * of the frame (up to 149, 80% to 90% of values over 2, a mean of 15 to 40), so these bounds still fail it.
 */
const LARGEST_GAP = 4;
const SHARE_OVER_TWO = 0.003;
const MEAN_GAP = 0.7;
/** The signed mean must stay under one level: a real change in tone shifts every value in a region the same way. */
const MAX_BIAS = 1;

async function page(): Promise<Page> {
    const tab = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await tab.setContent("<html><body style='margin:0;background:rgb(18,40,66)'></body></html>");
    await tab.addScriptTag({ content: bundle });
    return tab;
}

/**
 * The hero frame's placeholder as the stylesheet drew it for every other surface: the #0E0F12 backing and the ThumbHash
 * each under the art's own fade (opaque from the text-side edge to 32%, then clear), against the bitmap that stands in for
 * the two on Home, one masked layer fewer per swap (#310). Returns the largest and mean channel difference.
 */
async function difference(tab: Page, thumbhash: string | undefined, rtl: boolean): Promise<{ max: number; mean: number; over2: number; bias: number }> {
    const shoot = async (): Promise<string> => (await tab.screenshot({ clip: { x: 0, y: 0, width: FRAME.width, height: FRAME.height } })).toString("base64");
    const ramp = `linear-gradient(to ${rtl ? "right" : "left"}, #000 0%, #000 32%, transparent 100%)`;
    await tab.evaluate(([thumbhash, ramp, frame]) => {
        const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
        const box = document.createElement("div");
        box.style.cssText = `position:fixed;left:0;top:0;width:${frame.width}px;height:${frame.height}px;overflow:hidden`;
        const layer = (node: HTMLElement): HTMLElement => { node.style.cssText += `;position:absolute;inset:0;width:100%;height:100%;mask-image:${ramp};-webkit-mask-image:${ramp}`; return node; };
        const backing = document.createElement("div");
        backing.style.background = "#0e0f12";
        box.appendChild(layer(backing));
        const preview = fixture.thumbhashCanvas(thumbhash, "preview");
        if (preview !== undefined) { preview.style.objectFit = "cover"; box.appendChild(layer(preview)); }
        document.body.replaceChildren(box);
    }, [thumbhash, ramp, FRAME] as const);
    const reference = await shoot();
    await tab.evaluate(([thumbhash, rtl, frame]) => {
        const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
        const box = document.createElement("div");
        box.style.cssText = `position:fixed;left:0;top:0;width:${frame.width}px;height:${frame.height}px;overflow:hidden`;
        const baked = fixture.heroPlaceholder(thumbhash, rtl);
        if (baked === undefined) throw new Error("no 2D canvas");
        box.appendChild(baked);
        document.body.replaceChildren(box);
    }, [thumbhash, rtl, FRAME] as const);
    const baked = await shoot();
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
        const samples = first.length / 4 * 3;
        for (let i = 0; i < first.length; i += 4) for (let channel = 0; channel < 3; channel++) {
            const raw = (second[i + channel] ?? 0) - (first[i + channel] ?? 0);
            signed += raw;
            const gap = Math.abs(raw);
            max = Math.max(max, gap);
            total += gap;
            if (gap > 2) over2++;
        }
        return { max, mean: total / samples, over2: over2 / samples, bias: signed / samples };
    }, [reference, baked] as const);
}

for (const rtl of [false, true]) for (const [index, thumbhash] of THUMBHASHES.entries()) test(`the placeholder bitmap draws the backing and ThumbHash as the two masked layers did (${rtl ? "right to left" : "left to right"}, ${thumbhash === undefined ? "no ThumbHash" : `ThumbHash ${index}`})`, async () => {
    const tab = await page();
    try {
        const gap = await difference(tab, thumbhash, rtl);
        assert.ok(
            gap.max <= LARGEST_GAP && gap.over2 < SHARE_OVER_TWO && gap.mean < MEAN_GAP && Math.abs(gap.bias) < MAX_BIAS,
            `largest channel difference ${gap.max}, over 2: ${gap.over2}, mean ${gap.mean.toFixed(3)}, bias ${gap.bias.toFixed(3)}`,
        );
    } finally { await tab.context().close(); }
});
