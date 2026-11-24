# Auger docs

Index of documentation for Auger on Samsung TV (Tizen 8.0 or later). Start with [README.md](../README.md) for install and build setup, [FEATURES.md](../FEATURES.md) for the Apple TV and Android TV parity inventory, and [AGENTS.md](../AGENTS.md) for platform invariants.

## Current product scope

- Talks only to Silo's native `/api/v2` and plays video through AVPlay, with the Server planning Direct Play, Remux, or HLS Transcode.
- Top bar follows the Server's saved TV menu, falling back to Home, Movies, Series, For You, and Calendar with Search to the left. Movies and Series appear only when a matching or mixed Library exists.
- Music browsing is not built. Audiobooks is opt-in (Settings, General, Show Audiobooks) with browsing and detail only, no playback.
- Requests appears only when enabled by the Server for the active Profile.
- Diagnostics reports are blocked until Silo Server accepts a Tizen diagnostics platform ([#138](https://github.com/Artic0din/Auger/issues/138)).
- Ships through Apps2Samsung and GitHub Releases ([Releasing](releasing.md)).

## Core references

Read the matching reference before changing its area.

- **Domain terms and rules.** [GLOSSARY.md](../GLOSSARY.md) defines canonical vocabulary; [domain-model.md](domain-model.md) documents entity relationships, Authority lifecycle, Library visibility, and playback rules.
- **Runtime behavior and proof limits.** [app-behaviour.md](app-behaviour.md) summarizes shipped behavior and what has been proven on a TV.
- **API v2 operations and auth.** [native-api-v2.md](native-api-v2.md) documents every `/api/v2` operation, auth header, retry policy, and error kind.
- **TV remote focus.** [tv-focus.md](tv-focus.md) documents focus hosts, zone rules, restoration, and dwell exceptions. Read before changing navigation, menus, grids, dialogs, or custom controls.
- **Settings and AVPlay exclusions.** [settings.md](settings.md) lists supported Settings keys, scopes, and streaming rows AVPlay cannot honor.
- **Offline browse cache.** [offline-browse.md](offline-browse.md) documents Home, For You, and Details snapshot caching and recovery.
- **Translations and RTL.** [translation.md](translation.md) documents string catalog usage, mirrored views, and remaining English copy.
- **Player options HUD.** [player-hud.md](player-hud.md) documents the Info, Stats, Video, Audio, Subtitles, and Chapters tabs.
- **Releases and sideloading.** [releasing.md](releasing.md) documents automatic releases, Apps2Samsung, and sideloading.
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
- [Person hero](features/person-hero.md) and [filmography](features/person-filmography.md) for person pages and paged credits.
- [Profile launch](features/profile-launch.md) for launch selection preferences.
- [Change account](features/change-account.md) for multi-server and multi-account switching.
- [Requests](features/requests.md) for the Requests hub, My Requests, and follow actions.
- [Watch Party](features/watch-party.md) for room creation, lobby, and ballot voting.

## Evidence

- [Samsung simulator evidence](evidence/simulator-evidence.md) for simulator launch, signed `.wgt` asset verification, and Apple TV comparison steps.
- `evidence/screenshots/` for captures referenced by pull requests, feature docs, and `README.md`.
