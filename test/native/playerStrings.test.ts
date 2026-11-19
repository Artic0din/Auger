// The player's text on the catalog (silo-apple tvOS Screens/Player: TVPlayerInfoHUD.swift, TVPlayerTransportCluster.swift,
// TVIntroSkipPill.swift, PlayerTrack.swift, BufferingQualityController, upNext.* keys): English is what the screens showed before,
// German and Arabic read from Apple's keys, and a track's server-written name is never translated.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { translate, type MessageKey } from "../../src/i18n/translate.ts";
import { COPY } from "../../src/player/bufferingQuality.ts";
import { heading } from "../../src/player/headings.ts";
import { aspectLabel, statLabel } from "../../src/player/playerHUD.ts";
import { appearanceSummary, choiceLabel, choiceOptions, FONT_COLORS, opacityOptions, POSITIONS } from "../../src/player/subtitleAppearance.ts";
import { appearanceDetail } from "../../src/player/subtitleMenu.ts";
import { audioLayout, audioRow, subtitlePillSummary, subtitleRow } from "../../src/player/trackLabels.ts";
import { DEFAULT_APPEARANCE } from "../../src/contracts/v2/subtitles.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

/** Each key's English is the text the player drew before it read from the catalog. */
const ENGLISH: readonly (readonly [MessageKey, string])[] = [
    ["common.loading", "Loading"], ["player.controls.scrubber", "Scrubber"], ["player.audio.options", "Info and options"], ["player.audio.close", "Close player"],
    ["player.controls.showUpNext", "Show Up Next"], ["player.audio.play", "Play"], ["player.audio.pause", "Pause"],
    ["options.tabInfo", "Info"], ["options.tabStats", "Stats"], ["options.tabVideo", "Video"], ["options.tabAudio", "Audio"], ["options.tabSubtitles", "Subtitles"], ["options.tabChapters", "Chapters"],
    ["player.hud.audio", "Audio"], ["player.hud.subtitles", "Subtitles"], ["player.hud.chapter", "Chapter"], ["player.tracks.subtitlesOff", "Off"],
    ["upNext.keepWatching", "Keep Watching"], ["common.back", "Back"], ["player.goBack", "Go Back"], ["common.retry", "Retry"], ["common.cancel", "Cancel"],
    ["introSkip.pill.skip", "Skip Intro"], ["introSkip.pill.undo", "Watch Intro"], ["introSkip.pill.undoCaption", "Intro skipped"], ["player.introSkip.undoAccessibility", "Intro skipped. Watch Intro"],
    ["marker.skipRecap", "Skip Recap"], ["marker.skipCredits", "Skip Credits"],
    ["upNext.heading", "Up Next"], ["upNext.headingShuffle", "Up Next at Random"], ["upNext.headingEnded", "Playing Next"], ["upNext.headingFinished", "Finished"], ["upNext.headingNothing", "More To Watch"],
    ["upNext.onDeck", "On Deck"], ["upNext.playNow", "Play Now"], ["upNext.finding", "Finding the next episode"], ["upNext.almostFinished", "Almost finished"], ["upNext.endOfPlayback", "End of playback"],
    ["upNext.lookupFailed", "Couldn't load the next episode. Pick something from On Deck, or go back."], ["upNext.noNext", "No next episode is available."],
    ["options.quality", "Quality"], ["player.hud.pickerPlaybackSpeed", "Playback Speed"], ["player.hud.aspect", "Aspect"], ["player.settings.speed", "Speed"], ["player.settings.subtitleDelay", "Subtitle delay"],
    ["options.autoplayNext", "Auto-play next"], ["options.on", "On"], ["options.off", "Off"], ["player.hud.qualitySwitching", "Switching..."],
    ["player.hud.delay", "Delay"], ["player.hud.subtitleAppearance", "Appearance"], ["options.searchSubtitles", "Search Subtitles…"], ["subtitleSearch.chooseAnother", "Choose another language"],
    ["player.settings.subtitleDelayTitle", "Subtitle Delay"], ["player.hud.pickerSubtitleSize", "Subtitle Size"], ["player.hud.pickerSubtitlePosition", "Subtitle Position"], ["player.hud.pickerSubtitleFont", "Subtitle Font"],
    ["player.hud.pickerTextColor", "Text Color"], ["player.subtitles.style.textOpacityLabel", "Text Opacity"], ["player.hud.subtitleOutline", "Outline"], ["player.hud.pickerOutlineColor", "Outline Color"],
    ["player.hud.pickerSubtitleStyle", "Subtitle Style"], ["player.hud.pickerBackgroundColor", "Background Color"], ["player.subtitles.style.backgroundOpacityLabel", "Background Opacity"],
    ["player.subtitles.style.backgroundStyle", "Style"], ["player.subtitles.style.size", "Size"], ["player.subtitles.style.position", "Position"], ["player.subtitles.style.font", "Font"],
    ["detail.trackUnsupported", "Unsupported format"], ["player.subtitles.dataLoadFailed", "Subtitle data couldn’t be loaded. Turn subtitles off and on to retry."],
    ["bufferingQuality.prompt.title", "Playback keeps buffering"], ["buffering.promptMessage", "Try a lower quality to keep watching"], ["bufferingQuality.prompt.lower", "Lower quality"], ["bufferingQuality.prompt.keep", "Keep quality"],
    ["buffering.undoCaption", "Quality lowered to stop buffering"], ["bufferingQuality.restore", "Restore quality"], ["bufferingQuality.lowered", "Quality lowered to stop buffering"], ["bufferingQuality.cantLower", "Can't lower quality for this video"],
    ["detail.trackForced", "Forced"], ["detail.trackSdh", "SDH"], ["detail.trackExternal", "External"], ["detail.trackDefault", "Default"], ["detail.mono", "Mono"], ["detail.stereo", "Stereo"],
];

test("every key the player reads says what the player said before in English", () => {
    for (const [key, english] of ENGLISH) assert.equal(translate(key, undefined, "en"), english, key);
    assert.equal(translate("player.skip.back", { seconds: 1 }, "en"), "Back 1 second");
    assert.equal(translate("player.skip.forward", { seconds: 10 }, "en"), "Forward 10 seconds");
    assert.equal(translate("detail.channels", { count: "7" }, "en"), "7ch");
    assert.equal(translate("detail.trackWithFlag", { name: "Portuguese", flag: "SDH" }, "en"), "Portuguese (SDH)");
    // Headings Apple draws with `.textCase(.uppercase)`.
    for (const [key, shown] of [["player.hud.tracks", "TRACKS"], ["player.hud.title", "TITLE"], ["player.hud.stream", "STREAM"], ["options.chapters", "CHAPTERS"], ["player.stats.title", "PLAYBACK STATS"], ["player.hud.playback", "PLAYBACK"], ["player.hud.sync", "SYNC"], ["player.hud.options", "OPTIONS"], ["player.tracks.timing", "TIMING"], ["player.hud.style", "STYLE"], ["player.hud.subtitleAppearance", "APPEARANCE"]] as const) {
        assert.equal(inLanguage(null, () => heading(key)), shown, key);
    }
});

test("the buffering pill's copy, the aspect and stats labels and the appearance names read in German", () => {
    inLanguage("de", () => {
        assert.equal(COPY.promptTitle, translate("bufferingQuality.prompt.title", undefined, "de"));
        assert.equal(COPY.cantLower, translate("bufferingQuality.cantLower", undefined, "de"));
        assert.notEqual(COPY.promptTitle, "Playback keeps buffering");
        assert.equal(aspectLabel("Fit"), translate("player.aspect.fit", undefined, "de"));
        assert.equal(statLabel("Delivery"), translate("player.stats.delivery", undefined, "de"));
        assert.equal(statLabel("Video codec"), "Video codec", "a stats row Apple has no key for keeps its English");
        assert.equal(choiceLabel(POSITIONS, "lower-third"), translate("player.subtitles.position.lowerThirdTitleCase", undefined, "de"));
        assert.equal(choiceLabel(POSITIONS, "unknown"), "unknown");
        assert.deepEqual(choiceOptions(FONT_COLORS).map(option => option.id).slice(0, 2), ["#ffffff", "#facc15"]);
        assert.equal(appearanceSummary(DEFAULT_APPEARANCE), [translate("player.subtitles.size.large", undefined, "de"), translate("player.subtitles.background.box", undefined, "de"), translate("player.subtitles.position.bottom", undefined, "de")].join(" · "));
        assert.equal(appearanceDetail({ ...DEFAULT_APPEARANCE, textOutline: true }, "textOutline"), translate("options.on", undefined, "de"));
        assert.equal(opacityOptions(50, 0)[0]?.label, translate("options.off", undefined, "de"));
    });
});

test("a track's flags, layout and format read in German while its language is named and the server's title stays as sent", () => {
    inLanguage("de", () => {
        const subtitle = subtitleRow({ label: "Commentary", language: "pt-BR", codec: "srt", forced: true, hearingImpaired: true, source: "external" }, 0);
        assert.equal(subtitle.label, "Portugiesisch");
        assert.equal(subtitle.detail, ["Commentary", "SRT", translate("detail.trackForced", undefined, "de"), translate("detail.trackSdh", undefined, "de"), translate("detail.trackExternal", undefined, "de")].join(" · "));
        assert.equal(audioRow({ language: "en", codec: "eac3", channels: 2, title: undefined, isDefault: true }, 0).detail, ["EAC3", translate("detail.stereo", undefined, "de"), translate("detail.trackDefault", undefined, "de")].join(" · "));
        assert.equal(audioLayout(4), translate("detail.channels", { count: "4" }, "de"));
        assert.equal(subtitlePillSummary({ label: undefined, language: "pt-BR", codec: "srt", forced: true, hearingImpaired: false }, "?"), `${translate("detail.trackWithFlag", { name: "Portugiesisch", flag: translate("detail.trackForced", undefined, "de") }, "de")} · SRT`);
    });
});

test("in Arabic a track's channel count is written with the language's digits", () => {
    inLanguage("ar", () => assert.equal(audioLayout(4), translate("detail.channels", { count: "٤" }, "ar")));
});
