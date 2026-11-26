import { percentText } from "../i18n/format.ts";
import { translate, translateTv } from "../i18n/translate.ts";
import { el } from "../ui/screen.ts";
import { heading } from "./headings.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { TrackView } from "./controller.ts";
import type { SyncTimingView } from "./subtitleSync.ts";
import { chevronForwardIcon, closeIcon, magnifyingGlassIcon, uturnBackwardIcon, waveformIcon } from "./playerIcons.ts";
import { appearanceSummary, BACKGROUND_COLORS, choiceLabel, choiceOptions, delayLabel, delayOptions, FONT_COLORS, FONT_FAMILIES, FONT_SIZES, type LabeledChoice, opacityOptions, POSITIONS, providerLabel, resultDetail, STYLES } from "./subtitleAppearance.ts";

/** The Subtitles pane's state. A picker floats over the pane it opened from, including Video's PICTURE and PLAYBACK rows. */
export type SubtitlePane =
    | { readonly kind: "tracks" }
    | { readonly kind: "appearance" }
    | { readonly kind: "picker"; readonly title: string; readonly field: string; readonly selected: string; readonly options: readonly LabeledChoice[]; readonly origin: { readonly pane: "tracks" | "appearance" | "video"; readonly focusId: string } };

function colorSwatch(hex: string): HTMLElement {
    const swatch = el("span", "player-color-swatch");
    swatch.style.backgroundColor = hex;
    swatch.setAttribute("aria-hidden", "true");
    return swatch;
}

function choice(id: string, label: string, current: boolean, detail?: string, swatchHex?: string): HTMLButtonElement {
    const button = el("button", "player-choice");
    button.type = "button";
    button.setAttribute("data-focus", id);
    button.setAttribute("aria-pressed", String(current));
    if (swatchHex !== undefined) button.append(colorSwatch(swatchHex));
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
export function settingRow(id: string, label: string, value: string, options: { readonly chevron?: boolean; readonly detail?: string; readonly glyph?: string; readonly icon?: string; readonly pressed?: boolean; readonly swatchHex?: string } = {}): HTMLButtonElement {
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
    if (value !== "" || options.swatchHex !== undefined) {
        if (options.swatchHex !== undefined) {
            const valueGroup = el("span", "player-setting-value player-setting-value-swatch");
            valueGroup.append(colorSwatch(options.swatchHex), el("span", "", value));
            button.append(valueGroup);
        } else {
            button.append(el("span", "player-setting-value", value));
        }
    }
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
    for (const option of pane.options) options.append(choice(`subtitle-picker:${option.id}`, option.label, option.id === pane.selected, undefined, option.colorHex));
    picker.append(el("h2", "player-menu-picker-title", pane.title), options);
    list.append(behind, picker);
}

/**
 * `SubtitleAppearanceDialog` (TVPlayerInfoHUD.swift:1125-1446, silo-apple 3289bedb): 720px floating dialog over the dimmed
 * Subtitles pane with eyebrow, title, 46px close button, Apple's row order, toggles, and 18px color swatches.
 * "Use device settings" is omitted because Samsung TVs have no system caption appearance API (docs/settings.md).
 */
export function overlayAppearance(list: HTMLElement, tracks: TrackView): void {
    const display = tracks.subtitleTools?.display;
    if (display === undefined) return;
    const appearance = display.appearance;
    const behind = el("div", "player-menu-behind");
    behind.append(...Array.from(list.childNodes));
    behind.inert = true;
    for (const node of behind.querySelectorAll("[data-focus]")) node.removeAttribute("data-focus");

    const dialog = el("div", "player-appearance-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", translate("player.hud.styleAndColors"));

    const header = el("div", "player-appearance-header");
    const titles = el("div", "player-appearance-titles");
    titles.append(
        el("p", "player-appearance-eyebrow", translate("player.hud.appearanceEyebrow")),
        el("h2", "player-appearance-title", translate("player.hud.styleAndColors")),
    );
    const close = el("button", "player-appearance-close");
    close.type = "button";
    close.setAttribute("data-focus", "subtitle-appearance-close");
    close.setAttribute("aria-label", translate("player.hud.closeAppearance"));
    close.innerHTML = closeIcon();
    header.append(titles, close);

    const rows = el("div", "player-appearance-rows");
    rows.append(
        settingRow("subtitle-appearance:backgroundStyle", translate("player.subtitles.style.backgroundStyle"), appearanceDetail(appearance, "backgroundStyle")),
        settingRow("subtitle-appearance:fontFamily", translate("player.subtitles.style.font"), appearanceDetail(appearance, "fontFamily")),
        settingRow("subtitle-appearance:fontSize", translate("player.subtitles.style.size"), appearanceDetail(appearance, "fontSize")),
        settingRow("subtitle-appearance:fontColor", translate("player.hud.appearanceText"), appearanceDetail(appearance, "fontColor"), { swatchHex: appearance.fontColor }),
    );
    if (display.textOpacity) {
        rows.append(settingRow("subtitle-appearance:textOpacity", translate("player.subtitles.style.textOpacityLabel"), appearanceDetail(appearance, "textOpacity")));
    }
    rows.append(
        settingRow("subtitle-appearance:textOutline", translate("player.subtitles.style.textOutline"), appearanceDetail(appearance, "textOutline"), { chevron: false, pressed: appearance.textOutline }),
        settingRow("subtitle-appearance:textOutlineColor", translate("player.hud.subtitleOutline"), appearanceDetail(appearance, "textOutlineColor"), appearance.textOutline ? { swatchHex: appearance.textOutlineColor } : {}),
        settingRow("subtitle-appearance:backgroundColor", translate("player.subtitles.style.background"), appearanceDetail(appearance, "backgroundColor"), appearance.backgroundStyle === "box" ? { swatchHex: appearance.backgroundColor } : {}),
        settingRow("subtitle-appearance:backgroundOpacity", translate("player.subtitles.style.opacity"), appearanceDetail(appearance, "backgroundOpacity")),
        settingRow("subtitle-appearance:position", translate("player.subtitles.style.position"), appearanceDetail(appearance, "position")),
    );

    dialog.append(header, rows);
    list.append(behind, dialog);
}

export function pickerFor(tracks: TrackView, field: string): Omit<Extract<SubtitlePane, { kind: "picker" }>, "origin"> | undefined {
    const display = tracks.subtitleTools?.display;
    if (display === undefined) return undefined;
    const appearance = display.appearance;
    if (field === "delay") return { kind: "picker", title: translate("player.settings.subtitleDelayTitle"), field, selected: String(display.delayMs), options: delayOptions(display.delayMs) };
    if (field === "fontSize") return { kind: "picker", title: translate("player.hud.pickerSubtitleSize"), field, selected: appearance.fontSize, options: choiceOptions(FONT_SIZES) };
    if (field === "position") return { kind: "picker", title: translate("player.hud.pickerSubtitlePosition"), field, selected: appearance.position, options: choiceOptions(POSITIONS) };
    if (field === "fontFamily") return { kind: "picker", title: translate("player.hud.pickerSubtitleFont"), field, selected: appearance.fontFamily, options: choiceOptions(FONT_FAMILIES) };
    if (field === "fontColor") return { kind: "picker", title: translate("player.hud.pickerTextColor"), field, selected: appearance.fontColor, options: choiceOptions(FONT_COLORS, true) };
    if (field === "textOpacity") return { kind: "picker", title: translate("player.subtitles.style.textOpacityLabel"), field, selected: String(appearance.textOpacity), options: opacityOptions(appearance.textOpacity, 25) };
    if (field === "textOutline") return { kind: "picker", title: translate("player.hud.subtitleOutline"), field, selected: String(appearance.textOutline), options: [{ id: "true", label: translate("options.on") }, { id: "false", label: translate("options.off") }] };
    if (field === "textOutlineColor") return { kind: "picker", title: translate("player.hud.pickerOutlineColor"), field, selected: appearance.textOutlineColor, options: choiceOptions(BACKGROUND_COLORS, true) };
    if (field === "backgroundStyle") return { kind: "picker", title: translate("player.hud.pickerSubtitleStyle"), field, selected: appearance.backgroundStyle, options: choiceOptions(STYLES) };
    if (field === "backgroundColor") return { kind: "picker", title: translate("player.hud.pickerBackgroundColor"), field, selected: appearance.backgroundColor, options: choiceOptions(BACKGROUND_COLORS, true) };
    if (field === "backgroundOpacity") return { kind: "picker", title: translate("player.subtitles.style.backgroundOpacityLabel"), field, selected: String(appearance.backgroundOpacity), options: opacityOptions(appearance.backgroundOpacity, 0) };
    return undefined;
}

export function appearanceDetail(appearance: SubtitleAppearance, field: string): string {
    switch (field) {
        case "fontSize": return choiceLabel(FONT_SIZES, appearance.fontSize);
        case "position": return choiceLabel(POSITIONS, appearance.position);
        case "fontFamily": return choiceLabel(FONT_FAMILIES, appearance.fontFamily);
        case "fontColor": return choiceLabel(FONT_COLORS, appearance.fontColor);
        case "textOpacity": return percentText(appearance.textOpacity);
        case "textOutline": return appearance.textOutline ? translate("options.on") : translate("options.off");
        case "textOutlineColor": return appearance.textOutline ? choiceLabel(BACKGROUND_COLORS, appearance.textOutlineColor) : "—";
        case "backgroundStyle": return appearance.backgroundStyle === "outline" ? translate("player.subtitles.background.outline") : choiceLabel(STYLES, appearance.backgroundStyle);
        case "backgroundColor": return appearance.backgroundStyle === "box" ? choiceLabel(BACKGROUND_COLORS, appearance.backgroundColor) : "—";
        case "backgroundOpacity": return appearance.backgroundStyle === "box" && appearance.backgroundOpacity > 0 ? percentText(appearance.backgroundOpacity) : translate("options.off");
        default: return "";
    }
}

/** The Search pane, which replaces both columns. Appearance floats via `overlayAppearance`. */
export function fillSubtitleTools(list: HTMLElement, tracks: TrackView, _pane: SubtitlePane): void {
    const tools = tracks.subtitleTools;
    if (tools === undefined) return;
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
            for (const item of [...search.suggested, ...search.other]) list.append(choice(`subtitle-language:${item.code}`, item.label, item.code === search.language, item.hint === undefined ? undefined : translate(item.hint)));
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

/** The running job: ProgressView beside its whole percentage, with the phase under it. Neither takes focus. */
function syncProgress(progress: NonNullable<SyncTimingView["progress"]>): HTMLElement {
    const block = el("div", "player-sync-progress");
    block.setAttribute("role", "progressbar");
    block.setAttribute("aria-label", translate("player.subtitleSync.progressLabel"));
    block.setAttribute("aria-valuemin", "0");
    block.setAttribute("aria-valuemax", "100");
    block.setAttribute("aria-valuenow", String(progress.percent));
    const track = el("span", "player-sync-track");
    const fill = el("span", "player-sync-fill");
    fill.style.width = `${Math.min(100, Math.max(0, progress.percent))}%`;
    track.append(fill);
    const bar = el("div", "player-sync-bar");
    bar.append(track, el("span", "player-sync-percent", `${progress.percent}%`));
    block.append(bar);
    if (progress.phase !== "") block.append(el("p", "player-sync-phase", progress.phase));
    return block;
}

/**
 * SubtitlesPane.timingRows (TVPlayerInfoHUD.swift, silo-apple main): Sync to Audio, the running job's progress, Reset Timing,
 * then the note. The rows stay enabled while a request runs so focus never lands on a row that just went inert; a refusal
 * swaps Sync to Audio for a dimmed row that cannot hold focus.
 */
function syncRows(timing: SyncTimingView | undefined): HTMLElement[] {
    if (timing === undefined) return [];
    if (timing.forbidden !== undefined) {
        const row = settingRow("subtitle-sync", translate("player.tracks.syncToAudioButton"), "", { chevron: false, detail: timing.forbidden, icon: waveformIcon() });
        row.removeAttribute("data-focus");
        row.disabled = true;
        row.setAttribute("data-unavailable", "true");
        return [row];
    }
    const rows: HTMLElement[] = [];
    if (timing.canSync) rows.push(settingRow("subtitle-sync", translate(timing.inProgress ? "player.tracks.syncing" : "player.tracks.syncToAudioButton"), "", { chevron: false, icon: waveformIcon() }));
    if (timing.progress !== undefined) rows.push(syncProgress(timing.progress));
    if (timing.canReset) rows.push(settingRow("subtitle-reset-timing", translate("player.tracks.resetTimingButton"), "", { chevron: false, icon: uturnBackwardIcon() }));
    if (timing.note !== undefined) rows.push(el("p", `player-sync-note player-sync-note-${timing.note.tone}`, timing.note.text));
    return rows;
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
 * `source`, then Search), TIMING (Delay, then Sync to Audio and Reset Timing) and STYLE (Appearance, then the device switch). A group with no row is left out, and a column with
 * none has no heading. Delay and style act on overlay cues only, so they wait for `overlay`.
 */
export function optionColumn(tracks: TrackView, source: readonly HTMLElement[]): HTMLElement {
    const tools = tracks.subtitleTools;
    const display = tools?.overlay === true ? tools.display : undefined;
    const options = [...source];
    if (tools?.search.offered === true) options.push(settingRow("subtitle-search", translate("options.searchSubtitles"), "", { icon: magnifyingGlassIcon() }));
    const timing = [...(display?.delay === true ? [settingRow("subtitle-delay", translate("player.hud.delay"), delayLabel(display.delayMs))] : []), ...syncRows(tracks.syncTiming)];
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
