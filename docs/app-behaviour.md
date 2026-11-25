# App behaviour

Summary of what the packaged Samsung TV app does today and what has been proven on a TV.

## Runtime architecture

The packaged app talks only to Silo's native `/api/v2`: Server entry, device-code sign-in with password fallback, Household Profiles and PINs, Movies and Series browsing, and AVPlay playback with audio and subtitle selection.

- `src/main.ts` boots the app through `src/bootstrap.ts` and `src/platform.ts`.
- `src/app.ts` composes screen controllers without owning network or credential logic.
- Sign-in uses an eight-digit device code approved on Silo's web page, with "Sign in with a password" one press away as on Apple TV. Passwords are sent only in `login` and never stored; only issued tokens are kept.
- Server addresses are remembered publicly; credentials live in Tizen KeyManager or explicit session-only mode when protected storage is unavailable.
- The Profile controller stays active while browsing and playback hold its Authority. When Authority ends, the app clears prior screens before the Profile controller regains focus.
- Requests appear only when the Server enables Requests for the active Profile ([Requests](features/requests.md)).
- Player Back and dismissed Up Next or error panels restore the originating browse view and focus.
- Movie completion opens Up Next with On Deck offers (returning to browse when dismissed). Natural episode completion supports an optional pre-end Up Next prompt, an On Deck row, and a 10 s autoplay countdown when enabled; transient STOP failures retry in the background rather than blocking episode advance ([playback completion](playback/playback-quality.md#manual-episode-completion), [series autoplay](playback/series-autoplay.md)).
- Back from Home or Library content moves to the navigation bar, then selects Home, then opens an Exit/Cancel dialog. Modal keys stay isolated from the screen underneath.

## Interface and controls

The TV interface follows the [Skyline design guide](https://github.com/Silo-Server/silo-apple/blob/main/docs/skyline-design-guide.md), with shared OLED palette, type family, and motion durations in `src/theme.css`.

- Sign-in, Profiles, dialogs, and playback use monochrome focus states and honor `prefers-reduced-motion: reduce`.
- Supported media keys (Play/Pause, Play, Pause, Stop, Rewind, Fast Forward) register independently; Enter works on every remote.
- Player Up focuses visible transport controls. Left and Right preview a seek without changing playback; Enter commits the source position and Back cancels.
- Rewind, Fast Forward, transport buttons, and Left/Right previews use the Profile's separate saved video skip intervals (defaulting to 10 s back and 30 s forward on supported Servers; 10 s each way on unsupported Servers).
- The Skyline bar groups visible Libraries into Movies, Series, and opt-in Audiobooks tabs (alongside Home, For You, and Calendar roots) with anchored Library and Profile menus, remembering Library scope per Server, Profile, and content type ([Skyline browse shell](features/skyline-browse-shell.md)).
- Card focus updates the passive preview without fetching details; scrolling retargets immediately and honors Reduced Motion.

## Playback and recovery

- Sidecar text subtitles (WebVTT, SRT, and ASS/SSA dialogue text) render in an app overlay; embedded bitmap subtitles are unclaimed. A failed subtitle file shows "Subtitle data couldn't be loaded. Turn subtitles off and on to retry." until the track loads or changes.
- The Server burns embedded subtitles into video when Transcode is allowed.
- Movie and episode Details persist explicit audio and subtitle choices on the Server (`PUT /audio-prefs/{key}`, `PUT /subtitle-prefs/{key}`) and clear them on Auto (`DELETE`); version selection remains visit-only and pins its source through playback ([preplay behavior](features/skyline-browse-shell.md#preplay-audio-subtitles-and-resume)).
- Resume checks fresh Profile progress for up to 3 s; Play from start sends source position 0.
- `visibilitychange` suspends the active pipeline and revalidates Authority and media authorization before restoring it.
- Mid-stream connection loss pauses playback and retries at the saved source position with bounded backoff, preserving playing or paused intent ([playback recovery](playback/playback-quality.md#lifecycle-and-connection-recovery), [#13](https://github.com/Artic0din/Auger-Tizen/issues/13)).
- Cold launches use the normal Server resume flow and never restore an in-memory pipeline.
- A refused playback start shows the catalog line for the problem's first field code or type, else "The server returned HTTP {status}." Unlike Apple TV, it never shows the problem's own detail or title, which can carry URLs, email addresses or credentials onto a shared screen; Diagnostics records the HTTP status.

## Validation limits

Automated suites run the composed app (including production `src/main.ts` bootstrap) in desktop Chromium against fake Silo and AVPlay ports. Desktop tests do not prove TV rendering, AVPlay playback, or TV IME behavior.

- **Proven on an S95C (Tizen 9):** HTTPS discovery and authenticated reads, device-code approval, Profile and catalog reads, Account restore across full exit/relaunch, Direct Play with picture/dialogue/60 s resume/seek/progress, one audio-track replan, return to title, and sign-out with Server revocation. (In the composed-app run, AVPlay state and Server responses were observed; audible track differences were not independently confirmed.)
- **Still open on hardware:** Tizen 8.0 hardware, TV keyboard input, full Remux and Transcode acceptance, and audible/visible track-switch acceptance.
