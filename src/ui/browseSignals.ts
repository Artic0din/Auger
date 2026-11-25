import type { CardType } from "../contracts/v2/catalog.ts";

/**
 * Cross-route signals delivered through BrowseStack's single deduplicated traversal.
 * Feature modules subscribe via RouteEntry.onSignal without importing each other.
 */
export type BrowseSignal =
    | { readonly kind: "catalog.changed" }
    | {
        readonly kind: "title.watched";
        readonly id: string;
        readonly type: string;
        readonly seriesId?: string | undefined;
        readonly seasonNumber?: number | undefined;
        readonly source?: unknown;
    }
    | { readonly kind: "title.personal" }
    | { readonly kind: "title.notInterested"; readonly id: string; readonly marked: boolean; readonly current?: unknown }
    | { readonly kind: "title.notInterestedMarked"; readonly id: string }
    | { readonly kind: "title.dismissed"; readonly id: string; readonly type: CardType; readonly seriesId: string | undefined }
    | { readonly kind: "requests.capability"; readonly enabled: boolean; readonly refreshSearch: boolean }
    | { readonly kind: "requests.changed" }
    | { readonly kind: "playback.resumed" };
