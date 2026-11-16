// The lookup a screen calls for its text: a catalog key, in the language the app shows.
// A key the shown language does not translate shows the source language's text.
import english from "./catalog/en.json" with { type: "json" };
import { formatMessage, type MessageArgs, type MessageNode, parseMessage } from "./icu.ts";
import { deviceLanguages, formattingLocale, SOURCE_LANGUAGE, shownLanguage } from "./language.ts";

export type MessageKey = keyof typeof english;
export type Catalog = Readonly<Record<string, string>>;
export type Catalogs = Readonly<Record<string, Catalog>> & { readonly [SOURCE_LANGUAGE]: Catalog };

/**
 * English is bundled; every other language is its own packaged file that `load.ts` registers when it lands, so
 * the one script carries no other language's text. A language that has not landed reads as English.
 */
const catalogs: { [tag: string]: Catalog; [SOURCE_LANGUAGE]: Catalog } = { [SOURCE_LANGUAGE]: english };
const listeners = new Set<(tag: string) => void>();

/** Adds a language's text and tells the screens that drew in English meanwhile to draw again. */
export function registerCatalog(tag: string, catalog: Catalog): void {
    if (tag === SOURCE_LANGUAGE) return;
    catalogs[tag] = catalog;
    for (const listener of listeners) listener(tag);
}

export function onCatalogLoaded(listener: (tag: string) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

export function isCatalogLoaded(tag: string): boolean {
    return Object.hasOwn(catalogs, tag);
}

/** The language `translate` reads text in right now: the shown language once its file has landed, else English. */
export function textLanguage(): string {
    const shown = shownLanguage();
    return isCatalogLoaded(shown) ? shown : SOURCE_LANGUAGE;
}

const parsed = new Map<string, readonly MessageNode[]>();

/** `deviceLocale` is for tests; the app reads the TV's. */
export function resolveMessage(catalogs: Catalogs, key: string, language: string, args: MessageArgs = {}, deviceLocale?: string): string {
    const own = catalogs[language]?.[key];
    const message = own ?? catalogs[SOURCE_LANGUAGE][key];
    if (message === undefined) throw new Error(`Unknown message key ${key}`);
    let nodes = parsed.get(message);
    if (nodes === undefined) parsed.set(message, nodes = parseMessage(message));
    // Text that fell back to the source language reads, and counts, by its rules.
    return formatMessage(nodes, args, formattingLocale(own === undefined ? SOURCE_LANGUAGE : language, deviceLocale ?? deviceLanguages()[0]));
}

export function translate(key: MessageKey, args?: MessageArgs, language: string = shownLanguage()): string {
    return resolveMessage(catalogs, key, language, args);
}

/**
 * Text Apple wrote for "this Apple TV", said of this TV. Settings reads "this TV" for it, and the same
 * substitution holds in every language, where the brand stays "Apple TV".
 */
export function translateTv(key: MessageKey, args?: MessageArgs, language: string = shownLanguage()): string {
    return translate(key, args, language).replace(/Apple TV/gi, "TV");
}
