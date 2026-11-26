# Library discovery

Movies and Series each keep one selected library using the existing server/profile storage key.
Recommended uses Home's shared Skyline backdrop, marquee and preference-aware media rows.
Featured rows and rows without supported video destinations are omitted; headings are not focus targets, and Explore All opens the existing library-scoped section catalog.
Recommended omits the Collections tab's collections; Collections is a separate destination, matching Apple TV.
A row the server marks `collection_posters` is the exception: it is an ordinary Recommended shelf, described under Rows of collections.
The top-bar cascade provides every supported library destination without a duplicate mode strip.
Hero enrichment uses the existing bounded queue after accepted loads and cached re-entry, never on focus movement.
Known artwork capabilities size the initial section read; a late improving answer rereads sections only and merges artwork by retained section/card identity.
That optional upgrade preserves membership, metadata, collections, focus and scroll, and an expected failure leaves the current screen usable.
Shared row cards reserve 20px above their buttons during edge reveal, covering the approximately 19px artwork overhang and rounding.
The existing scroll owner reads that CSS scroll margin; other controls keep its 12px minimum.
Browse is a separate whole-library Movies/Series grid, matching the split in Apple's `TVLibraryTypeTabView`.
It requests 100 cards at a time and prefetches when a card in the last eight rows becomes visible.
Apple's sorts for the library's media type (up to 17 for a series library, listed in [Settings](../settings.md)), typed facet groups and transient A–Z prefix share one query; moving focus alone sends no request.
Sort applies immediately; Filter edits a draft, applies through Done or Back from its root, and returns from a facet to the facet list on Back.
Committed sort and filters are remembered per server, profile and library while Preserve sort & filters is enabled; the prefix is never persisted.
The selected destination is not part of that memory. A new visit opens Recommended, so a saved Browse sort cannot replace the server shelves.
Browse retains loaded cards, item focus and scroll through ordinary Details/Back, and refreshes explicit personal/playback invalidation from page one through the retained depth.
Favorites and Watchlist changes in Details invalidate filtered Browse even when a write's answer is lost.
Duplicate cards and repeated cursors cannot accumulate; an invalid cursor restarts once. A later failed page keeps the loaded cards and shows nothing, and the grid reads again when a scroll brings a card near its end onto the screen, as each cell's `.onAppear` does (`TVLibraryGridViewModel.swift:138-143`, `:337-339`; `TVCatalogGrid.swift:131-133` at silo-apple `5780c84`).
Optional facet and Shuffle capability answers do not delay the catalog.
Poster size and badge answers repaint existing cards without changing their identity or querying the catalog again.
Supported whole-library Shuffle creates one non-retryable server session, resolves its current pick through the existing watch/version path, and advances through the player completion owner.
Pending Shuffle launches are discarded when their Browse visit is replaced, left or covered by Settings or Card Actions.
Mixed-library Movies/Series slices hide Shuffle because the server's library scope would include other media.
Collections preserves server groups and order, including opted-in personal collections, in a six-column portrait grid (seven Compact, five Large).
Each card uses the single poster or collage supplied by the server, without inventing additional posters.
Standard collection artwork is 260×390 with a 12px radius, 40px column spacing, 60px row spacing, and centered 24px title / 20px metadata captions.
Missing artwork uses a stack glyph over a stable collection-id gradient; cards with a poster URL show `poster_thumbhash` or the surface colour while loading and keep it with a faint `film` glyph if the image fails.
Collection entry focuses the first non-empty group; Back from members restores the collection by id.
An empty list, or a failed read, shows Apple's “No collections yet” empty state (`TVLibraryCollectionsView.swift:139-151`, `:183-191`).
Empty members say “Collection is empty”.
Named groups keep the server heading; the anonymous bucket has none.
Count captions follow Apple's `collection_type` mapping; management types such as manual and smart use ITEM/ITEMS.
No collection creation or management controls are offered on this TV surface.
Collection contents use `POST /catalog/query` with `source=library_collection` for curated collections or `source=user_collection` for personal collections, `collection_id` and the current library scope.
This matches Apple's `LibraryCollectionDetailViewModel` and includes the profile's `user_state.played` for watched badges.
The collection membership endpoint's listing projection omits that viewer state.
Expanded Home and library section rows read 60 cards at a time into one scrolling grid, reading more when the last six cards enter the viewport.
Section queries send only their Home/library scope, section id, optional library id, limit and cursor, matching Apple's `sectionItems` builder; media filtering stays local because the server rejects query overlays on section sources.
They retain loaded depth through Details and refresh explicitly invalidated state from the beginning through that depth.
Other catalog and collection pages still contain at most 24 cards.
Recommended media previews show at most 20 supported cards; Explore All opens their complete section contents.

## Modes, layout, and platform substitutions

The library tabs offer only Apple's three destinations, Recommended, Browse and Collections (`TVLibraryPillRow.swift:7-17`); genre, A–Z and date added are Browse's filter, letter rail and sort.
Browse's 1920 column, the letter rail and its 32 trailing overflow the screen and centre, as Apple's HStack does at silo-apple `5780c84` (`TVLibraryGridView.swift:98-108`, `TVCatalogGrid.swift:102-143`): the pills and grid start at x55 with the rail closed and slide to x16 as it opens, and the open rail draws on through the bottom safe area.
The rail's letters, the Sort panel's heading and the filter count use bundled Roboto Mono in place of SF Mono (`app/fonts/README.md`).
Inter substitutes for SF Pro, drawn SVGs replace SF Symbols, CSS scale/shadow replaces native parallax/specular focus, and the dark panel gradient approximates tvOS material.
The focused Sort direction stays readable instead of copying Apple's low-contrast label, and Filter keeps focus trapped inside its modal.
All requests use the existing operations/session/NativeHttp owners and active profile authority.
Changing mode, scope or sort starts a fresh page sequence; Back restores the previous collection or section focus.
Each library mode remembers its own committed card and scroll position under the shared public view id.
Loading and failed initial reads do not replace a saved visit with placeholder controls.
Back from Details, playback or Settings keeps the saved position when its card still intersects the viewport and fits horizontally inside its shelf.
A partly clipped shelf card is revealed, while a missing or offscreen shelf card uses the visible fallback.
Grid cards retain their identity and are revealed when offscreen.
Reduced motion leaves focused cards at their resting size.
Return visibility is measured before reveal, including when reduced motion applies scrolling immediately.
Entering library content from navigation does not restore a saved navigation or selector control as the default card.

The Browse port references Apple commit `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940` (`TVLibraryTypeTabView`, `TVLibraryGridView`, `CatalogSortKey`, `CatalogFilterState`, `CatalogFacets`, `CatalogQueryBuilder`, `ShuffleLauncher`); Collections references `bef81e8652a89c23a1c3cf07e312e9444baa6c4c` (`TVLibraryCollectionsView`, `TVCollectionPosterCard`, `LibraryCollectionDetailView`, `TVCardFocusStyle`).
Collection members use 60-member pages, matching Apple, including the personal collection catalog query.
Member failures retain explicit Retry; a failed list read shows the empty state.
Collection detail uses a centered title and the Swift tvOS 260×390 poster default.
Its count uses loaded membership plus a continuation suffix when query totals are inexact.
Capability-gated Shuffle initially owns focus and uses the shared launch, cancellation and playback owners with the collection scope.
Restricted-member visibility remains server-authoritative in both clients.
The API fixtures and consumed Shuffle wire fields are pinned to server commit `cc8514943289045e7b9f7ac8d36d4968bfe93926`.
Optional test screenshots require both `DISCOVERY_CAPTURE` and `DISCOVERY_OUTPUT`; ordinary tests create no evidence directory.
Desktop fake-server tests exercise discovery, Authority, and detail/player handoff; see [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for simulator, Chromium 108, and physical-TV proof gates.

## Rows of collections

A Home or library row with `section_type` `collection_posters` shows collections instead of titles (silo-apple `TVCollectionsRow`, `TVSkylineSectionFeed` and `SectionCollectionCard` at 6eea7cf7; silo-server `docs/catalog-api.md`, Rows of collections).
Its `collections` cards decode leniently: a card with an unknown source, or a server collection with no `library_id`, is left out and the rest of the row stays; a malformed backdrop leaves the card without one.
The row keeps the server's order, is never featured, and shows every card it lists: `item_limit` does not apply.
It has no Explore all card, because each collection is its own page, and `source=section` answers it with an empty page.
A row left with no cards is omitted like any empty row, and a library tab's Movies or Series narrowing, Home's card removal and the artwork upgrade pass it through unchanged.
Cards are the Collections tab's poster card at the title posters' size, keyed by source and id so Back restores the card.
A focused card previews in the Home hero with its backdrop when the server sent one, else its poster. It is no title, so the hero reads no detail for it and ends the previous card's pending read.
A server collection opens in its library (the page's own on a library page, so the tab's narrowing carries over); a personal collection opens its own page, read by collection id with no library.
The hero's meta line for a focused collection is its item count (`collections.itemCount`) and, for another profile's shared collection, `by Name` (`collections.card.byOwner`, silo-apple `CollectionOwnerName`); it has no synopsis. The owner is named from this login's profile list, read once through the profiles adapter when rows that need it are shown (not on focus), and the shown hero is drawn again when it lands. The acting profile's own collection, a server collection and an owner missing from the list have no by line. A failed list read is not retried until the screen is opened again.
