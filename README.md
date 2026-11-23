# Silo Tizen

Samsung TV client for the [Silo](https://github.com/Silo-Server/silo-server) self-hosted media server.

This repo builds a Tizen web app (`.wgt`) for Samsung TVs running Tizen 8.0 or later.
The installed OS version, not the TV's model year, decides compatibility; earlier Tizen versions are not supported.
It talks to Silo's native `/api/v2` and plays through Samsung's AVPlay.
[FEATURES.md](FEATURES.md) lists what it does today and tracks parity with the Apple TV app.

## Install

The app is not in the Samsung TV store and will not be submitted to it.
Install it in one of two ways:

- **[Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung):** add this repository as a source (`github.com/Artic0din/silo-tizen`), then install from it.
  Apps2Samsung signs the app with your own Samsung certificate, so it installs on your TV without being listed in ours.
  It updates in one click when the app's version changes. It compares the version (`1.0.0`), not the build number, so to get a newer build of the same version, install it again from the source.
- **Sideload:** download a versioned build and its `.sha256` checksum from [Releases](https://github.com/Artic0din/silo-tizen/releases).
  [`silo-tizen-latest-beta.wgt`](https://github.com/Artic0din/silo-tizen/releases/download/beta-latest/silo-tizen-latest-beta.wgt) is always the newest build, but it has no checksum to check it against.
  It is signed with the maintainer's certificate, so it installs only on TVs listed in it; see [Releasing](docs/releasing.md#sideloading-a-build).

The two signatures differ, so to switch between Apps2Samsung and a sideloaded build, in either direction, uninstall the app first.
Uninstalling removes its data, so you sign in again afterwards.

## Screenshots

<p>
  <img src="docs/evidence/screenshots/readme/for-you.png" width="800" alt="For You on the Samsung TV simulator, built from main on 9 November 2026" />
</p>

## Layout

- `app/` - package manifest (`config.xml`), HTML entry, icon, fonts and third-party marks
- `src/api/`, `src/session/`, `src/contracts/v2/` - native transport, sessions, profile authority and contract decoders
- `src/ui/` - sign-in, profile/PIN, browse and settings screens, and remote focus
- `src/player/` - server playback plan, AVPlay transport, progress, final stop and track changes
- `scripts/` - build, packaging and release scripts
- `test/` - native contract tests and Playwright screen tests
- `docs/` - behaviour, design and validation notes; start with [App behaviour](docs/app-behaviour.md)

## Prerequisites

- Node.js 26 or later
- Tizen Studio Web CLI and a Certificate Manager security profile, for packaging
- A running Silo server for sign-in, browsing and playback validation
- A Samsung TV in Developer Mode, or the Samsung TV simulator, for runtime checks

## Build

Tizen 8.0 uses Chromium 108 ([Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
TypeScript checks ES2022 and DOM code in strict mode; tests additionally load Node types.
esbuild emits a classic script targeting `chrome108`.
Neither step supplies missing browser APIs or CSS support.

```sh
npm ci
npx playwright install chromium   # browser for the screen tests
npm run build
```

`scripts/build.mjs` stages `app/` into `dist/wgt/` and emits `js/main.js` and `js/main.css`.
The bundle's app version comes from `app/config.xml`.

## Test

`npm test` runs both strict type checks, the production build, native contract/session/player tests and Playwright screen/composition tests.
See [test/README.md](test/README.md) for the test boundaries, and [Samsung simulator evidence](docs/evidence/simulator-evidence.md) for the simulator recipe, signed-package identity checks and Apple TV comparisons.

## Signing

Packaging signs with a Tizen Studio Certificate Manager security profile.
Never commit certificates, profile XML or passwords.

```sh
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```

The script builds the package staging directory and writes `dist/Auger.wgt`.

CI builds the same package on every pull request and push to main (`.github/workflows/tizen-build.yml`).
On main and same-repository pull requests it signs with the maintainer's Samsung certificate from repository secrets and uploads `Auger.wgt` with its SHA-256 as the `silo-tizen-wgt` artifact.
That certificate lists the TVs it may install on, so a CI-signed package installs only on those TVs.

## Release Flow

Builds are made by the Release workflow from `main` and published on GitHub Releases; see [Releasing](docs/releasing.md).
The app ships by sideloading and through Apps2Samsung, not through the Samsung TV store.

## Contributing

Right now, the most helpful way to contribute is a clear, accurate issue. We
implement and review changes through our own workflow, and pull request volume
has outgrown what we can review carefully, so a good issue usually helps us
more than a pull request.

Pull requests are still welcome from contributors who've had one merged in a
Silo repository, or when a maintainer asks for one. We close other pull
requests without review. [CONTRIBUTING.md](CONTRIBUTING.md) explains what makes
an issue useful.

## License & Trademarks

Silo Tizen is licensed under `AGPL-3.0-or-later` with an additional
permission under AGPL section 7 allowing distribution through the Samsung TV
Apps store despite its signing, DRM, and redistribution terms. See
[LICENSE](LICENSE) and [APPSTORE-EXCEPTION.md](APPSTORE-EXCEPTION.md). A second
additional permission allows combining it with platform SDKs; see
[PLATFORM-EXCEPTION.md](PLATFORM-EXCEPTION.md).

The **Silo name, logo, and wordmark are trademarks of Silo Media L.L.C.** and
are **not** covered by the AGPL. You're free to fork and redistribute the code,
but forks and modified redistributions must not use the Silo brand as their
identity and must remove or replace the brand assets. Official, unmodified
builds may be redistributed under the Silo name with all notices kept intact.
Publishing a Silo-branded app to an app
store requires written permission. See [TRADEMARK.md](TRADEMARK.md) for what's
permitted — including referential use like "compatible with Silo."

Third-party code, fonts and marks retain their own licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
