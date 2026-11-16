// Tests that read a language other than English load its vendored file the way the app loads the packaged one.
import { readFileSync } from "node:fs";
import { SHIPPED_LANGUAGES } from "../../../src/i18n/language.ts";
import { registerCatalog } from "../../../src/i18n/translate.ts";

export function registerSourceCatalogs(): void {
    for (const tag of SHIPPED_LANGUAGES.filter(language => language !== "en")) {
        registerCatalog(tag, JSON.parse(readFileSync(new URL(`../../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>);
    }
}
