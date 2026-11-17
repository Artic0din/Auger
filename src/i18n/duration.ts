// A length of time as Apple writes it: "2h 8m" in English, "2h 8min" in German, "2時間8分" in Japanese.
// silo-apple Shared/LocaleFormat.swift `LocaleFormat.duration` (dce56e3c), reached through
// MediaTextFormatting.runtime, prints these with Foundation's Duration.UnitsFormatStyle, which has no
// counterpart in the TV's Chromium. `durationPatterns.json` holds what it prints for each shipped language,
// written by scripts/duration-patterns.swift, which checks the patterns against Foundation for every minute
// count from 0 to 1799 in both modes.
import patterns from "./durationPatterns.json" with { type: "json" };
import { deviceLanguages, formattingLocale, SOURCE_LANGUAGE, shownLanguage } from "./language.ts";
import { integerText } from "./numbers.ts";

interface DurationPattern { readonly hour: string; readonly minute: string; readonly join: string }
const PATTERNS: Readonly<Record<string, DurationPattern>> = patterns;

/**
 * `minutes` as hours and minutes, or minutes alone under an hour. `showZeroMinutes` keeps a whole hour's
 * "0m" ("1h 0m"); without it the zero unit is dropped ("1h").
 */
export function durationText(minutes: number, showZeroMinutes: boolean, language: string = shownLanguage(), numberLocale: string = formattingLocale(language, deviceLanguages()[0])): string {
    const pattern = PATTERNS[language] ?? PATTERNS[SOURCE_LANGUAGE];
    if (pattern === undefined) throw new Error("No English duration pattern");
    const unit = (template: string, count: number): string => template.replace("{n}", integerText(count, numberLocale));
    if (minutes < 60) return unit(pattern.minute, minutes);
    const hours = unit(pattern.hour, Math.floor(minutes / 60));
    return showZeroMinutes || minutes % 60 !== 0 ? hours + pattern.join + unit(pattern.minute, minutes % 60) : hours;
}
