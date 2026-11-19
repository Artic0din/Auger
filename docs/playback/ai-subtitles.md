# AI subtitles

Issue [#65](https://github.com/Artic0din/silo-tizen/issues/65) stacks on `feat/64-subtitle-appearance` at `5dbb374720f9b1ceb6e9747b8377514f2c25fc0b`, as approved, because completed text tracks require that renderer.
No server changes are required.

The native OpenAPI pinned at `cc8514943289045e7b9f7ac8d36d4968bfe93926` exposes these profile-scoped operations:

| Operation | Path | Behavior |
| --- | --- | --- |
| `getSubtitleAIStatus` | `GET /subtitles/ai/status` | Require `state=available`, `allowed` and the individual translation/transcription flag. |
| `getSubtitleAIQuota` | `GET /subtitles/ai/quota` | Show remaining ASR quota and its period; block transcription when exhausted or unknown. |
| `createSubtitleAIJob` | `POST /subtitles/ai/translate` | Send once with file, kind, source index/language, target language and source position. |
| `getSubtitleAIJob` | `GET /subtitles/ai/jobs/{job_id}` | Poll pending/running jobs every two seconds; verify job, file, kind, source index and language identity. |

The Subtitles tab has one OPTIONS row, AI Subtitles…, that opens a language menu ([#522](https://github.com/Artic0din/silo-tizen/issues/522), `SubtitleTranslateMenu` in silo-apple `main`).
The viewer picks a language and the player picks the method, as Apple's `route(to:)` does:

1. **Translate** an existing text subtitle in another language (or with none known): an English one first, then the shown, then the first. The track's server index (`combined_index`) is `source_index`.
2. Otherwise **transcribe** the spoken audio: the selected audio track, else the default, else the first (`source_index` is its server ordinal, `-1` for the server's default when none is known). It is a plain `transcribe` when the language is the spoken one, else `transcribe_translate`.
3. With translation off and the spoken language unknown, a Spoken language row runs a plain transcription in whatever language the server detects.

The row shows only when the server offers the capability and the file has something to run: a text track with translation on, or audio with transcription on.
Languages come from the settings contract's `playback_subtitle_languages` option set; the profile's preferred language and the spoken language lead as Suggested.
A language the server cannot serve now (no quota, or translation off for a language that is not the spoken one) is dimmed and does nothing.
The quota line shows only while some language relies on transcription, as Apple's does. When the balance cannot be read, SubtitleAI sends no transcription, so those rows are dimmed and the line reads Transcription quota unavailable.
The menu shows when at least one row is left: a catalog that is empty or failed to load leaves the Spoken language row (translation off, spoken language unknown), else no AI Subtitles… row.
A running job replaces the languages with its title, progress, the server's message and Cancel (`cancelSubtitleAIJob`, best effort). Each start and cancel opens a new generation, and an answer from an earlier one (a poll or a create that was in flight) is dropped; a cancel pressed before the server names the job stops it by the id the server then gives, and until that create answers the file is held (the panel shows the held state with Discard held request) so a second billable request cannot go out, as Apple's `SiloAI` holds an unresolved creation; an answer or a definite refusal lifts the hold, an unknown outcome keeps it, and a Discard forfeits it, so that create's late answer cannot take the hold back from a newer request. Unlike Apple, which holds only an identical request, the hold covers every request for the file. A failure shows its message with Dismiss, and a held request adds Discard held request. Cancel, Dismiss and Discard keep working while a track change is pending, because they act on the job and Apple does not disable them. A finished job returns to the tracks. A job the server reports completed with no subtitle result shows "AI job completed without a subtitle result." with Dismiss instead; Apple closes the menu with no message there, which would leave the viewer with neither a subtitle nor a reason.
Text translation does not spend the ASR quota; transcription requires a known balance.
No live delivery is requested: a completed stored track becomes selectable when ready.
An unknown create outcome is not resent, including on repeated presses in the same playback attempt.
Lost polling or an unknown accepted job state also blocks new creation for that attempt, because the original work may still spend quota.
Provider errors, quota refusals, read failures and unknown states are shown in the subtitles panel without issuing player stop commands.
Leaving the attempt or losing profile authority cancels polling; it does not cancel work already accepted by the server.

Completion alone never replans or changes the selected track.
When the viewer selects an AI result, the player first uses any matching `sync_key=stored-{result_subtitle_id}` already in the plan inventory.
Otherwise it requests a fresh plan retaining the current tracks, then selects only the server-returned track with that sync identity.
The pinned `SubtitleInventoryItemV3` publishes `sync_key`; `internal/playback/subtitle_inventory_v3.go` sets it from the stored subtitle ID.
`listStoredSubtitles` can omit rows with unrecognized provider languages, so list positions are deliberately never converted into playback ordinals.
If the refreshed plan does not contain the result, playback continues with a visible reason.
Selection uses the existing track-change replans and may briefly reopen AVPlay, as other track changes do.
AI-translated and AI-transcribed labels remain on matching tracks for the playback attempt.

Apple reference: `APIv2Client+SubtitleAI.swift`, `APIv2SubtitleAIModels.swift`, `APIv2SubtitleModels.swift` and `SubtitleAIController.swift` at `1a7cceeaf3b2bfc4f889c00487d19b2c6f843940` confirm independent gates, ASR quota, non-retryable creation, opaque job identity and the stored-list ordinal limitation.
Native tests cover capability gates, quota exhaustion, one-shot creation, identity mismatches, polling, failures, authority cancellation and fresh inventory selection.
Desktop tests cover the AI Subtitles… row, language rows and hints, dimmed rows, the quota line, a running and a failed job, Cancel, Dismiss and Discard, and result selection.
The TV draws the menu in the Subtitles pane, as it does Search, not in Apple's floating dialog, and has no live player-surface presentation while a job runs (the menu shows its progress instead).
Live provider quota consumption, actual generated output, Samsung compositing, signed packaging and hardware remain unproven.
