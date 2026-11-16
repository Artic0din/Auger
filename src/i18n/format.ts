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

/**
 * How Foundation's narrow duration style writes an hour and a minute in each shipped language, which is what
 * Apple's `LocaleFormat.duration` shows (silo-apple `Shared/LocaleFormat.swift`). `Intl` spells several of them
 * differently, so the units are kept here as Foundation writes them, with its no-break spaces. A language
 * missing here reads as English.
 */
const DURATION_UNITS: Readonly<Record<string, { readonly hour: string; readonly minute: string; readonly join: string }>> = {
    en: { hour: "h", minute: "m", join: " " },
    ar: { hour: "س", minute: "د", join: " " },
    cs: { hour: " h", minute: " m", join: " " },
    da: { hour: " t.", minute: " m.", join: " " },
    de: { hour: "h", minute: "min", join: " " },
    es: { hour: " h", minute: " min", join: " " },
    fi: { hour: " h", minute: " min", join: " " },
    fr: { hour: "h", minute: "min", join: " " },
    hr: { hour: " h", minute: " m", join: " " },
    it: { hour: " h", minute: " min", join: " " },
    ja: { hour: "時間", minute: "分", join: "" },
    ko: { hour: "시간", minute: "분", join: " " },
    nb: { hour: " t", minute: " min", join: ", " },
    nl: { hour: " u", minute: " m", join: ", " },
    pl: { hour: "h", minute: "min", join: " " },
    "pt-BR": { hour: "h", minute: "min", join: " " },
    ru: { hour: " ч", minute: " мин", join: " " },
    sv: { hour: " h", minute: " m", join: " " },
    tr: { hour: "sa", minute: "d", join: " " },
    uk: { hour: " г", minute: " хв", join: " " },
    "zh-Hans": { hour: "小时", minute: "分钟", join: "" },
    "zh-Hant": { hour: "時", minute: "分", join: "" },
};

/**
 * Apple's `LocaleFormat.duration(minutes:showZeroMinutes: true)`: "45m", "1h 0m", "2h 15m" in English and "2h 15min"
 * in German, in the shown language's digits. Nothing for a missing or non-positive length.
 */
export function durationText(minutes: number | undefined, language: string = shownLanguage(), locale: string = shownLocale()): string | undefined {
    if (minutes === undefined || minutes <= 0) return undefined;
    const units = DURATION_UNITS[language] ?? DURATION_UNITS["en"];
    if (units === undefined) return undefined;
    // Digits only: a unit such as Danish "m." holds a full stop that must stay one.
    const number = (value: number): string => localizeNumerals(String(value), locale);
    const hours = Math.floor(minutes / 60);
    return hours > 0 ? `${number(hours)}${units.hour}${units.join}${number(minutes % 60)}${units.minute}` : `${number(minutes)}${units.minute}`;
}
