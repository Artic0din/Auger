// A weekday's abbreviation as Apple prints it, from the table scripts/weekday-names.swift writes from Foundation.
import names from "./weekdayNames.json" with { type: "json" };
import { SOURCE_LANGUAGE, shownLanguage } from "./language.ts";

const TABLE: Readonly<Record<string, readonly string[]>> = names;

/**
 * `.dateTime.weekday(.abbreviated)`: the stand-alone name ("Mo" in German, "ثلاثاء" in Arabic), which `Intl` cannot ask for
 * ("Mo.", "الثلاثاء"). A language with no table reads English.
 */
export function abbreviatedWeekday(day: Date, language: string = shownLanguage()): string {
    const table = TABLE[language] ?? TABLE[SOURCE_LANGUAGE];
    // The table runs Monday first; getDay() starts on Sunday.
    return table?.[(day.getDay() + 6) % 7] ?? "";
}
