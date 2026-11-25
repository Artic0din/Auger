import { integerText } from "../i18n/numbers.ts";
import { translate, translateTv } from "../i18n/translate.ts";
import { el } from "../ui/screen.ts";
import { heading } from "./headings.ts";
import type { SubtitleAppearance } from "../contracts/v2/subtitles.ts";
import type { TrackView } from "./controller.ts";
import type { SyncTimingView } from "./subtitleSync.ts";
import { arrowDownCircleOutlineIcon, chevronBackwardIcon, chevronForwardIcon, globeIcon, magnifyingGlassIcon, spinnerIcon, starFillIcon, uturnBackwardIcon, warningTriangleOutlineIcon, waveformIcon } from "./playerIcons.ts";
import { appearanceSummary, BACKGROUND_COLORS, choiceLabel, choiceOptions, delayLabel, delayOptions, FONT_COLORS, FONT_FAMILIES, FONT_SIZES, languageLabel, opacityOptions, POSITIONS, providerLabel, resultDetail, scoreTier, STYLES, type LanguageChoice } from "./subtitleAppearance.ts";
import { renderSubtitleDialog } from "./subtitleDialog.ts";
import type { SubtitleSearchView } from "./subtitleSearch.ts";

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

function searchLanguageName(search: SubtitleSearchView): string {
    if (search.language === undefined) return translate("player.tracks.subtitles");
    return [...search.suggested, ...search.other].find(item => item.code === search.language)?.label ?? languageLabel(search.language);
}

function searchLanguageRow(item: LanguageChoice, current: boolean): HTMLButtonElement {
    const button = el("button", current ? "player-choice player-choice-current player-ai-row player-search-language-row" : "player-choice player-ai-row player-search-language-row");
    button.type = "button";
    button.setAttribute("data-focus", `subtitle-language:${item.code}`);
    button.setAttribute("aria-pressed", String(current));
    const glyph = el("span", "player-setting-glyph");
    glyph.innerHTML = item.hint === "subtitleSearch.preferred" ? starFillIcon() : globeIcon();
    glyph.setAttribute("aria-hidden", "true");
    const copy = el("span", "player-choice-copy");
    copy.append(el("span", "player-setting-label", item.label));
    if (item.hint !== undefined) copy.append(el("span", "player-choice-detail", translate(item.hint)));
    const chevron = el("span", "player-setting-chevron");
    chevron.innerHTML = chevronForwardIcon();
    button.append(glyph, copy, chevron);
    return button;
}

function searchResultRow(result: SubtitleSearchView["results"][number], downloading: boolean): HTMLButtonElement {
    const button = el("button", downloading ? "player-choice player-choice-current player-search-result-row" : "player-choice player-search-result-row");
    button.type = "button";
    button.setAttribute("data-focus", `subtitle-result:${result.key}`);
    button.setAttribute("aria-pressed", String(downloading));
    const scoreCol = el("span", "player-search-score-col");
    const tier = scoreTier(result.score);
    const badge = el("span", `player-search-score-badge player-search-score-${tier}`, integerText(Math.round(result.score)));
    badge.setAttribute("data-score-tier", tier);
    scoreCol.append(badge, el("span", "player-search-match-label", translate("subtitleSearch.matchLabel")));
    const copy = el("span", "player-choice-copy player-search-result-copy");
    const title = result.releaseName !== "" ? result.releaseName : translate("subtitleSearch.untitled");
    copy.append(el("span", "player-search-result-title", title));
    const detail = resultDetail(result);
    if (detail !== "") copy.append(el("span", "player-choice-detail player-search-result-detail", detail));
    if (downloading) {
        const spinner = el("span", "player-search-result-spinner");
        spinner.innerHTML = spinnerIcon();
        spinner.setAttribute("aria-hidden", "true");
        button.append(scoreCol, copy, spinner);
    } else {
        const providerCol = el("span", "player-search-provider-col");
        providerCol.append(el("span", "player-search-provider-name", providerLabel(result.provider)));
        const format = el("span", "player-search-format");
        const formatIcon = el("span", "player-search-format-icon");
        formatIcon.innerHTML = arrowDownCircleOutlineIcon();
        formatIcon.setAttribute("aria-hidden", "true");
        format.append(formatIcon, el("span", "player-search-format-text", result.format.toUpperCase()));
        providerCol.append(format);
        button.append(scoreCol, copy, providerCol);
    }
    return button;
}

function searchChooseAnotherRow(): HTMLButtonElement {
    const button = el("button", "player-choice player-ai-row player-search-back-row");
    button.type = "button";
    button.setAttribute("data-focus", "subtitle-search-back");
    const glyph = el("span", "player-setting-glyph player-search-back-icon");
    glyph.innerHTML = chevronBackwardIcon();
    glyph.setAttribute("aria-hidden", "true");
    button.append(glyph, el("span", "player-setting-label", translate("subtitleSearch.chooseAnother")));
    return button;
}

function searchWarningRow(message: string): HTMLElement {
    const row = el("p", "player-search-warning");
    const icon = el("span", "player-search-warning-icon");
    icon.innerHTML = warningTriangleOutlineIcon();
    icon.setAttribute("aria-hidden", "true");
    row.append(icon, el("span", "player-search-warning-text", message));
    return row;
}

/**
 * `SubtitleSearchMenu`'s tvOS dialog (`TVSubtitleDialog.swift`, `SubtitleSearchMenu.swift:315-585`, silo-apple 3289bedb):
 * shared 1280x800 modal dialog over a dimmed full-player backdrop with title, phase subtitle, hairline dividers, grouped
 * language rows / scored result rows / searching & failure panels, and non-focusable back/status footer.
 */
export function renderSearchDialog(host: HTMLElement, tracks: TrackView, onBackdropDismiss: () => void): void {
    const search = tracks.subtitleTools?.search;
    if (search === undefined || search.phase === "closed") return;
    const subtitle = search.phase === "languages"
        ? translate("subtitleSearch.explainer")
        : search.phase === "searching"
            ? search.language !== undefined ? translate("subtitleSearch.searchingIn", { language: searchLanguageName(search) }) : translate("subtitleSearch.searchingInYourLanguage")
            : search.phase === "failed"
                ? translate("subtitleSearch.failedTitle")
                : translate("subtitleSearch.resultCount", { language: searchLanguageName(search), count: search.results.length });
    const backHint = search.downloadingKey !== undefined
        ? translate("subtitleSearch.waitForDownload")
        : search.phase === "languages" ? translate("player.tracks.backToSubtitles") : translate("subtitleSearch.backToLanguages");
    const statusHint = search.downloadingKey !== undefined
        ? translate("subtitleSearch.adding")
        : search.phase === "results" && search.results.length > 0 ? translate("subtitleSearch.selectHint") : "";

    renderSubtitleDialog(host, {
        title: translate("subtitleSearch.title"),
        subtitle,
        backHint,
        statusHint,
        className: "player-search-menu",
        onBackdropDismiss: () => { if (search.downloadingKey === undefined) onBackdropDismiss(); },
        body: (body) => {
            if (search.phase === "searching") {
                const center = el("div", "player-subtitle-dialog-center");
                const head = el("div", "player-search-searching-head");
                const spinner = el("span", "player-search-searching-spinner");
                spinner.innerHTML = spinnerIcon();
                spinner.setAttribute("aria-hidden", "true");
                head.append(spinner, el("span", "player-search-searching-title", translate("subtitleSearch.searching")));
                const note = el("p", "player-search-searching-note", translate("subtitleSearch.searchingNote"));
                const actions = el("div", "player-subtitle-dialog-actions");
                actions.append(choice("subtitle-search-cancel", translate("common.cancel"), false));
                center.append(head, note, actions);
                body.append(center);
            } else if (search.phase === "failed") {
                const center = el("div", "player-subtitle-dialog-center");
                if (search.message !== "") {
                    const fail = el("p", "player-search-failure");
                    const icon = el("span", "player-search-failure-icon");
                    icon.innerHTML = warningTriangleOutlineIcon();
                    icon.setAttribute("aria-hidden", "true");
                    fail.append(icon, el("span", "player-search-failure-text", search.message));
                    center.append(fail);
                }
                const actions = el("div", "player-subtitle-dialog-actions");
                if (search.canRetry) actions.append(choice("subtitle-search-retry", translate("subtitleSearch.tryAgain"), false));
                actions.append(choice("subtitle-search-back", translate("common.back"), false));
                center.append(actions);
                body.append(center);
            } else if (search.phase === "languages") {
                if (!search.offered && search.unavailableReason !== "") body.append(el("p", "player-menu-note", search.unavailableReason));
                if (search.suggested.length > 0) {
                    body.append(el("h2", "player-menu-heading", heading("subtitleSearch.preferredHeader")));
                    for (const item of search.suggested) body.append(searchLanguageRow(item, item.code === search.language));
                }
                if (search.other.length > 0 || search.suggested.length === 0) {
                    body.append(el("h2", "player-menu-heading", heading(search.suggested.length === 0 ? "subtitleSearch.languageHeader" : "subtitleSearch.allLanguagesHeader")));
                    for (const item of search.other) body.append(searchLanguageRow(item, item.code === search.language));
                }
            } else {
                for (const warning of search.warnings) body.append(searchWarningRow(warning));
                if (search.results.length === 0) {
                    const emptyText = search.language !== undefined
                        ? translate("subtitleSearch.noResults", { language: searchLanguageName(search) })
                        : translate("subtitleSearch.noResultsAnyLanguage");
                    body.append(el("p", "player-search-empty", emptyText));
                    body.append(searchChooseAnotherRow());
                } else {
                    if (search.message !== "") body.append(el("p", "player-menu-note", search.message));
                    for (const result of search.results) body.append(searchResultRow(result, result.key === search.downloadingKey));
                }
            }
        },
    });
}

/** The Appearance pane, which replaces both columns. Search Subtitles renders in the shared modal via `renderSearchDialog`. */
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
