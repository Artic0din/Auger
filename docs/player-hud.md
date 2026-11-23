# Player options HUD

The player options panel exposes **Info**, **Stats**, **Video**, **Audio**, **Subtitles**, and **Chapters** in Apple TV order.

- **Info**, **Stats**, and **Video** stay available throughout active playback. **Audio** and **Chapters** hide when empty; **Subtitles** stays available whenever tracks or actionable AI tools exist.
- Chapter reads use the plan's effective media file (including after a version switch). Selecting a chapter seeks in source time and dismisses options without changing pause state. Failed chapter or title reads offer **Retry** in Info without stopping playback.
- Chapter rows show no thumbnails and never fetch artwork on focus; scrub previews remain owned by `SeekThumbnails`.

## Apple TV and Server references

- **Apple TV (`Silo-Server/silo-apple`, tvOS-only under `iosApp/iosApp/`):**
  - `TVPlayerInfoHUD.swift:38-72` (commit `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55`): tab order and availability; `:961` speeds `0.75..2.0`; `:2053-2162` numbered chapter rows, fallback title, time, current marker, seek, dismiss; `PlayerSettings.swift:19-36` Fit/Fill/Stretch.
  - `TVPlayerInfoHUD.swift:336-421,600-790,795-957`, `PlaybackStatsPanel.swift:33-38,75-160`, `PlaybackStats.swift:99-207`, `AetherPlaybackStatsProjection.swift` (commit `e0337595`, #523):
    - **Info:** `TITLE` (uppercase series, title, `S1 · E2`, film year + runtime joined by `  ·  `, overview) beside `NOW PLAYING` (Video, Audio, Subtitles, Playback, Chapter).
    - **Stats:** `Playback` (play method + container, Video, Dynamic range, Audio, Subtitles, Playback rate when not 1×, Diagnostics reason/warnings), divider, then `Stream` (Playback status) over `Engine` (Delivery, Source). Empty sections omit their heading.
    - **Video:** two equal columns 48 px apart: `PICTURE` (Quality, Aspect) and `PLAYBACK` (Speed, Auto-play next). Quality, Aspect, and Speed open pickers.
    - **Info** and **Stats** are each one focusable scroll pane (`HUDScrollablePane`, `:361-420`, `:772-787`: 2 px ring at 86% white, 10 px outside, 18 px corners, 1.01 scale; Up at top returns to the tab).
  - Two-column layout and glass styling (`7e478b26afd88bbe8e2fec00e945f9766a4e79a3`, `e958f58` #522, `SiloGlass.swift:35-57,190-199`):
    - **Subtitles** (`:1653-1659`): `TRACKS` (470 px) and options column (440 px), 58 px apart. Options groups: `OPTIONS` (AI Subtitles…, Search Subtitles…), `TIMING` (Delay, Sync to Audio, Reset Timing; [subtitle sync](playback/subtitle-sync.md)), `STYLE` (Appearance with summary second line, Only on this TV). `SECONDARY` follows tracks ([secondary subtitles](playback/secondary-subtitles.md)). Audio has a single `TRACKS` column.
    - **Subtitle ordering (`orderSubtitles`):** `effective_subtitle_language` from watch detail first (when present), other languages A-Z by name, format, full before forced before SDH, then incoming order.
    - **Rows and pickers (`:548-593,1042-1144,1665-1684,2191-2245`):** option values sit right-aligned at 72% white with a chevron when opening a picker (toggles omit chevrons; 14 + 18 + 14 px spacing, 49 px / 73 px row heights). Track selections show a 20 pt drawn SVG checkmark (22 pt in pickers) with no wash. Pickers are 620 px dialogs dimming the pane to 28% and leaving the focus graph; Back closes them with no Back row.
    - **Panel chrome (`:190`):** 380 px panel height with glass `rgba(32, 32, 32, 0.37)` + 30 px backdrop blur on `::before` and a 14% overlay stroke. Panes change only on the tab rail; Down enters at the top row; Left/Right cross columns only.
- **Server (`Silo-Server/silo-server`, commit `4e3020a266fca972d61fd82f7438eacb3430ddd4`):** `WatchFileVersion.chapters` and `WatchChapter` in `contracts/api/v2/openapi.json` provide source-time chapter boundaries.

## Platform limits and AVPlay substitutions

- **Playback speed:** [Samsung AVPlay `setSpeed`](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html) accepts integer rates only, so only **1×** and **2×** are offered, and only on `http_progressive` plans (omitted on HLS). Speed and aspect apply to the active attempt and reapply on transport reopen or restore.
- **Aspect mode:** **Fit** maps to `PLAYER_DISPLAY_MODE_LETTER_BOX` and **Stretch** to `PLAYER_DISPLAY_MODE_FULL_SCREEN`. **Fill** is omitted because `PLAYER_DISPLAY_MODE_AUTO_ASPECT_RATIO` does not establish Apple's crop-to-fill behavior. Missing platform methods hide their controls; platform exceptions retain the prior selection and show a message.
- **Auto-play next:** writes this TV's `profile_device` override (`PlayerSettings.swift:1107-1110`) and updates UI only after save succeeds. Up Next shares the same toggle, cancelling or restarting the end-of-episode countdown.
- **Planned stats only:** Info's Now Playing and Stats read `planStats` (`src/player/playerHUD.ts`) from `effective_recipe`, falling back to `source` and selected track. Engine-measured rows (buffer, network, read bitrates, dropped frames, A/V sync, decoders, Aether counters) stay omitted because AVPlay does not expose them ([#556](https://github.com/Artic0din/silo-tizen/issues/556)).
- **Visual differences:** AVPlay renders video below the web layer, so CSS backdrop blur cannot blur underlying video. Inter replaces SF Pro.

## Native capture checks

Follow [docs/evidence/simulator-evidence.md](evidence/simulator-evidence.md) for signed `.wgt` verification and Apple TV pairing, covering these playback-specific cases:

1. Info and Stats on identical title, file, position, and pause state (verify unknown-value omissions).
2. Chapters navigation, seek, HUD dismissal, preserved pause state, empty-chapter hiding, edition switch, and chapter-read failure with Retry.
3. HTTP 1×/2× speed, Fit/Stretch aspect, HLS hiding speed controls, error states, and reapply after reconnect and visibility restore.
4. Auto-play next toggle from both HUD and Up Next, verifying saved `profile_device` value, pre-end/EOF continuation, and failed-save rollback.
