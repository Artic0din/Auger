#!/usr/bin/env python3

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import tempfile
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
            "Merge pull request #5 from Artic0din/Auger-Tizen": Bump.NONE,
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

    def test_newer_beta_outranks_an_older_exact_tag(self):
        tags = ["v0.1.0", "v0.2.0-beta.1", "v0.2.0-beta.2", *BETAS]
        latest = release.latest_tag(tags)
        self.assertEqual("v0.2.0-beta.2", latest.name)
        self.assertTrue(latest.is_prerelease)

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

    def test_from_a_beta_tag_newer_than_an_exact_tag(self):
        tags = ["v0.1.0", "v0.2.0-beta.1", "v0.2.0-beta.2"]
        self.assertEqual(
            release.ReleasePlan(True, "0.2.1", "v0.2.1", "v0.2.0-beta.2", "patch"),
            plan(tags, "fix: a"),
        )
        self.assertEqual(
            release.ReleasePlan(True, "0.3.0", "v0.3.0", "v0.2.0-beta.2", "minor"),
            plan(tags, "feat: a"),
        )
        self.assertEqual("v1.0.0", plan(tags, "feat!: a").tag)

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

    def test_from_a_beta_tag_newer_than_an_exact_tag(self):
        tags = ["v0.1.0", "v0.2.0-beta.1"]
        self.assertEqual(
            release.ReleasePlan(True, "0.2.1", "v0.2.1", "v0.2.0-beta.1", "patch"),
            plan(tags, mode="patch"),
        )
        self.assertEqual("v0.3.0", plan(tags, mode="minor").tag)

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
        with self.assertRaisesRegex(release.ReleaseError, "not newer than the latest tag, v0.2.0-beta.1"):
            plan(["v0.1.0", "v0.2.0-beta.1"], explicit_version="0.2.0")
        self.assertEqual("v0.2.1", plan(["v0.1.0", "v0.2.0-beta.1"], explicit_version="0.2.1").tag)
        with self.assertRaisesRegex(release.ReleaseError, "not newer"):
            plan(["v0.2.0"], explicit_version="0.1.9")
        with self.assertRaisesRegex(release.ReleaseError, "look like"):
            plan(BETAS, explicit_version="1.2")

    def test_already_released_target_makes_no_release(self):
        result = plan(["v0.1.0"], "feat: a", explicit_version="0.2.0", target_already_released=True)
        self.assertEqual(release.ReleasePlan(False, "", "", "v0.1.0", "none"), result)

    def test_must_be_newer_than_an_unpublished_tag(self):
        with self.assertRaisesRegex(release.ReleaseError, "not newer than the latest tag, v0.2.0"):
            plan(["v0.1.0", "v0.2.0"], explicit_version="0.2.0", published_exact_tags={"v0.1.0"})


class UnpublishedTagTest(unittest.TestCase):
    def test_recovers_the_tag_on_the_target(self):
        tag = release.parse_tag("v0.1.1")
        result = plan(["v0.1.0", "v0.1.1"], "fix: a", published_exact_tags={"v0.1.0"}, unpublished_target_tag=tag)
        self.assertEqual(release.ReleasePlan(True, "0.1.1", "v0.1.1", "v0.1.0", "recover"), result)
        self.assertEqual("recover", plan(["v0.1.0", "v0.1.1"], mode="major", unpublished_target_tag=tag).bump)

    def test_explicit_version_recovers_matching_unpublished_tag(self):
        tag = release.parse_tag("v1.3.7")
        result = plan(
            ["v0.1.0", "v1.3.7"], explicit_version="1.3.7", published_exact_tags={"v0.1.0"}, unpublished_target_tag=tag
        )
        self.assertEqual(release.ReleasePlan(True, "1.3.7", "v1.3.7", "v0.1.0", "recover"), result)

    def test_explicit_version_skips_recovery_for_higher_override(self):
        tag = release.parse_tag("v0.1.1")
        result = plan(
            ["v0.1.0", "v0.1.1"], explicit_version="0.2.0", published_exact_tags={"v0.1.0"}, unpublished_target_tag=tag
        )
        self.assertEqual(release.ReleasePlan(True, "0.2.0", "v0.2.0", "v0.1.0", "explicit"), result)

    def test_bumps_past_an_unpublished_tag_elsewhere(self):
        result = plan(["v0.1.0", "v0.2.0"], "fix: a", published_exact_tags={"v0.1.0"})
        self.assertEqual(release.ReleasePlan(True, "0.2.1", "v0.2.1", "v0.1.0", "patch"), result)
        self.assertEqual("v0.3.0", plan(["v0.1.0", "v0.2.0"], mode="minor", published_exact_tags={"v0.1.0"}).tag)

    def test_tester_tags_count_as_previous_without_a_release(self):
        result = plan([*BETAS, "v0.1.0"], "fix: a", published_exact_tags=set())
        self.assertEqual(release.ReleasePlan(True, "0.1.1", "v0.1.1", "v0.1.0-beta.3", "patch"), result)


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


class GitRepoIntegrationTest(unittest.TestCase):
    """Runs `next` against a real temporary repository."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.git("init", "--quiet", "--initial-branch=main")
        self.published = self.repo / "published-tags.txt"
        self.published.write_text("", encoding="utf-8")

    def git(self, *args):
        env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.com",
        }
        return subprocess.run(
            ["git", *args], cwd=self.repo, env=env, check=True, capture_output=True, text=True
        ).stdout.strip()

    def commit(self, subject, tag="", published=True):
        self.git("commit", "--quiet", "--allow-empty", "-m", subject)
        if tag:
            self.git("tag", tag)
            if published:
                with self.published.open("a", encoding="utf-8") as tags:
                    tags.write(f"{tag}\n")
        return self.git("rev-parse", "HEAD")

    def next(self, *args):
        cwd = os.getcwd()
        os.chdir(self.repo)
        try:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(0, release.main(["next", *args]))
        finally:
            os.chdir(cwd)
        return dict(line.split("=", 1) for line in out.getvalue().splitlines())

    def next_published(self, *args):
        return self.next(*args, "--published-tags-file", str(self.published))

    def test_published_tagged_commit_makes_no_release(self):
        self.commit("feat: add search", "v0.1.0")
        for args in ((), ("--bump", "patch"), ("--version", "0.2.0")):
            with self.subTest(args):
                self.assertEqual("false", self.next_published(*args)["should_release"])
                self.assertEqual("false", self.next(*args)["should_release"])

    def test_ancestor_of_a_published_tag_makes_no_release(self):
        older = self.commit("feat: add search")
        self.commit("fix: stop a crash", "v0.1.0")
        result = self.next_published("--target", older)
        self.assertEqual("false", result["should_release"])
        self.assertEqual("v0.1.0", result["previous_tag"])

    def test_log_range_starts_at_the_published_tag(self):
        self.commit("feat: add search", "v0.1.0")
        target = self.commit("fix: stop crash")
        self.assertEqual(
            {"should_release": "true", "version": "0.1.1", "tag": "v0.1.1", "previous_tag": "v0.1.0", "bump": "patch"},
            self.next_published("--target", target),
        )

    def test_recovers_an_unpublished_tag_on_the_target(self):
        self.commit("feat: add search", "v0.1.0")
        target = self.commit("fix: stop crash", "v0.1.1", published=False)
        self.assertEqual(
            {"should_release": "true", "version": "0.1.1", "tag": "v0.1.1", "previous_tag": "v0.1.0", "bump": "recover"},
            self.next_published("--target", target),
        )
        self.assertEqual(
            {"should_release": "true", "version": "0.1.1", "tag": "v0.1.1", "previous_tag": "v0.1.0", "bump": "recover"},
            self.next_published("--target", target, "--version", "0.1.1"),
        )
        # Without the release list every exact tag counts as published.
        self.assertEqual("false", self.next("--target", target)["should_release"])

    def test_beta_tag_on_target_is_not_recovered(self):
        target = self.commit("feat: beta build", "v0.1.0-beta.3", published=False)
        self.assertEqual(
            {"should_release": "false", "version": "", "tag": "", "previous_tag": "v0.1.0-beta.3", "bump": "none"},
            self.next_published("--target", target),
        )
        self.assertEqual(
            {"should_release": "true", "version": "0.2.0", "tag": "v0.2.0", "previous_tag": "v0.1.0-beta.3", "bump": "minor"},
            self.next_published("--target", target, "--bump", "minor"),
        )

    def test_bumps_past_an_unpublished_tag_on_an_older_commit(self):
        self.commit("feat: add search", "v0.1.0")
        self.commit("feat: new feature", "v0.2.0", published=False)
        target = self.commit("fix: typo")
        self.assertEqual(
            {"should_release": "true", "version": "0.3.0", "tag": "v0.3.0", "previous_tag": "v0.1.0", "bump": "minor"},
            self.next_published("--target", target),
        )

    def test_bumps_from_a_beta_tag_newer_than_a_published_tag(self):
        self.commit("feat: initial", "v0.1.0")
        self.commit("feat: beta work", "v0.2.0-beta.1", published=False)
        target = self.commit("fix: polish beta")
        self.assertEqual(
            {"should_release": "true", "version": "0.2.1", "tag": "v0.2.1", "previous_tag": "v0.2.0-beta.1", "bump": "patch"},
            self.next_published("--target", target),
        )
        self.assertEqual(
            {"should_release": "true", "version": "0.3.0", "tag": "v0.3.0", "previous_tag": "v0.2.0-beta.1", "bump": "minor"},
            self.next_published("--target", target, "--bump", "minor"),
        )


if __name__ == "__main__":
    unittest.main()
