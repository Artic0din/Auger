// Writes test/native/fixtures/appleLanguageNames.json: how Apple names a language in each shipped language,
// from silo-apple (dce56e3c) Shared/LocaleFormat.swift `capitalizedName` and `languageName`, and
// Screens/Player/Subtitles/SubtitleDisplayOrder.swift `languageDisplayName`. Run on a Mac:
//
//   swift scripts/language-names.swift test/native/fixtures/appleLanguageNames.json
import Foundation

func formattingLocale(_ tag: String) -> Locale {
    let base = Locale(identifier: "en_AU")
    var components = Locale.Components(locale: base)
    let region = base.region
    components.languageComponents = Locale.Language.Components(identifier: tag)
    components.region = region
    if components.languageComponents.languageCode == .arabic, components.numberingSystem == nil { components.numberingSystem = Locale.NumberingSystem("arab") }
    return Locale(components: components)
}
func capitalizedName(_ name: String, locale: Locale) -> String {
    if locale.language.languageCode == .english { return name.capitalized }
    return name.prefix(1).capitalized(with: locale) + name.dropFirst()
}
/// SubtitleDisplayOrder.languageDisplayName: a language code (TrackLabels.languageName for a track's language).
func trackName(_ key: String, _ locale: Locale) -> String { locale.localizedString(forLanguageCode: key).map { capitalizedName($0, locale: locale) } ?? key.uppercased() }
/// LocaleFormat.languageName: a tag with its script or region (an original-language overlay).
func tagName(_ code: String, _ locale: Locale) -> String? {
    let identifier = code.replacingOccurrences(of: "_", with: "-")
    return (locale.localizedString(forIdentifier: identifier) ?? locale.localizedString(forLanguageCode: identifier)).map { capitalizedName($0, locale: locale) }
}

let languages = ["en", "ar", "cs", "da", "de", "es", "fi", "fr", "hr", "it", "ja", "ko", "nb", "nl", "pl", "pt-BR", "ru", "sv", "tr", "uk", "zh-Hans", "zh-Hant"]
let keys = ["pt", "de", "ja", "fr", "es", "it", "ko", "ru", "zh", "ar", "nl", "sv", "en", "tr", "pl", "uk"]
let tags = ["pt-BR", "zh-Hans", "zh-Hant", "en-GB"]
var out: [String: [String: [String: String]]] = [:]
for tag in languages {
    let locale = formattingLocale(tag)
    var track: [String: String] = [:], tagged: [String: String] = [:]
    for key in keys { track[key] = trackName(key, locale) }
    for code in keys + tags { if let name = tagName(code, locale) { tagged[code] = name } }
    out[tag] = ["track": track, "tag": tagged]
}
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
try encoder.encode(out).write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("\(languages.count) languages")
