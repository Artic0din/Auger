#!/usr/bin/env python3

import importlib.util
from pathlib import Path
import unittest


SCRIPT_DIR = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_version", SCRIPT_DIR / "release-version.py")
assert spec is not None and spec.loader is not None
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

Commit = release.CommitMessage
Bump = release.BumpLevel
BETAS = ["v0.1.0-beta.1", "v0.1.0-beta.2", "v0.1.0-beta.3"]


def plan(tags, *subjects, **options):
    return release.plan_release(tags, [Commit(subject) for subject in subjects], **options)


class ClassifyCommitTest(unittest.TestCase):
    def test_types(self):
        cases = {
            "feat: add search": Bump.MINOR,
            "feat(player): add chapters (#12)": Bump.MINOR,
            "Feat: upper-case type": Bump.MINOR,
            "fix: stop a crash": Bump.PATCH,
            "perf(ui): faster grid": Bump.PATCH,
            "revert: undo the grid": Bump.PATCH,
            'Revert "feat: add search"': Bump.PATCH,
            "feat!: drop Tizen 7": Bump.MAJOR,
            "fix(ui)!: change the remote keys": Bump.MAJOR,
            "Merge pull request #5 from Artic0din/Auger": Bump.NONE,
            "update readme": Bump.NONE,
            "feat:missing space": Bump.NONE,
        }
        for kind in ("docs", "chore", "ci", "test", "refactor", "style", "build"):
            cases[f"{kind}(repo): tidy"] = Bump.NONE
        for subject, level in cases.items():
            with self.subTest(subject):
                self.assertEqual(level, release.classify_commit(Commit(subject)))

    def test_breaking_change_footer(self):
        for footer in ("BREAKING CHANGE: settings reset", "BREAKING-CHANGE: settings reset"):
            with self.subTest(footer):
                commit = Commit("chore(settings): rename keys", f"Renames every key.\n\n{footer}")
                self.assertEqual(Bump.MAJOR, release.classify_commit(commit))

    def test_breaking_change_must_start_a_line(self):
        commit = Commit("fix: wording", "Mentions a BREAKING CHANGE: in passing.")
        self.assertEqual(Bump.PATCH, release.classify_commit(commit))


class LatestTagTest(unittest.TestCase):
    def test_newest_beta_when_only_betas_exist(self):
        self.assertEqual("v0.1.0-beta.3", release.latest_tag(BETAS).name)
        self.assertEqual("v0.1.0-beta.10", release.latest_tag([*BETAS, "v0.1.0-beta.10"]).name)

    def test_stable_outranks_its_prereleases(self):
        tags = ["v0.2.0-beta.1", "v0.2.0", "v0.2.0-beta.4", *BETAS]
        latest = release.latest_tag(tags)
        self.assertEqual("v0.2.0", latest.name)
        self.assertFalse(latest.is_prerelease)

    def test_legacy_build_metadata_tags(self):
        tag = release.parse_tag("v1.0.0+21")
        self.assertEqual(release.SemVer(1, 0, 0), tag.version)
        self.assertTrue(tag.is_prerelease)
        self.assertEqual("v1.0.0", release.latest_tag(["v1.0.0+21", "v1.0.0"]).name)

    def test_unrelated_tags_are_ignored(self):
        self.assertIsNone(release.latest_tag(["wip/x", "v2", "v1.2", "release-1.0.0"]))
        self.assertEqual("v0.2.0", release.latest_tag(["wip/x", "v2", "v0.2.0"]).name)


class AutoBumpTest(unittest.TestCase):
    def test_highest_bump_wins(self):
        self.assertEqual("patch", plan(["v1.0.0"], "docs: a", "fix: b", "chore: c").bump)
        self.assertEqual("minor", plan(["v1.0.0"], "fix: b", "feat: c", "docs: d").bump)
        self.assertEqual("major", plan(["v1.0.0"], "feat: c", "fix!: e", "fix: b").bump)

    def test_no_user_facing_change_makes_no_release(self):
        result = plan(["v1.0.0"], "docs: a", "chore: b", "ci: c", "test: d")
        self.assertEqual(release.ReleasePlan(False, "", "", "v1.0.0", "none"), result)
        self.assertFalse(plan(["v1.0.0"]).should_release)

    def test_from_legacy_beta_tags(self):
        self.assertEqual(
            release.ReleasePlan(True, "0.1.1", "v0.1.1", "v0.1.0-beta.3", "patch"),
            plan(BETAS, "fix: a"),
        )
        self.assertEqual("v0.2.0", plan(BETAS, "feat: a").tag)
        self.assertEqual("v1.0.0", plan(BETAS, "feat!: a").tag)

    def test_from_a_stable_tag(self):
        tags = ["v0.2.0-beta.1", "v0.2.0", *BETAS]
        self.assertEqual(
            release.ReleasePlan(True, "0.2.1", "v0.2.1", "v0.2.0", "patch"),
            plan(tags, "fix: a"),
        )
        self.assertEqual("v0.3.0", plan(tags, "feat: a").tag)

    def test_without_tags(self):
        self.assertEqual(release.ReleasePlan(True, "0.1.0", "v0.1.0", "", "minor"), plan([], "feat: a"))
        self.assertEqual("v0.0.1", plan([], "fix: a").tag)

    def test_already_released_target_makes_no_release(self):
        result = plan(["v1.0.0"], "feat: a", target_already_released=True)
        self.assertEqual(release.ReleasePlan(False, "", "", "v1.0.0", "none"), result)


class ManualBumpTest(unittest.TestCase):
    def test_from_legacy_beta_tags(self):
        self.assertEqual("v0.1.1", plan(BETAS, mode="patch").tag)
        self.assertEqual("v0.2.0", plan(BETAS, mode="minor").tag)
        self.assertEqual(
            release.ReleasePlan(True, "1.0.0", "v1.0.0", "v0.1.0-beta.3", "major"),
            plan(BETAS, "docs: a", mode="major"),
        )

    def test_already_released_target_makes_no_release(self):
        result = plan(["v0.2.1"], mode="patch", target_already_released=True)
        self.assertEqual(release.ReleasePlan(False, "", "", "v0.2.1", "none"), result)

    def test_unknown_mode(self):
        with self.assertRaisesRegex(release.ReleaseError, "Unknown bump"):
            plan(BETAS, mode="build")


class ExplicitVersionTest(unittest.TestCase):
    def test_first_release(self):
        self.assertEqual(
            release.ReleasePlan(True, "0.1.0", "v0.1.0", "", "explicit"),
            plan([], explicit_version="0.1.0"),
        )

    def test_overrides_the_bump(self):
        self.assertEqual("v1.0.0", plan(BETAS, "docs: a", mode="patch", explicit_version="v1.0.0").tag)

    def test_must_be_newer_than_the_latest_tag(self):
        with self.assertRaisesRegex(release.ReleaseError, "not newer"):
            plan(BETAS, explicit_version="0.1.0")
        with self.assertRaisesRegex(release.ReleaseError, "not newer"):
            plan(["v0.2.0"], explicit_version="0.1.9")
        with self.assertRaisesRegex(release.ReleaseError, "look like"):
            plan(BETAS, explicit_version="1.2")


class TizenLimitsTest(unittest.TestCase):
    def test_limits(self):
        self.assertEqual("255.255.65535", plan([], explicit_version="255.255.65535").version)
        for version in ("256.0.0", "1.256.0", "1.0.65536"):
            with self.subTest(version), self.assertRaisesRegex(release.ReleaseError, "Tizen version"):
                plan([], explicit_version=version)

    def test_bump_past_the_limit(self):
        with self.assertRaisesRegex(release.ReleaseError, "Tizen version"):
            plan(["v255.0.0"], "feat!: a")


class ParseGitLogTest(unittest.TestCase):
    def test_multi_line_bodies(self):
        output = (
            "feat(ui): add search (#7)\x1fFirst line.\n\nBREAKING CHANGE: keys moved\n\x1e\n"
            "docs: readme\x1f\x1e\n"
        )
        self.assertEqual(
            [
                Commit("feat(ui): add search (#7)", "First line.\n\nBREAKING CHANGE: keys moved"),
                Commit("docs: readme", ""),
            ],
            release.parse_git_log(output),
        )
        self.assertEqual([], release.parse_git_log(""))


if __name__ == "__main__":
    unittest.main()
