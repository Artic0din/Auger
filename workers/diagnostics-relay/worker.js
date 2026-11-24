// Zero-dependency Cloudflare Worker relay for Auger TV diagnostics.
// Validates and redacts incoming reports, rate-limits by client IP, and files a GitHub issue.
// Secrets live strictly in Cloudflare Worker Secrets (`GITHUB_TOKEN`), never in Auger or Git.

const MAX_BODY_BYTES = 8192;
const RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_MAX_REQUESTS = 5;
const DEFAULT_REPO = "Artic0din/Auger-Tizen";

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const QUERY_PATTERN = /\?[^\s"'<>]+/g;
const SECRET_ASSIGN_PATTERN = /\b(?:bearer|token|api[_-]?key|password|passwd|secret|authorization|cookie)\s*[:=]\s*\S+/gi;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{28,}\b/g;

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
    .replace(LONG_TOKEN_PATTERN, "<redacted>")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned === "") return undefined;
  return cleaned.length <= maxLength ? cleaned : `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
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
    play = {
      m: sanitize(raw.play.m, 64),
      v: sanitize(raw.play.v, 72),
      dr: sanitize(raw.play.dr, 40),
      a: sanitize(raw.play.a, 64),
      s: sanitize(raw.play.s, 64),
      d: sanitize(raw.play.d, 48),
      st: sanitize(raw.play.st, 32),
      n: notes.length > 0 ? notes : undefined,
      e: sanitize(raw.play.e, 120),
    };
  }

  const log = Array.isArray(raw.log)
    ? raw.log.map((item) => sanitize(item, 120)).filter(Boolean).slice(0, 12)
    : [];

  return {
    v: 1,
    app,
    tv,
    fw: sanitize(raw.fw, 48),
    os: sanitize(raw.os, 32),
    ua: sanitize(raw.ua, 32),
    hdr: typeof raw.hdr === "boolean" ? raw.hdr : undefined,
    srv: sanitize(raw.srv, 48),
    play,
    log: log.length > 0 ? log : undefined,
  };
}

export function formatGitHubIssue(payload) {
  const titleParts = [`[diagnostics] ${payload.tv}`, `Auger ${payload.app}`];
  if (payload.play?.e) titleParts.push(payload.play.e.slice(0, 48));
  else if (payload.play?.m) titleParts.push(payload.play.m);
  const title = titleParts.join(" · ").slice(0, 140);

  const deviceLine = [
    payload.tv,
    payload.fw ? `Firmware ${payload.fw}` : undefined,
    payload.os,
    payload.ua,
  ].filter(Boolean).join(", ");

  const lines = [
    "## Diagnostics Report (Sent from Auger TV)",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| TV | ${deviceLine} |`,
    `| Auger version | ${payload.app} |`,
    ...(payload.srv ? [`| Silo server | ${payload.srv} |`] : []),
    ...(typeof payload.hdr === "boolean" ? [`| HDR TV support | ${payload.hdr ? "Yes" : "No"} |`] : []),
  ];

  if (payload.play) {
    const p = payload.play;
    const playRows = [
      p.m ? `| Playback | ${p.m} |` : undefined,
      p.d ? `| Delivery | ${p.d} |` : undefined,
      p.v ? `| Video | ${p.v} |` : undefined,
      p.dr ? `| Dynamic range | ${p.dr} |` : undefined,
      p.a ? `| Audio | ${p.a} |` : undefined,
      p.s ? `| Subtitles | ${p.s} |` : undefined,
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
    `An Auger ${payload.app} user on ${payload.tv} submitted redacted TV and playback diagnostics directly from Settings > Diagnostics.`,
  );

  return { title, body: lines.join("\n") };
}

async function checkRateLimit(request, cache) {
  if (!cache) return { allowed: true };
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
  const key = new Request(`https://rate-limit.internal/${encodeURIComponent(ip)}/${bucket}`);
  const hit = await cache.match(key);
  const count = hit ? Number(await hit.text()) || 0 : 0;
  if (count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, retryAfter: RATE_LIMIT_WINDOW_SECONDS };
  }
  await cache.put(
    key,
    new Response(String(count + 1), {
      headers: { "Cache-Control": `max-age=${RATE_LIMIT_WINDOW_SECONDS}` },
    }),
  );
  return { allowed: true };
}

export async function handleRequest(request, env, deps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const cache = deps.cache !== undefined ? deps.cache : (typeof caches !== "undefined" ? caches.default : undefined);

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

  const limit = await checkRateLimit(request, cache);
  if (!limit.allowed) {
    return jsonResponse(
      { ok: false, error: "rate_limited" },
      429,
      { "Retry-After": String(limit.retryAfter) },
    );
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, error: "payload_too_large" }, 413);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, 400);
  }

  const payload = validatePayload(parsed);
  if (!payload) {
    return jsonResponse({ ok: false, error: "invalid_payload" }, 400);
  }

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const issue = formatGitHubIssue(payload);
  const ghResponse = await fetchFn(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "auger-diagnostics-relay/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      title: issue.title,
      body: issue.body,
      labels: ["bug", "needs-triage"],
    }),
  });

  if (!ghResponse.ok) {
    return jsonResponse({ ok: false, error: "github_error", status: ghResponse.status }, 502);
  }

  const created = await ghResponse.json();
  const issueNumber = typeof created?.number === "number" ? created.number : undefined;
  return jsonResponse({
    ok: true,
    issueNumber,
    reportId: issueNumber !== undefined ? `AUG-${issueNumber}` : "AUG-SENT",
  }, 201);
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
