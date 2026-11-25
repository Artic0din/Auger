import type { NativeSession } from "../session/session.ts";
import { AUDIO_KEY, AUDIOBOOK_SEEK_BACK_KEY, AUDIOBOOK_SEEK_FORWARD_KEY, AUTO_NEXT_KEY, HDR_KEY, isSkipKey, HIDDEN_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY, SHOW_FORCED_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, TITLE_ART_KEY, type SettingValue, type SettingsKey } from "../contracts/v2/settings.ts";
import { HELD_CHANGE_MESSAGE, HELD_DISCARD_NEEDS_SERVER_MESSAGE, type PlayerSettingsFlusher } from "../player/playerSettingsFlusher.ts";
import { STILL_WATCHING_CHOICES, stillWatchingLabel, type StillWatchingPreference } from "../player/stillWatchingGuard.ts";
import { FocusHost, type FocusItem, type FocusTarget } from "./browseFocus.ts";
import { actionButton, zoneNode } from "./browseViews.ts";
import { el } from "./screen.ts";
import { remoteKey } from "./keys.ts";
import { SettingsState } from "./settingsState.ts";
import type { ProfileLaunch, LaunchBehavior } from "../session/profileLaunch.ts";
import { acknowledgementsDocument } from "./acknowledgements.ts";
import type { EpisodeSpoilerPreferences } from "./episodeSpoilers.ts";
import type { ThemeMusicPreferences } from "./themeMusicPreferences.ts";
import type { AppLanguagePreferences } from "./appLanguagePreferences.ts";
import { settingsRows, rowValue, rowEdit, BUFFERING_ROW_ID, type SettingsRow } from "./settingsRows.ts";
import { APPEARANCE_KEY, BUFFERING_MODE_KEY } from "../contracts/v2/settingsRows.ts";
import { qrCode } from "./qr.ts";
import { profileMenuAvatar } from "./navigationAvatar.ts";
import { centredDialog } from "./confirmationDialog.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { decodeAppearance, DEFAULT_APPEARANCE } from "../contracts/v2/subtitles.ts";
import { applySubtitleAppearance, subtitleFontSize } from "../player/subtitleView.ts";
import { pairedProfileDescription, pairedProfileLabel, profileSelectionCaption } from "./pairedProfile.ts";
import { bitrateLabel, bufferingQualityModes, bufferingQualityTitle, qualityFooter } from "./qualitySettings.ts";
import { ConnectionSpeed, learnedLimitText } from "./connectionSpeed.ts";
import { signOutConfirmationCopy } from "./signOutConfirmation.ts";
import type { ShowAudiobooks } from "./audiobookPreference.ts";
import { EXPERIMENTAL_FEATURES, type ExperimentalFeature, type ExperimentalFeatures } from "../session/experimentalFeatures.ts";
import { applyLayoutDirection } from "../i18n/direction.ts";
import { translate, translateTv, type MessageKey } from "../i18n/translate.ts";
import { heldSelect } from "./selectRelease.ts";
import { buildDiagnosticsReportUrl, DIAGNOSTICS_CATEGORIES, type DiagnosticsCategory, DiagnosticsCollector, type DiagnosticsSendResult, formatDeviceDetails, sendDiagnosticsReport } from "../diagnostics.ts";

type Category = "general" | "playback" | "subtitles" | "diagnostics" | "server";
const CATEGORY_LABELS = { general: "settings.general", playback: "settings.playback", subtitles: "settings.subtitles", diagnostics: "player.settings.diagnostics", server: "settings.category.server" } as const satisfies Record<Category, MessageKey>;
const CATEGORY_DETAILS = { general: "settings.rail.general", playback: "settings.railDescription.playback", subtitles: "settings.rail.subtitles", server: "settings.rail.server" } as const;
const CATEGORY_ICONS = { general: "gearshape", playback: "playback", subtitles: "subtitles", diagnostics: "diagnostics", server: "switch-server" } as const;
const CATEGORY_BLURBS = { general: "settings.blurb.generalAppleTv", playback: "settings.blurb.playbackAppleTv", subtitles: "settings.blurb.subtitles", server: "settings.blurb.serverAppleTv" } as const;
const DIAGNOSTICS_DETAIL = "Reports and support";
const DIAGNOSTICS_BLURB = "Send a redacted bug report directly to GitHub, or share via QR code.";
const FEATURE_TITLES = { watchParty: "settings.experimental.watchParty" } as const satisfies Record<ExperimentalFeature, MessageKey>;
/** First sentence of SettingsViewModel.hdrFooterText (136-143), without "without Dolby Vision". The tvOS original-file sentence is omitted; see docs/settings.md. */
// After STREAMING, as TVPlaybackSettingsView.swift:248. The Lossless and TrueHD sentences at 251-257 are not on this pane.
const HDR_FOOTER = "With HDR off, videos the server converts for this device are sent in SDR.";
const MODE_CHOICES = [["auto", "Auto"], ["always", "Always"], ["off", "Off"]] as const;
const LAUNCH_CHOICES = [["automatic", "settings.profileLaunch.automatic"], ["askEveryLaunch", "settings.profileLaunch.askEveryLaunch"], ["afterOneHour", "settings.profileLaunch.afterOneHour"], ["afterTwelveHours", "settings.profileLaunch.afterTwelveHours"]] as const satisfies readonly (readonly [LaunchBehavior, MessageKey])[];
/** Apple scrolls its Acknowledgements document by remote presses while the document holds focus. */
const DOCUMENT_STEP = 160;
type Picker = "audio" | "quality" | "bitrate" | "seek-back" | "seek-forward" | "audiobook-seek-back" | "audiobook-seek-forward" | "subtitle-language" | "subtitle-mode";
const PICKER_KEYS = { audio: AUDIO_KEY, quality: QUALITY_KEY, bitrate: BITRATE_KEY, "seek-back": SEEK_BACK_KEY, "seek-forward": SEEK_FORWARD_KEY, "audiobook-seek-back": AUDIOBOOK_SEEK_BACK_KEY, "audiobook-seek-forward": AUDIOBOOK_SEEK_FORWARD_KEY, "subtitle-language": SUBTITLE_LANGUAGE_KEY, "subtitle-mode": SUBTITLE_MODE_KEY } as const;
const PICKER_LABELS = { audio: "settings.control.audioLanguage", quality: "settings.control.resolution", bitrate: "settings.control.bitrate", "seek-back": "settings.control.skipBack", "seek-forward": "settings.control.skipForward", "audiobook-seek-back": "settings.control.skipBack", "audiobook-seek-forward": "settings.control.skipForward", "subtitle-language": "settings.control.language", "subtitle-mode": "settings.control.behavior" } as const satisfies Record<Picker, MessageKey>;
const pickerLabel = (picker: Picker): string => translate(PICKER_LABELS[picker]);
/** Apple titles the skip pickers by media kind (`skipIntervalPickerTitle`) while their rows keep the short "Skip Back" and "Skip Forward". */
const SKIP_PICKER_TITLES = { "seek-back": "settings.skipIntervals.picker.videoBack", "seek-forward": "settings.skipIntervals.picker.videoForward", "audiobook-seek-back": "settings.skipIntervals.picker.audiobookBackApple", "audiobook-seek-forward": "settings.skipIntervals.picker.audiobookForwardApple" } as const satisfies Partial<Record<Picker, MessageKey>>;
const pickerTitle = (picker: Picker): string => translate(picker in SKIP_PICKER_TITLES ? SKIP_PICKER_TITLES[picker as keyof typeof SKIP_PICKER_TITLES] : PICKER_LABELS[picker]);
const onOffText = (on: boolean): string => translate(on ? "settings.on" : "settings.off");
const BITRATE_CHOICES = [200000, 100000, 60000, 40000, 20000, 15000, 10000, 6000, 4000, 2000, 1500];
export interface SettingsActions { readonly showAudiobooks?: ShowAudiobooks; readonly stillWatching?: StillWatchingPreference; readonly playerSettings?: PlayerSettingsFlusher; readonly profileName: string; readonly profileAvatarUrl?: string | undefined; readonly profileAvatarText?: string | undefined; readonly accountName?: string | undefined; readonly switchProfile: () => void; readonly signOut?: () => void; readonly serverName?: string | undefined; readonly switchServer?: (back: () => void) => void; /** True when this sign-out removes the saved server. Unreadable account lists return false. */ readonly removesServer?: () => boolean }
export interface SettingsScreen { destroy(): void }

function settingsChevron(): SVGSVGElement {
    const icon = navigationIcon("chevron-right");
    icon.classList.add("settings-chevron");
    icon.setAttribute("viewBox", "7 3 12 18");
    icon.setAttribute("stroke-width", "2.5");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    return icon;
}

export function mountSettings(root: HTMLElement, session: NativeSession, close: (hiddenChanged: boolean, titleArt?: boolean) => void, launch?: ProfileLaunch, actions?: SettingsActions, accounts?: (back: () => void) => void, spoilers?: EpisodeSpoilerPreferences, experimental?: ExperimentalFeatures, themeMusic?: ThemeMusicPreferences, appLanguage?: AppLanguagePreferences, diagnostics?: DiagnosticsCollector, sendDiagnostics?: (collector: DiagnosticsCollector, signal: AbortSignal, category?: DiagnosticsCategory) => Promise<DiagnosticsSendResult>): SettingsScreen {
    const container = el("section", "browse settings");
    container.setAttribute("aria-label", translate("settings.title"));
    root.appendChild(container);
    const host = new FocusHost(container);
    const diagnosticsCollector = diagnostics ?? new DiagnosticsCollector({ appVersion: APP_VERSION, tvModel: "Samsung TV" });
    const submitDiagnostics = sendDiagnostics ?? ((collector, signal, category) => sendDiagnosticsReport(collector.snapshot(), (url, init) => window.fetch(url, init), { signal, category }));
    let category: Category = "general";
    let picker: Picker | undefined;
    let extraPicker: SettingsRow | undefined;
    let confirmingPlaybackReset = false;
    let pendingPlaybackReset: SettingsKey[] = [];
    let privacy = false;
    let diagnosticsQr = false;
    let confirmingDiagnosticsSend = false;
    let diagnosticsSending = false;
    let diagnosticsStatus: { readonly kind: "ok" | "error"; readonly text: string } | undefined;
    const diagnosticsSendController = new AbortController();
    let paneSnapshot: HTMLElement | undefined;
    let activeModal: string | undefined;
    let modalPaneTop = 0;
    let confirmingAppearanceReset = false;
    let returnRow: Picker | "acknowledgements" | "subtitle-forced" | "send-diagnostics" | "share-diagnostics" = "acknowledgements";
    let acknowledging = false;
    let confirmingSignOut = false;
    let choosingLaunch = false;
    let choosingLanguage = false;
    let choosingStillWatching = false;
    let languageRead = false;
    let torn = false;
    let heldBusy = false;
    let heldDiscardFailed = false;
    let launchPending = false;
    let launchError = false;
    let launchTarget: LaunchBehavior = "askEveryLaunch";
    const launchController = new AbortController();
    const saveLaunch = (behavior: LaunchBehavior): void => {
        if (launchPending || launch === undefined) return;
        launchTarget = behavior;
        launchPending = true;
        launchError = false;
        render();
        launch.setBehavior(behavior, launchController.signal).then(() => {
            if (torn) return;
            launchPending = false;
            const focus = choosingLaunch ? { zone: "settings-rows", key: "remember-profile" } : undefined;
            choosingLaunch = false;
            render(focus);
        }, () => {
            if (torn) return;
            launchPending = false;
            launchError = true;
            render();
        });
    };
    const state = new SettingsState(session, () => render());
    const connection = new ConnectionSpeed(session, () => { if (!torn) render(host.focused()); });
    const stopSpoilers = spoilers?.subscribe(() => { if (!torn) render(host.focused()); }) ?? (() => undefined);
    const stopPlayerSettings = actions?.playerSettings?.subscribe(() => {
        if (torn) return;
        if ((actions.playerSettings?.heldKeys.length ?? 0) === 0) heldDiscardFailed = false;
        render(host.focused());
    }) ?? (() => undefined);
    const stopThemeMusic = themeMusic?.subscribe(() => { if (!torn) render(host.focused()); }) ?? (() => undefined);
    const stopDiagnostics = diagnosticsCollector.subscribe(() => { if (!torn && (category === "diagnostics" || diagnosticsQr)) render(host.focused()); });
    // A language change repaints Settings, but not under a held Select: it waits for the release, as Browse's reconcileLanguage does.
    let repaintAfterRelease = false;
    const stopAppLanguage = appLanguage?.subscribe(() => {
        if (torn) return;
        if (heldSelect() !== undefined) { repaintAfterRelease = true; return; }
        // The layout mirrors, or returns, in the repaint that changes the words.
        applyLayoutDirection();
        render(host.focused());
    }) ?? (() => undefined);
    // The release clicks the row after this keyup's handlers, so the repaint runs once they have.
    const onKeyUp = (): void => {
        if (!repaintAfterRelease) return;
        window.setTimeout(() => {
            if (torn || !repaintAfterRelease || heldSelect() !== undefined) return;
            applyLayoutDirection();
            render(host.focused());
        }, 0);
    };
    document.addEventListener("keyup", onKeyUp);
    const destroy = (): void => {
        if (torn) return;
        torn = true;
        connection.stop();
        stopSpoilers();
        stopPlayerSettings();
        stopThemeMusic();
        stopAppLanguage();
        stopDiagnostics();
        diagnosticsSendController.abort();
        document.removeEventListener("keyup", onKeyUp);
        launchController.abort();
        stopAuthority();
        state.stop();
        container.removeEventListener("keydown", onKey, true);
        host.destroy();
        container.remove();
    };
    const stopAuthority = session.onAuthorityChange(destroy);
    const exit = (): void => {
        const changed = state.hiddenChanged;
        const titleArt = state.effective.get(TITLE_ART_KEY)?.value;
        destroy();
        close(changed, typeof titleArt === "boolean" ? titleArt : undefined);
    };
    const rowFocus = (): FocusTarget => ({ zone: "settings-rows", key: returnRow });
    const back = (): void => {
        if (confirmingPlaybackReset) { if (state.busy) return; confirmingPlaybackReset = false; pendingPlaybackReset = []; render({ zone: "settings-rows", key: "reset-playback" }); }
        else if (confirmingAppearanceReset) { confirmingAppearanceReset = false; render({ zone: "settings-rows", key: "reset-appearance" }); }
        else if (privacy) { privacy = false; render({ zone: "settings-rows", key: "privacy" }); }
        else if (confirmingDiagnosticsSend) { if (diagnosticsSending) return; confirmingDiagnosticsSend = false; render({ zone: "settings-rows", key: "send-diagnostics" }); }
        else if (diagnosticsQr) { diagnosticsQr = false; render({ zone: "settings-rows", key: "share-diagnostics" }); }
        else if (extraPicker !== undefined) { const key = extraPicker.id; extraPicker = undefined; render({ zone: "settings-rows", key }); }
        else if (choosingLaunch) { choosingLaunch = false; render({ zone: "settings-rows", key: "remember-profile" }); }
        else if (choosingLanguage) { choosingLanguage = false; render({ zone: "settings-rows", key: "app-language" }); }
        else if (choosingStillWatching) { choosingStillWatching = false; render({ zone: "settings-rows", key: "still-watching" }); }
        else if (confirmingSignOut) { confirmingSignOut = false; render({ zone: "settings-categories", key: "settings-signout" }); }
        else if (acknowledging) { acknowledging = false; render(rowFocus()); }
        else if (picker !== undefined) { picker = undefined; render(rowFocus()); }
        else if (host.focused()?.zone !== "settings-categories") render({ zone: "settings-categories", key: category });
        else exit();
    };
    const onKey = (event: KeyboardEvent): void => {
        const key = remoteKey(event);
        if (picker === undefined && !acknowledging && !confirmingSignOut && key === "right" && host.focused()?.zone === "settings-categories") {
            event.preventDefault();
            const first = container.querySelector<HTMLElement>(".settings-pane [data-focus]")?.getAttribute("data-focus");
            if (first !== undefined && first !== null) render({ zone: "settings-rows", key: first });
            return;
        }
        const credits = container.querySelector<HTMLElement>(".acknowledgements-document");
        if (acknowledging && credits !== null && host.focused()?.key === "document" && (key === "up" || key === "down")) {
            // The document scrolls until an edge; Up from its top then reaches Done.
            const before = credits.scrollTop;
            credits.scrollTop += key === "down" ? DOCUMENT_STEP : -DOCUMENT_STEP;
            if (credits.scrollTop !== before || key === "down") event.preventDefault();
            return;
        }
        if (picker === undefined && !acknowledging && key === "left" && host.focused()?.zone === "settings-rows") {
            event.preventDefault();
            render({ zone: "settings-categories", key: category });
        }
    };
    container.addEventListener("keydown", onKey, true);
    const openPicker = (next: Picker): void => {
        picker = next;
        returnRow = next;
        render();
    };
    const commit = async (key: SettingsKey, value: SettingValue | undefined): Promise<void> => {
        const startedPicker = picker;
        if (value === undefined) await state.reset(key);
        else await state.save(key, value);
        if (!torn && startedPicker === picker && !state.busy && state.error === undefined) { picker = undefined; render(rowFocus()); }
    };
    const button = (key: string, label: string, action: () => void): FocusItem => {
        const blocked = state.busy || (state.canRetry && key !== "retry");
        const item = actionButton(key, label, () => { if (!blocked) action(); });
        if (blocked) item.element.setAttribute("aria-disabled", "true");
        return item;
    };
    const devicePlaybackKeys = (): readonly SettingsKey[] => [QUALITY_KEY, BITRATE_KEY, AUDIO_KEY, HDR_KEY, ...settingsRows("playback", state).map(row => row.key)];
    const hdrSwitch = (id: string, title: string, on: boolean, action: () => void): FocusItem => {
        const item = button(id, title, action);
        item.element.appendChild(el("span", "settings-row-value", onOffText(on)));
        item.element.setAttribute("role", "switch");
        item.element.setAttribute("aria-label", title);
        item.element.setAttribute("aria-checked", String(on));
        return item;
    };
    const subtitleEntry = (): Picker | "subtitle-forced" => state.definitions.some(def => def.key === SUBTITLE_LANGUAGE_KEY) ? "subtitle-language" : state.definitions.some(def => def.key === SUBTITLE_MODE_KEY) ? "subtitle-mode" : "subtitle-forced";
    const subtitlePicker = (id: "subtitle-language" | "subtitle-mode", value: SettingValue): FocusItem => {
        const text = id === "subtitle-language" ? (typeof value === "string" ? value : translate("settingsManifest.playback.subtitle_language.unsetLabel")) : value === "always" ? "Always" : value === "off" ? "Off" : "Auto";
        const item = button(id, pickerLabel(id), () => openPicker(id));
        item.element.replaceChildren(el("span", "settings-row-title", pickerLabel(id)), el("span", "settings-row-value", text), settingsChevron());
        return item;
    };
    const label = (value: SettingValue, key: SettingsKey): string => key === QUALITY_KEY ? value === "2160p" ? "4K" : value === "auto" ? "Auto" : state.definitions.find(def => def.key === key)?.options.find(option => option.value === value)?.label ?? String(value)     : isSkipKey(key)
        // SeekIntervalLabel.choiceLabel: Apple's own plural message in the shown language and digits, not the manifest's English label.
        ? typeof value === "number" ? translate("player.seekInterval.choice", { seconds: value }) : String(value)
        : valueLabel(value, key);
    const note = (key: SettingsKey): HTMLElement => {
        const effective = state.effective.get(key);
        const sources: Readonly<Record<string, string>> = { default: "Inherited default", profile: "Profile default", profile_device: "Device override", profile_library: "Library override", profile_series: "Series override" };
        const source = effective === undefined ? "" : sources[effective.source] ?? effective.source.replace(/_/g, " ");
        const permitted = effective?.constrained && effective.permittedValues !== undefined ? ` · Permitted: ${effective.permittedValues.map(value => label(value, key)).join(", ")}` : "";
        const text = effective === undefined ? "" : `On this TV: ${label(effective.value, key)} · ${source}${effective.constrained ? " · Limited by server policy" : ""}${permitted}`;
        return el("p", "settings-value", text);
    };
    const feedback = (): HTMLElement[] => {
        const nodes: HTMLElement[] = [];
        if (state.busy) { const pending = el("p", "browse-text", state.loaded ? translate("settings.saving") : "Loading settings…"); pending.setAttribute("role", "status"); nodes.push(pending); }
        if (state.error !== undefined) { const error = el("p", "browse-text browse-error settings-warning", state.error); error.setAttribute("role", "alert"); nodes.push(error); }
        return nodes;
    };
    const retryButton = (): FocusItem[] => state.error === undefined ? [] : [button("retry", state.canRetry ? "Check and retry" : "Reload settings", () => { void state.retry(); })];
    const resetPlayback = async (retry = false): Promise<void> => {
        if (state.busy) return;
        if (retry) {
            await state.retry();
            if (torn || state.error !== undefined) return;
        }
        while (pendingPlaybackReset.length > 0) {
            const key = pendingPlaybackReset[0];
            if (torn || !confirmingPlaybackReset || key === undefined) return;
            await state.reset(key);
            if (torn || state.error !== undefined) return;
            if (key === AUTO_NEXT_KEY) actions?.playerSettings?.clearKey(key);
            pendingPlaybackReset.shift();
        }
        if (!torn) back();
    };

    const showModal = (name: string, title: string, content: HTMLElement[], controls: FocusItem[], zone = "settings-picker"): void => {
        const card = el("div", "settings-modal settings-controls");
        card.setAttribute("role", "dialog");
        card.setAttribute("aria-modal", "true");
        card.setAttribute("aria-label", title);
        const list = zoneNode("settings-modal-options", controls);
        list.dataset.scrollKey = name;
        for (const item of controls) {
            if (item.element.getAttribute("aria-checked") === "true") {
                const check = el("span", "settings-checkmark");
                check.setAttribute("aria-hidden", "true");
                item.element.prepend(check);
            }
        }
        card.append(...content);
        if (name !== "settings:privacy" && name !== "settings:diagnostics-qr") {
            const hint = el("span", "settings-picker-hint");
            const icon = el("span", "settings-back-icon", "↩"); icon.setAttribute("aria-hidden", "true");
            hint.append(icon, el("span", "", translate("settings.picker.menuToClose")));
            // TVSettingsComponents.swift:713-724: "Choose an option" sits under the title; a divider closes the header (:748-750).
            const subtitle = el("p", "settings-picker-subtitle", translate("settings.picker.chooseOption"));
            const title = card.querySelector(".browse-title");
            if (title === null) card.append(subtitle); else { title.classList.add("settings-picker-title"); title.after(subtitle); }
            card.append(hint, el("div", "settings-picker-divider"));
        }
        const privacyCopy = card.querySelector(".settings-privacy-copy");
        if (privacyCopy !== null) privacyCopy.append(...controls.map(item => item.element));
        else card.append(list);
        const scrim = el("div", "settings-modal-scrim");
        scrim.appendChild(card);
        if (activeModal !== name) modalPaneTop = paneSnapshot?.querySelector<HTMLElement>(".settings-pane")?.scrollTop ?? 0;
        const background = paneSnapshot?.cloneNode(true) as HTMLElement | undefined;
        if (background !== undefined) {
            background.inert = true;
            background.setAttribute("aria-hidden", "true");
            background.querySelectorAll("[data-focus]").forEach(node => node.removeAttribute("data-focus"));
        }
        const selected = controls.find(item => item.element.getAttribute("aria-checked") === "true") ?? controls[0];
        const initialFocus = { zone, key: selected?.key ?? "" };
        const opening = activeModal !== name;
        activeModal = name;
        host.show({ name, content: [...(background === undefined ? [] : [background]), scrim], zones: [{ id: zone, layout: "column", items: controls }], focus: initialFocus, back }, opening ? initialFocus : undefined);
        const snapshotPane = background?.querySelector<HTMLElement>(".settings-pane");
        if (snapshotPane !== null && snapshotPane !== undefined) snapshotPane.scrollTop = modalPaneTop;
    };

    const renderPicker = (): void => {
        if (picker === undefined) return;
        const key = PICKER_KEYS[picker];
        const stored = state.stored(key);
        const controls: FocusItem[] = [];
        const content: HTMLElement[] = [el("h1", "browse-title", pickerTitle(picker)), ...feedback()];
        if (picker === "audio") {
            const current = stored?.isSet ? stored.value : state.scope(key) === "profile" ? state.effective.get(key)?.value : undefined;
            const effective = state.effective.get(AUDIO_KEY);
            const options = [...new Set([...state.audioOptions, ...(effective?.suggestedValues?.filter((value): value is string | null => value === null || typeof value === "string") ?? []), ...(typeof current === "string" ? [current] : [])])].filter(value => value !== null || state.scope(key) === "profile" || current === null);
            content.push(el("p", "browse-text", state.scope(key) === "profile_device" ? "This TV. Library and series choices can take priority." : "Profile default. Device, library and series choices can take priority."));
            for (const value of options) {
                const item = button(`audio:${value ?? "null"}`, valueLabel(value), () => { void commit(key, value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                controls.push(item);
            }
        } else if (picker === "subtitle-language" || picker === "subtitle-mode") {
            const current = state.subtitleProfileValue(picker === "subtitle-language" ? SUBTITLE_LANGUAGE_KEY : SUBTITLE_MODE_KEY);
            const choices: readonly (readonly [SettingValue, string])[] = picker === "subtitle-language" ? [[null, translate("settingsManifest.playback.subtitle_language.unsetLabel")], ...state.subtitleOptions.map(value => [value, value] as const)] : MODE_CHOICES;
            for (const [value, text] of choices) {
                const item = button(`${picker}:${value ?? "none"}`, text, () => {
                    if (current === value) { picker = undefined; render(rowFocus()); return; }
                    void commit(key, value);
                });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                controls.push(item);
            }
        } else if (picker === "quality" || picker === "seek-back" || picker === "seek-forward" || picker === "audiobook-seek-back" || picker === "audiobook-seek-forward") {
            const current = stored?.isSet ? stored.value : state.scope(key) === "profile" ? state.effective.get(key)?.value : undefined;
            const options = picker === "quality" ? ["auto", "2160p", "1080p", "720p", "480p"].flatMap(value => state.qualityOptions.filter(option => option.value === value)) : state.definitions.find(def => def.key === key)?.options ?? [];
            if (current !== undefined && !options.some(option => option.value === current)) content.push(el("p", "browse-text", `Current ${state.scope(key) === "profile_device" ? "device" : "profile"} value: ${label(current, key)} · Not offered`));
            for (const option of options) {
                const item = button(`${picker}:${option.value}`, label(option.value, key), () => { void commit(key, option.value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === option.value));
                controls.push(item);
            }
        } else {
            const current = stored?.isSet ? stored.value : state.scope(key) === "profile" ? state.effective.get(key)?.value : undefined;
            // SiloQualityPresets.bitrateChoices(including:): a stored cap no preset covers stays in descending order and selected.
            const extra = typeof current === "number" && current > 0 && !BITRATE_CHOICES.includes(current) ? [current] : [];
            const caps = [...BITRATE_CHOICES, ...extra].sort((a, b) => b - a);
            for (const value of caps) {
                const item = button(`bitrate:${value}`, bitrateLabel(value), () => { void commit(key, value); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                controls.push(item);
            }
            const noLimit = button("no-limit", translate("settings.noLimit"), () => { void commit(key, null); });
            noLimit.element.setAttribute("aria-checked", String(current === null));
            controls.unshift(noLimit);
        }
        // Apple's skip-interval pickers list only the seven choices, with no row to clear a stored one (TVPlaybackSettingsView, silo-apple 648091a7, line 556).
        if (picker !== "subtitle-language" && picker !== "subtitle-mode" && !isSkipKey(key) && (state.scope(key) === "profile_device" || stored?.isSet)) {
            const reset = button("reset", state.scope(key) === "profile_device" ? translate("settings.profileSettings.useRow") : "Use inherited default", () => { void commit(key, undefined); });
            if (state.scope(key) === "profile_device") { reset.element.setAttribute("role", "radio"); reset.element.setAttribute("aria-checked", String(stored?.isSet !== true)); }
            controls.unshift(reset);
        }
        controls.push(...retryButton());
        showModal(`settings:${picker}`, pickerTitle(picker), content, controls);
    };

    const renderAcknowledgements = (): void => {
        const done = actionButton("done", translate("common.done"), back);
        const credits = acknowledgementsDocument();
        credits.tabIndex = 0;
        credits.setAttribute("data-focus", "document");
        credits.setAttribute("aria-label", translate("settings.about.acknowledgementsLabel"));
        const panel = el("div", "acknowledgements-panel");
        const heading = el("div", "acknowledgements-heading");
        heading.append(el("p", "acknowledgements-eyebrow", translate("settings.about.creditsHeaderTv")), el("h1", "acknowledgements-title", translate("settings.about.acknowledgements")));
        const header = el("div", "acknowledgements-header");
        header.append(heading, zoneNode("acknowledgements-actions", [done]));
        panel.append(header, credits);
        host.show({ name: "settings:acknowledgements", content: [panel], zones: [
            { id: "acknowledgements-actions", layout: "row", down: "acknowledgements-document", items: [done] },
            { id: "acknowledgements-document", layout: "column", up: "acknowledgements-actions", items: [{ key: "document", element: credits }] },
        ], focus: { zone: "acknowledgements-document", key: "document" }, back }, undefined);
    };

    function render(focus?: FocusTarget): void {
        if (torn) return;
        repaintAfterRelease = false;
        if (confirmingPlaybackReset) {
            const playbackKeys = devicePlaybackKeys();
            const keys = playbackKeys.filter(key => state.scope(key) === "profile_device");
            const controls = [button("cancel-playback-reset", translate("common.cancel"), back), button("confirm-playback-reset", translate("settings.subtitles.resetConfirm"), () => {
                if (state.busy) return;
                if (pendingPlaybackReset.length === 0) pendingPlaybackReset = [...keys];
                void resetPlayback();
            }), ...(state.error === undefined ? [] : [button("retry", state.canRetry ? "Check and retry" : "Reload settings", () => { void resetPlayback(true); })])];
            showModal("settings:reset-playback", translate("settings.profileSettings.confirmTitle"), [el("h1", "browse-title", translate("settings.profileSettings.confirmTitle")), el("p", "settings-value", translateTv("settings.profileSettings.resetFooterAppleTv")), ...feedback()], controls);
            return;
        }
        if (torn) return;
        if (confirmingAppearanceReset) {
            const controls = [actionButton("cancel", translate("common.cancel"), back), button("reset", translate("settings.subtitles.resetConfirm"), () => { void state.save(APPEARANCE_KEY, { ...DEFAULT_APPEARANCE }).then(() => { if (!torn && confirmingAppearanceReset && state.error === undefined) back(); }); }), ...retryButton()];
            host.show({ name: "settings:reset-appearance", content: [el("h1", "browse-title", translate("settings.subtitles.resetTitleApple")), el("p", "settings-value", state.scope(APPEARANCE_KEY) === "profile_device" ? translateTv("settings.subtitles.resetMessageAppleTv") : translate("settings.subtitles.resetMessageProfile")), ...feedback(), zoneNode("settings-controls", controls)], zones: [{ id: "settings-picker", layout: "column", items: controls }], focus: { zone: "settings-picker", key: "cancel" }, back });
            return;
        }
        if (confirmingDiagnosticsSend) {
            const runSend = (chosen: DiagnosticsCategory): void => {
                if (diagnosticsSending) return;
                const existingId = diagnosticsCollector.duplicateSendReportId(chosen);
                if (existingId !== undefined) {
                    confirmingDiagnosticsSend = false;
                    diagnosticsStatus = { kind: "ok", text: `Already sent as ${existingId}. Play or reproduce a new issue to send another.` };
                    render({ zone: "settings-rows", key: "send-diagnostics" });
                    return;
                }
                // Snapshot the hash before submitting so events arriving mid-request are not swallowed as already sent.
                const submittedHash = diagnosticsCollector.stableSnapshotHash(chosen);
                diagnosticsSending = true;
                diagnosticsStatus = undefined;
                render();
                void submitDiagnostics(diagnosticsCollector, diagnosticsSendController.signal, chosen).then(result => {
                    if (torn) return;
                    diagnosticsSending = false;
                    confirmingDiagnosticsSend = false;
                    if (result.ok) {
                        diagnosticsCollector.markManualSent(chosen, result.reportId, submittedHash);
                        const okText = result.status === "duplicate"
                            ? `Already tracked (${result.reportId}). Thanks for confirming.`
                            : result.status === "updated"
                                ? `Added to existing report (${result.reportId}).`
                                : result.issueNumber !== undefined
                                    ? `Report sent — GitHub issue #${result.issueNumber} (${result.reportId}).`
                                    : `Report sent — Reference ${result.reportId}.`;
                        diagnosticsStatus = { kind: "ok", text: okText };
                    } else {
                        diagnosticsStatus = { kind: "error", text: result.message };
                    }
                    render({ zone: "settings-rows", key: "send-diagnostics" });
                }, () => {
                    if (torn) return;
                    diagnosticsSending = false;
                    confirmingDiagnosticsSend = false;
                    diagnosticsStatus = { kind: "error", text: "Could not send report. Try again or use Share via QR Code." };
                    render({ zone: "settings-rows", key: "send-diagnostics" });
                });
            };
            const categoryButtons = DIAGNOSTICS_CATEGORIES.map(entry => {
                const item = actionButton(`send-diagnostics-${entry.id}`, diagnosticsSending ? "Sending…" : entry.label, () => runSend(entry.id));
                item.element.setAttribute("aria-disabled", String(diagnosticsSending));
                return item;
            });
            const cancelButton = actionButton("cancel-send-diagnostics", translate("common.cancel"), back);
            cancelButton.element.setAttribute("aria-disabled", String(diagnosticsSending));
            showModal(
                "settings:send-diagnostics",
                "Send Diagnostics Report",
                [
                    el("h1", "browse-title", "Send Diagnostics Report"),
                    el("p", "settings-value", "Choose what best matches the issue. Redacted TV, memory, playback, and error details will be sent to GitHub."),
                    el("p", "settings-value", "Server addresses, account names, tokens, and media titles are never included."),
                    ...(diagnosticsSending ? [el("p", "browse-text", "Sending diagnostics report…")] : []),
                ],
                [...categoryButtons, cancelButton],
            );
            return;
        }
        if (diagnosticsQr) {
            const done = actionButton("back", translate("common.done"), back);
            const reportUrl = buildDiagnosticsReportUrl(diagnosticsCollector.snapshot());
            const code = qrCode(reportUrl, "Diagnostics Report QR code", "L");
            const image = el("div", "settings-privacy-qr");
            if (code !== undefined) { code.style.width = "360px"; code.style.height = "360px"; image.appendChild(code); }
            const copy = el("div", "settings-privacy-copy");
            copy.append(
                el("h1", "browse-title", "Share Diagnostics"),
                el("p", "settings-value", "Scan this QR code with your phone camera to copy a report for Discord or open a pre-filled GitHub bug report."),
                el("p", "settings-value", "All details stay inside the link fragment and are never sent to a server."),
            );
            const handoff = el("div", "settings-privacy-card");
            handoff.dataset.reportUrl = reportUrl;
            handoff.append(image, copy);
            copy.prepend(navigationIcon("diagnostics"));
            showModal("settings:diagnostics-qr", "Share Diagnostics", [handoff], [done]);
            return;
        }
        if (privacy) {
            const done = actionButton("back", translate("common.done"), back);
            const code = qrCode("https://siloserver.org/privacy", "Privacy Policy QR code");
            const image = el("div", "settings-privacy-qr");
            if (code !== undefined) { code.style.width = "320px"; code.style.height = "320px"; image.appendChild(code); }
            const copy = el("div", "settings-privacy-copy");
            copy.append(el("h1", "browse-title", translate("settings.about.privacyPolicy")), el("p", "settings-value", translate("settings.privacyPolicy.scanPrompt")), el("p", "settings-value", "https://siloserver.org/privacy"));
            const handoff = el("div", "settings-privacy-card");
            handoff.append(image, copy);
            copy.prepend(navigationIcon("privacy"));
            showModal("settings:privacy", translate("settings.about.privacyPolicy"), [handoff], [done]);
            return;
        }
        if (extraPicker !== undefined) {
            const row = extraPicker;
            const unsettled = row.member === undefined ? actions?.playerSettings?.unsettledValue(row.key) : undefined;
            const current = unsettled !== undefined ? unsettled : rowValue(row, state);
            const controls = [...row.choices.map(([value, text]) => {
                const item = button(`choice:${String(value)}`, text, () => {
                    void state.save(row.key, rowEdit(row, value, state)).then(() => {
                        if (!torn && state.error === undefined) {
                            actions?.playerSettings?.clearKey(row.key);
                            if (extraPicker === row) back();
                        }
                    });
                });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(current === value));
                return item;
            })];
            const reset = button("reset-row", row.key === "ui.card_presentation" ? translate("settings.cards.useProfileDefault") : state.scope(row.key) === "profile_device" ? translate("settings.profileSettings.useRow") : "Use inherited default", () => {
                void state.reset(row.key).then(() => {
                    if (!torn && state.error === undefined) {
                        actions?.playerSettings?.clearKey(row.key);
                        if (extraPicker === row) back();
                    }
                });
            });
            if (row.member === undefined && state.scope(row.key) === "profile_device") {
                const inherited = unsettled === undefined && state.stored(row.key)?.isSet !== true;
                reset.element.setAttribute("aria-checked", String(inherited));
                if (inherited) for (const item of controls) item.element.setAttribute("aria-checked", "false");
            }
            if (row.member === undefined && state.scope(row.key) === "profile_device") controls.unshift(reset);
            controls.push(...retryButton());
            showModal(`settings:${row.id}`, row.title, [el("h1", "browse-title", row.title), ...feedback()], controls);
            return;
        }
        if (choosingLanguage && appLanguage !== undefined) {
            // TVSettingsPickerSheet: picking closes the sheet at once; the save settles behind it.
            const busy = appLanguage.isBusy;
            const selected = appLanguage.currentChoice?.tag ?? null;
            const controls = appLanguage.options.map(option => {
                const item = actionButton(`language:${option.tag ?? "device"}`, option.label, () => {
                    if (appLanguage.isBusy) return;
                    choosingLanguage = false;
                    render({ zone: "settings-rows", key: "app-language" });
                    void appLanguage.select(option.tag);
                });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(option.tag === selected));
                item.element.setAttribute("aria-disabled", String(busy));
                return item;
            });
            showModal("settings:language", translate("settings.appLanguage.title"), [el("h1", "browse-title", translate("settings.appLanguage.title")), ...(busy ? [el("p", "browse-text", translate("settings.appLanguage.saving"))] : [])], controls, "settings-language");
            return;
        }
        if (choosingStillWatching && actions?.stillWatching !== undefined) {
            const pref = actions.stillWatching;
            const selected = pref.value;
            const title = translate("settingsManifest.player.passout_threshold.label");
            const controls = STILL_WATCHING_CHOICES.map(count => {
                const item = actionButton(`still-watching:${count}`, stillWatchingLabel(count), () => {
                    pref.set(count);
                    choosingStillWatching = false;
                    render({ zone: "settings-rows", key: "still-watching" });
                });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(selected === count));
                return item;
            });
            showModal("settings:still-watching", title, [el("h1", "browse-title", title)], controls, "settings-still-watching");
            return;
        }
        if (choosingLaunch && launch !== undefined) {
            const controls = [...LAUNCH_CHOICES.map(([behavior, key]) => {
                const text = translate(key);
                const item = actionButton(`launch:${behavior === "automatic" ? "true" : behavior === "askEveryLaunch" ? "false" : behavior}`, text, () => { if (!launchPending) saveLaunch(behavior); });
                item.element.setAttribute("role", "radio");
                item.element.setAttribute("aria-checked", String(launch.behavior === behavior));
                const detail = el("span", "settings-option-detail", profileSelectionCaption(behavior));
                detail.id = `settings-launch-${behavior}-detail`;
                item.element.setAttribute("aria-label", text);
                item.element.setAttribute("aria-describedby", detail.id);
                item.element.appendChild(detail);
                item.element.setAttribute("aria-disabled", String(launchPending));
                return item;
            })];
            showModal("settings:launch", translate("settings.control.profileSelection"), [el("h1", "browse-title", translate("settings.control.profileSelection")), ...(launchError ? [el("p", "browse-error settings-warning", "Could not save the launch choice. Try again.")] : []), ...(launchPending ? [el("p", "browse-text", "Saving launch choice…")] : [])], controls, "settings-launch");
            return;
        }
        if (confirmingSignOut) {
            const copy = signOutConfirmationCopy(actions?.accountName, actions?.serverName, actions?.removesServer?.() ?? false);
            const signOutAccount = actions?.accountName?.trim();
            const signOutServer = actions?.serverName?.trim();
            const signOutTitle = signOutAccount && signOutServer ? translate("shell.signOut.titleNamed", { account: signOutAccount, server: signOutServer }) : copy.title;
            const cancel = actionButton("cancel-signout", translate("common.cancel"), back);
            const confirm = actionButton("confirm-signout", translate("settings.signOut"), () => { destroy(); actions?.signOut?.(); });
            const controls = [cancel, confirm];
            // AccountRemovalConfirmation on tvOS: TVSettingsConfirmationOverlay over Settings, Cancel then Sign Out, Cancel focused.
            const behind = paneSnapshot?.cloneNode(true);
            host.show({ name: "settings:signout", content: centredDialog({ style: "confirmation", id: "settings-signout", title: signOutTitle, message: copy.message,
                buttons: controls.map(control => control.element), destructive: confirm.element, behind: behind instanceof HTMLElement ? [behind] : [] }),
                zones: [{ id: "settings-confirm", layout: "row", items: controls }], focus: { zone: "settings-confirm", key: "cancel-signout" }, back });
            return;
        }
        if (acknowledging) { renderAcknowledgements(); return; }
        if (picker !== undefined) { renderPicker(); return; }
        activeModal = undefined;
        const categories = (["general", "playback", "subtitles", "diagnostics", "server"] as const).map(id => {
            const item = actionButton(id, translate(CATEGORY_LABELS[id]), () => { category = id; returnRow = id === "general" ? "acknowledgements" : id === "playback" ? "quality" : id === "subtitles" ? subtitleEntry() : id === "diagnostics" ? "send-diagnostics" : "acknowledgements"; render(rowFocus()); });
            const icon = el("span", "settings-category-icon");
            icon.append(navigationIcon(CATEGORY_ICONS[id]));
            const detail = id === "diagnostics" ? DIAGNOSTICS_DETAIL : translate(CATEGORY_DETAILS[id]);
            const copy = el("span", "settings-category-copy");
            copy.append(el("span", "settings-category-title", translate(CATEGORY_LABELS[id])), el("span", "settings-category-detail", detail));
            item.element.replaceChildren(icon, copy);
            item.element.setAttribute("aria-label", `${translate(CATEGORY_LABELS[id])}, ${detail}`);
            item.element.setAttribute("aria-current", id === category ? "page" : "false");
            item.element.addEventListener("focus", () => { if (category !== id) { category = id; render({ zone: "settings-categories", key: id }); } });
            return item;
        });
        if (actions !== undefined) {
            const account = session.account?.role === "admin" ? translate("settings.account.administrator") : actions.accountName?.trim() || translate("settings.account.signedIn");
            const profile = actionButton("settings-profile", actions.profileName, () => { destroy(); actions.switchProfile(); });
            profile.element.classList.add("settings-profile");
            const copy = el("span", "settings-profile-copy");
            copy.append(el("span", "settings-profile-name", actions.profileName), el("span", "settings-profile-account", account));
            profile.element.replaceChildren(profileMenuAvatar(actions.profileName, actions.profileAvatarUrl, actions.profileAvatarText, session.http.base.baseUrl, 68), copy, settingsChevron());
            profile.element.setAttribute("aria-label", `${actions.profileName}, ${account}`);
            categories.unshift(profile);
            if (actions.signOut !== undefined) {
                const signOut = actionButton("settings-signout", translate("settings.signOut"), () => { confirmingSignOut = true; render({ zone: "settings-confirm", key: "cancel-signout" }); });
                signOut.element.classList.add("settings-signout");
                const icon = el("span", "settings-signout-icon");
                icon.append(navigationIcon("signout")); signOut.element.prepend(icon);
                categories.push(signOut);
            }
        }
        const rows: FocusItem[] = [];
        const body = el("div", "settings-pane");
        body.dataset.scrollKey = `settings-pane:${category}`;
        const header = el("div", "settings-pane-header");
        const tile = el("span", "settings-header-icon"); tile.append(navigationIcon(CATEGORY_ICONS[category]));
        const headerCopy = el("div", ""); headerCopy.append(el("h2", "browse-section-title", translate(CATEGORY_LABELS[category])), el("p", "settings-blurb", category === "diagnostics" ? DIAGNOSTICS_BLURB : translateTv(CATEGORY_BLURBS[category])));
        header.append(tile, headerCopy);
        body.append(header, ...feedback());
        if (category === "playback") connection.watch();
        else connection.unwatch();
        const pickers: readonly Picker[] = category === "playback" ? ["quality", "bitrate", "audio", "seek-back", "seek-forward"] : [];
        const info = (title: string, value: string): HTMLElement => {
            const row = el("div", "settings-info-row"); row.append(el("span", "", title), el("span", "settings-row-value", value)); return row;
        };
        if (category === "diagnostics") {
            const snapshot = diagnosticsCollector.snapshot();
            const send = actionButton("send-diagnostics", "Send Diagnostics Report", () => {
                if (!diagnosticsCollector.hasReportableData()) {
                    diagnosticsStatus = { kind: "ok", text: "Play something or reproduce an issue first, or use Share via QR Code." };
                    render({ zone: "settings-rows", key: "send-diagnostics" });
                    return;
                }
                confirmingDiagnosticsSend = true;
                render();
            });
            send.element.classList.add("settings-server-action");
            send.element.prepend(navigationIcon("requests"));
            send.element.appendChild(navigationIcon("chevron-right"));
            const share = actionButton("share-diagnostics", "Share via QR Code", () => { diagnosticsQr = true; render(); });
            share.element.classList.add("settings-server-action");
            share.element.prepend(navigationIcon("diagnostics"));
            share.element.appendChild(navigationIcon("qr"));
            const autoOn = diagnosticsCollector.autoReportEnabled;
            const autoToggle = button("auto-diagnostics", "Automatic Error Reports", () => {
                diagnosticsCollector.setAutoReportEnabled(!diagnosticsCollector.autoReportEnabled);
                render({ zone: "settings-rows", key: "auto-diagnostics" });
            });
            autoToggle.element.appendChild(el("span", "settings-row-value", onOffText(autoOn)));
            autoToggle.element.setAttribute("role", "switch");
            autoToggle.element.setAttribute("aria-label", "Automatic Error Reports");
            autoToggle.element.setAttribute("aria-checked", String(autoOn));
            const clear = actionButton("clear-diagnostics", "Clear Session Log", () => { diagnosticsCollector.clear(); diagnosticsStatus = { kind: "ok", text: "Session log cleared." }; render({ zone: "settings-rows", key: "send-diagnostics" }); });
            clear.element.classList.add("settings-server-action");
            clear.element.prepend(navigationIcon("reset"));
            rows.push(send, share, autoToggle, clear);
            body.append(
                send.element,
                share.element,
                autoToggle.element,
                el("p", "settings-value", "Automatically sends a redacted report on fatal playback errors or crashes (at most once per issue)."),
                clear.element,
            );
            if (diagnosticsStatus !== undefined) {
                const note = el("p", diagnosticsStatus.kind === "error" ? "browse-text browse-error settings-warning" : "settings-value", diagnosticsStatus.text);
                note.setAttribute("role", diagnosticsStatus.kind === "error" ? "alert" : "status");
                body.appendChild(note);
            }
            const deviceText = formatDeviceDetails({
                v: 1,
                app: snapshot.device.appVersion,
                tv: snapshot.device.tvModel,
                ...(snapshot.device.firmware === undefined ? {} : { fw: snapshot.device.firmware }),
                ...(snapshot.device.tizenVersion === undefined ? {} : { os: snapshot.device.tizenVersion }),
                ...(snapshot.device.browser === undefined ? {} : { ua: snapshot.device.browser }),
                ...(snapshot.device.screen === undefined ? {} : { scr: snapshot.device.screen }),
            });
            body.append(
                el("h3", "settings-section-header", "DEVICE"),
                info("TV", deviceText),
                info("Auger Version", snapshot.device.appVersion),
                ...(snapshot.device.serverVersion === undefined ? [] : [info("Silo Server", snapshot.device.serverVersion)]),
                ...(snapshot.device.hdrSupported === undefined ? [] : [info("HDR Support", snapshot.device.hdrSupported ? "Yes" : "No")]),
                ...(snapshot.device.memory === undefined ? [] : [info("JS Heap", snapshot.device.memory)]),
                ...(snapshot.device.deviceRam === undefined ? [] : [info("Device RAM", snapshot.device.deviceRam)]),
                ...(snapshot.device.uptimeMinutes === undefined ? [] : [info("Uptime", `${snapshot.device.uptimeMinutes}m`)]),
            );
            body.append(el("h3", "settings-section-header", "LAST PLAYBACK"));
            const last = snapshot.lastPlayback;
            if (last === undefined) {
                body.appendChild(el("p", "settings-value", "No playback recorded yet in this session."));
            } else {
                if (last.playback !== undefined) body.appendChild(info("Playback", last.playback));
                if (last.delivery !== undefined) body.appendChild(info("Delivery", last.delivery));
                if (last.stream !== undefined) body.appendChild(info("Stream", last.stream));
                if (last.source !== undefined) body.appendChild(info("Source file", last.source));
                if (last.video !== undefined) body.appendChild(info("Video", last.video));
                if (last.dynamicRange !== undefined) body.appendChild(info("Dynamic range", last.dynamicRange));
                if (last.audio !== undefined) body.appendChild(info("Audio", last.audio));
                if (last.subtitles !== undefined) body.appendChild(info("Subtitles", last.subtitles));
                if (last.subtitleDetail !== undefined) body.appendChild(info("Subtitle mode", last.subtitleDetail));
                if (last.position !== undefined) body.appendChild(info("Position", last.position));
                if (last.rebuffers !== undefined && last.rebuffers > 0) body.appendChild(info("Rebuffers", String(last.rebuffers)));
                if (last.status !== undefined) body.appendChild(info("Status", last.status));
                if (last.diagnostics !== undefined && last.diagnostics.length > 0) body.appendChild(info("Diagnostics", last.diagnostics.join(" · ")));
                if (last.error !== undefined) body.appendChild(info("Last error", last.error));
            }
            body.append(el("h3", "settings-section-header", "SESSION LOG"));
            if (snapshot.events.length === 0) {
                body.appendChild(el("p", "settings-value", "No events recorded yet."));
            } else {
                body.appendChild(info("Recorded events", String(snapshot.events.length)));
                for (const event of snapshot.events.slice(-4)) {
                    body.appendChild(el("p", "settings-value", `${event.at} [${event.kind}] ${event.text}`));
                }
            }
        }
        if (category === "server") {
            body.append(el("h3", "settings-section-header", translate("settings.activeServer.headerTv")), info(translate("settings.activeServer.server"), actions?.serverName ?? session.http.base.baseUrl));
            // TVSettingsView.swift:514-517: Address only when the Server row shows a name, not the URL itself.
            const address = session.http.base.baseUrl;
            if (address !== "" && (actions?.serverName ?? address) !== address) body.append(info(translate("settings.activeServer.address"), address));
            const policy = actionButton("privacy", translate("settings.about.privacyPolicy"), () => { privacy = true; render(); });

            if (accounts) {
                const item = actionButton("accounts", translate("accounts.title"), () => {
                    host.stop(); container.hidden = true;
                    accounts(() => {
                        if (torn) return;
                        container.hidden = false; host.listen();
                        category = "general"; returnRow = "acknowledgements";
                        render({ zone: "settings-categories", key: "general" });
                    });
                });
                rows.push(item); body.append(item.element);
            }
            if (accounts === undefined && actions?.switchServer !== undefined) {
                const manage = actionButton("manage-servers", translate("servers.manage.title"), () => {
                    host.stop(); container.hidden = true;
                    actions.switchServer?.(() => {
                        if (torn) return;
                        container.hidden = false; host.listen();
                        render({ zone: "settings-rows", key: "manage-servers" });
                    });
                });
                rows.push(manage); body.appendChild(manage.element);
            }
            // Apple's Server pane: an ABOUT section whose Acknowledgements row opens the credits.
            const item = actionButton("acknowledgements", translate("settings.about.acknowledgements"), () => { acknowledging = true; returnRow = "acknowledgements"; render(); });
            const hidden = state.effective.get(HIDDEN_KEY)?.value;
            if (Array.isArray(hidden) && hidden.length > 0) {
                const restore = button("restore-libraries", "Restore All Libraries", () => { void state.save(HIDDEN_KEY, []); });
                rows.push(restore); body.appendChild(restore.element);
            }
            body.append(el("h3", "settings-section-header", translate("settings.about.headerTv")), info(translate("settings.about.appVersion"), APP_VERSION), policy.element, item.element);
            rows.push(policy);
            rows.push(item);
        }
        if (category === "general" && launch !== undefined && actions?.switchProfile !== undefined) {
            const item = actionButton("paired-profile", translate("settings.general.pairedProfile"), () => { destroy(); actions.switchProfile(); });
            item.element.append(el("span", "settings-row-value", pairedProfileLabel(launch.rememberedProfileId, session.activeProfile?.id, actions.profileName)), settingsChevron());
            rows.push(item);
            body.append(el("h3", "settings-section-header", translateTv("settings.general.appleTvUserHeaderTv")), item.element, el("p", "settings-value", pairedProfileDescription(launch.behavior === "askEveryLaunch")));
        }
        if (category === "general" && launch !== undefined) {
            const item = actionButton("remember-profile", translate("settings.control.profileSelection"), () => { choosingLaunch = true; render(); });
            item.element.append(el("span", "settings-row-value", translate(LAUNCH_CHOICES.find(([value]) => value === launch.behavior)?.[1] ?? "settings.profileLaunch.askEveryLaunch")), settingsChevron());
            item.element.setAttribute("aria-disabled", String(launchPending));
            rows.push(item);
            body.append(el("h3", "settings-section-header", translate("settings.general.profileAtLaunchHeaderTv")), item.element, el("p", "settings-value", profileSelectionCaption(launch.behavior)));
            if (launchError) {
                const error = el("p", "browse-text browse-error settings-warning", "Could not save the launch choice.");
                error.setAttribute("role", "alert");
                body.appendChild(error);
                const retry = actionButton("retry-launch", "Retry launch choice", () => saveLaunch(launchTarget));
                rows.push(retry); body.appendChild(retry.element);
            }
        }
        // As Apple reads when Settings opens, but only once this screen's own load has settled, pass or fail, so the two capability reads never race.
        if (!state.busy && (state.loaded || state.error !== undefined) && !languageRead) { languageRead = true; void appLanguage?.refresh(); }
        if (category === "general" && appLanguage?.isOffered === true) {
            const item = actionButton("app-language", translate("settings.appLanguage.title"), () => { choosingLanguage = true; render(); });
            item.element.append(el("span", "settings-row-value", appLanguage.selectedLabel), settingsChevron());
            rows.push(item);
            body.append(el("h3", "settings-section-header", translate("settings.appLanguage.headerTv")), item.element, el("p", "settings-value", appLanguage.footer));
            if (appLanguage.error !== undefined) body.appendChild(el("p", "settings-value", appLanguage.error));
        }
        const titleArt = state.effective.get(TITLE_ART_KEY);
        if (category === "general" && state.loaded && titleArt !== undefined) {
            body.appendChild(el("h3", "settings-section-header", translate("settings.general.titlePagesHeaderTv")));
            const all = titleArt.source === "profile";
            for (const [key, text, checked, action] of [
                ["title-art", translate("settings.control.titleArt"), titleArt.value === true, () => { void state.save(TITLE_ART_KEY, titleArt.value !== true); }],
                ["title-art-all", translate("settings.interface.applyToAllDevices"), all, () => { void state.setTitleArtScope(!all); }],
            ] as const) {
                const item = button(key, text, action);
                item.element.appendChild(el("span", "settings-row-value", onOffText(checked)));
                item.element.setAttribute("role", "switch");
                item.element.setAttribute("aria-label", text);
                item.element.setAttribute("aria-checked", String(checked));
                rows.push(item);
                body.appendChild(item.element);
            }
            body.appendChild(el("p", "settings-value", translateTv(all
                ? titleArt.value === true ? "settings.general.titleArtAllOnTv" : "settings.general.titleArtAllOffTv"
                : "settings.general.titleArtThisAppleTv")));
        }
        if (category === "general" && state.loaded && themeMusic?.isOffered === true) {
            body.appendChild(el("h3", "settings-section-header", translate("settings.general.themeMusicHeaderTv")));
            for (const [key, text, checked, action, enabled] of [
                ["theme-music", translate("settings.control.themeMusic"), themeMusic.playsThemeMusic, () => themeMusic.setEnabled(!themeMusic.playsThemeMusic), themeMusic.allowsEditing],
                ["theme-music-loop", translate("settings.control.themeMusicLoop"), themeMusic.loops, () => themeMusic.setLoop(!themeMusic.loops), themeMusic.allowsEditing && themeMusic.playsThemeMusic],
            ] as const) {
                const item = button(key, text, () => { if (enabled) action(); });
                item.element.appendChild(el("span", "settings-row-value", onOffText(checked)));
                item.element.setAttribute("role", "switch");
                item.element.setAttribute("aria-label", text);
                item.element.setAttribute("aria-checked", String(checked));
                if (!enabled) item.element.setAttribute("aria-disabled", "true");
                rows.push(item);
                body.appendChild(item.element);
            }
            body.appendChild(el("p", "settings-value", translateTv("settings.general.themeMusicFooterTv")));
            if (themeMusic.error !== undefined) body.appendChild(el("p", "settings-value", themeMusic.error));
        }
        for (const id of pickers) {
            if (id === "seek-back" || id === "seek-forward") continue;
            const key = PICKER_KEYS[id];
            if (!state.loaded || !state.definitions.some(def => def.key === key)) continue;
            if (id === "quality") body.appendChild(el("h3", "settings-section-header", translate("settings.playback.tvHeader.quality")));
            if (id === "audio") body.appendChild(streamingHeader());
            const item = button(id, pickerLabel(id), () => openPicker(id));
            const value = state.effective.get(key)?.value ?? null;
            const displayValue = key === BITRATE_KEY ? bitrateLabel(typeof value === "number" ? value : null) : label(value, key);
            item.element.replaceChildren(el("span", "settings-row-title", pickerLabel(id)), el("span", "settings-row-value", displayValue), settingsChevron());
            rows.push(item);
            body.append(item.element);
        }
        // TVPlaybackSettingsView.swift:60-120: Resolution, Maximum Bitrate, the buffering row, the learned limit, then one footer.
        const bufferingRow = category === "playback" && state.loaded ? settingsRows("playback", state).find(row => row.id === BUFFERING_ROW_ID) : undefined;
        if (bufferingRow !== undefined) {
            const mode = rowValue(bufferingRow, state);
            const item = button(BUFFERING_ROW_ID, bufferingQualityTitle(), () => { extraPicker = bufferingRow; render(); });
            item.element.replaceChildren(el("span", "settings-row-title", bufferingQualityTitle()), el("span", "settings-row-value", bufferingQualityModes().find(([value]) => value === mode)?.[1] ?? translate("settings.bufferingQuality.always")), settingsChevron());
            rows.push(item);
            beforeStreaming(body, [item.element]);
        }
        // The server's default mode is Automatically; Never ignores the limit (SettingsViewModel.learnedConnectionLimitText).
        const learned = category === "playback" && state.effective.get(BUFFERING_MODE_KEY)?.value !== "never" ? connection.learnedLimit : undefined;
        if (learned !== undefined) {
            const text = learnedLimitText(learned);
            const item = button("learned-limit", text, () => {
                void connection.resetLearnedLimit().then(cleared => {
                    if (!cleared || torn) return;
                    // The row is gone, so focus moves to the row above it only if it is still on Reset (TVPlaybackSettingsView.swift:116-124).
                    const focused = host.focused();
                    render(focused?.key === "learned-limit" ? { zone: "settings-rows", key: bufferingRow === undefined ? "bitrate" : BUFFERING_ROW_ID } : focused);
                });
            });
            item.element.replaceChildren(el("span", "settings-row-title", text), el("span", "settings-row-value", translate("settings.learnedLimit.reset")));
            item.element.classList.add("settings-learned-limit");
            rows.push(item);
            beforeStreaming(body, [item.element]);
        }
        if (category === "playback" && state.loaded && state.definitions.some(def => def.key === QUALITY_KEY)) {
            const resolution = state.effective.get(QUALITY_KEY)?.value;
            const bitrate = state.effective.get(BITRATE_KEY)?.value;
            beforeStreaming(body, [el("p", "settings-value settings-quality-footer", qualityFooter(typeof resolution === "string" ? resolution : null, typeof bitrate === "number" ? bitrate : null, bufferingRow !== undefined))]);
        }
        if (category === "playback" && connection.learnedResetError !== undefined) {
            const warning = el("p", "browse-text browse-error settings-warning", connection.learnedResetError);
            warning.setAttribute("role", "alert");
            beforeStreaming(body, [warning]);
        }
        const speed = category === "playback" ? connection.view : undefined;
        if (speed !== undefined) {
            const item = button("connection-speed", translate("settings.connection.speed"), () => connection.test());
            const copy = el("span", "settings-connection-copy");
            copy.append(el("span", "settings-row-title", translate("settings.connection.speed")), el("span", "settings-connection-line", speed.line));
            item.element.replaceChildren(copy, ...(speed.action === undefined ? [] : [el("span", "settings-row-value", speed.action)]));
            item.element.classList.add("settings-connection-speed");
            if (speed.disabled) item.element.setAttribute("aria-disabled", "true");
            if (speed.testing) item.element.setAttribute("aria-busy", "true");
            const nodes: HTMLElement[] = [el("h3", "settings-section-header", translate("settings.playback.tvHeader.connection")), item.element];
            // Never ignores the limit the server's budget counts, so Apple drops the sentence (SettingsViewModel.swift:626-632).
            const ignoresLimit = state.effective.get(BUFFERING_MODE_KEY)?.value === "never" && connection.learnedLimit !== undefined;
            if (speed.budget !== undefined && !ignoresLimit) nodes.push(el("p", "settings-value settings-connection-budget", speed.budget));
            if (speed.message !== undefined) {
                const warning = el("p", "browse-text browse-error settings-warning", speed.message);
                warning.setAttribute("role", "alert");
                nodes.push(warning);
            }
            beforeStreaming(body, nodes);
            rows.push(item);
        }
        if (category === "subtitles" && state.loaded) {
            const language = state.definitions.some(def => def.key === SUBTITLE_LANGUAGE_KEY);
            const mode = state.definitions.some(def => def.key === SUBTITLE_MODE_KEY);
            const forced = state.definitions.some(def => def.key === SHOW_FORCED_KEY);
            if (language || mode || forced) {
                body.appendChild(el("h3", "settings-section-header", translate("settings.subtitles.tvHeader.profile")));
                if (language) rows.push(subtitlePicker("subtitle-language", state.subtitleProfileValue(SUBTITLE_LANGUAGE_KEY)));
                if (mode) rows.push(subtitlePicker("subtitle-mode", state.subtitleProfileValue(SUBTITLE_MODE_KEY)));
                if (forced) {
                    const on = state.subtitleProfileValue(SHOW_FORCED_KEY) === true;
                    const item = button("subtitle-forced", translate("settings.control.forced"), () => { void state.save(SHOW_FORCED_KEY, !on); });
                    item.element.appendChild(el("span", "settings-row-value", onOffText(on)));
                    item.element.setAttribute("role", "switch");
                    item.element.setAttribute("aria-label", translate("settings.control.forced"));
                    item.element.setAttribute("aria-checked", String(on));
                    rows.push(item);
                }
                for (const item of rows) body.appendChild(item.element);
                body.appendChild(el("p", "settings-value", translate("settings.subtitles.languageFooter")));
                const override = subtitleOverride(state);
                if (override !== undefined) body.appendChild(el("p", "settings-value", translate("settings.subtitles.overrideActive", { message: override })));
            }
        }
        if (state.loaded) {
            if (category === "general") body.appendChild(el("h3", "settings-section-header", translate("settings.general.cardsHeaderTv")));
            if (category === "playback") {
                if (state.definitions.some(def => def.key === HDR_KEY)) {
                    const hdrOn = state.effective.get(HDR_KEY)?.value === true;
                    const item = hdrSwitch("hdr", translate("settingsManifest.player.hdr_enabled.label"), hdrOn, () => { void state.save(HDR_KEY, !hdrOn); });
                    rows.push(item);
                    body.appendChild(item.element);
                    body.appendChild(el("p", "settings-value settings-hdr-footer", HDR_FOOTER));
                }
                body.appendChild(el("h3", "settings-section-header", translate("settings.playback.tvHeader.episodes")));
            }
            for (const row of settingsRows(category, state).filter(row => row.id !== BUFFERING_ROW_ID)) {
                if (row.id === "metadata-language") body.appendChild(el("h3", "settings-section-header", translate("settings.subtitles.tvHeader.metadata")));
                const unsettled = row.member === undefined ? actions?.playerSettings?.unsettledValue(row.key) : undefined;
                const value = unsettled !== undefined ? unsettled : rowValue(row, state);
                const item = button(row.id, row.title, () => {
                    if (row.id === "poster-size" && state.effective.get(row.key)?.source === "profile_device") return;
                    if (row.id === "advisory-age" || row.member === "textOutline") { void state.save(row.key, rowEdit(row, value !== true, state)); return; }
                    extraPicker = row; render();
                });
                const outlineOff = row.member === "textOutlineColor" && rowValue({ ...row, member: "textOutline" }, state) !== true;
                const backgroundOff = (row.member === "backgroundOpacity" || row.member === "backgroundColor") && rowValue({ ...row, member: "backgroundStyle" }, state) !== "box";
                item.element.appendChild(el("span", "settings-row-value", outlineOff || backgroundOff ? "—" : row.choices.find(([choice]) => choice === value)?.[1] ?? String(value)));
                if (row.id !== "advisory-age" && row.member !== "textOutline") item.element.appendChild(settingsChevron());
                if (row.id === "advisory-age" || row.member === "textOutline") { item.element.setAttribute("role", "switch"); item.element.setAttribute("aria-label", row.title); item.element.setAttribute("aria-checked", String(value === true)); }
                rows.push(item); body.appendChild(item.element);
                if (row.id === "advisory-age") body.appendChild(el("p", "settings-value", translate("settings.general.showAdvisoryAgeFooter")));
                if (row.id === "metadata-language") body.appendChild(el("p", "settings-value", translate("settings.metadataLanguageNote")));
                if (row.id === "poster-size" && state.client.get(row.key)?.isSet) {
                    const inherited = button("poster-profile-default", translate("settings.cards.useProfileDefault"), () => { void state.reset(row.key); });
                    rows.push(inherited); body.appendChild(inherited.element);
                }
                if (row.id === "poster-size" && state.effective.get(row.key)?.source === "profile_device") {
                    item.element.setAttribute("aria-disabled", "true");
                    const synced = button("use-synced-tv", translate("settings.general.useSyncedTvSettings"), () => { void state.resetPosterDevice(); });
                    rows.push(synced); body.appendChild(synced.element);
                }
                if (row.id === "poster-size") body.appendChild(el("p", "settings-value", translate("settings.general.posterSizeSyncsTv")));
                if (category === "playback" && row.id === "auto-next" && actions?.stillWatching !== undefined) {
                    const stillTitle = translate("settingsManifest.player.passout_threshold.label");
                    const stillItem = button("still-watching", stillTitle, () => { choosingStillWatching = true; render(); });
                    stillItem.element.replaceChildren(el("span", "settings-row-title", stillTitle), el("span", "settings-row-value", stillWatchingLabel(actions.stillWatching.value)), settingsChevron());
                    rows.push(stillItem);
                    body.appendChild(stillItem.element);
                }
            }
            if (category === "playback" && actions?.stillWatching !== undefined && !rows.some(item => item.key === "still-watching")) {
                const stillTitle = translate("settingsManifest.player.passout_threshold.label");
                const stillItem = button("still-watching", stillTitle, () => { choosingStillWatching = true; render(); });
                stillItem.element.replaceChildren(el("span", "settings-row-title", stillTitle), el("span", "settings-row-value", stillWatchingLabel(actions.stillWatching.value)), settingsChevron());
                rows.push(stillItem);
                body.appendChild(stillItem.element);
            }
            if (category === "playback") {
                if (spoilers?.showsSettings === true) {
                    body.appendChild(el("h3", "settings-section-header", translate("settings.playback.tvHeader.spoilers")));
                    for (const [key, text, checked, setting] of [
                        ["spoiler-images", translate("settingsManifest.catalog.hide_unwatched_episode_images.label"), spoilers.settings.hidesImages, "images"],
                        ["spoiler-overviews", translate("settingsManifest.catalog.hide_unwatched_episode_overviews.label"), spoilers.settings.hidesOverviews, "overviews"],
                    ] as const) {
                        const item = button(key, text, () => spoilers.toggle(setting));
                        item.element.appendChild(el("span", "settings-row-value", onOffText(checked)));
                        item.element.setAttribute("role", "switch");
                        item.element.setAttribute("aria-label", text);
                        item.element.setAttribute("aria-checked", String(checked));
                        const unavailable = item.element.getAttribute("aria-disabled") === "true" || !spoilers.allowsEditing;
                        item.element.setAttribute("aria-disabled", String(unavailable));
                        rows.push(item);
                        body.appendChild(item.element);
                    }
                    body.appendChild(el("p", "settings-value", spoilers.footer));
                }
                const playerSettings = actions?.playerSettings;
                if (playerSettings !== undefined && playerSettings.heldKeys.length > 0) {
                    const retryHeld = actionButton("held-retry", translate("settings.heldChange.tryAgain"), () => {
                        if (heldBusy || state.busy) return;
                        heldBusy = true;
                        heldDiscardFailed = false;
                        render({ zone: "settings-rows", key: "held-retry" });
                        void playerSettings.retryHeldChanges().then(() => {
                            if (torn) return;
                            heldBusy = false;
                            if (playerSettings.heldKeys.length === 0) void state.load();
                            else render({ zone: "settings-rows", key: "held-retry" });
                        });
                    });
                    retryHeld.element.classList.add("settings-held-action");
                    retryHeld.element.prepend(navigationIcon("reset"));
                    const discardHeld = actionButton("held-discard", translate("settings.heldChange.discard"), () => {
                        if (heldBusy || state.busy) return;
                        heldBusy = true;
                        heldDiscardFailed = false;
                        render({ zone: "settings-rows", key: "held-discard" });
                        void playerSettings.discardHeldChanges().then(discarded => {
                            if (torn) return;
                            heldBusy = false;
                            heldDiscardFailed = !discarded;
                            if (discarded) void state.load();
                            else render({ zone: "settings-rows", key: "held-discard" });
                        });
                    });
                    discardHeld.element.classList.add("settings-destructive");
                    discardHeld.element.prepend(navigationIcon("xmark-circle"));
                    if (heldBusy || state.busy) {
                        retryHeld.element.setAttribute("aria-disabled", "true");
                        discardHeld.element.setAttribute("aria-disabled", "true");
                    }
                    const warning = el("p", "browse-text browse-error settings-warning", heldDiscardFailed ? HELD_DISCARD_NEEDS_SERVER_MESSAGE : HELD_CHANGE_MESSAGE);
                    warning.setAttribute("role", "alert");
                    rows.push(retryHeld, discardHeld);
                    body.append(el("h3", "settings-section-header", translate("settings.heldChange.headerTv")), retryHeld.element, discardHeld.element, warning);
                }
                // Apple TVPlaybackSettingsView: a Video group, then an Audiobooks group, each offered only with its pair. The Video help line is Android TV's
                // `footerVideo`, not Apple TV's `footerVideoAppleTv`, which names the Siri Remote that a Samsung TV does not have.
                const skipGroups = [
                    { header: translate("settings.playback.tvHeader.video"), ids: ["seek-back", "seek-forward"], footer: translate("settings.skipIntervals.footerVideo") },
                    { header: translate("settings.playback.tvHeader.audiobooks"), ids: ["audiobook-seek-back", "audiobook-seek-forward"], footer: translate("settings.skipIntervals.footerAudiobook") },
                ] as const;
                for (const group of skipGroups) {
                    const skipRows = group.ids.filter(id => state.definitions.some(def => def.key === PICKER_KEYS[id]));
                    if (skipRows.length === 0) continue;
                    body.appendChild(el("h3", "settings-section-header", group.header));
                    for (const id of skipRows) {
                        const item = button(id, pickerLabel(id), () => openPicker(id));
                        item.element.replaceChildren(el("span", "settings-row-title", pickerLabel(id)), el("span", "settings-row-value", label(state.effective.get(PICKER_KEYS[id])?.value ?? (id.endsWith("back") ? 10 : 30), PICKER_KEYS[id])), settingsChevron());
                        rows.push(item); body.appendChild(item.element);
                    }
                    body.appendChild(el("p", "settings-value", group.footer));
                }
                const playbackKeys = devicePlaybackKeys();
                if (playbackKeys.some(key => state.scope(key) === "profile_device")) {
                    const reset = button("reset-playback", translate("settings.profileSettings.useAll"), () => { confirmingPlaybackReset = true; render(); });
                    reset.element.classList.add("settings-destructive");
                    reset.element.prepend(navigationIcon("reset"));
                    rows.push(reset);
                    body.append(el("h3", "settings-section-header", translate("settings.playback.tvHeader.reset")), reset.element, el("p", "settings-value", translateTv("settings.profileSettings.resetFooterAppleTv")));
                }
            }
            if (category === "subtitles" && state.definitions.some(def => def.key === APPEARANCE_KEY)) {
                const preview = el("div", "settings-subtitle-preview");
                const text = el("span", "", translate("player.subtitles.previewSample"));
                preview.appendChild(text);
                const stored = state.stored(APPEARANCE_KEY);
                const appearance = decodeAppearance({ profile_id: "preview", effective_value: JSON.stringify(stored?.isSet ? stored.value : {}) }, "preview");
                // The preview is laid out by flexbox, so it ignores the top and bottom this also sets for the player.
                applySubtitleAppearance(preview, text, appearance);
                text.style.fontSize = subtitleFontSize(appearance, 0.5);
                text.style.fontWeight = "600";
                text.style.padding = appearance.backgroundStyle === "box" ? "4px 10px" : "0";
                text.style.borderRadius = "4px";
                preview.style.alignItems = appearance.position === "top" ? "flex-start" : "flex-end";
                preview.style.paddingBlock = appearance.position === "lower-third" ? "33px" : "12px";
                body.appendChild(preview);
                const reset = button("reset-appearance", translate("settings.subtitles.resetAppearance"), () => { confirmingAppearanceReset = true; render(); });
                rows.push(reset); body.append(reset.element, el("p", "settings-value settings-appearance-footer", `${state.scope(APPEARANCE_KEY) === "profile_device" ? translateTv("settings.subtitles.scopeDeviceOnlyAppleTv") : translate("settings.subtitles.scopeProfile")} ${translate("settings.subtitles.authoredStyle")}`));
                if (state.definitions.some(def => def.key === APPEARANCE_KEY && def.device)) {
                    const device = state.scope(APPEARANCE_KEY) === "profile_device";
                    const toggle = button("appearance-device", translateTv("settings.subtitles.onlyOnThisAppleTv"), () => { void state.setAppearanceDevice(!device); });
                    toggle.element.setAttribute("role", "switch"); toggle.element.setAttribute("aria-label", translateTv("settings.subtitles.onlyOnThisAppleTv")); toggle.element.setAttribute("aria-checked", String(device));
                    toggle.element.appendChild(el("span", "settings-row-value", onOffText(device)));
                    rows.push(toggle); body.appendChild(toggle.element);
                }
            }
        }
        if (category === "general" && actions?.showAudiobooks !== undefined) {
            // TVGeneralSettingsView TOP MENU: a client_local opt-in, stored on this TV per profile.
            const audiobooks = actions.showAudiobooks;
            const on = audiobooks.value;
            const item = button("show-audiobooks", translate("settings.experimental.showAudiobooks"), () => { audiobooks.set(!audiobooks.value); render({ zone: "settings-rows", key: "show-audiobooks" }); });
            item.element.appendChild(el("span", "settings-row-value", onOffText(on)));
            item.element.setAttribute("role", "switch");
            item.element.setAttribute("aria-label", translate("settings.experimental.showAudiobooks"));
            item.element.setAttribute("aria-checked", String(on));
            rows.push(item);
            body.append(el("h3", "settings-section-header", translate("settings.general.topMenuHeaderTv")), item.element, el("p", "settings-value", translate("settings.general.topMenuFooterTv")));
        }
        if (state.loaded && rows.length === 0) body.appendChild(el("p", "browse-text settings-empty", "No supported settings in this category."));
        if (category === "server") {
            for (const row of rows) {
                const icon = row.key === "accounts" ? "switch-profile" : row.key === "privacy" ? "privacy" : row.key === "acknowledgements" ? "credits" : "switch-server";
                row.element.classList.add("settings-server-action");
                row.element.prepend(navigationIcon(icon));
                row.element.appendChild(navigationIcon(row.key === "privacy" ? "qr" : row.key === "acknowledgements" ? "document" : "chevron-right"));
            }
        }
        // Apple's Server pane ends with EXTRA FEATURES: one On/Off row per experimental feature, off until chosen on this device.
        if (category === "server" && experimental !== undefined) {
            body.appendChild(el("h3", "settings-section-header", translate("settings.experimental.extraFeaturesHeaderTv")));
            for (const feature of EXPERIMENTAL_FEATURES) {
                const on = experimental.isEnabled(feature.id);
                const key = `experimental-${feature.id}`;
                const toggle = actionButton(key, translate(FEATURE_TITLES[feature.id]), () => { experimental.setEnabled(feature.id, !on); render({ zone: "settings-rows", key }); });
                toggle.element.setAttribute("role", "switch"); toggle.element.setAttribute("aria-label", translate(FEATURE_TITLES[feature.id])); toggle.element.setAttribute("aria-checked", String(on));
                toggle.element.appendChild(el("span", "settings-row-value", onOffText(on)));
                rows.push(toggle); body.appendChild(toggle.element);
            }
        }
        const retries = retryButton();
        rows.push(...retries);

        body.classList.add("settings-controls");
        const firstAppearance = body.querySelector('[data-focus^="appearance-"]');
        const preview = body.querySelector(".settings-subtitle-preview");
        const deviceToggle = body.querySelector('[data-focus="appearance-device"]');
        if (firstAppearance !== null && preview !== null) {
            body.insertBefore(el("h3", "settings-section-header", translate("settings.subtitles.tvHeader.appearance")), firstAppearance);
            body.insertBefore(preview, firstAppearance);
            if (deviceToggle !== null) body.insertBefore(deviceToggle, firstAppearance);
            const group = el("div", "settings-nested-group");
            body.insertBefore(group, firstAppearance);
            for (const row of rows.filter(item => item.key.startsWith("appearance-") && item.key !== "appearance-device" || item.key === "reset-appearance")) group.appendChild(row.element);
        }
        body.appendChild(zoneNode("settings-controls", retries));
        // Remote order follows the visible order, including connected Retry controls.
        rows.sort((a, b) => a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        const panes = el("div", "settings-panes");
        const rail = zoneNode("settings-categories", categories);
        rail.prepend(el("h1", "browse-title", translate("settings.title")));
        rail.appendChild(el("p", "settings-version", `Auger ${APP_VERSION}`));
        panes.append(rail, body);
        paneSnapshot = panes;
        host.show({ name: "settings", content: [panes], zones: [
            // The rail is a focus section too: Up at the profile card and Down at Sign Out stay in it.
            { id: "settings-categories", layout: "column", up: "settings-categories", down: "settings-categories", right: "settings-rows", items: categories },
            // A save in flight blocks every row's press, so only then do the rows stay reachable (Apple's view models ignore presses while saving).
            // Apple's panes are focus sections: Up at the first row and Down at the last stay in the pane, and only Left leaves it.
            { id: "settings-rows", layout: "column", left: "settings-categories", up: "settings-rows", down: "settings-rows", skipDisabled: !state.busy, items: rows },
        ], focus: { zone: "settings-categories", key: category }, back }, focus);
    }
    connection.start();
    host.listen();
    render();
    void state.load();
    return { destroy };
}

const SUBTITLE_OVERRIDE = { profile_client: "settings.profilePrefs.overrideFamily", profile_device: "settings.profilePrefs.overrideDevice", profile_library: "settings.profilePrefs.overrideLibrary", profile_series: "settings.profilePrefs.overrideSeries" } as const satisfies Readonly<Record<string, MessageKey>>;

function subtitleOverride(state: SettingsState): string | undefined {
    const scopes = new Set<string>();
    for (const key of [SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, SHOW_FORCED_KEY] as const) {
        const source = state.effective.get(key)?.source;
        if (source === undefined || source === "profile" || source === "account" || source === "default") continue;
        scopes.add(source);
    }
    if (scopes.size === 0) return undefined;
    if (scopes.size > 1) return translate("settings.profilePrefs.overrideSeveral");
    const [scope] = [...scopes];
    if (scope === undefined) return undefined;
    return translate(scope in SUBTITLE_OVERRIDE ? SUBTITLE_OVERRIDE[scope as keyof typeof SUBTITLE_OVERRIDE] : "settings.profilePrefs.overrideOther");
}

function streamingHeader(): HTMLElement {
    const header = el("h3", "settings-section-header", translate("settings.playback.tvHeader.streaming"));
    header.dataset.section = "streaming";
    return header;
}

/** Inserts nodes above the STREAMING header, or at the end when the pane has none. */
function beforeStreaming(body: HTMLElement, nodes: readonly HTMLElement[]): void {
    const streaming = [...body.children].find(node => node instanceof HTMLElement && node.dataset.section === "streaming");
    for (const node of nodes) {
        if (streaming !== undefined) body.insertBefore(node, streaming);
        else body.appendChild(node);
    }
}

function valueLabel(value: SettingValue, key: SettingsKey = AUDIO_KEY): string {
    if (key === BITRATE_KEY) return bitrateLabel(typeof value === "number" ? value : null);
    if (value === null) return key === HIDDEN_KEY ? "None hidden" : translate("settingsManifest.playback.audio_language.unsetLabel");
    if (Array.isArray(value)) return `${value.length} hidden`;
    if (typeof value === "object") return key === "ui.card_presentation" && "poster_size" in value ? String(value.poster_size) : "Custom appearance";
    return value === "x-silo-original" ? "Original language" : String(value);
}
