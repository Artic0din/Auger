// TVSubtitleDialog.swift (silo-apple main 3289bedb): shared 1280x800 modal dialog for AI Subtitles and Search Subtitles.
import { el } from "../ui/screen.ts";
import { chevronBackwardCircleIcon } from "./playerIcons.ts";

export interface SubtitleDialogSpec {
    readonly title: string;
    readonly subtitle: string;
    readonly backHint: string;
    readonly statusHint?: string;
    readonly className?: string;
    readonly titleClass?: string;
    readonly subtitleClass?: string;
    readonly onBackdropDismiss?: () => void;
    readonly body: (container: HTMLElement) => void;
}

export function renderSubtitleDialog(host: HTMLElement, spec: SubtitleDialogSpec): void {
    host.textContent = "";
    const backdrop = el("div", "player-subtitle-dialog-backdrop");
    backdrop.addEventListener("click", (event) => {
        if (event.target === backdrop) spec.onBackdropDismiss?.();
    });

    const dialog = el("div", spec.className ? `player-subtitle-dialog ${spec.className}` : "player-subtitle-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", spec.title);

    const header = el("div", "player-subtitle-dialog-header");
    header.append(
        el("h2", spec.titleClass ? `player-subtitle-dialog-title ${spec.titleClass}` : "player-subtitle-dialog-title", spec.title),
        el("p", spec.subtitleClass ? `player-subtitle-dialog-subtitle ${spec.subtitleClass}` : "player-subtitle-dialog-subtitle", spec.subtitle),
    );

    const topDivider = el("div", "player-subtitle-dialog-divider");
    topDivider.setAttribute("aria-hidden", "true");

    const body = el("div", "player-subtitle-dialog-body");
    spec.body(body);

    const bottomDivider = el("div", "player-subtitle-dialog-divider");
    bottomDivider.setAttribute("aria-hidden", "true");

    const footer = el("div", "player-subtitle-dialog-footer");
    const back = el("span", "player-subtitle-dialog-back");
    const backIcon = el("span", "player-subtitle-dialog-back-icon");
    backIcon.setAttribute("aria-hidden", "true");
    backIcon.innerHTML = chevronBackwardCircleIcon();
    back.append(backIcon, el("span", "player-subtitle-dialog-back-text", spec.backHint));
    const status = el("span", "player-subtitle-dialog-status", spec.statusHint ?? "");
    footer.append(back, status);

    dialog.append(header, topDivider, body, bottomDivider, footer);
    backdrop.appendChild(dialog);
    host.appendChild(backdrop);
}
