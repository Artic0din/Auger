// The public Buffering / Quality evidence (`bq`, bv 1) a report carries next to `inc` (#875).
// Every value is an enum, bounded integer, boolean or allowlisted quality label; the relay's
// BUFFERING_CONTRACT (workers/diagnostics-relay/contract.js) mirrors this shape.

import type { BufferingQualityMode } from "./player/bufferingQuality.ts";
import type { BufferingEvidenceTrace, PlanQuality, StepDownOutcome, StepDownReason } from "./player/bufferingEvidence.ts";
import { publicMediaToken, QUALITIES } from "./diagnosticsIncident.ts";

const NETWORK_TYPES = ["wifi", "ethernet", "cellular", "other"] as const;
const CONNECTION_CLASSES = ["slow-2g", "2g", "3g", "4g"] as const;
const MAX_KBPS = 1_000_000;
const MAX_STALL_MS = 600_000;
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_COUNT = 99;

export type NetworkType = (typeof NETWORK_TYPES)[number] | "unavailable";
export type ConnectionClass = (typeof CONNECTION_CLASSES)[number] | "unavailable";
/**
 * How the server's learned connection limit applied: `unsupported` without `buffering_quality_v1`,
 * `ignored` while lowering is off, `cleared` after Restore quality, else `server`. The TV never sees its value.
 */
export type LearnedLimitState = "unsupported" | "ignored" | "server" | "cleared";

export interface DiagnosticsStepDown {
    readonly r: StepDownReason;
    readonly fq?: string;
    readonly fk?: number;
    readonly tq?: string;
    readonly tk?: number;
    /** The step-down estimate sent. */
    readonly est?: number;
    /** Measured media throughput sent as evidence; absent when nothing was measured. */
    readonly thr?: number;
    readonly o: StepDownOutcome;
}

export interface DiagnosticsBufferingPayload {
    readonly bv: 1;
    readonly md: BufferingQualityMode;
    readonly adv: boolean;
    /** Quality preference: `auto` is automatic quality, a rung is a fixed quality. */
    readonly q?: string;
    /** The viewer's bitrate cap from Settings: a forced cap. */
    readonly mc: number | "none";
    readonly ll: LearnedLimitState;
    /** The playing plan's quality, planned (delivered), source and output bitrates. */
    readonly pq?: string;
    readonly pk?: number;
    readonly sk?: number;
    readonly ok?: number;
    /** The connection estimate the start sent, from a stored reading. */
    readonly est?: number;
    /** Network type and the browser's effective connection class are separate readings. */
    readonly net: { readonly t: NetworkType; readonly ec: ConnectionClass; readonly on?: boolean };
    /** The newest stored speed reading with its age, or why there was none. */
    readonly spd: "unsupported" | "offline" | "metered" | "none" | { readonly kbps: number; readonly src: "probe" | "sample"; readonly age: number; readonly fresh: boolean };
    /** Stalls of a second or more, outages and startup grace excluded: count, recent durations, longest. */
    readonly st: { readonly n: number; readonly d: readonly number[]; readonly lg: number };
    readonly sd: readonly DiagnosticsStepDown[];
}

function kbps(value: number | undefined): number | undefined {
    return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), MAX_KBPS) : undefined;
}

/** Stall time to the nearest 100 ms, bounded. */
function stallMs(value: number): number {
    return Number.isFinite(value) && value > 0 ? Math.min(Math.round(value / 100) * 100, MAX_STALL_MS) : 0;
}

function quality(value: string | undefined): string | undefined {
    return publicMediaToken(value, QUALITIES);
}

function planFields(plan: PlanQuality | undefined): { readonly q?: string; readonly k?: number } {
    const q = quality(plan?.quality);
    const k = kbps(plan?.plannedKbps);
    return { ...(q === undefined ? {} : { q }), ...(k === undefined ? {} : { k }) };
}

function learnedLimit(trace: BufferingEvidenceTrace): LearnedLimitState {
    if (!trace.advertised) return "unsupported";
    if (trace.learnedLimitCleared) return "cleared";
    return trace.mode === "never" ? "ignored" : "server";
}

function speed(trace: BufferingEvidenceTrace, now: number): DiagnosticsBufferingPayload["spd"] {
    const reading = trace.speed;
    if (typeof reading === "string") return reading;
    const value = kbps(reading.kbps);
    if (value === undefined || !Number.isFinite(reading.measuredAt)) return "none";
    const age = Math.min(Math.max(0, Math.floor((now - reading.measuredAt) / 1000)), MAX_AGE_SECONDS);
    return { kbps: value, src: reading.source, age, fresh: reading.fresh };
}

/** Builds the public evidence at capture time; `now` dates the speed reading's age. */
export function bufferingPayload(trace: BufferingEvidenceTrace, now: number): DiagnosticsBufferingPayload {
    const plan = trace.plan;
    const pq = quality(plan?.quality);
    const pk = kbps(plan?.plannedKbps);
    const sk = kbps(plan?.sourceKbps);
    const ok = kbps(plan?.outputKbps);
    const q = quality(trace.preference);
    const est = kbps(trace.startEstimateKbps);
    const t = NETWORK_TYPES.find((type) => type === trace.network.type) ?? (trace.network.type === undefined ? "unavailable" : "other");
    const ec = CONNECTION_CLASSES.find((value) => value === trace.network.effectiveType) ?? "unavailable";
    return {
        bv: 1,
        md: trace.mode,
        adv: trace.advertised,
        ...(q === undefined ? {} : { q }),
        mc: kbps(trace.manualCapKbps) ?? "none",
        ll: learnedLimit(trace),
        ...(pq === undefined ? {} : { pq }),
        ...(pk === undefined ? {} : { pk }),
        ...(sk === undefined ? {} : { sk }),
        ...(ok === undefined ? {} : { ok }),
        ...(est === undefined ? {} : { est }),
        net: { t, ec, ...(trace.network.online === undefined ? {} : { on: trace.network.online }) },
        spd: speed(trace, now),
        st: {
            n: Math.min(Math.max(0, Math.floor(trace.stallCount)), MAX_COUNT),
            d: trace.stallsMs.map(stallMs).slice(-8),
            lg: stallMs(trace.longestStallMs),
        },
        sd: trace.stepDowns.slice(-4).map((step) => {
            const stepEst = kbps(step.estimateKbps);
            const thr = kbps(step.throughputKbps);
            const from = planFields(step.from);
            const to = planFields(step.to);
            return {
                r: step.reason,
                ...(from.q === undefined ? {} : { fq: from.q }),
                ...(from.k === undefined ? {} : { fk: from.k }),
                ...(to.q === undefined ? {} : { tq: to.q }),
                ...(to.k === undefined ? {} : { tk: to.k }),
                ...(stepEst === undefined ? {} : { est: stepEst }),
                ...(thr === undefined ? {} : { thr }),
                o: step.outcome,
            };
        }),
    };
}
