// An air time follows the TV's own clock setting, as Apple's `Date.FormatStyle(time: .shortened)` follows the device's:
// `tizen.time.getTimeFormat()` returns "h:m:s ap" for a 12-hour clock and "h:m:s" for a 24-hour one. Without it the
// device region's hour cycle decides. Words and digits come from the shown language.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { CalendarEvent } from "../../src/contracts/v2/calendar.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { eventTime } from "../../src/ui/calendarState.ts";

// 21:00 UTC on 1 January is 8:00 on the Melbourne clock.
const finale = { airAt: "2026-01-01T21:00:00Z" } as CalendarEvent;
const evening = { airAt: "2026-01-02T09:30:00Z" } as CalendarEvent;
const ZONE = "Australia/Melbourne";

function onTv<T>(format: string | undefined, language: string | null, body: () => T): T {
    if (format !== undefined) Reflect.set(globalThis, "tizen", { time: { getTimeFormat: () => format } });
    setAppLanguage(language, SHIPPED_LANGUAGES, ["en-GB"]);
    try { return body(); } finally { setAppLanguage(null); }
}
/** The browser's language list, as a Samsung TV set to en-GB reports it. */
function browserIn<T>(tag: string, body: () => T): T {
    Object.defineProperty(globalThis.navigator, "languages", { value: [tag], configurable: true });
    try { return body(); } finally { Reflect.deleteProperty(globalThis.navigator, "languages"); }
}
afterEach(() => { Reflect.deleteProperty(globalThis, "tizen"); });

test("a 12-hour TV clock gives 12-hour times in every language, whatever the browser's region", () => {
    for (const [language, morning, night] of [["de", "8:00 AM", "8:30 PM"], ["ar", "٨:٠٠ ص", "٨:٣٠ م"], [null, "8:00 AM", "8:30 PM"]] as const) {
        assert.equal(onTv("h:m:s ap", language, () => eventTime(finale, ZONE)), morning, `${language} morning`);
        assert.equal(onTv("h:m:s ap", language, () => eventTime(evening, ZONE)), night, `${language} evening`);
    }
});

test("a 12-hour TV clock wins over a browser language whose region is 24-hour (en-GB)", () => {
    assert.equal(browserIn("en-GB", () => onTv(undefined, "de", () => eventTime(evening, ZONE))), "20:30", "without the TV clock, the region says 24 hours");
    assert.equal(browserIn("en-GB", () => onTv("h:m:s ap", "de", () => eventTime(evening, ZONE))), "8:30 PM");
    assert.equal(browserIn("en-GB", () => onTv("h:m:s ap", "ar", () => eventTime(finale, ZONE))), "٨:٠٠ ص");
    assert.equal(browserIn("en-GB", () => onTv("h:m:s ap", null, () => eventTime(finale, ZONE))), "8:00 AM");
});

test("a 24-hour TV clock gives 24-hour times in every language", () => {
    assert.equal(onTv("h:m:s", "de", () => eventTime(finale, ZONE)), "08:00");
    assert.equal(onTv("h:m:s", "de", () => eventTime(evening, ZONE)), "20:30");
    assert.equal(onTv("h:m:s", null, () => eventTime(evening, ZONE)), "20:30");
    assert.match(onTv("h:m:s", "ar", () => eventTime(evening, ZONE)) ?? "", /^٢٠:٣٠$/);
});

test("with no TV clock the device region decides: 12-hour (12 hours for a US or Australian TV), and English keeps 12 hours", () => {
    assert.equal(onTv(undefined, "de", () => eventTime(finale, ZONE)), "8:00 AM", "the test runtime's region is US");
    assert.equal(onTv(undefined, null, () => eventTime(finale, ZONE)), "8:00 AM");
});

test("a TV clock that throws or answers nothing useful falls back to the region", () => {
    Reflect.set(globalThis, "tizen", { time: { getTimeFormat: () => { throw new Error("unavailable"); } } });
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-GB"]);
    try { assert.equal(eventTime(finale, ZONE), "8:00 AM"); } finally { setAppLanguage(null); }
});
