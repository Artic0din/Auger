// Zero-dependency Cloudflare Worker relay for Auger TV diagnostics.
// Validates and redacts incoming reports, rate-limits by client IP, deduplicates against open
// `diagnostics` issues via deterministic fingerprints, and opens an issue or appends a compact diff comment.
// Secrets live strictly in Cloudflare Worker Secrets (`GITHUB_TOKEN`), never in Auger or Git.

const MAX_BODY_BYTES = 8192;
// Cloudflare [[ratelimits]] only supports period = 10 or 60; keep Retry-After aligned with wrangler.toml.
const BINDING_RATE_LIMIT_WINDOW_SECONDS = 60;
const FALLBACK_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const FALLBACK_RATE_LIMIT_MAX_REQUESTS = 5;
const MAX_DIFF_COMMENTS_PER_ISSUE = 5;
const DEFAULT_REPO = "Artic0din/Auger-Tizen";

const CATEGORY_LABELS = {
  playback: "Playback failed",
  audio_subtitles: "Audio / Subtitles",
  buffering: "Buffering / Quality",
  app_ui: "App / Navigation",
};

const ALLOWED_APP_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
  "AbortError",
  "NotAllowedError",
  "NotSupportedError",
  "QuotaExceededError",
  "SecurityError",
  "NetworkError",
  "TimeoutError",
  "DataCloneError",
  "InvalidStateError",
  "UncaughtError",
  "UnhandledRejection",
]);

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const QUERY_PATTERN = /\?[^\s"'<>]+/g;
const SECRET_ASSIGN_PATTERN = /\b(?:bearer|token|api[_-]?key|password|passwd|secret|authorization|cookie)\s*[:=]\s*\S+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{28,}\b/g;
const PLAYER_ERROR_CODE_PATTERN = /^PLAYER_ERROR_[A-Z0-9_]{1,40}$/;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function sanitize(raw, maxLength = 140) {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(URL_PATTERN, "<url>")
    .replace(BEARER_PATTERN, "Bearer <redacted>")
    .replace(SECRET_ASSIGN_PATTERN, "<redacted>")
    .replace(IPV4_PATTERN, "<ip>")
    .replace(QUERY_PATTERN, "")
    .replace(LONG_TOKEN_PATTERN, (match) => (PLAYER_ERROR_CODE_PATTERN.test(match) ? match : "<redacted>"))
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}

const ALLOWED_AVPLAY_STAGES = new Set(["prepareAsync", "open", "play", "seekTo"]);
const ALLOWED_AVPLAY_EXCEPTIONS = new Set([
  ...ALLOWED_APP_ERRORS,
  "WebAPIException",
  "InvalidAccessError",
  "InvalidValuesError",
  "NotFoundError",
  "UnknownError",
  "OperationNotSupportedError",
  "failed",
  "error",
]);

function sanitizeAvplayError(raw) {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "startup_timeout" || PLAYER_ERROR_CODE_PATTERN.test(trimmed)) return trimmed;
  const colon = trimmed.indexOf(":");
  if (colon <= 0) return undefined;
  const stage = trimmed.slice(0, colon);
  if (!ALLOWED_AVPLAY_STAGES.has(stage)) return undefined;
  const name = trimmed.slice(colon + 1);
  return ALLOWED_AVPLAY_EXCEPTIONS.has(name) ? `${stage}:${name}` : `${stage}:error`;
}

function nonNegInt(raw, max) {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= max ? raw : undefined;
}

export function fnv1aHex(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stripLogTimestamp(line) {
  return line.replace(/^\d{2}:\d{2}:\d{2}\s+/, "");
}

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

export function validatePayload(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  if (raw.v !== 1) return undefined;
  const app = sanitize(raw.app, 32);
  const tv = sanitize(raw.tv, 48);
  if (app === undefined || tv === undefined) return undefined;

  let play;
  if (typeof raw.play === "object" && raw.play !== null && !Array.isArray(raw.play)) {
    const notes = Array.isArray(raw.play.n)
      ? raw.play.n.map((item) => sanitize(item, 96)).filter(Boolean).slice(0, 4)
      : [];
    const candidate = {
      m: sanitize(raw.play.m, 64),
      v: sanitize(raw.play.v, 72),
      dr: sanitize(raw.play.dr, 40),
      a: sanitize(raw.play.a, 64),
      s: sanitize(raw.play.s, 64),
      d: sanitize(raw.play.d, 48),
      st: sanitize(raw.play.st, 32),
      src: sanitize(raw.play.src, 110),
      tr: sanitize(raw.play.tr, 64),
      sub: sanitize(raw.play.sub, 80),
      pos: sanitize(raw.play.pos, 24),
      rb: nonNegInt(raw.play.rb, 10000),
      hdr: typeof raw.play.hdr === "boolean" ? raw.play.hdr : undefined,
      av: sanitizeAvplayError(raw.play.av),
      fb: nonNegInt(raw.play.fb, 20),
      n: notes.length > 0 ? notes : undefined,
      e: sanitize(raw.play.e, 120),
    };
    if (Object.values(candidate).some((value) => value !== undefined)) play = candidate;
  }

  const log = Array.isArray(raw.log)
    ? raw.log.map((item) => sanitize(item, 120)).filter(Boolean).slice(0, 12)
    : [];

  const cat = typeof raw.cat === "string" && Object.hasOwn(CATEGORY_LABELS, raw.cat) ? raw.cat : undefined;
  const err = typeof raw.err === "string" && ALLOWED_APP_ERRORS.has(raw.err) ? raw.err : undefined;

  return {
    v: 1,
    app,
    tv,
    cat,
    auto: raw.auto === true ? true : undefined,
    err,
    fw: sanitize(raw.fw, 48),
    os: sanitize(raw.os, 32),
    ua: sanitize(raw.ua, 32),
    hdr: typeof raw.hdr === "boolean" ? raw.hdr : undefined,
    srv: sanitize(raw.srv, 48),
    mem: sanitize(raw.mem, 48),
    ram: sanitize(raw.ram, 16),
    scr: sanitize(raw.scr, 20),
    up: nonNegInt(raw.up, 525600),
    play,
    log: log.length > 0 ? log : undefined,
  };
}

/** Deterministic issue grouping fingerprint: same app version, TV model, and error/playback signature. */
export function computeFingerprint(payload) {
  const play = payload.play;
  const playErr = play?.e === undefined ? undefined : play.av && play.e === "playback_failed" ? `${play.e}:${play.av}` : play.e;
  const sig = payload.err
    ? `app:${payload.err}`
    : playErr ?? [payload.cat ?? "", play?.m ?? "", play?.d ?? "", play?.src ?? "", play?.sub ?? ""].join("|");
  return fnv1aHex([payload.app, payload.tv, sig].join("\n"));
}

/** Stable technical state excluding volatile runtime counters (mem, up, pos) for dedup and diffing. */
function stableState(payload) {
  const play = payload.play;
  return {
    fw: payload.fw,
    os: payload.os,
    srv: payload.srv,
    cat: payload.cat,
    err: payload.err,
    m: play?.m,
    d: play?.d,
    tr: play?.tr,
    src: play?.src,
    v: play?.v,
    dr: play?.dr,
    a: play?.a,
    s: play?.s,
    sub: play?.sub,
    rb: play?.rb,
    hdr: play?.hdr,
    av: play?.av,
    fb: play?.fb,
    n: play?.n,
    e: play?.e,
    log: (payload.log ?? []).map(stripLogTimestamp),
  };
}

export function computeContentHash(payload) {
  return fnv1aHex(JSON.stringify(stableState(payload)));
}

function decodeEmbeddedState(issueBody) {
  if (typeof issueBody !== "string") return undefined;
  const match = /<!--\s*auger-state:([A-Za-z0-9+/=]+)\s*-->/.exec(issueBody);
  if (!match?.[1]) return undefined;
  const text = decodeBase64(match[1]);
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const DIFF_FIELDS = [
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
  ["a", "Audio"],
  ["s", "Subtitles"],
  ["sub", "Subtitle mode"],
  ["rb", "Rebuffers"],
  ["hdr", "HDR setting"],
  ["fb", "Route fallbacks"],
  ["av", "AVPlay error"],
  ["e", "Last error"],
];

function formatFieldValue(key, value) {
  if (value === undefined || value === null || value === "") return "none";
  if (key === "hdr" && typeof value === "boolean") return value ? "On" : "Off";
  if (key === "cat" && typeof value === "string" && Object.hasOwn(CATEGORY_LABELS, value)) {
    return CATEGORY_LABELS[value];
  }
  return String(value);
}

export function formatDiffComment(previousState, payload, contentHash) {
  const current = stableState(payload);
  const changedLines = [];
  if (previousState) {
    for (const [key, label] of DIFF_FIELDS) {
      const prev = previousState[key];
      const next = current[key];
      if (prev !== next && next !== undefined) {
        changedLines.push(`- **${label}:** \`${formatFieldValue(key, prev)}\` → \`${formatFieldValue(key, next)}\``);
      }
    }
    const prevNotes = Array.isArray(previousState.n) ? previousState.n.join(" · ") : undefined;
    const nextNotes = Array.isArray(current.n) ? current.n.join(" · ") : undefined;
    if (prevNotes !== nextNotes && nextNotes !== undefined) {
      changedLines.push(`- **Diagnostics:** \`${prevNotes ?? "none"}\` → \`${nextNotes}\``);
    }
  }

  const prevLogs = new Set(Array.isArray(previousState?.log) ? previousState.log : []);
  const newLogs = (payload.log ?? []).filter((entry) => !prevLogs.has(stripLogTimestamp(entry)));

  if (previousState && changedLines.length === 0 && newLogs.length === 0) {
    return null;
  }

  const sourceLabel = payload.auto === true
    ? "Automatic error report"
    : payload.cat
      ? `Manual (${CATEGORY_LABELS[payload.cat]})`
      : "Manual";

  const lines = [
    "### Additional report (same issue signature)",
    "",
    `- **Source:** ${sourceLabel}`,
    ...(payload.mem ? [`- **JS heap:** ${payload.mem}`] : []),
    ...(payload.ram ? [`- **Device RAM:** ${payload.ram}`] : []),
    ...(typeof payload.up === "number" ? [`- **App uptime:** ${payload.up}m`] : []),
    ...(payload.play?.pos ? [`- **Position:** ${payload.play.pos}`] : []),
  ];

  if (changedLines.length > 0) {
    lines.push("", "**Changed vs. initial report:**", ...changedLines);
  }
  if (newLogs.length > 0) {
    lines.push("", "**New log lines:**", "```text", ...newLogs, "```");
  }
  lines.push("", `<!-- auger-hash:${contentHash} -->`);
  return lines.join("\n");
}

export function formatGitHubIssue(payload) {
  const fp = computeFingerprint(payload);
  const contentHash = computeContentHash(payload);
  const encodedState = encodeBase64(JSON.stringify(stableState(payload)));
  const categoryLabel = payload.cat ? CATEGORY_LABELS[payload.cat] : undefined;
  const sourceLabel = payload.auto === true
    ? "Automatic error report"
    : categoryLabel
      ? `Manual (${categoryLabel})`
      : "Manual";

  const titleParts = [`[diagnostics] ${payload.tv}`, `Auger ${payload.app}`];
  if (categoryLabel) titleParts.push(categoryLabel);
  if (payload.err) titleParts.push(payload.err.slice(0, 48));
  else if (payload.play?.e) titleParts.push(payload.play.e.slice(0, 48));
  else if (payload.play?.m) titleParts.push(payload.play.m);
  const title = titleParts.join(" · ").slice(0, 140);

  const deviceLine = [
    payload.tv,
    payload.fw ? `Firmware ${payload.fw}` : undefined,
    payload.os,
    payload.ua,
    payload.scr,
  ].filter(Boolean).join(", ");

  const lines = [
    "## Diagnostics Report (Sent from Auger TV)",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Report source | ${sourceLabel} |`,
    ...(payload.err ? [`| App error | ${payload.err} |`] : []),
    `| TV | ${deviceLine} |`,
    `| Auger version | ${payload.app} |`,
    ...(payload.srv ? [`| Silo server | ${payload.srv} |`] : []),
    ...(typeof payload.hdr === "boolean" ? [`| HDR TV support | ${payload.hdr ? "Yes" : "No"} |`] : []),
    ...(payload.mem ? [`| JS heap | ${payload.mem} |`] : []),
    ...(payload.ram ? [`| Device RAM | ${payload.ram} |`] : []),
    ...(typeof payload.up === "number" ? [`| App uptime | ${payload.up}m |`] : []),
  ];

  if (payload.play) {
    const p = payload.play;
    const playRows = [
      p.m ? `| Playback | ${p.m} |` : undefined,
      p.d ? `| Delivery | ${p.d} |` : undefined,
      p.tr ? `| Stream | ${p.tr} |` : undefined,
      p.src ? `| Source file | ${p.src} |` : undefined,
      p.v ? `| Video | ${p.v} |` : undefined,
      p.dr ? `| Dynamic range | ${p.dr} |` : undefined,
      p.a ? `| Audio | ${p.a} |` : undefined,
      p.s ? `| Subtitles | ${p.s} |` : undefined,
      p.sub ? `| Subtitle mode | ${p.sub} |` : undefined,
      p.pos ? `| Position | ${p.pos} |` : undefined,
      typeof p.rb === "number" && p.rb > 0 ? `| Rebuffers | ${p.rb} |` : undefined,
      typeof p.hdr === "boolean" ? `| HDR setting | ${p.hdr ? "On" : "Off"} |` : undefined,
      typeof p.fb === "number" && p.fb > 0 ? `| Route fallbacks | ${p.fb} |` : undefined,
      p.av ? `| AVPlay error | ${p.av} |` : undefined,
      p.st ? `| Status | ${p.st} |` : undefined,
      p.n ? `| Diagnostics | ${p.n.join(" · ")} |` : undefined,
      p.e ? `| Last error | ${p.e} |` : undefined,
    ].filter(Boolean);
    if (playRows.length > 0) {
      lines.push("", "### Last Playback", "", "| Field | Value |", "| --- | --- |", ...playRows);
    }
  }

  if (payload.log && payload.log.length > 0) {
    lines.push("", "### Recent Events (Redacted)", "", "```text", ...payload.log, "```");
  }

  lines.push(
    "",
    "### ELI5",
    "",
    `An Auger ${payload.app} user on ${payload.tv} submitted redacted TV and playback diagnostics (${sourceLabel.toLowerCase()}).`,
    "",
    `<!-- auger-fp:${fp} -->`,
    `<!-- auger-hash:${contentHash} -->`,
    `<!-- auger-state:${encodedState} -->`,
  );

  return { title, body: lines.join("\n"), fingerprint: fp, contentHash };
}

let isolateBucketWindow = -1;
const isolateBuckets = new Map();

async function checkRateLimit(request, env, limiter) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const binding = limiter ?? env?.DIAGNOSTICS_RATE_LIMITER;
  if (binding && typeof binding.limit === "function") {
    const result = await binding.limit({ key: ip });
    return result?.success === true ? { allowed: true } : { allowed: false, retryAfter: BINDING_RATE_LIMIT_WINDOW_SECONDS };
  }
  const bucket = Math.floor(Date.now() / (FALLBACK_RATE_LIMIT_WINDOW_SECONDS * 1000));
  if (bucket !== isolateBucketWindow) {
    isolateBuckets.clear();
    isolateBucketWindow = bucket;
  }
  const count = isolateBuckets.get(ip) ?? 0;
  if (count >= FALLBACK_RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retryAfter: FALLBACK_RATE_LIMIT_WINDOW_SECONDS };
  }
  isolateBuckets.set(ip, count + 1);
  return { allowed: true };
}

async function readBoundedBody(request, maxBytes) {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await request.body?.cancel(); } catch { /* ignore cancel errors */ }
    return { tooLarge: true, text: "" };
  }
  if (!request.body) return { tooLarge: false, text: "" };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch { /* ignore cancel errors */ }
          return { tooLarge: true, text: "" };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder("utf-8").decode(merged) };
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "auger-diagnostics-relay/1.1",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

const MAX_ISSUE_LOOKUP_PAGES = 5;
const inFlightFingerprints = new Map();

function nextLinkUrl(linkHeader) {
  if (typeof linkHeader !== "string") return undefined;
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match?.[1];
}

async function findMatchingOpenIssue(fetchFn, repo, token, fingerprint) {
  const marker = `<!-- auger-fp:${fingerprint} -->`;
  let nextUrl = `https://api.github.com/repos/${repo}/issues?state=open&labels=diagnostics&per_page=100`;
  for (let page = 0; page < MAX_ISSUE_LOOKUP_PAGES && nextUrl; page++) {
    let response;
    try {
      response = await fetchFn(nextUrl, { method: "GET", headers: githubHeaders(token) });
    } catch {
      return { ok: false, status: 502 };
    }
    if (!response.ok) return { ok: false, status: response.status };
    let issues;
    try {
      issues = await response.json();
    } catch {
      return { ok: false, status: 502 };
    }
    if (!Array.isArray(issues)) return { ok: false, status: 502 };
    const match = issues.find(
      (entry) => entry && typeof entry === "object" && !entry.pull_request && typeof entry.body === "string" && entry.body.includes(marker),
    );
    if (match) return { ok: true, issue: match };
    nextUrl = nextLinkUrl(response.headers?.get?.("Link"));
  }
  return { ok: true, issue: undefined };
}

async function issueHasCommentHash(fetchFn, repo, token, issueNumber, hashMarker) {
  try {
    const response = await fetchFn(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments?per_page=10`,
      { method: "GET", headers: githubHeaders(token) },
    );
    if (!response.ok) return { ok: false, status: response.status };
    const comments = await response.json();
    if (!Array.isArray(comments)) return { ok: false, status: 502 };
    const found = comments.some((entry) => entry && typeof entry.body === "string" && entry.body.includes(hashMarker));
    return { ok: true, found };
  } catch {
    return { ok: false, status: 502 };
  }
}

async function serializeByFingerprint(fingerprint, task) {
  const previous = inFlightFingerprints.get(fingerprint) ?? Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  inFlightFingerprints.set(fingerprint, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (inFlightFingerprints.get(fingerprint) === tail) {
      inFlightFingerprints.delete(fingerprint);
    }
  }
}

export async function handleRequest(request, env, deps = {}) {
  const fetchFn = deps.fetch ?? fetch;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  if (url.pathname !== "/report") {
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }
  if (request.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!env?.GITHUB_TOKEN) {
    return jsonResponse({ ok: false, error: "relay_not_configured" }, 503);
  }

  const limit = await checkRateLimit(request, env, deps.rateLimiter);
  if (!limit.allowed) {
    return jsonResponse(
      { ok: false, error: "rate_limited" },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  const body = await readBoundedBody(request, MAX_BODY_BYTES);
  if (body.tooLarge) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }

  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const payload = validatePayload(parsed);
  if (!payload) {
    return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
  }

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const issue = formatGitHubIssue(payload);

  return serializeByFingerprint(issue.fingerprint, async () => {
    const lookup = await findMatchingOpenIssue(fetchFn, repo, env.GITHUB_TOKEN, issue.fingerprint);
    if (!lookup.ok) {
      return jsonResponse({ ok: false, error: "github_error", status: lookup.status }, 502);
    }
    const existing = lookup.issue;

    if (existing && typeof existing.number === "number") {
      const reportId = `AUG-${existing.number}`;
      const hashMarker = `<!-- auger-hash:${issue.contentHash} -->`;
      if (existing.body.includes(hashMarker) || (typeof existing.comments === "number" && existing.comments >= MAX_DIFF_COMMENTS_PER_ISSUE)) {
        return jsonResponse({ ok: true, status: "duplicate", issueNumber: existing.number, reportId }, 200);
      }
      if (typeof existing.comments === "number" && existing.comments > 0) {
        const commentCheck = await issueHasCommentHash(fetchFn, repo, env.GITHUB_TOKEN, existing.number, hashMarker);
        if (!commentCheck.ok) {
          return jsonResponse({ ok: false, error: "github_error", status: commentCheck.status }, 502);
        }
        if (commentCheck.found) {
          return jsonResponse({ ok: true, status: "duplicate", issueNumber: existing.number, reportId }, 200);
        }
      }
      const previousState = decodeEmbeddedState(existing.body);
      const diffBody = formatDiffComment(previousState, payload, issue.contentHash);
      if (diffBody === null) {
        return jsonResponse({ ok: true, status: "duplicate", issueNumber: existing.number, reportId }, 200);
      }
      const commentResponse = await fetchFn(`https://api.github.com/repos/${repo}/issues/${existing.number}/comments`, {
        method: "POST",
        headers: githubHeaders(env.GITHUB_TOKEN),
        body: JSON.stringify({ body: diffBody }),
      });
      if (!commentResponse.ok) {
        return jsonResponse({ ok: false, error: "github_error", status: commentResponse.status }, 502);
      }
      return jsonResponse({ ok: true, status: "updated", issueNumber: existing.number, reportId }, 200);
    }

    const ghResponse = await fetchFn(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: githubHeaders(env.GITHUB_TOKEN),
      body: JSON.stringify({
        title: issue.title,
        body: issue.body,
        labels: ["diagnostics", "needs-triage"],
      }),
    });

    if (!ghResponse.ok) {
      return jsonResponse({ ok: false, error: "github_error", status: ghResponse.status }, 502);
    }

    const created = await ghResponse.json();
    const issueNumber = typeof created?.number === "number" ? created.number : undefined;
    return jsonResponse({
      ok: true,
      status: "created",
      issueNumber,
      reportId: issueNumber !== undefined ? `AUG-${issueNumber}` : "AUG-SENT",
    }, 201);
  });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
