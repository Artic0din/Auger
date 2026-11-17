// The layout direction of the shown language (silo-apple Shared/AppLanguage.swift `isRightToLeft`):
// the CLDR character direction of the language, so Arabic is right to left and every other shipped language is not.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyLayoutDirection, isRightToLeft, type DirectionRoot } from "../../src/i18n/direction.ts";
import { SHIPPED_LANGUAGES } from "../../src/i18n/language.ts";
import { physicalKey, remoteKey } from "../../src/ui/keys.ts";

/** A root that records the attributes the direction sets. */
function fakeRoot(): DirectionRoot & { readonly attributes: Map<string, string> } {
    const attributes = new Map<string, string>();
    return { attributes, getAttribute: name => attributes.get(name) ?? null, setAttribute: (name, value) => { attributes.set(name, value); }, removeAttribute: name => { attributes.delete(name); } };
}

test("Arabic is the only shipped language written right to left", () => {
    assert.deepEqual(SHIPPED_LANGUAGES.filter(tag => isRightToLeft(tag)), ["ar"]);
});

test("any right-to-left language reads right to left, from the language and not from a kept list", () => {
    for (const tag of ["ar", "ar-EG", "he", "fa", "ur"]) assert.equal(isRightToLeft(tag), true, tag);
    for (const tag of ["en", "de", "ja", "zh-Hans", "pt-BR", "ru"]) assert.equal(isRightToLeft(tag), false, tag);
    assert.equal(isRightToLeft("not a tag"), false, "a tag Intl cannot read is left to right");
});

test("the root takes dir=rtl for Arabic and loses it for every other language", () => {
    const root = fakeRoot();
    applyLayoutDirection(root, "ar");
    assert.equal(root.attributes.get("dir"), "rtl");
    applyLayoutDirection(root, "ar");
    assert.equal(root.attributes.get("dir"), "rtl", "applying twice changes nothing");
    for (const tag of SHIPPED_LANGUAGES.filter(tag => tag !== "ar")) {
        applyLayoutDirection(root, "ar");
        applyLayoutDirection(root, tag);
        assert.equal(root.attributes.has("dir"), false, `${tag} clears it`);
    }
});

/** A locale as an engine builds it: only the property it has. */
const engine = (has: "textInfo" | "getTextInfo" | "neither", rtl: readonly string[]) => class {
    readonly language: string;
    constructor(tag: string) { this.language = tag.split("-")[0] ?? tag; }
    get textInfo(): { direction: string } | undefined { return has === "textInfo" ? { direction: rtl.includes(this.language) ? "rtl" : "ltr" } : undefined; }
    getTextInfo = has === "getTextInfo" ? () => ({ direction: rtl.includes(this.language) ? "rtl" : "ltr" }) : undefined;
};

test("Chromium 108 has only the textInfo getter, and the direction is read from it", () => {
    const chromium108 = engine("textInfo", ["ar", "he"]);
    assert.equal(isRightToLeft("ar", chromium108), true);
    assert.equal(isRightToLeft("he", chromium108), true, "the engine's data decides, not the shipped list");
    assert.equal(isRightToLeft("de", chromium108), false);
});

test("an engine with neither property still shows Arabic right to left, and English left to right", () => {
    const bare = engine("neither", []);
    assert.equal(isRightToLeft("ar", bare), true);
    assert.equal(isRightToLeft("ar-EG", bare), true);
    for (const tag of SHIPPED_LANGUAGES.filter(tag => tag !== "ar")) assert.equal(isRightToLeft(tag, bare), false, tag);
});

test("the fallback agrees with the engine for every shipped language", () => {
    const bare = engine("neither", []);
    for (const tag of SHIPPED_LANGUAGES) assert.equal(isRightToLeft(tag, bare), isRightToLeft(tag), tag);
});

test("lang follows the language on screen, and a language that reads left to right sets only lang", () => {
    const root = fakeRoot();
    root.setAttribute("lang", "en");
    applyLayoutDirection(root, "ar");
    assert.equal(root.attributes.get("lang"), "ar");
    assert.equal(root.attributes.get("dir"), "rtl");
    applyLayoutDirection(root, "de");
    assert.equal(root.attributes.get("lang"), "de");
    assert.equal(root.attributes.has("dir"), false);
    applyLayoutDirection(root, "en");
    assert.equal(root.attributes.get("lang"), "en");
});

test("English never sets dir, whatever the text language machinery says", () => {
    const root = fakeRoot();
    applyLayoutDirection(root, "en");
    assert.equal(root.attributes.has("dir"), false);
});

/** Runs `body` with a document whose root carries `dir`, as the page does. */
function withDocument(dir: string | null, body: () => void): void {
    const holder = globalThis as { document?: unknown };
    const before = holder.document;
    holder.document = { documentElement: { getAttribute: (name: string) => name === "dir" ? dir : null } };
    try { body(); } finally { holder.document = before; }
}
const press = (keyCode: number): KeyboardEvent => ({ keyCode, key: "" }) as KeyboardEvent;

test("Left and Right follow the mirrored layout, and nothing else changes, when the document reads right to left", () => {
    withDocument("rtl", () => {
        assert.equal(remoteKey(press(37)), "right");
        assert.equal(remoteKey(press(39)), "left");
        for (const [code, key] of [[38, "up"], [40, "down"], [13, "enter"], [10009, "back"], [10252, "play_pause"]] as const) assert.equal(remoteKey(press(code)), key);
        assert.equal(remoteKey(press(1)), undefined);
    });
    withDocument(null, () => {
        assert.equal(remoteKey(press(37)), "left");
        assert.equal(remoteKey(press(39)), "right");
    });
});

test("media transport reads the physical key in every layout", () => {
    for (const dir of ["rtl", null]) withDocument(dir, () => {
        assert.equal(physicalKey(press(37)), "left");
        assert.equal(physicalKey(press(39)), "right");
    });
});
