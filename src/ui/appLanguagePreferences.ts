// The profile's app language (`ui.app_language`), following silo-apple Networking/AppLanguagePreferences.swift
// and tvOS/Screens/Settings/TVGeneralSettingsView.swift. Null means Match Device. The choice is stored on the
// server for the profile; picking one also clears this TV's own value so the choice takes effect here.
// The row shows only an answer read from the server for the active profile. Each answer is also kept in public storage,
// per server and profile, and applied before the first screen draws on the next launch (Apple keeps the shown tag in
// `AppLanguage.displayedTag` for the same reason), so a screen is drawn once in the language it will keep.
// The stored choice sets the language the app shows (src/i18n/language.ts), which every request names in
// Accept-Language and the text of the screens that have moved onto the catalog. Tizen has no per-app system
// language (Apple also writes `AppleLanguages`) (see docs/settings.md).
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { settingsOperations } from "../api/settingsOperations.ts";
import { APP_LANGUAGE_KEY, type SettingsCapabilities } from "../contracts/v2/settings.ts";
import { languageEndonym, matchShipped, SHIPPED_LANGUAGES, setAppLanguage, shippedByName } from "../i18n/language.ts";
import { translate } from "../i18n/translate.ts";
import type { PublicStorage } from "../session/deviceIdentity.ts";
import type { NativeSession } from "../session/session.ts";
import { readSettingsCapability } from "./presentationSettings.ts";

/** Settings manifest revision that introduced the key (SettingKeyRevisions.swift). */
export const APP_LANGUAGE_INTRODUCED_IN = 28;

/** Where the last answer is kept: `scope` names the server (its id, never its address). */
export interface AppLanguageCache {
    readonly storage: PublicStorage;
    readonly scope: string;
}

/** What is kept is one language tag (empty for Match Device) under this key: no address, token or account. */
export function appLanguageCacheKey(scope: string, profileId: string): string {
    return `silo.appLanguage.choice:${JSON.stringify([scope, profileId])}`;
}

export interface AppLanguageChoice {
    /** Null: Match Device. */
    readonly tag: string | null;
    /** This TV's own row won, so the profile's value is hidden behind it. */
    readonly isDeviceValue: boolean;
}
export interface AppLanguageOption {
    readonly tag: string | null;
    readonly label: string;
}

export function appLanguageSettingsSupported(capability: SettingsCapabilities | undefined): boolean {
    if (capability === undefined) return false;
    return capability.apiVersion === 1
        && capability.state === "available"
        && capability.allowed
        && capability.supportsBatchedEffective
        && capability.manifestRevision >= APP_LANGUAGE_INTRODUCED_IN;
}

function isShipped(tag: string): boolean {
    return matchShipped(tag) !== undefined;
}

function writeFailure(error: unknown): string {
    if (error instanceof ApiError && (error.failure.kind === "network" || error.failure.kind === "timeout")) return translate("settings.appLanguage.saveFailedConnection");
    if (error instanceof ApiError && (error.status === 404 || error.status === 501 || error.problemId === "unknown_setting" || error.problemId === "server_upgrade_required" || error.problemId === "scope_not_allowed")) return translate("settings.appLanguage.saveUnsupported");
    return translate("settings.appLanguage.saveFailed");
}

export class AppLanguagePreferences {
    private readonly session: NativeSession;
    private readonly show: (tag: string | null) => void;
    private readonly cache: AppLanguageCache | undefined;
    private readonly listeners = new Set<() => void>();
    private readonly controller = new AbortController();
    private choice: AppLanguageChoice | undefined;
    /** The profile the answer belongs to; another profile's answer is never shown. */
    private profileId: string | undefined;
    private saving = false;
    private errorMessage: string | undefined;
    private published = "";
    private refreshSequence = 0;

    /** `show` applies the language the app shows; null is Match Device. */
    constructor(session: NativeSession, show: (tag: string | null) => void = setAppLanguage, cache?: AppLanguageCache) {
        this.session = session;
        this.show = show;
        this.cache = cache;
    }

    /** Shows the language kept from the last answer for this profile, before any request; false when none is kept. */
    applyCached(): boolean {
        const profileId = this.session.activeProfile?.id;
        if (this.cache === undefined || profileId === undefined) return false;
        let kept: string | null = null;
        try { kept = this.cache.storage.getItem(appLanguageCacheKey(this.cache.scope, profileId)); } catch { /* Storage refused: the answer arrives as before. */ }
        if (kept === null) return false;
        // This profile is the one shown, so the first read does not reset the language to the device's while it waits for the answer.
        this.profileId = profileId;
        this.show(kept === "" ? null : kept);
        return true;
    }

    private keep(choice: AppLanguageChoice | undefined): void {
        const profileId = this.profileId;
        if (this.cache === undefined || profileId === undefined) return;
        const key = appLanguageCacheKey(this.cache.scope, profileId);
        try {
            if (choice === undefined) this.cache.storage.removeItem(key);
            else this.cache.storage.setItem(key, choice.tag ?? "");
        } catch { /* The answer still shows; only the next launch loses it. */ }
    }

    /** The stored choice for the active profile; undefined hides the row. */
    get currentChoice(): AppLanguageChoice | undefined {
        return this.profileId !== undefined && this.profileId === this.session.activeProfile?.id ? this.choice : undefined;
    }
    get isOffered(): boolean { return this.currentChoice !== undefined; }
    /** A save is running: the picker takes no new choice. */
    get isBusy(): boolean { return this.saving; }
    get error(): string | undefined { return this.errorMessage; }

    /** Match Device, each shipped language by its own name in name order, and a stored tag this build lacks as itself, so re-saving never clears it. */
    get options(): readonly AppLanguageOption[] {
        const stored = this.currentChoice?.tag;
        const tags = stored !== undefined && stored !== null && !SHIPPED_LANGUAGES.includes(stored) ? [...shippedByName(), stored] : shippedByName();
        return [{ tag: null, label: translate("settings.appLanguage.option.matchDevice") }, ...tags.map(tag => ({ tag, label: languageEndonym(tag) }))];
    }
    get selectedLabel(): string {
        const tag = this.currentChoice?.tag;
        return tag === undefined || tag === null ? translate("settings.appLanguage.option.matchDevice") : languageEndonym(tag);
    }
    get footer(): string {
        const tag = this.currentChoice?.tag;
        return tag !== undefined && tag !== null && !isShipped(tag) ? translate("settings.appLanguage.unshippedFooter", { language: languageEndonym(tag) }) : translate("settings.appLanguage.footer");
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    stop(): void {
        this.controller.abort();
        this.listeners.clear();
    }

    /** Reads the server's answer for the active profile. Called at launch, on return to the foreground and when settings open. */
    async refresh(): Promise<void> {
        if (this.controller.signal.aborted) return;
        const profileId = this.session.activeProfile?.id;
        if (profileId === undefined) return;
        if (profileId !== this.profileId) {
            this.profileId = profileId;
            this.choice = undefined;
            this.errorMessage = undefined;
            this.publish();
        }
        const sequence = ++this.refreshSequence;
        try {
            const capability = await readSettingsCapability(spec => this.call(spec));
            if (!this.isCurrent(sequence)) return;
            if (!appLanguageSettingsSupported(capability)) {
                this.adopt(undefined);
                return;
            }
            await this.read(sequence);
        } catch (error) {
            // An unreachable server keeps the last answer for this profile; nothing new to read.
            if (error instanceof ApiError && error.aborted) return;
        }
    }

    /** Saves the profile's language (null: Match Device) and clears this TV's own value. */
    async select(tag: string | null): Promise<void> {
        const current = this.currentChoice;
        if (current === undefined || this.saving || (current.tag === tag && !current.isDeviceValue)) return;
        this.saving = true;
        this.errorMessage = undefined;
        // Reads already in flight answer for the state before this save.
        const sequence = ++this.refreshSequence;
        this.choice = { tag, isDeviceValue: false };
        this.publish();
        let failure: unknown;
        try {
            await this.call(settingsOperations.putSetting(APP_LANGUAGE_KEY, tag, "profile"), false);
            if (current.isDeviceValue) await this.clearDeviceValue();
        } catch (error) {
            if (this.controller.signal.aborted || (error instanceof ApiError && error.aborted)) return;
            failure = error;
        }
        this.saving = false;
        if (failure !== undefined) {
            this.choice = current;
            this.errorMessage = writeFailure(failure);
        }
        this.publish();
        // Success or not, show what the server now resolves: a failed step may have landed anyway.
        try { await this.read(sequence); } catch (error) { if (!(error instanceof ApiError && error.aborted)) this.publish(); }
    }

    private async clearDeviceValue(): Promise<void> {
        try {
            await this.call(settingsOperations.deleteSetting(APP_LANGUAGE_KEY, "profile_device"), false);
        } catch (error) {
            // Nothing stored for this TV: the profile's value already applies.
            if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
    }

    private async read(sequence: number): Promise<void> {
        const effective = await this.call(settingsOperations.effectiveSettings([APP_LANGUAGE_KEY]));
        if (!this.isCurrent(sequence) || this.saving) return;
        const row = effective.get(APP_LANGUAGE_KEY);
        if (row === undefined) return;
        this.adopt({ tag: typeof row.value === "string" ? row.value : null, isDeviceValue: row.source === "profile_device" });
    }

    private isCurrent(sequence: number): boolean {
        return !this.controller.signal.aborted && sequence === this.refreshSequence && this.profileId === this.session.activeProfile?.id;
    }

    private adopt(choice: AppLanguageChoice | undefined): void {
        this.choice = choice;
        this.keep(choice);
        this.publish();
    }

    private call<T>(spec: RequestSpec<T>, replayAfterRefresh = true): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh, signal: this.controller.signal });
    }

    private publish(): void {
        // No answer for this profile (another profile, an older server) shows the device's language.
        this.show(this.currentChoice?.tag ?? null);
        const snapshot = JSON.stringify({ choice: this.currentChoice, saving: this.saving, error: this.errorMessage });
        if (snapshot === this.published) return;
        this.published = snapshot;
        for (const listener of this.listeners) listener();
    }
}
