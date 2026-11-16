// The lookup a screen calls for its text: a catalog key, in the language the app shows.
// A key the shown language does not translate shows the source language's text.
import english from "./catalog/en.json" with { type: "json" };
import ar from "./catalog/ar.json" with { type: "json" };
import cs from "./catalog/cs.json" with { type: "json" };
import da from "./catalog/da.json" with { type: "json" };
import de from "./catalog/de.json" with { type: "json" };
import es from "./catalog/es.json" with { type: "json" };
import fi from "./catalog/fi.json" with { type: "json" };
import fr from "./catalog/fr.json" with { type: "json" };
import hr from "./catalog/hr.json" with { type: "json" };
import it from "./catalog/it.json" with { type: "json" };
import ja from "./catalog/ja.json" with { type: "json" };
import ko from "./catalog/ko.json" with { type: "json" };
import nb from "./catalog/nb.json" with { type: "json" };
import nl from "./catalog/nl.json" with { type: "json" };
import pl from "./catalog/pl.json" with { type: "json" };
import ptBR from "./catalog/pt-BR.json" with { type: "json" };
import ru from "./catalog/ru.json" with { type: "json" };
import sv from "./catalog/sv.json" with { type: "json" };
import tr from "./catalog/tr.json" with { type: "json" };
import uk from "./catalog/uk.json" with { type: "json" };
import zhHans from "./catalog/zh-Hans.json" with { type: "json" };
import zhHant from "./catalog/zh-Hant.json" with { type: "json" };
import { formatMessage, type MessageArgs, type MessageNode, parseMessage } from "./icu.ts";
import { deviceLanguages, formattingLocale, SOURCE_LANGUAGE, shownLanguage } from "./language.ts";

export type MessageKey = keyof typeof english;
export type Catalog = Readonly<Record<string, string>>;
export type Catalogs = Readonly<Record<string, Catalog>> & { readonly [SOURCE_LANGUAGE]: Catalog };

/**
 * Add a language here when its file lands in `catalog/`; the source language is always present. A file other
 * than English holds only the keys `src` names, so the one script carries no text no screen shows.
 */
const CATALOGS: Catalogs = { [SOURCE_LANGUAGE]: english, ar, cs, da, de, es, fi, fr, hr, it, ja, ko, nb, nl, pl, "pt-BR": ptBR, ru, sv, tr, uk, "zh-Hans": zhHans, "zh-Hant": zhHant };

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

/**
 * Text the server wrote (a Home section title), as `AppLanguage.serverText` shows it: the language's own
 * translation of the catalog key the server sent, else the server's text. English always shows the server's
 * text as sent, and a key this language lacks never falls back to the English catalog.
 */
export function resolveServerText(catalogs: Catalogs, text: string, key: string | undefined, args: Readonly<Record<string, string>> | undefined, language: string): string {
    if (key === undefined || key === "" || language === SOURCE_LANGUAGE) return text;
    const template = catalogs[language]?.[key];
    if (template === undefined) return text;
    try {
        return formatMessage(parseMessage(template), args ?? {}, formattingLocale(language, deviceLanguages()[0]));
    } catch {
        // A placeholder the server did not fill: its own text reads whole.
        return text;
    }
}

export function serverText(text: string, key: string | undefined, args?: Readonly<Record<string, string>>, language: string = shownLanguage()): string {
    return resolveServerText(CATALOGS, text, key, args, language);
}

/**
 * Text Apple wrote for "this Apple TV", said of this TV. Settings reads "this TV" for it, and the same
 * substitution holds in every language, where the brand stays "Apple TV".
 */
export function translateTv(key: MessageKey, args?: MessageArgs, language: string = shownLanguage()): string {
    return translate(key, args, language).replace(/Apple TV/gi, "TV");
}
