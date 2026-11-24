#!/usr/bin/env python3

import contextlib
import importlib.util
import io
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

        notes_script = extract_step_run(publish_block, "Write the release notes")
        changelog_script = extract_step_run(changelog_block, "Open a pull request to record the release in CHANGELOG.md")

        with tempfile.TemporaryDirectory() as tmp_name:
            root = Path(tmp_name)
            origin = root / "origin.git"
            work = root / "work"
            stub_bin = root / "bin"
            stub_bin.mkdir()
            gh_log = root / "gh.log"

            gh_stub = stub_bin / "gh"
            gh_stub.write_text(
                "#!/usr/bin/env bash\n"
                "set -euo pipefail\n"
                'if [[ "${1:-}" == "release" && "${2:-}" == "view" ]]; then\n'
                "  exit 1\n"
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

            git(work, "commit", "--quiet", "--allow-empty", "-m", "feat(player): add chapters")
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
            self.assertIn("- **Playback**: Add chapters", notes_text)
            self.assertNotIn("- Old bug", notes_text)
            self.assertNotIn("Initial feature", notes_text)

            # Move v0.1.0 to an older still-reachable commit before the changelog job runs.
            git(work, "tag", "-f", "v0.1.0", older_sha)
            git(work, "push", "--quiet", "-f", "origin", "refs/tags/v0.1.0")
            git(work, "checkout", "--quiet", "--detach", target_sha)

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
            }
            changelog_run = subprocess.run(
                ["bash", "-euo", "pipefail", "-c", changelog_script],
                cwd=work,
                env=changelog_env_vars,
                capture_output=True,
                text=True,
            )
            self.assertEqual(0, changelog_run.returncode, changelog_run.stderr)

            committed = git(origin, "show", "refs/heads/docs/changelog-v0.2.0:CHANGELOG.md")
            self.assertIn(f"## [0.2.0] - {outputs['release_date']}", committed)
            self.assertIn("- **Playback**: Add chapters", committed)
            self.assertNotIn("- Old bug", committed)
            self.assertNotIn("Initial feature", committed)
            self.assertIn("--head docs/changelog-v0.2.0", gh_log.read_text(encoding="utf-8"))

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
