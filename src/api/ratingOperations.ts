import { decodeRatingSources } from "../contracts/v2/ratings.ts";
import type { RequestSpec } from "./http.ts";

export const ratingOperations = {
    /** getRatingsCapability: profile-scoped, so send it through session.call with profileScoped. */
    ratingSources: (): RequestSpec<ReadonlySet<string>> => ({ method: "GET", path: "/capabilities/ratings", retry: "safe", decode: decodeRatingSources }),
};
