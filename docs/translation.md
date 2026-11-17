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
- The week strip's weekday is the stand-alone abbreviation Apple prints (`abbreviatedWeekday`, `src/i18n/weekdays.ts`): "Mo" in German, "ثلاثاء" in Arabic, where `Intl` gives "Mo." and "الثلاثاء". The table is `scripts/weekday-names.swift`'s output from Foundation (run it on a Mac to refresh it).
- An air time is Apple's `.shortened` time (silo-apple `DateFormatters.localShortTime`): the shown language's words and digits with the **device's clock setting** for 12 or 24 hours. `tizen.time.getTimeFormat()` ("h:m:s ap" is 12 hours, "h:m:s" is 24; the Time API documents no privilege, so `config.xml` is unchanged) is read first; where it is missing or throws, the device region's hour cycle decides, as Foundation's `formattingLocale` does ("8:00 AM" in German on an Australian or US TV). Chromium takes the cycle from the language alone, so `calendarState.ts` passes it in. English keeps `en` and 12 hours when no clock setting is available.
- Requests' hero line is one text, as silo-apple's `TVFocusMarquee.metaText` draws it (`lead.joined(separator: " · ")`): year, `Movie` or `Series` (Apple's `displayName`, a plain English string, not server text) and `Requested {date}`. Its base direction is the first strong letter's (`unicode-bidi: plaintext`), so in Arabic `Movie` makes it a left-to-right line, as Core Text does.
- Counts and numbers written into a placeholder use `integerText` (`src/i18n/numbers.ts`), Apple's `LocaleFormat.integer`: the shown language's digits, never grouped.
  A season or episode inside a code (`S1:E2`) stays in ASCII digits.
  A year is one of these: Details' facts line and loading line, a card's year badge, audiobook narrations, Requests and Watch Party facts all print it with `integerText`, as Apple's `TVDetailHero`, `OverlayRegistry`, `TVRequestsPage` and `WatchPartyLobbyState` do.
  The player's info panel still writes its Year row in ASCII: Apple's tvOS Info has no such row, so it keeps its English with the other Tizen-only rows.

## On the catalog

| Screen | Text |
|---|---|
| Details (movie, series, season, episode) | action row, readout, Version, Audio and Subtitles lists, More menu, facts, rails, empty, error and alert text, trailer status |
| Top bar and menus | the roots, Search and Profile buttons, the For You, library and profile menus, the sign-out confirmation |
| Home | `Loading home`, the empty state, `Explore all`, row titles the server keys |
| Watch Party | the hub, lobby, Ready, ballot, options and End sheets, invitation and its QR text, picker shelves, confirmation page, episode list and the room's notices (silo-apple `Screens/WatchParty`, `WatchParty/WatchPartyLobbyState.swift` at 6eea7cf7) |
| Home cards | the caption's episode code and years, the marquee's season and episode, time left, runtime and the Aired line, the card menu's Remove rows and update-failed alert, a season pill's Mark Season rows |
| For You | loading and empty text, row titles the server keys (`title_key` on each Discover row) |
| Library tabs | Recommended and Collections states, collection counts, Browse's Sort and Filter panels, A–Z rail, empty and loading states, the shuffle alert |
| Search | field prompt, filters, empty and first-visit states, result count, People and Box Sets headings, the Requests section heading and caption |
| Requests (hub, My Requests, detail) | status labels and stage tracks, headings, the record menu and its remove confirmation, write notices, facts (seasons, runtime, dates in the shown language), request cards |
| Calendar | filters, week arrows, Today and Jump to today, badges, season and episode captions, day headings, empty states, air times and dates in the shown language |
| Accounts | Change Account (headline, badges, add cards), Settings › Accounts and its sign-out and remove-server confirmations, profile counts |
| Player | the transport's button and scrubber labels, the Info, Stats, Video, Audio, Subtitles and Chapters tabs and their headings, rows and pickers (Appearance names, Search and Delay, On and Off), Up Next, On Deck and Keep Watching, the skip pill, the buffering prompt, a track's Forced, SDH, External, Default, Mono, Stereo and channel count, and the exit dialog's Cancel (silo-apple `Screens/Player/tvOS`, `PlayerTrack.swift`, `TrackLabels.swift` at 6eea7cf7) |
| PIN and Add Profile | the PIN screen's prompt, progress, wrong-PIN and lockout lines, Cancel; Add Profile's title, labels, avatar styles, Child Profile and Restrict libraries toggles, Create Profile |

## Right to left

Arabic reads right to left, as on Apple TV, where the root view sets `\.layoutDirection` from the language ([silo-apple `docs/i18n.md`, Right to left](https://github.com/Silo-Server/silo-apple/blob/main/docs/i18n.md)).

- `applyLayoutDirection` (`src/i18n/direction.ts`) sets `lang` on the document root to the text language on screen (`en`, the page's default, for English) and `dir="rtl"` when it is right to left, removing `dir` otherwise.
  The direction is the language's CLDR direction from `Intl.Locale` (Apple's `characterDirection`; Chromium 108 offers it as `textInfo`, newer engines as `getTextInfo()`), with a short list of the shipped right-to-left languages for an engine that has neither, and it follows `textLanguage()`, so the layout mirrors in the same redraw as the words.
- Browse sets it at launch from the kept language and in `reconcileLanguage`; Settings sets it in the repaint that follows a language change.
  Browse clears it when it is torn down, because the sign-in and profile screens are still English. A screen opened over browse (Add Profile, Switch Server) keeps it, as on Apple TV, where the root view sets the direction app-wide (silo-apple `iOSApp.swift:75`, `AddProfileFromMenu.swift:8-17`, `TVMainTabView.swift:1767-1768`); Add Profile's sign-in-style layout (`signIn.css`) still has physical offsets and is listed on #571.
  The sign-in and profile-picker screens (`ScreenHost` sections) are English until their text is on the catalog, so each carries `lang="en"` under a page whose `lang` is the shown language; a screen sets `translated: true` when its text moves, and `ScreenHost` then gives its section the shown language and direction (`applyScreenDirection`, `src/i18n/direction.ts`) instead. Change Account, the PIN screen and Add Profile are translated: they carry their own `lang` and `dir`, so they read and mirror the same with a browse page under them or none.
- Only Home, Search, Requests, Calendar, Settings, Change Account, Watch Party, Details and a library's Browse page (`MIRRORED_VIEW` in `src/ui/browseFocus.ts`) follow the page's direction. `FocusHost.show` pins every other view's content `dir="ltr"`, so a view that is not converted yet keeps its layout and its keys; the top bar, its menus and the hero layers (the nodes `Skyline.decorate` marks `data-chrome`) stay with the page and mirror above it. Remove a view from the pinned set by adding its name to `MIRRORED_VIEW` once its CSS and key handling are mirrored.
- `remoteKey` swaps Left and Right when the element that received the key is in an `rtl` layout (`readsRightToLeft`), as Apple's `MoveCommandDirection.inLayout` does, so a handler that steps "left" toward the start of a row, a menu or a pane keeps doing that on the mirrored screen.
  Zone code says "left" and "right" in layout terms; only `remoteKey` knows the remote is physical.
  Media transport reads `physicalKey` instead: the player is `dir="ltr"` (a rewind stays on the left in every language).
- CSS uses logical properties (`margin-inline-start`, `inset-inline-start`, `text-align: start`), which behave as the physical ones in English.
  Where Chromium 108 has no logical form (`float`, gradient and mask directions) a `:root[dir="rtl"]` rule overrides it.
  `chevron.forward` and `arrow.forward` symbols flip (`icon-forward`); card overlays and badges stay left to right, except a box set's BOX SET label and film count, which Apple places top-leading and bottom-trailing (`BoxSetCardBadges.swift`).
- Server-provided text (titles, names, overviews, captions) is isolated in a right-to-left page by one rule at the top of `browse.css`: `unicode-bidi: plaintext` takes the base direction from the text's own first letter, so `10 Cloverfield Lane` is not reordered as `Cloverfield Lane 10`, and `text-align: right` keeps the line aligned by the layout, as SwiftUI's `Text` is.
  Add a class to that list when a new element shows server text; app text is on the catalog and needs nothing.
  The Search field is `dir="auto"` instead: like Apple's field it aligns by what is typed (Latin text reads left to right in Arabic), and an empty field takes the layout's direction for its prompt.

Mirrored so far: the top bar and its menus (the profile menu under its button, a library's sections beside it), Home, Settings, Change Account, a library's Browse page (the grid reads right to left and the A–Z rail moves to the left edge, as silo-apple `TVLibraryGridView.swift:100-108` does with its trailing 32 pt), Search (the field, People, box sets, requests and results read from the right, as SwiftUI's `.leading` alignments do), and the hero art on Home and Details, including their placeholder layers and the marquee's title logo.
Not yet, and listed on [#571](https://github.com/Artic0din/silo-tizen/issues/571):
Details rails (episodes, season pills, cast) mirror, and the episode and season rows scroll with right-to-left (negative) offsets; their CSS spacing is still the left-to-right one.
Collections, For You (library roots and For You share Home's hero scene, so their hero is mirrored above their left-to-right rows), History and Watchlist and audiobooks stay left to right under the mirrored top bar, and so does the player.
Watch Party is mirrored with them: the hub, lobby, options and End sheets, invitation, picker shelves, confirmation page and episode list read from the right as SwiftUI's `.leading`, `.topLeading` and `.topTrailing` alignments do (silo-apple has no `layoutDirection` override in `Screens/WatchParty`), the backdrop's dark side moves with the layout, and a member's or host's name inside a sentence is wrapped in first-strong isolates (`isolated`, Apple's `AppLanguage.isolated`) so it keeps its own direction.
The player reads its Arabic text but keeps its layout and physical keys.
Apple pins only the transport, the scrubber and its time row left to right (`.mediaLayoutDirection()`, `TVPlayerControls.swift:325,555,557,575`) and mirrors the rest: the options panel's tabs and panes, Up Next, the buffering card and the error page.
That mirroring is not built yet, and a title, track or chapter name takes its own direction (`unicode-bidi: plaintext` at the top of `player.css`).
Requests, Calendar, Change Account, the PIN screen and Add Profile are mirrored: their art, copy, rails, badges and corners follow the layout's leading and trailing edges as silo-apple's `.leading`, `.topTrailing` and `.bottomTrailing` alignments do, the week strip and number pad read from the right, and Left and Right step through them that way.
The sign-in screens, the profile picker and Switch Server's entry screens (`signIn.css`: `.marquee-chip` `right`, `.marquee-card` `margin-left`, several `margin-right`) keep their English text and left-to-right layout.

## Still English

Apple has no key for these, or they belong to a later row of the plan.

- Tizen-only Details text: the circle buttons' `Versions` and `Audio Tracks`, `Seasons`, `Unknown language`, `Special N`, preference-save notes (`Saving audio preference…`), the unplayable-file notes, `Loading extra…`, the personal-action retry notes, and the held-change alert.
- Dates and the season view's `45 min` line: the facts' release dates use `Intl` with the device locale, not the shown language.
- Home's original-language overlay (`cardOverlays.languageName`) and the card menu's Play, Resume, Mark as Watched, Add to Favorites and Add to Watchlist rows: Apple builds those as plain strings, so they stay English (see [settings.md](settings.md#card-for-you-and-library-text)).
- Box set cards and the error screen's headline and buttons (`Something went wrong`, `Try Again`, `Go Back`, `Sign In Again`): collections and error rows of the plan.
- Requests text with no Apple key, or whose English differs: the `Movie` and `Series` facts (Apple's `displayName` is a plain string), `Not requested` on a card, `Search requests`, the Search button, `Previous page`, `Next page`, `No titles found.`, `No requests yet.`, `Loading requests…`, `Follow`, `Unfollow`, `Cancel request` on the detail (Apple's key reads `Cancel Request`), `Refresh`, `Could not load title information…`, `Could not confirm the change…`.
- Calendar text with no Apple key: `Details unavailable for this event type`, `Loading Calendar`, `Could not load Calendar. Try again.` and the time-zone errors.
- Accounts, PIN and Add Profile text with no Apple key: `Could not open the account. Try again.`, `Removing…`, `Signing out…`, the sign-out failure messages, `Checking the PIN.`, the server-busy and unreachable PIN lines, `Delete` on the pad, Add Profile's `Content rating`, library and error lines, `Creating profile`, `Choose profile`.
- Watch Party text with no Apple key: the ballot row's `Suggestions` label, `Loading titles…`, the empty picker's `Add a title to a watchlist and it shows up here.` (Apple's `watchParty.picker.emptyBody` mentions a search Tizen does not have), an episode tile's `E1` and its `series, season N, episode M` label, and the errors for a ballot the server sent wrongly. Apple's tvOS empty season reads `No episodes in this season` with `Reload episodes`; Tizen keeps the `No episodes` page it already had, in Apple's keys.
- Player text with no Apple key, or whose English differs: the error messages (`errorText`), `Restoring` and `Reconnecting` (Apple's `player.notice.reconnectingTitle` is `Reconnecting…`), `Changing quality`, `Changing track` and the track-change failures, `Loading audio tracks`, `No audio tracks listed`, the Info rows `Series`, `Year`, `Rating` and `Genres` and the chapter and title-detail notes, the `Player options` tab list label, `Play next`, `Cancel autoplay`, `Playing in Ns`, `S1 · E2`, `Back to subtitles` (Apple's key capitalises Subtitles), the Appearance rows `Text color`, `Text opacity`, `Outline color`, `Background color` and `Background opacity` (Apple's rows read differently), `Translate current subtitles`, `Transcribe current audio`, the series-subtitle rows, the subtitle search, AI and display messages, the Stats rows `Protocol`, `Video codec`, `Audio codec`, `Output resolution` and `Configured bitrate`, `Track N` and `Subtitles N`, and the exit dialog's `Exit Silo?`, `Exit` and `Could not exit Silo.`.
- A language that lands while playback is up makes the screen ask the controller to send its playing or paused view again (`refreshView`), once no Select is held, so track names, their flags and Up Next's status words rebuild; the screen then redraws an open panel and picker. A loading, restoring, completion or error view is left as it is. The end-of-playback page's heading and a buffering notice already on screen were built when they appeared, so they read English until the next view.
