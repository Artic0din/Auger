# Audiobook playback

Audiobooks play natively on Samsung TV through AVPlay under protocol V3 while keeping video playback and video continuations isolated ([#55](https://github.com/Artic0din/Auger-Tizen/issues/55)).

## Engine and progress synchronization

- `AudiobookController` (`src/player/audiobookController.ts`) starts per-part server playback sessions (`POST /playback/start`) with audio-only capabilities (`AUDIOBOOK_CAPABILITIES`), `AUDIOBOOK_CLIENT_FEATURES` (`["playback_plan_v3"]`), `allow_alternate_versions: false`, and `progress_persistence: "client"`.
- Whole-book resume positions map onto the stitched part timeline (`bookPosition`), honoring the 30 s resume grace, 5 s end margin, and `played` flag (`playerStartPosition`).
- Dual-sink reporting sends file-local position samples to `/playback/{sessionId}/progress` and authoritative whole-book milliseconds (`force_overwrite: true`, `retry: "never"`, `replayAfterRefresh: false`) to `POST /sync/progress` every 10 s (while playing and paused), on pause, after completed seeks and chapter changes, on part transitions, on final completion, and on stop.
- Profile switches and sign-out abort active requests via `NativeSession.authoritySignal`, preventing late writes across profiles.
- `AudiobookHost` (`src/player/audiobookHost.ts`) lazily mounts an off-screen `<object type="application/avplayer">` container while audiobook playback is active (`loading`, `playing`, `paused`), keeps the player visible in a stopping state until shutdown completes, defers surface removal until any pending AVPlay seek/restore finishes so video playback keeps one clean AVPlay object, and suspends/restores AVPlay across `visibilitychange`.
- Video `PlaybackController` and `AudiobookController` share `transportLock` (`src/player/avplayTransport.ts`) so AVPlay seeks and closes never overlap.

## Full-screen player, chapters, speed, and sleep timer

- `AudiobookPlayerScreen` (`src/player/audiobookPlayerScreen.ts`) matches `TVPlayerLayout` (`silo-apple` `d74a30aa`): cover artwork on the leading side (`620×620` with hidden/fallback toggling), right-hand metadata column (`Audiobook` label, title, author, active chapter), whole-book scrubber with chapter tick marks (pinned left-to-right even in Arabic RTL), 5-button transport row, and options row (Speed, Sleep timer, Chapters, Stop Listening), plus a focusable `Cancel` control during loading and `SkylineScroll`-managed modal lists with Select-on-release remote handling.
- Skip Back and Skip Forward read the profile's audiobook skip intervals (`player.audiobook_skip_back_seconds` and `player.audiobook_skip_forward_seconds`, falling back to 10 s back / 30 s forward when unavailable).
- Chapter controls disable cleanly when a book has no embedded chapters.
- **Platform speed limit:** AVPlay documents `setSpeed` only for whole-integer rates on `http_progressive` streams on Samsung TVs, so in-player Speed offers `1×` and `2×` on progressive streams when `setSpeed` is present and `1×` on HLS streams or hosts without `setSpeed` (Apple TV's `0.75×–3×` range cannot be matched on AVPlay). Audible `2×` audio output on progressive streams remains open for live Samsung S95C verification under `#55`.
- **Sleep timer:** `AudiobookSleepTimer` (`src/player/audiobookSleepTimer.ts`) counts down 15, 30, or 60 minutes, updates the player countdown button each second, pauses playback and syncs progress on expiry, and cancels cleanly on stop or teardown.

## Background playback and handoffs

- Pressing `Back` while playing or paused minimizes the full-screen player (`AudiobookHost.minimize()`) and restores Browse while audio continues in the background; `Back` on `loading` or `error` states stops cleanly, and `Stop Listening` explicitly ends playback.
- While minimized, the Skyline bar displays a focusable `Now Playing` shortcut (`audiobook.miniPlayer.nowPlaying`) beside the profile avatar; activating either that shortcut or the active book's `Resume` button reopens the full-screen overlay without allocating a second playback session.
- Capture-phase remote key handling (`src/app.ts`) forwards hardware media keys (`play_pause`, `play`, `pause`, `stop`, `rewind`, `fast_forward`) while browsing with minimized audio.
- Active audiobooks (`playing` or `paused`) suppress Detail theme music (`Browse.setAudiobookActive(true)`). Minimized audio continues while Settings is open, and completing in the background leaves Settings intact without unhiding Browse. Switching to another book flushes final `syncProgress` and stops the old session before starting the new book (`restart: true` on the same book stops the old session without overwriting progress); starting video playback stops any active audiobook cleanly before video opens AVPlay; profile switches, sign-out, and app exit tear down active audio with zero late cross-profile progress writes.
