// Writes the duration patterns src/i18n/durationPatterns.json holds, from Apple's own formatter, and the
// samples test/native/fixtures/appleDurations.json pins them to. Run on a Mac:
//
//   swift scripts/duration-patterns.swift src/i18n/durationPatterns.json test/native/fixtures/appleDurations.json
//
// `duration` is silo-apple Shared/LocaleFormat.swift `LocaleFormat.duration` (dce56e3c), which MediaTextFormatting.runtime
// calls with showZeroMinutes: true ("2h 8min" in German). Foundation's Duration.UnitsFormatStyle is the only source
// of those strings, so the patterns are read off its output and then checked against it for every hour and minute
// count of every shipped language: a pattern that does not reproduce Foundation stops the script.
import Foundation

func duration(minutes: Int, showZeroMinutes: Bool, locale: Locale) -> String {
    let minutes = min(max(0, minutes), Int.max / 60)
    let style: Duration.UnitsFormatStyle = minutes >= 60
        ? .units(allowed: [.hours, .minutes], width: .narrow, zeroValueUnits: showZeroMinutes ? .show(length: 1) : .hide)
        : .units(allowed: [.minutes], width: .narrow, zeroValueUnits: .show(length: 1))
    return Duration.seconds(minutes * 60).formatted(style.locale(locale))
}

/// AppLanguage.locale(for:base:): the language in the device's locale, with Arabic-Indic digits for Arabic.
func formattingLocale(_ tag: String) -> Locale {
    let base = Locale(identifier: "en_AU")
    var components = Locale.Components(locale: base)
    let region = base.region
    components.languageComponents = Locale.Language.Components(identifier: tag)
    components.region = region
    if components.languageComponents.languageCode == .arabic, components.numberingSystem == nil {
        components.numberingSystem = Locale.NumberingSystem("arab")
    }
    return Locale(components: components)
}
func integer(_ value: Int, _ locale: Locale) -> String { value.formatted(.number.grouping(.never).locale(locale)) }

let languages = ["en", "ar", "cs", "da", "de", "es", "fi", "fr", "hr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "ru", "sv", "tr", "uk", "zh-Hans", "zh-Hant"]
var patterns: [String: [String: String]] = [:]
var samples: [String: [String: String]] = [:]
var failures = 0

for tag in languages {
    // ASCII digits, so the number's place in each pattern can be found.
    let ascii = Locale(identifier: tag == "ar" ? "ar-u-nu-latn" : tag)
    let hourOnly = duration(minutes: 120, showZeroMinutes: false, locale: ascii)
    let minuteOnly = duration(minutes: 45, showZeroMinutes: true, locale: ascii)
    let both = duration(minutes: 128, showZeroMinutes: true, locale: ascii)
    guard let hourRange = hourOnly.range(of: "2"), let minuteRange = minuteOnly.range(of: "45") else { print("\(tag): no number in \(hourOnly) / \(minuteOnly)"); exit(1) }
    var hour = hourOnly; hour.replaceSubrange(hourRange, with: "{n}")
    var minute = minuteOnly; minute.replaceSubrange(minuteRange, with: "{n}")
    let hourText = hour.replacingOccurrences(of: "{n}", with: "2"), minuteText = minute.replacingOccurrences(of: "{n}", with: "8")
    guard both.hasPrefix(hourText), both.hasSuffix(minuteText) else { print("\(tag): \(both) is not \(hourText) + join + \(minuteText)"); exit(1) }
    let join = String(both.dropFirst(hourText.count).dropLast(minuteText.count))
    patterns[tag] = ["hour": hour, "minute": minute, "join": join]

    // The patterns, in the language's own digits, must reproduce Foundation for every runtime a title can have.
    let locale = formattingLocale(tag)
    func rebuilt(_ minutes: Int, _ showZero: Bool) -> String {
        let place = { (pattern: String, n: Int) in pattern.replacingOccurrences(of: "{n}", with: integer(n, locale)) }
        guard minutes >= 60 else { return place(minute, minutes) }
        let h = place(hour, minutes / 60)
        return showZero || minutes % 60 != 0 ? h + join + place(minute, minutes % 60) : h
    }
    for minutes in 0..<(60 * 30) { for showZero in [true, false] where rebuilt(minutes, showZero) != duration(minutes: minutes, showZeroMinutes: showZero, locale: locale) {
        failures += 1
        if failures < 10 { print("\(tag) \(minutes) \(showZero): \(rebuilt(minutes, showZero)) != \(duration(minutes: minutes, showZeroMinutes: showZero, locale: locale))") }
    } }
    samples[tag] = ["45": duration(minutes: 45, showZeroMinutes: true, locale: locale), "60": duration(minutes: 60, showZeroMinutes: true, locale: locale),
                    "128": duration(minutes: 128, showZeroMinutes: true, locale: locale), "120hidden": duration(minutes: 120, showZeroMinutes: false, locale: locale)]
}
if failures > 0 { print("\(failures) mismatches"); exit(1) }

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
try encoder.encode(patterns).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
try encoder.encode(samples).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print("\(languages.count) languages, patterns match Foundation for 0 to \(60 * 30 - 1) minutes")
