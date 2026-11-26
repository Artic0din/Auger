# Details actions

Canonical specification for movie, series, season, and episode Details hero entry, action row, popovers, inline episode rail, and directional scrolling (`src/ui/browseDetails.ts`, `src/ui/detailsState.ts`, `src/ui/detailsActions.ts`).
For preplay audio/subtitle persistence and fresh resume resolution, see [Skyline browse shell: Preplay audio, subtitles and resume](skyline-browse-shell.md#preplay-audio-subtitles-and-resume).

## Entry loading

- Series entry focuses Watchlist (`TVDetailActions.entryAction`) while the initial episode list loads or Play has no resolved episode label (including cached-detail first paint and empty episode responses before playback detail lands). Once Play gets a title, it claims focus once unless the viewer moved or pressed Select (which keeps Watchlist focused); later repaints do not move focus unless the focused item disappears.
- Explicit navigation to a season or action during loading preserves the viewer's focus. Failures and empty lists keep ordinary recovery targets reachable.
- Each Details route presentation carries a distinct `View.visitKey`, so pushing a fresh Details route opens on its primary action at scroll zero without clearing an ancestor's snapshot, while returning from an episode page retains the selected season.

## Actions and popovers

- **Action row:** Play/Resume, Start Over (when available, 76×76 circle with `backward.end.fill`, label shown on focus), Version, Audio, Subtitles, Watchlist, and More. Unfocused Play shares the circles' 10% white fill.
- **Popover surface (`TVActionPopoverMenu`):** Version, Audio, Subtitles, and More share one 560 px popover (black 45% translucent substitute for Liquid Glass, 1 px white 10% inner lip, 22 px radius, monospaced 14 px header, 54 px title-only rows in More, 76 px two-line rows in pickers, scaling from 0.96 over 180 ms). Lists over 7 rows scroll inside 504 px centered on the initial selection. Selection, Back, Left, and Right dismiss the popover and restore its trigger.
- **Audio and subtitle rows:** Audio leads with language and moves track title before codec/layout/Default/Preferred on the detail line. Embedded subtitles without a codec read `Unsupported format` and sidecars without a stream index read `Available in player` (both dimmed at 40% and unfocusable).
- **More menu order:**
  - Movies: Favorites, Mark as Watched/Unwatched, Find Trailers, Translate Description (capability/language gated), Not Interested (`user_state.not_interested` gated), Watch Party (experimental opt-in + server capability).
  - Series: Shuffle Series / Shuffle Season (when capability supports the scope and at least two playable episodes exist), Show Series Info (only when an episode owns the hero), Favorites, Mark Series Watched/Unwatched, Mark Season Watched/Unwatched (hidden if season watch state is absent), Find Trailers, Translate Description, Not Interested, Watch Party.
- **Find Trailers:** profile-scoped non-retryable `POST /api/v2/catalog/items/{id}/trailers/refresh` (never replayed after token refresh), polling item detail every 3 s (at least 60 s before five unchanged polls settle, 120 s max). New local extras publish immediately; new remote-only YouTube results while remote cards are hidden resolve with `detail.trailerFetch.unplayable` (`TrailerFetchCoordinator.outcome`). Leaving pauses observation; returning resumes without another POST; Authority changes discard it.
- **Not Interested:** writes `PUT`/`DELETE /not-interested/{id}` (idempotent), updates state optimistically, removes the title from Home recommendation rows and every For You row via `notInterestedStore.ts`, and rolls back with `Couldn't Update Item` on failure.
- **Failure alerts (`MediaActionFeedback`):** definite write refusals show `Couldn't Update Item` (`Couldn't Update Watched Status` for seasons; `Couldn't Shuffle` for shuffle with Apple's 409/404/default copy). Unanswered network/timeout writes hold the change (`Change Not Confirmed` with `Discard Held Change`) and reconcile by reading state rather than auto-replaying.
- **Removed controls (tvOS parity):** Read synopsis (synopsis is a non-focusable 3-line clamp at 92% white), Season details button (season tabs drive the inline rail), and personal 1–5 star ratings (removed when tvOS showed external scores only; tvOS has since added half-star ratings via `TVRatingActionButton` / `TVRatingEditor`, tracked under #106).

## Series seasons and episode rail

- **Initial season and episode selection:** follows Apple's rollup order: requested/cached season, in-progress season, partially watched season, first unplayed numbered season, Specials, then first numbered season; within a season, in-progress (`user_data.is_in_progress`), first unwatched, then first episode.
- **Season pills and episode dwell:** borderless capsules (100 px horizontal inset, 24 px padding, 12 px gap, 20% selected / 5% unselected fill). Resting 70 ms on a missing season pill reads that season once; resting 120 ms on an uncached episode card reads missing full catalog detail (max 4 concurrent reads, 16 retained playback owners per route; see [tv-focus.md](../tv-focus.md#never-fetch-on-focus)).
- **Windowing and captions:** joins contiguous loaded seasons, warms at least 8 episodes per side on initial load/season change, and clamps terminal scroll at Compact/Standard/Large poster sizes without extra clearance. Anchored episode captions use 20 pt semibold single-line tail truncation.
- **Failures:** selected-season failures stay on their season and retry only via explicit Retry (never automatically on reconnect); failed edge neighbors show `Couldn't load more episodes. Move away and back to retry.`

## Scroll and layout parity

- **Supporting sections order:** Cast & Crew (unclipped right scroll inset), Trailers & More (local extras play from zero; remote YouTube cards are hidden until a Samsung YouTube handoff is proven), Related Movies / Recommended Series, then Details facts table (one focusable block, 140 px page bottom padding). Down at the final section holds focus.
- **Directional reveal (`SkylineScroll`):** hero actions, season pills, and episode rail stay at scroll zero (`450 ms` ease-in-out on movies, `550 ms` cubic-bezier on series); Down centers the target supporting section (scaling Related headings with Poster Size: Compact 547/321, Standard 500.8/297.9, Large 434.8/264.9); Up resets to zero when the heading and focused artwork fit there.
- **Metadata:** outlined content-rating chip, inline external rating artwork, and optional advisory-age chip (`advisoryAgeBadgeLabel` when Show Advisory Age is on).

## Accepted differences

1. **Movie hero height:** Apple fixes Movie hero height at 690 px and clips long text (which can clip focused Play). Tizen uses `min-height: 690px` and expands so focused Play stays visible per [tv-focus.md](../tv-focus.md).
2. **Series readout without values:** Tizen hides empty Version/Audio/Subtitles readout bars once loading finishes with no known values (preserving vertical space), because playback detail loads lazily for the focused/next-up episode.
3. **Scroll back to hero:** Tizen animates scroll directly without tvOS's focus-engine scroll-lock polling.
4. **Update Required alert:** omitted because Tizen has no server update-requirement classification.
5. **Visual substitutes:** translucent black fill substitutes for Liquid Glass, and bundled `Inter` substitutes for SF Pro.

## References

- Apple TV (`silo-apple`, tvOS paths under `iosApp/iosApp/`): `7baff3ef`, `b3d08d44`, `df891d2e`, `5780c84`, `7e478b2`, `08ff656f`, `29c0dd43` (`TVDetailHero.swift`, `TVMovieDetailView.swift`, `TVSeriesDetailView.swift`, `TVDetailActions.swift`, `TVActionPopoverMenu.swift`, `TVEpisodeRail.swift`, `TVDetailFocusScroll.swift`, `TVTrailersRail.swift`).
- Verification: desktop Chromium tests cover synthetic behavior only; follow [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for signed `.wgt` verification and same-state Apple TV comparisons.
