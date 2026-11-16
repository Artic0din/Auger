# Translating screens

Screens read their text from the vendored catalog through `translate(key, args)` (`src/i18n/translate.ts`), in the language the app shows.
A key a language lacks shows English.
How the catalog is vendored and refreshed is in [`src/i18n/catalog/README.md`](../src/i18n/catalog/README.md); the plan is on [#571](https://github.com/Artic0din/silo-tizen/issues/571).

## Rules for a screen

- Use the key silo-apple's tvOS code uses for the same text, read from its Swift source (`AppLanguage.string(.detailResume)` is `detail.resume`).
- Name the key as a whole string at the call (`translate("detail.resume")`), never built from parts, so a search of `src` finds every key in use.
- English must not change: take a key only when its English is the text the screen already shows.
  Where Apple's English differs, the text stays as it is until a parity fix changes it on its own.
- Server-provided text (titles, overviews, people, genres, studios) is shown as the server sends it.
- Counts that Apple writes with `LocaleFormat.integer` use `integerText`, and ones it groups use `groupedCountText` (`src/i18n/numbers.ts`).
  A season or episode inside a code (`S1:E2`) stays in ASCII digits.

## On the catalog

| Screen | Text |
|---|---|
| Details (movie, series, season, episode) | action row, readout, Version, Audio and Subtitles lists, More menu, facts, rails, empty, error and alert text, trailer status |
| Search | field prompt, filters, empty and first-visit states, result count, People and Box Sets headings, the Requests section heading and caption |

## Still English

Apple has no key for these, or they belong to a later row of the plan.

- Tizen-only Details text: the circle buttons' `Versions` and `Audio Tracks`, `Seasons`, `Unknown language`, `Special N`, preference-save notes (`Saving audio preference…`), the unplayable-file notes, `Loading extra…`, the personal-action retry notes, and the held-change alert.
- Durations, dates and file facts: `1h 5m`, `45 min`, the facts' release dates (`Intl` with the device locale, not the shown language), and language names (`Intl` asked for English).
- Box set cards, Request cards and the error screen's buttons: collections, requests and error rows of the plan.
- Subtitle track names from `src/player/trackLabels.ts` (`(Forced)`, `(SDH)`, `External`): the player row.
