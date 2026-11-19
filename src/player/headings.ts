import { type MessageKey, textLanguage, translate } from "../i18n/translate.ts";

/**
 * `PaneColumn`'s `.textCase(.uppercase)` (TVPlayerInfoHUD.swift:314): the catalog's header in capitals. The casing follows the language the
 * text is actually in, so English that shows while a language's file is on its way is not cased by that language's rules (Turkish İ).
 */
export function heading(key: MessageKey): string {
    return translate(key).toLocaleUpperCase(textLanguage());
}
