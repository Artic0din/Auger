// In-memory GitHub Issues destination for relay cases. Plain ES module with no Node imports so the same
// cases can run under node:test and in a browser harness on the TV (Chromium 108).

export const RELAY_URL = "https://auger-diagnostics.plaintextlab.com/report";
const REPO = "Artic0din/Auger-Tizen";
const ISSUES_URL = `https://api.github.com/repos/${REPO}/issues`;

/** A fresh destination. `seed` pre-loads open issues as `{ number, title, body, comments? }`. */
export function fakeGitHub(seed = []) {
  const issues = seed.map((issue) => ({ comments: 0, ...issue, commentBodies: [] }));
  const outbound = [];
  let nextNumber = Math.max(1000, ...issues.map((issue) => issue.number + 1));

  async function fetch(url, init = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "GET" && url.startsWith(`${ISSUES_URL}?state=open&labels=diagnostics`)) {
      return new Response(JSON.stringify(issues.map(({ number, title, body, comments }) => ({ number, title, body, comments }))), { status: 200 });
    }
    const commentsMatch = /\/issues\/(\d+)\/comments/.exec(url);
    if (method === "GET" && commentsMatch) {
      const target = issues.find((issue) => issue.number === Number(commentsMatch[1]));
      return new Response(JSON.stringify((target?.commentBodies ?? []).map((body) => ({ body }))), { status: 200 });
    }
    const body = JSON.parse(String(init.body ?? "{}"));
    outbound.push({ method, url, body });
    if (method === "POST" && url === ISSUES_URL) {
      const number = nextNumber++;
      issues.push({ number, title: body.title, body: body.body, labels: body.labels, comments: 0, commentBodies: [] });
      return new Response(JSON.stringify({ number }), { status: 201 });
    }
    if (method === "POST" && commentsMatch) {
      const target = issues.find((issue) => issue.number === Number(commentsMatch[1]));
      if (!target) return new Response("not found", { status: 404 });
      target.comments++;
      target.commentBodies.push(body.body);
      return new Response(JSON.stringify({ id: target.comments }), { status: 201 });
    }
    return new Response("unexpected", { status: 418 });
  }

  return {
    fetch,
    issues,
    outbound,
    /** Issues this relay created (seeded issues excluded). */
    created: () => outbound.filter((call) => call.url === ISSUES_URL),
    comments: () => outbound.filter((call) => call.url.endsWith("/comments")),
    /** Every string the relay published: titles, bodies (including decoded metadata) and comments. */
    publishedText: () => outbound.flatMap((call) => [call.body.title, call.body.body].filter((text) => typeof text === "string")).flatMap(withDecodedMetadata),
  };
}

function withDecodedMetadata(text) {
  const decoded = [...text.matchAll(/<!--\s*auger-state:(?:v2:)?([A-Za-z0-9+/=]+)\s*-->/g)].map((match) => {
    try {
      const binary = atob(match[1]);
      return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    } catch {
      return "";
    }
  });
  return [text, ...decoded];
}

let ipCounter = 0;

/** Sends one report through the relay with a fresh client IP so rate limiting does not interfere. */
export async function send(handleRequest, destination, payload) {
  ipCounter++;
  const request = new Request(RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${ipCounter % 250}` },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  const limiter = { limit: async () => ({ success: true }) };
  const response = await handleRequest(request, { GITHUB_TOKEN: "test-secret-not-real", GITHUB_REPO: REPO }, { fetch: destination.fetch, rateLimiter: limiter });
  return { status: response.status, json: await response.json() };
}

/** Base64 helper matching the relay's metadata encoding, for seeding issues as older relays filed them. */
export function encodeState(state) {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** 32-bit FNV-1a, re-implemented here so a relay change cannot move both sides of a marker assertion. */
export function fnv(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Fingerprint the deployed relay wrote into `auger-fp` markers. */
export const deployedLegacyFingerprint = (app, tv, signature) => fnv([app, tv, signature].join("\n"));

/** Client incidentGroupKey digest (src/diagnosticsIncident.ts), the `auger-group:inc1` marker value. */
export const incidentGroupId = (app, tv, inc) => fnv(["inc1", app, tv, inc.cat, inc.op, inc.stage, inc.code ?? ""].join("\n"));
