import { el } from "../ui/screen.ts";
import type { TrackView } from "./controller.ts";
import { currentChapter, type PlayerHUD, type StatsRow } from "./playerHUD.ts";
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
        body.append(statsColumn([["Playback", stats?.playback ?? []]]), el("div", "player-stats-divider"), statsColumn([["Stream", stats?.stream ?? []], ["Engine", stats?.engine ?? []]]));
        list.appendChild(body);
    } else if (name === "Chapters") {
        list.appendChild(el("h2", "player-menu-heading", "CHAPTERS"));
        const chapters = hud?.chapters ?? [];
        const current = currentChapter(chapters, seconds);
        chapters.forEach((chapter, index) => list.appendChild(choice(`chapter:${index}`, `${String(index + 1).padStart(2, "0")}  ${chapter.title}`, index === current, time(chapter.seconds))));
    }
}

/** A Grid of sections: an uppercase heading over label and value rows; a section with no rows is left out. */
function statsColumn(sections: readonly (readonly [string, readonly StatsRow[]])[]): HTMLElement {
    const column = el("div", "player-stats-column");
    for (const [title, rows] of sections) {
        if (rows.length === 0) continue;
        column.appendChild(el("h2", "player-stats-heading", title));
        column.appendChild(el("span", "player-stats-spacer"));
        for (const row of rows) column.append(el("span", "player-stats-label", row.label), el("span", "player-stats-value", row.value));
    }
    return column;
}

/** "1.0×", "2.00×": VideoPane.speedLabel (TVPlayerInfoHUD.swift:973). */
function speedLabel(speed: number): string {
    return `${speed === 1 ? "1.0" : speed.toFixed(2)}×`;
}

/** The selected quality's label, or "Switching..." while a switch runs (VideoPane.qualityValue, TVPlayerInfoHUD.swift:938; Switching... is `player.hud.qualitySwitching`). */
function qualityValue(tracks: TrackView): string {
    if (tracks.change.state === "changing" && tracks.change.kind === "quality") return "Switching...";
    const quality = tracks.quality;
    return quality?.choices.find(option => option.id === quality.selectedId)?.label ?? "";
}

/** The Video row pickers: Quality, Aspect and Playback Speed (TVPlayerInfoHUD.swift:816-876). */
export function videoPickerFor(hud: PlayerHUD | undefined, tracks: TrackView, field: string): Omit<Extract<SubtitlePane, { kind: "picker" }>, "origin"> | undefined {
    const quality = tracks.quality;
    if (field === "quality" && quality !== undefined && quality.choices.length > 1) return { kind: "picker", title: "Quality", field, selected: quality.selectedId ?? "", options: quality.choices.map(option => ({ id: option.id, label: option.label })) };
    if (field === "speed" && hud !== undefined && hud.speeds.length > 0) return { kind: "picker", title: "Playback Speed", field, selected: hud.speed === undefined ? "" : String(hud.speed), options: hud.speeds.map(speed => ({ id: String(speed), label: speedLabel(speed) })) };
    if (field === "aspect" && hud !== undefined && hud.aspects.length > 0) return { kind: "picker", title: "Aspect", field, selected: hud.aspect ?? "", options: hud.aspects.map(aspect => ({ id: aspect, label: aspect })) };
    return undefined;
}

/**
 * VideoPane (TVPlayerInfoHUD.swift:795-957, silo-apple e0337595): PICTURE has Quality and Aspect, PLAYBACK has Speed and
 * Auto-play next. Subtitle timing lives in the Subtitles pane.
 */
export function fillVideoPane(list: HTMLElement, hud: PlayerHUD | undefined, tracks: TrackView): void {
    const columns = el("div", "player-menu-columns player-menu-columns-video");
    const picture = paneColumn("PICTURE", "player-menu-column-picture");
    const playback = paneColumn("PLAYBACK", "player-menu-column-playback");
    if ((tracks.quality?.choices.length ?? 0) > 1) picture.rows.append(settingRow("video-quality", "Quality", qualityValue(tracks)));
    if ((hud?.aspects.length ?? 0) > 0) picture.rows.append(settingRow("video-aspect", "Aspect", hud?.aspect ?? ""));
    if ((hud?.speeds.length ?? 0) > 0) playback.rows.append(settingRow("video-speed", "Speed", hud?.speed === undefined ? "" : speedLabel(hud.speed)));
    if (hud?.autoNext !== undefined) playback.rows.append(settingRow("auto-next", "Auto-play next", hud.autoNext ? "On" : "Off", { chevron: false, pressed: hud.autoNext }));
    columns.append(picture.column, playback.column);
    list.append(columns);
    if (list.querySelector("[data-focus]") === null) {
        const note = el("p", "player-menu-note", "No video controls available for this stream.");
        note.tabIndex = -1;
        note.dataset.focus = "video-empty";
        picture.rows.append(note);
    }
}
