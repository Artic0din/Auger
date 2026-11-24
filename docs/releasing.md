# Releasing

Every user-facing change that lands on `main` becomes a GitHub Release with a signed `Auger.wgt`.
Auger ships through [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) and by sideloading.

## Automatic releases and tags

The **Release** workflow (`.github/workflows/release.yml`) runs after **Tizen Builds** succeeds on a `main` push.
`scripts/release-version.py` reads the Conventional Commit messages since the latest `v*` tag and picks the bump:

| Commits since the latest tag | Bump |
| --- | --- |
| `feat!:`, `fix(ui)!:` or any type with `!`, or a body line starting `BREAKING CHANGE:` | major (`1.4.2` to `2.0.0`) |
| `feat` | minor (`1.4.2` to `1.5.0`) |
| `fix`, `perf`, `revert`, or a `Revert "..."` subject | patch (`1.4.2` to `1.4.3`) |
| only `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build` or merge commits | no release |

The largest bump wins.
When the workflow releases, it writes `X.Y.Z` into `app/config.xml`, signs the `.wgt` with the maintainer's Samsung certificate, and creates the `vX.Y.Z` tag together with the release.
A commit that is already at or behind the latest `vX.Y.Z` tag never releases again, so re-runs are safe.

Tizen limits widget versions to `[0-255].[0-255].[0-65535]`, and the script refuses a version outside that range.

The older tester tags (`vX.Y.Z-beta.B`) count as their `X.Y.Z`, so the first automatic release after `v0.1.0-beta.3` is `v0.1.1`, `v0.2.0` or `v1.0.0`.

### Running a release by hand

Open **Actions**, select **Release**, and run it on `main`.
The commit must have passed **Tizen Builds**.

- `bump: auto` releases only when the commits call for it, as above.
- `bump: patch`, `minor` or `major` forces that bump from the latest tag.
- `version: X.Y.Z` releases exactly that version, which must be newer than the latest tag.

If a run fails, use **Re-run failed jobs**.
The publish step refreshes both assets and release notes on any leftover draft, skips tags that are already published, and never demotes a newer Latest release.

## Release artifacts

Each release carries two files:

- `Auger.wgt`, the signed package, with `<widget version="X.Y.Z">` in its `config.xml`.
- `Auger.wgt.sha256`, its checksum.

Every release is marked Latest, so `https://github.com/Artic0din/Auger/releases/latest/download/Auger.wgt` always serves the newest build.
Release notes are generated from merged pull requests and grouped by `.github/release.yml`.

## Installing and updating with Apps2Samsung

1. Add this repository as a source: run `apps2samsung-cli sources add github.com/Artic0din/Auger`, or use **Settings > Installing > Your sources** in the app.
2. Install Auger from that source.
   Apps2Samsung re-signs the `.wgt` with your own Samsung certificate, so your TV needs no listing in the maintainer's certificate.
3. Update with one click.
   Every release raises `X.Y.Z` in `app/config.xml`, so Apps2Samsung's updater sees every release.

Upgrading from a `0.1.0-beta.*` build requires uninstalling the older build first, because the package ID is now `AugerTv001.Auger` and Tizen treats a new package ID as a separate app.
Uninstalling removes saved sign-in data, so you sign in again once; subsequent builds with `AugerTv001.Auger` update in place within the same install method (Apps2Samsung or sideloading).

### Community catalog

[`docs/apps2samsung/Artic0din__Auger.json`](apps2samsung/Artic0din__Auger.json) is a manifest for the [Apps2Samsung community catalog](https://github.com/Apps2Samsung/tizen-community-packages).
It is ready to submit to that repository's `packages/` folder once it is reviewed and a first `vX.Y.Z` release is live.

## Sideloading a build

The maintainer's certificate lists the TV DUIDs it allows, so a sideloaded build installs only on those TVs.

1. Download `Auger.wgt` and `Auger.wgt.sha256` from [GitHub Releases](https://github.com/Artic0din/Auger/releases).
2. Check the file with `sha256sum --check Auger.wgt.sha256`.
3. On a listed TV in Developer Mode, install it through Tizen Studio Device Manager or run `tizen install -n Auger.wgt -t <device>`.

## Switching between Apps2Samsung and a sideloaded build

Apps2Samsung and the maintainer sign with different certificates.
Uninstall Auger before switching in either direction.
Uninstalling clears the app's data, so you sign in again afterwards.
