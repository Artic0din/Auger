# Secondary subtitles

Secondary subtitle rendering in the player's Subtitles tab ([#522](https://github.com/Artic0din/Auger-Tizen/issues/522)). Apple behavior follows `silo-apple` `main` (`TVPlayerInfoHUD.swift` `SubtitlesPane.trackRows`, `PlayerViewModel.selectSecondarySubtitle`, `AetherSubtitleOverlay.swift`). There is no Server endpoint for secondary subtitles; the player draws a second set of cues locally.

## What the Subtitles tab does

- Under the tracks, a SECONDARY heading, then Off and every other text track, as the tracks are listed. The primary's own row is dimmed and does nothing (`isDisabled: track.trackId == selectedSubtitleId`).
- Select reads the track's sidecar from the plan inventory (`url`, with the account's media token) and draws its cues as a second line in the primary's style.
- The second line sits 17% from the edge at the top and bottom, and 36% in the lower third (the primary sits 8% from top and bottom, and 27% in the lower third per `src/player/subtitleView.ts`); Apple's inset for the second line, from `defaultPlacement`.
- It ends when the primary is turned off, becomes the same track, or stops being drawn by the app.

## The limit

AVPlay selects one text track (`setSelectTrack("TEXT", index)`), so it cannot draw a second one. Secondary therefore works only where the app draws the primary subtitle itself, from the plan's text artifact (render or convert). A subtitle AVPlay draws from the stream, or one burned in, has no Secondary list.
Only sidecar rows with a text codec and a `.vtt`, `.srt`, `.ass` or `.ssa` URL qualify; the app draws ASS as plain text.
The second track's cues use the primary artifact's `timing_origin_seconds`, because both come from the same stream session. The contract gives a sidecar URL no origin of its own, so this is an assumption that has not been checked against a live server.
The second line uses the same clock as the primary, so the subtitle delay applies to both.
