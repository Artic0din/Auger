# Client-side workarounds for `EXT-X-DEFINE` playlists

Research note for [#314](https://github.com/Artic0din/Auger-Tizen/issues/314), [#911](https://github.com/Artic0din/Auger-Tizen/issues/911) and [#988](https://github.com/Artic0din/Auger-Tizen/issues/988).
It builds on the 19 Nov feasibility comment on #314 and does not repeat it.
Checked on 28 Nov 2026 against Auger main `8a13b905`, silo-server `0a631fb9` and Moonfin Smart-TV `76b471c1`.
The research below was desk work; the [TV results](#tv-results-29-nov-2026) section was added after a run on the S95C on 29 Nov 2026.

## Recommendation

1. Keep the upstream server fix as the real fix ([silo-server#5466](https://github.com/Silo-Server/silo-server/issues/5466), no PR yet).
   No client route below matches it on coverage, cost and credential handling at once.
2. Consider the cheapest partial fix: on HLS plans, stop appending the account `token` and let the plan's own `st` authorize the media.
   It needs no server change and no privilege, takes the account token out of media URLs, and fixes long transcodes that a transcode node runs.
   It changes nothing for transcodes the API server runs itself, which the existing guard keeps refusing cleanly.
   The 8 Nov capture on #314 (a 145 KB playlist whose segment URIs end in `?{$silo_query}` with no `st` appended) matches a transcode the API server ran itself, so this route would not have fixed that case.
3. Run the one-hour TV spike in [Smallest TV tests](#smallest-tv-tests) for the local-file rewrite before building anything bigger.
   If AVPlay plays a local `.m3u8` with remote segments, the local-file rewrite is the only route that covers every long transcode without a server change, at the cost of `http://tizen.org/privilege/filesystem.write`.
4. Do not build the local HTTP service, the hls.js engine or the API-key route.
   Each is larger, breaks an AGENTS.md invariant, or puts a long-lived full-account credential in every segment URL.

Separately, long H.264 and HEVC copy remuxes are literal for this client, but they failed on the TV for a different reason: HLS subtitle renditions (see [TV results, 29 Nov 2026](#tv-results-29-nov-2026)).
The client no longer requests those renditions (`CLIENT_FEATURES`, `src/player/capabilities.ts`), so long copy remuxes play and their text tracks arrive as artifacts the app draws.
Requesting renditions again is worth a TV test once server-built playlists stay literal for this client.

| Route | Server change | Coverage of long transcodes | New privilege or invariant cost | Credential in | Size | TV proof needed |
|---|---|---|---|---|---|---|
| Wait for upstream fix (baseline) | Yes | All | None | Unchanged | None in this repo | Release check only |
| `st` only on HLS plans | No | Node-executed only | None | Plan URL (`st`) only | Small | One long transcode on a node-backed server |
| Local-file rewrite | No | All | `filesystem.write` (public level) | A temp file plus every segment URL | Medium | Yes, blocking |
| Local HTTP service | No | All | `application.launch`, `web.service` feature, a Node service | Service memory plus every segment URL | Large | Yes, blocking |
| hls.js over MSE | No | Partial (codec gaps) | Breaks the AVPlay invariant; CSP change | Page memory | Very large | Yes |
| Short API key in `token` | No | All, admin accounts only | None in `config.xml`; security cost | Every segment URL, never expires | Small to medium | Yes |
| Steer to another delivery | No | None | None | Unchanged | Small | Not worth it |
| `data:`, `blob:`, userinfo, `COOKIE` | No | None | None | n/a | n/a | Not worth it |

## Which playlists are affected

The server substitutes in [`syntheticManifestQuery`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/manifest_variables.go#L96-L105).
It repeats the playlist request's whole raw query on every segment URI ([`HandleGetTranscodeManifest`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/handlers/playback.go#L2442) passes `r.URL.RawQuery`).
It keeps the query literal while each URI saves under 64 bytes (a query of 76 bytes or less) or the total saving stays under 64 KiB, and it never reads `hls_variable_substitution_v1` ([`manifest_variables.go:22,69,101`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/manifest_variables.go#L101)).
The protocol states this split in [playback-protocol-v3.md §4.2](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/docs/architecture/playback-protocol-v3.md#L1098-L1110).

| Playlist | Built by | Substitutes for Auger? |
|---|---|---|
| Encoded transcode video playlist | Server, synthetic VOD ([`buildVideoPlaylist`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/transcode.go#L2822-L2843), [`generateSyntheticPlaylist`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/transcode.go#L3629-L3678)) | Yes, past about 66 two-second segments with a 1 KB query |
| Encoded transcode subtitle-rendition playlist | Server, same synthetic grid ([`subtitle_rendition.go:818-820`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/subtitle_rendition.go#L818-L820)) | Yes |
| H.264 or HEVC copy remux | FFmpeg's real playlist, rewritten literally | No, per source |
| Multivariant playlist | Server, a handful of URIs | No |

The remux row follows from four facts.
Auger lists `hls_copy_mpegts_v1` ([`capabilities.ts:238`](../../src/player/capabilities.ts)).
The planner then packages an H.264 or HEVC copy as MPEG-TS ([`candidate_routes_v3.go:142`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/candidate_routes_v3.go#L142), [`playback_v3.go:4324`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/handlers/playback_v3.go#L4324)).
A keyframe plan needs fragmented MP4 ([`planCopySegments`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/copy_keyframe_plan.go#L81-L89), [`copyVideoUsesFMP4`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/transcode.go#L1330-L1340)), so the session serves FFmpeg's playlist.
That playlist is rewritten with substitution only when the flag is set ([`transcode.go:2836-2839`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/transcode.go#L2836-L2839)).
The S95C confirmed the literal playlist on 29 Nov 2026 (see [TV results, 29 Nov 2026](#tv-results-29-nov-2026)).

## TV results, 29 Nov 2026

Samsung S95C (QA77S95CAWXXY, Tizen 9.0), installed Auger 0.14.17, one 2 h 6 m film (H.264 1920x804, E-AC-3 5.1, MKV, about 47 embedded text subtitle tracks).
The app was driven over the SDK debug inspector with injected remote keys.
Remux plans were forced by removing `eac3` from the audio lists of the app's `POST /playback/start` body in transit; a title with DTS audio should plan the same way, which was not tested.

| Case | Playlists the app received | Result |
|---|---|---|
| Direct play | None | Played |
| Transcode (Quality set to 1080p Medium) | Multivariant master, 75,666 bytes, version 3; video playlist, 202,256 bytes, version 8, `#EXT-X-DEFINE` (1,590-character definition), 3,784 segments, `segment/seg_00000.ts?{$silo_query}` | The app refused the stream before AVPlay opened and showed its error page |
| Remux, features as shipped | Multivariant master, 79,715 bytes, one variant plus a rendition per text track; video playlist, version 6, `EVENT`, literal `st` and `token` on every URI, no `#EXT-X-DEFINE` | The guard passed, AVPlay opened the master, the page stopped answering and the TV closed the app |
| Remux without `hls_subtitle_renditions_all_v1` | `master.m3u8` is the media playlist itself: version 6, `EVENT`, literal, 17,825 to 44,985 bytes while growing | Played on three starts, across one skip that reopened the stream, and past 2:00 |
| Remux without `hls_subtitle_renditions_all_v1`, one subtitle selected | Multivariant master, 3,095 bytes, one variant and one subtitle rendition; video playlist literal | The app's error page after about 8 s; the app kept running |

What this establishes:

- The transcode failure is `#EXT-X-DEFINE` in the video playlist, as described above.
- The app-closing freeze first recorded in #650 does not need `#EXT-X-DEFINE` in the video playlist: a multivariant master with a rendition per text track is enough.
  `playlistUnreadable` reads only the master and the first video variant, so it does not catch this.
- A long copy remux plays on AVPlay when the plan carries no subtitle rendition.
- Subtitle-rendition playlists were not read in this run.
  The server builds them itself ([`subtitle_rendition.go:818-820`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/subtitle_rendition.go#L818-L820)), so they probably carry `#EXT-X-DEFINE` on a long title; that would explain both rendition failures and is unverified.

Samsung's [General Specifications](https://developer.samsung.com/smarttv/develop/specifications/general-specifications.html) HLS tag table lists `#EXT-X-DEFINE` as "Not supported", in the same row group as `#EXT-X-INDEPENDENT-SEGMENTS` and `#EXT-X-START`.
That is a positive statement, not silence, so AVPlay support should not be expected on newer models either.
The HLS draft defines the substitution in [rfc8216bis-20 §4.3 and §4.4.2.3](https://www.ietf.org/archive/id/draft-pantos-hls-rfc8216bis-20.txt); resolving it means replacing each `{$name}` in URI lines and quoted attribute values with the defined value, and the server states the resolved URIs are byte-identical to the literal form (§4.2 above).

## Routes

### 1. `st` only on HLS plans (recommended first)

**How it works.**
The media routes take the plan's signed reference `st` alone, with no `Authorization` and no `token`, while the attempt is live and its login session is active ([`RequireStreamReferenceAuth`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/middleware/stream_reference.go#L60-L87); [api-contract.md around line 747](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/docs/architecture/api-contract.md#L746-L760)).
When a transcode node runs the session, the API strips `st` before relaying ([`playback.go:2685`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/handlers/playback.go#L2685)), so the node builds its playlist from the remaining query.
Today that remainder is Auger's account `token`, long enough to substitute.
With `st` alone the node sees an empty query and writes a literal playlist, and the API appends `st` literally because Auger does not list the flag ([`playback.go:2764-2785`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/handlers/playback.go#L2764-L2785)).
When the API runs the transcode itself, the query is `st` (about 1 KB, [`manifest_variables.go:12-15`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/manifest_variables.go#L12-L15)) and still substitutes, so nothing changes there.

- **Server change:** none.
- **Invariants and privileges:** stream auth stays in the query; no `config.xml` change.
  [native-api-v2.md](../native-api-v2.md) and the Gate C comment in `src/player/controller.ts` must be updated to say HLS uses `st` only.
- **Credentials:** the account bearer leaves media URLs entirely; only `st` remains, which ends when the session stops, the login session signs out, or after 24 hours.
- **Controller interplay:** skip `withMediaToken` for HLS plans at both build sites, `open` ([`controller.ts:2287-2305`](../../src/player/controller.ts)) and `urlWithToken` for warm restore ([`controller.ts:3815-3830`](../../src/player/controller.ts)).
  Seek inside the VOD playlist, `seek_reanchor` ([`controller.ts:1099`](../../src/player/controller.ts)), replan and reconnect all get a fresh plan URL with a fresh `st`.
  Subtitle-rendition URIs inherit the same query.
  `playlistUnreadable` ([`controller.ts:3227-3238`](../../src/player/controller.ts)) stays as the safety net.
- **Size:** a few lines plus tests that assert the `token` parameter.
- **Primary sources prove:** the auth path, the relay query handling and the literal append.
- **Only a TV can prove:** that a node-backed long transcode then plays, and whether the owner's server uses transcode nodes at all (not checked; no sign-in was allowed).
- **Risk:** an attempt with no recorded login session falls back to requiring the account credential (`stream_reference.go:115-118`); Auger signs in with login sessions, so this should not apply.

### 2. Local-file rewrite

**How it works.**
Fetch the small substituted playlist from the web view, resolve `{$silo_query}`, make segment URIs absolute, drop `#EXT-X-DEFINE` and lower `#EXT-X-VERSION`, write the file, and call `webapis.avplay.open()` with its absolute path.
The web view can already read the playlist: the transcode routes are registered cross-origin ([`playback_delivery.go:202`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/apiv2/playback_delivery.go#L202)) and `playlistHeads` reads them today ([`http.ts:101-141`](../../src/api/http.ts)).
`playlistHeads` stops at 64 KiB, so the rewrite needs a full read.

What Samsung documents:

- `open(url)`: "It can be an absolute local path or a remote URL from a network-based stream server" ([AVPlay API](https://developer.samsung.com/smarttv/develop/api-references/samsung-product-api-references/avplay-api.html)); "Relative local paths are not supported" ([Playback Using AVPlay](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html)).
- `setExternalSubtitlePath`: "If the subtitle file is stored remotely, you must first download the file to local storage, and pass the absolute local path" (AVPlay API).
  This shows Samsung expects apps to write a file and hand AVPlay its path, but says nothing about playlists.
- Writing: `openFile` needs `http://tizen.org/privilege/filesystem.write` (and `filesystem.read` for reading), privilege level public ([Filesystem API](https://developer.samsung.com/smarttv/develop/api-references/tizen-web-device-api-references/filesystem-api.html)).
  No writable virtual root is documented without it; `wgt-package` is read-only.
- Location: `wgt-private-tmp` is private, and its content "can be removed from this directory when the widget is closed or the Web Runtime is restarted" (Filesystem API), which suits a file that holds a credential.
- Path mapping: `tizen.filesystem.toURI(path)` (since Tizen 5.0, no privilege listed) returns a `file:///...` URI for a virtual path (Filesystem API).
  Stripping `file://` gives an absolute path; which form AVPlay accepts is undocumented.

- **Server change:** none.
- **Invariants and privileges:** AGENTS.md limits `config.xml` to `internet`, `tv.inputdevice` and `productinfo`; adding `filesystem.write` (and probably `filesystem.read`) is the owner's call.
  AVPlay stays the player.
- **Credentials:** `st` and `token` sit in a file on the TV in every segment line, plus every segment URL as today.
  Delete the file on stop, error, replan and app exit, and keep it in `wgt-private-tmp`.
  Route 1 shrinks this to `st` only.
- **Controller interplay:** run only when `playlistUnreadable` trips, so short titles and remuxes keep today's path.
  Every replan, `seek_reanchor`, reconnect and quality or track change returns a new plan URL and needs a new rewrite.
  Seeks inside the VOD playlist need none.
  `restoreAsync` after `visibilitychange` must get the local path, not the remote URL (`urlWithToken`).
  For a plan with a subtitle rendition, open the multivariant playlist's `silo_rendition=video` variant directly: Auger draws text itself, and rewriting master, variant and subtitle playlists into three local files adds relative-path questions the docs do not answer.
- **Size:** medium; a pure rewrite function with tests, a filesystem adapter, cleanup, and two URL build sites.
- **Cost on the TV:** a 91-minute transcode's substituted playlist was 145,809 bytes ([silo-server#5466](https://github.com/Silo-Server/silo-server/issues/5466) log); the server estimates 4 to 6 MB once literal for two hours (`manifest_variables.go:12-15`).
  AVPlay's playlist size limit and parse time are undocumented.
- **Primary sources prove:** the privilege, the location and the path conversion.
- **Only a TV can prove:** that AVPlay accepts a local `.m3u8` with absolute `https` segments, which path form it wants, and that a 4 to 6 MB playlist parses in time.

### 3. Local HTTP service

The 19 Nov comment assumed a Tizen web app cannot listen on a port.
That holds for the page, but Samsung TVs run Tizen web service applications on a Node runtime: Samsung's [Implementing Personal Preview](https://developer.samsung.com/smarttv/develop/guides/smart-hub-preview/implementing-personal-preview.html) declares one with `<tizen:service>`, launches it with `tizen.application.launchAppControl`, and says HTTP requests there "must" use NodeJS.
The open-source [Nuvio TV](https://github.com/nuviomedia/nuviotvsmart/tree/4dd0f8b6edd093ce7a319758c94c0ba447d62ff0) ships such a service with `http.createServer` on loopback for its player ([`services/tizen/enginefs-service.js`](https://github.com/nuviomedia/nuviotvsmart/blob/4dd0f8b6edd093ce7a319758c94c0ba447d62ff0/services/tizen/enginefs-service.js), [`scripts/package-tizen.mjs:87-115`](https://github.com/nuviomedia/nuviotvsmart/blob/4dd0f8b6edd093ce7a319758c94c0ba447d62ff0/scripts/package-tizen.mjs#L87-L115)), declaring `http://tizen.org/feature/web.service` and `http://tizen.org/privilege/application.launch`.
Its README claims this works on Tizen 5 and later; that is the project's claim, not a Samsung statement.

- **Server change:** none.
- **Invariants and privileges:** adds `application.launch`, a feature requirement, a second runtime and a Node service to the package.
- **Lifecycle risk:** Samsung documents services only for Smart Hub Preview, and states "if the background service application is not terminated in this way, it is automatically terminated after 5 minutes" under the Samsung Apps TV policy (same page).
  Whether that kills a playlist server mid-film, and whether Apps2Samsung review accepts one, is unknown.
  The [Smart Hub Preview Q&A](https://developer.samsung.com/smarttv/develop/faq/smart-hub-preview.html) also warns that launching a service on a TV without service support "causes unexpected behavior in the foreground application, such as missing images and corrupted video playback".
- **Credentials:** held by the service; segment URLs as in route 2.
- **Controller interplay:** as route 2, with a loopback URL instead of a path, plus service start, health and teardown.
- **Size:** large.
- **Only a TV can prove:** service launch on the S95C, AVPlay reading `http://127.0.0.1`, and survival past 5 minutes.
  Route 2 does the same job with less, so build this only if AVPlay refuses local files but takes loopback URLs.

### 4. hls.js over Media Source Extensions

- hls.js resolves `EXT-X-DEFINE` from [v1.4.0](https://github.com/video-dev/hls.js/releases/tag/v1.4.0) ([PR #5161](https://github.com/video-dev/hls.js/pull/5161)), but only in the full build: `__USE_VARIABLE_SUBSTITUTION__` is off in the light build ([`build-config.js:67-72`](https://github.com/video-dev/hls.js/blob/v1.6.15/build-config.js#L67-L72)).
- In MPEG-TS, the latest release v1.7.4 rejects E-AC-3 ("Unsupported EC-3 in M2TS found") and parses HEVC only in the full build (`__USE_M2TS_ADVANCED_CODECS__`); AC-3 is parsed ([`tsdemuxer.ts`](https://github.com/video-dev/hls.js/blob/v1.7.4/src/demux/tsdemuxer.ts)).
- Samsung lists MSE as supported ([Web Engine Specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html); Tizen 8.0 is Chromium M108) but documents no MSE codec list; which of HEVC, AC-3 and E-AC-3 `MediaSource.isTypeSupported` accepts on the S95C is unverified.
- `app/config.xml` sets `default-src *` and `script-src 'self'`; under CSP Level 3 the `*` wildcard does not match `blob:`, so a MediaSource object URL likely needs `media-src blob:`, and hls.js's blob worker needs a packaged worker file. Unverified on Tizen.
- Moonfin, the client behind #5466, plays through AVPlay only on Tizen: its fallback ladder never reaches hls.js there ([`playbackFallback.js`](https://github.com/Moonfin-Client/Smart-TV/blob/76b471c1fbf2ea7f95c3f3a8733faa5d621dda79/src/pages/Player/playbackFallback.js), [`videoEngine.js:737-760`](https://github.com/Moonfin-Client/Smart-TV/blob/76b471c1fbf2ea7f95c3f3a8733faa5d621dda79/src/state/videoEngine.js#L737-L760)), so it offers no Tizen precedent.

It breaks the AGENTS.md invariant that AVPlay plays primary video, needs a CSP change and a new dependency, and duplicates suspend and restore, the HUD Stats tab, audio track switching and the reconnect ladder for a second engine.
Rejected.

### 5. A query short enough to stay literal

Only an API key fits: `sa_` plus 64 hex characters ([`generateAPIKey`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/auth/api_key_repository.go#L70-L77)) makes `token=<key>` 73 bytes, under the 76-byte limit, and the auth middleware accepts keys in `token` ([`auth.go:439-450`, `116-158`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/middleware/auth.go#L439-L450)).
Access tokens and `st` are far longer.
It would have to replace `st`, so the attempt must negotiate `header_authenticated_media_v1` ([§4.1](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/docs/architecture/playback-protocol-v3.md#L836)), whose URLs carry no credential, and Auger must not list `hls_transport_marker_v1` so no `silo_transport` parameter joins the query.
`silo_rendition` is stripped before segment URIs are written ([`subtitle_rendition.go:793-799`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/subtitle_rendition.go#L793-L799)), so renditions do not break it.

Why it is rejected:

- No user scope admits playback; "None lists playback, a stream, a download" ([`api_key_scopes.go:46-49`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/middleware/api_key_scopes.go#L46-L49)), and a profile-bound key must carry user scopes only ([`bindAPIKeyProfile`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/api/middleware/api_key_scopes.go#L210-L231)).
  So only an unscoped account key works, and only "a server admin's login session" can create one ([`personal_api_keys.go:251-265`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/apiv2/personal_api_keys.go#L251-L265)).
- That key is full access as the owning admin, has no expiry field ([`models/api_key.go`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/models/api_key.go#L6-L18)), and would sit in every segment URL and server log line.
- The server's own parameter description says header-authenticated media "requires the Authorization header and the profile selector" ([`playback_delivery.go:140`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/apiv2/playback_delivery.go#L140)); the code accepts the query today, but relying on it contradicts the contract.

### 6. Steering away from server-built playlists

The server uses FFmpeg's real playlist only for copy video, unknown durations, or more than 50,000 segments ([`buildVideoPlaylist`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/transcode.go#L2822-L2843), [`CanGenerateSyntheticManifest`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/transcode.go#L3111-L3119)); a client controls none of these for an encode.
Declaring a `progressive` delivery would make the planner prefer `server_remux_progressive` over HLS for copies ([`candidate_planner_v3.go:80-93`](https://github.com/Silo-Server/silo-server/blob/0a631fb9cba82de78c6461a6edcc9a2291957354/internal/playback/candidate_planner_v3.go#L80-L93)), but copies are already literal for Auger and an encode has no progressive form (§4 table).
The only levers that avoid an encode are user-side: subtitles off for bitmap burn-in (#911), or clearing a learned bandwidth limit (21 Nov comment on #314).
Not a fix.

### 7. Other AVPlay inputs

- `data:` and `blob:` URLs: neither Samsung page mentions them; silence, not support.
- `COOKIE` is the only request-shaping streaming property besides `USER_AGENT` (AVPlay API, `AVPlayStreamingPropertyType`); the server never reads cookies (`extractBearerToken`).
  `HttpHeader` exists only for PlayReady licence requests (Playback Using AVPlay).
  No property adds query parameters or headers to segment requests.
- URL userinfo: even if AVPlay turned it into Basic auth, the server parses only `Bearer` (`parseBearerHeader`, `auth.go:454-462`).
- The Jellyfin-compatible routes are outside `/api/v2` and barred by AGENTS.md and `scripts/ci/check-no-api-v1.sh`.

## Unverified, needs a TV

1. AVPlay plays a local `.m3u8` whose segment URIs are absolute `https` URLs.
2. Which path form `open()` takes: the bare absolute path or the `file://` URI from `toURI`, and the real path behind `wgt-private-tmp` on the S95C.
3. AVPlay's playlist size limit and parse time for a 4 to 6 MB literal playlist, and the time to fetch, expand and write it on the TV.
4. Long transcodes play with `st` alone on a server whose transcodes run on a transcode node; whether the owner's server does.
5. Why AVPlay fails on a multivariant master with subtitle renditions, and whether a real DTS title plans the same remux as the forced one (a remux without renditions did play on 29 Nov 2026).
6. A web service launches on the S95C, serves `http://127.0.0.1` to AVPlay, and survives past 5 minutes.
7. MSE codec support for HEVC, AC-3 and E-AC-3 on Tizen 8, and CSP enforcement of `media-src` for MediaSource URLs.
8. AVPlay behaviour with `data:` or `blob:` URLs.

## Smallest TV tests

1. **Local playlist (settles 1 and 2, about an hour, no privilege).**
   Package a hand-made `.m3u8` in `wgt-package` whose segments are absolute `https` URLs of a public, credential-free test stream longer than two minutes.
   Call `open()` once with `toURI('wgt-package/test.m3u8')` and once with that URI minus `file://`.
   Play, seek past the two-minute mark, and read `getDuration()`.
   This avoids putting a live token in the package, unlike the #314 spike.
2. **`st` only (settles 4).**
   On a node-backed test server, open a long transcode's plan URL with `st` and no `token`; it should pass `playlistUnreadable` and play past two minutes.
3. **Remux (settles 5).**
   Play a long H.264 MKV that plans as `server_remux_hls` and seek past two minutes.
4. **Size (settles 3, only if test 1 passes).**
   Repeat test 1 with a generated two-hour playlist padded to 5 MB of query text and time `prepareAsync`.

Tests 2 to 4 need a test account on a test server; record results in #314 per [simulator-evidence.md](../evidence/simulator-evidence.md).
