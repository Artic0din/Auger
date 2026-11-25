# Releasing

Every user-facing change that lands on `main` becomes a GitHub Release with a signed `Auger.wgt`.
Auger ships through [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung) and by sideloading.

## Automatic releases and tags

The **Release** workflow (`.github/workflows/release.yml`) runs after **Tizen Builds** succeeds on a `main` push.
`scripts/release-version.py` reads the Conventional Commit messages since the latest published release (or tester tag) and picks the bump:

| Commits since the latest release | Bump |
| --- | --- |
| `feat!:`, `fix(ui)!:` or any type with `!`, or a body line starting `BREAKING CHANGE:` | major (`1.4.2` to `2.0.0`) |
| `feat` | minor (`1.4.2` to `1.5.0`) |
| `fix`, `perf`, `revert`, or a `Revert "..."` subject | patch (`1.4.2` to `1.4.3`) |
| only `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build` or merge commits | no release |

The largest bump wins.
When the workflow releases, it writes `X.Y.Z` into `app/config.xml` and signs the `.wgt` with the Tizen SDK public distributor certificate (no personal Samsung TV certificates or DUIDs).
It then reserves the `vX.Y.Z` tag on the commit, publishes the release on that tag, and commits the release notes to `CHANGELOG.md` on `main`.
A commit that is already at or behind the latest published `vX.Y.Z` release never releases again, so re-runs are safe.

Only tags with a published GitHub Release count as released.
If a run stops after reserving its tag, the next run on that commit publishes the same version (`bump=recover`).
A run on a newer commit picks a version past the unpublished tag, and its notes still cover every commit since the last published release.

Tizen limits widget versions to `[0-255].[0-255].[0-65535]`, and the script refuses a version outside that range.

The older tester tags (`vX.Y.Z-beta.B`) count as their `X.Y.Z`, so the first automatic release after `v0.1.0-beta.3` is `v0.1.1`, `v0.2.0` or `v1.0.0`.

### Running a release by hand

Open **Actions**, select **Release**, and run it on `main`.
The commit must have passed **Tizen Builds**.

- `bump: auto` releases only when the commits call for it, as above.
- `bump: patch`, `minor` or `major` forces that bump from the latest tag.
- `version: X.Y.Z` releases exactly that version, which must be newer than the latest tag (or match an unpublished `vX.Y.Z` tag already on the target commit to recover it).

No mode releases a commit that is already released.

If a run fails, use **Re-run failed jobs**.
The publish step refreshes both assets and release notes on any leftover draft, skips tags that are already published, refuses a tag that points at another commit, and never demotes a newer Latest release.

## Release artifacts

Each release carries two files:

- `Auger.wgt`, the signed package, with `<widget version="X.Y.Z">` in its `config.xml`.
- `Auger.wgt.sha256`, its checksum.

Every release is marked Latest, so `https://github.com/Artic0din/Auger-Tizen/releases/latest/download/Auger.wgt` always serves the newest build.

## Release notes and the changelog

`scripts/generate-changelog.py` writes two records of each release from the commits since the previous release.

The GitHub Release body is for people who use Auger.
For each commit, the Release workflow reads the merged pull request named by its `(#123)` suffix and uses that pull request's `## Release Notes` section.
That section can hold `### Highlights`, `### Breaking Changes`, `### New`, `### Improved`, `### Security`, and `### Fixed` subheadings.
Text outside a subheading goes to the section the commit type implies, or to Improved for an internal commit type.
`None`, `N/A`, or `No user-visible changes` leaves the pull request out, unless the commit is breaking.
A pull request without that section falls back to a legacy `Release note:` line, then to the commit itself.
A pull request the workflow cannot read also falls back to its commit, so a GitHub API failure never blocks a release.
The body opens with `Released: YYYY-MM-DD`, then Breaking Changes, Highlights, New, Improved, Security, and Fixed, without emojis.
It ends with an **Install or update** section that points to the Apps2Samsung community catalog, and links to `CHANGELOG.md` and [Reporting bugs](reporting-bugs.md).

`CHANGELOG.md` is the technical record, written from the commits alone.
The commits also fill the GitHub Release body for pull requests without notes.
The generator reads commits with the same Conventional Commit rules as the version bump and groups them:

| Section | Commits |
| --- | --- |
| ⚠️ Breaking Changes | any type with `!`, or a `BREAKING CHANGE:` footer, whose text it uses when present |
| ✨ New Features | `feat` |
| 🔧 Improvements | `perf` |
| 🔒 Security | `fix` with the `security` or `sec` scope, or a subject naming a vulnerability, CVE, or secret leak |
| 🐛 Fixes | `fix`, `revert`, or a `Revert "..."` subject |

It leaves out `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build`, internal-scope fixes (`ci`, `docs`, `test`, `scripts`, `deps`, `build`), and merge commits unless they are breaking.
Each bullet drops the type prefix and the `(#123)` suffix, starts with a capital, and leads with the scope's area, such as `- **Playback**: Add chapters` for `feat(player): add chapters (#12)`.
Fixes read as plain sentences.
A release with no user-facing commits reads `General maintenance and stability improvements.`

The Release workflow uses the notes as the GitHub Release body, followed by an Install section (including the one-time reinstall note when upgrading from `0.1.0-beta.*`).
After publishing, a separate **Update CHANGELOG.md on main** job inserts `## [X.Y.Z] - YYYY-MM-DD` in descending version order below `<!-- changelog:releases -->` in `CHANGELOG.md` and pushes the `docs(changelog): record vX.Y.Z release notes` commit directly to `main` (retrying on concurrent pushes).
It pushes with the `CHANGELOG_DEPLOY_KEY` write deploy key, a secret of the `changelog` environment that only `main` can deploy to, the only actor besides repository admins that bypasses the `main` ruleset, and marks the commit `[skip ci]` so it never starts Tizen Builds or another release.
A changelog that already has the version stays unchanged.
If the changelog job fails after the release is published, use **Re-run failed jobs** to retry only the changelog update, or add the section locally with:

```sh
python3 scripts/generate-changelog.py update --file CHANGELOG.md --version X.Y.Z --from vPREVIOUS --to vX.Y.Z
```

Preview the GitHub Release body locally with `python3 scripts/generate-changelog.py release --version X.Y.Z --from <tag>`, adding `--pr-notes-file PR.json` (`{"123": "<pull request body>"}`) to include pull request notes.
`.github/release.yml` groups only the notes from GitHub's **Generate release notes** button.

## Installing and updating with Apps2Samsung

Auger is listed in the [Apps2Samsung community catalog](https://github.com/Apps2Samsung/tizen-community-packages/blob/main/packages/Artic0din__Auger-Tizen.json), which automatically tracks each new `vX.Y.Z` GitHub Release.

1. Open Apps2Samsung and find **Auger** under **Media servers & players**.
2. Install Auger directly from the catalog.
   Apps2Samsung re-signs the `.wgt` with your own Samsung certificate, so it installs straight onto your TV.
3. Update with one click.
   Every release raises `X.Y.Z` in `app/config.xml`, so Apps2Samsung's updater sees every release.

Do not add `github.com/Artic0din/Auger-Tizen` as a custom source unless you are testing an unlisted build.
Adding it alongside the community catalog creates a duplicate `Unverified · Auger-Tizen` entry, which can be removed in Apps2Samsung under **Settings > Installing > Your sources**.

Upgrading from a `0.1.0-beta.*` build requires uninstalling the older build first, because the package ID is now `AugerTv001.Auger` and Tizen treats a new package ID as a separate app.
Uninstalling removes saved sign-in data, so you sign in again once; subsequent builds with `AugerTv001.Auger` update in place within the same install method (Apps2Samsung or sideloading).

## Sideloading a build

Public GitHub Releases use the Tizen SDK public distributor certificate so no personal TV DUID is embedded in public artifacts.
To sideload directly onto a Samsung TV in Developer Mode, build and sign locally with your own Samsung certificate profile:

1. Create a Samsung author and distributor certificate profile in Tizen Studio Certificate Manager for your TV's DUID.
2. Clone the release tag into a temporary directory (`git clone --depth 1 --branch vX.Y.Z https://github.com/Artic0din/Auger-Tizen.git auger-release && cd auger-release`), install dependencies (`npm ci`), and stamp its version into `app/config.xml`: `scripts/ci/set-wgt-version.sh X.Y.Z`.
3. Package locally: `export TIZEN_SECURITY_PROFILE="YourProfileName" && ./scripts/build-wgt.sh`.
4. Install through Tizen Studio Device Manager or run `tizen install -n dist/Auger.wgt -t <device>`, then delete the temporary `auger-release` directory when done.

## Switching between Apps2Samsung and a sideloaded build

Apps2Samsung and a local Tizen Studio profile sign with different certificates.
Uninstall Auger before switching in either direction.
Uninstalling clears the app's data, so you sign in again afterwards.
