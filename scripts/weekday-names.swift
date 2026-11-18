// Writes src/i18n/weekdayNames.json: each shipped language's abbreviated weekday names, Monday first, as Apple prints them.
// Run on a Mac:
//
//   swift scripts/weekday-names.swift src/i18n/weekdayNames.json
//
// silo-apple Screens/Calendar/CalendarWeekStrip.swift draws each day of the week strip with
// `date.formatted(.dateTime.weekday(.abbreviated).locale(locale))`. That is the stand-alone abbreviation ("Mo" in German,
// "ثلاثاء" in Arabic), which the TV's Chromium has no way to ask for: `Intl` gives "Mo." and "الثلاثاء". The names are
// the same in every region, so they are read for the language alone.
import Foundation

let languages = ["en", "ar", "cs", "da", "de", "es", "fi", "fr", "hr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "ru", "sv", "tr", "uk", "zh-Hans", "zh-Hant"]
var calendar = Calendar(identifier: .gregorian)
calendar.timeZone = TimeZone(identifier: "UTC")!
// 5 January 2026 is a Monday.
let monday = DateComponents(year: 2026, month: 1, day: 5, hour: 12)

var names: [String: [String]] = [:]
for tag in languages {
    let locale = Locale(identifier: tag)
    names[tag] = (0..<7).map { offset in
        var day = monday
        day.day = 5 + offset
        let date = calendar.date(from: day)!
        return date.formatted(Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).weekday(.abbreviated).locale(locale))
    }
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
try encoder.encode(names).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("\(languages.count) languages")
