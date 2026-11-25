import type { handleRequest } from "../../../../workers/diagnostics-relay/worker.js";
import type { RelayCase, RelayCaseResult } from "./relayCases.js";

export const BUFFERING_CASES: readonly RelayCase[];
export const bufferingEvidence: Readonly<Record<string, unknown>>;
export const failedRecovery: Readonly<Record<string, unknown>>;
/** Runs every Buffering / Quality case, or only the named ones, and never throws. */
export function runBufferingCases(handle: typeof handleRequest, names?: readonly string[]): Promise<RelayCaseResult[]>;
