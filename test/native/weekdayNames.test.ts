// The week strip's abbreviated weekday, as Apple prints it: the stand-alone name Foundation's
// `.dateTime.weekday(.abbreviated)` gives ("Mo" in German, "ثلاثاء" in Arabic), not Chromium's "Mo." and "الثلاثاء".
// silo-apple Screens/Calendar/CalendarWeekStrip.swift; the table is scripts/weekday-names.swift's output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIPPED_LANGUAGES } from "../../src/i18n/language.ts";
import { abbreviatedWeekday } from "../../src/i18n/weekdays.ts";

// 5 to 11 January 2026 run Monday to Sunday.
const week = Array.from({ length: 7 }, (_, offset) => new Date(2026, 0, 5 + offset, 12));
const names = (language: string): string[] => week.map(day => abbreviatedWeekday(day, language));

test("German and Arabic print Apple's stand-alone abbreviations", () => {
    assert.deepEqual(names("de"), ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]);
    assert.deepEqual(names("ar"), ["اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت", "أحد"]);
});

test("other languages keep their own punctuation and case, and English is unchanged", () => {
    assert.deepEqual(names("en"), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    assert.deepEqual(names("fr"), ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."]);
    assert.equal(abbreviatedWeekday(week[0] as Date, "ru"), "Пн");
    assert.equal(abbreviatedWeekday(week[6] as Date, "ja"), "日");
});

test("every shipped language has seven names, and an unknown one reads English", () => {
    for (const language of SHIPPED_LANGUAGES) assert.equal(new Set(names(language)).size, 7, language);
    assert.deepEqual(names("xx"), names("en"));
});
