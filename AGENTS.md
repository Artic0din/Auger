# Repository guidelines

## Context pointers

Read the matching reference before editing a branch of the codebase.

- **Domain terms and entity rules.** Read [GLOSSARY.md](GLOSSARY.md) and [docs/domain-model.md](docs/domain-model.md).
- **Runtime overview and hardware proof status.** Read [docs/app-behaviour.md](docs/app-behaviour.md) and [FEATURES.md](FEATURES.md).
- **TV focus, menus, grids, dialogs, or remote keys.** Read [docs/tv-focus.md](docs/tv-focus.md).
- **API v2 transport, auth, retries, or contract fixtures.** Read [docs/native-api-v2.md](docs/native-api-v2.md) and [src/contracts/v2/README.md](src/contracts/v2/README.md).
- **Settings keys, scopes, and AVPlay exclusions.** Read [docs/settings.md](docs/settings.md).
- **Translations, string catalog, and Arabic RTL.** Read [docs/translation.md](docs/translation.md) and [src/i18n/catalog/README.md](src/i18n/catalog/README.md).
- **Offline cache, KeyManager artwork, and cold-start restore.** Read [docs/offline-browse.md](docs/offline-browse.md).
- **Player options HUD, playback quality, autoplay, trickplay, or subtitles.** Read [docs/player-hud.md](docs/player-hud.md) and the playback specs in [docs/README.md](docs/README.md#playback).
- **Browse, Details, Search, Person, Requests, Accounts, or Watch Party.** Use the feature specs in [docs/README.md](docs/README.md#features).
- **Porting from Apple TV or Android TV.** Read [docs/upstream-design-notes.md](docs/upstream-design-notes.md).
- **Tests, fake clocks, and flake hunting.** Read [test/README.md](test/README.md).
- **CI checks, required ruleset contexts, and workflows.** Read [docs/ci-checks.md](docs/ci-checks.md).
- **Simulator capture, signed `.wgt` verification, and Apple TV comparison.** Read [docs/evidence/simulator-evidence.md](docs/evidence/simulator-evidence.md).
- **Releases, sideloading, and Apps2Samsung.** Read [docs/releasing.md](docs/releasing.md).
- **Fonts and third-party marks.** Read [app/fonts/README.md](app/fonts/README.md) and [app/third-party/README.md](app/third-party/README.md).
- **Pull requests and AI disclosure.** Read [CONTRIBUTING.md](CONTRIBUTING.md) and [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).

## Workspace and upstream boundaries

Auger is a third-party Samsung TV client for Silo packaged as a Tizen web app (`.wgt`) targeting Tizen 8.0 or later (Chromium 108).

- `app/` holds `config.xml`, HTML entry, icons, fonts, and third-party marks.
- `src/api/`, `src/session/`, and `src/contracts/v2/` own `/api/v2` transport, sessions, active Profile Authority, and decoders.
- `src/ui/` owns screens and remote focus; `src/player/` owns AVPlay playback.
- `test/native/` holds `node:test` suites; `test/ui/` holds Playwright screen tests; `scripts/` holds build, packaging, and CI scripts; `docs/` holds specs.
- Keep all edits and issues inside `Artic0din/Auger-Tizen`; treat `silo-server`, `silo-apple` (tvOS layout and behavior reference), and `silo-android` (shared TV reference) as read-only upstream repositories.
- Port client behavior exclusively from `silo-apple` and `silo-android` (shared AGPL license) in idiomatic TypeScript for Tizen.

## Parity delivery gates

1. **Before editing UI or behavior:** read the affected Apple TV Swift source in `silo-apple` (recording its commit SHA separately from any installed build), compare all states (layout, typography, focus, motion, keys, loading, error, Retry, offline, empty, artwork fallback), and inspect existing Tizen owners (shell, artwork, cards, focus, scrolling, dialogs, paging, session) to fix shared causes at their owner.
2. **Before merging user-facing parity changes:** demonstrate same-state Apple TV and Samsung parity on the signed `.wgt` with verified installed asset hashes and recorded pixel dimensions per [docs/evidence/simulator-evidence.md](docs/evidence/simulator-evidence.md). Re-verify hashes and recapture after any parity-affecting change, and add a recording when focus, motion, or timing matters. Passing tests, source review, or CI do not substitute for native comparison. For a demonstrated platform limit, ship the closest substitute, document why, and attach the comparison; waivers apply only to the explicitly accepted gap.
3. **Runtime ownership:** run at most one Apple TV simulator and one Samsung TV simulator concurrently, with one input owner per simulator; test the authorized SDK debugging interface before reporting a blocker; defer physical-TV checks until simulator parity completes.

## Platform invariants

- **API v2 and session:** call `/api/v2` exclusively (`scripts/ci/check-no-api-v1.sh` enforces this in CI), keep operations and decoders in `src/api/` and `src/contracts/v2/`, route UI/player requests through `NativeSession` and active Profile Authority, and store credentials only in Tizen KeyManager or explicit session-only memory.
- **Playback:** use AVPlay (`<object type="application/avplayer">` in `src/player/playerScreen.ts`) for primary video playback under server-planned Direct Play, Remux, or HLS Transcode (no DTS Direct Play, no client ABR). Pass stream auth via query parameter, report start/10 s progress/stop through the adapter, and suspend/restore AVPlay on `visibilitychange`.
- **Package and artwork:** validate capabilities on the target hardware (Samsung S95C baseline) rather than model year; keep `$WEBAPIS/webapis/webapis.js` in `app/index.html`, limit `app/config.xml` privileges to `internet`, `tv.inputdevice`, and `productinfo` while retaining `object-src 'self'` in its CSP, and render artwork with plain `<img>` elements.
- **TV focus:** give each screen zone one focus owner, handle D-pad `keydown` moves in app code, restore focus by `{ zone, key }`, move focus programmatically only when the focused item disappears, and limit focus-move fetches to the six named exceptions in [docs/tv-focus.md](docs/tv-focus.md).
- **Code and tests:** write strict TypeScript (no `any`, explicit `.ts` imports, Skyline tokens in `src/theme.css`). Run scripts from `package.json` (`npm test` requires Node 26+ and Playwright Chromium) and CI script checks in `.github/workflows/ci-scripts.yml`; preserve focus, cancellation, authority, paging, and request-count assertions when editing tests, and diagnose failures rather than relaxing checks or assuming a later pass proves a flake.
- **Security and PRs:** run `gitleaks git --staged --redact` before every commit and scan the outgoing range before pushing; keep certificates, `.p12` files, security profiles, passwords, server URLs, tokens, DUIDs, and PR-only media out of Git. Open one non-draft Conventional Commit PR per concern following [CONTRIBUTING.md](CONTRIBUTING.md) and [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md), placing `Closes #N` in the PR body only.
