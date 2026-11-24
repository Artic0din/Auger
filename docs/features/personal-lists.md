# Personal list pages

The Skyline For You dropdown opens Watchlist and Favorites; the profile dropdown opens History.
Watchlist and Favorites retain the selected underlying root tab.
Their first Back focuses that tab while the list remains; the second leaves the list with the menu closed.
Saved lists append 24-card server pages using opaque continuations.
Favorites filters Movies and TV Shows locally without changing stored list order.
History appends unfiltered 60-card catalog pages and uses the TV safe area plus 48-point content padding.
All lists preserve native source ordering.
Moving focus never fetches data.
History, Watchlist and Favorites align both card caption lines with the poster's leading edge.
This follows the tvOS `TVMediaCardCaption` in [MediaCard.swift:648–666](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/Components/MediaCard.swift#L648-L666); History reaches it through `CatalogGrid`, while Watchlist and Favorites use `MediaCard` directly.

Cards open the existing Details route and its playback handoff.
Holding Select opens the shared [card actions](skyline-browse-shell.md) without pushing Details.
After a confirmed or uncertain personal change, closing that panel rereads the committed list continuation and restores nearby focus if membership removed the origin.
Closing and reopening an uncertain action retains its target and requires readback before an explicit retry can resend it.
Reopening refreshes the item's confirmed watched and membership values before those controls become available.
Active Details and card-menu updates share one pending-action check, and menu controls become available when the other update settles.
Returning from Details shows cached cards while re-reading the current page's opaque continuation in the existing fenced window.
Focus returns by item identity when that item remains visible; a removed item falls back to the next visible card at its old position, or the last card when it was at the end.
An empty page retains navigation through the existing focus host.
A failed page turn preserves the loaded page and retries the requested continuation.
An invalid cursor clears the obsolete window and Try again starts at page one.
Profile authority changes cancel requests and remove all personal-page data with the browse owner.

Favorites and Watchlist read the personal-list capability before querying.
An unsupported or disallowed capability has an explicit unavailable state.
Malformed responses and transport/server failures offer Try again.
`membership_supported` describes item membership reads, so it does not gate catalog list queries.
List absence never establishes that an item is not a member.

## Contract and integration

The tvOS comparison source is canonical `Silo-Server/silo-apple` commit `bef81e8652a89c23a1c3cf07e312e9444baa6c4c`.
Apple's Personal Watchlist, Favorites and History screens define the destinations; Favorites supplies the TV media selector and History uses fenced catalog pagination.
Apple's History query factory omits `type`, but that does not expose episodes in the pinned backend's media-items relation.
The public query scope accepts `episode`; the query-only type was extended without widening library media scopes.
Watchlist and Favorites use `GET /watchlist` and `GET /favorites`, as Apple's `APIv2Client+PersonalLists.swift` does.
The shared `operations.listPersonalItems` factory owns those requests; `decodePersonalListPage` owns their wire contract.
The UI applies only the Favorites media filter after decoding.
Those endpoints order tied membership timestamps by item ID descending; the catalog query path uses a different tiebreaker and can respect collection sort preferences.
The existing incremental loading owner keeps 24-card batches rather than Apple's eager 200-item batches.
History uses `POST /catalog/query` with `source=history` and no media filter.
Apple passes overlay data through `MediaCard.posterImage` on all three pages; overlays remain preference-controlled, including show status when supplied by the list endpoint.
The existing session supplies profile and PIN proof headers.
`GET /history` has a different response shape and is not consumed here.

`src/ui/personalLists.ts` owns read-only capability checks, page queries, and list rendering; Details owns item mutations and membership confirmation.
Personal pages preserve the `item` route identity and refresh their current page on Back.
Desktop Chromium validates behavior, bounded DOM, and focus geometry; see [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for Chromium 108, signed `.wgt`, and physical-TV proof boundaries.
