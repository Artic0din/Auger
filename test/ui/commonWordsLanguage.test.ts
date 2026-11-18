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

test("a language file landing while Select is held on the startup failure's button waits for the release, and the press still runs Retry", async () => {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent("<!doctype html><main id='root'></main>");
        await page.addScriptTag({ content: bundle });
        await page.evaluate(() => {
            const api = window as unknown as ScreenApi & { retries?: number };
            api.retries = 0;
            api.setAppLanguage("de", api.SHIPPED_LANGUAGES, ["en-AU"]);
            api.startupFailure(document.getElementById("root") as HTMLElement, () => { api.retries = (api.retries ?? 0) + 1; });
        });
        const retry = page.locator("button");
        await retry.focus();
        await page.keyboard.down("Enter");
        await page.evaluate(files => { for (const [file, catalog] of Object.entries(files)) (window as unknown as ScreenApi).registerCatalog(file, catalog); }, catalogs);
        await page.evaluate(() => new Promise(resolve => window.setTimeout(resolve, 50)));
        assert.equal(await retry.innerText(), "Try again", "not redrawn while Select is held");
        assert.equal(await retry.getAttribute("data-pressed"), "", "the press is still drawn on the button it started on");
        await page.keyboard.up("Enter");
        assert.equal(await page.evaluate(() => (window as unknown as { retries: number }).retries), 1, "the press ran Retry once");
        await page.waitForFunction(text => document.querySelector("button")?.textContent === text, translate("common.tryAgain", undefined, "de"));
    } finally { await page.close(); }
});

test("an exit dialog open when the language file lands reads Cancel from it in place, keeping focus and a held Select press", async () => {
    for (const language of ["de", "ar"]) {
        const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
        try {
            await page.setContent("<!doctype html><main id='root'></main>");
            await page.addScriptTag({ content: bundle });
            const exits = await page.evaluate(tag => {
                const api = window as unknown as ScreenApi & { mountExitDialog: (root: HTMLElement, exit: () => void, closed: () => void) => unknown; exits?: number };
                api.exits = 0;
                api.setAppLanguage(tag, api.SHIPPED_LANGUAGES, ["en-AU"]);
                api.mountExitDialog(document.getElementById("root") as HTMLElement, () => { api.exits = (api.exits ?? 0) + 1; }, () => undefined);
                return api.exits;
            }, language);
            assert.equal(exits, 0);
            const cancel = page.locator('[data-focus="cancel-exit"]');
            assert.equal(await cancel.innerText(), "Cancel", "English until the file lands");
            const mark = await cancel.evaluate(node => { node.setAttribute("data-same", "yes"); return document.activeElement === node; });
            assert.equal(mark, true, "Cancel has focus");
            await page.keyboard.down("Enter");
            await page.evaluate(([tag, file]) => (window as unknown as ScreenApi).registerCatalog(tag, file), [language, catalogs[language] ?? {}] as const);
            assert.equal(await cancel.innerText(), translate("common.cancel", undefined, language), language);
            assert.equal(await cancel.getAttribute("data-same"), "yes", "the same button, not a rebuilt one");
            assert.equal(await cancel.getAttribute("data-pressed"), "", "the held press stays on it");
            assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-focus")), "cancel-exit", "focus stays");
            await page.keyboard.up("Enter");
            await page.locator(".app-exit").waitFor({ state: "detached" });
            assert.equal(await page.evaluate(() => (window as unknown as { exits: number }).exits), 0, "the release ran Cancel, not Exit");
        } finally { await page.close(); }
    }
});

test("the playback-unavailable screen's Back reads the catalog in German and Arabic, and English is unchanged", async () => {
    assert.deepEqual(await screenText("unavailablePlayer", null), { title: "Playback unavailable", buttons: ["Back"] });
    for (const language of ["de", "ar"]) assert.deepEqual(await screenText("unavailablePlayer", language), { title: "Playback unavailable", buttons: [translate("common.back", undefined, language)] }, language);
});
