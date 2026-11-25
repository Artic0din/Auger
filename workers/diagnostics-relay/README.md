# Auger Diagnostics Relay (Cloudflare Worker)

Stateless Cloudflare Worker that accepts redacted v1 diagnostic reports from Auger (`Settings > Diagnostics > Send Diagnostics Report` and opt-in Automatic Error Reports) at `https://auger-diagnostics.plaintextlab.com/report`.
It enforces a bounded 8 KiB streaming body limit and an atomic per-IP Cloudflare Workers Rate Limiting binding (`DIAGNOSTICS_RATE_LIMITER`, 1 report per 60 seconds), and files issues on `Artic0din/Auger-Tizen` labelled `diagnostics` and `needs-triage`.

No secrets are ever shipped inside Auger or committed to this repository.

## What it publishes

All public output (titles, bodies, follow-up comments and embedded metadata) is built from validated structured fields.
Unknown fields and unrecognized free text are discarded, never truncated into an issue.

| Module | Role |
| --- | --- |
| `contract.js` | `INCIDENT_CONTRACT`: the `inc` (iv 1) record a current client sends inside the v1 payload, mirroring `src/diagnosticsIncident.ts`. `iv`, `cat` and `out` are required; other invalid values are dropped. `BUFFERING_CONTRACT`: the optional `bq` (bv 1) Buffering / Quality evidence, mirroring `src/diagnosticsBuffering.ts`; invalid evidence is dropped and never rejects a report. |
| `legacy.js` | Field-by-field allowlist for installed clients' v1 fields and log lines, and the deployed legacy fingerprint. |
| `grouping.js` | When an incident may reuse an older issue, and the evidence checks that guard it. |
| `titles.js`, `labels.js` | Fixed plain-language phrases; no bracketed prefix and no TV model in titles (140-character ceiling). |
| `report.js` | Issue bodies, follow-up comments and `auger-state` metadata. |
| `navigation.js` | The optional `nav` (nv 1) App / Navigation record from `src/diagnosticsNavigation.ts`, with vocabulary shared through `shared/diagnostics-navigation.js`. An invalid `nav` is dropped and the report still files. |
| `buffering.js` | The Buffering and quality section rendered from validated `bq`. |

Codes the client allows but the relay does not list still group, but render as "Unlisted code".
Automatic submission requires a failed incident.
For a network failure, recovery must also have reached `exhausted`.
The relay returns HTTP 422 `not_auto_reportable` for other automatic submissions with an incident.

## Grouping markers

| Report | Marker | Groups by |
| --- | --- | --- |
| With `inc` | `auger-group:inc1:<hash>` | App version, TV model, incident category, first failed operation, stage and code (the client's `incidentGroupKey`). |
| Viewer-observed, with an allowlisted `precedingScreen` | `auger-group:obs1:<hash>` | App version, TV model, selected category and screen. |
| App error with `nav` naming a known screen | `auger-group:nav1:<hash>` | App version, TV model, the screen in `nav` and the error name. Manual and automatic submissions of one error hash identically. A legacy `app:<name>` issue cannot name a screen, so it is never reused. |
| Anything else (installed clients) | `auger-fp:<hash>` | The deployed relay's legacy signature, so old clients keep finding their open issues after a title edit. |

Each marker hit is checked against the issue's embedded state before reuse, so a hash collision files a new issue.
An incident reuses a legacy issue only when the legacy signature names one failure (a start refusal reason, or a stage-qualified AVPlay error with matching first and last codes) and that issue's recorded events agree.
When both matches exist, the relay prefers the current incident marker.
If a later GitHub page fails, it uses the best match already verified or returns an error if it has none.
Concurrent requests in one Worker isolate share the legacy marker lock while matching and writing equivalent reports.
Generic legacy signatures such as a bare `playback_failed` or `session_expired` never absorb a current incident.
Existing titles and historical evidence are left untouched; reuse adds a comment.

## Tests

`test/native/fixtures/diagnostics-relay/relayCases.js` holds the relay cases as a plain ES module with no Node imports, so a browser harness on the TV can import it with `worker.js` and call `runRelayCases(handleRequest)`.
`test/native/diagnosticsRelay.test.ts` runs the same cases under `node:test`.
`navigationCases.js` and `test/native/diagnosticsNavigationRelay.test.ts` do the same for `nav`.
`bufferingCases.js` and `test/native/diagnosticsBufferingRelay.test.ts` do the same for Buffering / Quality reports with `runBufferingCases(handleRequest)`.

## Deploy

1. Create a fine-grained GitHub Personal Access Token scoped **only** to repository `Artic0din/Auger-Tizen` with permission **Issues: Read and write** (no code, actions, or other permissions).
2. Authenticate Wrangler and upload the secret:
   ```sh
   cd workers/diagnostics-relay
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN
   ```
   In the Cloudflare dashboard, add it as type **Secret**, not **Text**: every deploy replaces Text variables with the `[vars]` in `wrangler.toml`, and the Worker then answers each report with HTTP 503 `relay_not_configured`.
   The deploy workflow checks for the secret first and skips the deploy when it is missing.
3. Deploy the Worker and custom domain route:
   ```sh
   npx wrangler deploy
   ```
4. Verify with a test payload (close the test issue afterwards):
   ```sh
   curl -i -X POST https://auger-diagnostics.plaintextlab.com/report \
     -H 'Content-Type: application/json' \
     -d '{"v":1,"app":"0.2.1","tv":"QE65S95C"}'
   ```
