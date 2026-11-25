// Issue bodies, follow-up comments and embedded metadata, built from validated records only.

import { CATEGORY_LABELS, isPublishedCode } from "./contract.js";
import { codeCell, DELIVERY_LABELS, OPERATION_LABELS, OUTCOME_LABELS, RECOVERY_LABELS, SCREEN_LABELS, STAGE_LABELS } from "./labels.js";
import { fnv1aHex, LEGACY_FIELD_CHECKS } from "./legacy.js";
import { incidentTitle, legacyTitle } from "./titles.js";

const yesNo = (value) => (value ? "Yes" : "No");
const table = (rows) => ["| Field | Value |", "| --- | --- |", ...rows.map(([label, value]) => `| ${label} | ${value} |`)];
const marker = (name, value) => `<!-- ${name}:${value} -->`;

function clockText(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function stripLogTimestamp(line) {
  return line.replace(/^\d{2}:\d{2}:\d{2}\s+/, "");
}

// ---------------------------------------------------------------------------
// Public view of an incident
// ---------------------------------------------------------------------------

/** Codes the client allowed but the relay does not print become a stable digest, so metadata stays comparable. */
const publicCode = (code) => (code === undefined || isPublishedCode(code) ? code : `unlisted_${fnv1aHex(code)}`);

function publicStep(step) {
  const [stage, result, ...rest] = step.split(":");
  const code = rest.length === 0 ? undefined : publicCode(rest.join(":"));
  return code === undefined ? `${stage}:${result}` : `${stage}:${result}:${code}`;
}

/** The incident exactly as it may appear in titles, bodies, comments and embedded state. */
export function publicIncident(inc) {
  const view = { ...inc };
  if (inc.code !== undefined) view.code = publicCode(inc.code);
  if (inc.fc !== undefined) view.fc = publicCode(inc.fc);
  if (inc.t !== undefined) view.t = inc.t.map(publicStep);
  return view;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(encoded) {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseObject(text) {
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Reads `{ version, state }` from an issue body: `inc1` for incident issues, `legacy` for unversioned states. */
export function decodeEmbeddedState(issueBody) {
  if (typeof issueBody !== "string") return undefined;
  const match = /<!--\s*auger-state:(?:(inc1):)?([A-Za-z0-9+/=]+)\s*-->/.exec(issueBody);
  if (!match?.[2]) return undefined;
  const state = parseObject(decodeBase64(match[2]));
  return state === undefined ? undefined : { version: match[1] === "inc1" ? "inc1" : "legacy", state };
}

/**
 * Comparable incident evidence. Excludes submission source, selected category, positions and runtime counters,
 * so manual and automatic submissions of one incident hash identically.
 */
export function incidentStableState(record) {
  const inc = publicIncident(record.inc);
  delete inc.src;
  if (typeof inc.pl === "object") inc.pl = { ...inc.pl, pos: undefined, at: undefined };
  if (typeof inc.req === "object") inc.req = { ...inc.req, pos: undefined };
  return {
    gk: record.groupGuard,
    sg: record.equivalent?.digest,
    fw: record.fw,
    os: record.os,
    ua: record.ua,
    srv: record.srv,
    hdr: record.hdr,
    inc,
    log: (record.log ?? []).map(stripLogTimestamp),
  };
}

/** Comparable legacy evidence: allowlisted values only, plus digests for collision checks. */
export function legacyStableState(record) {
  const play = record.play ?? {};
  return {
    sg: record.legacySignatureDigest,
    og: record.observedGuard,
    ps: record.screen,
    fw: record.fw,
    os: record.os,
    srv: record.srv,
    cat: record.cat,
    err: record.err,
    m: play.m,
    d: play.d,
    tr: play.tr,
    src: play.src,
    v: play.v,
    dr: play.dr,
    sub: play.sub,
    rb: play.rb,
    hdr: play.hdr,
    av: play.av,
    fb: play.fb,
    e: play.e,
    log: (record.log ?? []).map(stripLogTimestamp),
  };
}

export function contentHash(record) {
  return fnv1aHex(JSON.stringify(record.inc ? incidentStableState(record) : legacyStableState(record)));
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function sourceLabel(record) {
  if (record.inc?.src === "auto" || record.auto === true) return "Automatic error report";
  if (record.inc) return "Manual";
  return record.cat ? `Manual (${CATEGORY_LABELS[record.cat]})` : "Manual";
}

const stageCell = (stage) => (stage === undefined ? "Not reported" : STAGE_LABELS[stage]);
const screenRows = (record) => (record.screen === undefined ? [] : [["Screen before Settings", SCREEN_LABELS[record.screen]]]);

function incidentRows(record, inc) {
  const recovery = inc.rec;
  return [
    ["Category", CATEGORY_LABELS[inc.cat]],
    ["Submission source", sourceLabel(record)],
    ["Outcome", OUTCOME_LABELS[inc.out]],
    ["Error kind", inc.kind ?? "Not reported"],
    ["Operation", inc.op === undefined ? "Not reported" : OPERATION_LABELS[inc.op]],
    ["First failed stage", stageCell(inc.stage)],
    ["First failure code", codeCell(inc.code) ?? "Not reported"],
    ["Final stage", inc.fs === undefined ? (inc.out === "recovered" ? "Recovered" : "Not reported") : STAGE_LABELS[inc.fs]],
    ["Final code", codeCell(inc.fc) ?? "Not reported"],
    ["Last completed stage", inc.done === undefined ? "Not reported" : inc.done === "none" ? "None" : STAGE_LABELS[inc.done]],
    ...(inc.dec === undefined ? [] : [["Server decision", inc.dec]]),
    ["HTTP status", inc.http === undefined ? "Not observed" : String(inc.http)],
    ...(inc.rt === undefined ? [] : [["Retryable", yesNo(inc.rt)]]),
    ["First AVPlay error", inc.av?.f ?? "None observed"],
    ["Last AVPlay error", inc.av?.l ?? "None observed"],
    ["AVPlay opened", inc.open === undefined ? "Not reported" : yesNo(inc.open)],
    ["Frame shown", inc.shown === undefined ? "Not reported" : yesNo(inc.shown)],
    ["Request resends", inc.rs === undefined ? "Not reported" : String(inc.rs)],
    ["Route fallbacks", recovery?.n === undefined ? "Not reported" : String(recovery.n)],
    ["Reconnects", recovery?.c === undefined ? "Not reported" : String(recovery.c)],
    ["Recovery", recovery?.r === undefined ? "Not reported" : RECOVERY_LABELS[recovery.r]],
    ...screenRows(record),
  ];
}

function stepLine(step, index) {
  const [stage, result, code] = step.split(":");
  const parts = [STAGE_LABELS[stage], result, code === undefined ? undefined : codeCell(code)].filter(Boolean);
  return `${index + 1}. ${parts.join(" · ")}`;
}

const NEVER = "Never reached";
const UNREPORTED = "Not reported";

function settingRows(settings) {
  if (settings === undefined || settings === "not_reached") {
    const value = settings === undefined ? UNREPORTED : NEVER;
    return [["Quality preference", value], ["Bitrate cap", value], ["HDR setting", value]];
  }
  return [
    ["Quality preference", settings.q ?? UNREPORTED],
    ["Bitrate cap", settings.cap === undefined ? UNREPORTED : settings.cap === "none" ? "None" : `${settings.cap} kbps`],
    ["HDR setting", settings.hdr === undefined ? UNREPORTED : settings.hdr ? "On" : "Off"],
  ];
}

function requestRows(request) {
  if (request === undefined) return [["Requested start", UNREPORTED]];
  return [
    ["Requested start", request.pos === undefined ? UNREPORTED : request.pos === "none" ? "None requested" : clockText(request.pos)],
    ["Requested subtitles", request.sub ?? UNREPORTED],
    ["Requested audio", request.aud ?? UNREPORTED],
  ];
}

function planRows(plan) {
  if (plan === undefined || plan === "not_reached") {
    const value = plan === undefined ? UNREPORTED : NEVER;
    return [["Plan", value], ["Position at failure", value]];
  }
  return [
    ["Plan", DELIVERY_LABELS[plan.dl]],
    ["Protocol", plan.pr ?? UNREPORTED],
    ["Container", plan.ct ?? UNREPORTED],
    ["Stream quality", plan.q ?? UNREPORTED],
    ["Video", [plan.vc, plan.res, plan.dr].filter(Boolean).join(" · ") || UNREPORTED],
    ["Source bitrate", plan.kbps === undefined ? UNREPORTED : `${plan.kbps} kbps`],
    ["Plan start position", plan.pos === undefined ? UNREPORTED : clockText(plan.pos)],
    ["Position at failure", plan.at === undefined ? UNREPORTED : clockText(plan.at)],
  ];
}

function panelRow(panel) {
  if (panel === undefined) return ["HDR panel capability", UNREPORTED];
  if (panel === "unavailable" || panel === "unknown") return ["HDR panel capability", "Unknown on this TV"];
  const part = (name, value) => `${name} ${value === undefined ? "not reported" : yesNo(value).toLowerCase()}`;
  return ["HDR panel capability", [part("HDR10", panel.h10), part("HLG", panel.hlg), part("Dolby Vision", panel.dv)].join(", ")];
}

function legacyPlayRows(play) {
  return [
    play.m ? ["Playback", play.m] : undefined,
    play.d ? ["Delivery", play.d] : undefined,
    play.tr ? ["Stream", play.tr] : undefined,
    play.src ? ["Source file", play.src] : undefined,
    play.v ? ["Video", play.v] : undefined,
    play.dr ? ["Dynamic range", play.dr] : undefined,
    play.sub ? ["Subtitle mode", play.sub] : undefined,
    play.pos ? ["Position", play.pos] : undefined,
    typeof play.rb === "number" && play.rb > 0 ? ["Rebuffers", String(play.rb)] : undefined,
    typeof play.hdr === "boolean" ? ["HDR setting", play.hdr ? "On" : "Off"] : undefined,
    play.st ? ["Status", play.st] : undefined,
  ].filter(Boolean);
}

function deviceRows(record) {
  const deviceLine = [record.tv, record.fw ? `Firmware ${record.fw}` : undefined, record.os, record.ua, record.scr].filter(Boolean).join(", ");
  return [
    ["TV", deviceLine],
    ["Auger version", record.app],
    ...(record.srv ? [["Silo server", record.srv]] : []),
    ...(typeof record.hdr === "boolean" ? [["HDR TV support", yesNo(record.hdr)]] : []),
    ...(record.mem ? [["JS heap", record.mem]] : []),
    ...(record.ram ? [["Device RAM", record.ram]] : []),
    ...(typeof record.up === "number" ? [["App uptime", `${record.up}m`]] : []),
  ];
}

function finish(lines, record, eli5, hidden) {
  lines.push("", "### Device", "", ...table(deviceRows(record)), "", "### ELI5", "", eli5, "", ...hidden);
  return lines.join("\n");
}

function incidentBody(record, hash) {
  const inc = publicIncident(record.inc);
  const lines = ["## What happened", "", ...table(incidentRows(record, inc))];
  if (inc.t?.length > 0) lines.push("", "### Event sequence", "", ...inc.t.map(stepLine));
  lines.push("", "### This attempt", "", ...table([...settingRows(inc.set), ...requestRows(inc.req), ...planRows(inc.pl), panelRow(inc.hp)]));
  // A plan-free attempt must not show player rows: they could only describe an earlier attempt.
  const playRows = inc.pl === "not_reached" || record.play === undefined ? [] : legacyPlayRows(record.play);
  if (playRows.length > 0) lines.push("", "### Player summary", "", ...table(playRows));
  if (record.log) lines.push("", "### Recent Events (Redacted)", "", "```text", ...record.log, "```");
  return finish(lines, record, "An Auger TV recorded what it was doing when playback went wrong and what happened next, without personal details.", [
    marker("auger-group", `inc1:${record.groupId}`),
    ...(record.equivalent ? [marker("auger-fp", record.equivalent.fingerprint)] : []),
    marker("auger-hash", hash),
    marker("auger-state", `inc1:${encodeBase64(JSON.stringify(incidentStableState(record)))}`),
  ]);
}

function legacyBody(record, hash) {
  const p = record.play ?? {};
  const observed = record.cat !== undefined && record.auto !== true && !p.e && !record.err;
  const summaryRows = [
    ["Report source", sourceLabel(record)],
    ["Report type", observed ? "Viewer-observed symptom (no failure detected)" : "Summary without an incident record"],
    ...screenRows(record),
    ...(record.err ? [["App error", record.err]] : []),
    ...(p.e ? [["Last error", p.e]] : []),
    ...(p.av ? [["AVPlay error", p.av]] : []),
    ...(typeof p.fb === "number" && p.fb > 0 ? [["Route fallbacks", String(p.fb)]] : []),
  ];
  const lines = ["## What happened", "", ...table(summaryRows)];
  if (record.log) lines.push("", "### Recent Events (Redacted)", "", "```text", ...record.log, "```");
  const playRows = legacyPlayRows(p);
  if (playRows.length > 0) lines.push("", "### Last Playback", "", ...table(playRows));
  return finish(lines, record, "An Auger TV sent a redacted report; only values the relay recognizes are shown.", [
    ...(record.observedGroupId ? [marker("auger-group", `obs1:${record.observedGroupId}`)] : [marker("auger-fp", record.legacyFingerprint)]),
    marker("auger-hash", hash),
    marker("auger-state", encodeBase64(JSON.stringify(legacyStableState(record)))),
  ]);
}

/** Title, body and content hash for a validated record. */
export function formatIssue(record) {
  const hash = contentHash(record);
  if (record.inc) return { title: incidentTitle(publicIncident(record.inc)), body: incidentBody(record, hash), contentHash: hash };
  return { title: legacyTitle(record), body: legacyBody(record, hash), contentHash: hash };
}

// ---------------------------------------------------------------------------
// Follow-up comments
// ---------------------------------------------------------------------------

const LEGACY_DIFF_FIELDS = [
  ["fw", "Firmware"],
  ["os", "Tizen OS"],
  ["srv", "Silo server"],
  ["cat", "Category"],
  ["err", "App error"],
  ["m", "Playback"],
  ["d", "Delivery"],
  ["tr", "Stream"],
  ["src", "Source file"],
  ["v", "Video"],
  ["dr", "Dynamic range"],
  ["sub", "Subtitle mode"],
  ["rb", "Rebuffers"],
  ["hdr", "HDR setting"],
  ["fb", "Route fallbacks"],
  ["av", "AVPlay error"],
  ["e", "Last error"],
];

/** Previous values come from older public issues; republish them only if they pass today's allowlist. */
function safeLegacyValue(key, value) {
  if (value === undefined || value === null || value === "") return "none";
  const check = LEGACY_FIELD_CHECKS[key];
  const safe = check === undefined ? undefined : check(value);
  if (safe === undefined) return "earlier value";
  if (key === "hdr") return safe ? "On" : "Off";
  if (key === "cat") return CATEGORY_LABELS[safe];
  return String(safe);
}

const INCIDENT_DIFF_FIELDS = [
  ["out", "Outcome"],
  ["kind", "Error kind"],
  ["fs", "Final stage"],
  ["fc", "Final code"],
  ["done", "Last completed stage"],
  ["http", "HTTP status"],
  ["dec", "Server decision"],
  ["av.l", "Last AVPlay error"],
  ["open", "AVPlay opened"],
  ["shown", "Frame shown"],
  ["rs", "Request resends"],
  ["rec.n", "Route fallbacks"],
  ["rec.c", "Reconnects"],
  ["rec.r", "Recovery"],
  ["set.q", "Quality preference"],
  ["set.cap", "Bitrate cap"],
  ["set.hdr", "HDR setting"],
  ["pl.dl", "Plan"],
];

function readPath(value, path) {
  return path.split(".").reduce((current, key) => (current !== null && typeof current === "object" ? current[key] : undefined), value);
}

/**
 * Stored incident values are re-checked so an edited issue body cannot inject text into a comment: only booleans,
 * integers, published codes and the contract's own lowercase enum words pass.
 */
function safeScalar(value) {
  if (value === undefined || value === null) return "none";
  if (typeof value === "boolean" || (typeof value === "number" && Number.isInteger(value))) return String(value);
  if (typeof value !== "string") return "earlier value";
  if (isPublishedCode(value) || /^unlisted_[0-9a-f]{8}$/.test(value)) return value;
  return STAGE_OR_ENUM.has(value) || /^(?:\d{3,4}p|[48]k)$/.test(value) ? value : "earlier value";
}

const STAGE_OR_ENUM = new Set([
  ...Object.keys(STAGE_LABELS), ...Object.keys(OUTCOME_LABELS), ...Object.keys(RECOVERY_LABELS), ...Object.keys(DELIVERY_LABELS),
  "none", "not_reached", "adaptation_unavailable", "unknown", "auto", "original", "source",
]);

function followUpHeader(record) {
  return ["### Additional report (same issue signature)", "", `- **Source:** ${sourceLabel(record)}`];
}

/**
 * Compact follow-up for an existing issue, or null when nothing new would be said.
 * `previous` is `{ version, state }` decoded from the issue body, or undefined.
 */
export function formatFollowUp(previous, record, hash) {
  return record.inc ? incidentFollowUp(previous, record, hash) : legacyFollowUp(previous, record, hash);
}

function incidentFollowUp(previous, record, hash) {
  const inc = publicIncident(record.inc);
  const lines = followUpHeader(record);
  if (typeof inc.pl === "object" && inc.pl.at !== undefined) lines.push(`- **Position at failure:** ${clockText(inc.pl.at)}`);
  if (previous?.version !== "inc1") {
    lines.push("- **Report type:** Incident record from a current Auger client", "", ...table(incidentRows(record, inc)));
    if (inc.t?.length > 0) lines.push("", ...inc.t.map(stepLine));
    lines.push("", marker("auger-hash", hash));
    return lines.join("\n");
  }
  const before = previous.state.inc ?? {};
  const after = incidentStableState(record).inc;
  const changed = INCIDENT_DIFF_FIELDS
    .filter(([path]) => readPath(after, path) !== undefined && JSON.stringify(readPath(after, path)) !== JSON.stringify(readPath(before, path)))
    .map(([path, label]) => `- **${label}:** \`${safeScalar(readPath(before, path))}\` → \`${safeScalar(readPath(after, path))}\``);
  const priorSteps = new Set(Array.isArray(before.t) ? before.t : []);
  const newSteps = (after.t ?? []).filter((step) => !priorSteps.has(step));
  if (changed.length === 0 && newSteps.length === 0) return null;
  if (changed.length > 0) lines.push("", "**Changed vs. initial report:**", ...changed);
  if (newSteps.length > 0) lines.push("", "**New events:**", ...newSteps.map(stepLine));
  lines.push("", marker("auger-hash", hash));
  return lines.join("\n");
}

function legacyFollowUp(previous, record, hash) {
  const current = legacyStableState(record);
  const prevState = previous?.version === "legacy" ? previous.state : undefined;
  const changed = [];
  if (prevState) {
    for (const [key, label] of LEGACY_DIFF_FIELDS) {
      if (current[key] !== undefined && prevState[key] !== current[key]) {
        changed.push(`- **${label}:** \`${safeLegacyValue(key, prevState[key])}\` → \`${safeLegacyValue(key, current[key])}\``);
      }
    }
  }
  const prevLogs = new Set(Array.isArray(prevState?.log) ? prevState.log : []);
  const newLogs = (record.log ?? []).filter((entry) => !prevLogs.has(stripLogTimestamp(entry)));
  if (prevState && changed.length === 0 && newLogs.length === 0) return null;
  const lines = [
    ...followUpHeader(record),
    ...(record.mem ? [`- **JS heap:** ${record.mem}`] : []),
    ...(record.ram ? [`- **Device RAM:** ${record.ram}`] : []),
    ...(typeof record.up === "number" ? [`- **App uptime:** ${record.up}m`] : []),
    ...(record.play?.pos ? [`- **Position:** ${record.play.pos}`] : []),
  ];
  if (!prevState) {
    lines.push("", "**Report summary:**", ...table([["Title", legacyTitle(record)], ...(record.play?.e ? [["Last error", record.play.e]] : []), ...(record.play?.av ? [["AVPlay error", record.play.av]] : [])]));
  }
  if (changed.length > 0) lines.push("", "**Changed vs. initial report:**", ...changed);
  if (newLogs.length > 0) lines.push("", "**New log lines:**", "```text", ...newLogs, "```");
  lines.push("", marker("auger-hash", hash));
  return lines.join("\n");
}
