// SubtitleDisplayOrder (silo-apple Screens/Player/Subtitles/SubtitleDisplayOrder.swift, main e958f58): group by
// language, preferred language first, then A-Z by display name; format, then full/forced/SDH, then default, then input order.

import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalLanguageKey, formatRank, orderSubtitles } from "../../src/player/trackLabels.ts";

interface Track {
    readonly id: number;
    readonly language?: string;
    readonly codec?: string;
    readonly forced?: boolean;
    readonly hearingImpaired?: boolean;
    readonly isDefault?: boolean;
}

function order(tracks: readonly Track[], preferred?: string): number[] {
    return orderSubtitles(tracks, preferred, track => ({ language: track.language, codec: track.codec, forced: track.forced === true, hearingImpaired: track.hearingImpaired === true, isDefault: track.isDefault === true })).map(track => track.id);
}

test("a messy multi-language set groups by language and floats the preferred one", () => {
    const tracks: Track[] = [
        { id: 0, language: "en", codec: "subrip", isDefault: true },
        { id: 1, language: "es", codec: "ass" },
        { id: 2, language: "en", codec: "hdmv_pgs_subtitle", forced: true },
        { id: 3, language: "fr", codec: "hdmv_pgs_subtitle" },
        { id: 4, language: "en", codec: "subrip" },
        { id: 5, language: "ja", codec: "ass" },
        { id: 6, language: "es", codec: "subrip" },
        { id: 7, language: "de", codec: "subrip", forced: true },
    ];
    assert.deepEqual(order(tracks, "en"), [0, 4, 2, 3, 7, 5, 6, 1]);
});

test("the S95C case: English first, then Chinese, Danish and German by name, not in server order", () => {
    const tracks: Track[] = [
        { id: 0, language: "dan", codec: "subrip" },
        { id: 1, language: "ger", codec: "subrip" },
        { id: 2, language: "eng", codec: "subrip" },
        { id: 3, language: "eng", codec: "subrip", hearingImpaired: true },
        { id: 4, language: "chi", codec: "subrip" },
    ];
    assert.deepEqual(order(tracks, "eng"), [2, 3, 4, 0, 1]);
});

test("without a preferred language the groups run A to Z by English name", () => {
    assert.deepEqual(order([{ id: 0, language: "es", codec: "subrip" }, { id: 1, language: "en", codec: "subrip" }, { id: 2, language: "de", codec: "subrip" }]), [1, 2, 0]);
});

test("format priority within a language: SubRip, ASS, WebVTT, then bitmaps", () => {
    const tracks: Track[] = [
        { id: 0, language: "en", codec: "hdmv_pgs_subtitle" },
        { id: 1, language: "en", codec: "webvtt" },
        { id: 2, language: "en", codec: "subrip" },
        { id: 3, language: "en", codec: "ass" },
    ];
    assert.deepEqual(order(tracks), [2, 3, 1, 0]);
});

test("full dialogue comes before forced before SDH in the same format", () => {
    const tracks: Track[] = [
        { id: 0, language: "en", codec: "subrip", hearingImpaired: true },
        { id: 1, language: "en", codec: "subrip", forced: true },
        { id: 2, language: "en", codec: "subrip" },
    ];
    assert.deepEqual(order(tracks), [2, 1, 0]);
});

test("two and three letter codes make one group, and the preferred code may be either form", () => {
    assert.deepEqual(order([{ id: 0, language: "fr", codec: "subrip" }, { id: 1, language: "en", codec: "subrip" }], "eng"), [1, 0]);
    assert.deepEqual(order([{ id: 0, language: "eng", codec: "ass" }, { id: 1, language: "fr", codec: "subrip" }, { id: 2, language: "en", codec: "subrip" }]), [2, 0, 1]);
});

test("tracks without a usable language trail every named group, ordered by format among themselves", () => {
    assert.deepEqual(order([{ id: 0 }, { id: 1, language: "en", codec: "subrip" }, { id: 2, language: "und", codec: "subrip" }]), [1, 2, 0]);
});

test("equal tracks keep their incoming order, and short lists are untouched", () => {
    assert.deepEqual(order([{ id: 0, language: "en", codec: "subrip" }, { id: 1, language: "en", codec: "subrip" }, { id: 2, language: "en", codec: "subrip" }]), [0, 1, 2]);
    assert.deepEqual(order([]), []);
    assert.deepEqual(order([{ id: 9, language: "es", codec: "ass" }]), [9]);
});

test("formatRank follows Apple's ladder", () => {
    const ladder = ["subrip", "ass", "ssa", "webvtt", "mov_text", "hdmv_pgs_subtitle", "dvd_subtitle", undefined];
    for (let index = 1; index < ladder.length; index += 1) assert.ok(formatRank(ladder[index - 1]) < formatRank(ladder[index]), `${ladder[index - 1]} before ${ladder[index]}`);
    assert.equal(formatRank("srt"), formatRank("subrip"));
    assert.equal(formatRank("sup"), formatRank("pgssub"));
});

test("canonicalLanguageKey folds three-letter codes and drops und", () => {
    assert.equal(canonicalLanguageKey("eng"), "en");
    assert.equal(canonicalLanguageKey("EN"), "en");
    assert.equal(canonicalLanguageKey("en-US"), "en");
    assert.equal(canonicalLanguageKey("pt_BR"), "pt");
    assert.equal(canonicalLanguageKey("spa"), "es");
    assert.equal(canonicalLanguageKey("xyz"), "xyz");
    assert.equal(canonicalLanguageKey("und"), undefined);
    assert.equal(canonicalLanguageKey(""), undefined);
    assert.equal(canonicalLanguageKey(undefined), undefined);
});
