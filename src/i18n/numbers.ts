// Counts written into text placeholders, following silo-apple Shared/LocaleFormat.swift.
import { deviceLanguages, formattingLocale, shownLanguage } from "./language.ts";

const formats = new Map<string, Intl.NumberFormat>();
function format(locale: string, grouped: boolean): Intl.NumberFormat {
    const id = `${grouped}:${locale}`;
    let found = formats.get(id);
    if (found === undefined) formats.set(id, found = new Intl.NumberFormat(locale, { useGrouping: grouped }));
    return found;
}

const shownLocale = (): string => formattingLocale(shownLanguage(), deviceLanguages()[0]);

/** `LocaleFormat.integer`: a count or number in the shown language's digits, never grouped. */
export function integerText(value: number, locale: string = shownLocale()): string {
    return format(locale, false).format(value);
}

/** `LocaleFormat.groupedCount`: a count that can run large, grouped as the shown language groups it. */
export function groupedCountText(value: number, locale: string = shownLocale()): string {
    return format(locale, true).format(value);
}
