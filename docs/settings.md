# Settings rows

## Rail and row styling

The styling reference is tvOS-only silo-apple [`fc86b2019762ac10224140e1ad721a0c04532072`](https://github.com/Silo-Server/silo-apple/tree/fc86b2019762ac10224140e1ad721a0c04532072).
The two Settings source files below are unchanged from `8655b06b077ab09a4604073ab3f9718fbfe66c6d`, the Apple simulator revision identified in issue #484.

- [TVSettingsView.swift:242-258](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsView.swift#L242-L258) uses 22 pt medium category symbols in 34 pt slots, and regular 16 pt subtitles at 0.62 opacity.
  The [same-state Apple capture supplied for the follow-up](https://raw.githubusercontent.com/Artic0din/Auger-Tizen/evidence/484-settings-styling/cmp484-rail.png) measures approximately 24 × 24 px of General gear ink, 26 × 20 px for Playback, 24 × 22 px for Subtitles and 24 × 20 px for Server at 1920 × 1080.
  The original SVG substitutes keep the 34 px slots and use per-symbol proportions with approximately 1.7–2 px medium strokes.
  These are capture measurements, not values specified by the Swift font size.
  [The category symbols at lines 675-681](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsView.swift#L675-L681) include `gearshape` for General.
- [TVSettingsView.swift:233-235](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsView.swift#L233-L235) uses `chevron.forward` at 17 pt semibold and 0.5 opacity for the profile.
  [TVSettingsComponents.swift:313-325](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsComponents.swift#L313-L325) uses the same symbol at 18 pt semibold and 0.55 opacity for picker rows.
  Settings draws these as rounded SVG strokes instead of font-dependent text chevrons.
- [TVSettingsView.swift:182-208](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsView.swift#L182-L208) puts Sign Out after the categories and a spacer with a 24 pt minimum, with 6 pt stack gaps and 10 pt top padding on the following version line.
  **Source/capture distinction:** Swift allows the spacer to expand; the [second same-state capture](https://raw.githubusercontent.com/Artic0din/Auger-Tizen/evidence/484-settings-styling/cmp484b-rail.png) shows about 135 px between the Server and Sign Out baselines, compared with about 120 px on Samsung at `68efd0ee`.
  The old minimum-only translation (6 + 24 + 6 = 36 px between row bounds) underfilled this gap.
  Tizen now uses the capture's 50 px between row bounds, equivalent to a 38 px expanded spacer and both 6 px stack gaps.
  [TVSettingsComponents.swift:198-202](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsComponents.swift#L198-L202) adds 15 pt of vertical and 20 pt of horizontal padding inside each rail row, including Sign Out, and fills the rail width.
  The vertical padding puts Sign Out's label box 65 px below Server's row bounds; the rendered baseline gap is approximately 134 px with the bundled font.
  The 50 px gap is capture-derived, not an explicit Swift constant; it is measured relative to Server, so Apple's additional Diagnostics row does not enter the calculation.
  The label's 33 px line box plus its two 15 px padding edges makes the Sign Out row 63 px high; the version follows after its existing 6 + 10 = 16 px gap.
  There is no bottom pinning or fixed screen coordinate.
  [TVSettingsView.swift:275-281](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsView.swift#L275-L281) gives Sign Out the same 34 pt icon slot and 16 pt content spacing as the categories.
  Removing Tizen's separate left margin aligns both the icon slot and text column with the categories.
- [TVSettingsView.swift:211-219](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsView.swift#L211-L219) directly uses `ProfileAvatarView` at 68 pt for the Settings header.
  [ProfileAvatarView.swift:12-20](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/Components/ProfileAvatarView.swift#L12-L20) draws a filled circle behind the fallback initial, [sized at 0.34 of the diameter in semibold at lines 45-52](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/Components/ProfileAvatarView.swift#L45-L52).
  Its default fill and text colours are `#0E0F12` and `#EDEDED` ([Colors.swift:12-22](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/Theme/Colors.swift#L12-L22)).
  Tizen applies those colours only to the Settings header avatar, including on focus; other avatars retain their existing styling.
- [TVSettingsView.swift:275-280](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsView.swift#L275-L280) explicitly uses 27 pt medium for Sign Out, while category titles use 25 pt medium.
  Tizen applies its existing 0.9685 SF-to-Inter cap-height adjustment to the 27 pt size (26.1495 CSS px) and uses weight 500, reducing the previous label's visible size and weight without inventing a smaller Apple source value.
  The resting destructive colour is `.siloError` in [TVSettingsComponents.swift:217-220](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsComponents.swift#L217-L220), defined as `#B00020` in [Theme/Colors.swift:52-53](https://github.com/Silo-Server/silo-apple/blob/fc86b2019762ac10224140e1ad721a0c04532072/iosApp/iosApp/Theme/Colors.swift#L52-L53).

Rendered regressions check painted icon bounds, medium stroke sizes, Sign Out columns and baseline gap at two viewport heights, font metrics and color, and the profile circle pixels at rest and on focus alongside subtitle, chevron, and focus/pressed checks. See [docs/evidence/simulator-evidence.md](evidence/simulator-evidence.md) for native comparison gates.

## Row behavior

Apple source is [silo-apple `2ef3a171`](https://github.com/Silo-Server/silo-apple/tree/2ef3a171dfa597a450886b2de3745acfd5132b3d), tvOS only. `SettingsView` on tvOS is `TVSettingsView`. The installed Apple build was not read.

Playback already sends `playback.preferred_quality` and `playback.max_bitrate_kbps` on each start. The Quality section shows those two rows, then Apple's footer for the effective pair:

- Auto, or a stored `original`: `Plays the original file whenever your device and connection can handle it.`
- Any other resolution, using Apple's label (`4K` for 2160p): `Plays the original file up to {label}. Larger files are converted.`
- A positive bitrate cap adds `Files above this bitrate are converted to fit.`

Maximum Bitrate uses Apple's spelling: `No limit`, whole Mbps above 1000 kbps (`6 Mbps`), one decimal when the cap is not whole Mbps (`1.5 Mbps`, `2.0 Mbps` for 1999 kbps), and `{n} kbps` below 1000. A stored cap that is not in the preset list stays in descending order and selected, as `SiloQualityPresets.bitrateChoices(including:)` does. The picker has no separate kbps field or Save action.

## Disabled rows

A disabled Settings row is drawn exactly like an enabled one, as on Apple TV.
Every Settings row uses `TVSettingsPaneRowStyle` ([`TVSettingsComponents.swift`](https://github.com/Silo-Server/silo-apple/blob/e0337595b82fe4a8778b3c9abfb69bc31e8744f7/iosApp/iosApp/tvOS/Screens/Settings/TVSettingsComponents.swift), tvOS), which sets an explicit foreground and fill, so `.disabled(true)` adds no dimming.
This covers every row that can be disabled here: the Loop and Play Theme Music, Show Title Art, Apply to All Devices, Poster Size, Profile Selection, Connection speed, HDR, spoiler and skip-interval rows, and every row while a save is in flight.
Up and Down pass over a disabled row, as tvOS focus passes a disabled `Button`: Apple's own comments say "Skipped by focus while HDR is off" and "unfocusable when this server cannot store them" (`TVPlaybackSettingsView.swift`, silo-apple `dce56e3c`).
The zone's `skipDisabled` flag does this once for every row (`docs/tv-focus.md`); when nothing enabled is left in that direction, focus stays where it is.
A row that is focused when it becomes disabled keeps focus, and a key press then moves off it.
Each pane is a focus section on Apple TV (`.focusSection()` in `TVSettingsView.swift`, silo-apple `dce56e3c`): vertical movement stays in the pane and Left/Right bridges panes.
The rows zone names itself as its own `up` and `down` target, so Up at the first row and Down at the last stay put in every pane and only Left leaves for the rail.
The rail is a `.focusSection()` too, so its zone names itself as `up` and `down` as well: Down from Sign Out stays on it instead of entering the pane (`TVSettingsView.swift`, silo-apple `dce56e3c`).
While a save is in flight every row ignores presses but stays reachable, because Apple's view models ignore presses while saving and its rows stay in the focus graph.
Apple's one dimmed Settings group is `TVSettingsNestedGroup` (0.42 opacity while Use Device Settings is on), which this client has no counterpart for: Samsung has no system caption appearance to follow.

## Connection speed

Playback shows Connection speed when `GET /api/v2/playback/capabilities` includes `connection_speed_v1` (`TVPlaybackSettingsView.swift:18-20,127-169` and `SettingsViewModel.swift:496-531,572-575` at silo-apple `2ef3a171`). The stored reading is `GET /api/v2/playback/connection` (`APIv2Client+Playback.swift:91-98`). **Test speed** downloads the advertised `bandwidth_probe_url` with `size=1000000000` for up to 10 seconds (`BandwidthProbe.swift:19-24,35-44`) and, when that measures a rate, reports `POST /api/v2/playback/bandwidth-probe/results` with `manual: true` (`APIv2Client+Playback.swift:100-115`). The row stays hidden when that feature is missing or the capabilities read fails. A failed connection read still shows the row as `Not measured yet` (`SettingsViewModel.swift:521-526`).

Opening Settings reads the stored connection. Focusing Playback, or opening that pane, does not start a test. The download starts only from Test speed (`TVPlaybackSettingsView.swift:135-136`, `SettingsViewModel.swift:639-661`).

The row copy matches `SettingsViewModel.swift:576-745`: `Not measured yet`, `Testing…`, `48 Mbps · measured 3 minutes ago on Wi-Fi`, `Faster than 115 Mbps · …` for a lower bound, `Faster than 51 Mbps · seen during playback 2 hours ago` for a playback sample, `Auto plays videos up to {rate} without converting them.`, `Couldn't measure the connection speed. Try again.`, `Couldn't save the speed test result. Try again.`, and `Try again in N seconds` (one second at 1). A metered network hides the action and the budget. tvOS `PlayerSettings.offersCellularQuality` is false (`PlayerSettings.swift:325-330`), so a metered network that is not cellular says `Speed tests are skipped on metered networks.`

Leaving Playback cancels an in-flight test. That cancellation is not a failure, and it does not report a result.

Playback start sends `bandwidth_estimate_kbps` as Apple does (`PlayerViewModel.swift:6207-6218`, `BandwidthProbeScheduler.swift:418-428`): the highest stored reading, the probe or the playback sample, younger than the server's `bandwidth_probe_max_age_seconds` (7 days when it sends none), for this server and transport, never on a metered network, and only when the server has `connection_speed_v1` and a probe URL. The value is the stored integer kbps, unrounded. Readings come from the connection document Settings loads and from a saved Test speed result, kept in memory. Start never probes and never reads the connection document, so it costs no request. The transport is the connection type the browser reports, which is often unknown on a TV, so a reading can outlive a network change until the app closes; Apple drops its readings on any network change. Readings belong to one account on one server and are cleared when that account signs in, signs out, expires or selects a profile; another live account's changes leave them alone (`BandwidthProbeScheduler.swift:510-525`). A start with no reading, such as the first one after the app opens before Settings, omits the member. Apple also keeps readings from automatic background tests, which this client does not run. With `buffering_quality_v1` advertised in the capability response, the start adds it to `client_features` and names the estimate `bandwidth_estimate_source: "probe"`, as Apple does (`PlaybackSessionBridge.swift:1179-1220`); without it neither goes out. The auto budget is the server's figure and is display-only.

These parts of Apple's behaviour have no Samsung owner, so they are not copied:

- The automatic quick probe is not run. Apple may measure in the background (`BandwidthProbe.swift:13-16`). This TV measures only when Test speed is pressed.
- A redirect fails the test. Apple follows it after stripping `Authorization`, `X-Profile-Id` and `X-Profile-Token` (`BandwidthProbe.swift:243,403-411`). A browser cannot follow a redirect and drop those headers.
- A probe URL on another origin is refused, so the account token is not sent there. Apple resolves `bandwidth_probe_url` against the server and downloads that URL (`BandwidthProbeScheduler.swift:161-166`).
- The reading kept for this Settings visit follows the server's `connection` string. Apple also keeps an in-memory reading per network path (`SettingsViewModel.swift:595-599`). This TV does not subscribe to network changes while Settings stays open; the next visit reads again.
- Metered is `navigator.connection.type === "cellular"` or `saveData === true` when the browser exposes them. Otherwise the row offers Test speed. Transport is `wifi`, `ethernet` or `cellular` only when the browser reports that type; otherwise it is `other`, shown as `this connection`.
- `Stop playback before testing, then try again.` (`SettingsViewModel.swift:577,654-655`) is not shown. Settings replaces the browse screen, so it is not open during playback.
- Apple hides the auto-budget sentence when buffering quality is Never and a learned limit exists (`SettingsViewModel.swift:626-632`), because the server's budget counts the limit and Never ignores it. This TV does the same.

## HDR

`TVPlaybackSettingsView.swift:173-259` is Apple's STREAMING section: Audio Language, HDR (`185-191`), Dolby Vision (`193-202`), then Seek Cache, Buffer Ahead, Lossless Multichannel Audio, TrueHD Atmos and DTS:X, Deinterlacing and Deinterlacing Field Rate. The section ends with `TVSettingsFooter(streamingFooterText)` (`248-258`).

This pane shows Audio Language and HDR. Dolby Vision is absent. Samsung exposes no Dolby Vision support check, and this client claims no Dolby Vision profile, so a switch would not change playback. The client does not read or write `player.dolby_vision_enabled`. That absence is not a measurement that the panel lacks Dolby Vision.

The HDR key is `player.hdr_enabled` (`SettingKeys.generated.swift:97`). It is a remote boolean, default true, allowed only at `profile_device` (`PlayerSettings.swift:740-741`, `setHDREnabled` at `1092-1099`). The vendored settings subset does not list it. A live contract that matches that device-only definition shows the row. Any other shape hides it. The platform list may omit `tizen`; this key is not a profile-scope adoption.

The caption is after the Streaming section, matching `TVPlaybackSettingsView.swift:248`. It keeps the first sentence of `SettingsViewModel.hdrFooterText` (`SettingsViewModel.swift:136-143`), without the words "without Dolby Vision", and without the Lossless Multichannel Audio and TrueHD Atmos sentences (`TVPlaybackSettingsView.swift:251-257`) because those rows are not on this pane. The caption is: "With HDR off, videos the server converts for this device are sent in SDR."

The tvOS second sentence is not used. Apple's snapshot gates output HDR on `player.hdr_enabled` (`ApplePlaybackV3Capabilities.swift:439-446`) and copies that same `hdrDetails` onto `original_http`, `progressive`, and `hls` (`240-283`). Original files still play in HDR on Apple TV because `original_http` carries `client_managed_dynamic_range_v1` when Aether is declared (`226-229`). That claim is scoped to `original_http`: the Aether executor accepts the source dynamic range and resolves presentation after delivery, and it is not a promise about packaged streams (`PlaybackProtocolV3Models.swift:38-42`). The claim makes the server ignore output HDR evidence (`309-315`). On Apple TV, Match Content reads the system flag, not this setting, and switches the TV (`SettingsViewModel.swift:128-134`).

This client cannot do that. Protocol v3 folds `server_remux_hls` and `server_transcode_hls` onto one `hls` delivery (`PlaybackProtocolV3Models.swift:96-100`), so one `hdr_details` covers a copy remux and a conversion. The server gives output HDR precedence over a delivery claim (`ApplePlaybackV3Capabilities.swift:435-438`). AVPlay plays the URL the server sends and does not manage dynamic range, so this client does not send `client_managed_dynamic_range_v1`. With HDR off, `output`, `original_http`, and `hls` all omit `hdr_details`. An HDR original is not claimed as playable in HDR.

The panel probe is Samsung's `webapis.avinfo.isHdrTvSupport()` ([AvInfo API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avinfo-api.html), since Tizen 2.3). The method returns one boolean and lists no privilege, so `config.xml` gains none. A missing object, a non-boolean, or a throw is SDR. Samsung's FAQ says not every TV supports HDR and points at this method ([Specifications and Feature Support](https://developer.samsung.com/smarttv/develop/faq/specifications-and-feature-support.html)). The boolean does not name HDR10, HDR10+ or HLG.

No other documented call names those formats. `webapis.productinfo` exposes `getModel`, `getModelCode`, `getRealModel`, `isUdPanelSupported`, `is8KPanelSupported`, `isOledPanelSupported` and `isUHDAModel` (Ultra HD Premium), and none of them report a dynamic-range format ([ProductInfo API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/productinfo-api.html)). The productinfo privilege already present is only for the model name. AVPlay `getStreamingProperty` reads `IS_LIVE`, `AVAILABLE_BITRATE`, `GET_LIVE_DURATION` and `CURRENT_BANDWIDTH`. `getTotalTrackInfo` describes a playing stream's fourCC, width, height and bit rate, not the panel ([AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html)). `webapis.systeminfo.isSupportedVideoCodec` lists codecs such as H264 and HEVC, not HDR formats ([SystemInfo API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/systeminfo-api.html)). Tizen `systeminfo.getCapability` screen keys do not include HDR ([device capabilities](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/systeminfo-api/getting-device-capabilities-using-systeminfo-api.html)).

The year specifications do not put HDR10+ or HLG on every model this app can run. General Specifications map Tizen 8.0 to 2024, 9.0 to 2025 and 10.0 to 2026, and say a 2023 set can install a later OS, so the OS version is not the panel ([General Specifications](https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html)). The [2024](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2024-tv-video-specifications.html), [2025](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2025-tv-video-specifications.html) and [2026](https://developer.samsung.com/smarttv/develop/specifications/media-specifications/2026-tv-video-specifications.html) video pages list codecs per model group, including FHD groups, and do not name HDR10, HDR10+ or HLG. The adaptive-streaming guide's "Supported: HLG, HDR10, HDR10+" line is a recommended 8K content table, and 8K is not every model ([adaptive streaming](https://developer.samsung.com/smarttv/develop/guides/multimedia/adaptive-streaming.html)).

A true `isHdrTvSupport()` result, with the HDR setting on, claims HDR10 only. HDR10+ and HLG stay unclaimed, so the server converts or sends the HDR10 base layer. Dolby Vision stays unclaimed: Samsung documents no probe, and `dolby_vision_profiles` stays empty. Measured on an S95C on 8 Nov 2026, `webapis.avinfo.isHdrTvSupport()` returned true, the server sent the original HEVC HDR10 file, and AVPlay played it.

The capability body follows `ApplePlaybackV3Capabilities.swift:439-483` and `PlaybackProtocolV3Models.swift:160-165`:

- HDR10 is claimed when the HDR setting is on and `isHdrTvSupport()` returned true, as Apple fills HDR10 from the setting and a panel report (`440-441`).
- HLG stays unclaimed. The probe does not report it. A panel value would still map, and this probe never sets one.
- `hdr10_plus` stays false. Apple hardcodes `hdr10Plus` false because it has no HDR10+ attestation (`479-480`). Nothing on this client reports HDR10+ either.
- `dolby_vision_profiles` is always `[]`. Apple sends `[5, 8]` when Dolby Vision is on (`482`). This client does not claim a Dolby Vision profile.
- `capabilities.hdr` is true only when HDR10 or HLG is claimed. The same `hdr_details` go on `client_capabilities`, `output`, and both `original_http` and `hls`.

Off, an unsupported panel, a throwing probe, or a failed read of the HDR key the server offered sends the same SDR profile as before: `hdr: false` and no `hdr_details` on `client_capabilities`, `output`, `original_http`, or `hls`. HDR off does not leave an original or a remux claimed as HDR. The reason is in the caption section above. A title is never declared direct-playable in a range the panel did not report. If the server does not offer the HDR key, the Apple default stays on, so a panel that reports HDR still claims HDR10. Resolution stays 1080p. No DTS and no audio passthrough.

## App language

Settings › General › LANGUAGE, after Profile at Launch and before Title Pages, shows an `App Language` row that opens a picker of Match Device and the languages this build ships, by Apple's names for them (Deutsch, Español, 日本語, 简体中文…), sorted by name as Apple's `AppLanguagePreferences.options` sorts them: `localizedStandardCompare` in the TV's locale, so Čeština, Dansk, Deutsch, English, Español… then Cyrillic, Arabic, Korean, Japanese and the two Chinese last. Match Device stays first and a stored tag this build lacks goes last.
The footer is Apple's: `The language of Auger’s menus and buttons on this profile. Audio and subtitle languages are set in Playback.`
Source: [silo-apple `dce56e3c`](https://github.com/Silo-Server/silo-apple/tree/dce56e3c), `tvOS/Screens/Settings/TVGeneralSettingsView.swift` (`languageGroup`, the `.appLanguage` picker) and `Networking/AppLanguagePreferences.swift`.

- Key `ui.app_language` (settings revision 28, a language tag; null is Match Device, the default). The row appears only once the server has answered for the active profile: the capability must be available, allowed, batched and at revision 28 or later.
- The choice is stored on the server for the profile, so every device signed into it shares it. Picking a language writes the profile value, then clears this TV's own `profile_device` row if one hid it (a 404 on that delete counts as already absent). Picking Match Device writes null. Choosing the language already stored does nothing, except over a device row, where it still saves.
- Picking closes the picker at once and the save settles behind it, as Apple's `TVSettingsPickerSheet` does. While a save runs the picker shows `Saving the app language…` and takes no choice. A failed save restores the stored language and shows Apple's connection, unsupported or generic message under the row.
- A language tag stored by another client that this build lacks (Íslenska, for example) shows as itself in the row and the picker, with `Auger isn’t available in Íslenska yet, so it uses the device language.`, so saving never clears it. Its name comes from the browser's own language data, because only the shipped languages have a fixed name.
- Browse reads the answer when it starts (launch, and each profile or server switch), and Settings reads it again once its own load has finished, as Apple reads when Settings opens. The read waits for that load because a capability read made at the same time raced it. A launch read that missed therefore does not hide the row. The last confirmed choice is cached in public storage (`silo.appLanguage.choice:[serverId, profileId]`) for first-draw display.

Platform limits, which Apple does not have:

- Screen translation coverage, `reconcileLanguage`, `serverText`, sort/date formatting, right-to-left mirroring, and remaining English strings live in [translation.md](translation.md) (single source of truth; see [#571](https://github.com/Artic0din/Auger-Tizen/issues/571)).
- Apple also writes the choice as the app's system language (`AppleLanguages`) and reads a change made in system settings back as this device's value. Tizen has no per-app system language, so neither direction exists here.

### Settings text

Every string on the four Settings panes, their pickers and dialogs, the Privacy Policy and Acknowledgements screens, Connection speed and the sign-out confirmation reads from the catalog through `translate(key)`, with Apple's key for it (silo-apple `dce56e3c`, tvOS `TVGeneralSettingsView`, `TVPlaybackSettingsView`, `TVSubtitleSettingsView`, `TVSettingsView` and the label helpers they call).
A screen builds its text when it draws, so a language change repaints Settings at once.

- Apple's catalog names Apple TV in the keys whose text says "this Apple TV" (`…AppleTv`, `…Tv`). `translateTv(key)` reads them as Settings always has, "this TV", by replacing the brand in every language. A test pins the list of those keys and shows none keeps "Apple TV".
- Apple keeps some labels out of the catalog, so Tizen does too: the subtitle Behavior values (Auto, Always, Off), the Resolution value Auto, and the units in rates. A rate keeps `Mbps` and `kbps` in English and writes its digits and decimal mark in the language's, as Apple's `LocaleFormat.localized` does (`4,5 Mbps`, `٤٨ Mbps`). Subtitle opacity writes `50 %` in German.
- Server text with no key stays as the server sent it: option labels such as the skip intervals and the metadata and subtitle language names.
- Lines with no Apple key to take stay English whatever the language, because they are Tizen's own wording or name something Apple's lines do not: the Settings load, save and conflict errors, the theme music and spoiler save errors, the launch-choice save and retry text, `Loading settings…`, `Check and retry`, `Reload settings`, `Use inherited default`, `Restore All Libraries`, `No supported settings in this category.`, the Playback audio picker's two scope notes, the not-offered note, `None hidden` and `Custom appearance`, the HDR footer (it leaves out Apple's Dolby Vision sentence), and the Acknowledgements lines for TMDB, YouTube, profile avatars and open source. Apple's own text for the Playback reset dialog counts device settings that Samsung has no row for, so the dialog uses Apple's title and its reset footer instead.
- A failed skip-interval save reads Apple's message for its interval (`player.seekInterval.saveConnection…`, `saveUnsupported…`, silo-apple `SeekIntervalPreferences.writeFailureMessage`) when the request never reached the server or its answer did not parse, or when a 422 names the key. Apple's English replaces Tizen's generic line for these two causes. Every other failure keeps Tizen's own wording, including the 429 retry-after seconds and the 403 and 422 advice, because Apple's single `saveRejected…` line has no room for them (#592, option A).
- A key a language lacks shows the English text, as Apple's does for a key outside a language's table.

Catalog vendoring, per-language trimming, and on-demand loading (`catalog/<tag>.js`, keeping only English in `main.js`) are documented in [src/i18n/catalog/README.md](../src/i18n/catalog/README.md). On the S95C, bundling every language into `main.js` slowed first paint by 277 ms ([#595](https://github.com/Artic0din/Auger-Tizen/issues/595)).

## Theme music

Settings › General › THEME MUSIC, after the Title Pages group and before Cards & Posters, shows `Play Theme Music` and `Loop Theme Music`.
Both are switches. Loop is disabled until Play is on. A disabled Loop row is drawn at full brightness (Apple's `TVSettingsPaneRowStyle` sets an explicit foreground, so `.disabled` does not dim it); Up and Down skip it, and it ignores presses. The footer is Apple's: `Play a title's theme song from your library while its page is open. Only affects this TV.`
Source: [silo-apple `650a0b8a`](https://github.com/Silo-Server/silo-apple/tree/650a0b8a), `TVGeneralSettingsView.themeMusicGroup`, `ThemeMusicPreferences.swift`, `Screens/Detail/ThemeMusic/*`, and silo-server `df9f5501` (`docs/catalog-api.md`, "Local theme songs, V2").

- Keys `ui.theme_music_enabled` and `ui.theme_music_loop` (settings revision 11, boolean, default off). The rows appear only when the capability is available, allowed, batched, at revision 11 or later, with a `profile_device` scope.
- The server resolves each key for this TV: `profile_device`, then `profile`, then the default. A switch writes this TV's `profile_device` value, which wins over a profile value, so the change always takes effect here. The manifest lists the keys for the web only, so the Tizen decoder does not rely on the platform list.
- Settings are read when Browse starts (launch, and each profile or server switch) and on return to the foreground. Apple also reads when Settings opens; this client does not, because the rows write and re-read their own keys and a second read would race the Settings load. Nothing is cached: music plays only for an answer read from the server for the active profile.
- A failed write rolls back only its own switch and says why, using Apple's three messages.

### Playback of the theme

`src/ui/themeMusic.ts` ports Apple's `ThemeMusicController` and `ThemeMusicCenter`.

- Pages: a movie, series, season or episode Details page. Other screens play nothing. A season whose detail has no set keeps its series' set.
- Starts: as soon as the grant arrives; there is no extra delay. Audio is created silent and fades up over 300 ms (12 steps) to 0.35 once playback has advanced past the start.
- Same owner and theme across pages (series to season, for example) keeps playing and is not restarted. Loading Details suspends: fade out and pause, then resume in place.
- Loop off: the theme plays once and is released; staying on the page does not start it again. Loop on: original audio loops in place. A converted theme cannot seek, so it asks for a fresh grant when it ends.
- A failed stream retries once with a fresh grant. Progress earns another retry. A refused grant leaves the page silent.
- Leaving Details, opening Settings, or the profile or server changing fades the theme out (or silences it at once).
- Starting playback stops the theme in the same turn, before the player opens AVPlay (`handoff`, `src/ui/browse.ts`). Nothing starts while the player is open; the theme starts again on return to Details.
- App hidden (`visibilitychange`) suspends; visible again resumes.

### Audio output

AVPlay is a single instance and belongs to video, so the theme plays through an HTML5 `<audio>` element (`src/ui/themeAudioOutput.ts`).
The server sends original audio (mp3, aac, flac, ogg, wav) or, for a format this Chromium cannot decode, progressive AAC in MP4 with no length or byte ranges; both are plain audio the web client plays in an `<audio>` element.
Tearing down pauses, drops `src` and calls `load()` so the element releases the TV's audio decoder before AVPlay opens.
If the platform refuses `play()` for lack of a user gesture, the next remote key starts it.
Desktop Chromium proves the state machine and the hand-off order, not that a TV's `<audio>` plays these formats or that it frees the decoder in time; that needs a Samsung TV.
S95C checks on 16 and 22 Nov 2026 (#529, main `2ccaadf3`) found the `<audio>` element plays an mp3 theme, loops, fades out over about 350 ms and is released before AVPlay opens, after which AVPlay plays with its audio stream. Sound by ear and the other formats were not checked: the TV stayed muted and the themes were mp3.

## Show Audiobooks

General ends with Apple's TOP MENU section: a Show Audiobooks switch and the footer `Adds an Audiobooks tab when an audiobook library is available.` (`TVGeneralSettingsView.swift`).
`nav.show_audiobooks` is `client_local`, default off.
The choice is stored on this TV for the current server, account and profile, and is never sent to the server, as Apple's `AppNavPreferences` does.
TOP MENU is the last section in General, as in Apple's `TVGeneralSettingsView`.
The Audiobooks tab, and the Audiobooks filter in Search, need the switch on and an audiobook library the profile has not hidden.
Settings returns to Home, so turning the switch off while on the tab leaves nothing stranded.

## Streaming rows AVPlay cannot honour

Rows that nothing on this TV can act on stay hidden.
Apple's STREAMING section ([`TVPlaybackSettingsView.swift:175-251`](https://github.com/Silo-Server/silo-apple/blob/e958f58413521087c57f9e1971b244537a1fd890/iosApp/iosApp/tvOS/Screens/Settings/TVPlaybackSettingsView.swift#L175-L251), silo-apple `e958f584`, tvOS) exposes these rows for its Aether engine; Samsung's STREAMING section shows Audio Language and HDR only (`test/ui/settings.test.ts` and `test/native/settings.test.ts` enforce that hidden keys are never shown, read, or written).
AVPlay quotes below are from Samsung's [AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html) (read 15 Nov 2026).

| Hidden row | Reason / Samsung platform limit |
| --- | --- |
| Dolby Vision (`player.dolby_vision_enabled`) | Samsung's AvInfo API exposes no Dolby Vision check, and this client claims no Dolby Vision profile (`dolby_vision_profiles: []`). |
| Seek Cache (`player.seek_cache_enabled`, remote) | `AVPlayStreamingPropertyType` has no cache or read-ahead setting (`PREBUFFER_MODE` sets initial prebuffering start time only), and `seekTo` in PLAYING flushes buffered data. |
| Buffer Ahead | `setBufferingParam` / `setTimeoutForBuffering` control start/resume accumulation thresholds only (callable in IDLE, 4 s min), not forward download window. |
| Deinterlacing, Deinterlacing Field Rate | AVPlay exposes `ScanType` read-only with no deinterlacer or cadence setter. This client claims H.264/HEVC only so the server converts MPEG-2/VC-1. |
| Lossless Multichannel Audio | AVPlay has no client-side lossless bridge decoder; Samsung TVs lack TrueHD and dropped DTS in Tizen 7.0+; `tvaudiocontrol.getOutputMode()` cannot attest lossless sink support; server transcode targets are `copy`, `opus`, `eac3`, `ac3`, `aac`. |
| TrueHD Atmos and DTS:X | Hidden in Apple's own Silo build (`AetherLoadSpec.swift:660-666`), and Samsung lists neither codec. |
| Still Watching prompt | Apple's EPISODES row limits consecutive autoplay episodes (`TVPlaybackSettingsView.swift:275-279`); Samsung has no guard yet ([#796](https://github.com/Artic0din/Auger-Tizen/issues/796)). |
| Use Device Settings (captions) | Samsung exposes no TV-wide caption-style API for the app subtitle overlay. |
| Diagnostics (Silo server upload) | Auger is a third-party client and does not upload to Silo's first-party diagnostics endpoint (#138). Instead, **Settings > Diagnostics** provides a 4-category **Send Diagnostics Report** picker (deduplicated through the Auger Cloudflare Worker relay to `diagnostics` GitHub Issues), an opt-in **Automatic Error Reports** toggle (off by default), and a zero-backend **Share via QR Code** backup (#847). |

Open question: whether to claim multichannel LPCM direct play requires HDMI/eARC channel-count proof on the S95C first.

## Lower quality when buffering

QUALITY keeps Apple's order (`TVPlaybackSettingsView.swift:60-120`): Resolution, Maximum Bitrate, Lower quality when buffering, the learned limit, then one footer.

- **Lower quality when buffering** is `playback.buffering_quality_mode` with the manifest's labels: Never, Ask first and Automatically (default). It is a device value like Skip Intros: the picker lists Use Profile Setting first, and a choice is saved for this TV only. The row is drawn only when the server's settings define the key (`SettingsViewModel.swift:82`).
- The footer under Resolution and Maximum Bitrate ends with the manifest's description, "What Auger does on Auto when playback keeps buffering. Auger always asks before lowering a quality you picked.", while the row is shown (`TVPlaybackSettingsView.swift:106-110`).
- **Learned limit** reads `learned_limit` from `GET /playback/connection` and shows "Limited to 44 Mbps after buffering on Oct 17" with Reset: the rate as Settings shows rates, and the day of the last lowering in the TV's locale and time zone. The row needs `buffering_quality_v1` in the capability answer and a limit on the connection document, and it is hidden in Never, which ignores the limit (`SettingsViewModel.swift:476-481`). Connection speed needs only `connection_speed_v1`: with just `buffering_quality_v1` the document is read for the limit, and the probe, sample and budget in it are ignored.
- **Reset** sends `DELETE /playback/connection/learned-limit`, which the server answers with 204 and which is never retried. The row then disappears and focus moves to the buffering row, or to Maximum Bitrate when the server has no such row. With `connection_speed_v1` the document is read again because the server's budget counted the limit. A failed reset keeps the row and shows "Couldn't reset the limit. Try again." under the footer until the next reset or read.

For the in-player stall detection, replan thresholds, and prompt/undo pill behavior, see [Playback quality: Lower quality when buffering](playback/playback-quality.md#lower-quality-when-buffering).
