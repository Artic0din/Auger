import type { RequestSpec } from "./http.ts";
import { decodeShuffle, decodeShuffleCapability, type Shuffle, type ShuffleCapability } from "../contracts/v2/shuffle.ts";

export const shuffleOperations = {
    shuffleCapabilities: (): RequestSpec<ShuffleCapability> => ({ method: "GET", path: "/shuffles/capabilities", retry: "safe", decode: decodeShuffleCapability }),
    createShuffle: (id: string, kind: "library" | "library_collection" | "user_collection" | "series" | "season" = "library"): RequestSpec<Shuffle> => ({ method: "POST", path: "/shuffles", retry: "never", body: { scope: { kind, id } }, decode: decodeShuffle }),
    getShuffle: (id: string): RequestSpec<Shuffle> => ({ method: "GET", path: `/shuffles/${encodeURIComponent(id)}`, retry: "safe", decode: decodeShuffle }),
    advanceShuffle: (id: string, fromContentId: string): RequestSpec<Shuffle> => ({ method: "POST", path: `/shuffles/${encodeURIComponent(id)}/advance`, retry: "safe", body: { from_content_id: fromContentId }, decode: decodeShuffle }),
    skipShuffleItem: (id: string, nextContentId: string): RequestSpec<Shuffle> => ({ method: "POST", path: `/shuffles/${encodeURIComponent(id)}/skip`, retry: "safe", body: { next_content_id: nextContentId }, decode: decodeShuffle }),
    deleteShuffle: (id: string): RequestSpec<undefined> => ({ method: "DELETE", path: `/shuffles/${encodeURIComponent(id)}`, retry: "never", decode: () => undefined }),
};
