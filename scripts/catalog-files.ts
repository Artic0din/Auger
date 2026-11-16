// The packaged language files: every vendored language except English becomes `catalog/<tag>.js` in the .wgt,
// a classic script that hands its text to the page. A script loads from the package with no network, no
// server and no file-URL fetch rule to depend on, and the app's script policy (`script-src 'self'`) allows it.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_LANGUAGE = "en";
const VENDORED = new URL("../src/i18n/catalog/", import.meta.url);

/** `src/i18n/load.ts` reads `siloCatalogs[tag]` the moment the script has run. */
export function catalogScript(tag: string, catalog: Readonly<Record<string, string>>): string {
    return `(globalThis.siloCatalogs ??= {})[${JSON.stringify(tag)}] = ${JSON.stringify(catalog)};\n`;
}

/** The vendored languages other than English, sorted by tag: the order Apple lists them in. */
export function packagedLanguages(): string[] {
    return readdirSync(VENDORED).filter(name => name.endsWith(".json")).map(name => name.slice(0, -".json".length)).filter(tag => tag !== SOURCE_LANGUAGE).sort();
}

export function writeCatalogFiles(destination: string): void {
    mkdirSync(destination, { recursive: true });
    for (const tag of packagedLanguages()) {
        const catalog = JSON.parse(readFileSync(new URL(`${tag}.json`, VENDORED), "utf8")) as Record<string, string>;
        writeFileSync(join(destination, `${tag}.js`), catalogScript(tag, catalog));
    }
}
