// The exit dialog's Cancel in German and Arabic (silo-apple `common.cancel`): the button reads the catalog while the keyless title and
// Exit stay English, and English is unchanged.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
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
        stdin: { contents: `import { mountExitDialog } from "./src/ui/exitDialog.ts"; import { startupFailure } from "./src/bootstrap.ts"; import { unavailablePlayer } from "./src/app.ts"; import { setAppLanguage, SHIPPED_LANGUAGES } from "./src/i18n/language.ts"; import { registerCatalog } from "./src/i18n/translate.ts"; Object.assign(window, { mountExitDialog, startupFailure, unavailablePlayer, setAppLanguage, SHIPPED_LANGUAGES, registerCatalog });`, resolveDir: fileURLToPath(new URL("../..", import.meta.url)), loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    bundle = built.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

const catalogs = Object.fromEntries(["de", "ar"].map(tag => [tag, JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>]));

async function exitButtons(language: string | null): Promise<{ title: string; buttons: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent("<!doctype html><main id='root'></main>");
        await page.addScriptTag({ content: bundle });
        return await page.evaluate(([tag, files]) => {
            const api = window as unknown as { mountExitDialog: (root: HTMLElement, exit: () => void, closed: () => void) => unknown; setAppLanguage: (tag: string | null, shipped: readonly string[], device: readonly string[]) => void; registerCatalog: (tag: string, catalog: Record<string, string>) => void; SHIPPED_LANGUAGES: readonly string[] };
            for (const [name, catalog] of Object.entries(files)) api.registerCatalog(name, catalog);
            api.setAppLanguage(tag, api.SHIPPED_LANGUAGES, ["en-AU"]);
            const root = document.getElementById("root") as HTMLElement;
            api.mountExitDialog(root, () => undefined, () => undefined);
            const dialog = document.querySelector(".app-exit");
            return { title: dialog?.querySelector("h1")?.textContent ?? "", buttons: [...(dialog?.querySelectorAll("button") ?? [])].map(button => button.textContent ?? "") };
        }, [language, catalogs] as const);
    } finally { await page.close(); }
}

test("the exit dialog's Cancel reads the catalog in German and Arabic, with the keyless title and Exit left English", async () => {
    for (const language of ["de", "ar"]) {
        const shown = await exitButtons(language);
        assert.deepEqual(shown, { title: "Exit Silo?", buttons: ["Exit", translate("common.cancel", undefined, language)] }, language);
    }
});

test("the exit dialog in English is the text it always was", async () => {
    assert.deepEqual(await exitButtons(null), { title: "Exit Silo?", buttons: ["Exit", "Cancel"] });
});

type ScreenApi = {
    startupFailure: (root: HTMLElement, retry: () => void) => { destroy(): void };
    unavailablePlayer: (root: HTMLElement, back: () => void) => { destroy(): void };
    setAppLanguage: (tag: string | null, shipped: readonly string[], device: readonly string[]) => void;
    registerCatalog: (tag: string, catalog: Record<string, string>) => void;
    SHIPPED_LANGUAGES: readonly string[];
};

/** A screen's heading and button text, drawn in `language` with its file registered first, or registered after the draw when `late`. */
async function screenText(screen: "startupFailure" | "unavailablePlayer", language: string | null, late = false): Promise<{ title: string; buttons: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent("<!doctype html><main id='root'></main>");
        await page.addScriptTag({ content: bundle });
        return await page.evaluate(async ([name, tag, files, afterDraw]) => {
            const api = window as unknown as ScreenApi;
            if (!afterDraw) for (const [file, catalog] of Object.entries(files)) api.registerCatalog(file, catalog);
            api.setAppLanguage(tag, api.SHIPPED_LANGUAGES, ["en-AU"]);
            const root = document.getElementById("root") as HTMLElement;
            api[name](root, () => undefined);
            if (afterDraw) {
                for (const [file, catalog] of Object.entries(files)) api.registerCatalog(file, catalog);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return { title: root.querySelector("h1")?.textContent ?? "", buttons: [...root.querySelectorAll("button")].map(button => button.textContent ?? "") };
        }, [screen, language, catalogs, late] as const);
    } finally { await page.close(); }
}

test("the startup failure screen's button reads the catalog in German and Arabic, with its title left English, and English is unchanged", async () => {
    assert.deepEqual(await screenText("startupFailure", null), { title: "Silo could not start", buttons: ["Try again"] });
    for (const language of ["de", "ar"]) assert.deepEqual(await screenText("startupFailure", language), { title: "Silo could not start", buttons: [translate("common.tryAgain", undefined, language)] }, language);
});

test("a language file that lands after the startup failure screen drew redraws its button", async () => {
    for (const language of ["de", "ar"]) assert.deepEqual(await screenText("startupFailure", language, true), { title: "Silo could not start", buttons: [translate("common.tryAgain", undefined, language)] }, language);
});

test("the playback-unavailable screen's Back reads the catalog in German and Arabic, and English is unchanged", async () => {
    assert.deepEqual(await screenText("unavailablePlayer", null), { title: "Playback unavailable", buttons: ["Back"] });
    for (const language of ["de", "ar"]) assert.deepEqual(await screenText("unavailablePlayer", language), { title: "Playback unavailable", buttons: [translate("common.back", undefined, language)] }, language);
});
