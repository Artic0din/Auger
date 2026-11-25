// What one playback attempt observed about buffering and quality, for Buffering / Quality reports
// (#875): stall durations, each step-down and its outcome, the playing plan's bitrates and the
// stored speed reading the start had. Bounded and in memory only; src/diagnosticsBuffering.ts
// validates every value before anything leaves the TV.

import type { BandwidthReading } from "./bandwidthReadings.ts";
import type { BufferingQualityMode, ReplanRequest } from "./bufferingQuality.ts";

export const MAX_STALLS = 8;
export const MAX_STEP_DOWNS = 4;

/** `auto`: the controller lowered on its own; `prompt`: the viewer chose Lower quality; `restore`: Restore quality. */
export type StepDownReason = "auto" | "prompt" | "restore";
/** `not_sent`: the player could not send the replan; `not_adopted`: it was sent and no plan came of it. */
export type StepDownOutcome = "pending" | "adopted" | "not_adopted" | "not_sent";

export interface PlanQuality {
    /** The plan's active quality label, else the requested preference. */
    readonly quality: string;
    /** `effective_recipe.bitrate_kbps`, else `source.bitrate_kbps`: what the controller steps down from. */
    readonly plannedKbps: number | undefined;
    readonly sourceKbps: number | undefined;
    /** The transcode or remux recipe's own bitrate; undefined when the server names none. */
    readonly outputKbps: number | undefined;
}

export interface StepDown {
    readonly reason: StepDownReason;
    readonly from: PlanQuality | undefined;
    readonly to: PlanQuality | undefined;
    /** The step-down estimate the replan carried. */
    readonly estimateKbps: number | undefined;
    /** Throughput the plan's media measurably arrived at, sent as evidence; undefined when nothing was measured. */
    readonly throughputKbps: number | undefined;
    readonly outcome: StepDownOutcome;
}

/** Why the start had no stored speed reading, or the newest one with whether it was young enough to send. */
export type SpeedEvidence =
    | "unsupported" | "offline" | "metered" | "none"
    | (BandwidthReading & { readonly source: "probe" | "sample"; readonly fresh: boolean });

/** `navigator.connection` as the webview reports it; undefined members were not reported. */
export interface NetworkEvidence {
    readonly type: string | undefined;
    readonly effectiveType: string | undefined;
    readonly online: boolean | undefined;
}

/** One attempt's raw buffering evidence plus the player settings it ran under. */
export interface BufferingEvidenceTrace {
    /** Changes whenever the recorded evidence changes; never serialized. */
    readonly revision: number;
    readonly mode: BufferingQualityMode;
    readonly advertised: boolean;
    readonly preference: string;
    /** `playback.max_bitrate_kbps`, the viewer's own cap. */
    readonly manualCapKbps: number | undefined;
    readonly learnedLimitCleared: boolean;
    readonly plan: PlanQuality | undefined;
    /** The `bandwidth_estimate_kbps` the start sent. */
    readonly startEstimateKbps: number | undefined;
    readonly speed: SpeedEvidence;
    readonly network: NetworkEvidence;
    readonly stallCount: number;
    /** The most recent MAX_STALLS stall durations, oldest first. */
    readonly stallsMs: readonly number[];
    readonly longestStallMs: number;
    readonly stepDowns: readonly StepDown[];
}

export interface PlayerQualitySettings {
    readonly mode: BufferingQualityMode;
    readonly advertised: boolean;
    readonly preference: string;
    readonly manualCapKbps: number | undefined;
}

/** The newest stored reading as speed evidence; a reading dated after `now` is fresh, as the estimate treats it. */
export function storedSpeed(reading: (BandwidthReading & { readonly source: "probe" | "sample" }) | undefined, now: number, maxAgeSeconds: number): SpeedEvidence {
    return reading === undefined ? "none" : { ...reading, fresh: now - reading.measuredAt < maxAgeSeconds * 1000 };
}

export function readNetwork(): NetworkEvidence {
    if (typeof navigator === "undefined") return { type: undefined, effectiveType: undefined, online: undefined };
    const connection = (navigator as Navigator & { readonly connection?: { readonly type?: unknown; readonly effectiveType?: unknown } }).connection;
    const online: unknown = navigator.onLine;
    return {
        type: typeof connection?.type === "string" ? connection.type : undefined,
        effectiveType: typeof connection?.effectiveType === "string" ? connection.effectiveType : undefined,
        online: typeof online === "boolean" ? online : undefined,
    };
}

export class BufferingEvidence {
    private revision = 0;
    private plan: PlanQuality | undefined;
    private startEstimateKbps: number | undefined;
    private speed: SpeedEvidence = "none";
    private stallCount = 0;
    private readonly stallsMs: number[] = [];
    private longestStallMs = 0;
    private readonly steps: { request: ReplanRequest; evidence: StepDown }[] = [];
    private learnedLimitCleared = false;

    startRead(speed: SpeedEvidence, estimateKbps: number | undefined): void {
        this.speed = speed;
        this.startEstimateKbps = estimateKbps;
        this.revision++;
    }

    stallMeasured(ms: number): void {
        this.stallCount++;
        this.longestStallMs = Math.max(this.longestStallMs, ms);
        this.stallsMs.push(ms);
        if (this.stallsMs.length > MAX_STALLS) this.stallsMs.shift();
        this.revision++;
    }

    stepQueued(reason: StepDownReason, request: ReplanRequest): void {
        this.steps.push({ request, evidence: {
            reason, from: this.plan, to: undefined, outcome: "pending",
            estimateKbps: request.bandwidthEstimateKbps, throughputKbps: request.observedThroughputKbps,
        } });
        if (this.steps.length > MAX_STEP_DOWNS) this.steps.shift();
        this.revision++;
    }

    stepEnded(request: ReplanRequest, outcome: "not_adopted" | "not_sent"): void {
        this.settle(request, { outcome });
    }

    planAdopted(plan: PlanQuality, request?: ReplanRequest): void {
        this.plan = plan;
        if (request !== undefined) {
            if (request.learnedLimit === "clear") this.learnedLimitCleared = true;
            this.settle(request, { outcome: "adopted", to: plan });
        }
        this.revision++;
    }

    trace(settings: PlayerQualitySettings, network: NetworkEvidence = readNetwork()): BufferingEvidenceTrace {
        return {
            revision: this.revision,
            ...settings,
            learnedLimitCleared: this.learnedLimitCleared,
            plan: this.plan,
            startEstimateKbps: this.startEstimateKbps,
            speed: this.speed,
            network,
            stallCount: this.stallCount,
            stallsMs: this.stallsMs.slice(),
            longestStallMs: this.longestStallMs,
            stepDowns: this.steps.map(step => step.evidence),
        };
    }

    private settle(request: ReplanRequest, change: Pick<StepDown, "outcome"> & Partial<Pick<StepDown, "to">>): void {
        const step = this.steps.find(entry => entry.request === request);
        if (step === undefined || step.evidence.outcome !== "pending") return;
        step.evidence = { ...step.evidence, ...change };
        this.revision++;
    }
}
