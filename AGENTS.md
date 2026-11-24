# Repository guidelines

## Context pointers

Read the matching reference before editing a branch of the codebase.

- **Domain terms and entity rules.** Read [GLOSSARY.md](GLOSSARY.md), [docs/domain-model.md](docs/domain-model.md), and [docs/agents/domain.md](docs/agents/domain.md), plus `docs/adr/` when present.
- **Navigation, menus, grids, dialogs, or custom controls.** Read [docs/tv-focus.md](docs/tv-focus.md).
- **API v2 operations, auth, retries, or error decoding.** Read [docs/native-api-v2.md](docs/native-api-v2.md) and [src/contracts/v2/README.md](src/contracts/v2/README.md).
- **Porting a feature from Apple TV or Android TV.** Read [docs/upstream-design-notes.md](docs/upstream-design-notes.md).
- **Settings keys and AVPlay exclusions.** Read [docs/settings.md](docs/settings.md).
- **Simulator launch, signed `.wgt` capture, and Apple TV comparison.** Read [docs/evidence/simulator-evidence.md](docs/evidence/simulator-evidence.md).
- **Feature, playback, HUD, offline, and translation specs.** Use the index in [docs/README.md](docs/README.md).
- **Tests, fake clocks, and flake hunting.** Read [test/README.md](test/README.md).
- **Releases, sideloading, and Apps2Samsung.** Read [docs/releasing.md](docs/releasing.md).
- **Pull request evidence, `tvOS source`, and AI disclosure.** Read [CONTRIBUTING.md](CONTRIBUTING.md) and [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md).
- **GitHub issues, triage labels, and Wayfinder.** Read [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md) and [docs/agents/triage-labels.md](docs/agents/triage-labels.md).

## Workspace and module boundaries

This repository owns Auger, a third-party Samsung TV client for Silo, a plain Tizen web app (`.wgt`) targeting Tizen 8.0 or later (Chromium 108).

- `app/` holds the package manifest (`config.xml`), HTML entry, icons, fonts, and third-party marks.
- `src/api/`, `src/session/`, and `src/contracts/v2/` own `/api/v2` transport, sessions, active Profile Authority, and contract decoders.
- `src/ui/` owns screens and remote focus; `src/player/` owns AVPlay playback.
- `test/native/` holds `node:test` suites; `test/ui/` holds Playwright screen tests; `scripts/` holds build, packaging, and release scripts; `docs/` holds specs and validation notes.

Silo's own repositories are read-only upstream references.

- Treat `silo-server` as read-only upstream. Keep all code edits and GitHub issues inside `Artic0din/Auger-Tizen`.
- Use `silo-apple` (tvOS) as the TV behavior and layout reference, and compare `silo-android` for shared TV behavior.
- Port code only from `silo-apple` and `silo-android` (same AGPL license), keeping ports minimal and idiomatic for TypeScript on Tizen. Never copy from `jellyfin-web` or `jellyfin-tizen`.
- Check compatibility with upstream `silo-server` when touching auth, API models, playback, browsing, or metadata. Server issues belong in upstream `silo-server`; keep server concerns out of this repository.

## Parity delivery gates

### Before editing UI or behavior

1. Read the affected Apple TV Swift source in `silo-apple`, including for integration fixes. Record the source revision separately from any installed Apple build.
2. Compare the complete experience: layout, typography, color, spacing, copy, focus, motion, remote keys, and loading, failure, Retry, offline, empty, and artwork-fallback states.
3. Inspect existing Tizen owners (shell, artwork, cards, focus, scrolling, dialogs, paging, session) and fix shared causes at their owner instead of rebuilding them per screen.

### Before merging user-facing parity changes

1. Demonstrate parity with a same-state Apple TV and Samsung comparison on the signed `.wgt` before merging, using identical content, selection, focus, scroll, matching logical viewports with each capture's actual pixel dimensions recorded, and verified installed asset hashes (see [docs/evidence/simulator-evidence.md](docs/evidence/simulator-evidence.md)). Repeat installed asset hash verification against the updated signed `.wgt` and recapture affected comparisons after any subsequent parity-affecting change. Add a recording when focus, motion, or timing matters. Passing tests, source review, or CI do not substitute for native comparison.
2. Fix implementation differences. For a demonstrated platform constraint, ship the closest practical substitute, document why, and attach the comparison. Waivers apply only to the explicitly accepted gap.
3. Preserve focus, cancellation, authority, paging, and request-count regression assertions during test migrations. Diagnose failures rather than relaxing checks or assuming a later pass proves a flake.

### Runtime ownership and parallel work

- Run native comparisons on the Pro and use Xcode Device Hub for Apple TV. Run at most one Apple simulator and one Samsung simulator concurrently, with one input owner per simulator.
- Test the authorized SDK debugging interface before reporting a blocker. A locked desktop or missing generic device listing does not establish unavailability.
- Spread independent implementation, research, and review across isolated agents and machines; serialize only shared-file integration and simulator input. Verify transferred patch bytes and hashes before applying them.
- Keep physical-TV validation deferred until simulator parity completes.
- Under `full-send`, continue the agreed backlog after each pull request and record verified progress and remaining gaps in GitHub issues.

## Commands and proof bar

See `package.json` for standard scripts (`npm ci`, `npm run build`, `npm test`, `npm run typecheck`; requires Node.js 26+ and `npx playwright install chromium`). Only one screen-test suite runs per machine; a second `npm run test:ui` waits for the first.

- `python3 scripts/test-release-version.py` tests the release version script.
- `SILO_SERVER_REPO=/path/to/silo-server scripts/sync-apiv2-fixtures.sh <server-commit>` re-vendors API v2 fixtures. Regenerate with this script instead of hand-editing `src/contracts/v2/fixtures/`.
- `export TIZEN_SECURITY_PROFILE="YourProfileName" && ./scripts/build-wgt.sh` packages and signs `dist/Auger.wgt`.
- `tizen install -n dist/Auger.wgt -t <device>` and `tizen run -p AugerTv001.Auger -t <device>` install and launch on a Developer Mode TV.

The proof bar requires a built signed `.wgt` and passing simulator parity gates, with physical-TV validation as the final hardware gate. Desktop Chromium proves behavior, not Chromium 108 rendering or AVPlay. The Samsung simulator launches with `--disable-web-security`, so simulator requests do not prove browser CORS, LAN discovery, pinned local certificates, or physical-TV acceptance.

## Platform invariants

- **API v2 and session.** Call only `/api/v2` (`scripts/ci/check-no-api-v1.sh` enforces this in CI). Keep server operations and decoders in `src/api/` and `src/contracts/v2/`, and route UI and player calls through the session transport and active Profile Authority. Generate `DeviceId` once per install independent of Server URL or Account. Store credentials only in the protected vault or explicit session-only fallback. Sign-in uses device-code approval (with password fallback) followed by Household Profile selection and PIN verification when required. Check Server CORS and origin rules on the target runtime being claimed.
- **Playback.** Use AVPlay for primary video playback; the Server plans Direct Play, Remux, or HLS (MPEG-TS segments) Transcode from the TV's capabilities and quality limits, with no DTS Direct Play and no client ABR logic. Report start, progress every 10 s, and stop through the adapter. Pass stream auth as a query parameter because AVPlay cannot send HTTP headers. Suspend and restore AVPlay on `visibilitychange`, rebuilding the stream URL on restore. Resume from stored seconds and skip resume within 5 s of the end.
- **Package and artwork.** Target the Samsung S95C with supported installed firmware and validate its actual OS and AVPlay capabilities rather than assuming from model year. Keep `$WEBAPIS/webapis/webapis.js` in `app/index.html`, `<object type="application/avplayer">` in `src/player/playerScreen.ts`, and only the `internet`, `tv.inputdevice`, and `productinfo` privileges (plus `object-src 'self'`) in `app/config.xml` unless proven necessary (AVPlay needs no privilege). Render artwork with plain `<img>` elements pointing at Server image URLs.
- **TV focus.** Give each screen zone one focus owner, handle D-pad `keydown` moves in app code (Samsung remotes deliver plain `keydown` events and have no Tab key), restore focus by zone id and item id, move focus programmatically only when the focused item disappears, and avoid fetching on focus moves outside the six named exceptions in [docs/tv-focus.md](docs/tv-focus.md) (`filter`, `season-pill`, `episode-detail`, `outer-edge`, `featured-card`, `marquee-rest`).

## Code, writing, pull requests, and security

- **Code.** Write strict TypeScript with no `any`, explicit `.ts` import extensions, and Skyline design tokens in `src/theme.css`. Keep changes MVP, YAGNI, and KISS, with focused regression tests for changed behavior and rendered checks for visual changes.
- **Writing.** Run a readability pass on every human-facing issue, pull request, document, and status update. Lead with the outcome in concrete active English, cut filler and repetition, and keep exact quotations, commands, logs, identifiers, API names, and contractual language verbatim.
- **Pull requests.** Work on a feature branch and open one non-draft pull request per concern with a Conventional Commit title. Put `Fixes #N` or `Closes #N` in the pull request body only, never in commit messages. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) for `tvOS source`, Evidence (`Evidence: none, no user-visible change` only when nothing user-visible changes), and the required AI disclosure. Scrub private details including DUIDs from media and keep PR-only assets out of Git. When babysitting, check CI and comments posted after the last push, verify bot findings against source, fix real issues, dismiss false positives with a written reason, and stay quiet when nothing new appears. Before merging, run `python3 scripts/pr-gate.py <number>`; it prints `READY` or the first gate that fails (conflicts, a check's latest run, Codex on the head commit, or unresolved threads).
- **Security.** Run `gitleaks git --staged --redact` before every commit and scan the outgoing commit range before every push. Keep certificates, `.p12` files, security profiles, passwords, server URLs, tokens, and DUIDs out of Git. CI signs with repository secrets `TIZEN_AUTHOR_P12_B64`, `TIZEN_AUTHOR_PASSWORD`, `TIZEN_DISTRIBUTOR_P12_B64`, and `TIZEN_DISTRIBUTOR_PASSWORD`. `npm ci` installs a pre-commit hook from `.githooks/` that runs the staged scan and the type check, and the Secrets workflow scans every pull request's commits.
