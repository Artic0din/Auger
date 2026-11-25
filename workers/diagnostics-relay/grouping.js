// Legacy-marker equivalence for incidents, and evidence checks against older issues' embedded state.
// Pure functions over validated incidents and decoded states.

import { fnv1aHex } from "./hash.js";

// Server reasons installed clients also raise locally for several operations; their legacy marker cannot name one.
const MULTI_ORIGIN_REASONS = new Set(["version_unavailable", "subtitle_selection_unavailable"]);
const AVPLAY_CALL_STAGE = { open: "avplay_open", prepareAsync: "avplay_prepare", play: "avplay_play" };

/**
 * The single legacy (`play.e`) signature this incident is unambiguously equivalent to, or undefined.
 * Generic legacy signatures (bare kinds, unstaged PLAYER_ERROR codes, app errors without a screen) never map.
 */
export function legacyEquivalent(inc) {
  if (inc.out !== "failed" && inc.out !== "refused") return undefined;
  if (
    inc.kind === "terminal" &&
    inc.dec === "adaptation_unavailable" &&
    inc.op === "start_playback" &&
    inc.stage === "start" &&
    typeof inc.fc === "string" &&
    /^[a-z0-9_]{1,48}$/.test(inc.fc) &&
    !MULTI_ORIGIN_REASONS.has(inc.fc)
  ) {
    return { family: "terminal", signature: `terminal: ${inc.fc}` };
  }
  const last = inc.av?.l;
  if (inc.kind === "playback_failed" && inc.out === "failed" && last !== undefined && (inc.av.f ?? last) === last) {
    const [call, name] = last.split(":");
    if (name !== undefined && AVPLAY_CALL_STAGE[call] === inc.stage) return { family: "playback_failed", signature: `playback_failed:${last}` };
  }
  return undefined;
}

/**
 * Whether an older issue's own recorded evidence pins it to the same failure as `equivalent`.
 * Missing or undecodable evidence is ambiguous, so the current incident files separately.
 */
export function legacyEvidenceMatches(state, equivalent) {
  if (state === undefined || state.e === undefined) return false;
  const log = Array.isArray(state.log) ? state.log.filter((line) => typeof line === "string") : [];
  if (equivalent.family === "terminal") {
    if (state.e !== equivalent.signature || state.hadPlanEvent === true || state.m || state.d) return false;
    // A plan, AVPlay or rebuffer line means a stream was already running, so the refusal may have come from a replan.
    return !log.some((line) => /^\[playback\] (?:plan|avplay|rebuffer)\b/.test(line));
  }
  const code = equivalent.signature.slice("playback_failed:".length);
  if (state.e !== "playback_failed" || state.av !== code) return false;
  const avplayCodes = log.map((line) => /^\[playback\] avplay (\S+)/.exec(line)?.[1]).filter(Boolean);
  return avplayCodes.every((value) => value === code) && !log.some((line) => line.startsWith("[playback] rebuffer"));
}

/** Legacy signature digest from a stored state; issues this relay files carry it as `sg`. */
export function legacySignatureDigest(state) {
  if (state === undefined) return undefined;
  if (typeof state.sg === "string") return state.sg;
  const playErr = state.e === undefined ? undefined : state.av && state.e === "playback_failed" ? `${state.e}:${state.av}` : state.e;
  const sig = state.err ? `app:${state.err}` : playErr ?? [state.cat ?? "", state.m ?? "", state.d ?? "", state.src ?? "", state.sub ?? ""].join("|");
  return fnv1aHex(sig);
}
