import { translate } from "../i18n/translate.ts";
import { el } from "../ui/screen.ts";
import { heading } from "./headings.ts";
import type { TrackView } from "./controller.ts";
import { aspectLabel, currentChapter, type PlayerHUD, type StatsRow, statLabel } from "./playerHUD.ts";
import { paneColumn, settingRow, type SubtitlePane } from "./subtitleMenu.ts";

type Choice = (id: string, label: string, selected: boolean, detail?: string) => HTMLButtonElement;

export function fillHUDPane(list: HTMLElement, name: string, hud: PlayerHUD | undefined, seconds: number, choice: Choice, time: (seconds: number) => string): void {
    if (name === "Stats") {
        // PlaybackStatsPanel's tvOS two-column layout (PlaybackStatsPanel.swift:33-38, :74-89): Playback, a divider, then
        // Stream over Engine. Like HUDScrollablePane, the whole pane is one focus target that Up and Down scroll.
        const stats = hud?.stats;
        const body = el("div", "player-stats");
        body.tabIndex = -1;
        body.dataset.focus = "stats";
        body.append(
            statsColumn([[translate("player.hud.playback"), stats?.playback ?? []]]),
            el("div", "player-stats-divider"),
            statsColumn([[translate("player.hud.stream"), stats?.stream ?? []], [translate("player.stats.sectionEngine"), stats?.engine ?? [], "engine"]]),
        );
        list.appendChild(body);
    } else if (name === "Chapters") {
        list.appendChild(el("h2", "player-menu-heading", heading("options.chapters")));
        const chapters = hud?.chapters ?? [];
        const current = currentChapter(chapters, seconds);
        chapters.forEach((chapter, index) => list.appendChild(choice(`chapter:${index}`, `${String(index + 1).padStart(2, "0")}  ${chapter.title}`, index === current, time(chapter.seconds))));
    }
}

/** A Grid of sections: an uppercase heading over label and value rows; a section with no rows is left out. */
function statsColumn(sections: readonly (readonly [string, readonly StatsRow[], string?])[]): HTMLElement {
    const column = el("div", "player-stats-column");
    for (const [title, rows, anchor] of sections) {
        if (rows.length === 0) continue;
        const heading = el("h2", "player-stats-heading", title);
        // StatsPane pages to Engine's heading (PlaybackStatsPanel.engineSectionID, TVPlayerInfoHUD.swift:772-787).
        if (anchor !== undefined) heading.dataset.pageTarget = anchor;
        column.appendChild(heading);
        column.appendChild(el("span", "player-stats-spacer"));
        for (const row of rows) column.append(el("span", "player-stats-label", statLabel(row.label)), el("span", "player-stats-value", row.value));
    }
    return column;
}

/** "1.0×", "2.00×": VideoPane.speedLabel (TVPlayerInfoHUD.swift:973). */
function speedLabel(speed: number): string {
    return `${speed === 1 ? "1.0" : speed.toFixed(2)}×`;
}

/** The selected quality's label, or "Switching..." while a switch runs (VideoPane.qualityValue, TVPlayerInfoHUD.swift:938; Switching... is `player.hud.qualitySwitching`). */
function qualityValue(tracks: TrackView): string {
    if (tracks.change.state === "changing" && tracks.change.kind === "quality") return translate("player.hud.qualitySwitching");
    const quality = tracks.quality;
    return quality?.choices.find(option => option.id === quality.selectedId)?.label ?? "";
}

/** The Video row pickers: Quality, Aspect and Playback Speed (TVPlayerInfoHUD.swift:816-876). */
export function videoPickerFor(hud: PlayerHUD | undefined, tracks: TrackView, field: string): Omit<Extract<SubtitlePane, { kind: "picker" }>, "origin"> | undefined {
    const quality = tracks.quality;
    if (field === "quality" && quality !== undefined && quality.choices.length > 1) return { kind: "picker", title: translate("options.quality"), field, selected: quality.selectedId ?? "", options: quality.choices.map(option => ({ id: option.id, label: option.label })) };
    if (field === "speed" && hud !== undefined && hud.speeds.length > 0) return { kind: "picker", title: translate("player.hud.pickerPlaybackSpeed"), field, selected: hud.speed === undefined ? "" : String(hud.speed), options: hud.speeds.map(speed => ({ id: String(speed), label: speedLabel(speed) })) };
    if (field === "aspect" && hud !== undefined && hud.aspects.length > 0) return { kind: "picker", title: translate("player.hud.aspect"), field, selected: hud.aspect ?? "", options: hud.aspects.map(aspect => ({ id: aspect, label: aspectLabel(aspect) })) };
    return undefined;
}

/**
 * VideoPane (TVPlayerInfoHUD.swift:795-957, silo-apple e0337595): PICTURE has Quality and Aspect, PLAYBACK has Speed and
 * Auto-play next. Subtitle timing lives in the Subtitles pane.
 */
export function fillVideoPane(list: HTMLElement, hud: PlayerHUD | undefined, tracks: TrackView): void {
    const columns = el("div", "player-menu-columns player-menu-columns-video");
    const picture = paneColumn(heading("player.hud.picture"), "player-menu-column-picture");
    const playback = paneColumn(heading("player.hud.playback"), "player-menu-column-playback");
    if ((tracks.quality?.choices.length ?? 0) > 1) picture.rows.append(settingRow("video-quality", translate("options.quality"), qualityValue(tracks)));
    if ((hud?.aspects.length ?? 0) > 0) picture.rows.append(settingRow("video-aspect", translate("player.hud.aspect"), hud?.aspect === undefined ? "" : aspectLabel(hud.aspect)));
    if ((hud?.speeds.length ?? 0) > 0) playback.rows.append(settingRow("video-speed", translate("player.settings.speed"), hud?.speed === undefined ? "" : speedLabel(hud.speed)));
    if (hud?.autoNext !== undefined) playback.rows.append(settingRow("auto-next", translate("options.autoplayNext"), hud.autoNext ? translate("options.on") : translate("options.off"), { chevron: false, pressed: hud.autoNext }));
    columns.append(picture.column, playback.column);
    list.append(columns);
    if (list.querySelector("[data-focus]") === null) {
        const note = el("p", "player-menu-note", "No video controls available for this stream.");
        note.tabIndex = -1;
        note.dataset.focus = "video-empty";
        picture.rows.append(note);
    }
}
