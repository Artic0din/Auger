import type { handleRequest } from "../../../../workers/diagnostics-relay/worker.js";

export interface RelayCase {
    readonly name: string;
    run(handle: typeof handleRequest): Promise<void>;
}

export interface RelayCaseResult {
    readonly name: string;
    readonly ok: boolean;
    readonly message?: string;
}

export const CASES: readonly RelayCase[];
export const sessionExpiredAtStart: Readonly<Record<string, unknown>>;
export const missingSession404: Readonly<Record<string, unknown>>;
export const cappedHlsBeforeOpen: Readonly<Record<string, unknown>>;
/** Runs every case, or only the named ones, and never throws. */
export function runRelayCases(handle: typeof handleRequest, names?: readonly string[]): Promise<RelayCaseResult[]>;
