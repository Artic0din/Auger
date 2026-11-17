// Settings text on the resolver: Apple's catalog keys, shown in the chosen language, with English for what a
// language lacks (silo-apple Shared/AppLanguage.swift, tvOS/Screens/Settings/*).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import english from "../../src/i18n/catalog/en.json" with { type: "json" };
import { localizeNumerals, percentText } from "../../src/i18n/format.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { registerCatalog, translate, translateTv, type MessageKey } from "../../src/i18n/translate.ts";
import { usedKeys } from "../../scripts/sync-translations.ts";
import { autoBudgetText, connectionAgeText, connectionRateText, connectionSpeedText, learnedLimitText, tryAgainMessage } from "../../src/ui/connectionSpeed.ts";
import { pairedProfileDescription, pairedProfileLabel, profileSelectionCaption } from "../../src/ui/pairedProfile.ts";
import { bitrateLabel, bufferingQualityModes, bufferingQualityTitle, qualityFooter } from "../../src/ui/qualitySettings.ts";

const SOURCE = new URL("../../src/", import.meta.url).pathname;
const sources = readdirSync(SOURCE, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".ts")).map(name => readFileSync(join(SOURCE, name), "utf8"));
const catalogKeys = new Set(Object.keys(english));
const used = usedKeys(sources, catalogKeys);
/** A language's text as the packaged file hands it to the page (npm test builds dist/wgt first). */
function file(tag: string): Record<string, string> {
    const page: { siloCatalogs?: Record<string, Record<string, string>> } = {};
    runInNewContext(readFileSync(new URL(`../../dist/wgt/catalog/${tag}.js`, import.meta.url), "utf8"), page);
    const catalog = page.siloCatalogs === undefined ? undefined : (JSON.parse(JSON.stringify(page.siloCatalogs)) as Record<string, Record<string, string>>)[tag];
    if (catalog === undefined) throw new Error(`${tag} is not packaged`);
    return catalog;
}
for (const tag of SHIPPED_LANGUAGES.filter(language => language !== "en")) registerCatalog(tag, file(tag));
const NOW = Date.UTC(2026, 10, 17, 3, 0, 0);

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

test("every language holds every key the source names, and no key it does not", () => {
    assert.ok(used.size > 150, `${used.size} keys in use`);
    for (const tag of SHIPPED_LANGUAGES.filter(language => language !== "en")) {
        const keys = new Set(Object.keys(file(tag)));
        assert.deepEqual([...used].filter(key => !keys.has(key)), [], `${tag} lacks a key a screen shows`);
        assert.deepEqual([...keys].filter(key => !used.has(key)), [], `${tag} carries text no screen shows`);
    }
});

test("Settings text shows in the chosen language, and English for a key that language lacks", () => {
    assert.equal(translate("settings.title"), "Settings");
    assert.equal(inLanguage("de", () => translate("settings.title")), "Einstellungen");
    assert.equal(inLanguage("de", () => translate("settings.general")), "Allgemein");
    assert.equal(inLanguage("de", () => translate("settings.appLanguage.option.matchDevice")), "Gerätesprache verwenden");
    assert.equal(inLanguage("zh-Hans", () => translate("settings.playback")), file("zh-Hans")["settings.playback"]);
    // `player.hud.about` is in no Settings screen, so no language file holds it: English shows.
    assert.equal(file("de")["player.hud.about"], undefined);
    assert.equal(inLanguage("de", () => translate("player.hud.about")), english["player.hud.about"]);
});

test("Apple's text for 'this Apple TV' reads 'this TV' in every language", () => {
    // The keys whose English names Apple TV: each is read through translateTv, which this list pins.
    const appleTvKeys = [...used].filter(key => /Apple TV/i.test(english[key as MessageKey])).sort();
    assert.deepEqual(appleTvKeys, [
        "settings.blurb.generalAppleTv", "settings.blurb.playbackAppleTv", "settings.blurb.serverAppleTv", "settings.general.appleTvUserHeaderTv",
        "settings.general.pairingSharedAskEveryTime", "settings.general.pairingShared", "settings.general.themeMusicFooterTv", "settings.general.titleArtAllOffTv",
        "settings.general.titleArtAllOnTv", "settings.general.titleArtThisAppleTv", "settings.profileLaunch.automatic.detailAppleTv", "settings.profileSettings.resetFooterAppleTv",
        "settings.subtitles.onlyOnThisAppleTv", "settings.subtitles.resetMessageAppleTv", "settings.subtitles.scopeDeviceOnlyAppleTv",
    ].sort());
    for (const key of appleTvKeys) {
        const readThroughTranslateTv = sources.some(source => new RegExp(`translateTv\\([^;]*"${key.replace(/\./g, "\\.")}"`).test(source) || (source.includes("CATEGORY_BLURBS") && source.includes(`"${key}"`)));
        assert.ok(readThroughTranslateTv, `${key} is shown without translateTv`);
    }
    assert.equal(inLanguage(null, () => translateTv("settings.blurb.generalAppleTv")), "App-level options for this TV.");
    assert.equal(inLanguage(null, () => translateTv("settings.general.appleTvUserHeaderTv")), "TV USER");
    for (const tag of SHIPPED_LANGUAGES) {
        for (const key of appleTvKeys) assert.doesNotMatch(translateTv(key as MessageKey, undefined, tag), /apple tv/i, `${tag} ${key}`);
    }
});

test("rates keep Apple's English units and write the number in the language's digits", () => {
    assert.equal(connectionRateText(4500), "4.5 Mbps");
    assert.equal(inLanguage("de", () => connectionRateText(4500)), "4,5 Mbps");
    assert.equal(inLanguage("de", () => bitrateLabel(1999)), "2,0 Mbps");
    assert.equal(inLanguage("de", () => bitrateLabel(null)), "Kein Limit");
    assert.equal(inLanguage("ar", () => bitrateLabel(null)), "بلا حد");
    assert.equal(inLanguage("ar", () => connectionRateText(48000)), "٤٨ Mbps");
    assert.equal(localizeNumerals("1.5 Mbps", "de"), "1,5 Mbps");
    assert.equal(percentText(50, "en"), "50%");
    assert.equal(percentText(50, "de"), "50\u00a0%");
});

test("Playback and Connection text takes the language's plurals and wording", () => {
    assert.equal(inLanguage("de", () => connectionAgeText(NOW, NOW + 60_000)), "vor 1 Minute");
    assert.equal(inLanguage("de", () => connectionAgeText(NOW, NOW + 3 * 60_000)), "vor 3 Minuten");
    assert.equal(inLanguage("ru", () => connectionAgeText(NOW, NOW + 3 * 60_000)), "3 минуты назад");
    assert.equal(inLanguage("ru", () => connectionAgeText(NOW, NOW + 5 * 60_000)), "5 минут назад");
    assert.equal(inLanguage("de", () => tryAgainMessage(1)), "Versuche es in 1 Sekunde erneut");
    assert.equal(inLanguage("de", () => tryAgainMessage(12)), "Versuche es in 12 Sekunden erneut");
    assert.equal(inLanguage("de", () => autoBudgetText(35280)), translate("settings.connection.budget", { rate: "35 Mbps" }, "de"));
    assert.match(inLanguage("de", () => connectionSpeedText(4500, true, NOW, "wifi", NOW)), /^.*4,5 Mbps.*Wi-Fi/);
    assert.match(inLanguage("de", () => learnedLimitText({ kbps: 44000, observedAt: Date.parse("2026-10-17T05:00:00Z") } as Parameters<typeof learnedLimitText>[0], "de", "UTC")), /17\. Okt\. auf 44 Mbps/);
    assert.equal(inLanguage("de", () => qualityFooter("auto", null)), file("de")["settings.quality.footerOriginal"]);
    assert.equal(inLanguage("de", () => qualityFooter("2160p", null)), "Spielt die Originaldatei bis 4K ab. Größere Dateien werden konvertiert.");
    assert.deepEqual(inLanguage("de", () => bufferingQualityModes().map(([, label]) => label)), ["never", "ask", "always"].map(mode => file("de")[`settings.bufferingQuality.${mode}`]));
    assert.equal(inLanguage("de", () => bufferingQualityTitle()), file("de")["settings.bufferingQuality.title"]);
});

test("the profile pairing and launch copy read in the chosen language", () => {
    assert.equal(inLanguage("de", () => pairedProfileLabel(undefined, "p", "Laura")), file("de")["settings.general.notPaired"]);
    assert.equal(inLanguage("de", () => profileSelectionCaption("askEveryLaunch")), file("de")["settings.profileLaunch.askEveryLaunch.detail"]);
    assert.doesNotMatch(inLanguage("de", () => pairedProfileDescription(true)), /apple tv/i);
    assert.notEqual(inLanguage("de", () => pairedProfileDescription(true)), pairedProfileDescription(true));
});
