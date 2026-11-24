# Tests

Requires Node.js 26 or later (ES modules with native TypeScript type stripping) and Playwright Chromium.

```bash
npm ci
npx playwright install chromium
npm test
```

`npm test` runs both strict type checks, `npm run build`, `test/native/*.test.ts`, and `test/ui/*.test.ts`.

## Native suite (`npm run test:native`)

Runs the real API, session, catalog, and playback controllers against fake Silo, KeyManager, and AVPlay ports with no TV or network required.

- Covers auth, refresh/cleanup races, Profile Authority and PIN proofs, contract decoding, Library restrictions, playback identities, progress/STOP ordering, identical STOP retries, offset timelines, seek/close sequencing, track changes, and natural episode EOF handoff.
- `FakeAVPlay` enforces documented AVPlay states and retains uncancellable callbacks after teardown.
- Lost track-change replies cannot leave an obsolete local plan playing; definitive refusals preserve the active transport.

## UI suite (`npm run test:ui`)

Bundles the real TypeScript screens targeting Chrome 108 and runs two test files concurrently in desktop Chromium (limiting concurrency avoids timer/reply starvation on shared machines). `scripts/run-ui-tests.ts` serializes runs across worktrees via `/tmp/auger-ui-suite.lock` so only one UI suite runs per machine at a time. Playwright routes `/api/v2` calls to the fake Silo server and serves synthetic SVG artwork.

### Clock control and flake hunting

- **Pause before timed actions.** `openTv` installs a running browser clock, so `fastForward` alone lets host time consume deadlines between jumps. Call `pauseTvClock(tv)` before starting an exact deadline or intermediate animation, then advance explicitly with `tv.jump(ms)` or `page.clock.runFor(ms)`.
- **Wait on observable state.** Wait for `tv.pendingReplies === 0` or the screen's own DOM/state condition, never a fixed sleep. Unexpected page logs and errors fail the test.
- **Reproduce timing flakes.** Run with `SILO_REPLY_JITTER_MS=150` to inject random reply delays up to 150 ms and expose tests that act before in-flight reads settle.

### Suite coverage boundaries

- `test/ui/app.test.ts` composes real sign-in, Profiles, browse, and playback (including a production case importing `src/main.ts`) over fake ports, covering device-code approval, playback return, PIN-proof revocation during playback, sign-out/relaunch, protected-account restore, Exit modal key isolation, unavailable AVPlay, and startup failure recovery.
- Focused screen suites (`signIn`, `profiles`, `browse`, `settings`, `player`, `focusParity`, `rtl`, `accountsParity`) cover loading/failure/empty states, Skyline bar/menus, preplay audio/version/resume, seek preview and profile skip intervals, media-key registration, pressed looks, and reduced motion.
- Desktop Chromium and fake AVPlay prove behavior, not Chromium 108 rendering, real video/audio, or TV IME behavior. Verify hardware behavior separately per [docs/evidence/simulator-evidence.md](../docs/evidence/simulator-evidence.md).

## Captures, security, and quick checks

- Set `PLAYER_CAPTURE_DIR` to a directory outside the repository to save player screen test captures. Keep PR media outside Git and use inspected synthetic data.
- `.gitleaks.toml` keeps default rules and excludes only the pinned synthetic subtitle-path hash fixture.

```bash
npm run typecheck
node --check scripts/build.mjs
xmllint --noout app/config.xml
git diff --check
```
