import type { Clock } from "../api/clock.ts";
import type { PlaybackPlan } from "../contracts/v2/playback.ts";
import { shownLocale } from "../i18n/format.ts";
import type { NativeSession } from "../session/session.ts";
import { SubtitleAI, type SubtitleAIView } from "./subtitleAI.ts";
import { aiMenu, aiRoute, hasActionableSource, quotaText, relyOnTranscription, type AIInputs, type AIMenu } from "./subtitleAIRoute.ts";
import { STORED, SubtitleSearch, type SubtitleSearchView } from "./subtitleSearch.ts";
import { SubtitleSync, type SubtitleSyncView } from "./subtitleSync.ts";
import { textSubtitle } from "./subtitleTransportRules.ts";
import type { AudioVersionSnapshot, PendingStoredTrack, SubtitleTrackViewSlice } from "./subtitleTypes.ts";

export type SearchAction =
    | { readonly kind: "search-open" }
    | { readonly kind: "search-language"; readonly code: string }
    | { readonly kind: "search-back" }
    | { readonly kind: "search-close" }
    | { readonly kind: "search-download"; readonly key: string }
    | { readonly kind: "search-retry" };

/**
 * Private internal coordinator behind `SubtitleSession` for per-file subtitle tools:
 * `SubtitleAI`, `SubtitleSearch`, and `SubtitleSync`.
 */
export class SubtitleTools {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    private readonly onChanged: () => void;
    private readonly onTimingChanged: (key: string) => void;
    private readonly onDownloaded: (id: string) => boolean;

    private readonly aiBlockedFiles = new Set<string>();
    private ai: SubtitleAI | undefined;
    private search: SubtitleSearch | undefined;
    private sync: SubtitleSync | undefined;
    private cachedAIMenu: { readonly key: string; readonly menu: AIMenu } | undefined;

    constructor(
        session: NativeSession,
        clock: Clock,
        onChanged: () => void,
        onTimingChanged: (key: string) => void,
        onDownloaded: (id: string) => boolean,
    ) {
        this.session = session;
        this.clock = clock;
        this.onChanged = onChanged;
        this.onTimingChanged = onTimingChanged;
        this.onDownloaded = onDownloaded;
    }

    get searchView(): SubtitleSearchView | undefined {
        return this.search?.view;
    }

    get syncView(): SubtitleSyncView | undefined {
        return this.sync?.view;
    }

    /** Rotates per-file AI/Search/Sync helpers on plan adoption; returns whether AI or Search file changed. */
    adoptFile(plan: PlaybackPlan): { readonly aiRotated: boolean; readonly searchRotated: boolean } {
        this.adoptSync(plan);
        let aiRotated = false;
        if (this.ai?.fileId !== plan.effectiveMediaFileId) {
            this.ai?.destroy();
            this.ai = new SubtitleAI(this.session, this.clock, plan.effectiveMediaFileId, () => this.onChanged(), this.aiBlockedFiles);
            aiRotated = true;
        }
        let searchRotated = false;
        if (this.search?.fileId !== plan.effectiveMediaFileId) {
            this.search?.destroy();
            this.search = new SubtitleSearch(this.session, plan.effectiveMediaFileId, id => this.onDownloaded(id), () => this.onChanged());
            void this.search.refresh();
            searchRotated = true;
        }
        return { aiRotated, searchRotated };
    }

    adoptSync(plan: PlaybackPlan): void {
        const keys = plan.subtitle.inventory.flatMap(track => track.syncKey === undefined || track.syncKey === "" ? [] : [track.syncKey]);
        if (this.sync !== undefined && this.sync.fileId !== plan.effectiveMediaFileId) {
            this.sync.destroy();
            this.sync = undefined;
        }
        if (keys.length === 0) return;
        if (this.sync === undefined) {
            this.sync = new SubtitleSync(
                this.session,
                this.clock,
                plan.effectiveMediaFileId,
                () => this.onChanged(),
                key => this.onTimingChanged(key),
            );
        } else if (keys.some(key => !this.sync?.knows(key))) {
            this.sync.reload();
        }
    }

    timingVersion(key: string | undefined): number {
        return key === undefined || key === "" ? 0 : this.sync?.timingVersion(key) ?? 0;
    }

    generatedLabel(syncKey: string | undefined): string | undefined {
        if (syncKey === undefined) return undefined;
        return this.ai?.view?.results.find(result => syncKey === `stored-${result.id}`)?.label;
    }

    hasAIResult(id: string): boolean {
        return this.ai?.view?.results.some(result => result.id === id) === true;
    }

    aiView(plan: PlaybackPlan): SubtitleAIView | undefined {
        const view = this.ai?.view;
        if (view === undefined || !plan.subtitle.inventory.some(entry => entry.unplayable === true)) return view;
        return {
            ...view,
            results: view.results.map(result =>
                plan.subtitle.inventory.some(entry => entry.syncKey === `stored-${result.id}` && entry.unplayable === true)
                    ? { ...result, unavailable: true }
                    : result),
        };
    }

    aiMenuView(plan: PlaybackPlan, shownSubtitleId: string | undefined, audioVersions: AudioVersionSnapshot): SubtitleTrackViewSlice["aiMenu"] {
        const inputs = this.aiInputs(plan, shownSubtitleId, audioVersions);
        const view = this.ai?.view;
        if (inputs === undefined || view === undefined) return undefined;
        const jobPanel = view.phase === "busy" || view.phase === "failed";
        if (!hasActionableSource(inputs)) {
            return jobPanel ? { menu: { detected: undefined, suggested: [], other: [] }, quota: undefined, quotaExhausted: inputs.quotaExhausted } : undefined;
        }
        const key = JSON.stringify([inputs, view.languages, view.preferred, shownLocale()]);
        if (this.cachedAIMenu?.key !== key) this.cachedAIMenu = { key, menu: aiMenu(inputs, view.languages, view.preferred) };
        const menu = this.cachedAIMenu.menu;
        if (menu.detected === undefined && menu.suggested.length === 0 && menu.other.length === 0 && !jobPanel) return undefined;
        const relies = relyOnTranscription(inputs, view.languages);
        const quota = view.quota?.used === undefined && view.quota !== undefined ? { ...view.quota, limit: undefined } : view.quota;
        return {
            menu,
            quota: relies ? quotaText(quota) ?? (inputs.quotaKnown ? undefined : "Transcription quota unavailable.") : undefined,
            quotaExhausted: inputs.quotaExhausted,
        };
    }

    startAI(plan: PlaybackPlan, shownSubtitleId: string | undefined, audioVersions: AudioVersionSnapshot, language: string, sourceSeconds: number): void {
        const inputs = this.aiInputs(plan, shownSubtitleId, audioVersions);
        const route = inputs === undefined ? undefined : aiRoute(inputs, language);
        if (route === undefined) return;
        void this.ai?.start({
            media_file_id: plan.effectiveMediaFileId,
            kind: route.kind,
            source_index: route.sourceIndex,
            source_language: route.sourceLanguage,
            target_language: route.targetLanguage,
            start_position: sourceSeconds,
        });
    }

    aiAction(action: "open" | "cancel" | "dismiss" | "discard"): void {
        if (action === "open") this.ai?.menuOpened();
        else if (action === "cancel") void this.ai?.cancel();
        else if (action === "dismiss") this.ai?.acknowledge();
        else this.ai?.discardHeld();
    }

    applySearch(action: SearchAction): void {
        switch (action.kind) {
            case "search-open": this.search?.open(); return;
            case "search-language": void this.search?.pick(action.code); return;
            case "search-back": this.search?.back(); return;
            case "search-close": this.search?.close(); return;
            case "search-download": void this.search?.download(action.key); return;
            case "search-retry": void this.search?.retry(); return;
            default: {
                const unexpected: never = action;
                return unexpected;
            }
        }
    }

    syncRequest(key: string): void {
        void this.sync?.request(key);
    }

    syncReset(key: string): void {
        void this.sync?.reset(key);
    }

    activateStored(plan: PlaybackPlan, stored: PendingStoredTrack, selectTrack: (trackId: string) => void): void {
        const track = plan.subtitle.inventory.find(entry => entry.syncKey === `stored-${stored.id}`);
        if (stored.kind === "ai") {
            if (track === undefined) this.ai?.notice("The completed subtitle is not in the refreshed inventory. Playback continues; try selecting it later.");
            else if (track.unplayable === true) this.ai?.notice(STORED);
            else selectTrack(track.trackId);
            return;
        }
        if (track === undefined || track.unplayable === true) this.search?.reportUnselected();
        else selectTrack(track.trackId);
    }

    notifyDroppedStored(stored: PendingStoredTrack | undefined): void {
        if (stored === undefined) return;
        if (stored.kind === "ai") {
            this.ai?.notice("Could not load the completed subtitle track. Playback continues; select it again to retry.");
        } else {
            this.search?.reportUnselected();
        }
    }

    destroy(): void {
        this.ai?.destroy();
        this.search?.destroy();
        this.sync?.destroy();
    }

    private aiInputs(plan: PlaybackPlan, shown: string | undefined, tracks: AudioVersionSnapshot): AIInputs | undefined {
        const view = this.ai?.view;
        if (view === undefined) return undefined;
        const version = tracks?.state === "ready" ? tracks.versions.find(candidate => candidate.fileId === plan.effectiveMediaFileId) : undefined;
        const selectedAudio = plan.selectedTracks.audio?.index;
        return {
            translateEnabled: view.available.translate,
            transcribeEnabled: view.available.transcribe,
            sources: plan.subtitle.inventory
                .filter(track => textSubtitle(track.codec) && track.combinedIndex >= 0)
                .map(track => ({ index: track.combinedIndex, language: track.language, selected: track.trackId === shown, isDefault: false })),
            audio: version === undefined
                ? (selectedAudio === undefined || tracks === undefined || tracks.state === "loading" ? [] : [{ index: selectedAudio, language: "", selected: true, isDefault: false }])
                : version.audio.map((track, ordinal) => ({ index: ordinal, language: track.language, selected: ordinal === selectedAudio, isDefault: track.isDefault })),
            quotaKnown: view.quota !== undefined,
            quotaExhausted: view.quota?.limited === true && view.quota.remaining <= 0,
        };
    }
}
