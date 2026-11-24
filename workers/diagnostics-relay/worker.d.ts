export interface RelayEnv {
    readonly GITHUB_TOKEN?: string;
    readonly GITHUB_REPO?: string;
}

export interface RelayCache {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
}

export interface RelayDeps {
    readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    readonly cache?: RelayCache;
}

export function handleRequest(request: Request, env: RelayEnv, deps?: RelayDeps): Promise<Response>;
