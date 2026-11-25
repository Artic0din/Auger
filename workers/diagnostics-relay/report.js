// Issue bodies, follow-up comments and embedded metadata, built from validated records only.

import { bufferingSection } from "./buffering.js";
import {
  AUDIO_CODECS, CAPTION_LOAD_STATES, CATEGORY_LABELS, CONTAINERS, DYNAMIC_RANGES, LANGUAGE_PATTERN, PROTOCOLS, SUBTITLE_CODECS, SUBTITLE_DELIVERIES,
  SUBTITLE_DRAWERS, SUBTITLE_MODES, SUBTITLE_SOURCES, SWITCH_RESULTS, VIDEO_CODECS, isPublishedCode,
} from "./contract.js";
import {
  CAPTION_LOAD_LABELS, codeCell, DELIVERY_LABELS, OPERATION_LABELS, OUTCOME_LABELS, RECOVERY_LABELS, SCREEN_LABELS, STAGE_LABELS,
  SUBTITLE_DRAWER_LABELS, SWITCH_RESULT_LABELS,
} from "./labels.js";
import { fnv1aHex, LEGACY_FIELD_CHECKS } from "./legacy.js";
import { incidentTitle, legacyTitle } from "./titles.js";
import { navigationSection } from "./navigation.js";

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

/** The audio/subtitle record as it may appear in public output: an unlisted switch code becomes a digest. */
export function publicMedia(md) {
  if (md?.sw?.code === undefined) return md;
  return { ...md, sw: { ...md.sw, code: publicCode(md.sw.code) } };
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
    bq: record.bq,
    md: publicMedia(record.md),
    log: (record.log ?? []).map(stripLogTimestamp),
  };
}

/** Comparable legacy evidence: allowlisted values only, plus digests for collision checks. */
export function legacyStableState(record) {
  const play = record.play ?? {};
  return {
    sg: record.legacySignatureDigest,
    ...(record.hadPlanEvent ? { hadPlanEvent: true } : {}),
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
    md: publicMedia(record.md),
    bq: record.bq,
    log: (record.log ?? []).map(stripLogTimestamp),
    nav: record.nav,
  };
}

/**
 * Comparable evidence for an app error with navigation context. Excludes the selected category, the screen before
 * Settings and the submission source, so manual and automatic submissions of one error hash identically.
 */
export function navigationErrorState(record) {
  return {
    ng: record.navGuard,
    sg: record.legacySignatureDigest,
    fw: record.fw,
    os: record.os,
    ua: record.ua,
    srv: record.srv,
    err: record.err,
    nav: record.nav,
    log: (record.log ?? []).map(stripLogTimestamp),
  };
}

function stableState(record) {
  if (record.inc) return incidentStableState(record);
  return record.navGroupId ? navigationErrorState(record) : legacyStableState(record);
}

export function contentHash(record) {
  return fnv1aHex(JSON.stringify(stableState(record)));
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
  const firstHttp = /^http_([1-5]\d{2})$/.exec(inc.code ?? "")?.[1];
  const separateHttp = firstHttp !== undefined && (inc.stage !== inc.fs || firstHttp !== String(inc.http));
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
    ...(separateHttp ? [["First failure HTTP status", firstHttp]] : []),
    [separateHttp ? "Final HTTP status" : "HTTP status", inc.http === undefined ? "Not observed" : String(inc.http)],
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
  const [stage, result, ...rest] = step.split(":");
  const code = rest.length ? rest.join(":") : undefined;
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

const audioFormatCell = (format, unavailable) => {
  if (format === undefined) return UNREPORTED;
  if (format === "unavailable") return unavailable;
  return [format.c, format.ch === undefined ? undefined : `${format.ch} ch`].filter(Boolean).join(" · ");
};

function mediaRows(md) {
  const rows = [];
  if (md.a !== undefined) {
    rows.push(
      ["Audio language", md.a.lang ?? UNREPORTED],
      ["Audio source (file)", audioFormatCell(md.a.src, "Unknown: no source track identified")],
      ["Audio output (planned by server)", audioFormatCell(md.a.pl, "Not stated in the plan")],
      ["Audio output (reported by AVPlay)", audioFormatCell(md.a.obs, "Not reported by AVPlay")],
    );
  }
  const sub = md.s;
  if (sub !== undefined) {
    const flags = [sub.f ? "forced" : undefined, sub.hi ? "SDH" : undefined].filter(Boolean).join(", ");
    rows.push(["Subtitle mode (planned)", sub.mode]);
    if (sub.mode !== "off") {
      rows.push(["Subtitle track", [sub.src, sub.c, sub.dl, sub.lang, flags || undefined].filter(Boolean).join(" · ") || UNREPORTED]);
    }
    rows.push(
      ["Subtitles drawn by", SUBTITLE_DRAWER_LABELS[sub.via]],
      ["Subtitle file load", CAPTION_LOAD_LABELS[sub.ld]],
      // Zero is an observed count; a load that never completed has none to report.
      ["Subtitle cues loaded", sub.cues === undefined ? "Not observed" : String(sub.cues)],
      ["Subtitle delay (applied)", sub.sync === undefined ? "Not applied" : `${sub.sync > 0 ? "+" : ""}${sub.sync} ms`],
      ["Second subtitle line", sub.sec === undefined ? UNREPORTED : yesNo(sub.sec)],
    );
  }
  const sw = md.sw;
  rows.push(["Requested switch", sw === undefined ? "None this attempt" : [sw.k === "audio" ? "Audio" : "Subtitle", SWITCH_RESULT_LABELS[sw.r], codeCell(sw.code)].filter(Boolean).join(" · ")]);
  return rows;
}

function mediaSection(record) {
  if (record.md === undefined) return [];
  return ["", "### Audio and subtitles", "", ...table(mediaRows(publicMedia(record.md)))];
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
  lines.push(...bufferingSection(record.bq, table));
  // A plan-free attempt must not show player rows: they could only describe an earlier attempt.
  const playRows = inc.pl === "not_reached" || record.play === undefined ? [] : legacyPlayRows(record.play);
  if (playRows.length > 0) lines.push("", "### Player summary", "", ...table(playRows));
  lines.push(...mediaSection(record));
  if (record.log) lines.push("", "### Recent Events (Redacted)", "", "```text", ...record.log, "```");
  const eli5 = inc.cat === "audio_subtitles"
    ? "An Auger TV recorded which audio and subtitles were chosen, what the player delivered and what failed, without personal details."
    : "An Auger TV recorded what it was doing when playback went wrong and what happened next, without personal details.";
  return finish(lines, record, eli5, [
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
    ["Report type", observed ? "Viewer-observed symptom (no failure detected)" : record.navGroupId ? "Uncaught app error with navigation context" : "Summary without an incident record"],
    ...screenRows(record),
    ...(record.err ? [["App error", record.err]] : []),
    ...(p.e ? [["Last error", p.e]] : []),
    ...(p.av ? [["AVPlay error", p.av]] : []),
    ...(typeof p.fb === "number" && p.fb > 0 ? [["Route fallbacks", String(p.fb)]] : []),
  ];
  const lines = ["## What happened", "", ...table(summaryRows), ...navigationSection(record.nav, table), ...bufferingSection(record.bq, table)];
  if (record.log) lines.push("", "### Recent Events (Redacted)", "", "```text", ...record.log, "```");
  const playRows = legacyPlayRows(p);
  if (playRows.length > 0) lines.push("", "### Last Playback", "", ...table(playRows));
  lines.push(...mediaSection(record));
  return finish(lines, record, "An Auger TV sent a redacted report; only values the relay recognizes are shown.", [
    ...(record.navGroupId
      ? [marker("auger-group", `nav1:${record.navGroupId}`)]
      : record.observedGroupId ? [marker("auger-group", `obs1:${record.observedGroupId}`)] : [marker("auger-fp", record.legacyFingerprint)]),
    marker("auger-hash", hash),
    marker("auger-state", encodeBase64(JSON.stringify(stableState(record)))),
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

const VERSION_DIFF_FIELDS = [
  ["fw", "Firmware"],
  ["os", "Tizen OS"],
  ["srv", "Silo server"],
];

const DEVICE_DIFF_FIELDS = [...VERSION_DIFF_FIELDS, ["ua", "Browser"], ["hdr", "HDR TV support"]];

const LEGACY_DIFF_FIELDS = [
  ...VERSION_DIFF_FIELDS,
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

function changedEvidence(fields, before, after) {
  return fields
    .filter(([key]) => after[key] !== undefined && before[key] !== after[key])
    .map(([key, label]) => `- **${label}:** \`${safeLegacyValue(key, before[key])}\` → \`${safeLegacyValue(key, after[key])}\``);
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
  ["pl.pr", "Protocol"],
  ["pl.ct", "Container"],
  ["pl.q", "Stream quality"],
  ["pl.kbps", "Source bitrate (kbps)"],
  ["pl.vc", "Video codec"],
  ["pl.res", "Resolution"],
  ["pl.dr", "Dynamic range"],
];

const MEDIA_DIFF_FIELDS = [
  ["a.lang", "Audio language"],
  ["a.src.c", "Audio source codec"],
  ["a.src.ch", "Audio source channels"],
  ["a.pl.c", "Planned audio codec"],
  ["a.pl.ch", "Planned audio channels"],
  ["a.obs.c", "AVPlay audio codec"],
  ["a.obs.ch", "AVPlay audio channels"],
  ["s.mode", "Subtitle mode"],
  ["s.src", "Subtitle source"],
  ["s.c", "Subtitle codec"],
  ["s.dl", "Subtitle delivery"],
  ["s.lang", "Subtitle language"],
  ["s.via", "Subtitles drawn by"],
  ["s.ld", "Subtitle file load"],
  ["s.cues", "Subtitle cues loaded"],
  ["s.sync", "Subtitle delay (ms)"],
  ["sw.k", "Requested switch"],
  ["sw.r", "Switch result"],
  ["sw.code", "Switch code"],
];

function mediaChanges(before, after) {
  if (after === undefined) return [];
  return MEDIA_DIFF_FIELDS
    .filter(([path]) => readPath(after, path) !== undefined && JSON.stringify(readPath(after, path)) !== JSON.stringify(readPath(before, path)))
    .map(([path, label]) => `- **${label}:** \`${safeScalar(readPath(before, path))}\` → \`${safeScalar(readPath(after, path))}\``);
}

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
  return STAGE_OR_ENUM.has(value) || LANGUAGE_PATTERN.test(value) || /^(?:\d{3,4}p|[48]k|\d{1,5}x\d{1,5})$/.test(value) ? value : "earlier value";
}

const STAGE_OR_ENUM = new Set([
  ...CONTAINERS, ...DYNAMIC_RANGES, ...PROTOCOLS, ...VIDEO_CODECS,
  ...Object.keys(STAGE_LABELS), ...Object.keys(OUTCOME_LABELS), ...Object.keys(RECOVERY_LABELS), ...Object.keys(DELIVERY_LABELS),
  ...AUDIO_CODECS, ...SUBTITLE_CODECS, ...SUBTITLE_MODES, ...SUBTITLE_SOURCES, ...SUBTITLE_DELIVERIES, ...SUBTITLE_DRAWERS, ...CAPTION_LOAD_STATES, ...SWITCH_RESULTS,
  "none", "not_reached", "adaptation_unavailable", "unknown", "auto", "original", "source", "audio", "subtitle",
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
  const after = inc;
  const changed = INCIDENT_DIFF_FIELDS
    .filter(([path]) => readPath(after, path) !== undefined && JSON.stringify(readPath(after, path)) !== JSON.stringify(readPath(before, path)))
    .map(([path, label]) => `- **${label}:** \`${safeScalar(readPath(before, path))}\` → \`${safeScalar(readPath(after, path))}\``);
  changed.push(...changedEvidence(DEVICE_DIFF_FIELDS, previous.state, record));
  changed.push(...mediaChanges(previous.state.md, publicMedia(record.md)));
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
  const changed = prevState ? [...changedEvidence(LEGACY_DIFF_FIELDS, prevState, current), ...mediaChanges(prevState.md, current.md)] : [];
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
