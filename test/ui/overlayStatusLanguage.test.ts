// A card's show-status ribbon reads in the shown language (silo-apple Overlays/OverlayRegistry.swift `formatShowStatus`:
// `overlays.returning`, `.ended`, `.cancelled`, `.upcoming`), while its value key stays the English status so a per-value image
// still matches in every language. A status Apple does not recognise shows as the server sent it. English is unchanged.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { launchBrowser } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
let bundle: string;
before(async () => {
    browser = await launchBrowser();
    const built = await build({
        stdin: { contents: `import { overlayLayer, parseOverlayPrefs } from "./src/ui/cardOverlays.ts"; import { setAppLanguage, SHIPPED_LANGUAGES } from "./src/i18n/language.ts"; import { registerCatalog } from "./src/i18n/translate.ts"; Object.assign(window, { overlayLayer, parseOverlayPrefs, registerCatalog, setAppLanguage, SHIPPED_LANGUAGES });`, resolveDir: new URL("../..", import.meta.url).pathname, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    bundle = built.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

type Api = {
    overlayLayer: (card: unknown, prefs: unknown, variant: string, width: number, baseUrl: string) => HTMLElement | undefined;
    parseOverlayPrefs: (raw: unknown) => object;
    setAppLanguage: (tag: string | null, shipped: readonly string[], device: readonly string[]) => void;
    registerCatalog: (tag: string, catalog: Record<string, string>) => void;
    SHIPPED_LANGUAGES: readonly string[];
};
const catalogs = Object.fromEntries(["de", "ar"].map(tag => [tag, JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>]));

/** The ribbon's text and the value key its per-value image is looked up by, for a card with this server status. */
async function ribbon(language: string | null, showStatus: string, imageFor?: string): Promise<{ text: string | null; image: string | null }> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent(`<!doctype html><main><div id="art" style="position:relative;width:220px;height:330px"></div></main>`);
        await page.addScriptTag({ content: bundle });
        return await page.evaluate(([tag, status, valueKey, files]) => {
            const api = window as unknown as Api;
            // The packaged app loads the shown language's file; here it is registered directly.
            for (const [name, catalog] of Object.entries(files)) api.registerCatalog(name, catalog);
            api.setAppLanguage(tag, api.SHIPPED_LANGUAGES, ["en-AU"]);
            const ref = `${"a".repeat(64)}.webp`;
            const parsed = api.parseOverlayPrefs({ show_status: { enabled: true, position: "top-right", ...(valueKey === null ? {} : { valueImages: { [valueKey]: ref } }) } });
            const prefs = { ...parsed, images: new Map([[ref, { url: `/api/v2/overlay-images/${ref}`, aspect: 2.5 }]]) };
            const layer = api.overlayLayer({ id: "series:1", type: "series", title: "Show", showStatus: status }, prefs, "poster", 220, "https://silo.invalid");
            return { text: layer?.querySelector(".card-overlay")?.textContent ?? null, image: layer?.querySelector("img")?.getAttribute("src") ?? null };
        }, [language, showStatus, imageFor ?? null, catalogs] as const);
    } finally { await page.close(); }
}

test("the status ribbon reads in German and Arabic from Apple's keys", async () => {
    for (const [server, key] of [["returning series", "overlays.returning"], ["Continuing", "overlays.returning"], ["ended", "overlays.ended"], ["canceled", "overlays.cancelled"], ["planned", "overlays.upcoming"]] as const) {
        for (const language of ["de", "ar"]) assert.equal((await ribbon(language, server)).text, translate(key, undefined, language), `${server} in ${language}`);
    }
    assert.equal((await ribbon("de", "ended")).text, "Beendet");
});

test("English keeps its status words, and a status Apple does not recognise shows as sent", async () => {
    assert.equal((await ribbon(null, "returning series")).text, "Returning");
    assert.equal((await ribbon(null, "ended")).text, "Ended");
    assert.equal((await ribbon("de", "Pilot Season")).text, "Pilot Season");
});

test("a per-value image is found by the English status in every language", async () => {
    const found = await ribbon("de", "returning series", "Returning");
    assert.ok(found.image?.includes("/overlay-images/"), `the image listed for "Returning" is used in German: ${JSON.stringify(found)}`);
    assert.equal((await ribbon("de", "ended", "Returning")).image, null, "another status does not take it");
});
