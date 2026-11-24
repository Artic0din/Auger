# Playback quality, completion, and recovery

Settings rows and AVPlay streaming exclusions live in [docs/settings.md](../settings.md) (see [Streaming rows AVPlay cannot honour](../settings.md#streaming-rows-avplay-cannot-honour) and [Lower quality when buffering](../settings.md#lower-quality-when-buffering)). This page covers episode completion, quality and seek controls, lifecycle recovery, and saved playback defaults.

## Manual episode completion

Issue #12's bounded first slice offers Play next and Back only after a natural episode EOF.
PlaybackController retires the transport and waits for an in-flight progress request before sending STOP with a newer sequence and the last observed source position.
The adopted plan's effective file and source timeline identify the completed edition; unknown or different durations and early EOF never manufacture a full-duration sample.
At an episode's natural end the STOP is sent once, as Apple's `PlaybackSessionBridge.stopSession` sends it: a failure that may clear (a timeout, no answer, a rate limit or a server error) is left to the background and the advance goes on, so a slow server no longer keeps a known next episode from starting (#709). The background resend repeats the identical installation ID, stop ID, sequence, position and body, waits at least its first retry delay and honors Retry-After, so the old session still ends once the server answers; otherwise the server times it out. A refusal or an expired session still ends the advance.
An expired session during final progress or STOP reporting offers Back without an unusable Retry.
Fresh watch-read failures remain retryable after STOP is confirmed.
EOF during a pending track or quality change is retained when a refusal keeps the original transport; adopting a replacement discards that predecessor's EOF.
Authorization, installation and administrator refusals cannot create a successor session.

A valid STOP receipt, or a STOP left to the background after a failure that may clear, lets the advance go on; neither is proof that progress or watch-history side effects succeeded.
Fresh watch reads follow the receipt and precede any next offer.
The panel says End of playback even when fresh played state remains false or the contract's optional progress is absent.
Its words are Apple TV's (`PlayerView`, under the `upNext.*` keys), in every shipped language. While the session ends and the next item is worked out it reads Playing Next (Up Next at Random in a Shuffle) over Finding the next episode (Picking at random); Apple has no separate stage for ending the session, so the TV's old Ending playback… is gone. With nothing to follow it reads Finished over End of playback and No next episode is available. (in a Shuffle, Nothing else in this shuffle can play.). A failed lookup reads Couldn't load the next episode. Go back to choose something else., Apple's wording for a card with no On Deck row. A failure while the session ends (the final progress or STOP), before anything is looked up, reads Playback progress could not be recorded. (Apple's `errors.apple.playback.invalidSample`) instead.
No separate mark-watched write is sent.
Failed or malformed reads show Retry and Back rather than reporting exhaustion or a saved state.

The resolver checks current identity and the effective version's explicit multi-episode range, then sorts returned numeric season and episode fields.
Successful empty or unreadable permitted media are skipped; failed requests are errors.
Regular sequences skip specials, while explicitly playing specials continues only within that season.
The next title needs both an authorized episode row and a fresh permitted readable version.
Watched episodes are still eligible; confirmed partial progress may resume, otherwise START receives explicit numeric zero.
Play next uses the existing planner with a fresh attempt and no previous file's audio or edition selection.
Movies and exhausted episode sequences open Up Next with On Deck offers (requiring manual selection) and a focusable Back action.

Back, backgrounding, teardown and authority changes cancel continuation and fence late answers.
Remote focus stays reachable during finalization, resolution, failure and exhaustion; focus movement sends no reads.
Pre-end Up Next prompts, Show Next Up timing, 10 s autoplay countdowns, and On Deck behavior are documented in [Series autoplay](series-autoplay.md).

The source contracts are pinned to [server cc85149](https://github.com/Artic0din/silo-server/tree/cc8514943289045e7b9f7ac8d36d4968bfe93926), including WatchDetail, WatchFileVersion, Season, Episode and PlaybackMutation in OpenAPI and the stop finalization handler.
Behavioral tests use synthetic server data and fake AVPlay; see [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for signed-package and physical-TV gates ([#12](https://github.com/Artic0din/Auger-Tizen/issues/12)).

## Quality and seek controls

Playback Settings also offers separate video rewind and fast-forward intervals.
The profile-only remote keys are `player.video_skip_back_seconds` and `player.video_skip_forward_seconds`, introduced in settings manifest revision 9.
Their numeric choices are 5, 10, 15, 30, 45, 60 and 90 seconds, with inherited defaults of 10 and 30 seconds.
The controls show each interval as Apple does (`player.seekInterval.choice`: "10 seconds", "10 Sekunden", Arabic digits in Arabic) instead of the manifest's English label, with the catalog's help lines (`settings.skipIntervals.footerVideo` for Video, Android TV's key, because Apple TV's `footerVideoAppleTv` names the Siri Remote and a Samsung remote has arrow keys; `footerAudiobook` for Audiobooks); they display explicit and effective values. A skip picker lists only the seven choices, with no row to clear a stored one, as Apple TV's does (`TVPlaybackSettingsView`, silo-apple 648091a7, line 556); the other pickers keep their reset row, which deletes the key.
A skip picker opens on the stored choice, or on the first when that choice is not offered, as `TVSettingsPickerSheet.focusSelection` does (silo-apple 648091a7, `TVSettingsComponents.swift` lines 837-839).
The audiobook pair, `player.audiobook_skip_back_seconds` and `player.audiobook_skip_forward_seconds`, has the same shape and is listed under Audiobooks beneath the video pair, as on Apple TV. The audiobook player is not built yet, so nothing reads these values at playback.
They reuse Settings' pre-write read, post-write confirmation, uncertain-answer reconciliation, busy lock, Retry-After and profile authority fences.

The controller discovers the supported pair before each start and carries it in PlaybackView to buttons, repeated Left/Right previews and dedicated Rewind/Fast Forward keys.
Settings capability revision remains opaque; numeric manifest, definition and option revisions negotiate support.
Effective reads batch only when advertised; otherwise supported settings use single-key reads, including quality and cap through the unchanged playback-default decoder.
Servers without seek support retain the existing 10/10 behavior and labels.
A network or malformed supported seek read blocks startup with a visible Retry; it never fabricates saved defaults.
The approved Tizen adoption applies only to these two known video keys despite advisory platform metadata omitting Tizen; other platform filters and client identity are unchanged.

The existing audio/subtitle menu includes Quality only when the current server plan offers an alternative.
Auto is followed by server entries in server order, preferring `display_name` and sending the exact `label` as `quality_preference`.
Legacy Original entries are excluded.
The menu uses the current plan rather than a hardcoded resolution or bitrate ladder.

Before every start, the player reads effective `playback.preferred_quality` and `playback.max_bitrate_kbps` with the captured profile and stable device headers.
Missing settings use the contract defaults Auto and no cap; a failed or malformed settings read fails startup visibly.
Legacy saved Original maps to Auto.
These defaults are captured for the attempt, and an in-player choice is session-only.
Successful quality changes replace its requested preference and current cap; track changes, seeking and route recovery repeat both.
Fixed choices use the server rung's positive `bitrate_kbps`, and source-preserving rungs omit the cap.
Auto restores the saved bandwidth cap captured at startup.
Playback Settings edits supported device overrides or profile-only defaults through the existing Settings owner described below.

Auto remains selected when the session requests Auto, regardless of the delivered rung.
For a fixed preference, `plan_active_quality_v1` makes only a returned, offered `active_quality` authoritative.
With that feature and no active quality, nothing is highlighted.
Without it, only a matching explicit in-player pick is highlighted.
Resolution and bitrate are never used to guess delivery.

A quality change uses the existing serialized replan path with operation `quality_change`, source position, effective-file tracks, and unchanged opaque plan identities.
It clears route failure exclusions, keeps the playback attempt ID and gives the logical change one request ID, reused with an identical body on bounded retries.
Subtitle Off stays omitted and returned effective-file selections are adopted without remapping ordinals.
The latest local pause intent during the pending request is applied to replacement playback.
The existing physical seek barrier, progress reporting, visibility suspension and authority cancellation still own transport lifetime.

Only a confirmed `adaptation_unavailable` keeps the predecessor transport and preference.
Unanswered transient quality or track changes join bounded connection recovery after their identical-request retries are exhausted.
Invalid successes and generic quality-replan 409 conflicts still end the attempt.
A playable replacement retires the predecessor on the server; load failure recovers against the replacement identity or ends playback, never reopening the predecessor.

Contracts were checked against [server cc85149](https://github.com/Silo-Server/silo-server/tree/cc8514943289045e7b9f7ac8d36d4968bfe93926) and [canonical Apple quality rules](https://github.com/Silo-Server/silo-apple/blob/148d5d70f8b8ce982a827fead2b16f8de40f0f57/iosApp/iosApp/Screens/Player/ApplePlaybackQuality.swift).

### Lifecycle and connection recovery

Visibility hide suspends the active AVPlay pipeline and cancels its timers.
Show rechecks capabilities, installation, profile authority and media authorization before restoring playback.
Preparing transports cannot play while that foreground check is pending; obsolete restore callbacks cannot bypass a newer check.
Play and pause during that check keep the latest intent and do not call AVPlay or show transport controls until restoration finishes.
Visibility changes keep an in-flight recovery request serialized; its accepted plan waits for foreground validation before opening a transport.
An initial capability read establishes authority before foreground restoration compares installation identities.
Hiding during a local seek defers native suspension until that seek settles, retaining its actual resulting position.
Retiring a pipeline clears its suspension state; a deferred replacement opens with a new listener, and old native restore callbacks cannot mark it started.
Hidden startup and reconnect deadlines are rearmed from the clock instead of relying on background timers.
An already prepared READY pipeline resumes with play or pause, because AVPlay restoreAsync is not valid in READY.
The explicit controller background() action remains a terminal stop; visibility events use suspend/restore instead.
A cold launch has no in-memory pipeline and uses the normal fresh server resume path.

After an established transport loses its connection, the controller keeps source position, current tracks and playing or paused intent.
Recovery sends a no-op track_change rather than reporting a failed route.
An unanswered recovery replan retains its request identity and identical body until a definitive answer, allowing the server to replay an accepted decision.
Temporary login-refresh unavailability remains inside the recovery budget and does not force re-login.
The twelve waits are 1, 2, 4, 8 and then eight 15-second waits: 135 seconds of waiting, excluding request time.
Longer server Retry-After cooldowns extend those waits and remain in force across visibility changes and manual Retry.
A loss within 30 seconds of replacement playback carries the existing budget; an API response alone does not establish stable playback.
A replacement that fails before playing follows ordinary route recovery; if that recovery cannot reach the server, it rejoins the same reconnect budget.
Exhaustion exposes Retry and Back instead of starting another automatic cycle.
An app return preserves that exhausted error until explicit Retry, including exhaustion during foreground validation.

A missing session may create one replacement START at the saved position and tracks.
Its unanswered retries retain the same body and attempt identity.
When a stale plan requires a fresh session, accepting its replacement also sends a sequenced STOP for the possibly live predecessor.
A 404 proves the predecessor is already gone and needs no cleanup STOP.
A missing session during an active reconnect schedules one replacement when no recovery request is still in flight.
Recovery classifies each answer by its dispatched operation, even when a concurrent progress answer changes the pending recovery step.
Progress answers belong to their dispatched session and cannot end or restart a successor; predecessor teardown still waits for its own pending progress.
User replan answers are also fenced to their dispatched transport and session, and adopting a replacement clears interrupted seek state.
If its playable answer arrives after Back or teardown, cleanup stops that new session with its own sequence and STOP identity.
An admin-ended session, changed installation or revoked authority is terminal and does not silently create a replacement.
Back, teardown, another playback and authority loss fence late recovery work.
Hiding during next-episode resolution still cancels continuation; recovery does not autoplay a successor.

Native fake-server and desktop tests establish the state, identity, timing and cancellation rules above.
Actual Samsung suspend/restore, audible recovery, decoded frames, live-server restart behavior and the cross-device acceptance matrix remain unverified.
The existing Skyline tokens and Chrome 108-compatible list layout are reused.

## Lower quality when buffering

Playback reads `playback.buffering_quality_mode` (`never`, `ask`, or `always`, defaulting to `always`) before start and runs Apple's `BufferingQualityController` (`src/player/bufferingQuality.ts`, `bufferingSignals.ts`, `bufferingBridge.ts`).
For the Settings rows, learned-limit display, and Reset action, see [docs/settings.md](../settings.md#lower-quality-when-buffering).

- A stall is AVPlay's `onbufferingstart` to `onbufferingcomplete` while the viewer wants to play (excluding initial startup before first frame, seek buffering until playhead advances, source reloads, pauses, backgrounding, and connection/media errors). AVPlay exposes no buffer-ahead or byte counters, so renderer-wait, upstream-silence, and `observed_throughput_kbps` inputs are unavailable.
- Thresholds match Apple: two 1 s stalls within 2 minutes, or one 6 s stall, after 10 s of startup grace. In `always` on Auto, the player sends `quality_change` with `quality_preference: "auto"`, `bandwidth_estimate_kbps` at 70% of delivered bitrate, and `bandwidth_estimate_source: "observed_rebuffer"` when the server advertises `buffering_quality_v1`. A viewer-picked quality always prompts first (unless `never`) and steps down to the next rung.
- Restore quality sends Auto with `learned_limit: "clear"`; `never` sends `learned_limit: "ignore"` on start and replans. Other replans repeat the active estimate while a lowering stands.
- The prompt ("Playback keeps buffering" / "Try a lower quality to keep watching") runs a 15 s countdown while visible; undo ("Quality lowered to stop buffering" / Restore quality) and notices show for 5 s. Skip pills and Up Next pause the buffering pill timer. Select acts when controls are hidden, Left/Right switch buttons, and Back keeps the current quality.
- A refused lowering keeps playing with no error; a lost or unusable answer reconnects to adopt the server's active plan. A queued lowering drops if the plan, attempt, or viewer pick changes first (Restore quality still sends). `plan_summary` events are not built.

## Saved Playback settings

Profile menu > Settings > Playback manages Resolution, Maximum Bitrate, Audio Language, Skip Back/Forward, Lower quality when buffering, Connection speed, HDR, Episodes controls, Spoilers, and Reset; see [docs/settings.md](../settings.md) for the complete row list, styling, and AVPlay exclusions.
Hidden Libraries restores via Settings > Server > Restore All Libraries (writing `[]` and refreshing Browse on exit).

- Explicit profile defaults, this TV's `profile_device` overrides, and effective values remain separate (`Audio Language`, `Resolution`, and `Maximum Bitrate` use `profile_device` when advertised; seek intervals remain profile-only).
- `No limit` writes JSON `null`; `Use Profile Setting` deletes only the device row; `Use inherited default` deletes only the profile row. Deprecated `Original` and unfamiliar stored values display without rewriting on read.
- Writes serialize without automatic replay, reconcile explicit and effective state on Retry after uncertain answers, and cancel cleanly on Authority changes.
- Reference: [silo-apple `TVPlaybackSettingsView.swift`](https://github.com/Silo-Server/silo-apple/blob/9723df007baa8e933f5615cc14b13e99a6ee1ea1/iosApp/iosApp/tvOS/Screens/Settings/TVPlaybackSettingsView.swift), [src/contracts/v2/README.md](../../src/contracts/v2/README.md), and [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md).
