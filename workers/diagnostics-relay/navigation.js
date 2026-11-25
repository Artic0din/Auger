// App / Navigation evidence (`nav`, nv 1) from src/diagnosticsNavigation.ts: validation, grouping, rows and titles.
// Every published value is an allowlisted word from shared/diagnostics-navigation.js or a bounded integer.
// An invalid `nav` is dropped, never rejected, so the rest of the report still files.

import {
  NAV_ACTIONS,
  NAV_API_OPERATIONS,
  NAV_MAX_REPEAT,
  NAV_MAX_STEPS,
  NAV_OUTCOMES,
  NAV_SCREENS,
  NAV_ZONES,
} from "../../shared/diagnostics-navigation.js";
import { isPlainObject } from "./contract.js";
import { SCREEN_LABELS } from "./labels.js";

const int = (raw, min, max) => (typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max ? raw : undefined);
const MAX_MS = 60_000;

/** `screen:zone:action:outcome[:target][*count]`, rebuilt from validated parts; anything else is dropped. */
export function navigationStep(raw) {
  if (typeof raw !== "string" || raw.length > 96) return undefined;
  const star = raw.indexOf("*");
  const count = star === -1 ? 1 : /^\d{1,2}$/.test(raw.slice(star + 1)) ? Number(raw.slice(star + 1)) : 0;
  if (count < 1 || count > NAV_MAX_REPEAT) return undefined;
  const parts = (star === -1 ? raw : raw.slice(0, star)).split(":");
  const [screen, zone, action, outcome, target] = parts;
  if (parts.length !== (outcome === "zone" ? 5 : 4)) return undefined;
  if (!NAV_SCREENS.includes(screen) || !NAV_ZONES.includes(zone) || !NAV_ACTIONS.includes(action) || !NAV_OUTCOMES.includes(outcome)) return undefined;
  if (outcome === "zone" && !NAV_ZONES.includes(target)) return undefined;
  return [screen, zone, action, outcome, ...(outcome === "zone" ? [target] : [])].join(":") + (count > 1 ? `*${count}` : "");
}

function sample(raw, fields) {
  if (raw === "off" || raw === "unavailable") return raw;
  if (!isPlainObject(raw)) return undefined;
  const value = {};
  for (const [key, [min, max]] of Object.entries(fields)) {
    const checked = int(raw[key], min, max);
    if (checked !== undefined) value[key] = checked;
  }
  return value.n === undefined ? undefined : value;
}

/** The validated `nav` record, or undefined when absent or not version 1. */
export function validateNavigation(raw) {
  if (!isPlainObject(raw) || raw.nv !== 1) return undefined;
  const nav = { nv: 1, sc: NAV_SCREENS.includes(raw.sc) ? raw.sc : "unknown" };
  nav.st = Array.isArray(raw.st) ? raw.st.slice(-NAV_MAX_STEPS).map(navigationStep).filter((step) => step !== undefined) : [];
  const lt = sample(raw.lt, { n: [0, 99_999], w: [0, MAX_MS] });
  if (lt !== undefined) nav.lt = lt;
  const fr = sample(raw.fr, { n: [0, 64], p95: [0, MAX_MS], w: [0, MAX_MS] });
  if (fr !== undefined) nav.fr = fr;
  if (raw.dom === "unavailable") nav.dom = raw.dom;
  else if (isPlainObject(raw.dom) && int(raw.dom.n, 0, 1_000_000) !== undefined && int(raw.dom.img, 0, 100_000) !== undefined) nav.dom = { n: raw.dom.n, img: raw.dom.img };
  const cpu = raw.cpu === "unavailable" ? raw.cpu : int(raw.cpu, 1, 64);
  if (cpu !== undefined) nav.cpu = cpu;
  if (raw.rm === "unavailable" || typeof raw.rm === "boolean") nav.rm = raw.rm;
  if (raw.api === "none") nav.api = raw.api;
  else if (isPlainObject(raw.api) && NAV_API_OPERATIONS.includes(raw.api.op) && int(raw.api.ms, 0, MAX_MS) !== undefined) nav.api = { op: raw.api.op, ms: raw.api.ms };
  return nav;
}

/** Group key parts for an app error with a known screen: category, screen and error name; never counters or source. */
export function navigationErrorKey(record) {
  return record.err !== undefined && record.nav !== undefined && record.nav.sc !== "unknown" ? ["app_ui", record.nav.sc, record.err] : undefined;
}

const SCREEN_NAMES = { ...SCREEN_LABELS, settings: "Settings", unknown: "Unknown screen" };
const ACTION_NAMES = {
  up: "Up", down: "Down", left: "Left", right: "Right", enter: "Select", back: "Back", play_pause: "Play/Pause",
  play: "Play", pause: "Pause", stop: "Stop", rewind: "Rewind", fast_forward: "Fast forward",
};
const OUTCOME_PHRASES = {
  moved: "moved within the zone",
  stayed: "focus stayed (no move)",
  lost: "focus lost",
  restored: "focus restored",
  pressed: "pressed",
};

function stepLine(step, index) {
  const [body, count] = step.split("*");
  const [screen, zone, action, outcome, target] = body.split(":");
  const result = outcome === "zone" ? `moved to zone ${target}` : OUTCOME_PHRASES[outcome];
  return `${index + 1}. ${SCREEN_NAMES[screen]} · zone ${zone} · ${ACTION_NAMES[action]} · ${result}${count === undefined ? "" : ` (×${count})`}`;
}

const UNREPORTED = "Not reported";

function sampleCell(value, observed) {
  if (value === undefined) return UNREPORTED;
  if (value === "off") return "Sampling off";
  if (value === "unavailable") return "Unavailable on this TV";
  return observed(value);
}

function navigationRows(nav) {
  return [
    ["Screen at capture", SCREEN_NAMES[nav.sc]],
    ["Long tasks over 50 ms (last 60 s)", sampleCell(nav.lt, (lt) => (lt.n === 0 ? "0 observed" : `${lt.n}${lt.w === undefined ? "" : ` (worst ${lt.w} ms)`}`))],
    ["D-pad input to next frame (estimate)", sampleCell(nav.fr, (fr) => {
      if (fr.n === 0) return "0 samples";
      const parts = [fr.p95 === undefined ? undefined : `p95 ${fr.p95} ms`, fr.w === undefined ? undefined : `worst ${fr.w} ms`].filter(Boolean);
      return `${parts.length === 0 ? "" : `${parts.join(", ")} `}(${fr.n} samples)`;
    })],
    ["DOM nodes / images", nav.dom === undefined ? UNREPORTED : nav.dom === "unavailable" ? "Unavailable on this TV" : `${nav.dom.n} / ${nav.dom.img}`],
    ["CPU cores", nav.cpu === undefined ? UNREPORTED : nav.cpu === "unavailable" ? "Unavailable on this TV" : String(nav.cpu)],
    ["Reduced motion", nav.rm === undefined ? UNREPORTED : nav.rm === "unavailable" ? "Unavailable on this TV" : nav.rm ? "Yes" : "No"],
    ["Slowest API operation (to response headers)", nav.api === undefined ? UNREPORTED : nav.api === "none" ? "None observed" : `${nav.api.op} · ${nav.api.ms} ms`],
  ];
}

/** Body section for a validated `nav`; `table` is the report's own table builder. */
export function navigationSection(nav, table) {
  if (nav === undefined) return [];
  const lines = ["", "### Navigation before the report", ""];
  lines.push(...(nav.st.length === 0 ? ["No remote actions recorded."] : nav.st.map(stepLine)));
  lines.push("", ...table(navigationRows(nav)));
  return lines;
}

const ERROR_PHRASES = { UncaughtError: "an uncaught error", UnhandledRejection: "an unhandled promise rejection" };

/** "Home navigation raised an uncaught TypeError", or undefined when the error's screen is unknown. */
export function navigationErrorTitle(record) {
  if (navigationErrorKey(record) === undefined) return undefined;
  return `${SCREEN_NAMES[record.nav.sc]} navigation raised ${ERROR_PHRASES[record.err] ?? `an uncaught ${record.err}`}`;
}
