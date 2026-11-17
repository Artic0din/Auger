# Translating screens

Screens read their text from the vendored catalog through `translate(key, args)` (`src/i18n/translate.ts`), in the language the app shows.
A key a language lacks shows English.
How the catalog is vendored and refreshed is in [`src/i18n/catalog/README.md`](../src/i18n/catalog/README.md); the plan is on [#571](https://github.com/Artic0din/silo-tizen/issues/571).

## Rules for a screen

- Use the key silo-apple's tvOS code uses for the same text, read from its Swift source (`AppLanguage.string(.detailResume)` is `detail.resume`).
- Name the key as a whole string at the call (`translate("detail.resume")`), never built from parts, so a search of `src` finds every key in use.
- English must not change: take a key only when its English is the text the screen already shows.
  Where Apple's English differs, the text stays as it is until a parity fix changes it on its own.
- Server-provided text (titles, overviews, people, genres, studios) is shown as the server sends it. The exception is a Home section title that carries `title_key`: `serverText` (`src/i18n/translate.ts`) shows the shown language's own translation of that `home.section.*` key, and the server's title otherwise ([details](settings.md#home-and-navigation-text)).
- Runtimes use `durationText` (`src/i18n/duration.ts`), which prints what Apple's formatter prints: `2h 8m`, and `2h 8min` in German. Its patterns come from Foundation (`scripts/duration-patterns.swift`), because the TV's Chromium has no equivalent.
- A track's language is named in the shown language (`languageName` in `src/player/trackLabels.ts`, Apple's `TrackLabels.languageName`): `Portugiesisch` in German. A tag with a region reads as its language, as Apple's does (`pt-BR` is Portuguese).
- Counts and numbers written into a placeholder use `integerText` (`src/i18n/numbers.ts`), Apple's `LocaleFormat.integer`: the shown language's digits, never grouped.
  A season or episode inside a code (`S1:E2`) stays in ASCII digits.

## On the catalog

| Screen | Text |
|---|---|
| Details (movie, series, season, episode) | action row, readout, Version, Audio and Subtitles lists, More menu, facts, rails, empty, error and alert text, trailer status |
| Top bar and menus | the roots, Search and Profile buttons, the For You, library and profile menus, the sign-out confirmation |
| Home | `Loading home`, the empty state, `Explore all`, row titles the server keys |
| Home cards | the caption's episode code and years, the marquee's season and episode, time left, runtime and the Aired line, the card menu's Remove rows and update-failed alert, a season pill's Mark Season rows |
| For You | loading and empty text, row titles the server keys (`title_key` on each Discover row) |
| Library tabs | Recommended and Collections states, collection counts, Browse's Sort and Filter panels, A–Z rail, empty and loading states, the shuffle alert |
| Search | field prompt, filters, empty and first-visit states, result count, People and Box Sets headings, the Requests section heading and caption |

## Right to left

Arabic reads right to left, as on Apple TV, where the root view sets `\.layoutDirection` from the language ([silo-apple `docs/i18n.md`, Right to left](https://github.com/Silo-Server/silo-apple/blob/main/docs/i18n.md)).

- `applyLayoutDirection` (`src/i18n/direction.ts`) sets `lang` on the document root to the text language on screen (`en`, the page's default, for English) and `dir="rtl"` when it is right to left, removing `dir` otherwise.
  The direction is the language's CLDR direction from `Intl.Locale` (Apple's `characterDirection`; Chromium 108 offers it as `textInfo`, newer engines as `getTextInfo()`), with a short list of the shipped right-to-left languages for an engine that has neither, and it follows `textLanguage()`, so the layout mirrors in the same redraw as the words.
- Browse sets it at launch from the kept language and in `reconcileLanguage`; Settings sets it in the repaint that follows a language change.
  Browse clears it when it is torn down, because the sign-in and profile screens are still English. A screen opened over browse (Add Profile, Switch Server) keeps it, as on Apple TV, where the root view sets the direction app-wide (silo-apple `iOSApp.swift:75`, `AddProfileFromMenu.swift:8-17`, `TVMainTabView.swift:1767-1768`); Add Profile's sign-in-style layout (`signIn.css`) still has physical offsets and is listed on #571.
  Those screens (`ScreenHost` sections and the accounts screens) are English until their text is on the catalog, so each carries `lang="en"` under a page whose `lang` is the shown language; remove it when a screen translates.
- Only Home, Search, Settings, Change Account, Details and a library's Browse page (`MIRRORED_VIEW` in `src/ui/browseFocus.ts`) follow the page's direction. `FocusHost.show` pins every other view's content `dir="ltr"`, so a view that is not converted yet keeps its layout and its keys; the top bar, its menus and the hero layers (the nodes `Skyline.decorate` marks `data-chrome`) stay with the page and mirror above it. Remove a view from the pinned set by adding its name to `MIRRORED_VIEW` once its CSS and key handling are mirrored.
- `remoteKey` swaps Left and Right when the element that received the key is in an `rtl` layout (`readsRightToLeft`), as Apple's `MoveCommandDirection.inLayout` does, so a handler that steps "left" toward the start of a row, a menu or a pane keeps doing that on the mirrored screen.
  Zone code says "left" and "right" in layout terms; only `remoteKey` knows the remote is physical.
  Media transport reads `physicalKey` instead: the player is `dir="ltr"` (a rewind stays on the left in every language).
- CSS uses logical properties (`margin-inline-start`, `inset-inline-start`, `text-align: start`), which behave as the physical ones in English.
  Where Chromium 108 has no logical form (`float`, gradient and mask directions) a `:root[dir="rtl"]` rule overrides it.
  `chevron.forward` and `arrow.forward` symbols flip (`icon-forward`); card overlays and badges stay left to right, except a box set's BOX SET label and film count, which Apple places top-leading and bottom-trailing (`BoxSetCardBadges.swift`).
- Server-provided text (titles, names, overviews, captions) is isolated in a right-to-left page by one rule at the top of `browse.css`: `unicode-bidi: plaintext` takes the base direction from the text's own first letter, so `10 Cloverfield Lane` is not reordered as `Cloverfield Lane 10`, and `text-align: right` keeps the line aligned by the layout, as SwiftUI's `Text` is.
  Add a class to that list when a new element shows server text; app text is on the catalog and needs nothing.

Mirrored so far: the top bar and its menus (the profile menu under its button, a library's sections beside it), Home, Settings, Change Account, a library's Browse page (the grid reads right to left and the A–Z rail moves to the left edge, as silo-apple `TVLibraryGridView.swift:100-108` does with its trailing 32 pt), Search (the field, People, box sets, requests and results read from the right, as SwiftUI's `.leading` alignments do), and the hero art on Home and Details, including their placeholder layers and the marquee's title logo.
Not yet, and listed on [#571](https://github.com/Artic0din/silo-tizen/issues/571):
Details rails (episodes, season pills, cast) mirror, and the episode and season rows scroll with right-to-left (negative) offsets; their CSS spacing is still the left-to-right one.
Collections, For You (library roots and For You share Home's hero scene, so their hero is mirrored above their left-to-right rows), History and Watchlist, Requests, Calendar, Watch Party, audiobooks and Accounts stay left to right under the mirrored top bar, and so does the player.

## Still English

Apple has no key for these, or they belong to a later row of the plan.

- Tizen-only Details text: the circle buttons' `Versions` and `Audio Tracks`, `Seasons`, `Unknown language`, `Special N`, preference-save notes (`Saving audio preference…`), the unplayable-file notes, `Loading extra…`, the personal-action retry notes, and the held-change alert.
- Dates and the season view's `45 min` line: the facts' release dates use `Intl` with the device locale, not the shown language.
- Home's original-language overlay (`cardOverlays.languageName`) and the card menu's Play, Resume, Mark as Watched, Add to Favorites and Add to Watchlist rows: Apple builds those as plain strings, so they stay English (see [settings.md](settings.md#card-for-you-and-library-text)).
- Box set cards, Request cards and the error screen's buttons: collections, requests and error rows of the plan.
- Subtitle track names from `src/player/trackLabels.ts` (`(Forced)`, `(SDH)`, `External`): the player row.
