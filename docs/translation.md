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

## Still English

Apple has no key for these, or they belong to a later row of the plan.

- Tizen-only Details text: the circle buttons' `Versions` and `Audio Tracks`, `Seasons`, `Unknown language`, `Special N`, preference-save notes (`Saving audio preference…`), the unplayable-file notes, `Loading extra…`, the personal-action retry notes, and the held-change alert.
- Dates and the season view's `45 min` line: the facts' release dates use `Intl` with the device locale, not the shown language.
- Home's original-language overlay (`cardOverlays.languageName`) and the card menu's Play, Resume, Mark as Watched, Add to Favorites and Add to Watchlist rows: Apple builds those as plain strings, so they stay English (see [settings.md](settings.md#card-for-you-and-library-text)).
- Box set cards, Request cards and the error screen's buttons: collections, requests and error rows of the plan.
- Subtitle track names from `src/player/trackLabels.ts` (`(Forced)`, `(SDH)`, `External`): the player row.
