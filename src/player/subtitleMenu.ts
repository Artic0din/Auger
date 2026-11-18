import { translate, translateTv } from "../i18n/translate.ts";
import { el } from "../ui/screen.ts";
import { heading } from "./headings.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { TrackView } from "./controller.ts";
import { chevronForwardIcon, magnifyingGlassIcon } from "./playerIcons.ts";
import { appearanceSummary, BACKGROUND_COLORS, choiceLabel, choiceOptions, delayLabel, delayOptions, FONT_COLORS, FONT_FAMILIES, FONT_SIZES, opacityOptions, POSITIONS, providerLabel, resultDetail, STYLES } from "./subtitleAppearance.ts";

/** The Subtitles pane's state. A picker floats over the pane it opened from, including Video's PICTURE and PLAYBACK rows. */
export type SubtitlePane =
    | { readonly kind: "tracks" }
    | { readonly kind: "appearance" }
    | { readonly kind: "picker"; readonly title: string; readonly field: string; readonly selected: string; readonly options: readonly { readonly id: string; readonly label: string }[]; readonly origin: { readonly pane: "tracks" | "appearance" | "video"; readonly focusId: string } };

function choice(id: string, label: string, current: boolean, detail?: string): HTMLButtonElement {
    const button = el("button", "player-choice");
    button.type = "button";
    button.setAttribute("data-focus", id);
    button.setAttribute("aria-pressed", String(current));
    const copy = el("span", "player-choice-copy");
    copy.append(el("span", "player-choice-label", label));
    if (detail !== undefined && detail !== "") copy.append(el("span", "player-choice-detail", detail));
    button.append(copy);
    if (current) button.className = "player-choice player-choice-current";
    return button;
}

/**
 * `HUDSettingRow` (TVPlayerInfoHUD.swift:494, label at 548): label left, value right-aligned, then a chevron when the row opens a picker.
 * `glyph` (text) or `icon` (inline SVG) stands in for its `systemImage` at 20pt semibold; Appearance's `textformat` reads "Aa".
 */
export function settingRow(id: string, label: string, value: string, options: { readonly chevron?: boolean; readonly detail?: string; readonly glyph?: string; readonly icon?: string; readonly pressed?: boolean } = {}): HTMLButtonElement {
    const button = el("button", "player-choice player-setting");
    button.type = "button";
    button.setAttribute("data-focus", id);
    if (options.pressed !== undefined) button.setAttribute("aria-pressed", String(options.pressed));
    if (options.glyph !== undefined || options.icon !== undefined) {
        const glyph = el("span", "player-setting-glyph", options.glyph);
        if (options.icon !== undefined) glyph.innerHTML = options.icon;
        glyph.setAttribute("aria-hidden", "true");
        button.append(glyph);
    }
    if (options.detail === undefined) button.append(el("span", "player-setting-label", label));
    else {
        // `detail` is HUDSettingRow's second line: 17pt, dimmed, under the label.
        const copy = el("span", "player-choice-copy");
        copy.append(el("span", "player-setting-label", label), el("span", "player-choice-detail", options.detail));
        button.append(copy);
    }
    if (value !== "") button.append(el("span", "player-setting-value", value));
    if (options.chevron !== false) {
        const chevron = el("span", "player-setting-chevron");
        chevron.innerHTML = chevronForwardIcon();
        button.append(chevron);
    }
    return button;
}

/** `PaneColumn` (TVPlayerInfoHUD.swift:314): an uppercase header over rows that scroll on their own. */
export function paneColumn(heading: string, className: string): { readonly column: HTMLElement; readonly rows: HTMLElement } {
    const column = el("div", `player-menu-column ${className}`);
    const rows = el("div", "player-menu-column-rows");
    column.append(el("h2", "player-menu-heading", heading), rows);
    return { column, rows };
}

/**
 * `HUDPickerDialog` (TVPlayerInfoHUD.swift:1042-1104) floats over the pane it opened from, which dims to 28% and
 * leaves the focus graph (`.disabled`, :1665-1666). Its title keeps its case; Back closes it (`onExitCommand`, :1092),
 * so it has no Back row.
 */
export function overlayPicker(list: HTMLElement, pane: Extract<SubtitlePane, { kind: "picker" }>): void {
    const behind = el("div", "player-menu-behind");
    behind.append(...Array.from(list.childNodes));
    behind.inert = true;
    for (const node of behind.querySelectorAll("[data-focus]")) node.removeAttribute("data-focus");
    const picker = el("div", "player-menu-picker");
    picker.setAttribute("role", "dialog");
    picker.setAttribute("aria-label", pane.title);
    const options = el("div", "player-menu-picker-options");
    for (const option of pane.options) options.append(choice(`subtitle-picker:${option.id}`, option.label, option.id === pane.selected));
    picker.append(el("h2", "player-menu-picker-title", pane.title), options);
    list.append(behind, picker);
}

export function pickerFor(tracks: TrackView, field: string): Omit<Extract<SubtitlePane, { kind: "picker" }>, "origin"> | undefined {
    const display = tracks.subtitleTools?.display;
    if (display === undefined) return undefined;
    const appearance = display.appearance;
    if (field === "delay") return { kind: "picker", title: translate("player.settings.subtitleDelayTitle"), field, selected: String(display.delayMs), options: delayOptions(display.delayMs) };
    if (field === "fontSize") return { kind: "picker", title: translate("player.hud.pickerSubtitleSize"), field, selected: appearance.fontSize, options: choiceOptions(FONT_SIZES) };
    if (field === "position") return { kind: "picker", title: translate("player.hud.pickerSubtitlePosition"), field, selected: appearance.position, options: choiceOptions(POSITIONS) };
    if (field === "fontFamily") return { kind: "picker", title: translate("player.hud.pickerSubtitleFont"), field, selected: appearance.fontFamily, options: choiceOptions(FONT_FAMILIES) };
    if (field === "fontColor") return { kind: "picker", title: translate("player.hud.pickerTextColor"), field, selected: appearance.fontColor, options: choiceOptions(FONT_COLORS) };
    if (field === "textOpacity") return { kind: "picker", title: translate("player.subtitles.style.textOpacityLabel"), field, selected: String(appearance.textOpacity), options: opacityOptions(appearance.textOpacity, 25) };
    if (field === "textOutline") return { kind: "picker", title: translate("player.hud.subtitleOutline"), field, selected: String(appearance.textOutline), options: [{ id: "true", label: translate("options.on") }, { id: "false", label: translate("options.off") }] };
    if (field === "textOutlineColor") return { kind: "picker", title: translate("player.hud.pickerOutlineColor"), field, selected: appearance.textOutlineColor, options: choiceOptions(BACKGROUND_COLORS) };
    if (field === "backgroundStyle") return { kind: "picker", title: translate("player.hud.pickerSubtitleStyle"), field, selected: appearance.backgroundStyle, options: choiceOptions(STYLES) };
    if (field === "backgroundColor") return { kind: "picker", title: translate("player.hud.pickerBackgroundColor"), field, selected: appearance.backgroundColor, options: choiceOptions(BACKGROUND_COLORS) };
    if (field === "backgroundOpacity") return { kind: "picker", title: translate("player.subtitles.style.backgroundOpacityLabel"), field, selected: String(appearance.backgroundOpacity), options: opacityOptions(appearance.backgroundOpacity, 0) };
    return undefined;
}

export function appearanceDetail(appearance: SubtitleAppearance, field: string): string {
    switch (field) {
        case "fontSize": return choiceLabel(FONT_SIZES, appearance.fontSize);
        case "position": return choiceLabel(POSITIONS, appearance.position);
        case "fontFamily": return choiceLabel(FONT_FAMILIES, appearance.fontFamily);
        case "fontColor": return choiceLabel(FONT_COLORS, appearance.fontColor);
        case "textOpacity": return `${appearance.textOpacity}%`;
        case "textOutline": return appearance.textOutline ? translate("options.on") : translate("options.off");
        case "textOutlineColor": return choiceLabel(BACKGROUND_COLORS, appearance.textOutlineColor);
        case "backgroundStyle": return appearance.backgroundStyle === "outline" ? translate("player.subtitles.background.outline") : choiceLabel(STYLES, appearance.backgroundStyle);
        case "backgroundColor": return choiceLabel(BACKGROUND_COLORS, appearance.backgroundColor);
        case "backgroundOpacity": return appearance.backgroundOpacity === 0 ? translate("options.off") : `${appearance.backgroundOpacity}%`;
        default: return "";
    }
}

/** The Appearance and Search panes, which replace both columns. */
export function fillSubtitleTools(list: HTMLElement, tracks: TrackView, pane: SubtitlePane): void {
    const tools = tracks.subtitleTools;
    if (tools === undefined) return;
    if (pane.kind === "appearance") {
        const display = tools.display;
        if (display === undefined) return;
        list.append(el("h2", "player-menu-heading", heading("player.hud.subtitleAppearance")));
        list.append(choice("subtitle-appearance-back", translate("common.back"), false));
        const rows = ["backgroundStyle", "fontSize", "position", "fontFamily", "fontColor", ...(display.textOpacity ? ["textOpacity"] : []), "textOutline", "textOutlineColor", "backgroundColor", "backgroundOpacity"];
        // Apple's row names (`player.subtitles.style.*`) where its English is Tizen's; the rest keep their wording.
        const titles: Record<string, string> = { backgroundStyle: translate("player.subtitles.style.backgroundStyle"), fontSize: translate("player.subtitles.style.size"), position: translate("player.subtitles.style.position"), fontFamily: translate("player.subtitles.style.font"), fontColor: "Text color", textOpacity: "Text opacity", textOutline: translate("player.hud.subtitleOutline"), textOutlineColor: "Outline color", backgroundColor: "Background color", backgroundOpacity: "Background opacity" };
        for (const field of rows) list.append(choice(`subtitle-appearance:${field}`, titles[field] ?? field, false, appearanceDetail(display.appearance, field)));
        return;
    }
    const search = tools.search;
    if (search.phase !== "closed") {
        list.append(el("h2", "player-menu-heading", "SEARCH"));
        list.append(choice("subtitle-search-back", search.phase === "languages" ? translate("common.back") : translate("subtitleSearch.chooseAnother"), false));
        if (search.phase === "searching") {
            list.append(el("p", "player-menu-note", search.status));
            list.append(choice("subtitle-search-cancel", translate("common.cancel"), false));
        } else if (search.phase === "failed") {
            if (search.message !== "") list.append(el("p", "player-menu-note", search.message));
            if (search.canRetry) list.append(choice("subtitle-search-retry", "Try Again", false));
        } else if (search.phase === "languages") {
            if (!search.offered && search.unavailableReason !== "") list.append(el("p", "player-menu-note", search.unavailableReason));
            for (const item of [...search.suggested, ...search.other]) list.append(choice(`subtitle-language:${item.code}`, item.label, item.code === search.language, item.hint));
        } else {
            for (const warning of search.warnings) list.append(el("p", "player-menu-note", warning));
            if (search.message !== "") list.append(el("p", "player-menu-note", search.message));
            for (const result of search.results) {
                const title = result.releaseName !== "" ? result.releaseName : providerLabel(result.provider);
                list.append(choice(`subtitle-result:${result.key}`, title, result.key === search.downloadingKey, [providerLabel(result.provider), result.format.toUpperCase(), resultDetail(result)].filter(part => part !== "").join(" · ")));
            }
        }
        return;
    }
}

function group(heading: string, rows: readonly HTMLElement[]): HTMLElement[] {
    if (rows.length === 0) return [];
    const box = el("section", "player-menu-group");
    const body = el("div", "player-menu-group-rows");
    body.append(...rows);
    box.append(el("h2", "player-menu-heading", heading), body);
    return [box];
}

/**
 * SubtitlesPane.optionRows (TVPlayerInfoHUD.swift, silo-apple main e958f58): one scrolling column of OPTIONS (what supplies subtitles:
 * `source`, then Search), TIMING (Delay) and STYLE (Appearance, then the device switch). A group with no row is left out, and a column with
 * none has no heading. Delay and style act on overlay cues only, so they wait for `overlay`.
 */
export function optionColumn(tracks: TrackView, source: readonly HTMLElement[]): HTMLElement {
    const tools = tracks.subtitleTools;
    const display = tools?.overlay === true ? tools.display : undefined;
    const options = [...source];
    if (tools?.search.offered === true) options.push(settingRow("subtitle-search", translate("options.searchSubtitles"), "", { icon: magnifyingGlassIcon() }));
    const timing = display?.delay === true ? [settingRow("subtitle-delay", translate("player.hud.delay"), delayLabel(display.delayMs))] : [];
    const style: HTMLElement[] = [];
    if (display?.styling === true) {
        style.push(settingRow("subtitle-appearance", translate("player.hud.subtitleAppearance"), "", { detail: appearanceSummary(display.appearance), glyph: "Aa" }));
        if (display.deviceScope) style.push(settingRow("subtitle-device", translateTv("player.hud.onlyOnThisAppleTv"), display.deviceOverride ? translate("options.on") : translate("options.off"), { chevron: false, pressed: display.deviceOverride }));
    }
    const column = el("div", "player-menu-column player-menu-column-options");
    const rows = el("div", "player-menu-column-rows");
    rows.append(...group(heading("player.hud.options"), options), ...group(heading("player.tracks.timing"), timing), ...group(heading("player.hud.style"), style));
    column.append(rows);
    return column;
}
