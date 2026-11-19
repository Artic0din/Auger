# Subtitle sync

Part of [#522](https://github.com/Artic0din/silo-tizen/issues/522): Sync to Audio and Reset Timing on the player's Subtitles tab.
Apple behaviour is read from silo-apple `main` (`TVPlayerInfoHUD.swift` `SubtitlesPane`, `SubtitleSync.swift`, `APIv2SubtitleSyncModels.swift`).
No server changes are required.

The server aligns a subtitle to the file's audio and stores a timing correction (`offset_ms` and `scale`).
It never changes the subtitle's bytes: the subtitle's URL serves the corrected timing.

| Operation | Path | Behavior |
| --- | --- | --- |
| `getSubtitleSyncStatus` | `GET /subtitles/sync/status` | Sync is offered only when `state=available` and `allowed`. `external` says whether sidecar files can be synced too. |
| `listSubtitleSync` | `GET /subtitles/{media_file_id}/sync` | Every syncable subtitle of the file, by sync key. |
| `getSubtitleSync` | `GET /subtitles/{media_file_id}/sync/{key}` | One subtitle, to follow a running job. Its `ETag` guards a timing write. |
| `startSubtitleSync` | `POST /subtitles/{media_file_id}/sync/{key}` | Starts a sync, or returns the subtitle with its active job. Sent once; never replayed. |
| `setSubtitleTiming` | `PUT /subtitles/{media_file_id}/sync/{key}/timing` | Reset Timing sends the identity timing with `If-Match`. A change made since the read wins (412). |

All calls go through `src/api/subtitleOperations.ts`. A subtitle's sync key is the plan inventory's `sync_key` (`stored-{id}` or `external-{hash}`); a track with none has no sync row and no status.

## What the Subtitles tab shows

- Under TIMING, after Delay: Sync to Audio, the running job's progress bar and phase, Reset Timing, then one note. Rows stay enabled while a request runs; a press during a running job does nothing.
- The note is the last action's error, else the last result, else (when Sync to Audio applies and nothing runs) what it does.
- A 403 swaps Sync to Audio for a dimmed row that holds the server's message and cannot take focus. A 422 says the format can't be synced.
- Each track's row ends with its sync status after its attributes. An unsupported format shows that instead.
- Focus: if the focused Sync or Reset row disappears, focus moves to the other timing row, then Delay, then the tracks.
- When a timing change reaches a subtitle the app is drawing, as the primary or as the SECONDARY line, its cues are read again from the server, and the answer replaces the HTTP cache's copy (`cache: "reload"`), so choosing the track again later gets the new timing too.
- Each subtitle's timing has a version, raised on its first listing and on each change, and each cue read remembers the version it started under. The plan names no timing, so cues read before the first listing are read again once it arrives (one extra read at playback start for a shown track that has a sync key); after that, cues are read again only when the timing changes. A reread keeps the shown cues, and the SECONDARY choice, until the new cues have fully loaded; if it fails they stay, and the next timing change tries again.
- One poll runs at a time, and a list or poll answer, or a poll failure, sent before a newer answer for the same subtitle landed is dropped, so a late answer or a late 404 cannot end or revive a job.
- A track retimed while it is not shown needs no reread: the server sends retimeable subtitles with `Cache-Control: private, no-cache` and no validator (silo-server `internal/api/handlers/stream.go`), so its next ordinary read fetches the new timing.

Sync rows do not depend on the overlay: the server's timing applies to the file's subtitle whoever draws it.
A track AVPlay draws itself or that is burned in keeps its old timing on screen until the next plan.

## Not built

- Apple also follows jobs through realtime events and shows a sync card over the video. The TV polls every 3 s for up to 5 minutes (Apple's `pollInterval` and `pollLimit`) and has no card.
- A job that is still running after 5 minutes stops polling; pressing Sync to Audio again re-arms it, since the server returns the active job. Apple re-arms when the pane opens, which would be a data read on a tab change here.
- A server that predates sync keys (status without `external`) reads as sync unavailable. Apple falls back to the stored-subtitle routes.
- The sync listing is read when a plan first names a sync key, and again when a later plan names one it has not seen (a download, an AI result). It is not read each time the tab opens.
- Nothing here has run against the live server: tests use a fake server only.
