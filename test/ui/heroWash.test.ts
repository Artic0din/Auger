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

const TINTS = [
    { base: { r: 0.09, g: 0.1, b: 0.08 }, accent: { r: 0.39, g: 0.18, b: 0.11 }, shadow: { r: 0.02, g: 0.04, b: 0.07 } },
    { base: { r: 0.22, g: 0.05, b: 0.05 }, accent: { r: 0.22, g: 0.2, b: 0.02 }, shadow: { r: 0.07, g: 0.01, b: 0.01 } },
    { base: { r: 0.03, g: 0.12, b: 0.2 }, accent: { r: 0.05, g: 0.22, b: 0.12 }, shadow: { r: 0, g: 0.03, b: 0.07 } },
];

/** The wash as the current CSS gradients draw it and as the bitmap draws it, compared pixel by pixel in the page. */
async function washDifference(tab: Page, index: number | undefined): Promise<{ max: number; mean: number; over2: number }> {
    const shoot = async (): Promise<string> => (await tab.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } })).toString("base64");
    await tab.evaluate(([index, tints]) => {
        const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
        const chosen = index === undefined ? undefined : tints[index];
        const css = document.createElement("div");
        css.id = "css";
        css.style.cssText = `position:fixed;left:0;top:0;width:1920px;height:1080px;background:${fixture.washBackground(chosen)}`;
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
        let max = 0, total = 0, over2 = 0;
        for (let i = 0; i < first.length; i += 4) for (let channel = 0; channel < 3; channel++) {
            const difference = Math.abs((first[i + channel] ?? 0) - (second[i + channel] ?? 0));
            max = Math.max(max, difference);
            if (difference > 2) over2++;
            total += difference;
        }
        return { max, mean: total / (first.length / 4 * 3), over2: over2 / (first.length / 4 * 3) };
    }, [css, bitmap] as const);
}

// Measured on a 1920 x 1080 frame: about 98% of channel values are within 1, and fewer than 0.01% differ by 3, the most.
for (const index of [undefined, 0, 1, 2]) test(`the bitmap wash draws the CSS wash's pixels (${index === undefined ? "no tint" : `tint ${index}`})`, async () => {
    const tab = await page();
    try {
        const difference = await washDifference(tab, index);
        assert.ok(difference.max <= 3 && difference.over2 < 0.0001 && difference.mean < 0.6, `largest channel difference ${difference.max}, over 2 ${difference.over2}, mean ${difference.mean.toFixed(3)}`);
    } finally { await tab.context().close(); }
});

test("a new wash fades in over the old one, which stays until it is opaque", async () => {
    const tab = await page();
    try {
        const layers = await tab.evaluate(async ([tints]) => {
            const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
            let release: (() => void) | undefined;
            const wash = new fixture.HeroWash({ now: () => 0, schedule: run => { release = run; return () => { release = undefined; }; } });
            document.body.appendChild(wash.element);
            const count = (): number => wash.element.querySelectorAll("canvas").length;
            wash.show(tints[0], false);
            const first = count();
            wash.show(tints[1], true);
            const fading = count();
            const entering = wash.element.lastElementChild?.classList.contains("skyline-art-enter") === true;
            release?.();
            const settled = count();
            wash.show(tints[2], false);
            return { first, fading, entering, settled, snapped: count() };
        }, [TINTS] as const);
        assert.deepEqual(layers, { first: 1, fading: 2, entering: true, settled: 1, snapped: 1 });
    } finally { await tab.context().close(); }
});

test("a steady roll never keeps more than three bitmaps", async () => {
    const tab = await page();
    try {
        const peak = await tab.evaluate(([tints]) => {
            const fixture = Reflect.get(window, "HeroFixture") as typeof import("../../src/ui/heroBackdrop.ts");
            // The timer never fires: each swap comes sooner than the 240 ms crossfade.
            const wash = new fixture.HeroWash({ now: () => 0, schedule: () => () => undefined });
            document.body.appendChild(wash.element);
            let most = 0;
            for (let swap = 0; swap < 12; swap++) { wash.show(tints[swap % 3], swap > 0); most = Math.max(most, wash.element.querySelectorAll("canvas").length); }
            return most;
        }, [TINTS] as const);
        assert.ok(peak <= 3, `${peak} bitmaps`);
    } finally { await tab.context().close(); }
});
