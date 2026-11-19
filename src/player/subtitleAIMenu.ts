import { translate } from "../i18n/translate.ts";
import { el } from "../ui/screen.ts";
import { heading } from "./headings.ts";
import type { TrackView } from "./controller.ts";
import { chevronForwardIcon, globeIcon, starFillIcon, waveformIcon } from "./playerIcons.ts";
import { DETECTED_LANGUAGE, type AIMenuRow } from "./subtitleAIRoute.ts";

// SubtitleTranslateMenu's tvOS panel (silo-apple main): a title and one line under it, then the languages, a running job's progress,
// or a failure. The TV draws it in the Subtitles pane, as it does Search, rather than in a floating dialog.

function button(id: string, label: string): HTMLButtonElement {
    const row = el("button", "player-choice");
    row.type = "button";
    row.setAttribute("data-focus", id);
    row.append(el("span", "player-choice-label", label));
    return row;
}

/** TVLanguageRow: symbol, name, hint, chevron. Rows the server cannot serve now are dimmed and do nothing. */
function languageRow(row: AIMenuRow): HTMLButtonElement {
    const button = el("button", "player-choice player-ai-row");
    button.type = "button";
    button.setAttribute("data-focus", `ai-language:${row.code}`);
    const glyph = el("span", "player-setting-glyph");
    glyph.innerHTML = row.code === DETECTED_LANGUAGE ? waveformIcon() : row.hint === "subtitleSearch.preferred" ? starFillIcon() : globeIcon();
    glyph.setAttribute("aria-hidden", "true");
    const copy = el("span", "player-choice-copy");
    copy.append(el("span", "player-setting-label", row.label));
    if (row.hint !== undefined) copy.append(el("span", "player-choice-detail", translate(row.hint)));
    const chevron = el("span", "player-setting-chevron");
    chevron.innerHTML = chevronForwardIcon();
    button.append(glyph, copy, chevron);
    if (row.disabled) button.setAttribute("data-unavailable", "true");
    return button;
}

function jobTitle(kind: string | undefined): string {
    switch (kind) {
        case "transcribe": return translate("player.aiTranslate.transcribingAudio");
        case "transcribe_translate": return translate("player.aiTranslate.transcribingTranslating");
        default: return translate("player.aiTranslate.translatingSubtitles");
    }
}

/** Every language row, in display order. */
export function aiRows(aiMenu: NonNullable<TrackView["aiMenu"]>): readonly AIMenuRow[] {
    const { detected, suggested, other } = aiMenu.menu;
    return [...(detected === undefined ? [] : [detected]), ...suggested, ...other];
}

/** The focus id of the first language the viewer can use, in display order: where the menu starts. */
export function firstServiceableLanguage(aiMenu: TrackView["aiMenu"]): string | undefined {
    const row = aiMenu === undefined ? undefined : aiRows(aiMenu).find(candidate => !candidate.disabled);
    return row === undefined ? undefined : `ai-language:${row.code}`;
}

export function fillAIMenu(list: HTMLElement, tracks: TrackView): void {
    const ai = tracks.ai;
    const aiMenu = tracks.aiMenu;
    if (ai === undefined || aiMenu === undefined) return;
    const phase = ai.phase === "completed" ? "idle" : ai.phase;
    const box = el("div", "player-ai-menu");
    box.append(el("h2", "player-ai-title", translate("player.aiTranslate.aiSubtitles")), el("p", "player-ai-subtitle", translate(phase === "busy" ? "player.aiTranslate.preparing" : phase === "failed" ? "player.aiTranslate.failedTitle" : "player.aiTranslate.explainerShort")));
    box.append(button("ai-language-back", translate("player.tracks.backToSubtitles")));
    if (phase === "busy") {
        const progress = el("div", "player-ai-progress");
        progress.setAttribute("role", "progressbar");
        progress.setAttribute("aria-valuemin", "0");
        progress.setAttribute("aria-valuemax", "100");
        progress.setAttribute("aria-valuenow", String(ai.progress?.percent ?? 0));
        const track = el("span", "player-ai-track");
        const fill = el("span", "player-ai-fill");
        fill.style.width = `${Math.min(100, Math.max(0, ai.progress?.percent ?? 0))}%`;
        track.append(fill);
        progress.append(el("p", "player-ai-job", jobTitle(ai.kind)), track);
        if (ai.progress !== undefined && ai.progress.message !== "") progress.append(el("p", "player-ai-progress-message", ai.progress.message));
        box.append(progress, button("ai-cancel", translate("common.cancel")));
    } else if (phase === "failed") {
        box.append(el("p", "player-ai-failure", ai.message !== "" ? ai.message : translate("player.aiTranslate.failed")), button("ai-dismiss", translate("player.aiTranslate.dismiss")));
        if (ai.held) box.append(button("ai-discard", translate("player.aiTranslate.discardHeldRequest")));
    } else {
        if (aiMenu.quota !== undefined) {
            const quota = el("p", aiMenu.quotaExhausted ? "player-ai-quota player-ai-quota-exhausted" : "player-ai-quota", aiMenu.quota);
            box.append(quota);
            if (aiMenu.quotaExhausted) box.append(el("p", "player-ai-quota-note", translate("player.aiTranslate.quotaExhaustedNote")));
        }
        const { detected, suggested, other } = aiMenu.menu;
        if (detected !== undefined || suggested.length > 0) {
            box.append(el("h2", "player-menu-heading", heading("player.aiTranslate.suggestedHeader")));
            if (detected !== undefined) box.append(languageRow(detected));
            for (const row of suggested) box.append(languageRow(row));
        }
        box.append(el("h2", "player-menu-heading", heading(detected === undefined && suggested.length === 0 ? "subtitleSearch.languageHeader" : "subtitleSearch.allLanguagesHeader")));
        for (const row of other) box.append(languageRow(row));
    }
    list.appendChild(box);
}
