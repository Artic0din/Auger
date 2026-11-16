# Silo strings (vendored)

`SOURCE` holds the exact `silo-translations` commit these files come from.
`<tag>.json` is that repository's `catalog/<tag>.arb`, reduced to `key -> ICU message`.
The keys are the ones Apple ships (no `x-platforms`, or one naming `apple`), because tvOS is the parity target and Apple's keys use the ICU subset `src/i18n/icu.ts` reads.
Metadata and Info.plist prompts are left out, and a message outside that subset stops the sync.
Today only `en.json` is vendored: 3,571 messages, 247 KB (57 KB gzipped).
Phone-only text is in it, because `x-platforms` names `apple` for all Apple devices; trim it by key prefix if the size ever matters.

Refresh at an explicit commit or release tag, never a moving branch:

```sh
npm run sync:translations -- <silo-translations commit or tag>
npm run sync:translations -- <commit or tag> --languages en,es,de
```

Then add each new language to `SHIPPED_LANGUAGES` (`src/i18n/language.ts`) and `CATALOGS` (`src/i18n/translate.ts`), and run `npm test`.
A test holds the shipped list to the files here.
Nothing in `src` imports a catalog file except `translate.ts`, so a build that shows no catalog text carries none of it.

How screens use it is in [docs/settings.md](../../../docs/settings.md#app-language).
