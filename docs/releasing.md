# Releasing

Releases run from GitHub Actions on `main` and compute version and build numbers from repository tags. Auger ships by sideloading and through [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung). It is not submitted to the Samsung TV store ([#732](https://github.com/Artic0din/silo-tizen/issues/732)).

## Publishing a tester build

1. Confirm **Tizen Builds** passed on the target `main` commit.
2. Open **Actions**, select **Release**, and run the workflow with `bump` left on `build`. (On the very first release with no prior tag, supply a starting `version` such as `0.1.0`.)
3. Verify the run tags `vX.Y.Z-beta.B`, writes `X.Y.Z` into `app/config.xml`, signs `silo-tizen-X.Y.Z-B.wgt` with the maintainer's Samsung certificate, and publishes the `.wgt` and `.sha256` on a GitHub prerelease grouped by `.github/release.yml`.

If a run fails, use **Re-run failed jobs** to keep the same tag and build number. Delete the tag only if the run never published a prerelease; the next run refuses to start while the newest tag has no release.

## Sideloading a build

The maintainer's certificate lists allowed TV DUIDs, so a sideloaded build installs only on those TVs.

1. Download the versioned `.wgt` and `.sha256` from GitHub Releases and verify the checksum.
2. On a listed TV in Developer Mode, install through Tizen Studio Device Manager or run `tizen install -n silo-tizen-1.0.0-23.wgt -t <device>`.

## Installing with Apps2Samsung

1. Add this repository as a source in [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) (`apps2samsung-cli sources add github.com/Artic0din/Auger`) and install from it. Apps2Samsung re-signs the `.wgt` with the user's own Samsung certificate, so the TV needs no listing in the maintainer's certificate.
2. When upgrading to a newer build with the same widget version in `config.xml`, install from the source again because Apps2Samsung's update button compares only `X.Y.Z`, not the build number.
3. Uninstall the existing app before switching between a sideloaded build and Apps2Samsung in either direction because their signatures differ; uninstalling clears app data.

## Version and tag scheme

- **Version (`X.Y.Z`):** user-visible widget version in `app/config.xml`, constrained by Tizen to `[0-255].[0-255].[0-65535]`. Keep the same version across beta builds; start a new version by entering it in the `version` workflow input. `bump: minor` and `bump: patch` count from exact `vX.Y.Z` tags, so they stop with "Nothing has been released yet" (`scripts/release-version.py`) while only `vX.Y.Z-beta.B` tags exist.
- **Build number (`B`):** single monotonically increasing counter across the repository.
- **Tags:** `vX.Y.Z-beta.B` for GitHub prereleases.

## Latest tester build link

`releases/download/beta-latest/silo-tizen-latest-beta.wgt` always serves the newest tester build without a `.sha256` file; use the versioned release file when checksum verification is required. Each Release run moves `beta-latest` to its commit and replaces that file unless a newer tester build already exists.
