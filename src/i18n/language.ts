// The language the app shows, following silo-apple Shared/AppLanguage.swift: the profile's stored App
// Language, or the device's when it is Match Device or names a language this build does not ship.
// Apple keeps the shown tag in one place that every request and every string reads; so does this.

/** The language the catalog is written in, and the fallback for a key another language lacks. */
export const SOURCE_LANGUAGE = "en";
/**
 * The languages with a catalog file in `catalog/`, source language first. Apple's list is the bundle's
 * localizations, never a hand-kept list; a test holds this to the files.
 */
export const SHIPPED_LANGUAGES: readonly string[] = [SOURCE_LANGUAGE];

/** Apple's `AppLanguage.match` maps these to Norwegian Bokmål, the one Norwegian the catalog ships. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = { no: "nb", nn: "nb" };

/** The device's language list, most preferred first. Tizen's web runtime follows the TV's language setting. */
export function deviceLanguages(): readonly string[] {
    const languages = globalThis.navigator?.languages;
    return languages === undefined ? [] : [...languages];
}

/**
 * The shipped language a tag selects, matched as the system matches a device language list: `es-MX` is
 * `es`, `pt-PT` is `pt-BR`, `zh-CN` and `zh-SG` are `zh-Hans`, `zh-TW` and `zh-HK` are `zh-Hant`, `no`
 * and `nn` are `nb`. Undefined when nothing ships for it.
 */
export function matchShipped(tag: string, shipped: readonly string[] = SHIPPED_LANGUAGES): string | undefined {
    let wanted: Intl.Locale;
    try {
        wanted = new Intl.Locale(tag);
    } catch {
        return undefined;
    }
    const language = LANGUAGE_ALIASES[wanted.language] ?? wanted.language;
    const sameLanguage = shipped.filter(candidate => new Intl.Locale(candidate).language === language);
    if (sameLanguage.length <= 1) return sameLanguage[0];
    // Several scripts of one language (Chinese): the tag's own script, or the one its region implies.
    const script = wanted.maximize().script;
    return sameLanguage.find(candidate => new Intl.Locale(candidate).maximize().script === script) ?? sameLanguage[0];
}

/** The shipped language a preference list selects: the first match, else the source language. */
export function matchPreferences(preferences: readonly string[], shipped: readonly string[] = SHIPPED_LANGUAGES): string {
    for (const tag of preferences) {
        const match = matchShipped(tag, shipped);
        if (match !== undefined) return match;
    }
    return shipped[0] ?? SOURCE_LANGUAGE;
}

let shown: string | undefined;

/** The language on screen, and the one every request names. Before the profile's choice is read, the device's. */
export function shownLanguage(): string {
    return shown ?? matchPreferences(deviceLanguages());
}

/** Applies the profile's stored App Language; null is Match Device. */
export function setAppLanguage(tag: string | null, shipped: readonly string[] = SHIPPED_LANGUAGES, device: readonly string[] = deviceLanguages()): void {
    shown = (tag === null ? undefined : matchShipped(tag, shipped)) ?? matchPreferences(device, shipped);
}

/**
 * The locale numbers and plurals use: the device's locale with its language replaced, so region stays the
 * viewer's (Apple's `AppLanguage.locale(for:)`). Arabic writes Arabic-Indic digits unless the device chose
 * other digits.
 */
export function formattingLocale(tag: string, deviceLocale: string | undefined): string {
    try {
        const base = new Intl.Locale(tag);
        const device = deviceLocale === undefined ? undefined : new Intl.Locale(deviceLocale);
        const options: Intl.LocaleOptions = {};
        if (base.region === undefined && device?.region !== undefined) options.region = device.region;
        const numbering = device?.numberingSystem ?? (base.language === "ar" ? "arab" : undefined);
        if (numbering !== undefined) options.numberingSystem = numbering;
        return new Intl.Locale(base, options).toString();
    } catch {
        return tag;
    }
}
