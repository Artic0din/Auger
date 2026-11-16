// Home and top-navigation text on the resolver: Apple's catalog keys shown in the chosen language, English for
// what a language lacks, and the server's own section titles translated only through the key it sends
// (silo-apple tvOS/Navigation/TVTopMenuBar.swift, Screens/Home/HomeView.swift, Networking/Models.swift).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeHomeSections } from "../../src/contracts/v2/catalog.ts";
import type { UserLibrary } from "../../src/contracts/v2/catalog.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { resolveServerText, serverText, translate, type Catalogs } from "../../src/i18n/translate.ts";
import { navigationRoots } from "../../src/ui/navigation.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";
import { signOutConfirmationCopy } from "../../src/ui/signOutConfirmation.ts";

registerSourceCatalogs();

const file = (tag: string): Record<string, string> => JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
const library = (type: UserLibrary["type"]): UserLibrary => ({ id: type, name: type, type }) as UserLibrary;

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

test("the top bar names its roots in the chosen language, and in English by default", () => {
    const libraries = [library("movies"), library("series"), library("music"), library("audiobooks")];
    const titles = (): string[] => navigationRoots(null, libraries, false, true).map(root => root.title);
    assert.deepEqual(titles(), ["Home", "Movies", "Series", "Music", "Audiobooks", "For You", "Calendar"]);
    const de = file("de");
    assert.deepEqual(inLanguage("de", titles), ["topBar.home", "topBar.movies", "topBar.series", "topBar.music", "topBar.audiobooks", "topBar.forYou", "topBar.calendar"].map(key => de[key]));
    assert.notDeepEqual(inLanguage("de", titles), titles());
    assert.equal(inLanguage("de", () => translate("topBar.movies")), "Filme");
});

test("a key a language does not hold reads in English, and a screen key is never shown as text", () => {
    assert.equal(file("de")["player.hud.about"], undefined);
    assert.equal(inLanguage("de", () => translate("player.hud.about")), translate("player.hud.about", undefined, "en"));
    for (const key of ["topBar.home", "menu.settings", "menu.signOut", "home.empty", "home.loading", "library.browse"] as const) {
        assert.doesNotMatch(inLanguage("de", () => translate(key)), /^[a-z][A-Za-z]*\.[A-Za-z.]+$/, key);
    }
});

const CATALOGS: Catalogs = {
    en: { "home.section.continueWatching": "Continue Watching", "home.section.recentlyAddedIn": "Recently Added in {library}", "home.section.randomPicks": "Random Picks" },
    de: { "home.section.continueWatching": "Weiterschauen", "home.section.recentlyAddedIn": "Kürzlich hinzugefügt in {library}" },
};

test("a server title shows the catalog's translation only when the language translates the key it sent", () => {
    const title = (text: string, key: string | undefined, args: Record<string, string> | undefined, language: string): string => resolveServerText(CATALOGS, text, key, args, language);
    // The key and the shown language both have to say so.
    assert.equal(title("Continue Watching", "home.section.continueWatching", undefined, "de"), "Weiterschauen");
    assert.equal(title("Continue Watching", undefined, undefined, "de"), "Continue Watching");
    assert.equal(title("Continue Watching", "", undefined, "de"), "Continue Watching");
    assert.equal(title("Meine Zeile", undefined, undefined, "de"), "Meine Zeile");
    // English always shows the server's text as sent, even for a key.
    assert.equal(title("Continue Watching (renamed)", "home.section.continueWatching", undefined, "en"), "Continue Watching (renamed)");
    // A key this language lacks shows the server's text, not the English catalog.
    assert.equal(title("Random Picks!", "home.section.randomPicks", undefined, "de"), "Random Picks!");
    assert.equal(title("Whatever", "home.section.unknown", undefined, "de"), "Whatever");
    assert.equal(title("Whatever", "home.section.continueWatching", undefined, "fr"), "Whatever");
    // The key's placeholder is filled from title_args; one the server did not send leaves the server's text.
    assert.equal(title("Recently Added in Movies", "home.section.recentlyAddedIn", { library: "Filme" }, "de"), "Kürzlich hinzugefügt in Filme");
    assert.equal(title("Recently Added in Movies", "home.section.recentlyAddedIn", undefined, "de"), "Recently Added in Movies");
    assert.equal(title("Recently Added in Movies", "home.section.recentlyAddedIn", { other: "x" }, "de"), "Recently Added in Movies");
});

test("the shown language picks the server title's translation", () => {
    const key = "home.section.continueWatching";
    assert.equal(serverText("Continue Watching", key), "Continue Watching");
    assert.equal(inLanguage("de", () => serverText("Continue Watching", key)), file("de")[key]);
    assert.equal(inLanguage("de", () => serverText("Continue Watching", undefined)), "Continue Watching");
    assert.equal(inLanguage("de", () => serverText("Weiterschauen (mine)", key, undefined, "en")), "Weiterschauen (mine)");
});

test("Home sections carry the server's title key and arguments, and a malformed pair is dropped", () => {
    const section = { id: "recent", section_type: "recently_added", title: "Recently Added in Movies", items: [] };
    const [keyed, plain, malformed] = decodeHomeSections({ sections: [
        { ...section, title_key: "home.section.recentlyAddedIn", title_args: { library: "Movies" } },
        section,
        { ...section, title_key: 7, title_args: ["Movies"] },
    ] });
    assert.equal(keyed?.titleKey, "home.section.recentlyAddedIn");
    assert.deepEqual(keyed?.titleArgs, { library: "Movies" });
    assert.equal(plain?.titleKey, undefined);
    assert.equal(plain?.titleArgs, undefined);
    assert.equal(malformed?.title, "Recently Added in Movies");
    assert.equal(malformed?.titleKey, undefined);
    assert.equal(malformed?.titleArgs, undefined);
});

test("every key the server can send for a Home section title is in the language files", () => {
    const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
    const serverKeys = Object.keys(english).filter(key => key.startsWith("home.section."));
    assert.ok(serverKeys.length > 60, `${serverKeys.length} Home section keys`);
    for (const tag of SHIPPED_LANGUAGES.filter(language => language !== "en")) {
        const held = file(tag);
        assert.deepEqual(serverKeys.filter(key => held[key] === undefined), [], `${tag} lacks a Home section title`);
    }
});

test("the sign-out confirmation reads in the chosen language and keeps its English wording", () => {
    assert.equal(signOutConfirmationCopy("laura", "Living room", false).title, "Sign out of laura on Living room?");
    assert.equal(signOutConfirmationCopy(undefined, undefined, false).title, "Sign out of this account on this server?");
    assert.equal(signOutConfirmationCopy("laura", "Living room", true).message, "This account's profiles and settings leave this TV, and Living room will be removed from it.");
    const de = file("de");
    assert.equal(inLanguage("de", () => signOutConfirmationCopy("laura", "Wohnzimmer", false).title), "laura auf Wohnzimmer abmelden?");
    assert.equal(inLanguage("de", () => signOutConfirmationCopy(undefined, undefined, false).title), de["shell.signOut.titleNamed"]?.replace("{account}", de["account.fallback.thisAccount"] ?? "").replace("{server}", de["account.fallback.thisServer"] ?? ""));
    assert.equal(inLanguage("de", () => signOutConfirmationCopy("laura", "Wohnzimmer", true).message), de["account.signOut.leavesRemovingServer"]?.replace("{device}", "TV").replace("{server}", "Wohnzimmer"));
    assert.equal(inLanguage("de", () => signOutConfirmationCopy("laura", "Wohnzimmer", false).message), de["account.signOut.leaves"]?.replace("{device}", "TV"));
    for (const tag of SHIPPED_LANGUAGES) {
        for (const removes of [false, true]) assert.doesNotMatch(inLanguage(tag, () => signOutConfirmationCopy("laura", "Wohnzimmer", removes).message), /apple tv/i, `${tag} keeps Apple's device name`);
    }
});
