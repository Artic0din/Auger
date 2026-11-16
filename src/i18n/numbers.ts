// Counts written into text placeholders, following silo-apple Shared/LocaleFormat.swift.
import { deviceLanguages, formattingLocale, shownLanguage } from "./language.ts";

const formats = new Map<string, Intl.NumberFormat>();
function format(locale: string): Intl.NumberFormat {
    let found = formats.get(locale);
    if (found === undefined) formats.set(locale, found = new Intl.NumberFormat(locale, { useGrouping: false }));
    return found;
}

const shownLocale = (): string => formattingLocale(shownLanguage(), deviceLanguages()[0]);

/** `LocaleFormat.integer`: a count or number in the shown language's digits, never grouped. */
export function integerText(value: number, locale: string = shownLocale()): string {
    return format(locale).format(value);
}
