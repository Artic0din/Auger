export interface RelayRateLimiter {
    limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

export interface RelayEnv {
    readonly GITHUB_TOKEN?: string;
    readonly GITHUB_REPO?: string;
    readonly DIAGNOSTICS_RATE_LIMITER?: RelayRateLimiter;
}

export interface RelayDeps {
    readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    readonly rateLimiter?: RelayRateLimiter;
}

export function handleRequest(request: Request, env: RelayEnv, deps?: RelayDeps): Promise<Response>;

/**
 * The `inc` (iv 1) shape the relay accepts inside a v1 payload; mirrors the client's DiagnosticsIncidentPayload so a
 * compile-time assignment between the two catches drift. Values outside the runtime INCIDENT_CONTRACT are dropped;
 * `iv`, `cat` and `out` are required.
 */
export interface RelayIncident {
    readonly iv: 1;
    readonly cat: "playback" | "buffering";
    readonly src?: "manual" | "auto";
    readonly out: "failed" | "refused" | "interrupted" | "recovered";
    readonly kind?: string;
    readonly op?: string;
    readonly stage?: string;
    readonly code?: string;
    readonly fs?: string;
    readonly fc?: string;
    readonly done?: string;
    readonly dec?: "adaptation_unavailable" | "unknown";
    readonly http?: number;
    readonly rt?: boolean;
    readonly av?: { readonly f?: string; readonly l?: string };
    readonly open?: boolean;
    readonly shown?: boolean;
    readonly rs?: number;
    readonly rec?: { readonly n?: number; readonly c?: number; readonly r?: "none" | "recovered" | "attempted" | "exhausted" };
    readonly pl?: "not_reached" | {
        readonly dl: string;
        readonly pr?: string;
        readonly ct?: string;
        readonly q?: string;
        readonly kbps?: number;
        readonly vc?: string;
        readonly res?: string;
        readonly dr?: string;
        readonly pos?: number;
        readonly at?: number;
    };
    readonly set?: "not_reached" | { readonly q?: string; readonly cap?: number | "none"; readonly hdr?: boolean };
    readonly hp?: "unknown" | "unavailable" | { readonly h10?: boolean; readonly hlg?: boolean; readonly dv?: boolean };
    readonly req?: { readonly pos?: number | "none"; readonly sub?: "auto" | "off" | "track"; readonly aud?: "default" | "track" };
    readonly t?: readonly string[];
}

/** Runtime field declarations the relay validates `inc` against. */
export const INCIDENT_CONTRACT: Readonly<Record<keyof RelayIncident, Readonly<Record<string, unknown>>>>;
/** Allowlisted top-level `precedingScreen` values for viewer-observed reports. */
export const PRECEDING_SCREENS: readonly string[];
