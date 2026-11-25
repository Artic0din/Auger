// Numbers and dates written the way the shown language writes them, following silo-apple Shared/LocaleFormat.swift.
import { deviceLanguages, formattingLocale, shownLanguage, SOURCE_LANGUAGE } from "./language.ts";

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

/** The TV's own clock setting: `tizen.time.getTimeFormat()` is "h:m:s ap" for 12 hours and "h:m:s" for 24 (no privilege needed). Undefined where the API is missing or fails. */
function tvHourCycle(): "h12" | "h23" | undefined {
    const time: unknown = Reflect.get(Object(Reflect.get(globalThis, "tizen") ?? {}), "time");
    const read: unknown = Reflect.get(Object(time ?? {}), "getTimeFormat");
    if (typeof read !== "function") return undefined;
    try {
        const format: unknown = read.call(time);
        return typeof format === "string" && format !== "" ? (format.includes("ap") ? "h12" : "h23") : undefined;
    } catch { return undefined; }
}

/**
 * Apple's `Date.FormatStyle(time: .shortened, locale: AppLanguage.formattingLocale)`: the shown language's words and digits,
 * and the device's clock setting for 12 or 24 hours. Chromium takes the cycle from the language alone, so the TV's
 * own setting is passed in, else the device region's ("8:00 AM" in German on an Australian or US TV, "08:00" on a German one).
 * English keeps "en" rather than the TV's region and 12 hours, and an explicit h12 keeps noon and midnight at 12 on Chromium 108.
 */
function clock(): { readonly locale: string; readonly options: Intl.DateTimeFormatOptions } {
    const english = shownLanguage() === SOURCE_LANGUAGE;
    const device = deviceLanguages()[0];
    const hourCycle = tvHourCycle() ?? (english ? "h12" : new Intl.DateTimeFormat(device, { hour: "numeric" }).resolvedOptions().hourCycle);
    // 12 hours drops the leading zero ("8:00 AM"); 24 hours takes the language's own short pattern ("08:00" in German).
    const twelve = hourCycle === "h11" || hourCycle === "h12";
    return { locale: english ? "en" : shownLocale(), options: { ...(twelve ? { hour: "numeric", minute: "2-digit" } : { timeStyle: "short" }), ...(hourCycle === undefined ? {} : { hourCycle }) } };
}

/** A wall-clock time as `clock` writes it, in `timeZone` when given (a time zone the engine cannot read throws a RangeError). */
export function shortTime(date: Date, timeZone?: string): string {
    const { locale, options } = clock();
    return new Intl.DateTimeFormat(locale, timeZone === undefined ? options : { ...options, timeZone }).format(date);
}
