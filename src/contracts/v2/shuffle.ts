import { boolean, nonEmptyString, object, string, WireError } from "./wire.ts";

export interface Shuffle {
    readonly id: string;
    readonly current: { readonly id: string };
    readonly next: { readonly id: string };
    /** APIv2Shuffle.scopeLabel: "Movies" or "Breaking Bad · Season 2" when scope is returned. */
    readonly scopeLabel?: string | undefined;
}
export interface ShuffleCapability { readonly usable: boolean; readonly scopeKinds: readonly string[] }

function decodeScopeLabel(scope: unknown): string | undefined {
    if (typeof scope !== "object" || scope === null || Array.isArray(scope)) return undefined;
    const record = scope as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title === "") return undefined;
    const parent = typeof record.parent_title === "string" ? record.parent_title.trim() : "";
    return parent === "" ? title : `${parent} · ${title}`;
}

export function decodeShuffle(value: unknown): Shuffle {
    const body = object(value, "shuffle");
    const scopeLabel = decodeScopeLabel(body.scope);
    return {
        id: nonEmptyString(body, "id", "shuffle"),
        current: { id: nonEmptyString(object(body.current, "shuffle.current"), "content_id", "shuffle.current") },
        next: { id: nonEmptyString(object(body.next, "shuffle.next"), "content_id", "shuffle.next") },
        ...(scopeLabel === undefined ? {} : { scopeLabel }),
    };
}

export function decodeShuffleCapability(value: unknown): ShuffleCapability {
    const body = object(value, "shuffle_capability");
    const allowed = boolean(body, "allowed", "shuffle_capability"), state = string(body, "state", "shuffle_capability");
    if (!Array.isArray(body.scope_kinds) || body.scope_kinds.some(kind => typeof kind !== "string")) throw new WireError("shuffle_capability.scope_kinds", "an array of strings");
    return { usable: allowed && state === "available", scopeKinds: body.scope_kinds };
}
