import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "./support/tv.ts";

let browser: Browser;
let bundle = "";
before(async () => {
    browser = await launchBrowser();
    const fixture = await build({ entryPoints: [new URL("../../src/ui/heroBackdrop.ts", import.meta.url).pathname], bundle: true, format: "iife", globalName: "HomeBackdropFixture", target: "chrome108", write: false });
    bundle = fixture.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

interface Fixture { readonly page: Page; readonly url: string; readonly requests: () => number }

/** A page on one origin and a smooth 640 x 360 PNG, red to blue, on another origin that allows CORS. */
async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
    const maker = await browser.newPage();
    const base64 = await maker.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("no canvas");
        const fill = context.createLinearGradient(0, 0, 640, 0);
        fill.addColorStop(0, "rgb(200,30,30)");
        fill.addColorStop(1, "rgb(30,60,200)");
        context.fillStyle = fill;
        context.fillRect(0, 0, 640, 360);
        return canvas.toDataURL("image/png").split(",")[1] ?? "";
    });
    await maker.close();
    const png = Buffer.from(base64, "base64");
    let requests = 0;
    const art = createServer((_request, response) => { requests++; response.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" }); response.end(png); });
    const host = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<html><body></body></html>"); });
    const port = async (server: Server): Promise<number> => { server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address !== null && typeof address !== "string"); return address.port; };
    const artPort = await port(art);
    const hostPort = await port(host);
    const page = await browser.newPage();
    try {
        await page.goto(`http://127.0.0.1:${hostPort}/tv`);
        await page.addScriptTag({ content: bundle });
        await body({ page, url: `http://127.0.0.1:${artPort}/backdrop.png`, requests: () => requests });
    } finally {
        await page.context().close();
        art.closeAllConnections();
        host.closeAllConnections();
        await Promise.all([art, host].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
}

/** Counts what is drawn to a canvas, and what createImageBitmap is asked for. */
async function spy(page: Page): Promise<void> {
    await page.evaluate(() => {
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        const counts = { images: 0, bitmaps: 0, resizes: [] as string[] };
        Reflect.set(window, "spy", counts);
        CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: Parameters<typeof draw>) {
            if (args[0] instanceof HTMLImageElement) counts.images++;
            if (args[0] instanceof ImageBitmap) counts.bitmaps++;
            return draw.apply(this, args);
        } as typeof draw;
        const make = window.createImageBitmap.bind(window) as (...args: unknown[]) => Promise<ImageBitmap>;
        window.createImageBitmap = ((...args: unknown[]) => {
            const options = args.find(arg => typeof arg === "object" && arg !== null && "resizeWidth" in arg) as { resizeWidth: number; resizeHeight: number } | undefined;
            counts.resizes.push(options === undefined ? "none" : `${options.resizeWidth}x${options.resizeHeight}`);
            return make(...args);
        }) as typeof window.createImageBitmap;
    });
}

const counts = (page: Page): Promise<{ images: number; bitmaps: number; resizes: string[] }> => page.evaluate(() => Reflect.get(window, "spy") as { images: number; bitmaps: number; resizes: string[] });

/** Shows the backdrop with the given artwork reader (or none) and resolves with the sampled tints. */
async function sample(page: Page, url: string, reader: "fetch" | "refused" | "none"): Promise<{ base: number[]; accent: number[]; shadow: number[] }> {
    return page.evaluate(async ([url, reader]) => {
        const fixture = Reflect.get(window, "HomeBackdropFixture") as typeof import("../../src/ui/heroBackdrop.ts");
        fixture.useArtworkBytes(reader === "fetch" ? (address, signal) => fetch(address, { mode: "cors", credentials: "omit", signal }).then(response => response.blob()) : reader === "refused" ? () => Promise.reject(new Error("refused")) : undefined);
        const cache = new Map<string, import("../../src/ui/heroBackdrop.ts").Tints>();
        document.body.appendChild(fixture.heroBackdrop(url, undefined, cache));
        const started = performance.now();
        while (cache.size === 0) {
            if (performance.now() - started > 5000) throw new Error("no tint was sampled");
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        const tints = cache.get(url);
        if (tints === undefined) throw new Error("no tint");
        const channels = (rgb: { r: number; g: number; b: number }): number[] => [rgb.r, rgb.g, rgb.b];
        return { base: channels(tints.base), accent: channels(tints.accent), shadow: channels(tints.shadow) };
    }, [url, reader] as const);
}

test("the tint is sampled from a 64 px bitmap decoded off the main thread, without drawing the shown image", async () => {
    await withFixture(async ({ page, url, requests }) => {
        await spy(page);
        await sample(page, url, "fetch");
        const seen = await counts(page);
        assert.equal(seen.images, 0, "the full-size shown image is never drawn to a canvas");
        assert.ok(seen.bitmaps >= 1, "the downscaled bitmap is");
        assert.deepEqual(seen.resizes, ["64x36"], "the bitmap is decoded at 64 x 36, Apple's 64 px sample");
        assert.ok(requests() >= 1);
    });
});

test("the bitmap tint matches the full-image tint to within 2 of 255 per channel", async () => {
    await withFixture(async ({ page, url }) => {
        const viaBitmap = await sample(page, url, "fetch");
        await page.evaluate(() => document.body.replaceChildren());
        const viaImage = await sample(page, `${url}?second`, "none");
        for (const key of ["base", "accent", "shadow"] as const) {
            viaBitmap[key].forEach((value, index) => assert.ok(Math.abs(value - (viaImage[key][index] ?? 0)) <= 2 / 255, `${key}[${index}] ${value} against ${viaImage[key][index]}`));
        }
    });
});

test("a refused artwork read falls back to sampling the shown image", async () => {
    await withFixture(async ({ page, url }) => {
        await spy(page);
        const tints = await sample(page, url, "refused");
        assert.ok(tints.base.some(value => value > 0), "a tint is still sampled");
        assert.equal((await counts(page)).bitmaps, 0);
    });
});

test("a runtime without resize support falls back to sampling the shown image", async () => {
    await withFixture(async ({ page, url }) => {
        // An older engine ignores the resize options and hands back the full-size bitmap.
        await page.evaluate(() => {
            const make = window.createImageBitmap.bind(window) as (...args: unknown[]) => Promise<ImageBitmap>;
            window.createImageBitmap = ((source: unknown) => make(source)) as typeof window.createImageBitmap;
        });
        await spy(page);
        const tints = await sample(page, url, "fetch");
        assert.ok(tints.base.some(value => value > 0));
        assert.ok((await counts(page)).images >= 1, "the shown image is sampled instead");
    });
});

test("a runtime without createImageBitmap falls back to sampling the shown image", async () => {
    await withFixture(async ({ page, url }) => {
        await page.evaluate(() => { Reflect.deleteProperty(window, "createImageBitmap"); });
        await spy(page).catch(() => undefined);
        const tints = await sample(page, url, "fetch");
        assert.ok(tints.base.some(value => value > 0));
    });
});
