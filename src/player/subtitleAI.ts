import type { Clock } from "../api/clock.ts";
import { ApiError } from "../api/errors.ts";
import type { RequestSpec } from "../api/http.ts";
import { subtitleAIOperations as operations, type SubtitleAIRequest } from "../api/subtitleAIOperations.ts";
import { subtitleSearchOperations } from "../api/subtitleSearchOperations.ts";
import type { SubtitleAIJob, SubtitleAIQuota, SubtitleAIStatus } from "../contracts/v2/subtitleAI.ts";
import type { NativeSession } from "../session/session.ts";

export interface AIResult { readonly id: string; readonly label: string; /** The stored track cannot be shown, so selecting it does nothing. */ readonly unavailable?: boolean }
export interface SubtitleAIView {
    readonly available: SubtitleAIStatus;
    readonly languages: readonly string[];
    /** The profile's preferred subtitle language, floated to the top of the menu. */
    readonly preferred: string | undefined;
    readonly quota: SubtitleAIQuota | undefined;
    readonly busy: boolean;
    readonly message: string;
    readonly results: readonly AIResult[];
    /** The menu's panel: the languages, a running job, a failure, or the job that just finished. */
    readonly phase: "idle" | "busy" | "failed" | "completed";
    /** The running job's kind, as the server names it. */
    readonly kind: string | undefined;
    readonly progress: { readonly percent: number; readonly message: string } | undefined;
    /** A request may have started a job whose outcome is unknown, so none is sent until it is discarded. */
    readonly held: boolean;
}

const POLL_INTERVAL_MS = 2000;
const POLL_ATTEMPTS = 3;
const UNCONFIRMED = "Could not confirm the AI request. It may still finish on the server; it was not sent again.";

export class SubtitleAI {
    private readonly session: NativeSession;
    private readonly clock: Clock;
    readonly fileId: string;
    private readonly changed: () => void;
    private readonly abort = new AbortController();
    private readonly stopAuthority: () => void;
    private cancelPoll: (() => void) | undefined;
    private readonly results: AIResult[] = [];
    private busy = false;
    private message = "";
    private available: SubtitleAIStatus | undefined;
    private languages: readonly string[] = [];
    private preferred: string | undefined;
    private quota: SubtitleAIQuota | undefined;
    private failed = false;
    private completed = false;
    private jobId: string | undefined;
    /** Grows with each start and each cancel: an answer from an earlier generation belongs to a job the viewer let go. */
    private generation = 0;
    /** The generation of the cancelled create that holds the file; a discard clears it, so that create's late answer cannot touch the file again. */
    private holdingGeneration: number | undefined;
    private kind: string | undefined;
    private progress: SubtitleAIView["progress"];
    /** Files whose server job outcome is unknown; owned by the caller so it outlives this instance. */
    private readonly blockedFiles: Set<string>;

    constructor(session: NativeSession, clock: Clock, fileId: string, changed: () => void, blockedFiles: Set<string> = new Set()) {
        this.blockedFiles = blockedFiles;
        this.session = session;
        this.clock = clock;
        this.fileId = fileId;
        this.changed = changed;
        const signal = session.authoritySignal;
        const cancel = (): void => this.destroy();
        signal.addEventListener("abort", cancel, { once: true });
        this.stopAuthority = () => signal.removeEventListener("abort", cancel);
        if (signal.aborted) this.destroy();
        else void this.discover();
    }

    private get uncertain(): boolean { return this.blockedFiles.has(this.fileId); }

    get view(): SubtitleAIView | undefined {
        if (this.available === undefined) return undefined;
        const phase = this.busy && !this.failed ? "busy" : this.failed || this.uncertain ? "failed" : this.completed ? "completed" : "idle";
        return { available: this.available, languages: this.languages, preferred: this.preferred, quota: this.quota, busy: this.busy || this.uncertain, message: this.message, results: this.results, phase, kind: this.kind, progress: this.progress, held: this.uncertain };
    }

    destroy(): void {
        // A job still in flight can finish unseen, so its file stays blocked for the next instance.
        if (this.busy) this.blockedFiles.add(this.fileId);
        this.abort.abort();
        this.cancelPoll?.();
        this.stopAuthority();
    }

    notice(message: string): void {
        if (this.abort.signal.aborted) return;
        this.message = message;
        this.changed();
    }

    private call<T>(spec: RequestSpec<T>): Promise<T> {
        return this.session.call({ ...spec, profileScoped: true, replayAfterRefresh: spec.method === "GET", signal: this.abort.signal });
    }

    private async discover(): Promise<void> {
        try {
            const status = await this.call(operations.subtitleAIStatus());
            if (this.abort.signal.aborted || (!status.translate && !status.transcribe)) return;
            this.available = status;
            this.changed();
            await Promise.all([
                this.call(operations.subtitleAILanguages()).then(languages => { if (!this.abort.signal.aborted) this.languages = languages; }, () => this.notice("Could not load translation languages.")),
                this.refreshQuota(true),
                // The menu is usable without it; the preferred row is only a shortcut.
                this.call(subtitleSearchOperations.preferredLanguage()).then(preferred => { if (!this.abort.signal.aborted) this.preferred = preferred; }, () => undefined),
            ]);
            if (!this.abort.signal.aborted) this.changed();
        } catch { /* Unsupported AI is omitted; it never gates playback. */ }
    }

    /** After a job the panel already holds that job's reason, and the menu's quota line covers a balance it cannot read, so only the first read reports a failure. */
    private async refreshQuota(report = false): Promise<void> {
        try {
            const quota = await this.call(operations.subtitleAIQuota());
            if (!this.abort.signal.aborted) { this.quota = quota; this.changed(); }
        } catch { if (report) this.notice("Could not read transcription quota. Playback continues."); }
    }

    async start(request: SubtitleAIRequest): Promise<void> {
        if (this.abort.signal.aborted || this.busy || this.uncertain || request.media_file_id !== this.fileId || this.available === undefined) return;
        if (request.kind !== "transcribe" && (!this.available.translate || !this.languages.includes(request.target_language))) return;
        if (request.kind !== "translate" && (!this.available.transcribe || this.quota === undefined || (this.quota.limited && this.quota.remaining <= 0))) { this.notice("Transcription quota is exhausted or unavailable. Playback continues."); return; }
        this.failed = false;
        this.completed = false;
        this.kind = request.kind;
        this.progress = undefined;
        // The last job's id must not stand in for this one: until the server names it, Cancel only marks this generation as let go.
        this.jobId = undefined;
        this.busy = true;
        const generation = ++this.generation;
        this.notice("Starting AI subtitles…");
        try {
            const job = await this.call(operations.createSubtitleAI(request));
            if (this.abort.signal.aborted) return;
            // Cancelled while the request was in flight: the job exists now, so stop it by the id the server just gave.
            if (generation !== this.generation) { this.settleCreate(generation, false); void this.stop(job.id); return; }
            if (job.fileId !== this.fileId || job.kind !== request.kind || job.sourceIndex !== request.source_index || job.id === "" || job.language !== request.target_language) throw new Error("AI job identity mismatch");
            await this.update(job, generation);
        } catch (error) {
            if (this.abort.signal.aborted) return;
            // A problem body is the server's answer; 429 (e.g. quota_exceeded) refuses, unlike 408/5xx whose outcome is unknown.
            const unknown = !(error instanceof ApiError && error.problemId !== undefined && (!error.transient || error.status === 429));
            // The viewer already let this request go; a later job's panel is not its to change.
            if (generation !== this.generation) { this.settleCreate(generation, unknown); return; }
            if (unknown) this.blockedFiles.add(this.fileId);
            this.busy = false;
            this.failed = true;
            this.notice(error instanceof ApiError && error.problemId ? `AI subtitles could not start: ${error.problemId}. Playback continues.` : UNCONFIRMED);
            void this.refreshQuota();
        }
    }

    /** Dismiss: the viewer has seen a failure or a finished job, so the menu reopens on its languages. */
    acknowledge(): void {
        if (this.failed || this.completed) {
            this.failed = false;
            this.completed = false;
            this.message = "";
            this.changed();
        }
    }

    /** Lets a request go out again after one whose outcome is unknown. */
    discardHeld(): void {
        this.holdingGeneration = undefined;
        if (this.blockedFiles.delete(this.fileId)) {
            this.failed = false;
            this.message = "";
            this.changed();
        }
    }

    /** Best effort: stops polling and asks the server to stop the job. Quota already spent stays spent. */
    async cancel(): Promise<void> {
        if (!this.busy || this.abort.signal.aborted) return;
        const id = this.jobId;
        const cancelled = this.generation++;
        this.cancelPoll?.();
        this.busy = false;
        this.progress = undefined;
        // Before the server has named the job there is nothing to stop yet: start() stops it when its id arrives.
        // Until it answers the request may have started a billable job, so the file is held as Apple's SiloAI holds
        // an unresolved creation: nothing else is sent until the create settles or the viewer discards it.
        if (id === undefined) { this.blockedFiles.add(this.fileId); this.holdingGeneration = cancelled; }
        this.message = id === undefined ? "Waiting for the AI request to finish. Nothing new is sent until it does." : "";
        this.changed();
        if (id !== undefined) await this.stop(id);
    }

    /**
     * A cancelled create has answered. Only the create that holds the file settles it: after a discard the file
     * belongs to whatever the viewer started since, and this late answer changes nothing.
     */
    private settleCreate(generation: number, unknown: boolean): void {
        if (this.holdingGeneration === generation) {
            this.holdingGeneration = undefined;
            if (!unknown) this.blockedFiles.delete(this.fileId);
            this.message = unknown ? UNCONFIRMED : "";
        }
        this.changed();
    }

    private async stop(id: string): Promise<void> {
        try { await this.call(operations.cancelSubtitleAIJob(id)); } catch { /* The job may still finish; its result is not listed. */ }
        void this.refreshQuota();
    }

    private async update(job: SubtitleAIJob, generation: number): Promise<void> {
        // An answer for a job the viewer cancelled must not touch the panel, nor a job started since.
        if (this.abort.signal.aborted || generation !== this.generation) return;
        this.jobId = job.id;
        const resultId = job.resultId;
        if (job.status === "completed" && resultId === undefined) {
            // Apple closes the menu on any completion. With nothing to select, the reason stays on the failure panel until Dismiss instead.
            this.busy = false;
            this.failed = true;
            this.progress = undefined;
            this.notice("AI job completed without a subtitle result.");
            void this.refreshQuota();
        } else if (job.status === "completed") {
            this.busy = false;
            this.completed = true;
            this.progress = undefined;
            if (resultId !== undefined && !this.results.some(result => result.id === resultId)) this.results.push({ id: resultId, label: `${job.kind === "translate" ? "AI-translated" : "AI-transcribed"}${job.language ? ` · ${job.language.toUpperCase()}` : ""}` });
            this.notice("AI subtitles are ready to select.");
            void this.refreshQuota();
        } else if (job.status === "failed" || job.status === "cancelled") {
            this.busy = false;
            this.failed = true;
            this.progress = undefined;
            this.notice(job.error || `AI subtitles ${job.status}. Playback continues.`);
            void this.refreshQuota();
        } else if (job.status === "pending" || job.status === "running") {
            this.progress = { percent: Math.round(Math.min(1, Math.max(0, job.progress ?? 0)) * 100), message: job.progressMessage ?? "" };
            this.notice("Generating AI subtitles…");
            this.poll(job, 0, generation);
        } else {
            this.busy = false;
            this.failed = true;
            this.blockedFiles.add(this.fileId);
            this.notice("The server returned an unknown AI job state. Playback continues.");
        }
    }

    private poll(job: SubtitleAIJob, failures: number, generation: number): void {
        this.cancelPoll = this.clock.schedule(() => {
            void this.call(operations.subtitleAIJob(job.id)).then(next => {
                if (next.id !== job.id || next.fileId !== this.fileId || next.kind !== job.kind || next.sourceIndex !== job.sourceIndex || next.language !== job.language) throw new Error("AI job identity changed");
                return this.update(next, generation);
            }).catch(() => {
                if (this.abort.signal.aborted || generation !== this.generation) return;
                if (failures + 1 < POLL_ATTEMPTS) { this.poll(job, failures + 1, generation); return; }
                this.busy = false;
                this.failed = true;
                this.blockedFiles.add(this.fileId);
                this.notice("Could not check the AI job. It may still finish on the server; another request is blocked for this playback. Playback continues.");
            });
        }, POLL_INTERVAL_MS);
    }
}
