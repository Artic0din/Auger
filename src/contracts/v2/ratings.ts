import { object, string, WireError } from "./wire.ts";

/**
 * `GET /capabilities/ratings`: the rating sources the server shows (`imdb`, `tmdb` and any source a metadata plugin
 * declares and an administrator turned on, such as `rt_critic`). Empty unless the state is `available`, as
 * APIv2Client+Ratings.swift decides it.
 */
export function decodeRatingSources(value: unknown): ReadonlySet<string> {
    const body = object(value, "ratings_capability");
    const state = string(body, "state", "ratings_capability");
    if (body.sources !== undefined && !Array.isArray(body.sources)) throw new WireError("ratings_capability.sources", "an array");
    const names = ((body.sources ?? []) as unknown[]).map((entry, index) => string(object(entry, `ratings_capability.sources[${index}]`), "source", `ratings_capability.sources[${index}]`));
    return new Set(state === "available" ? names : []);
}
