// Deterministic plain-language issue titles from the validated category, first failed stage, outcome and code.
// Unknown or unlisted values never reach a title; missing evidence falls back to a category phrase.

import { CATEGORY_PROBLEM, codePhrase, SCREEN_LABELS } from "./labels.js";

export const TITLE_MAX = 140;

const cap = (text) => (text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1).trimEnd()}…`);

const STAGE_PHRASES = {
  capabilities: "Playback capability check failed",
  settings: "Playback settings could not be read",
  start: "Playback start failed",
  subtitles: "Subtitle preferences could not be read before playback",
  media_token: "Playback media token request failed",
  playlist_check: "HLS playlist check failed before playback",
  avplay_open: "Player could not open the stream",
  avplay_prepare: "Player could not prepare the stream",
  avplay_seek: "Player could not seek to the start position",
  avplay_play: "Player could not begin playback",
  playing: "Playback failed while playing",
  recovery: "Playback recovery failed",
  reconnect: "Playback reconnect failed",
  track_change: "Track change failed during playback",
  quality_change: "Quality change failed during playback",
  seek_reanchor: "Seek failed during playback",
  progress: "Playback progress report failed",
};

const INTERRUPTED = {
  backgrounded: "Playback stopped when Auger was backgrounded",
  revoked: "Playback stopped: device access revoked",
  installation_changed: "Playback stopped: server installation changed",
};

const REFUSED_BY_KIND = {
  unavailable: "Native playback unavailable on this server",
  settings: "Playback settings unavailable",
};

function incidentBase(inc) {
  if (inc.out === "interrupted") return INTERRUPTED[inc.kind] ?? "Playback was interrupted";
  if (inc.fc === "client_upgrade_required") return "Playback requires an Auger update";
  if (inc.out === "refused" && REFUSED_BY_KIND[inc.kind]) return REFUSED_BY_KIND[inc.kind];
  if (inc.stage === "start" && (inc.out === "refused" || inc.dec === "adaptation_unavailable")) return "Playback start refused";
  if (inc.cat === "buffering" && inc.stage === "quality_change") return "Playback stalled after a quality step-down";
  const phrase = inc.stage === undefined ? undefined : STAGE_PHRASES[inc.stage];
  if (phrase === undefined) return undefined;
  return inc.out === "refused" ? `${phrase} (refused)` : phrase;
}

/** Title for a validated record that carries an incident. */
export function incidentTitle(inc) {
  const base = incidentBase(inc);
  if (base === undefined) return inc.cat === "buffering" ? "Buffering or quality problem reported" : "Playback problem reported";
  if (inc.out === "interrupted" || base === "Playback requires an Auger update") return base;
  const phrase = inc.code === undefined ? undefined : codePhrase(inc.code);
  const http = inc.http !== undefined && !(inc.code ?? "").startsWith("http_") ? ` (HTTP ${inc.http})` : "";
  const recovered = inc.out === "recovered" ? ", then recovered" : "";
  return cap(`${base}${phrase === undefined ? "" : `: ${phrase}`}${http}${recovered}`);
}

function legacyCategoryTitle(record) {
  if (record.cat !== undefined && record.auto !== true) {
    return `Viewer reported ${CATEGORY_PROBLEM[record.cat]}${record.screen === undefined ? "" : ` on ${SCREEN_LABELS[record.screen]}`}`;
  }
  return record.cat === "playback" || record.play !== undefined ? "Playback problem reported" : "TV diagnostic report received";
}

/** Title for a record without an incident: older clients and user-observed symptoms. */
export function legacyTitle(record) {
  if (record.err) return cap(`Auger raised an uncaught ${record.err}`);
  const e = record.play?.e;
  if (e !== undefined) {
    const [kind, detail] = e.split(": ");
    switch (kind) {
      case "terminal": {
        const phrase = detail === undefined ? undefined : codePhrase(detail);
        return cap(phrase === undefined ? "Playback refused by the server" : `Playback refused by the server: ${phrase}`);
      }
      case "playback_failed":
        return cap(`Playback failed on every offered route${record.play.av ? `: ${record.play.av}` : ""}`);
      case "session_expired": return "Playback session expired";
      case "network": return "Playback lost its network connection";
      case "server":
        if (detail?.startsWith("HTTP ")) return `Playback server error (${detail})`;
        return detail === "app_update_required" ? "Playback requires an Auger update" : "Playback server error";
      case "unavailable": return "Native playback unavailable on this server";
      case "installation_changed": return INTERRUPTED.installation_changed;
      case "revoked": return INTERRUPTED.revoked;
      case "backgrounded": return INTERRUPTED.backgrounded;
      default: break;
    }
  }
  return legacyCategoryTitle(record);
}
