// Numbers and dates written the way the shown language writes them, following silo-apple Shared/LocaleFormat.swift.
import { deviceLanguages, formattingLocale, shownLanguage } from "./language.ts";

let lastLocale: { readonly language: string; readonly device: string | undefined; readonly locale: string } | undefined;

/** The locale numbers and dates use: the shown language with the device's region (Apple's `AppLanguage.formattingLocale`). */
export function shownLocale(): string {
    const language = shownLanguage();
    const device = deviceLanguages()[0];
    if (lastLocale?.language !== language || lastLocale.device !== device) lastLocale = { language, device, locale: formattingLocale(language, device) };
    return lastLocale.locale;
}

// A formatter costs far more to build than to use, and Settings asks for dozens in one draw.
const plainFormats = new Map<string, Intl.NumberFormat>();
const percentFormats = new Map<string, Intl.NumberFormat>();
const groupedFormats = new Map<string, Intl.NumberFormat>();
function cached(formats: Map<string, Intl.NumberFormat>, locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
    let format = formats.get(locale);
    if (format === undefined) formats.set(locale, format = new Intl.NumberFormat(locale, options));
    return format;
}

/** Apple's `LocaleFormat.localized`: ASCII digits and the decimal point become the locale's, the rest stays. */
export function localizeNumerals(text: string, locale: string = shownLocale()): string {
    const plain = cached(plainFormats, locale, { useGrouping: false });
    const digits = Array.from({ length: 10 }, (_, digit) => plain.format(digit));
    const decimal = plain.formatToParts(1.1).find(part => part.type === "decimal")?.value ?? ".";
    return text.replace(/[0-9.]/g, character => character === "." ? decimal : digits[Number(character)] ?? character);
}

/** Apple's `LocaleFormat.percent`: a whole percent, no grouping ("50%", "50 %" in German). */
export function percentText(wholePercent: number, locale: string = shownLocale()): string {
    return cached(percentFormats, locale, { style: "percent", maximumFractionDigits: 0, useGrouping: false }).format(wholePercent / 100);
}

/** Apple's `LocaleFormat.groupedCount`: a count with the language's thousands separator and digits ("1,234", "1.234" in German). */
export function groupedCount(count: number, locale: string = shownLocale()): string {
    return cached(groupedFormats, locale, { useGrouping: true }).format(count);
}
