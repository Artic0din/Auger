// Watch Party text in the shown language (silo-apple Screens/WatchParty/*, WatchParty/WatchPartyLobbyState.swift): a key the screens read
// resolves in every language, a member's name is isolated in a right-to-left sentence, and a language without a key reads English.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { isolated } from "../../src/i18n/direction.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { registerCatalog, translate } from "../../src/i18n/translate.ts";
import { choiceFromEpisode, choiceFromNextUp } from "../../src/ui/watchPartyChoice.ts";
import { noticeText } from "../../src/ui/watchPartyHub.ts";
import { presenceSummary } from "../../src/ui/watchPartyPolicy.ts";
import type { Card, Episode } from "../../src/contracts/v2/catalog.ts";
import { WatchPartyHub } from "../../src/ui/watchPartyHub.ts";
import type { RoomMember } from "../../src/contracts/v2/watchTogether.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";
import { offline, unusedLobbyOperations } from "./support/watchPartyApi.ts";
import type { WatchPartyApi } from "../../src/ui/watchPartyHub.ts";

registerSourceCatalogs();
// Turkish has no Watch Party text here: a key it lacks reads English.
registerCatalog("tr", {});

const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
const source = (name: string): string => readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), "utf8");

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

const member = (over: Partial<RoomMember>): RoomMember => ({ userId: "u", profileId: "p", displayName: "Sam", isHost: false, isSelf: false, connected: true, lobbyReady: false, isReady: false, isBuffering: false, isSyncing: false, ...over } as RoomMember);

test("every catalog key the Watch Party screens read is in the German and Arabic files", () => {
    const keys = new Set<string>();
    for (const name of readdirSync(new URL("../../src/ui/", import.meta.url)).filter(file => /^watchParty.*\.ts$/.test(file))) {
        for (const [, key] of source(name).matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)"/g)) if (key !== undefined && Object.hasOwn(english, key)) keys.add(key);
    }
    assert.ok(keys.size > 100, `the screens read ${keys.size} catalog keys`);
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        assert.deepEqual([...keys].filter(key => !Object.hasOwn(catalog, key)), [], `${tag} lacks keys the screens read`);
    }
});

test("a name is isolated by first-strong marks in a right-to-left language and left as sent otherwise", () => {
    assert.equal(inLanguage("ar", () => isolated("Owner")), "⁨Owner⁩");
    assert.equal(inLanguage("de", () => isolated("Owner")), "Owner");
    assert.equal(isolated("أحمد", "ar"), "⁨أحمد⁩");
    assert.equal(isolated("Owner", "en"), "Owner");
});

test("the presence summary reads in German and Arabic, counting with each language's plural rules", () => {
    const here = [member({ isHost: true, lobbyReady: true }), member({ userId: "v", lobbyReady: true }), member({ userId: "w" })];
    inLanguage("de", () => {
        assert.equal(presenceSummary(here, "lobby"), translate("watchParty.presence.ready", { ready: "2", total: 3 }, "de"));
        assert.equal(presenceSummary(here.slice(0, 1), "lobby"), translate("watchParty.presence.onlyYou", undefined, "de"));
        assert.equal(presenceSummary([], "lobby"), translate("watchParty.presence.nobody", undefined, "de"));
        assert.equal(presenceSummary(here, "playing"), translate("watchParty.presence.watching", { watching: "0", total: 3 }, "de"));
    });
    inLanguage("ar", () => {
        assert.equal(presenceSummary(here, "lobby"), translate("watchParty.presence.ready", { ready: "٢", total: 3 }, "ar"));
    });
    assert.notEqual(translate("watchParty.presence.nobody", undefined, "de"), translate("watchParty.presence.nobody", undefined, "en"), "the German file carries it");
});

test("a language without the key reads English", () => {
    inLanguage("tr", () => {
        assert.equal(presenceSummary([], "lobby"), "nobody connected");
    });
});

test("the hub's own notices read in the shown language", async () => {
    const unused = async (): Promise<never> => { throw new Error("not read"); };
    const api: WatchPartyApi = { ...unusedLobbyOperations, capabilities: unused, playbackCapabilities: unused, createRoom: unused, joinByCode: unused, closeRoom: unused };
    const hub = new WatchPartyHub(api, () => undefined, offline());
    setAppLanguage("de", SHIPPED_LANGUAGES, ["en-AU"]);
    try {
        await hub.join("   ");
        assert.equal(noticeText(hub.state.error ?? ""), translate("watchParty.error.codeRequired", undefined, "de"));
        await hub.join("https://silo.example.test/rooms/join?token=x");
        assert.equal(noticeText(hub.state.error ?? ""), translate("watchParty.error.invalidInvitation", undefined, "de"));
    } finally { setAppLanguage(null); }
    assert.notEqual(translate("watchParty.error.codeRequired", undefined, "de"), "Enter a party code or invitation link.");
});

test("a chosen episode's labels are read when they are drawn, in the language shown then", () => {
    const series = { id: "series:s1", type: "series", title: "Harbor Lights" } as Card;
    const episode = { id: "episode:s1e2", seasonNumber: 1, episodeNumber: 2, title: "", runtimeMinutes: 90 } as Episode;
    const next = choiceFromNextUp(series, { contentId: "episode:s1e2", seasonNumber: 1, episodeNumber: 2, title: undefined });
    const choice = choiceFromEpisode(series, episode);
    // Chosen while the page still reads English.
    assert.equal(choice.subtitle(), "S1 · E2 · Episode 2");
    assert.equal(choice.lobby.title(), "Episode 2");
    assert.equal(choice.lobby.subtitle(), "Harbor Lights · S1:E2");
    assert.equal(next.subtitle(), "S1 · E2");
    // German's file lands: the same choice reads German with nothing rebuilt.
    inLanguage("de", () => {
        assert.equal(choice.subtitle(), "S1 · F2 · Folge 2");
        assert.equal(choice.lobby.title(), "Folge 2");
        assert.equal(choice.lobby.subtitle(), "Harbor Lights · S1:F2");
        assert.equal(next.subtitle(), "S1 · F2");
        assert.deepEqual(choice.facts(), choice.lobby.facts());
    });
});

test("a notice is read when it is drawn, in the language shown then", async () => {
    const unused = async (): Promise<never> => { throw new Error("not read"); };
    const api: WatchPartyApi = { ...unusedLobbyOperations, capabilities: unused, playbackCapabilities: unused, createRoom: unused, joinByCode: unused, closeRoom: unused };
    const hub = new WatchPartyHub(api, () => undefined, offline());
    await hub.join("   ");
    const raised = hub.state.error;
    assert.ok(raised !== undefined);
    assert.equal(noticeText(raised), "Enter a party code or invitation link.");
    inLanguage("de", () => { assert.equal(noticeText(raised), translate("watchParty.error.codeRequired", undefined, "de")); });
});
