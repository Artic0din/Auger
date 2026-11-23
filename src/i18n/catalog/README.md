# Vendored Silo string catalog

`SOURCE` pins the exact `silo-translations` commit these files come from. Each `<tag>.json` reduces that repository's `catalog/<tag>.arb` to `key -> ICU message`. See [docs/settings.md](../../../docs/settings.md#app-language) and [docs/translation.md](../../../docs/translation.md) for runtime usage.

## Filtering and app naming rules

- **Included keys:** keys shipped by Apple (no `x-platforms`, or naming `apple`) because tvOS is the parity target and uses the ICU subset supported by `src/i18n/icu.ts`. Metadata and `Info.plist` prompts are excluded; any message outside the supported ICU subset stops sync.
- **Android exception:** `PLATFORM_EXCEPTIONS` in `scripts/sync-translations.ts` also vendors `settings.skipIntervals.footerVideo` because Apple's copy names the Siri Remote.
- **Brand substitution:** `APP_NAME_KEYS` in `scripts/sync-translations.ts` replaces `Silo` with `Auger` in app-name strings ([#733](https://github.com/Artic0din/silo-tizen/issues/733)) while keeping `Silo` in Server references. Sync fails for review if an English `APP_NAME_KEYS` entry stops containing `Silo`; add new app-name keys to `APP_NAME_KEYS`.
- **Per-language trimming:** `en.json` keeps the full Apple keyset. Each of the other 21 shipped languages keeps only keys named as literal strings in `src/` plus every `home.section.*` and `error.*` key (`SERVER_KEY_PREFIXES` in `scripts/sync-translations.ts`), saving ~5 MB in the `.wgt`. A test pins every non-English file to the exact keys in use, so adding or removing a screen key requires a fresh sync.

## Package loading

- `SHIPPED_LANGUAGES` (`src/i18n/language.ts`) lists shipped languages in Apple order (English first, rest sorted by tag; the picker sorts by display name via `shippedByName`). A test pins this list to the files in this directory.
- Only `en.json` bundles into `main.js` (imported by `translate.ts`). `scripts/catalog-files.ts` packages every other language as `catalog/<tag>.js`; `src/i18n/load.ts` loads it on demand and calls `registerCatalog` to redraw screens.

## Refreshing the catalog

Sync against an explicit commit or release tag, never a moving branch, then run `npm test`:

```sh
npm run sync:translations -- <silo-translations commit or tag>   # all shipped languages
npm run sync:translations -- <commit or tag> --languages en,de   # subset (deletes unlisted files)
```
