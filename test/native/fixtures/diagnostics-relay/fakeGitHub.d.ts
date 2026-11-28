import type { handleRequest } from "../../../../workers/diagnostics-relay/worker.js";

export interface OutboundCall {
    readonly method: string;
    readonly url: string;
    readonly body: { readonly title?: string; readonly body?: string; readonly type?: string; readonly labels?: readonly string[] };
}

export interface FakeGitHub {
    fetch(url: string, init?: RequestInit): Promise<Response>;
    readonly issues: readonly { readonly number: number; readonly title: string; readonly body: string }[];
    readonly outbound: readonly OutboundCall[];
    created(): readonly OutboundCall[];
    comments(): readonly OutboundCall[];
    publishedText(): readonly string[];
}

export const RELAY_URL: string;
export function fakeGitHub(seed?: readonly { readonly number: number; readonly title: string; readonly body: string; readonly comments?: number }[]): FakeGitHub;
export function send(handle: typeof handleRequest, destination: FakeGitHub, payload: unknown): Promise<{ readonly status: number; readonly json: Record<string, unknown> }>;
export function encodeState(state: unknown): string;
export function fnv(input: string): string;
export function deployedLegacyFingerprint(app: string, tv: string, signature: string): string;
export function incidentGroupId(app: string, tv: string, inc: { readonly cat: string; readonly op?: string; readonly stage?: string; readonly code?: string }): string;
