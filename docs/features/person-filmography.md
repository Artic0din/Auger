# Person hero and filmography

The Person page renders a portrait hero and metadata above a title count, All/Movies/Series filter chips, and an accumulating catalog grid (`src/ui/personFilmography.ts`, `src/ui/browseDetails.ts`).
The ready page has no Back, See all, or Read synopsis buttons; remote Back returns to the originating credit.
The page mirrors in Arabic RTL (`person:` is in `MIRRORED_VIEW`, `src/ui/browseFocus.ts`).

## Hero and portrait

- **Dates and age:** a living person with a valid `YYYY-MM-DD` `birth_date` shows that date and whole-year age computed against this TV's local calendar date (never UTC; Feb 29 birthdays reach age on Mar 1 in non-leap years; future birth dates omit age). A `death_date` shows the death fact and omits living age. Non-calendar strings display unchanged with no invented age. English uses medium date formatting (`12 Apr 1980`); non-English app languages use the TV region's numeric order with the shown language's digits (`17/8/1943`, `١٧/٨/١٩٤٣`; see [translation.md](../translation.md)).
- **Portrait and ThumbHash:** 300×450 portrait (12 px radius, 1 px white 10% border) draws `photo_thumbhash` (rejecting inputs longer than 44 Base64 chars) underneath until the image loads, then fades in over 120 ms (instant in reduced motion). Failed photos retain a decoded ThumbHash rather than swapping to initials. Missing photos show the first grapheme of each of the first two name words via `unicode-segmenter` (handles Hangul, Indic conjuncts missing in Chromium 108 ICU 72, and emoji), or `?` when empty.
- **Image transport and lifecycle:** signed photo URLs send no app credentials and `no-referrer`; Back or Authority changes abort pending image loads.

## Metadata refresh and filmography paging

- **Queries:** every page uses `personQuery` (`POST /catalog/query`, `source: "person"`, `sort: "year"`, `order: "desc"`, `limit: 60`, opaque `cursor`): All sends `type: "video"` (Apple omits `type`; Tizen keeps `video` as locked by tests), Movies sends `movie`, and Series sends `series`.
- **Count and availability:** exact totals use `library.titleCount` with `groupedCount`; non-exact estimates defer to loaded item count using `library.titleCountMore` while more pages remain and `library.titleCount` once exhausted (omitted when zero items loaded). Movies and Series chips hide only when a `limit: 1` probe returns zero items and zero total; failed probes keep the chip visible.
- **Metadata refresh:** if trimmed biography, photo URL, or birth date is missing, the page dispatches one non-replayed `POST /catalog/people/{id}/refresh` per visit and polls every 3 s up to 120 s (stopping on complete metadata or five consecutive unchanged answers). Leaving cancels polling; returning resumes an unfinished visit without a second dispatch. Metadata failure retains loaded credits, Retry, and Back; first-works failure retains hero and filters.
- **Accumulating grid:** `feedGrid` prefetches the next 60-title page when scrolling reveals the last eight rows (48 cards at six columns; 40 at five columns for Large posters), guarded against overlapping reads. Focus movement alone never fetches. Failed later pages keep loaded cards silently and retry when scrolling away and back; `invalid_cursor` restarts once from page one. Details/CardActions returns refresh from page one through the committed depth and restore focus by item identity.

## Layout, focus, and upstream references

- **Layout:** rendered insets are horizontal 160 px, top 108 px, bottom 132 px (Swift 80/48/72 plus tvOS 80/60 safe areas); 72 px bold title, 26 px regular biography (`Font.siloBody`, 7-line clamp, 920 px max width), 20 px fact capsules, 36 px Filmography heading, 22 px count/chips, 1600 px grid (6 flexible cells at 273.33 px pitch, 60 px row gap, 260×390 posters), and 420 px reserved empty/error/loading frame. Bundled `Inter` substitutes for SF Pro ([app/fonts/README.md](../../app/fonts/README.md)).
- **Focus:** initial loading renders an empty focus-owning loading page (`pageLoadingView`) until person metadata arrives; once loaded, focus enters the first grid card (or `All` while filmography is still loading), preserves chip focus across filter loads, moves Up from row 1 to the chip closest to the card's start edge (`startOffset` in `inlineAxis.ts`) and resets scroll to zero; reopening Person from a credit starts a fresh `All` visit.
- **Sources:** `silo-apple` `f3347940`, `9723df00`, and `7baff3ef` (`Screens/People/PersonDetailView.swift`, `tvOS/Screens/Components/TVCatalogGrid.swift`), `silo-android` `670f5ba0` (`TvPersonDetailViewModel.kt:21`), and `silo-server` `cc851494` (`src/contracts/v2/SOURCE`).
- **Verification:** desktop tests cover synthetic behavior only; follow [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for signed `.wgt`, Apple TV comparison (60+ title person, missing/failed photos, Large 5-column switch, refresh polling, Back restoration), and hardware gates.
