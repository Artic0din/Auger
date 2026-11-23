# Cached browse content

Home and For You retain last-known metadata in optional local snapshots. Details and season metadata stay in memory for the active Authority. Every visit still requests fresh data; only transport failure or timeout falls back to cache.

- HTTP errors, cancellation, and writes never use cached fallback.
- Navigation and actions keep normal Server validation and error handling. This does not download media or enable offline playback.
- Uncached Home and For You failures show Apple's centered warning and **Try Again** (Home also offers **Manage Servers**). Both cached and uncached Home retry transport failures automatically.

## Cold-start restoration

- On automatic cold start, a saved Account restores its local session and remembered Profile (including protected PIN proof) before waiting for discovery, enabling snapshot hydration while offline.
- The app validates deployment identity, setup, Account, Profile list, and Profile-scoped access in the background. Before releasing any recovered request or media credential, public discovery must confirm the saved deployment identity.
- Temporary failures retain local Authority and retry. A different deployment identity clears the old Authority without sending credentials or revocation there; a rejected Account, Profile, or PIN proof clears protected content and returns to sign-in.
- When launch settings require Profile selection, the app never invents an offline Profile list. An Account without a remembered Profile still requires selection. A first-time unreachable address retains the connection error.

## Scope and protected artwork storage

- Cache scope uses `serverId`, `accountId`, and `profileId` (never Server address or credentials). Changing any component closes the previous cache owner.
- Authority loss clears memory and snapshots and fences pending responses. Account removal clears that Account's snapshots even without a mounted Browse screen (including offline), while preserving other saved Accounts' caches. The cache authority listener attaches before restore, saved-session reuse, and saved-account revocation.
- Optional storage failures leave the in-memory cache usable. Snapshots decode through the standard API decoders before use.
- Persistent snapshots strip URL and credential fields recursively; in-memory responses retain full artwork URLs for the active session.
- Because artwork URLs are signed capabilities (`/api/v2/artwork/{key}?exp=...&sig=...` or presigned storage URLs, expiring after 4 hours by default), Home, For You, and Library-list artwork fields (`poster_url`, `backdrop_url`, `series_backdrop_url`, `still_url`, `logo_url`, `photo_url`) are stored only in Tizen KeyManager (`silo.browseArtwork.v1`, capped at 256 KiB UTF-16 and skipped if larger), paired with the scope and an FNV-1a hash of each snapshot. Cold start restores artwork only when scope and hash match; without KeyManager, nothing persists.
- Remembered Profiles store only display name and primary/child flags alongside existing identity and protected-proof references (no avatar URLs); legacy entries fall back to Profile ID until online selection updates them.

## Cache bounds, recovery, and Details behavior

- **Bounds:** no TTL; at most 32 responses overall (at most 20 Details/season responses), 512 KiB UTF-16 payload budget, 1 MiB snapshot-read ceiling. Reads refresh LRU eviction order. Home enrichment has its own owner and cannot populate or evict the visited Details pool (up to 20 visited Details states retain supporting reads in memory).
- **Invalidation:** personal-write reconciliation always requires fresh reads. Metadata writes and playback returns invalidate snapshots behind a generation fence.
- **Recovery:** while unreachable, the visible route retries normal `/api/v2` reads every 15 seconds (Apple's unversioned health endpoint is outside this contract). Cached metadata stays visible with no unreachable banner, matching tvOS. Recovery replaces cached metadata.
- **Details fallback:** optional personal, next-episode, and related reads retain prior display values on transport failure; title art retains its remembered answer ([Title art](features/title-art.md)). Series Play retains its cached episode owner when fresh read fails. Season Details retries offline supporting reads automatically. Episode refusals persist across cached revisits until a fresh read succeeds.
- **Card menus and errors:** card menus open from row state (reading item detail once only if list state is absent) and show Apple's "Couldn't Update Item" alert on failure. Active episode selection overrides the overview suggestion; Show Series Info restores the season's suggestion independently of rail focus memory. Failed episode hierarchy reads show "Couldn't load episodes." and inline **Retry** (18 px row below retained episodes, or 22 px without episodes); uncached Details failure shows centered warning and **Try Again** with Back returning.

## Apple TV reference

Source: `Silo-Server/silo-apple` commit `7baff3ef657757cc0a69202e86dd4bd5c7fcb585` (source only, not an installed build).

- `Networking/ResponseCache.swift:7-12,193-200` and `ResponseSnapshotStore.swift:15-25`: decoded responses, stale-while-revalidate, 32 snapshots per server/account/profile scope (Details not persisted).
- `Screens/Auth/AccountSessions.swift:30-60`, `AuthService.swift:851-876,1064-1067`, `Networking/AccountLocalData.swift:95-106`, `tvOS/Caching/ItemDetailCache.swift:25-34,122-128,149-160`: identity-boundary resets, account purge, and 20-item Details LRU.
- `HomeViewModel.swift:83-110`, `HomeView.swift:53-107`, `RecommendationsViewModel.swift:16-51`, `RecommendationsView.swift:106-159`, `TVItemDetailView.swift:63-84,868-873`, `ItemDetailViewModel.swift:385-390,570-622,1431-1433`, `TVSeriesDetailView.swift:582-589,801-811`: tvOS keeps cached feeds without `ServerUnreachablePill` (which lives in the non-tvOS `#else` branch) and offers hierarchy Retry.
- `Networking/ConnectionMonitor.swift:189-190`: 15 s recovery interval.
- **Tizen choices:** no downloads, explicit byte budgets, KeyManager-sanitized artwork, conservative invalidation, and `/api/v2` page-read recovery.

## Offline verification notes

Follow [docs/evidence/simulator-evidence.md](evidence/simulator-evidence.md) for signed `.wgt` verification and Apple TV pairing. To simulate offline loss in Web Inspector after warming Home, For You, and Details:

1. Enable offline mode in the Network panel, or temporarily replace `window.fetch` (which `src/platform.ts:66` calls dynamically) with `() => Promise.reject(new TypeError("Offline test"))` without reloading, then restore it for recovery.
2. Verify retained metadata, artwork fallbacks, absence of an unreachable banner, Back navigation, cold uncached error handling, and recovery on reconnect.
3. Verify Profile switch, sign-out, and Account removal clear prior Authority caches, and repeat with optional storage unavailable.
