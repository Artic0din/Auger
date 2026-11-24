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
spec = importlib.util.spec_from_file_location("generate_changelog", SCRIPT_DIR / "generate-changelog.py")
assert spec is not None and spec.loader is not None
changelog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changelog)

Commit = changelog.CommitMessage
Category = changelog.Category


def sections(*commits):
    notes = changelog.build_notes("1.0.0", "2026-01-31", [c if isinstance(c, Commit) else Commit(c) for c in commits])
    return {category: list(bullets) for category, bullets in notes.sections}


def run(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = changelog.main(list(argv))
    return code, out.getvalue()


class CategoryTest(unittest.TestCase):
    def test_groups_by_category_and_omits_empty_sections(self):
        result = sections(
            "feat(player): add chapters (#12)",
            "perf(ui): faster grid",
            "fix: stop a crash",
            "fix(security): redact tokens in logs",
            "feat!: drop Tizen 7",
        )
        self.assertEqual(
            {
                Category.FEATURES: ["- **Playback**: Add chapters"],
                Category.IMPROVEMENTS: ["- **Interface**: Faster grid"],
                Category.FIXES: ["- Stop a crash"],
                Category.SECURITY: ["- Redact tokens in logs"],
                Category.BREAKING: ["- Drop Tizen 7"],
            },
            result,
        )
        self.assertEqual({Category.FIXES: ["- Stop a crash"]}, sections("fix: stop a crash"))

    def test_section_order(self):
        notes = changelog.build_notes(
            "1.0.0", "2026-01-31", [Commit("fix: a"), Commit("fix(sec): b"), Commit("perf: c"), Commit("feat: d"), Commit("feat!: e")]
        )
        self.assertEqual(
            [Category.BREAKING, Category.FEATURES, Category.IMPROVEMENTS, Category.SECURITY, Category.FIXES],
            [category for category, _ in notes.sections],
        )

    def test_security_from_the_subject(self):
        for subject in ("fix(auth): fix auth bypass vulnerability", "fix: patch CVE-2026-1234", "fix(player): stop a secret leak"):
            with self.subTest(subject):
                self.assertIn(Category.SECURITY, sections(subject))
        self.assertEqual(
            {Category.SECURITY: ["- **Sign-In**: Fix auth bypass vulnerability"]},
            sections("fix(auth): fix auth bypass vulnerability"),
        )
        # Cosmetic UI wording mentioning "security" stays under Fixes.
        self.assertEqual({Category.FIXES: ["- Security badge is clipped"]}, sections("fix: security badge is clipped"))
        # Only fixes move on wording alone.
        self.assertIn(Category.FEATURES, sections("feat: show security settings"))

    def test_reverts_are_fixes(self):
        self.assertEqual({Category.FIXES: ["- Reverted: Add search"]}, sections('Revert "feat: add search" (#9)'))
        self.assertEqual({Category.FIXES: ["- Undo the grid"]}, sections("revert: undo the grid"))


class NoiseTest(unittest.TestCase):
    def test_internal_commits_are_left_out(self):
        noise = [f"{kind}(repo): tidy" for kind in ("docs", "chore", "ci", "test", "refactor", "style", "build")]
        noise += [
            "fix(ci): fail Evidence links that do not load",
            "fix(ci): patch CVE-2026-1234 in fixture tooling",
            "fix(docs): fix broken link",
            "perf(test): speed up fixture setup",
            "Merge pull request #5 from Artic0din/Auger-Tizen",
            "docs(changelog): record v1.0.0 release notes",
            "update readme",
        ]
        result = sections(*noise, "fix: real fix", "feat(build): add user-facing support")
        self.assertEqual(
            {Category.FEATURES: ["- **Build**: Add user-facing support"], Category.FIXES: ["- Real fix"]},
            result,
        )

    def test_breaking_noise_is_kept(self):
        self.assertEqual({Category.BREAKING: ["- Rename settings keys"]}, sections("chore!: rename settings keys"))
        footer = Commit(
            "chore(settings): rename keys",
            "Renames every key.\n\nBREAKING CHANGE: settings reset\nonce on update\nRefs: #123\nReviewed-by: Maintainer",
        )
        self.assertEqual({Category.BREAKING: ["- **Settings**: Settings reset once on update"]}, sections(footer))

    def test_breaking_footer_keeps_the_feature_when_distinct(self):
        commit = Commit("feat(player): add chapters", "BREAKING-CHANGE: old chapter files are ignored")
        self.assertEqual(
            {
                Category.BREAKING: ["- **Playback**: Old chapter files are ignored"],
                Category.FEATURES: ["- **Playback**: Add chapters"],
            },
            sections(commit),
        )
        same = Commit("feat(player): add chapters", "BREAKING CHANGE: add chapters")
        self.assertEqual({Category.BREAKING: ["- **Playback**: Add chapters"]}, sections(same))


class FormatTest(unittest.TestCase):
    def test_scope_labels(self):
        cases = {
            "player": "Playback", "playback": "Playback", "auth": "Sign-In", "sign-in": "Sign-In",
            "library": "Browse", "watch-party": "Watch Party", "i18n": "Languages", "brand": "Branding",
            "release": "Releases", "up-next": "Up Next", "tv_focus": "TV Focus", "player,ui": "Playback, Interface",
        }
        for scope, label in cases.items():
            with self.subTest(scope):
                self.assertEqual(label, changelog.scope_label(scope))

    def test_unscoped_features_have_no_label(self):
        self.assertEqual({Category.FEATURES: ["- Add search"]}, sections("feat: add search"))

    def test_casing_and_suffixes(self):
        self.assertEqual(
            {
                Category.FEATURES: ["- **Playback**: AVPlay restores on resume", "- HDR10 passthrough"],
                Category.FIXES: ["- Tizen 8 stalls", "- `config.xml` keeps its version", "- Browse, search and play"],
            },
            sections(
                "feat(player): avplay restores on resume (#40) (#41)",
                "feat: hdr10 passthrough",
                "fix: tizen 8 stalls (#3)",
                "fix: `config.xml` keeps its version",
                "fix: browse, search and play",
            ),
        )

    def test_duplicates_are_dropped(self):
        result = sections("feat(player): add chapters (#12)", "feat(player): add chapters (#13)", "feat(ui): add chapters")
        self.assertEqual({Category.FEATURES: ["- **Playback**: Add chapters", "- **Interface**: Add chapters"]}, result)

    def test_fallback_without_user_facing_commits(self):
        self.assertEqual(
            {Category.IMPROVEMENTS: ["- General maintenance and stability improvements."]}, sections("chore: bump deps")
        )
        self.assertEqual({Category.IMPROVEMENTS: ["- General maintenance and stability improvements."]}, sections())

    def test_release_body(self):
        notes = changelog.build_notes("0.2.0", "2026-01-31", [Commit("feat(player): add chapters"), Commit("fix: stop a crash")])
        self.assertEqual(
            "# Updates - Auger v0.2.0 (2026-01-31)\n\n"
            "## ✨ New Features\n\n- **Playback**: Add chapters\n\n"
            "## 🐛 Fixes\n\n- Stop a crash\n",
            notes.release_body(),
        )
        self.assertEqual(
            "## [0.2.0] - 2026-01-31\n\n"
            "### ✨ New Features\n\n- **Playback**: Add chapters\n\n"
            "### 🐛 Fixes\n\n- Stop a crash\n",
            notes.changelog_entry(),
        )


HEADER = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- Pending.\n\n"


class InsertEntryTest(unittest.TestCase):
    def entry(self, version):
        return f"## [{version}] - 2026-01-31\n\n### 🐛 Fixes\n\n- Fix {version}\n"

    def test_inserts_below_the_marker_newest_first(self):
        text = f"{HEADER}<!-- changelog:releases -->\n\n## [Earlier changes]\n\n- Old.\n"
        once = changelog.insert_entry(text, "0.2.0", self.entry("0.2.0"))
        twice = changelog.insert_entry(once, "0.3.0", self.entry("0.3.0"))
        self.assertEqual(
            f"{HEADER}<!-- changelog:releases -->\n\n{self.entry('0.3.0')}\n{self.entry('0.2.0')}\n## [Earlier changes]\n\n- Old.\n",
            twice,
        )
        self.assertIsNone(changelog.insert_entry(twice, "0.2.0", self.entry("0.2.0")))

    def test_inserts_in_descending_semver_order(self):
        text = f"{HEADER}<!-- changelog:releases -->\n\n## [Earlier changes]\n\n- Old.\n"
        first = changelog.insert_entry(text, "1.2.0", self.entry("1.2.0"))
        second = changelog.insert_entry(first, "1.1.0", self.entry("1.1.0"))
        third = changelog.insert_entry(second, "1.3.0", self.entry("1.3.0"))
        self.assertEqual(
            f"{HEADER}<!-- changelog:releases -->\n\n"
            f"{self.entry('1.3.0')}\n{self.entry('1.2.0')}\n{self.entry('1.1.0')}\n"
            f"## [Earlier changes]\n\n- Old.\n",
            third,
        )

    def test_without_a_marker(self):
        after_unreleased = changelog.insert_entry(f"{HEADER}## [0.1.0] - 2025-01-01\n", "0.2.0", self.entry("0.2.0"))
        self.assertEqual(f"{HEADER}{self.entry('0.2.0')}\n## [0.1.0] - 2025-01-01\n", after_unreleased)
        bare = changelog.insert_entry("# Changelog\n", "0.2.0", self.entry("0.2.0"))
        self.assertEqual(f"# Changelog\n\n{self.entry('0.2.0')}", bare)


class GitRepoIntegrationTest(unittest.TestCase):
    """Runs both commands against a real temporary repository."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.git("init", "--quiet", "--initial-branch=main")
        cwd = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, cwd)

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
        return subprocess.run(["git", *args], cwd=self.repo, env=env, check=True, capture_output=True, text=True).stdout

    def commit(self, subject):
        self.git("commit", "--quiet", "--allow-empty", "-m", subject)
        return self.git("rev-parse", "HEAD").strip()

    def test_range_from_tag_to_target(self):
        self.commit("feat(search): add search")
        self.git("tag", "v0.1.0")
        self.commit("fix: stop a crash (#4)")
        self.commit("docs: readme")
        target = self.commit("feat(player): add chapters (#5)")
        self.commit("feat: after the target")

        code, body = run("release", "--version", "0.2.0", "--date", "2026-01-31", "--from", "v0.1.0", "--to", target)
        self.assertEqual(0, code)
        self.assertEqual(
            "# Updates - Auger v0.2.0 (2026-01-31)\n\n"
            "## ✨ New Features\n\n- **Playback**: Add chapters\n\n"
            "## 🐛 Fixes\n\n- Stop a crash\n",
            body,
        )

        path = self.repo / "CHANGELOG.md"
        path.write_text(f"{HEADER}<!-- changelog:releases -->\n\n## [Earlier changes]\n\n- Old.\n", encoding="utf-8")
        args = ("update", "--file", str(path), "--version", "0.2.0", "--date", "2026-01-31", "--from", "v0.1.0", "--to", target)
        self.assertEqual(0, run(*args)[0])
        first = path.read_text(encoding="utf-8")
        self.assertEqual(0, run(*args)[0])
        self.assertEqual(first, path.read_text(encoding="utf-8"))
        self.assertEqual(1, first.count("## [0.2.0] - 2026-01-31"))
        self.assertIn("<!-- changelog:releases -->\n\n## [0.2.0] - 2026-01-31\n\n### ✨ New Features\n", first)
        self.assertLess(first.index("## [0.2.0]"), first.index("## [Earlier changes]"))

    def test_without_from_reads_all_history(self):
        target = self.commit("fix: first fix")
        code, body = run("release", "--version", "0.0.1", "--date", "2026-01-31", "--to", target)
        self.assertEqual(0, code)
        self.assertIn("- First fix", body)

    def test_rejects_bad_input(self):
        self.commit("fix: a")
        self.assertEqual(1, run("release", "--version", "1.2", "--date", "2026-01-31")[0])
        self.assertEqual(1, run("release", "--version", "1.2.0", "--date", "31/01/2026")[0])
        self.assertEqual(1, run("release", "--version", "1.2.0", "--from", "v9.9.9")[0])


if __name__ == "__main__":
    unittest.main()
