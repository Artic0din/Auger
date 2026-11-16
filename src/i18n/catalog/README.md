# Silo strings (vendored)

`SOURCE` holds the exact `silo-translations` commit these files come from.
`<tag>.json` is that repository's `catalog/<tag>.arb`, reduced to `key -> ICU message`.
The keys are the ones Apple ships (no `x-platforms`, or one naming `apple`), because tvOS is the parity target and Apple's keys use the ICU subset `src/i18n/icu.ts` reads.
Metadata and Info.plist prompts are left out, and a message outside that subset stops the sync.
`en.json` holds all 3,571 messages (247 KB, 57 KB gzipped).
Each of the other 21 languages (Apple's list) holds only the keys `src` names as strings, 226 today at 16 to 26 KB each: the whole catalog would add about 5 MB to the package, and a key no screen shows is dead weight there. A test holds each file to exactly the keys in use, so a screen that starts using a key needs a new sync, and one that stops using it a new sync too.
Phone-only text is in it, because `x-platforms` names `apple` for all Apple devices; trim it by key prefix if the size ever matters.

Refresh at an explicit commit or release tag, never a moving branch:

```sh
npm run sync:translations -- <silo-translations commit or tag>   # every shipped language
npm run sync:translations -- <commit or tag> --languages en,de   # a subset deletes the other files
```

`SHIPPED_LANGUAGES` (`src/i18n/language.ts`) lists them in Apple's order, English first and the rest sorted by tag, with the name Apple shows for each (`AppLanguage.shipped`; the picker sorts by that name instead, `shippedByName`); the build packages each file but English's as `catalog/<tag>.js` in the .wgt (`scripts/catalog-files.ts`). Add a new language to the list, and run `npm test`.
A test holds the shipped list to the files here.
Only `en.json` is imported, by `translate.ts`: English is in `main.js`. Every other language is loaded when it is the language shown (`src/i18n/load.ts` adds a script for its packaged file), the screens read English until it lands, and `registerCatalog` then tells them to draw again. A test holds every packaged file to the vendored text and to the keys `src` names.

How screens use it is in [docs/settings.md](../../../docs/settings.md#app-language).
