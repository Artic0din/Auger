// The lookup a screen calls for its text: a catalog key, in the language the app shows.
// A key the shown language does not translate shows the source language's text.
import english from "./catalog/en.json" with { type: "json" };
import { formatMessage, type MessageArgs, type MessageNode, parseMessage } from "./icu.ts";
import { deviceLanguages, formattingLocale, SOURCE_LANGUAGE, shownLanguage } from "./language.ts";

export type MessageKey = keyof typeof english;
export type Catalog = Readonly<Record<string, string>>;
export type Catalogs = Readonly<Record<string, Catalog>> & { readonly [SOURCE_LANGUAGE]: Catalog };

/** Add a language here when its file lands in `catalog/`; the source language is always present. */
const CATALOGS: Catalogs = { [SOURCE_LANGUAGE]: english };

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
    return resolveMessage(CATALOGS, key, language, args);
}
