// The layout direction and `lang` of the language on screen, following silo-apple `AppLanguage.isRightToLeft`
// (`Locale.Language.characterDirection == .rightToLeft`): the CLDR direction of the language from the engine, with a short list for an engine that has none.
import { SOURCE_LANGUAGE } from "./language.ts";
import { textLanguage } from "./translate.ts";

/** What `isRightToLeft` reads of a locale. Chromium 108 (Tizen 8) has the `textInfo` getter; newer engines replace it with `getTextInfo()`. */
export interface DirectionLocale {
    readonly language: string;
    getTextInfo?: (() => { direction?: string } | undefined) | undefined;
    readonly textInfo?: { direction?: string } | undefined;
}

/**
 * shortcut: for an engine that offers neither `textInfo` nor `getTextInfo()`, the shipped languages written right
 * to left. A test holds it to what the engine reports for every shipped language; add a new right-to-left language here.
 */
const SHIPPED_RIGHT_TO_LEFT: ReadonlySet<string> = new Set(["ar"]);

/** True when the language is written right to left (Arabic, Hebrew, Persian, Urdu). `Locale` is for tests; the app reads the engine's. */
export function isRightToLeft(tag: string, Locale: new (tag: string) => DirectionLocale = Intl.Locale): boolean {
    try {
        const locale = new Locale(tag);
        const info = locale.getTextInfo?.() ?? locale.textInfo;
        return info === undefined ? SHIPPED_RIGHT_TO_LEFT.has(locale.language) : info.direction === "rtl";
    } catch {
        return false;
    }
}

/** The part of the document root the direction lands on. */
export interface DirectionRoot {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
}

/**
 * Sets the document root's `lang` to the text language on screen and `dir="rtl"` when it reads right to left (removing
 * `dir` otherwise). It follows `textLanguage`, the language whose text is drawn, so the layout mirrors and the
 * language tag changes in the same redraw as the words: a language whose file has not landed yet is still English,
 * which is also the page's default `lang`.
 */
export function applyLayoutDirection(root: DirectionRoot | undefined = globalThis.document?.documentElement, language: string = textLanguage()): void {
    if (root === undefined) return;
    // Settings and Browse both call this on every repaint; an unchanged value must not restyle the page.
    if (root.getAttribute("lang") !== language) root.setAttribute("lang", language);
    const rightToLeft = language !== SOURCE_LANGUAGE && isRightToLeft(language);
    if (rightToLeft === (root.getAttribute("dir") === "rtl")) return;
    if (rightToLeft) root.setAttribute("dir", "rtl");
    else root.removeAttribute("dir");
}

/** Leaves the screens that are still English, sign-in among them, with the default `lang` and reading left to right. */
export function clearLayoutDirection(): void {
    applyLayoutDirection(undefined, SOURCE_LANGUAGE);
}

/** True while the document reads right to left: Left and Right on the remote then follow the mirrored layout. */
export function documentIsRightToLeft(): boolean {
    return globalThis.document?.documentElement.getAttribute("dir") === "rtl";
}

/** True when the layout around `target` (the element a key press landed on) reads right to left: a screen pinned `dir="ltr"` inside an rtl page does not. */
export function readsRightToLeft(target: EventTarget | null): boolean {
    const scope = typeof Element !== "undefined" && target instanceof Element ? target.closest("[dir]") : null;
    return (scope ?? globalThis.document?.documentElement)?.getAttribute("dir") === "rtl";
}
