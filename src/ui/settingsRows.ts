import { APPEARANCE_KEY, ADVISORY_KEY, BUFFERING_MODE_KEY, METADATA_KEY, INTRO_SKIP_KEY, CREDITS_SKIP_KEY } from "../contracts/v2/settingsRows.ts";
import { percentText } from "../i18n/format.ts";
import { translate, type MessageKey } from "../i18n/translate.ts";
import { bufferingQualityModes, bufferingQualityTitle } from "./qualitySettings.ts";
import { AUTO_NEXT_KEY, NEXT_UP_KEY, CARD_PRESENTATION_KEY, type SettingValue, type SettingsKey } from "../contracts/v2/settings.ts";
import { DEFAULT_APPEARANCE } from "../contracts/v2/subtitles.ts";
import type { SettingsState } from "./settingsState.ts";

type Choice = readonly [SettingValue, string];
/** Drawn in QUALITY, under Maximum Bitrate, not with the episode rows. */
export const BUFFERING_ROW_ID = "buffering-mode";
export interface SettingsRow { readonly id: string; readonly title: string; readonly key: SettingsKey; readonly member?: string; readonly choices: readonly Choice[] }
const onOff = (): readonly Choice[] => [[true, translate("settings.on")], [false, translate("settings.off")]];
const colors = (): readonly Choice[] => [["#ffffff", translate("player.subtitles.color.white")], ["#facc15", translate("player.subtitles.color.yellow")], ["#22c55e", translate("player.subtitles.color.green")], ["#06b6d4", translate("player.subtitles.color.cyan")], ["#d946ef", translate("player.subtitles.color.magenta")], ["#ef4444", translate("player.subtitles.color.red")], ["#3b82f6", translate("player.subtitles.color.blue")], ["#9ca3af", translate("player.subtitles.color.gray")], ["#000000", translate("player.subtitles.color.black")]];
const backgrounds = (): readonly Choice[] => [["#000000", translate("player.subtitles.color.black")], ["#374151", translate("player.subtitles.color.darkGrayTitleCase")], ["#1e3a5f", translate("player.subtitles.color.navy")], ["#7f1d1d", translate("player.subtitles.color.darkRedTitleCase")], ["#14532d", translate("player.subtitles.color.darkGreenTitleCase")]];
const appearance = (member: string, title: MessageKey, values: readonly Choice[]): SettingsRow => ({ id: `appearance-${member}`, title: translate(title), key: APPEARANCE_KEY, member, choices: values });

export function settingsRows(category: string, state: SettingsState): readonly SettingsRow[] {
    const rows: readonly SettingsRow[] = category === "general" ? [
        { id: "advisory-age", title: translate("settings.general.showAdvisoryAge"), key: ADVISORY_KEY, choices: onOff() },
        { id: "poster-size", title: translate("settings.cards.posterSize"), key: CARD_PRESENTATION_KEY, member: "poster_size", choices: [["compact", translate("settings.cards.size.compact")], ["standard", translate("settings.cards.size.standard")], ["large", translate("settings.cards.size.large")]] },
    ] : category === "playback" ? [
        { id: BUFFERING_ROW_ID, title: bufferingQualityTitle(), key: BUFFERING_MODE_KEY, choices: bufferingQualityModes() },
        { id: "auto-next", title: translate("settings.control.autoplay"), key: AUTO_NEXT_KEY, choices: onOff() },
        { id: "next-up", title: translate("settings.nextUp.title"), key: NEXT_UP_KEY, choices: [[0, translate("settings.nextUp.atEnd")], [10, translate("settings.nextUp.secondsBeforeEnd", { count: 10 })], [30, translate("settings.nextUp.secondsBeforeEnd", { count: 30 })], [60, translate("settings.nextUp.minutesBeforeEnd", { count: 1 })], [120, translate("settings.nextUp.minutesBeforeEnd", { count: 2 })]] },
        { id: "skip-intros", title: translate("settings.control.intros"), key: INTRO_SKIP_KEY, choices: [["never", translate("settings.introSkip.never")], ["ask", translate("settings.introSkip.ask")], ["always", translate("settings.introSkip.always")]] },
        { id: "skip-credits", title: translate("settings.control.credits"), key: CREDITS_SKIP_KEY, choices: onOff() },
    ] : category === "subtitles" ? [
        { id: "metadata-language", title: translate("settings.control.metadataLanguage"), key: METADATA_KEY, choices: [[null, translate("settingsManifest.catalog.metadata_language.unsetLabel")], ...state.definitions.find(def => def.key === METADATA_KEY)?.options.map(option => [option.value, option.label] as const) ?? []] },
        appearance("fontSize", "settings.subtitles.fontSize", [["small", translate("player.subtitles.size.small")], ["medium", translate("player.subtitles.size.medium")], ["large", translate("player.subtitles.size.large")], ["xlarge", translate("player.subtitles.size.xLarge")], ["xxlarge", translate("player.subtitles.size.xxLarge")]]),
        appearance("fontFamily", "settings.subtitles.fontFamily", [["sans-serif", translate("player.subtitles.font.sansSerif")], ["serif", translate("player.subtitles.font.serif")], ["monospace", translate("player.subtitles.font.monospace")]]),
        appearance("fontColor", "settings.subtitles.fontColor", colors()),
        appearance("textOpacity", "settings.subtitles.textOpacity", Array.from({ length: 20 }, (_, index) => [(index + 1) * 5, percentText((index + 1) * 5)])),
        appearance("textOutline", "settings.subtitles.textOutline", onOff()),
        appearance("textOutlineColor", "settings.subtitles.outlineColor", backgrounds()),
        appearance("backgroundStyle", "settings.subtitles.backgroundStyle", [["box", translate("player.subtitles.background.box")], ["shadow", translate("player.subtitles.background.dropShadow")], ["none", translate("player.subtitles.background.none")]]),
        appearance("backgroundOpacity", "settings.subtitles.backgroundOpacity", Array.from({ length: 21 }, (_, index) => [index * 5, percentText(index * 5)])),
        appearance("backgroundColor", "settings.subtitles.backgroundColor", backgrounds()),
        appearance("position", "settings.subtitles.position", [["bottom", translate("player.subtitles.position.bottom")], ["lower-third", translate("player.subtitles.position.lowerThirdTitleCase")], ["top", translate("player.subtitles.position.top")]]),
    ] : [];
    return rows.filter(row => (row.key !== METADATA_KEY || state.metadataEnabled) && state.definitions.some(def => def.key === row.key)).map(row => {
        const current = rowValue(row, state);
        return row.member?.endsWith("Opacity") && typeof current === "number" && !row.choices.some(([value]) => value === current) ? { ...row, choices: [...row.choices, [current, percentText(Number(current))] as const].sort(([a], [b]) => Number(a) - Number(b)) } : row;
    });
}

export function rowValue(row: SettingsRow, state: SettingsState): SettingValue {
    const stored = state.stored(row.key);
    const value = row.key === APPEARANCE_KEY || row.key === METADATA_KEY ? stored?.isSet ? stored.value : row.key === APPEARANCE_KEY ? {} : null : state.effective.get(row.key)?.value ?? null;
    if (row.member === undefined) return value;
    const document = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, SettingValue>> : {};
    return document[row.member] as SettingValue ?? (row.key === APPEARANCE_KEY ? DEFAULT_APPEARANCE[row.member as keyof typeof DEFAULT_APPEARANCE] : "standard");
}

export function rowEdit(row: SettingsRow, value: SettingValue, state: SettingsState): SettingValue {
    if (row.member === undefined) return value;
    const stored = state.stored(row.key);
    const old = stored?.isSet ? stored.value : row.key === APPEARANCE_KEY ? {} : state.effective.get(row.key)?.value;
    const document = old !== null && typeof old === "object" && !Array.isArray(old) ? old as Readonly<Record<string, SettingValue>> : {};
    const next: Record<string, SettingValue> = { ...document, [row.member]: value };
    if (row.key === CARD_PRESENTATION_KEY) next.caption = "title_metadata";
    if (row.member === "textOutlineColor") next.textOutline = true;
    if (row.member === "backgroundColor" || (row.member === "backgroundOpacity" && Number(value) > 0)) next.backgroundStyle = "box";
    if ((row.member === "backgroundColor" || (row.member === "backgroundStyle" && value === "box")) && next.backgroundOpacity === 0) next.backgroundOpacity = 75;
    return next;
}
