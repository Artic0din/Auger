# Auger docs

Index of documentation for Auger on Samsung TV (Tizen 8.0 or later).
Start with [README.md](../README.md) for install and build setup, [FEATURES.md](../FEATURES.md) for the Apple TV and Android TV parity inventory, and [AGENTS.md](../AGENTS.md) for platform invariants.

## Current product scope

- Talks only to Silo's native `/api/v2` and plays video through AVPlay, with the Server planning Direct Play, Remux, or HLS Transcode.
- Top bar uses Apple's fixed `visibleRoots` order (`Home`, `Movies`, `Series`, `Music`, opt-in `Audiobooks`, `For You`, `Calendar`) with Search to the left and Profile to the right. Library tabs appear only when a matching visible Library exists.
- Music shows an explicit unavailable screen (no music catalog queries). Audiobooks is opt-in (Settings > General > Show Audiobooks) with browsing and detail only, no playback.
- Requests appears in the profile menu only when enabled by the Server for the active Profile.
- Diagnostics reports are blocked until Silo Server accepts a Tizen diagnostics platform ([#138](https://github.com/Artic0din/Auger-Tizen/issues/138)).
- Ships through Apps2Samsung and GitHub Releases ([Releasing](releasing.md)).

## Core references

Read the matching reference before changing its area.

- **Domain terms and rules.** [GLOSSARY.md](../GLOSSARY.md) defines canonical vocabulary; [domain-model.md](domain-model.md) documents entity relationships, Authority lifecycle, Library visibility, and playback rules.
- **Runtime behavior and proof limits.** [app-behaviour.md](app-behaviour.md) summarizes shipped behavior and what has been proven on a TV.
- **API v2 operations and auth.** [native-api-v2.md](native-api-v2.md) documents every `/api/v2` operation, auth header, retry policy, and error kind; [src/contracts/v2/README.md](../src/contracts/v2/README.md) documents vendored fixtures and contract pinning.
- **TV remote focus.** [tv-focus.md](tv-focus.md) documents focus hosts, zone rules, restoration, and dwell exceptions. Read before changing navigation, menus, grids, dialogs, or custom controls.
- **Settings and AVPlay exclusions.** [settings.md](settings.md) lists supported Settings keys, scopes, and streaming rows AVPlay cannot honor.
- **Offline browse cache.** [offline-browse.md](offline-browse.md) documents Home, For You, and Details snapshot caching and recovery.
- **Translations and RTL.** [translation.md](translation.md) documents string catalog usage, mirrored views, and remaining English copy; [src/i18n/catalog/README.md](../src/i18n/catalog/README.md) documents catalog vendoring and trimming.
- **Player options HUD.** [player-hud.md](player-hud.md) documents the Info, Stats, Video, Audio, Subtitles, and Chapters tabs.
- **Tests and flake hunting.** [test/README.md](../test/README.md) documents native and UI suites, fake clocks, and concurrency locks.
- **Releases and sideloading.** [releasing.md](releasing.md) documents automatic releases, Apps2Samsung, and sideloading.
- **Fonts and third-party marks.** [app/fonts/README.md](../app/fonts/README.md) and [app/third-party/README.md](../app/third-party/README.md) document bundled fonts and trademark assets.
- **Upstream TV specs.** [upstream-design-notes.md](upstream-design-notes.md) links the `silo-apple` and `silo-android` design specs relevant to TV clients.
- **Upstream parity drift snapshot.** `parity/upstream-snapshot.json` records the upstream state `FEATURES.md` was last reviewed against (`scripts/parity-drift.py`).

## Playback

- [Playback quality, completion, and recovery](playback/playback-quality.md) for quality selection, manual episode EOF, and reconnect recovery.
- [Series autoplay](playback/series-autoplay.md) for Up Next timing, countdowns, and On Deck behavior.
- [Seek thumbnails](playback/seek-thumbnails.md) for trickplay sprite-sheet scrubbing.
- [Subtitle appearance](playback/subtitle-appearance.md) for overlay styling and scope persistence.
- [Subtitle sync](playback/subtitle-sync.md) for sync-to-audio jobs and timing reset.
- [Secondary subtitles](playback/secondary-subtitles.md) for dual-track overlay rendering.
- [AI subtitles](playback/ai-subtitles.md) for translation and transcription jobs.

## Features

- [Skyline browse shell](features/skyline-browse-shell.md) for navigation bar, Home, sections, text search, and preplay.
- [Library discovery](features/library-discovery.md) for Recommended, Browse, Collections, filters, and A-Z rail.
- [Details actions](features/details-actions.md) for hero actions, pickers, trailers, and entry loading.
- [Title art](features/title-art.md) for logo display and profile/device scope persistence.
- [Personal lists](features/personal-lists.md) for Watchlist, Favorites, and History.
- [Person hero and filmography](features/person-filmography.md) for person pages, portrait/dates, and paged credits.
- [Profile launch](features/profile-launch.md) for launch selection preferences.
- [Change account](features/change-account.md) for multi-server and multi-account switching.
- [Requests](features/requests.md) for the Requests hub, My Requests, and follow actions.
- [Calendar](features/calendar.md) for the weekly agenda, week strip, and focus rules.
- [Watch Party](features/watch-party.md) for room creation, lobby, and ballot voting.

## Simulator validation

- [Samsung simulator guide](evidence/simulator-evidence.md) for simulator launch, signed `.wgt` asset verification, and Apple TV comparison steps.
