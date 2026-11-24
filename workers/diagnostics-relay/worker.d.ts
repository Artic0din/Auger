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
