// Brings the shown language's text into the page: its packaged `catalog/<tag>.js` (scripts/catalog-files.ts)
// is a classic script that sets `siloCatalogs[tag]`. Nothing is fetched from a server, and until the file
// lands the screens read English; `registerCatalog` then tells them to draw again.
import { SHIPPED_LANGUAGES, shownLanguage } from "./language.ts";
import { isCatalogLoaded, registerCatalog, type Catalog } from "./translate.ts";

type Handoff = { siloCatalogs?: Record<string, Catalog> };

const pending = new Map<string, Promise<boolean>>();

/** True once the language's text is registered. Resolves false, leaving English, when there is no page or the file does not load. */
export function loadCatalog(tag: string): Promise<boolean> {
    if (isCatalogLoaded(tag)) return Promise.resolve(true);
    // The tag names a packaged file, so only a shipped language is ever asked for.
    if (typeof document === "undefined" || !SHIPPED_LANGUAGES.includes(tag)) return Promise.resolve(false);
    const inFlight = pending.get(tag);
    if (inFlight !== undefined) return inFlight;
    const loading = new Promise<boolean>(resolve => {
        const script = document.createElement("script");
        const finish = (loaded: boolean): void => {
            script.remove();
            pending.delete(tag);
            resolve(loaded);
        };
        script.addEventListener("load", () => {
            const handoff = globalThis as Handoff;
            const catalog = handoff.siloCatalogs?.[tag];
            if (handoff.siloCatalogs !== undefined) delete handoff.siloCatalogs[tag];
            if (catalog === undefined) { finish(false); return; }
            registerCatalog(tag, catalog);
            finish(true);
        });
        script.addEventListener("error", () => finish(false));
        script.src = new URL(`catalog/${tag}.js`, document.baseURI).href;
        document.head.append(script);
    });
    pending.set(tag, loading);
    return loading;
}

/** Asks for the language the app shows now. Safe to call again: a loaded or loading language is not asked for twice. */
export function loadShownLanguage(): Promise<boolean> {
    return loadCatalog(shownLanguage());
}
