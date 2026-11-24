# CI checks and workflows

This reference describes every status check that runs on pull requests in `Artic0din/Auger-Tizen`, what each check validates, and how those checks map to GitHub branch rulesets and `scripts/pr-gate.py`.

## Pull request checks

Every pull request runs 12 status checks, 10 from GitHub Actions workflows in `.github/workflows/` and 2 from external GitHub Apps.
In GitHub's pull request UI, Actions checks display as `<Workflow name> / <Job name>`.
Reusable workflow calls display as `<Caller workflow name> / <Caller job name> / <Callee job name>`.

| GitHub UI display name | Status check context | Source | What it checks |
| --- | --- | --- | --- |
| `Tizen Builds / Typecheck, build, and native unit tests` | `Typecheck, build, and native unit tests` | `.github/workflows/tizen-build.yml` (`checks`) | Runs strict TypeScript checks, builds `dist/wgt/`, and runs `test/native/*.test.ts`. |
| `Tizen Builds / Playwright UI tests (shard 1/3)` | `Playwright UI tests (shard 1/3)` | `.github/workflows/tizen-build.yml` (`ui`) | Runs shard 1 of 3 of the Playwright Chromium screen tests (`test/ui/*.test.ts`). |
| `Tizen Builds / Playwright UI tests (shard 2/3)` | `Playwright UI tests (shard 2/3)` | `.github/workflows/tizen-build.yml` (`ui`) | Runs shard 2 of 3 of the Playwright Chromium screen tests (`test/ui/*.test.ts`). |
| `Tizen Builds / Playwright UI tests (shard 3/3)` | `Playwright UI tests (shard 3/3)` | `.github/workflows/tizen-build.yml` (`ui`) | Runs shard 3 of 3 of the Playwright Chromium screen tests (`test/ui/*.test.ts`). |
| `Tizen Builds / All build and test checks` | `All build and test checks` | `.github/workflows/tizen-build.yml` (`test`) | Passes only when `Typecheck, build, and native unit tests` and all three UI shards succeed. |
| `Tizen Builds / Package and sign .wgt` | `Package and sign .wgt` | `.github/workflows/tizen-build.yml` (`package`) | Packages and signs `dist/Auger.wgt` with the Tizen public distributor certificate and uploads `auger-wgt`. |
| `CI Scripts and Guards / API v2 guard and automation script tests` | `API v2 guard and automation script tests` | `.github/workflows/ci-scripts.yml` (`test`) | Blocks `/api/v1` paths in app and test code and tests the repository's CI, release, parity, and PR-gate scripts. |
| `Security / Gitleaks secret scan` | `Gitleaks secret scan` | `.github/workflows/secrets.yml` (`gitleaks`) | Scans the commit range with pinned Gitleaks using the base commit's rules. |
| `Repository Checks / Standards / Repository baseline` | `Standards / Repository baseline` | `.github/workflows/baseline.yml` (`shared` calling `baseline`) | Verifies that required root documentation and config files exist. |
| `Repository Checks / Standards / Pull request hygiene` | `Standards / Pull request hygiene` | `.github/workflows/baseline.yml` (`shared` calling `pr-hygiene`) | Enforces Conventional Commits, AI attribution template rules, and forbidden-path bans. |
| `Kody Code Review` | `Kody Code Review` | External GitHub App (Kody) | Runs automated code review on the pull request diff and posts inline comments. |
| `Sourcery review` | `Sourcery review` | External GitHub App (Sourcery) | Runs automated code review on the pull request diff; may report `SKIPPED` when not applicable. |

### Tizen Builds (`.github/workflows/tizen-build.yml`)

This workflow runs on pull requests, pushes to `main`, and manual dispatch.
The workflow name stays `Tizen Builds` because `.github/workflows/release.yml` subscribes to `workflow_run` completions under that name.

- **Typecheck, build, and native unit tests (`checks`).** Installs dependencies with `npm ci`, runs `npm run build` (`tsc -p .`, `tsc -p tsconfig.test.json`, and `node scripts/build.mjs` targeting Chrome 108 into `dist/wgt/`), and runs `npm run test:native`.
  Native tests execute the API, session, catalog, and playback controllers in Node 26 against fake Silo, KeyManager, and AVPlay ports.
- **Playwright UI tests (shard 1/3, 2/3, 3/3) (`ui`).** Installs Playwright Chromium, runs `npm run build` for tests that inspect `dist/wgt/`, and runs one-third of `test/ui/*.test.ts` with `--test-concurrency=2 --test-timeout=60000`.
  Sharding keeps total runtime below the 20-minute job timeout.
- **All build and test checks (`test`).** Runs with `if: always()` after `checks` and all three `ui` shards finish, and fails unless every upstream job reports `success`.
  This gives the `main` branch ruleset a single stable check name covering the sharded test matrix.
- **Package and sign .wgt (`package`).** Installs the Tizen Studio Web CLI (`scripts/ci/install-tizen-cli.sh`), creates a public Tizen signing profile (`scripts/ci/create-signing-profile.sh`, refusing to continue unless `signing == public`), runs `scripts/build-wgt.sh`, writes `dist/Auger.wgt.sha256`, uploads the `auger-wgt` artifact for 7 days, and deletes temporary signing files afterward.
  No personal Samsung TV certificates or DUIDs are used.

### CI Scripts and Guards (`.github/workflows/ci-scripts.yml`)

This workflow runs on pull requests, pushes to `main`, and manual dispatch.

- **API v2 guard and automation script tests (`test`).** Runs eight script and guard steps in sequence:
  1. `bash scripts/ci/check-no-api-v1.test.sh` tests the `/api/v1` detector.
  2. `bash scripts/ci/check-no-api-v1.sh` fails if `app/`, `src/`, or `test/` (excluding `fixtures/`) references an `/api/v1` request path.
  3. `bash scripts/sync-apiv2-fixtures.test.sh` tests API v2 fixture synchronization.
  4. `python3 scripts/test-parity-drift.py` tests the upstream parity drift report script.
  5. `python3 scripts/test-release-version.py` tests semantic version bump selection from Conventional Commits.
  6. `python3 scripts/test-generate-changelog.py` tests release note generation and `CHANGELOG.md` updates.
  7. `python3 scripts/test-pr-gate.py` tests the local merge gate script (`scripts/pr-gate.py`).
  8. `scripts/ci/set-wgt-version.sh` verifies stamping a valid three-part version (`1.2.30`) into `app/config.xml` and rejecting an invalid two-part version (`1.2`).

### Security (`.github/workflows/secrets.yml`)

This workflow runs on pull requests and pushes to `main`.

- **Gitleaks secret scan (`gitleaks`).** Downloads Gitleaks `8.30.1`, verifies its SHA-256 checksum, and scans the commit range with `--diff-merges=remerge` so conflict-resolution edits in merge commits are inspected too.
  The job loads `.gitleaks.toml` and `.gitleaksignore` from the base commit and passes `--ignore-gitleaks-allow`, so a pull request cannot allowlist its own leaked secret.

### Repository Checks (`.github/workflows/baseline.yml`)

This workflow runs on pull request metadata and commit updates (`opened`, `edited`, `synchronize`, `reopened`) and on pushes to `main`.
It calls the pinned reusable workflow `Artic0din/devkit/.github/workflows/baseline.yml` under the caller job name `Standards`.
The callee job names (`Repository baseline` and `Pull request hygiene`) come from that shared workflow.

- **Standards / Repository baseline (`baseline`).** Checks that every required root file exists inside the checkout: `README.md`, `LICENSE`, `.gitignore`, `AGENTS.md`, and `CHANGELOG.md`.
- **Standards / Pull request hygiene (`pr-hygiene`, pull requests only).** Checks four rules for non-bot pull requests:
  1. The pull request title uses a Conventional Commit prefix (`feat`, `fix`, `test`, `refactor`, `perf`, `docs`, `style`, `chore`, `ci`, `build`, or `revert`).
  2. Every non-merge commit by the pull request author uses a Conventional Commit headline or starts with `Revert "`.
  3. Agent attribution rules match the base commit's pull request templates.
     Because `.github/PULL_REQUEST_TEMPLATE.md` requires an AI disclosure section, disclosure is permitted.
  4. No added, modified, renamed, or copied file touches a forbidden path (`node_modules` by default).

### External code review apps

Two third-party GitHub Apps report check runs directly on pull requests.
Their check names are set by the external apps and cannot be renamed in this repository's workflow files.

- **Kody Code Review.** Reviews pull request diffs, posts inline findings, and reports completion when the review finishes.
- **Sourcery review.** Reviews pull request diffs for bugs and clarity improvements; reports `SKIPPED` when no review runs for a pull request.

## Branch ruleset and merge gate

GitHub branch rulesets match each check by its status check context (the second column in the table above), not the top-level workflow name.
Keep the `main` ruleset (`Settings > Rules > Rulesets > main`) aligned with these six required contexts:

- `All build and test checks` (covers `Typecheck, build, and native unit tests` and all Playwright UI shards)
- `Package and sign .wgt`
- `API v2 guard and automation script tests`
- `Gitleaks secret scan`
- `Standards / Repository baseline`
- `Standards / Pull request hygiene`

When renaming a required check in a pull request, update the `main` ruleset as that pull request lands.
Updating the ruleset before merge breaks open pull requests still running the previous workflow names, and leaving the old names in the ruleset blocks subsequent pull requests after merge.

`scripts/pr-gate.py <PR>` checks the required check runs (including `Kody Code Review` and all three Playwright UI shards) plus mergeability and unresolved review threads before merging.

## Other repository workflows

Four workflows in `.github/workflows/` run on `main` pushes, schedules, or manual dispatch instead of pull requests:

| Workflow | File | Trigger | What it does |
| --- | --- | --- | --- |
| `Release` | `.github/workflows/release.yml` | After `Tizen Builds` succeeds on `main`, or `workflow_dispatch` | Chooses the next `vX.Y.Z` tag, builds and signs `Auger.wgt`, publishes the GitHub Release, and commits release notes to `CHANGELOG.md` (see [Releasing](releasing.md)). |
| `Parity drift` | `.github/workflows/parity-drift.yml` | Weekly Monday 08:00/09:00 Melbourne (`0 22 * * 0` UTC), or `workflow_dispatch` | Runs `scripts/parity-drift.py check` against upstream `silo-apple` and `silo-android` and opens, updates, or closes the single `Parity drift` issue. |
| `Deploy diagnostics Worker` | `.github/workflows/deploy-diagnostics-worker.yml` | Push to `main` touching `workers/diagnostics-relay/**`, or `workflow_dispatch` | Deploys `workers/diagnostics-relay/` to Cloudflare with pinned Wrangler. |
| `Deploy Diagnostics Helper` | `.github/workflows/pages.yml` | Push to `main` touching `pages/**`, or `workflow_dispatch` | Publishes the static `pages/` diagnostics helper site to GitHub Pages. |

## Running checks locally

Run the local equivalents before opening a pull request:

```sh
npm test                                    # Typecheck, build, native unit tests, and Playwright UI tests
bash scripts/ci/check-no-api-v1.sh          # /api/v1 path guard
gitleaks git --staged --redact              # Secret scan on staged changes
python3 scripts/pr-gate.py <PR_NUMBER>      # Merge gate status for an open PR
```

See [test/README.md](../test/README.md) for test boundaries and flake-hunting flags, and [Samsung simulator validation](evidence/simulator-evidence.md) for `.wgt` signing and simulator verification.
