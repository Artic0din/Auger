// Fixed display phrases for validated enum values. Titles and bodies both read these.

import { isPublishedCode } from "./contract.js";

export const STAGE_LABELS = {
  capabilities: "Playback capabilities",
  settings: "Playback settings",
  start: "Playback start request",
  subtitles: "Subtitle preferences",
  media_token: "Media token",
  playlist_check: "HLS playlist check",
  avplay_open: "AVPlay open",
  avplay_prepare: "AVPlay prepare",
  avplay_seek: "AVPlay start seek",
  avplay_play: "AVPlay play",
  playing: "During playback",
  recovery: "Recovery replan",
  reconnect: "Reconnect",
  track_change: "Track change",
  quality_change: "Quality change",
  seek_reanchor: "Seek re-anchor",
  progress: "Progress report",
};

export const OPERATION_LABELS = {
  playback_capabilities: "Playback capabilities",
  playback_defaults: "Playback defaults",
  start_playback: "Start playback",
  subtitle_preferences: "Subtitle preferences",
  media_token: "Media token",
  hls_playlist: "HLS playlist",
  avplay: "AVPlay",
  replan_playback: "Replan playback",
  progress_report: "Progress report",
};

export const OUTCOME_LABELS = {
  failed: "Failed",
  refused: "Refused (expected refusal)",
  interrupted: "Interrupted",
  recovered: "Recovered",
};

export const RECOVERY_LABELS = { none: "None attempted", recovered: "Recovered", attempted: "Attempted, not recovered", exhausted: "Exhausted" };

export const DELIVERY_LABELS = {
  original_http: "Direct Play (original HTTP)",
  server_remux_progressive: "Server Remux",
  server_remux_hls: "Server Remux HLS",
  server_transcode_hls: "Server Transcode HLS",
  unknown: "Unknown delivery",
};

export const SCREEN_LABELS = {
  home: "Home",
  details: "Details",
  library: "Library",
  search: "Search",
  person: "Person",
  calendar: "Calendar",
  requests: "Requests",
  audiobook: "Audiobook",
  personal: "Personal",
  watchParty: "Watch Party",
  for_you: "For You",
};

export const CATEGORY_PROBLEM = {
  playback: "a playback problem",
  audio_subtitles: "an audio or subtitle problem",
  buffering: "a buffering or quality problem",
  app_ui: "a navigation problem",
};

const CODE_PHRASES = {
  session_expired: "session expired",
  session_missing: "playback session missing",
  adaptation_unavailable: "no playable version",
  version_unavailable: "selected version unavailable",
  subtitle_selection_unavailable: "selected subtitles unavailable",
  routes_exhausted: "every route failed",
  no_response: "no response",
  no_answer: "no server answer",
  network_unreachable: "network unreachable",
  hls_playlist_unreadable: "HLS playlist unreadable",
  connection_lost: "connection lost",
  avplay_prepare_failed: "AVPlay prepare failed",
  avplay_open_failed: "AVPlay open failed",
  avplay_play_failed: "AVPlay play failed",
  avplay_resume_seek_failed: "AVPlay resume seek failed",
  avplay_playback_error: "AVPlay playback error",
  avplay_startup_timeout: "AVPlay start timed out",
  startup_timeout: "start timed out",
  terminal_error: "server refused playback",
  client_upgrade_required: "Auger update required",
  server_error: "server error",
  installation_changed: "server installation changed",
  revoked: "device access revoked",
  backgrounded: "app backgrounded",
};

/** Phrase for a published code; undefined for codes the relay groups by but does not print. */
export function codePhrase(code) {
  if (!isPublishedCode(code)) return undefined;
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return `HTTP ${http[1]}`;
  return CODE_PHRASES[code] ?? code;
}

/** Table value for a code: published verbatim, otherwise named as unlisted without its text. */
export function codeCell(code) {
  if (code === undefined) return undefined;
  return isPublishedCode(code) ? code : "Unlisted code";
}
