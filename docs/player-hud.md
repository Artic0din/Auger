# Player options

Issue #225 adds Info, Stats, Video, Audio, Subtitles and Chapters in Apple TV order.
Info, Stats and Video remain available throughout active playback.
Audio and Chapters hide when their lists are empty; Subtitles remains available for tracks or actionable AI tools.
Chapter reads use the plan's effective media file, including after a version switch.
Selecting a chapter uses the existing source-time seek and dismisses options without changing pause state.
Failed chapter or title reads offer Retry in Info and never stop playback.

## Reference

Apple source: `Silo-Server/silo-apple` at `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55`.
`Screens/Player/tvOS/TVPlayerInfoHUD.swift` is entirely inside `#if os(tvOS)` (lines 1–2214).
Paths below are relative to `iosApp/iosApp`.

- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:38–72`: tab order and availability.
- Info, Stats and Video follow `main` `e0337595` (silo-apple #1178, 15 Nov), issue #523:
  - `Screens/Player/tvOS/TVPlayerInfoHUD.swift:600–739`: Info has TITLE (series in capitals, title, `S1 · E2`, year for a film then runtime joined by `  ·  `, overview) beside NOW PLAYING (Video, Audio, Subtitles, Playback, Chapter).
  - `Screens/Player/tvOS/TVPlayerInfoHUD.swift:745–790`, `Screens/Player/PlaybackStatsPanel.swift:33–38`, `:75–160`: Stats shows Playback, a divider, then Stream over Engine; a section with no rows has no heading.
  - `Screens/Player/PlaybackStats.swift:99–207`: one row per fact. Playback: how it plays and the file's container, Video, Dynamic range, Audio, Subtitles, Playback rate (only when not 1×), then Diagnostics (the server's reason and each warning, one label). Stream: Playback status. Engine: Delivery, Source.
  - `Screens/Player/AetherPlaybackStatsProjection.swift`: labels and formats ("Direct play", "Remuxed by the server", "Transcoded by the server"; "4K", "1080p"; "HEVC · 3840×1600 · 24 fps · 20.0 Mbps"; "Dolby Vision Profile 8 → SDR").
  - `Screens/Player/tvOS/TVPlayerInfoHUD.swift:795–957`: Video has PICTURE (Quality, Aspect) beside PLAYBACK (Speed, Auto-play next). Subtitle delay is in the Subtitles tab only.
  - `:336–421`: Info and Stats are each one focusable scroll pane; Up at its top returns to the tab.
- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:961`: speeds 0.75, 1.0, 1.25, 1.5 and 2.0.
- `Screens/Player/PlayerSettings.swift:19–36`: Fit, Fill and Stretch.
- `Screens/Player/tvOS/TVPlayerInfoHUD.swift:2053–2162`: numbered chapter rows, title fallback, time, current marker, seek and dismiss.
The tvOS chapter rows have no thumbnails.

Server source: `Silo-Server/silo-server` at `4e3020a266fca972d61fd82f7438eacb3430ddd4`.
`contracts/api/v2/openapi.json` defines `WatchFileVersion.chapters` and `WatchChapter` with source-time start/end seconds.
`docs/architecture/trickplay.md` defines separate per-file JPEG sprite-sheet previews.
Existing scrub previews remain owned by `SeekThumbnails`; chapter rows do not fetch artwork on focus.

## Platform limits

[Samsung AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html) documents `setSpeed(long playbackSpeed)`, with integer rates and protocol-dependent support.
The Apple intersection is 1× and 2×; fractional rates are omitted.
Speed is exposed for `http_progressive` plans with `setSpeed`, and omitted for HLS or unspecified protocols without a verified rate contract.
Video speed and aspect apply to this playback attempt and are reapplied when its transport reopens or restores.
Auto-play next uses the existing profile preference and changes only after a successful save.

Fit maps to `PLAYER_DISPLAY_MODE_LETTER_BOX`; Stretch maps to `PLAYER_DISPLAY_MODE_FULL_SCREEN`.
Fill is omitted: Samsung describes `PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO` as following video DAR/PAR, which does not establish Apple's crop-to-fill behaviour.
Missing platform methods hide their controls; platform exceptions retain the last confirmed selection and show a message.
Subtitle controls belong to issue #226.

Issue #391 matches Apple's two-column panes (`Silo-Server/silo-apple` at `7e478b26afd88bbe8e2fec00e945f9766a4e79a3`, `Screens/Player/tvOS/TVPlayerInfoHUD.swift`):

- `:1653–1659`: Subtitles has TRACKS (470 px) and an options column (440 px), 58 px apart. Tracks, AI results and the series choice sit in TRACKS. Silo-apple `main` `e958f58` (#1178, 15 Nov) groups the options column as OPTIONS (AI Subtitles…, Search Subtitles…), TIMING (Delay, Sync to Audio, Reset Timing) and STYLE (Appearance with its Large · Box · Bottom line under the label, then Only on this TV); a group with no row has no heading, and Size and Position are in Appearance. TIMING holds Sync to Audio and Reset Timing for the selected track ([subtitle sync](playback/subtitle-sync.md), #522). AI Subtitles… is one OPTIONS row that opens a language menu ([AI subtitles](playback/ai-subtitles.md), #522). The SECONDARY list follows the tracks ([Secondary subtitles](playback/secondary-subtitles.md)). Audio has one TRACKS column and no options column.
- Subtitles in TRACKS are ordered as `SubtitleDisplayOrder` does (`orderSubtitles`): the watch read's `effective_subtitle_language` first (Apple takes it only from the watch detail, so the catalog item's language is not used; with none, A to Z), the other languages A to Z by name, then format, full before forced before SDH, then incoming order. The server's inventory has no default flag, so that tie-break is not applied.
- Video has two equal columns 48 px apart, PICTURE (Quality, Aspect) and PLAYBACK (Speed, Auto-play next), as `main` `e0337595` (#523). Quality, Aspect and Speed each open their picker (Quality, Aspect, Playback Speed).
- `:548–593`: option rows show the value right-aligned at 72 % white, then a chevron when the row opens a picker. Toggles have no chevron. Appearance carries `textformat` ("Aa"), Search `magnifyingglass` and the AI rows `sparkles` (`:1964–2077`), drawn as inline SVG at 20 pt.
- `:2191–2245`: track rows mark the selection with a 20 pt checkmark and no wash.
- `:1042–1144`, `:1665–1684`: a picker is a 620 px dialog over its pane, which dims to 28 % and leaves the focus graph. Its title keeps its case at 30 px semibold, options are 24 px with the 14 % selected wash, and Back closes it; it has no Back row.
- `:9–16`, `:131–152`: panes change only on the tab rail. Down from a pill enters at the pane's top row (`:1664`), and Left/Right inside a pane only cross its columns.

- `SiloGlass.swift:35-57`, `:190-199`: the panel and pickers use `siloPlayerGlass`, Liquid Glass on current TVs. Apple's capture passes about 63 % of the video and lifts black to 13, which `rgba(32, 32, 32, 0.37)` with the app's 30 px backdrop blur reproduces; the 14 % stroke is an overlay ring. The glass sits on a `::before` layer so a picker's blur can still sample the pane under it.
- `:2239–2241`, `:1138–1139`: the selected checkmark is a drawn 20 pt (picker: 22 pt) semibold symbol, 17 × 17 px of ink in a 24 px frame, not a font glyph.
- `:559–590`: setting rows keep 14 + 18 + 14 px between label and value (`Spacer(minLength: 18)`), a 28 px `textformat` frame and an 11 px chevron frame, so a long value truncates as on Apple TV (Appearance now shows its summary as a second line instead of a value). Row text uses SF's 27 px and 21 px line heights, giving Apple's 49 px and 73 px rows.
- `:190`: the 380 px panel holds only the pane, so columns run to its padded bottom and clip the next row. The status line, which Apple does not have, sits just below the panel.

Still different from Apple, outside this issue: Speed offers 1× and 2× and Aspect Fit and Stretch, because AVPlay supports only those (see Platform limits). Liquid Glass also blurs the video under the panel; AVPlay draws video on a plane below the web page, so the CSS blur cannot reach it, and the video shows through the tint unblurred. Inter replaces SF Pro, so text widths differ by a few pixels.

Stats and Info's Now playing rows come from the playback plan (`src/player/playerHUD.ts`, `planStats`).
The picture and the Stats Audio format are the plan's `effective_recipe` (what reaches the TV, where Apple reads its engine's decoded stream), falling back to `source` and the selected track; Info's Audio row names the track as the Audio tab does. The Video row's bitrate is the recipe's, never a measured throughput.
Dynamic range is the source's, or "source → output" when the recipe changes it, as Apple's planned-range label.
Apple's engine-measured rows (buffer, network, read bitrates, dropped frames, A/V sync, decoders, Aether counters) are left out because AVPlay does not report them; no estimate is substituted (#556).
The Info and Stats panes have no focus ring yet, and Stats scrolls by page rather than by section (#556).

## Native capture checklist

Same-state comparison is pending; the PR must remain unmerged until it passes.
No simulator, TV, signed package or installed-build acceptance is claimed by desktop tests.

1. Build and identify the signed WGT for the PR head, install through the established device workflow, and verify the installed assets match it.
   Record the Apple installed build separately from the Apple source revision.
2. **Playback required:** open the same title, file, position and pause state on both clients.
   Capture Info and Stats at native dimensions, with identical focus and scroll, and compare metadata and the presence of unknown-value omissions.
3. **Playback required:** choose content with chapters, record remote navigation into Chapters, move to a later chapter, select it, and verify the resulting source position, HUD dismissal and preserved pause state.
   Repeat with no chapters and after changing edition, then capture chapter-read failure and Retry using a controlled test service.
4. **Playback required:** record HTTP 1×/2×, Fit/Stretch, remote focus across updates, unsupported-method/error states, and settings restoration after reconnect and visibility restore.
   Check HLS hides unverified speed controls and compare the documented Fill omission explicitly.
5. **Episode playback required:** toggle Auto-play next both ways, verify the saved profile value, and check pre-end/EOF continuation with each value.
   Capture save failure without changing the displayed value, plus the pending-write focus state.

Before publishing captures, remove private media details, addresses, credentials and device identifiers.
