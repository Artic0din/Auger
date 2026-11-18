// Text that has an Apple catalog key and was left out of the earlier screen groups (silo-apple d49d7bd): the password-reset line
// (ErrorState.swift), the Box Set page's Movies heading (BoxSetDetailView.swift), the Multi-Audio and subtitles overlay values
// (OverlayRegistry.swift). The saved-file audio layout stays English: it is also the key a per-value overlay image is looked up by.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import { compactAudioLayout } from "../../src/ui/homeEnrichment.ts";
import { passwordChangeRequiredMessage } from "../../src/ui/signInText.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
const source = (name: string): string => readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), "utf8");
const KEYS = ["profiles.error.passwordReset", "boxSets.movies", "overlays.multiAudio", "overlays.subtitles"] as const;

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

test("every key these screens read is read by the screen and is in the German and Arabic files", () => {
    const reads: Record<string, readonly string[]> = {
        "signInText.ts": ["profiles.error.passwordReset"], "boxSetView.ts": ["boxSets.movies"],
        "cardOverlays.ts": ["overlays.multiAudio", "overlays.subtitles"],
    };
    for (const [file, keys] of Object.entries(reads)) for (const key of keys) assert.ok(source(file).includes(`"${key}"`), `${file} reads ${key}`);
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        assert.deepEqual(KEYS.filter(key => !Object.hasOwn(catalog, key)), [], `${tag} lacks keys`);
    }
});

test("English reads exactly as before", () => {
    assert.equal(passwordChangeRequiredMessage(), "Your password needs to be reset. Use the Silo mobile app or website to set a new one, then come back.");
    assert.equal(english["boxSets.movies"], "Movies");
    assert.equal(english["overlays.multiAudio"], "Multi-Audio");
    assert.equal(english["overlays.subtitles"], "CC");
    assert.equal(compactAudioLayout({ index: 0, layout: undefined, channels: 1 } as never), "Mono");
    assert.equal(compactAudioLayout({ index: 0, layout: undefined, channels: 2 } as never), "Stereo");
    assert.equal(compactAudioLayout({ index: 0, layout: undefined, channels: 3 } as never), "3ch");
    assert.equal(compactAudioLayout({ index: 0, layout: "7.1 Atmos", channels: 8 } as never), "Atmos");
});

for (const tag of ["de", "ar"]) {
    test(`the password-reset line reads ${tag}, and the saved-file audio layout stays the English text its overlay image is keyed by`, () => inLanguage(tag, () => {
        assert.equal(passwordChangeRequiredMessage(), translate("profiles.error.passwordReset", undefined, tag));
        assert.notEqual(passwordChangeRequiredMessage(), "Your password needs to be reset. Use the Silo mobile app or website to set a new one, then come back.");
        const label = (channels: number, layout?: string): string | undefined => compactAudioLayout({ index: 0, layout, channels } as never);
        assert.deepEqual([label(1), label(2), label(3), label(2, "Stereo"), label(6)], ["Mono", "Stereo", "3ch", "Stereo", "5.1"]);
    }));
}
