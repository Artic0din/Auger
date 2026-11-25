// Zero-dependency Cloudflare Worker relay for Auger TV diagnostics.
// Validates every public field against an allowlist (contract.js for current clients, legacy.js for installed v1
// clients), rate-limits by client IP, groups against open `diagnostics` issues via versioned markers, and opens an
// issue or appends a compact follow-up comment. Secrets live strictly in Cloudflare Worker Secrets (`GITHUB_TOKEN`).

import { legacyEquivalent, legacyEvidenceMatches, legacySignatureDigest } from "./grouping.js";
import { fnv1aHex, sanitize, validateV1 } from "./legacy.js";
import { decodeEmbeddedState, formatFollowUp, formatIssue, legacyStableState } from "./report.js";

export { INCIDENT_CONTRACT, PRECEDING_SCREENS } from "./contract.js";
export { fnv1aHex, sanitize };
export { formatIssue as formatGitHubIssue, formatFollowUp as formatDiffComment };

const MAX_BODY_BYTES = 8192;
// Cloudflare [[ratelimits]] only supports period = 10 or 60; keep Retry-After aligned with wrangler.toml.
const BINDING_RATE_LIMIT_WINDOW_SECONDS = 60;
const FALLBACK_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const FALLBACK_RATE_LIMIT_MAX_REQUESTS = 5;
const MAX_DIFF_COMMENTS_PER_ISSUE = 5;
const DEFAULT_REPO = "Artic0din/Auger-Tizen";

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

/** Validated internal record, or `{ error, missing? }`. Only `v: 1` (with optional `inc`) is accepted. */
export function validateReport(raw) {
  return validateV1(raw);
}

/** Backwards-compatible helper: the validated record or undefined. */
export function validatePayload(raw) {
  return validateV1(raw).record;
}

/**
 * Lookup candidates in priority order. Each names a body marker and a guard that rejects a marker hit whose
 * embedded evidence describes a different failure (a hash collision or an ambiguous legacy signature).
 */
function lookupCandidates(record) {
  if (record.inc) {
    const candidates = [{
      marker: `<!-- auger-group:inc1:${record.groupId} -->`,
      accept: (previous) => previous === undefined || (previous.version === "inc1" && previous.state.gk === record.groupGuard),
    }];
    const equivalent = record.equivalent;
    if (equivalent !== undefined) {
      candidates.push({
        marker: `<!-- auger-fp:${equivalent.fingerprint} -->`,
        accept: (previous) => previous?.version === "legacy" && legacySignatureDigest(previous.state) === equivalent.digest && legacyEvidenceMatches(previous.state, equivalent),
      });
    }
    return candidates;
  }
  if (record.navGroupId) {
    return [{
      marker: `<!-- auger-group:nav1:${record.navGroupId} -->`,
      accept: (previous) => previous === undefined || (previous.version === "legacy" && previous.state.ng === record.navGuard),
    }];
  }
  if (record.observedGroupId) {
    return [{
      marker: `<!-- auger-group:obs1:${record.observedGroupId} -->`,
      accept: (previous) => previous === undefined || (previous.version === "legacy" && previous.state.og === record.observedGuard),
    }];
  }
  return [{
    marker: `<!-- auger-fp:${record.legacyFingerprint} -->`,
    accept: (previous) => previous === undefined || (previous.version === "legacy"
      ? legacySignatureDigest(previous.state) === record.legacySignatureDigest
      : previous.state.sg === record.legacySignatureDigest && matchesCurrentIssue(record, previous.state)),
  }];
}

function matchesCurrentIssue(record, state) {
  const equivalent = state.inc && legacyEquivalent(state.inc);
  return Boolean(equivalent && legacyEvidenceMatches(legacyStableState(record), equivalent));
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
    "User-Agent": "auger-diagnostics-relay/2.0",
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

/** Scans open `diagnostics` issues; returns the highest-priority candidate whose marker and guard both match. */
async function findMatchingOpenIssue(fetchFn, repo, token, candidates) {
  let nextUrl = `https://api.github.com/repos/${repo}/issues?state=open&labels=diagnostics&per_page=100`;
  let best;
  const interrupted = (status) => best ? { ok: true, issue: best.issue } : { ok: false, status };
  for (let page = 0; page < MAX_ISSUE_LOOKUP_PAGES && nextUrl; page++) {
    let response;
    let issues;
    try {
      response = await fetchFn(nextUrl, { method: "GET", headers: githubHeaders(token) });
      if (!response.ok) return interrupted(response.status);
      issues = await response.json();
    } catch {
      return interrupted(502);
    }
    if (!Array.isArray(issues)) return interrupted(502);
    for (const entry of issues) {
      if (!entry || typeof entry !== "object" || entry.pull_request || typeof entry.body !== "string" || typeof entry.number !== "number") continue;
      const limit = best === undefined ? candidates.length : best.rank;
      for (let rank = 0; rank < limit; rank++) {
        const candidate = candidates[rank];
        if (entry.body.includes(candidate.marker) && candidate.accept(decodeEmbeddedState(entry.body))) {
          best = { rank, issue: entry };
          break;
        }
      }
      if (best?.rank === 0) return { ok: true, issue: best.issue };
    }
    nextUrl = nextLinkUrl(response.headers?.get?.("Link"));
  }
  return { ok: true, issue: best?.issue };
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

  const validated = validateReport(parsed);
  if (!validated.record) {
    const status = validated.error === "not_auto_reportable" ? 422 : 400;
    return jsonResponse({ ok: false, error: validated.error, ...(validated.missing ? { fields: validated.missing } : {}) }, status);
  }
  const record = validated.record;

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const issue = formatIssue(record);
  const candidates = lookupCandidates(record);

  const writeIssue = async () => {
    const lookup = await findMatchingOpenIssue(fetchFn, repo, env.GITHUB_TOKEN, candidates);
    if (!lookup.ok) {
      return jsonResponse({ ok: false, error: "github_error", status: lookup.status }, 502);
    }
    const existing = lookup.issue;

    if (existing) {
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
      const followUp = formatFollowUp(decodeEmbeddedState(existing.body), record, issue.contentHash);
      if (followUp === null) {
        return jsonResponse({ ok: true, status: "duplicate", issueNumber: existing.number, reportId }, 200);
      }
      const commentResponse = await fetchFn(`https://api.github.com/repos/${repo}/issues/${existing.number}/comments`, {
        method: "POST",
        headers: githubHeaders(env.GITHUB_TOKEN),
        body: JSON.stringify({ body: followUp }),
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
  };
  // Within this isolate, take the preferred marker first and its legacy alias second.
  return serializeByFingerprint(candidates[0].marker, () =>
    candidates[1] ? serializeByFingerprint(candidates[1].marker, writeIssue) : writeIssue());
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
