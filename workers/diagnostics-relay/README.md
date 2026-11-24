# Auger Diagnostics Relay (Cloudflare Worker)

Stateless Cloudflare Worker that accepts redacted v1 diagnostic reports from Auger (`Settings > Diagnostics > Send Diagnostics Report`) at `https://auger-diagnostics.plaintextlab.com/report`, validates and re-redacts every field, enforces a bounded 8 KiB streaming body limit and an atomic per-IP Cloudflare Workers Rate Limiting binding (`DIAGNOSTICS_RATE_LIMITER`, 5 reports per 60 seconds), and opens a GitHub issue on `Artic0din/Auger-Tizen` labelled `bug` and `needs-triage`.

No secrets are ever shipped inside Auger or committed to this repository.

## Deploy

1. Create a fine-grained GitHub Personal Access Token scoped **only** to repository `Artic0din/Auger-Tizen` with permission **Issues: Read and write** (no code, actions, or other permissions).
2. Authenticate Wrangler and upload the secret:
   ```sh
   cd workers/diagnostics-relay
   npx wrangler login
   npx wrangler secret put GITHUB_TOKEN
   ```
3. Deploy the Worker and custom domain route:
   ```sh
   npx wrangler deploy
   ```
4. Verify with a test payload (close the test issue afterwards):
   ```sh
   curl -i -X POST https://auger-diagnostics.plaintextlab.com/report \
     -H 'Content-Type: application/json' \
     -d '{"v":1,"app":"0.2.1","tv":"SmokeTest"}'
   ```
