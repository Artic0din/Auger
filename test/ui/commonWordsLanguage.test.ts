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
        stdin: { contents: `import { mountExitDialog } from "./src/ui/exitDialog.ts"; import { setAppLanguage, SHIPPED_LANGUAGES } from "./src/i18n/language.ts"; import { registerCatalog } from "./src/i18n/translate.ts"; Object.assign(window, { mountExitDialog, setAppLanguage, SHIPPED_LANGUAGES, registerCatalog });`, resolveDir: fileURLToPath(new URL("../..", import.meta.url)), loader: "ts" },
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
