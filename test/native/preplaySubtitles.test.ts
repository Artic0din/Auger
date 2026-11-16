import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeCatalogSubtitles, decodeSubtitlePreferences, type CatalogSubtitleTrack, type SubtitlePreferences } from "../../src/contracts/v2/preplaySubtitles.ts";
import { initialSubtitle, startSubtitleTrackId } from "../../src/player/preplaySubtitles.ts";
import { subtitlePillSummary } from "../../src/player/trackLabels.ts";
import type { AudioTrackInfo, SubtitleTrack } from "../../src/contracts/v2/playback.ts";
import type { PlayableFile } from "../../src/contracts/v2/catalog.ts";
import { withStartAudioLanguage } from "../../src/ui/browseModel.ts";

const track: SubtitleTrack = { trackId: "file:42:subtitle:9", combinedIndex: 9, source: "embedded", delivery: "sidecar", label: "English", codec: "srt", language: "en", forced: false, hearingImpaired: false, url: undefined, streamIndex: undefined, containerTrackId: undefined, nativeSelectable: undefined, hlsRendition: undefined };
const forced: SubtitleTrack = { ...track, trackId: "file:42:subtitle:12", combinedIndex: 12, forced: true, label: "Forced" };
const prefs: SubtitlePreferences = { mode: "auto", language: "en", audioLanguage: "ja", showForced: true, signature: undefined };

test("subtitle Auto compares actual audio language and preserves explicit Off", () => {
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], prefs), track.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, audioLanguage: "eng" }), forced.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, audioLanguage: "en", showForced: false }), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, mode: "off", audioLanguage: "en" }), forced.trackId);
    assert.equal(initialSubtitle({ kind: "off" }, [forced, track], prefs), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, language: "" }), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, audioLanguage: undefined }), track.trackId);
});

test("Auto omits the pre-start subtitle when the playing audio language is unknown", () => {
    const rows = [{ selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "en", codec: "srt", label: "English", forced: false, hearingImpaired: false }];
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, { ...prefs, audioLanguage: undefined }), undefined);
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, { ...prefs, audioLanguage: "en" }), undefined);
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, { ...prefs, audioLanguage: "ja" }), "file:42:subtitle:0");
    assert.equal(startSubtitleTrackId("42", { kind: "off" }, rows, prefs), undefined);
});

test("a server-shaped catalog names the signs track by the combined ordinal and does not name a downloaded row", () => {
    // Catalog order is every embedded row, then every external row. Downloaded rows exist only on the plan.
    const catalog = decodeCatalogSubtitles({
        subtitle_tracks: [
            { index: 97, external: false, language: "eng", codec: "ass", title: "English (Signs)", forced: true },
            { index: 1, external: false, language: "jpn", codec: "pgs", title: "Japanese" },
            { index: 2, external: false, language: "fre", codec: "dvd_subtitle", title: "French" },
            { external: true, language: "eng", codec: "srt", title: "English", file_name: "English.srt" },
        ],
    }, "version");
    const signs = catalog[0];
    const external = catalog[3];
    assert.ok(signs && external);
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: signs }, catalog), "file:42:subtitle:1");
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: external }, catalog), "file:42:subtitle:0");
    const downloaded = { selectionIndex: 4, externalPath: "", source: "downloaded" as const, language: "spa", codec: "srt", label: "Spanish (downloaded)", forced: false, hearingImpaired: false };
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: downloaded }, [...catalog, downloaded]), undefined);
});

test("a pre-start pick skips an embedded row the server cannot deliver and keeps later ordinals", () => {
    const unroutable = { selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "en", codec: undefined, label: "English", forced: false, hearingImpaired: false };
    const routable = { ...unroutable, selectionIndex: 1, codec: "srt", label: "English SDH", hearingImpaired: true };
    for (const mode of ["auto", "always"] as const) {
        assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [unroutable], { ...prefs, mode }), undefined, mode);
        assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [unroutable, routable], { ...prefs, mode }), "file:42:subtitle:1", mode);
    }
    assert.equal(startSubtitleTrackId("42", { kind: "track", signature: unroutable }, [unroutable]), undefined);
    // After start the plan inventory goes through the same rule, so no track change names the row.
    const planRow: SubtitleTrack = { ...track, trackId: "file:42:subtitle:0", combinedIndex: 0, codec: undefined };
    assert.equal(initialSubtitle({ kind: "track", signature: { ...unroutable, codec: undefined } }, [planRow]), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [planRow], { ...prefs, mode: "always" }), undefined);
});

test("a saved downloaded subtitle names no catalog row before start", () => {
    const spanish = { selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "es", codec: "srt", label: "Spanish", forced: false, hearingImpaired: false };
    const downloaded = { ...spanish, source: "downloaded" as const, label: "Spanish (downloaded)" };
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [spanish], { ...prefs, mode: "always", language: "es", signature: downloaded }), undefined);
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [spanish], { ...prefs, mode: "always", language: "es" }), "file:42:subtitle:0");
    const forcedEnglish = { ...spanish, language: "en", forced: true, label: "English (Forced)" };
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, [forcedEnglish], { ...prefs, mode: "off", audioLanguage: "en", signature: downloaded }), "file:42:subtitle:0", "Off still names the forced track");
});

test("a Details audio pick decides which language Auto compares before start", () => {
    const audio = (language: string, isDefault: boolean): AudioTrackInfo => ({ isDefault, language, codec: "aac", channels: 2, title: undefined });
    const file = {
        fileId: "42", durationSeconds: 60, played: false, positionSeconds: undefined, lastFileId: undefined,
        effectiveAudioTrackIndex: 0, audio: [audio("en", true), audio("ja", false)],
        subtitles: [{ selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "en", codec: "srt", label: "English", forced: false, hearingImpaired: false }],
        effectiveSubtitle: { ...prefs, audioLanguage: undefined },
    } as unknown as PlayableFile;
    const request = { contentId: "movie:1", fileId: "42", audioTrackId: "file:42:audio:1" };
    const hinted = withStartAudioLanguage(request as never, file) as { subtitlePreferences?: SubtitlePreferences };
    assert.equal(hinted.subtitlePreferences?.audioLanguage, "ja");
    const defaulted = withStartAudioLanguage({ contentId: "movie:1", fileId: "42" } as never, file) as { subtitlePreferences?: SubtitlePreferences };
    assert.equal(defaulted.subtitlePreferences?.audioLanguage, "en");
});

test("subtitle identities come only from the actual inventory, with exact and regional preferences", () => {
    const british = { ...track, trackId: "file:73:subtitle:6", language: "en-GB" };
    assert.equal(initialSubtitle({ kind: "track", signature: british }, [british]), british.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [track, british], { ...prefs, language: "en-GB" }), british.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [track, british], { ...prefs, mode: "always", signature: british }), british.trackId);
    assert.throws(() => initialSubtitle({ kind: "track", signature: track }, []));
    assert.throws(() => initialSubtitle({ kind: "track", signature: track }, [track, { ...track, trackId: "file:42:subtitle:10" }]));
});

test("preplay subtitle decoders validate file identity and retain display metadata without inventing playback IDs", () => {
    const rows = decodeCatalogSubtitles({ subtitle_tracks: [{ index: 27, external: true, title: "English", language: "en", codec: "srt", forced: false }] }, "file");
    assert.equal("index" in (rows[0] ?? {}), false);
    assert.equal(rows[0]?.source, "external");
    assert.equal("trackId" in (rows[0] ?? {}), false);
    const body = { content_id: "movie:1", versions: [{ file_id: "42", audio_tracks: [{ default: true, language: "ja" }] }], effective_subtitle_mode: "always", effective_subtitle_language: "en", effective_show_forced_subtitles: false };
    assert.deepEqual(decodeSubtitlePreferences(body, "movie:1", "42", "file:42:audio:0"), { mode: "always", language: "en", audioLanguage: "ja", showForced: false, signature: undefined });
    assert.equal(decodeSubtitlePreferences({ ...body, effective_subtitle_track_signature: { language: "en", forced: false, hearing_impaired: false } }, "movie:1", "42", undefined).signature?.source, "unknown", "saved signatures can omit their source");
    for (const bad of [{ ...body, content_id: "other" }, { ...body, versions: [] }, { ...body, effective_subtitle_mode: "invalid" }, { ...body, effective_show_forced_subtitles: 1 }]) assert.throws(() => decodeSubtitlePreferences(bad, "movie:1", "42", undefined));
    assert.equal(decodeCatalogSubtitles({ subtitle_tracks: [{ language: "en" }] }, "file").length, 1, "zero stream indexes may be omitted");
    for (const value of [{ subtitle_tracks: {} }, { subtitle_tracks: [{ language: 1 }] }, { subtitle_tracks: [{ index: 0, external: "yes" }] }]) assert.throws(() => decodeCatalogSubtitles(value, "file"));
});

test("the automatic and initial pick never choose a track the plan flags unplayable", () => {
    const broken = { ...track, trackId: "file:42:subtitle:3", combinedIndex: 3, unplayable: true };
    const brokenForced = { ...forced, unplayable: true };
    assert.equal(initialSubtitle({ kind: "auto" }, [broken, track], prefs), track.trackId, "the preferred-language pick skips it");
    assert.equal(initialSubtitle({ kind: "auto" }, [broken], prefs), undefined, "nothing playable leaves subtitles off");
    assert.equal(initialSubtitle({ kind: "auto" }, [brokenForced, track], { ...prefs, audioLanguage: "en" }), undefined, "a forced pick skips it");
    assert.equal(initialSubtitle({ kind: "auto" }, [broken, track], { ...prefs, mode: "always", signature: broken }), track.trackId, "a saved signature never lands on it");
    assert.equal(initialSubtitle({ kind: "auto" }, [{ ...track, unplayable: false }], prefs), track.trackId, "an explicit false stays pickable");
    const french = { ...broken, language: "fr", label: "French" };
    assert.equal(initialSubtitle({ kind: "track", signature: french }, [french, track]), undefined, "a chosen unplayable track starts with subtitles off, as Apple does");
    assert.throws(() => initialSubtitle({ kind: "track", signature: french }, [track]), "a chosen track missing from the plan is still an error");
});

test("mode always with no subtitle language picks the best available track as Apple does, and an empty language still means none", () => {
    const sdh: SubtitleTrack = { ...track, trackId: "file:42:subtitle:10", combinedIndex: 10, hearingImpaired: true };
    const external: SubtitleTrack = { ...track, trackId: "file:42:subtitle:11", combinedIndex: 11, source: "external" };
    const always: SubtitlePreferences = { ...prefs, mode: "always", language: undefined, showForced: false };
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, sdh, external, track], always), track.trackId, "full dialogue first, embedded before external");
    assert.equal(initialSubtitle({ kind: "auto" }, [sdh, forced], always), sdh.trackId, "a forced track is the last resort");
    assert.equal(initialSubtitle({ kind: "auto" }, [track, forced], { ...always, showForced: true }), forced.trackId, "show forced puts the forced class first");
    assert.equal(initialSubtitle({ kind: "auto" }, [track, forced], { ...always, language: "" }), undefined);
    assert.equal(initialSubtitle({ kind: "auto" }, [], always), undefined);
});

test("mode always puts renderable tracks ahead of burn-in-only ones, as Apple's ranking does", () => {
    const bitmap: SubtitleTrack = { ...track, trackId: "file:42:subtitle:13", combinedIndex: 13, codec: "hdmv_pgs_subtitle", delivery: "burn_in_only" };
    const external: SubtitleTrack = { ...track, trackId: "file:42:subtitle:14", combinedIndex: 14, source: "external" };
    const always: SubtitlePreferences = { ...prefs, mode: "always", language: undefined, showForced: false };
    assert.equal(initialSubtitle({ kind: "auto" }, [bitmap, external], always), external.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [bitmap], always), bitmap.trackId, "burn-in still wins when nothing else is on offer");
});

test("Auto with no subtitle language leaves the plan's selection alone, and a saved pick still wins", () => {
    const quiet: SubtitlePreferences = { ...prefs, mode: "auto", language: undefined, showForced: false };
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], quiet, forced.trackId), forced.trackId, "the plan's own track stands");
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], quiet, undefined), undefined, "nothing selected stays nothing");
    const signature = { source: track.source, language: track.language, codec: track.codec, label: track.label, forced: false, hearingImpaired: false };
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...quiet, signature }, forced.trackId), track.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [forced, track], { ...prefs, language: "" }, forced.trackId), undefined, "an empty language is an explicit none");
});

test("mode always with no language treats a CC or SDH title as an accessibility track, as Apple's classes do", () => {
    const cc: SubtitleTrack = { ...track, trackId: "file:42:subtitle:15", combinedIndex: 15, label: "English (CC)" };
    const always: SubtitlePreferences = { ...prefs, mode: "always", language: undefined, showForced: false };
    assert.equal(initialSubtitle({ kind: "auto" }, [cc, track], always), track.trackId);
    assert.equal(initialSubtitle({ kind: "auto" }, [cc], always), cc.trackId, "an accessibility track still beats nothing");
});

const withoutDefault = ({ isDefault: _isDefault, ...track }: CatalogSubtitleTrack): CatalogSubtitleTrack => track;

/** Aladdin (2019) as the S95C and Apple TV list it on PR #525: the 24 rows visible in the captures, all embedded SubRip, Portuguese audio. */
const aladdin: CatalogSubtitleTrack[] = ([
    ["zh-HK", "Hong Kong"], ["zh-Hans", "Simplified"], ["zh-Hant", "Traditional"], ["cs", undefined], ["da", undefined], ["nl", undefined],
    ["fr-CA", "Canadian"], ["fr-FR", "European (SDH)", { hearingImpaired: true }], ["de", undefined], ["el", undefined], ["it", undefined], ["ja", undefined],
    ["ko", undefined], ["nb", undefined], ["pt-BR", "Brazilian"], ["pt-BR", "Brazilian (SDH)", { hearingImpaired: true }], ["pt-PT", "European"],
    ["pt-BR", "Brazilian (Forced)", { forced: true, isDefault: true }], ["pt-PT", "European (Forced)", { forced: true, isDefault: true }],
    ["es-419", "Latin American"], ["es-419", "Latin American (SDH)", { hearingImpaired: true }], ["es-ES", "European"], ["sv", undefined], ["tr", undefined],
] as const).map(([language, label, flags], index) => ({ selectionIndex: index + 3, externalPath: "", source: "embedded" as const, language, codec: "subrip", label, forced: false, hearingImpaired: false, ...flags }));
const aladdinDefaults: SubtitlePreferences = { mode: "auto", language: undefined, audioLanguage: "pt-BR", showForced: true, signature: undefined };

test("Auto with no subtitle language starts on the file's default track, else a forced one, as Apple's start request does (Aladdin)", () => {
    assert.equal(startSubtitleTrackId("7", { kind: "auto" }, aladdin, aladdinDefaults), "file:7:subtitle:17", "Portuguese Brazilian (Forced), the first default row");
    const europeanDefault = aladdin.map(track => track.label === "Brazilian (Forced)" ? withoutDefault(track) : track);
    assert.equal(startSubtitleTrackId("7", { kind: "auto" }, europeanDefault, aladdinDefaults), "file:7:subtitle:18", "the default flag decides, not the audio language");
    const noDefault = aladdin.map(withoutDefault);
    assert.equal(startSubtitleTrackId("7", { kind: "auto" }, noDefault, aladdinDefaults), "file:7:subtitle:17", "with no default row, the first forced one");
    const plain = noDefault.filter(track => !track.forced);
    assert.equal(startSubtitleTrackId("7", { kind: "auto" }, plain, aladdinDefaults), undefined, "nothing default or forced leaves subtitles off");
    const unroutable = aladdin.map(track => track.label === "Brazilian (Forced)" ? { ...track, codec: undefined } : track);
    assert.equal(startSubtitleTrackId("7", { kind: "auto" }, unroutable, aladdinDefaults), "file:7:subtitle:18", "a default row the server cannot deliver is skipped");
    const external = { ...aladdin[0]!, source: "external" as const, selectionIndex: undefined, externalPath: "Aladdin.en.srt", language: "en", label: "English", isDefault: true as const };
    assert.equal(startSubtitleTrackId("7", { kind: "auto" }, [...aladdin, external], aladdinDefaults), "file:7:subtitle:0", "externals come first in the combined order Apple scans");
});

test("an empty subtitle language still starts Aladdin with subtitles off", () => {
    assert.equal(startSubtitleTrackId("7", { kind: "auto" }, aladdin, { ...aladdinDefaults, language: "" }), undefined);
});

test("Auto with a subtitle language the file lacks starts on the first forced track when forced subtitles are on, else the file's default (Apple's last resolver branch)", () => {
    const signs: SubtitleTrack = { ...track, trackId: "file:42:subtitle:1", combinedIndex: 1, label: "Signs", forced: true };
    const secondForced: SubtitleTrack = { ...signs, trackId: "file:42:subtitle:2", combinedIndex: 2, language: "fr" };
    const german: SubtitleTrack = { ...track, trackId: "file:42:subtitle:0", combinedIndex: 0, language: "de", label: "German" };
    const finnish: SubtitlePreferences = { mode: "auto", language: "fi", audioLanguage: "ja", showForced: true, signature: undefined };
    const rows = [german, signs, secondForced];
    assert.equal(initialSubtitle({ kind: "auto" }, rows, finnish, "file:42:subtitle:0"), signs.trackId, "forced beats the file's default, in list order, in any language");
    assert.equal(initialSubtitle({ kind: "auto" }, rows, { ...finnish, mode: "always" }, undefined), signs.trackId, "always takes the same branch");
    assert.equal(initialSubtitle({ kind: "auto" }, rows, { ...finnish, showForced: false }, "file:42:subtitle:0"), "file:42:subtitle:0", "without forced subtitles the file's default stays");
    assert.equal(initialSubtitle({ kind: "auto" }, rows, { ...finnish, showForced: false }, undefined), undefined, "no default leaves subtitles off");
    assert.equal(initialSubtitle({ kind: "auto" }, [german], finnish, undefined), undefined, "no forced row leaves subtitles off");
    assert.equal(initialSubtitle({ kind: "auto" }, [german, { ...signs, unplayable: true }], finnish, undefined), undefined, "a forced row the server cannot deliver is never picked");
    assert.equal(initialSubtitle({ kind: "auto" }, rows, { ...finnish, language: "" }, "file:42:subtitle:0"), undefined, "an empty language is still an explicit no");
    assert.equal(initialSubtitle({ kind: "auto" }, rows, { ...finnish, mode: "off" }, "file:42:subtitle:0"), undefined, "Off keeps its own audio-language forced rule");
    assert.equal(initialSubtitle({ kind: "auto" }, rows, { ...finnish, mode: "always", language: "" }, "file:42:subtitle:0"), undefined, "always with an empty language is an explicit no, forced row or default notwithstanding");
});

test("a start request for a title lacking the subtitle language names the forced track", () => {
    const rows = [
        { selectionIndex: 0, externalPath: "", source: "embedded" as const, language: "de", codec: "srt", label: "German", forced: false, hearingImpaired: false },
        { selectionIndex: 1, externalPath: "", source: "embedded" as const, language: "en", codec: "ass", label: "Signs", forced: true, hearingImpaired: false },
    ];
    const finnish: SubtitlePreferences = { mode: "auto", language: "fi", audioLanguage: "ja", showForced: true, signature: undefined };
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, finnish), "file:42:subtitle:1");
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows, { ...finnish, showForced: false }), "file:42:subtitle:1", "forced subtitles off still falls to `.noChange`, which takes the default, else a forced row");
    assert.equal(startSubtitleTrackId("42", { kind: "auto" }, rows.slice(0, 1), finnish), undefined, "no default or forced row leaves subtitles off");
});

test("the Details subtitle line reads as Apple's pill: language, SDH and Forced in parentheses, then the format", () => {
    const entry = { label: undefined, language: "pt-BR", codec: "subrip", forced: false, hearingImpaired: false };
    assert.equal(subtitlePillSummary(entry, "Unknown language"), "Portuguese · SRT");
    assert.equal(subtitlePillSummary({ ...entry, forced: true }, "Unknown language"), "Portuguese (Forced) · SRT");
    assert.equal(subtitlePillSummary({ ...entry, hearingImpaired: true, forced: true }, "Unknown language"), "Portuguese (SDH) (Forced) · SRT");
    assert.equal(subtitlePillSummary({ ...entry, label: "Brazilian (Forced)", forced: true }, "Unknown language"), "Portuguese (Forced) · SRT", "a title never repeats the flag or leads the name");
    assert.equal(subtitlePillSummary({ ...entry, language: undefined, label: "Signs & Songs", codec: undefined }, "Unknown language"), "Signs & Songs");
    assert.equal(subtitlePillSummary({ ...entry, language: undefined, label: undefined }, "Unknown language"), "Unknown language · SRT");
});
