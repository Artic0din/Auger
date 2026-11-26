#!/usr/bin/env python3

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import textwrap
import unittest


SCRIPT_DIR = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("generate_changelog", SCRIPT_DIR / "generate-changelog.py")
assert spec is not None and spec.loader is not None
changelog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(changelog)

Commit = changelog.CommitMessage
Category = changelog.Category
UserSection = changelog.UserSection


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
        commits = [Commit("feat(player): add chapters"), Commit("fix: stop a crash")]
        notes = changelog.build_notes("0.2.0", "2026-01-31", commits)
        self.assertEqual(
            "Released: 2026-01-31\n\n"
            "## New\n\n- **Playback**: Add chapters\n\n"
            "## Fixed\n\n- Stop a crash\n",
            changelog.build_user_notes("0.2.0", "2026-01-31", commits, {}).render(),
        )
        self.assertEqual(
            "## [0.2.0] - 2026-01-31\n\n"
            "### New Features\n\n- **Playback**: Add chapters\n\n"
            "### Fixes\n\n- Stop a crash\n",
            notes.changelog_entry(),
        )


class TechnicalChangelogTest(unittest.TestCase):
    def test_includes_all_technical_categories_without_emojis_or_compare_links(self):
        commits = [
            Commit("feat!: drop Tizen 7 (#10)", "BREAKING CHANGE: upgrade to Tizen 8", "11111111"),
            Commit("feat(player): add chapters (#11)", "", "22222222"),
            Commit("perf(home): cache backdrop (#12)", "", "33333333"),
            Commit("fix(security): redact tokens (#13)", "", "44444444"),
            Commit("fix(ci): stop flaky runner (#14)", "", "55555555"),
            Commit("refactor(ui): simplify row (#15)", "", "66666666"),
            Commit("chore(deps-dev): bump playwright (#16)", "", "77777777"),
            Commit("test(player): add seek regression (#17)", "", "88888888"),
            Commit("docs(readme): update screenshots (#18)", "", "99999999"),
            Commit("docs(changelog): record v0.4.0 release notes troubleshooting (#22)", "", "eeeeeeee"),
            Commit("ci(release): add deploy key (#19)", "", "aaaaaaaa"),
            Commit("Update README.md", "", "bbbbbbbb"),
            Commit("docs(changelog): record v0.4.0 release notes (#20)", "", "cccccccc"),
            Commit("Merge pull request #21 from Artic0din/Auger-Tizen", "", "dddddddd"),
        ]
        rendered = changelog.build_technical_changelog("0.5.0", "2026-11-25", commits).changelog_entry()
        self.assertIn("## [0.5.0] - 2026-11-25\n", rendered)
        expected_pairs = (
            (
                "### Breaking Changes",
                "- Upgrade to Tizen 8 ([#10](https://github.com/Artic0din/Auger-Tizen/pull/10), [`11111111`](https://github.com/Artic0din/Auger-Tizen/commit/11111111))",
            ),
            (
                "### Features",
                "- Drop Tizen 7 ([#10](https://github.com/Artic0din/Auger-Tizen/pull/10), [`11111111`](https://github.com/Artic0din/Auger-Tizen/commit/11111111))\n"
                "- **Playback**: Add chapters ([#11](https://github.com/Artic0din/Auger-Tizen/pull/11), [`22222222`](https://github.com/Artic0din/Auger-Tizen/commit/22222222))",
            ),
            (
                "### Performance",
                "- **Home**: Cache backdrop ([#12](https://github.com/Artic0din/Auger-Tizen/pull/12), [`33333333`](https://github.com/Artic0din/Auger-Tizen/commit/33333333))",
            ),
            (
                "### Security",
                "- Redact tokens ([#13](https://github.com/Artic0din/Auger-Tizen/pull/13), [`44444444`](https://github.com/Artic0din/Auger-Tizen/commit/44444444))",
            ),
            (
                "### Fixes",
                "- **CI**: Stop flaky runner ([#14](https://github.com/Artic0din/Auger-Tizen/pull/14), [`55555555`](https://github.com/Artic0din/Auger-Tizen/commit/55555555))",
            ),
            (
                "### Refactors & Maintenance",
                "- **Interface**: Simplify row ([#15](https://github.com/Artic0din/Auger-Tizen/pull/15), [`66666666`](https://github.com/Artic0din/Auger-Tizen/commit/66666666))\n"
                "- **Dependencies**: Bump playwright ([#16](https://github.com/Artic0din/Auger-Tizen/pull/16), [`77777777`](https://github.com/Artic0din/Auger-Tizen/commit/77777777))",
            ),
            (
                "### Tests",
                "- **Playback**: Add seek regression ([#17](https://github.com/Artic0din/Auger-Tizen/pull/17), [`88888888`](https://github.com/Artic0din/Auger-Tizen/commit/88888888))",
            ),
            (
                "### Documentation",
                "- **README**: Update screenshots ([#18](https://github.com/Artic0din/Auger-Tizen/pull/18), [`99999999`](https://github.com/Artic0din/Auger-Tizen/commit/99999999))\n"
                "- **Changelog**: Record v0.4.0 release notes troubleshooting ([#22](https://github.com/Artic0din/Auger-Tizen/pull/22), [`eeeeeeee`](https://github.com/Artic0din/Auger-Tizen/commit/eeeeeeee))",
            ),
            (
                "### CI",
                "- **Releases**: Add deploy key ([#19](https://github.com/Artic0din/Auger-Tizen/pull/19), [`aaaaaaaa`](https://github.com/Artic0din/Auger-Tizen/commit/aaaaaaaa))",
            ),
            (
                "### Other Changes",
                "- Update README.md ([`bbbbbbbb`](https://github.com/Artic0din/Auger-Tizen/commit/bbbbbbbb))",
            ),
        )
        for heading, bullets in expected_pairs:
            self.assertIn(f"\n{heading}\n\n{bullets}\n", rendered)
        for emoji in ("⚠️", "✨", "🔧", "🔒", "🐛"):
            self.assertNotIn(emoji, rendered)
        self.assertNotIn("/compare/", rendered)
        self.assertNotIn("cccccccc", rendered)
        self.assertNotIn("Merge pull request", rendered)

    def test_breaking_single_bullet_when_footer_absent_or_identical_and_custom_repo(self):
        commits = [
            Commit("feat!: drop Tizen 7 (#10)", "", "11111111"),
            Commit("feat(player): add chapters (#11)", "BREAKING CHANGE: add chapters", "22222222"),
        ]
        rendered = changelog.build_technical_changelog("1.0.0", "2026-11-25", commits, repo="ForkOwner/ForkRepo").changelog_entry()
        self.assertIn(
            "### Breaking Changes\n\n"
            "- Drop Tizen 7 ([#10](https://github.com/ForkOwner/ForkRepo/pull/10), [`11111111`](https://github.com/ForkOwner/ForkRepo/commit/11111111))\n"
            "- **Playback**: Add chapters ([#11](https://github.com/ForkOwner/ForkRepo/pull/11), [`22222222`](https://github.com/ForkOwner/ForkRepo/commit/22222222))\n",
            rendered,
        )
        self.assertNotIn("### Features", rendered)
        self.assertNotIn("Artic0din/Auger-Tizen", rendered)


def user_notes(*commits, bodies=None):
    commits = [c if isinstance(c, Commit) else Commit(c) for c in commits]
    return changelog.build_user_notes("1.0.0", "2026-01-31", commits, bodies or {})


def user_sections(*commits, bodies=None):
    return {section: list(items) for section, items in user_notes(*commits, bodies=bodies).sections}


def pr_body(release_notes):
    return f"## Problem\n\nA crash.\n\n## Approach\n\nA fix.\n\n{release_notes}\n\n## Validation\n\n- Tests pass.\n"


class UserReleaseNotesTest(unittest.TestCase):
    def test_categorized_release_notes(self):
        body = pr_body(
            "## Release Notes\n\n<!-- Write for Samsung TV users. -->\n\n"
            "### Highlights\n\nChapters arrive in the player.\nPick one to jump there.\n\nSecond paragraph.\n\n"
            "### ✨ New Features\n\n- Chapter list in the player\n- Chapter thumbnails\n  load as you scroll.\n\n"
            "### Improvements\n\n* Faster seeking\n\n"
            "### Security\n\n- Sign-in tokens stay out of logs\n\n"
            "### Bug Fixes\n\nPlayback no longer stalls after a pause.\n\n"
            "### Breaking Changes\n\n- Sign in again after updating"
        )
        self.assertEqual(
            "Released: 2026-01-31\n\n"
            "## Breaking Changes\n\n- Sign in again after updating\n\n"
            "## Highlights\n\nChapters arrive in the player. Pick one to jump there.\n\nSecond paragraph.\n\n"
            "## New\n\n- Chapter list in the player\n- Chapter thumbnails load as you scroll.\n\n"
            "## Improved\n\n- Faster seeking\n\n"
            "## Security\n\n- Sign-in tokens stay out of logs\n\n"
            "## Fixed\n\n- Playback no longer stalls after a pause.\n",
            user_notes("feat(player): add chapters (#5)", bodies={5: body}).render(),
        )

    def test_unsectioned_notes_follow_the_commit_type(self):
        bodies = {n: pr_body(f"### Release Notes\n\nNote {n}.") for n in range(1, 7)}
        self.assertEqual(
            {
                UserSection.BREAKING: ["Note 5."],
                UserSection.NEW: ["Note 1."],
                UserSection.IMPROVED: ["Note 2.", "Note 6."],
                UserSection.SECURITY: ["Note 4."],
                UserSection.FIXED: ["Note 3."],
            },
            user_sections(
                "feat: a (#1)", "perf: b (#2)", "fix: c (#3)", "fix(security): d (#4)", "chore!: e (#5)", "chore: f (#6)",
                bodies=bodies,
            ),
        )
        # Notes from two pull requests repeat once.
        self.assertEqual({UserSection.FIXED: ["Note 3."]}, user_sections("fix: c (#3)", "fix: d (#3)", bodies=bodies))

    def test_no_user_change_is_left_out_unless_breaking(self):
        for note in ("None", "N/A", "No user-visible changes", "*No user-facing change.*", "`none`"):
            with self.subTest(note):
                bodies = {1: pr_body(f"## Release Notes\n\n{note}")}
                suppressed = user_notes("feat: hidden (#1)", bodies=bodies)
                self.assertEqual((), suppressed.highlights)
                self.assertEqual((), suppressed.sections)
                self.assertEqual(
                    "Released: 2026-01-31\n\n## Improved\n\n- General maintenance and stability improvements.\n",
                    suppressed.render(),
                )
                self.assertEqual(
                    {UserSection.BREAKING: ["Drop Tizen 7"]}, user_sections("feat!: drop Tizen 7 (#1)", bodies=bodies)
                )

    def test_breaking_commit_keeps_its_warning_when_the_notes_skip_it(self):
        body = pr_body("## Release Notes\n\n### New\n\n- Settings sync")
        self.assertEqual(
            {UserSection.BREAKING: ["**Settings**: Settings reset once"], UserSection.NEW: ["Settings sync"]},
            user_sections(Commit("feat(settings): sync (#1)", "BREAKING CHANGE: settings reset once"), bodies={1: body}),
        )
        unsectioned = pr_body("## Release Notes\n\nSettings now sync between your TVs.")
        self.assertEqual(
            {
                UserSection.BREAKING: ["**Settings**: Settings reset once"],
                UserSection.NEW: ["Settings now sync between your TVs."],
            },
            user_sections(Commit("feat(settings): sync (#1)", "BREAKING CHANGE: settings reset once"), bodies={1: unsectioned}),
        )
        chore_breaking = pr_body("## Release Notes\n\nSettings moved to a new format.")
        self.assertEqual(
            {
                UserSection.BREAKING: ["Settings moved to a new format.", "**Settings**: Settings reset once"],
            },
            user_sections(Commit("chore(settings)!: rename keys (#1)", "BREAKING CHANGE: settings reset once"), bodies={1: chore_breaking}),
        )

    def test_comment_only_notes_fall_back(self):
        comment_only = "## Release Notes\n\n<!-- Write for Samsung TV users,\nor None. -->\n"
        self.assertEqual(
            {UserSection.FIXED: ["Subtitles stay in sync."]},
            user_sections("fix: sync subtitles (#1)", bodies={1: pr_body(comment_only) + "\nRelease note: Subtitles stay in sync."}),
        )
        self.assertEqual(
            {UserSection.FIXED: ["Sync subtitles"]}, user_sections("fix: sync subtitles (#1)", bodies={1: pr_body(comment_only)})
        )

    def test_legacy_release_note_line(self):
        bodies = {1: "Fixes the grid.\n\nrelease note:  The grid keeps focus after Back.\n", 2: "Release note: None"}
        self.assertEqual(
            {UserSection.FIXED: ["The grid keeps focus after Back."]},
            user_sections("fix(ui): keep focus (#1)", "fix: internal (#2)", bodies=bodies),
        )

    def test_commits_without_a_pr_body_use_the_commit(self):
        self.assertEqual(
            {UserSection.NEW: ["**Playback**: Add chapters"], UserSection.FIXED: ["Stop a crash"]},
            user_sections("feat(player): add chapters (#5)", "fix: stop a crash", bodies={9: pr_body("## Release Notes\n\nX")}),
        )

    def test_fenced_code_blocks_are_stripped_from_notes_and_legacy_fallback(self):
        body = (
            "## Approach\n\n```markdown\n## Release Notes\n\nFake example.\n```\n\n"
            "## Release Notes\n\n### New\n\n- Real feature.\n\n```sh\n# shell comment\n```\n\n- After code fence.\n\n"
            "## Validation\n\n- Passed.\n"
        )
        self.assertEqual(
            {UserSection.NEW: ["Real feature.", "After code fence."]},
            user_sections("feat: example (#1)", bodies={1: body}),
        )
        fenced_legacy = "## Approach\n\n```markdown\nRelease note: Do not publish this example.\n```\n"
        self.assertEqual(
            {UserSection.FIXED: ["Real commit fix"]},
            user_sections("fix: real commit fix (#2)", bodies={2: fenced_legacy}),
        )

    def test_suppression_markers_under_subheadings_are_dropped(self):
        body = pr_body("## Release Notes\n\n### Breaking Changes\n\nNone\n\n### New\n\n- Real feature.\n")
        self.assertEqual(
            {UserSection.BREAKING: ["Settings reset once"], UserSection.NEW: ["Real feature."]},
            user_sections(Commit("feat: sync (#1)", "BREAKING CHANGE: settings reset once"), bodies={1: body}),
        )
        only_none = pr_body("## Release Notes\n\n### Highlights\n\nN/A\n\n### New\n\n- None\n")
        suppressed = user_notes("feat: internal (#2)", bodies={2: only_none})
        self.assertEqual((), suppressed.highlights)
        self.assertEqual((), suppressed.sections)

    def test_bulleted_highlights_preserve_list_formatting(self):
        body = pr_body("## Release Notes\n\n### Highlights\n\n- First highlight.\n- Second highlight.\n")
        self.assertEqual(
            "Released: 2026-01-31\n\n## Highlights\n\n- First highlight.\n- Second highlight.\n",
            user_notes("feat: two things (#1)", bodies={1: body}).render(),
        )

    def test_empty_subheadings_fall_back_to_commit(self):
        body = pr_body("## Release Notes\n\n### New\n\n### Fixed\n")
        self.assertEqual(
            {UserSection.FIXED: ["Stop a crash"]},
            user_sections("fix: stop a crash (#1)", bodies={1: body}),
        )

    def test_non_trailing_pr_numbers_are_ignored(self):
        bodies = {12: pr_body("## Release Notes\n\nAdded search.")}
        self.assertEqual(
            {UserSection.FIXED: ["Reverted: Add search"]},
            user_sections('Revert "feat: add search (#12)" (#20)', bodies=bodies),
        )
        self.assertEqual(
            {UserSection.FIXED: ["Reverted: Add search"]},
            user_sections('Revert "feat: add search (#12)"', bodies=bodies),
        )
        self.assertEqual(
            {UserSection.FIXED: ["Restore playback (#12) on older TVs"]},
            user_sections("fix: restore playback (#12) on older TVs", bodies=bodies),
        )

    def test_unclosed_html_comments_finish_in_linear_time(self):
        malformed = "<!-- " * 5000 + "\n## Release Notes\n\n- Still fast.\n"
        self.assertEqual({UserSection.NEW: ["Still fast."]}, user_sections("feat: fast (#1)", bodies={1: malformed}))

    def test_fence_inside_html_comment_and_crlf_headings_work(self):
        body = (
            "<!-- Example:\r\n```markdown\r\nnot closed\r\n-->\r\n"
            "## Release Notes ##\r\n\r\n### New ###\r\n\r\n- Works on CRLF bodies.\r\n"
        )
        self.assertEqual({UserSection.NEW: ["Works on CRLF bodies."]}, user_sections("feat: crlf (#1)", bodies={1: body}))

    def test_singular_release_note_heading_is_accepted(self):
        body = pr_body("## Release note\n\nAdded Still Watching prompt under Settings > Playback.")
        self.assertEqual(
            {UserSection.NEW: ["Added Still Watching prompt under Settings > Playback."]},
            user_sections("feat(player): add still watching (#886)", bodies={886: body}),
        )


class CheckPrReleaseNotesTest(unittest.TestCase):
    def test_non_releasing_prs_pass_without_release_notes(self):
        for title in (
            "docs(releasing): clarify guide",
            "chore(deps): bump actions/checkout",
            "ci(release): update check",
            "test(ui): stabilize focus test",
            "refactor(player): simplify state",
            "fix(ci): stop flaky check",
        ):
            with self.subTest(title=title):
                self.assertEqual([], changelog.check_pr_release_notes(title, ""))

    def test_user_facing_prs_require_populated_release_notes(self):
        for title in ("feat(player): add chapters", "fix: stop crash", "perf(home): faster rows", "revert: undo change", "feat!: drop Tizen 7"):
            for body in ("", pr_body(""), pr_body("## Release Notes\n\n<!-- comment only -->"), pr_body("## Release Notes\n\n### New\n")):
                with self.subTest(title=title, body=body[:30]):
                    self.assertTrue(changelog.check_pr_release_notes(title, body))

    def test_suppression_rules_and_quality_guards(self):
        self.assertEqual([], changelog.check_pr_release_notes("fix(ui): internal tweak", pr_body("## Release Notes\n\nNone")))
        self.assertTrue(changelog.check_pr_release_notes("feat(player): add chapters", pr_body("## Release Notes\n\nNone")))
        self.assertTrue(changelog.check_pr_release_notes("perf(home): faster rows", pr_body("## Release Notes\n\nNone")))
        self.assertTrue(changelog.check_pr_release_notes("feat!: drop Tizen 7", pr_body("## Release Notes\n\nNone")))
        self.assertTrue(
            changelog.check_pr_release_notes(
                "refactor(settings): rename storage keys",
                "## Problem\n\nRename keys.\n\nBREAKING CHANGE: settings reset once.\n",
            )
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "fix(auth): change session format",
                pr_body("## Release Notes\n\nNone") + "\nBREAKING CHANGE: sign in again.\n",
            )
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "feat(player): add chapters",
                "## Problem\n\nNo chapters.\n\nRelease note: Added chapters.\n",
            )
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "feat(player): add chapters",
                pr_body("## Release Notes\n\n<!-- empty -->") + "\nRelease note: Added chapters.\n",
            )
        )
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "feat(player): add still watching",
                pr_body("## Release note\n\n### New\n\n- Pause Auto-play after 3 episodes. See [guide](https://example.com/docs#123)."),
            ),
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "feat(diagnostics): explain track and buffering failures",
                pr_body("## Release Notes\n\n- Audio reports now show tracks.\n- Playback error screens use local text."),
            )
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "feat(player): add chapters",
                pr_body("## Release Notes\n\n### Highlights\n\nChapters arrive in the player."),
            )
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "feat!: drop Tizen 7",
                pr_body("## Release Notes\n\n### New\n\n- Requires Tizen 8 or later."),
            )
        )
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "feat!: drop Tizen 7",
                pr_body("## Release Notes\n\n### Breaking Changes\n\n- Upgrade your TV to Tizen 8 or later."),
            ),
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "feat(player): add still watching",
                pr_body("## Release Notes\n\n### New\n\n- Added prompt (#886)."),
            )
        )
        self.assertTrue(
            changelog.check_pr_release_notes(
                "fix(player): stop crash",
                pr_body("## Release Notes\n\n### Fixed\n\n- fix(player): stop crash"),
            )
        )

    def test_semver_bump_matches_release_notes_categories(self):
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "feat(subtitles): floating appearance dialog",
                pr_body("## Release Notes\n\n### Improved\n\n- Subtitle Appearance opens as a floating dialog."),
            ),
        )
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "perf(home): cache tint wash",
                pr_body("## Release Notes\n\n### Improved\n\n- Home scrolls more smoothly."),
            ),
        )
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "fix(security): redact token",
                pr_body("## Release Notes\n\n### Security\n\n- Redact tokens from error screens."),
            ),
        )
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "fix(ci): stop flaky upload",
                pr_body("## Release Notes\n\n### Fixed\n\n- Release uploads retry cleanly."),
            ),
        )
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "perf(ci): cache bundle check",
                pr_body("## Release Notes\n\n### Improved\n\n- Faster package validation."),
            ),
        )
        self.assertEqual(
            [],
            changelog.check_pr_release_notes(
                "chore(repo): tidy scripts",
                pr_body("## Release Notes\n\nNone"),
            ),
        )
        for title, section in (
            ("fix(player): add end time", "### New\n\n- Show estimated finish time."),
            ("fix(player): add end time", "### Improved\n\n- Show estimated finish time."),
            ("fix(ci): add check", "### New\n\n- Added a new setting."),
            ("perf(ci): cache bundle check", "### Fixed\n\n- Stopped a crash."),
            ("revert: undo row", "### Improved\n\n- Removed extra subtitle row."),
            ("perf(home): faster rows", "### New\n\n- Added a new shelf."),
            ("perf(home): faster rows", "### Fixed\n\n- Stopped a crash."),
            ("feat(player): fix crash", "### Fixed\n\n- Stopped a crash."),
            ("feat(settings): rename keys", "### Breaking Changes\n\n- Sign in again.\n\n### New\n\n- New settings."),
            ("chore(repo): change package id", "### Breaking Changes\n\n- Uninstall older builds first."),
        ):
            with self.subTest(title=title, section=section[:20]):
                self.assertTrue(changelog.check_pr_release_notes(title, pr_body(f"## Release Notes\n\n{section}")))

    def test_check_pr_cli_and_workflow_step(self):
        workflow_text = (SCRIPT_DIR.parent / ".github/workflows/ci-scripts.yml").read_text(encoding="utf-8")
        self.assertIn("types: [opened, edited, synchronize, reopened]", workflow_text)
        self.assertIn("PR_TITLE: ${{ github.event.pull_request.title }}", workflow_text)
        self.assertIn("PR_BODY: ${{ github.event.pull_request.body }}", workflow_text)
        step_script = extract_step_run(extract_job_block(workflow_text, "test"), "Check user-facing PR release notes")
        with tempfile.TemporaryDirectory() as tmp_name:
            runner_temp = Path(tmp_name)
            env = {**os.environ, "RUNNER_TEMP": str(runner_temp)}
            good = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", step_script],
                cwd=SCRIPT_DIR.parent,
                env={**env, "PR_TITLE": "feat(player): add chapters", "PR_BODY": pr_body("## Release Notes\n\n### New\n\n- Jump to any chapter from the player.")},
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, good.returncode, good.stderr)
            missing = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", step_script],
                cwd=SCRIPT_DIR.parent,
                env={**env, "PR_TITLE": "feat(player): add chapters", "PR_BODY": "## Problem\n\nNo chapters."},
                capture_output=True,
                text=True,
            )
            self.assertEqual(1, missing.returncode)
            self.assertIn("## Release Notes", missing.stderr)


HEADER = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n- Pending.\n\n"


class InsertEntryTest(unittest.TestCase):
    def entry(self, version):
        return f"## [{version}] - 2026-01-31\n\n### Fixes\n\n- Fix {version}\n"

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
            "Released: 2026-01-31\n\n"
            "## New\n\n- **Playback**: Add chapters\n\n"
            "## Fixed\n\n- Stop a crash\n",
            body,
        )
        pr_notes = self.repo / "pr-notes.json"
        pr_notes.write_text('[{"number": 5, "body": "## Release Notes\\n\\nPick a chapter to jump to it."}]', encoding="utf-8")
        code, body = run(
            "release", "--version", "0.2.0", "--date", "2026-01-31", "--from", "v0.1.0", "--to", target,
            "--pr-notes-file", str(pr_notes),
        )
        self.assertEqual(0, code)
        self.assertEqual(
            "Released: 2026-01-31\n\n## New\n\n- Pick a chapter to jump to it.\n\n## Fixed\n\n- Stop a crash\n", body
        )

        path = self.repo / "CHANGELOG.md"
        path.write_text(f"{HEADER}<!-- changelog:releases -->\n\n## [Earlier changes]\n\n- Old.\n", encoding="utf-8")
        args = ("update", "--file", str(path), "--version", "0.2.0", "--date", "2026-01-31", "--from", "v0.1.0", "--to", target)
        self.assertEqual(0, run(*args)[0])
        first = path.read_text(encoding="utf-8")
        self.assertEqual(0, run(*args)[0])
        self.assertEqual(first, path.read_text(encoding="utf-8"))
        self.assertEqual(1, first.count("## [0.2.0] - 2026-01-31"))
        self.assertIn("<!-- changelog:releases -->\n\n## [0.2.0] - 2026-01-31\n\n### Features\n", first)
        self.assertIn("### Documentation\n\n- README", first)
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

    def test_rejects_invalid_pr_notes_file(self):
        self.commit("fix: a (#1)")
        cases = ("{not json", '"a string"', "[1, 2]", '{"abc": "body"}', '{"1": 2}', '[{"number": true, "body": ""}]')
        for text in cases:
            with self.subTest(text):
                path = self.repo / "pr-notes.json"
                path.write_text(text, encoding="utf-8")
                err = io.StringIO()
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                    code = changelog.main(["release", "--version", "1.2.0", "--pr-notes-file", str(path)])
                self.assertEqual(1, code)
                self.assertIn("::error::", err.getvalue())
        path.write_text('{"1": null}', encoding="utf-8")
        self.assertEqual(0, run("release", "--version", "1.2.0", "--pr-notes-file", str(path))[0])


def extract_job_block(workflow_text: str, job_name: str) -> str:
    lines = workflow_text.splitlines()
    start = next(i for i, line in enumerate(lines) if line == f"  {job_name}:")
    end = next(
        (i for i in range(start + 1, len(lines)) if lines[i].startswith("  ") and not lines[i].startswith("   ")),
        len(lines),
    )
    return "\n".join(lines[start:end])


def extract_job_mapping(job_block: str, section: str) -> dict[str, str]:
    lines = job_block.splitlines()
    start = next(i for i, line in enumerate(lines) if line == f"    {section}:")
    entries: dict[str, str] = {}
    for line in lines[start + 1 :]:
        if line and not line.startswith("      "):
            break
        if ":" in line:
            key, _, value = line.strip().partition(":")
            entries[key.strip()] = value.split("#", 1)[0].strip()
    return entries


def extract_step_run(job_block: str, step_name: str) -> str:
    lines = job_block.splitlines()
    name_index = next(i for i, line in enumerate(lines) if line == f"      - name: {step_name}")
    run_index = next(i for i in range(name_index + 1, len(lines)) if lines[i] == "        run: |")
    body: list[str] = []
    for line in lines[run_index + 1 :]:
        if line and not line.startswith("          "):
            break
        body.append(line)
    return textwrap.dedent("\n".join(body))


class ReleaseWorkflowChangelogRangeTest(unittest.TestCase):
    """Runs the release.yml notes and changelog steps against a real temp repo."""

    def test_changelog_keeps_original_range_after_previous_tag_moves(self):
        workflow_text = (SCRIPT_DIR.parent / ".github/workflows/release.yml").read_text(encoding="utf-8")
        publish_block = extract_job_block(workflow_text, "publish")
        changelog_block = extract_job_block(workflow_text, "changelog")

        publish_outputs = extract_job_mapping(publish_block, "outputs")
        changelog_env = extract_job_mapping(changelog_block, "env")
        self.assertEqual("${{ steps.notes.outputs.previous_sha }}", publish_outputs["previous_sha"])
        self.assertEqual("${{ steps.notes.outputs.release_date }}", publish_outputs["release_date"])
        self.assertEqual("${{ needs.publish.outputs.previous_sha }}", changelog_env["PREVIOUS_SHA"])
        self.assertEqual("${{ needs.publish.outputs.release_date }}", changelog_env["RELEASE_DATE"])
        self.assertNotIn("PREVIOUS_TAG", changelog_env)
        self.assertIn("\n    environment: changelog\n", changelog_block, "the deploy key is scoped to the main-only changelog environment")

        notes_script = extract_step_run(publish_block, "Write the release notes")
        changelog_script = extract_step_run(changelog_block, "Commit the release notes to CHANGELOG.md on main")

        with tempfile.TemporaryDirectory() as tmp_name:
            root = Path(tmp_name)
            origin = root / "origin.git"
            work = root / "work"
            stub_bin = root / "bin"
            stub_bin.mkdir()
            gh_log = root / "gh.log"
            gh_api_log = root / "gh-api.log"
            pr_bodies = root / "pr-bodies"
            pr_bodies.mkdir()
            (pr_bodies / "5.md").write_text(
                "## Problem\n\nNo chapters.\n\n## Release Notes\n\n<!-- Write for Samsung TV users. -->\n\n"
                "### New\n\n- Pick a chapter from the player to jump straight to it.\n\n## Validation\n\n- Tests.\n",
                encoding="utf-8",
            )

            # Release JSON fixtures run through the workflow's real --jq expressions; PR #6 fails to load.
            gh_stub = stub_bin / "gh"
            gh_stub.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                'if [[ "${1:-}" == "release" && "${2:-}" == "view" ]]; then\n'
                '  [[ -n "${RELEASE_JSON:-}" ]] || exit 1\n'
                '  if [[ "${4:-}" == "--json" ]]; then jq -r "${7}" <<< "${RELEASE_JSON}"; fi\n'
                "  exit 0\n"
                "fi\n"
                'if [[ "${1:-}" == "api" && "${2:-}" == repos/Artic0din/Auger-Tizen/pulls/* ]]; then\n'
                '  printf "%s\\n" "$*" >> "${GH_API_LOG}"\n'
                '  [[ "${3:-} ${4:-}" == "--jq .body // \\"\\"" && -f "${PR_BODIES}/${2##*/}.md" ]] || exit 1\n'
                '  cat "${PR_BODIES}/${2##*/}.md"\n'
                "  exit 0\n"
                "fi\n"
                'if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then\n'
                "  exit 0\n"
                "fi\n"
                'if [[ "${1:-}" == "pr" && "${2:-}" == "create" ]]; then\n'
                '  printf "%s\\n" "$*" >> "${GH_LOG}"\n'
                "  exit 0\n"
                "fi\n"
                'echo "unexpected gh call: $*" >&2\n'
                "exit 1\n",
                encoding="utf-8",
            )
            gh_stub.chmod(gh_stub.stat().st_mode | stat.S_IXUSR)

            base_env = {
                **os.environ,
                "PATH": f"{stub_bin}{os.pathsep}{os.environ['PATH']}",
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_AUTHOR_NAME": "Test",
                "GIT_AUTHOR_EMAIL": "test@example.com",
                "GIT_COMMITTER_NAME": "Test",
                "GIT_COMMITTER_EMAIL": "test@example.com",
                "GH_TOKEN": "test-token",
                "GH_REPO": "Artic0din/Auger-Tizen",
                "GH_LOG": str(gh_log),
                "GH_API_LOG": str(gh_api_log),
                "PR_BODIES": str(pr_bodies),
            }

            def git(cwd: Path, *args: str) -> str:
                return subprocess.run(
                    ["git", *args], cwd=cwd, env=base_env, check=True, capture_output=True, text=True
                ).stdout.strip()

            git(root, "init", "--bare", "--quiet", "--initial-branch=main", str(origin))
            work.mkdir()
            git(work, "init", "--quiet", "--initial-branch=main")
            git(work, "remote", "add", "origin", str(origin))

            (work / "scripts").mkdir()
            shutil.copy2(SCRIPT_DIR / "generate-changelog.py", work / "scripts/generate-changelog.py")
            shutil.copy2(SCRIPT_DIR / "release-version.py", work / "scripts/release-version.py")
            (work / "CHANGELOG.md").write_text(
                f"{HEADER}<!-- changelog:releases -->\n\n## [Earlier changes]\n\n- Old.\n",
                encoding="utf-8",
            )
            git(work, "add", "scripts", "CHANGELOG.md")
            git(work, "commit", "--quiet", "-m", "feat(search): initial feature")
            older_sha = git(work, "rev-parse", "HEAD")

            git(work, "commit", "--quiet", "--allow-empty", "-m", "fix: old bug")
            prev_tag_sha = git(work, "rev-parse", "HEAD")
            git(work, "tag", "v0.1.0")

            git(work, "commit", "--quiet", "--allow-empty", "-m", "fix: stop a crash (#6)")
            git(work, "commit", "--quiet", "--allow-empty", "-m", "docs: mention (#12) in passing")
            git(work, "commit", "--quiet", "--allow-empty", "-m", "feat(player): add chapters (#5)")
            target_sha = git(work, "rev-parse", "HEAD")
            git(work, "push", "--quiet", "-u", "origin", "main", "--tags")

            publish_temp = root / "publish-temp"
            publish_temp.mkdir()
            github_output = root / "github-output.txt"
            github_summary = root / "github-summary.md"
            publish_env = {
                **base_env,
                "RUNNER_TEMP": str(publish_temp),
                "GITHUB_OUTPUT": str(github_output),
                "GITHUB_STEP_SUMMARY": str(github_summary),
                "VERSION": "0.2.0",
                "TAG": "v0.2.0",
                "PREVIOUS_TAG": "v0.1.0",
                "TARGET_SHA": target_sha,
            }
            publish_run = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", notes_script],
                cwd=work,
                env=publish_env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, publish_run.returncode, publish_run.stderr)

            outputs = dict(line.split("=", 1) for line in github_output.read_text(encoding="utf-8").splitlines())
            self.assertEqual(prev_tag_sha, outputs["previous_sha"])
            notes_text = (publish_temp / "notes.md").read_text(encoding="utf-8")
            self.assertTrue(notes_text.startswith(f"Released: {outputs['release_date']}\n\n## New\n\n"), notes_text)
            self.assertIn("## New\n\n- Pick a chapter from the player to jump straight to it.\n", notes_text)
            self.assertNotIn("Add chapters", notes_text)
            self.assertIn("## Fixed\n\n- Stop a crash\n", notes_text, "an unreadable PR falls back to its commit")
            self.assertIn("::warning::Could not read PR #6", publish_run.stdout)
            self.assertEqual(
                ['api repos/Artic0din/Auger-Tizen/pulls/5 --jq .body // ""', 'api repos/Artic0din/Auger-Tizen/pulls/6 --jq .body // ""'],
                gh_api_log.read_text(encoding="utf-8").splitlines(),
            )
            self.assertNotIn("- Old bug", notes_text)
            self.assertNotIn("Initial feature", notes_text)
            self.assertNotIn("## Install", notes_text)
            self.assertNotIn("Apps2Samsung", notes_text)
            self.assertNotIn("Sideload with Tizen Studio", notes_text)
            self.assertTrue(
                notes_text.endswith(
                    "\n\nFull technical details in [CHANGELOG.md](https://github.com/Artic0din/Auger-Tizen/blob/main/CHANGELOG.md). "
                    "Need help? See [Reporting Bugs](https://github.com/Artic0din/Auger-Tizen/blob/main/docs/reporting-bugs.md).\n"
                ),
                notes_text,
            )

            # A retry keeps the date of the release already published, in the new and the legacy body format.
            for body, date in (("Released: 2026-03-04\n\n## New", "2026-03-04"), ("# Updates - Auger v0.2.0 (2026-02-01)\n", "2026-02-01")):
                with self.subTest(body=body):
                    github_output.write_text("", encoding="utf-8")
                    retry = subprocess.run(
                        ["bash", "-euo", "pipefail", "-c", notes_script],
                        cwd=work,
                        env={**publish_env, "RELEASE_JSON": json.dumps({"isDraft": False, "body": body, "publishedAt": "2026-05-05T00:00:00Z"})},
                        capture_output=True,
                        text=True,
                    )
                    self.assertEqual(0, retry.returncode, retry.stderr)
                    self.assertIn(f"release_date={date}\n", github_output.read_text(encoding="utf-8"))
                    self.assertTrue((publish_temp / "notes.md").read_text(encoding="utf-8").startswith(f"Released: {date}\n"))

            # Move v0.1.0 to an older still-reachable commit before the changelog job runs.
            git(work, "tag", "-f", "v0.1.0", older_sha)
            git(work, "push", "--quiet", "-f", "origin", "refs/tags/v0.1.0")
            git(work, "checkout", "--quiet", "--detach", target_sha)

            # The job checks out without credentials, so a push to origin must fail here as it would in Release.
            git(work, "remote", "set-url", "--push", "origin", str(root / "no-push-to-origin"))

            changelog_temp = root / "changelog-temp"
            changelog_temp.mkdir()
            changelog_env_vars = {
                **base_env,
                "RUNNER_TEMP": str(changelog_temp),
                "VERSION": "0.2.0",
                "TAG": "v0.2.0",
                "PREVIOUS_SHA": outputs["previous_sha"],
                "TARGET_SHA": target_sha,
                "RELEASE_DATE": outputs["release_date"],
                "GITHUB_REPOSITORY": "Artic0din/Auger-Tizen",
                "CHANGELOG_DEPLOY_KEY": "test-deploy-key",
                # Route the job's SSH push to GitHub into the local bare origin.
                "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": f"url.{origin}.insteadOf",
                "GIT_CONFIG_VALUE_0": "git@github.com:Artic0din/Auger-Tizen.git",
            }
            changelog_run = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", changelog_script],
                cwd=work,
                env=changelog_env_vars,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, changelog_run.returncode, changelog_run.stderr)

            committed = git(origin, "show", "refs/heads/main:CHANGELOG.md")
            self.assertIn(f"## [0.2.0] - {outputs['release_date']}", committed)
            self.assertIn("### Features\n\n- **Playback**: Add chapters ([#5](https://github.com/Artic0din/Auger-Tizen/pull/5), [`", committed)
            self.assertIn("### Fixes\n\n- Stop a crash ([#6](https://github.com/Artic0din/Auger-Tizen/pull/6), [`", committed)
            self.assertIn("### Documentation\n\n- Mention (#12) in passing ([`", committed)
            self.assertNotIn("Pick a chapter", committed, "CHANGELOG.md stays the technical commit record")
            self.assertNotIn("/compare/", committed)
            self.assertNotIn("- Old bug", committed)
            self.assertNotIn("Initial feature", committed)
            self.assertEqual("docs(changelog): record v0.2.0 release notes", git(origin, "log", "-1", "--format=%s", "refs/heads/main"))
            self.assertIn("[skip ci]", git(origin, "log", "-1", "--format=%B", "refs/heads/main"), "the deploy-key push must not start Tizen Builds or Release")
            self.assertFalse(gh_log.exists(), "changelog job should push directly to main without opening a PR")

            # Re-running the changelog job for the same version is a no-op.
            head_after_first = git(origin, "rev-parse", "refs/heads/main")
            rerun = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", changelog_script],
                cwd=work,
                env=changelog_env_vars,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, rerun.returncode, rerun.stderr)
            self.assertEqual(head_after_first, git(origin, "rev-parse", "refs/heads/main"))

            # Simulate a competing commit advancing main on the first push attempt; the retry must preserve it and record v0.2.1.
            competing_dir = root / "competing"
            git(root, "clone", "--quiet", str(origin), str(competing_dir))
            (competing_dir / "NOTES.txt").write_text("concurrent commit\n", encoding="utf-8")
            git(competing_dir, "add", "NOTES.txt")
            git(competing_dir, "commit", "--quiet", "-m", "docs: concurrent note")
            competing_sha = git(competing_dir, "rev-parse", "HEAD")

            marker = root / "raced-once"
            hook = origin / "hooks" / "pre-receive"
            hook.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                f'if [[ ! -f "{marker}" ]]; then\n'
                f'  touch "{marker}"\n'
                f'  env -u GIT_DIR -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_QUARANTINE_PATH git -C "{competing_dir}" push --quiet origin HEAD:main\n'
                "  exit 1\n"
                "fi\n",
                encoding="utf-8",
            )
            hook.chmod(hook.stat().st_mode | stat.S_IXUSR)

            retry_run = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", changelog_script],
                cwd=work,
                env={**changelog_env_vars, "VERSION": "0.2.1", "TAG": "v0.2.1"},
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, retry_run.returncode, retry_run.stderr)
            self.assertTrue(marker.exists(), "expected first push attempt to race and trigger retry")
            self.assertEqual("concurrent commit", git(origin, "show", "refs/heads/main:NOTES.txt"))
            self.assertIn(f"## [0.2.1] - {outputs['release_date']}", git(origin, "show", "refs/heads/main:CHANGELOG.md"))
            self.assertEqual(competing_sha, git(origin, "rev-parse", "refs/heads/main^"))

            # Manual dispatch guard walks back past CHANGELOG.md-only commits to the passing code commit.
            prepare_block = extract_job_block(workflow_text, "prepare")
            build_guard_script = extract_step_run(prepare_block, "Require Tizen Builds to have passed on this commit")
            tip_sha = git(origin, "rev-parse", "refs/heads/main")
            git(work, "fetch", "--quiet", "origin", "main")
            git(work, "checkout", "--quiet", "--detach", tip_sha)
            gh_stub.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                'if [[ "${1:-}" == "run" && "${2:-}" == "list" ]]; then\n'
                '  commit=""\n'
                '  while [[ $# -gt 0 ]]; do\n'
                '    if [[ "$1" == "--commit" ]]; then commit="$2"; shift 2; else shift; fi\n'
                "  done\n"
                f'  if [[ "${{commit}}" == "{competing_sha}" ]]; then echo "success"; else echo "${{TIP_RUN_STATE:-missing}}"; fi\n'
                "  exit 0\n"
                "fi\n"
                "exit 1\n",
                encoding="utf-8",
            )
            guard_ok = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", build_guard_script],
                cwd=work,
                env={**base_env, "GITHUB_REPOSITORY": "Artic0din/Auger-Tizen", "TARGET_SHA": tip_sha},
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, guard_ok.returncode, guard_ok.stderr)
            guard_failed_tip = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", build_guard_script],
                cwd=work,
                env={**base_env, "GITHUB_REPOSITORY": "Artic0din/Auger-Tizen", "TARGET_SHA": tip_sha, "TIP_RUN_STATE": "failure"},
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(0, guard_failed_tip.returncode, "a failed run on a CHANGELOG.md tip must never fall back to a green parent")

    def test_release_signing_guard_requires_public_profile_without_personal_secrets(self):
        workflow_text = (SCRIPT_DIR.parent / ".github/workflows/release.yml").read_text(encoding="utf-8")
        wgt_block = extract_job_block(workflow_text, "wgt")
        self.assertNotIn("TIZEN_AUTHOR_", wgt_block)
        self.assertNotIn("TIZEN_DISTRIBUTOR_", wgt_block)

        guard_lines = wgt_block.splitlines()
        guard_index = next(
            i for i, line in enumerate(guard_lines) if line == "      - name: Require the public Tizen certificate"
        )
        condition = guard_lines[guard_index + 1].strip()
        self.assertEqual("if: steps.signing.outputs.signing != 'public'", condition)

        guard_script = extract_step_run(wgt_block, "Require the public Tizen certificate")
        for signing_value, expected_blocked in (("public", False), ("samsung", True), ("throwaway", True), ("", True)):
            with self.subTest(signing=signing_value):
                would_run = signing_value != "public"
                self.assertEqual(expected_blocked, would_run)
                if would_run:
                    guard_run = subprocess.run(
                        ["bash", "-euo", "pipefail", "-c", guard_script],
                        capture_output=True,
                        text=True,
                    )
                    self.assertNotEqual(0, guard_run.returncode)

        # Run create-signing-profile.sh against a stub SDK even when personal cert env vars are set.
        with tempfile.TemporaryDirectory() as tmp_name:
            root = Path(tmp_name)
            sdk_root = root / "tizen-studio"
            cli_dir = sdk_root / "tools/ide/bin"
            jdk_dir = sdk_root / "jdk/bin"
            dist_dir = sdk_root / "tools/certificate-generator/certificates/distributor"
            for directory in (cli_dir, jdk_dir, dist_dir):
                directory.mkdir(parents=True)
            (sdk_root / "org.tizen.common_1.0.jar").write_text("", encoding="utf-8")
            (sdk_root / "slf4j-api-1.0.jar").write_text("", encoding="utf-8")
            dist_p12 = dist_dir / "tizen-distributor-signer.p12"
            dist_p12.write_text("public-distributor", encoding="utf-8")

            tizen_log = root / "tizen.log"
            tizen_stub = cli_dir / "tizen"
            tizen_stub.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                'printf "%s\\n" "$*" >> "${TIZEN_LOG}"\n'
                'if [[ "${1:-}" == "certificate" ]]; then\n'
                '  out_dir="${!#}"\n'
                '  printf "author" > "${out_dir}/auger-public.p12"\n'
                "fi\n",
                encoding="utf-8",
            )
            javac_stub = jdk_dir / "javac"
            javac_stub.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
            java_stub = jdk_dir / "java"
            java_stub.write_text("#!/usr/bin/env bash\ncat\n", encoding="utf-8")
            for stub in (tizen_stub, javac_stub, java_stub):
                stub.chmod(stub.stat().st_mode | stat.S_IXUSR)

            runner_temp = root / "runner-temp"
            runner_temp.mkdir()
            github_env = root / "github-env.txt"
            github_output = root / "github-output.txt"
            env = {
                **os.environ,
                "PATH": f"{cli_dir}{os.pathsep}{os.environ['PATH']}",
                "RUNNER_TEMP": str(runner_temp),
                "GITHUB_ENV": str(github_env),
                "GITHUB_OUTPUT": str(github_output),
                "TIZEN_LOG": str(tizen_log),
                "TIZEN_AUTHOR_P12_B64": "should-be-ignored",
                "TIZEN_DISTRIBUTOR_P12_B64": "should-be-ignored",
            }
            profile_run = subprocess.run(
                ["bash", str(SCRIPT_DIR / "ci/create-signing-profile.sh")],
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, profile_run.returncode, profile_run.stderr)
            self.assertEqual("signing=public\n", github_output.read_text(encoding="utf-8"))
            self.assertEqual("TIZEN_SECURITY_PROFILE=auger-public\n", github_env.read_text(encoding="utf-8"))
            profiles_path = runner_temp / "tizen-signing/profiles.xml"
            profiles_xml = profiles_path.read_text(encoding="utf-8")
            self.assertIn(f'distributor="1" key="{dist_p12}"', profiles_xml)
            self.assertNotIn("should-be-ignored", profiles_xml)
            self.assertIn(f"cli-config profiles.path={profiles_path}", tizen_log.read_text(encoding="utf-8").splitlines())


if __name__ == "__main__":
    unittest.main()
