import type { handleRequest } from "../../../../workers/diagnostics-relay/worker.js";
import type { RelayCase, RelayCaseResult } from "./relayCases.js";

export const CASES: readonly RelayCase[];
export const homeRowNavigation: Readonly<Record<string, unknown>>;
/** Runs every case, or only the named ones, and never throws. */
export function runNavigationCases(handle: typeof handleRequest, names?: readonly string[]): Promise<RelayCaseResult[]>;
