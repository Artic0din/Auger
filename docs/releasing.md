# Releasing

Releases run from GitHub Actions on `main`.
Each run picks its own version and build number from the repository's tags.

The app ships by sideloading and through [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung).
It will not be submitted to the Samsung TV store (decided 22 Nov 2026, #732): store certification needs a public demo server with licence-free content, testing across many TV model groups and screen-flow paperwork.

## Tester build

Actions → **Release** → Run workflow, leaving `bump` on `build`.

The run tags the commit `v1.0.0-beta.23`, writes `1.0.0` into `app/config.xml`, and signs the package with the maintainer's Samsung certificate.
It publishes `silo-tizen-1.0.0-23.wgt` and its `.sha256` on a GitHub prerelease.
Its notes list the pull requests merged since the previous build, grouped by label (`.github/release.yml`).

It requires **Tizen Builds** to have passed on the commit, so run it once `main` is green.

The very first run has no tester build to continue from: enter the version to start with, such as `0.1.0`, as `version`.

If a run fails, use **Re-run failed jobs**: it keeps the same tag and build number.
Delete the tag instead only if that run never published its prerelease.
The next run refuses to start while the newest tag has no release, so its notes don't skip changes no tester got.

## Sideloading a build

The signing certificate lists the TVs it may install on (their DUIDs), so a build installs only on those TVs.
On a listed TV in Developer Mode, install the `.wgt` with Tizen Studio's Device Manager or `tizen install -n silo-tizen-1.0.0-23.wgt -t <device>`.
Check the file against its `.sha256` first.

## Installing with Apps2Samsung

In [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung), add this repository as a source (`apps2samsung-cli sources add github.com/Silo-Server/silo-tizen` from the command line) and install the app from it.
Apps2Samsung re-signs the `.wgt` with the user's own Samsung certificate, so the TV does not need to be listed in the maintainer's certificate, and its update button installs a newer release.
Because the signatures differ, a TV with a sideloaded build must uninstall the app before installing it through Apps2Samsung, and the reverse; uninstalling removes the app's data.

## Numbers

- `1.0.0` is the version people see, and the widget version in `config.xml`.
  It stays the same for every build until a Release run starts the next version with `bump: minor` (new features) or `bump: patch` (fixes only).
  Tizen limits it to `[0-255].[0-255].[0-65535]`.
- `23` is the build number: one counter for the whole repository that never resets.
- Tags: `vX.Y.Z-beta.B` for builds (GitHub prereleases).

## Latest tester build link

`releases/download/beta-latest/silo-tizen-latest-beta.wgt` always serves the newest tester build.
Every Release run moves the `beta-latest` tag to its commit and replaces that file on the "Latest tester build" prerelease, unless a newer tester build already exists.
