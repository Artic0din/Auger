# Samsung simulator evidence

Use the Samsung TV Web Simulator (an NW.js desktop app, not the Tizen software emulator or a physical TV) to capture packaged Silo screens and remote navigation against a real Server. See Samsung's [TV Simulator guide](https://developer.samsung.com/smarttv/develop/tools/additional-tools/vscode/tv-simulator.html) for general usage.

Serialize simulator work on the Mac that also runs Xcode, and confirm ownership before replacing an installed app or changing screens.

## Build and hash the candidate

Run on the branch under review with dependencies installed ([README](../../README.md#build)). Keep certificates and security profiles outside the repository.

```bash
npm ci
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
shasum -a 256 dist/Auger.wgt
```

The `auger-wgt` artifact from a Tizen Builds CI run is the same signed package, with its hash in `Auger.wgt.sha256`. Record the source commit, uncommitted-diff identity (if any), package SHA-256, and simulator version, and keep a backup of any installed candidate you need to restore.

## Launch on macOS

Run from the simulator directory so relative resources resolve, using a fresh private profile directory so prior sign-in state stays isolated. Confirm no other person or agent owns the simulator first.

```bash
simulator_dir="${TIZEN_STUDIO_HOME:-$HOME/tizen-sdk}/tools/sec-tv-simulator"
simulator_profile="$(mktemp -d "${TMPDIR:-/tmp}/silo-tv-simulator.XXXXXX")"
cd "$simulator_dir"
./nwjs.app/Contents/MacOS/nwjs \
  --user-data-dir="$simulator_profile" \
  --remote-debugging-port=9333 \
  --disableInspector
```

Install the signed `Auger.wgt` through the simulator's app loader and launch the Auger tile. If launch throws `Cannot read properties of null (reading 'location')`, reload the shell and launch the tile again; treat repeated failure as a blocker. Keep remote debugging local only and close clients when finished.

## Transport, policy, and AVPlay proof boundaries

- **HTTPS baseline:** test against a valid HTTPS route without adding certificate bypasses or rewriting Server responses.
- **CORS and engine limits:** Samsung simulator 10.0.6 runs NW.js Chromium 137 with `--disable-web-security` in `nwjs.app/Contents/Resources/app.nw/package.json`. A 200 response there proves neither browser CORS headers nor physical-TV origin policy. Never infer the engine version from the TV user-agent string.
- **Content Security Policy:** `app/config.xml` keeps `script-src 'self'`, `style-src 'self'`, `img-src * data:` (for the generated grain tile), and `object-src 'self'` (required for Samsung's AVPlay `<object>` per the [AVPlay guide](https://developer.samsung.com/smarttv/develop/guides/multimedia/media-playback/using-avplay.html)). The policy regression test verifies these directives in Chromium; simulator `--disable-web-security` does not prove physical-TV CSP enforcement.
- **AVPlay limits:** the Web Simulator does not provide working AVPlay playback. Treat failed open/unavailable states there as failure-path evidence only, and keep synthetic AVPlay confined to automated tests. Real video/audio decoding, playback return, and physical-remote checks require a capable emulator or physical TV.

## Capture and verification steps

Complete every step before attaching simulator parity evidence to a pull request.

1. **Verify installed bytes.** Hash the installed app's changed JS, CSS, and assets inside the simulator and confirm they match the signed `Auger.wgt` bytes. The `.wgt` hash alone does not identify what is running.
2. **Match state across before/after and Apple TV.** Use identical Server, Profile, title, selection, focus, scroll, and settings. Record remote keys, loading/error states, request paths, and statuses without credentials or private hosts.
3. **Capture native app viewport.** Capture the app viewport (1920×1080 on Samsung), not the desktop or simulator shell. Wait for transitions to settle and confirm with a second frame when needed.
4. **Pair with real Apple TV.** Capture the matching state in the real Apple TV app and label both source commits and installed build IDs separately. Xcode Apple TV previews at 960×540 for a 1920×1080 logical screen may be paired beside Samsung at 50% only when scales are labeled explicitly; never upscale a preview and label it native.
5. **Use real TV Back.** Send TV Back key code `10009` for single-Back evidence; macOS `Esc` triggers a second Back in the simulator and invalidates focus-restoration checks. Disclose any CDP focus emulation used while a Mac screen is locked.
6. **Redact and clean up.** Keep raw captures private (dirs `700`, files `600`) and publish only redacted copies free of sign-in codes, server addresses, account names, DUIDs, credentials, and private media details (titles, artwork, and identifying metadata). Restore any mutated test state (including originally unset values), close Xcode and debugging clients, and release simulator ownership.

## Pull request acceptance

Record each proof layer separately: automated tests, signed `.wgt`, simulator, Apple TV comparison, and physical TV. List every unresolved difference under Risks. Documentation-only pull requests change no app behavior and write `Evidence: none, no user-visible change` per [.github/PULL_REQUEST_TEMPLATE.md](../../.github/PULL_REQUEST_TEMPLATE.md).
