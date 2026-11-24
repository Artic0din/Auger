# Auger

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="Auger, a Silo client for Samsung TV. An independent project, not affiliated with Silo Media L.L.C." />
</p>

Auger is a third-party Samsung TV client for [Silo](https://siloserver.org), the self-hosted media server.
It is not made by, endorsed by, or affiliated with Silo Media L.L.C.

It is a Tizen web app (`.wgt`) for Samsung TVs running Tizen 8.0 or later.
The installed OS version, not the TV's model year, decides compatibility; earlier Tizen versions are not supported.
[FEATURES.md](FEATURES.md) lists what it does today and tracks parity with Silo's Apple TV app.

## How it works

<p align="center">
  <img src="./assets/readme/how-it-works.svg" width="100%" alt="Auger on a Samsung TV signs in to your Silo server, browses it over /api/v2, and plays the stream the server plans through Samsung's AVPlay." />
</p>

1. **Sign in.** Approve a device code from another device, or use a password, then pick a profile and enter its PIN if it has one.
2. **Browse.** Auger reads your libraries through Silo's native `/api/v2`, and nothing else.
3. **Play.** The server plans Direct Play, Remux or an HLS Transcode from what the TV can decode, and Samsung's AVPlay plays it.

## Screenshots

| Home | Movies |
| --- | --- |
| ![Auger Home screen](./assets/readme/home.jpg) | ![Auger Movies library](./assets/readme/movies.jpg) |

| Series Details | Search |
| --- | --- |
| ![Auger Series Details](./assets/readme/series-details.jpg) | ![Auger Search](./assets/readme/search.jpg) |

## Install

Auger ships through Apps2Samsung and GitHub Releases.
Install it in one of two ways:

- **[Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) (recommended):** add this repository as a source (`github.com/Artic0din/Auger-Tizen`), then install from it.
  Apps2Samsung signs `Auger.wgt` with your own Samsung certificate and updates it in one click when a new release ships.
- **Sideload from source:** public releases are signed with the Tizen SDK public certificate (no personal TV DUIDs), so direct `tizen install` requires building and signing locally with your own Samsung TV certificate profile; see [Releasing](docs/releasing.md#sideloading-a-build).

The two signatures differ, so to switch between Apps2Samsung and a sideloaded build, in either direction, uninstall the app first.
Upgrading from a `0.1.0-beta.*` build also requires uninstalling first because the Tizen package ID changed to `AugerTv001.Auger`; subsequent builds with `AugerTv001.Auger` update in place within the same install method.
Uninstalling removes its data, so you sign in again afterwards.

## Build from source

You need:

- Node.js 26 or later
- Tizen Studio Web CLI and a Certificate Manager security profile, for packaging
- A running Silo server for sign-in, browsing and playback validation
- A Samsung TV in Developer Mode, or the Samsung TV simulator, for runtime checks

```sh
npm ci
npx playwright install chromium   # browser for the screen tests
npm run build
```

`scripts/build.mjs` stages `app/` into `dist/wgt/` and emits `js/main.js` and `js/main.css`.
The bundle's app version comes from `app/config.xml`.

Tizen 8.0 uses Chromium 108 ([Samsung web engine specifications](https://developer.samsung.com/smarttv/develop/specifications/web-engine-specifications.html)).
TypeScript checks ES2022 and DOM code in strict mode; tests additionally load Node types.
esbuild emits a classic script targeting `chrome108`.
Neither step supplies missing browser APIs or CSS support.

### Test

`npm test` runs both strict type checks, the production build, native contract/session/player tests and Playwright screen/composition tests.
See [test/README.md](test/README.md) for the test boundaries, and [Samsung simulator evidence](docs/evidence/simulator-evidence.md) for the simulator recipe, signed-package identity checks and Apple TV comparisons.

### Sign and package

Packaging signs with a Tizen Studio Certificate Manager security profile.
Never commit certificates, profile XML or passwords.

```sh
export TIZEN_SECURITY_PROFILE="YourProfileName"
./scripts/build-wgt.sh
```

The script builds the package staging directory and writes `dist/Auger.wgt`.

CI builds the same package on every pull request and push to main (`.github/workflows/tizen-build.yml`).
It signs with the Tizen SDK public distributor certificate (never embedding personal Samsung TV certificates or DUIDs) and uploads `Auger.wgt` with its SHA-256 as the `auger-wgt` artifact.
Apps2Samsung re-signs the release `.wgt` with each user's own Samsung certificate; direct TV sideloading signs locally with your own Certificate Manager profile.

### Release

After CI passes on `main`, the Release workflow reads the Conventional Commits since the last tag, tags `vX.Y.Z`, and publishes `Auger.wgt` on GitHub Releases; see [Releasing](docs/releasing.md).

<details>
<summary>Repository layout</summary>

- `app/` holds the package manifest (`config.xml`), HTML entry, icon, fonts, and third-party marks.
- `src/api/`, `src/session/`, and `src/contracts/v2/` own `/api/v2` transport, sessions, active Profile Authority, and contract decoders.
- `src/ui/` owns screens and remote focus; `src/player/` owns AVPlay playback.
- `scripts/` holds build, packaging, fixture sync, and release scripts; `test/` holds native and Playwright screen tests.
- `assets/readme/` holds the images on this page.
- [GLOSSARY.md](GLOSSARY.md) and [docs/domain-model.md](docs/domain-model.md) define canonical terms and entity rules.
- `docs/` holds behavior, focus, API, feature, and validation docs; use [docs/README.md](docs/README.md) as the index and [docs/app-behaviour.md](docs/app-behaviour.md) for current runtime behavior.
- [AGENTS.md](AGENTS.md) holds coding-agent context pointers, platform invariants, and parity gates.

</details>

## Contributing

Right now, the most helpful way to contribute is a clear, accurate issue.
We implement and review changes through our own workflow, so a good issue usually helps us more than a pull request.

Pull requests are welcome when a accompanied by an issue.
We close other pull requests without review.
[CONTRIBUTING.md](CONTRIBUTING.md) explains what makes an issue useful, and [docs/reporting-bugs.md](docs/reporting-bugs.md) shows where to find your TV model, Auger version, and the player's **Stats** tab.

Problems with the server or its API belong in [silo-server](https://github.com/Silo-Server/silo-server/issues/new/choose), not here.

## Credits

- **Silo.** Auger is an independent client for [Silo](https://siloserver.org).
- **Silo's TV apps.** The interface follows Silo's [Skyline design guide](https://github.com/Silo-Server/silo-apple/blob/main/docs/skyline-design-guide.md).
  Behavior is ported from [silo-apple](https://github.com/Silo-Server/silo-apple) and compared with [silo-android](https://github.com/Silo-Server/silo-android).

## License and trademarks

Auger is licensed under `AGPL-3.0-or-later`; see [LICENSE](LICENSE).
An additional permission under AGPL section 7 allows combining it with platform SDKs; see [PLATFORM-EXCEPTION.md](PLATFORM-EXCEPTION.md).

Silo and the Silo logo are trademarks of Silo Media L.L.C.

The Auger mark and wordmark are this project's own artwork.
[TRADEMARK.md](TRADEMARK.md) summarizes Auger's trademark notice and links to Silo's canonical policy.

Samsung, Tizen, Apple TV, TMDB and other names belong to their owners.
Third-party code, fonts and marks retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
