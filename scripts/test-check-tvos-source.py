#!/usr/bin/env python3

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "ci" / "check-tvos-source.py"
# The fixture uses the checked-in rules, so the tests fail if those rules stop covering a path.
RULES = (Path(__file__).resolve().parent.parent / ".github" / "tvos-source.yml").read_text()
CITED = "## tvOS source\n\nsilo-apple 71a3beb9\n\n- `tvOS/Screens/Components/TVCollectionPosterCard.swift:106-148`\n"


class CheckTvosSourceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-q", "-b", "main")
        self.commit({".github/tvos-source.yml": RULES, "README.md": "fixture\n"})
        self.base = self.git("rev-parse", "HEAD")

    def git(self, *arguments):
        identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"]
        return subprocess.run(["git", *identity, *arguments], cwd=self.root, capture_output=True,
                              text=True, check=True).stdout.strip()

    def commit(self, files):
        for path, text in files.items():
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(text)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "fixture")
        return self.git("rev-parse", "HEAD")

    def check(self, head, body="", labels=""):
        environment = dict(os.environ, BASE=self.base, HEAD=head, BODY=body, LABELS=labels)
        return subprocess.run(["python3", "-I", str(SCRIPT)], cwd=self.root, env=environment,
                              capture_output=True, text=True, timeout=30)

    def test_skips_changes_outside_the_interface(self):
        result = self.check(self.commit({"src/api/http.ts": "export {};\n", "src/session/core.ts": "export {};\n",
                                          "docs/notes.md": "text\n"}))
        self.assertEqual(0, result.returncode, result.stdout)
        self.assertIn("tvOS source not required", result.stdout)

    def test_fails_an_interface_change_without_a_citation(self):
        head = self.commit({"src/ui/home.ts": "export {};\n"})
        for body in ("",
                     "## tvOS source\n\nMatches Apple.\n",
                     "## tvOS source\n\n<!-- tvOS/Screens/Home/HomeView.swift:79 -->\n",
                     "## tvOS source\n\n`tvOS/Screens/Home/HomeView.swift` (no line)\n",
                     "## Approach\n\nPorts tvOS/Screens/Home/HomeView.swift:79.\n\n## tvOS source\n\nsilo-apple 71a3beb9, see above.\n",
                     "## tvOS source\n\nsilo-apple 71a3beb9\n\n## Risks\n\ntvOS/Screens/Home/HomeView.swift:79\n",
                     "## tvOS source\n\ntvOS/Screens/Home/HomeView.swift:79 (no commit named)\n",
                     "## tvOS source\n\nTizen 1303cf9d, tvOS/Screens/Home/HomeView.swift:79\n",
                     "## Approach\n\n```markdown\n## tvOS source\n\nsilo-apple 71a3beb9 HomeView.swift:79\n```\n"):
            with self.subTest(body=body):
                result = self.check(head, body)
                self.assertEqual(1, result.returncode, result.stdout)
                self.assertIn("changes src/ui/home.ts", result.stdout)

    def test_passes_a_cited_line_or_range_under_the_heading(self):
        head = self.commit({"src/player/controller.ts": "export {};\n"})
        for body in (CITED,
                     "### tvOS Source\n\nsilo-apple `f70e16a`, Screens/Player/tvOS/TVPlayerControls.swift:583\n",
                     "## tvOS source\r\n\r\n- silo-apple commit: 71a3beb9c0c4b6774b5caca452dfec66f208ac8f\r\n- PlayerView.swift:1613-1635\r\n",
                     "## tvOS source\n\nsilo-apple 71a3beb9\n\n### Card\n\nTVCollectionPosterCard.swift:106\n",
                     "## tvOS source\n\nsilo-apple commit: 8465631\n\nHomeView.swift:79\n",
                     "## tvOS source\n\nsilo-apple commit: abcdefa\n\nHomeView.swift:79\n"):
            with self.subTest(body=body):
                result = self.check(head, body)
                self.assertEqual(0, result.returncode, result.stdout)
                self.assertIn("tvOS source cited", result.stdout)

    def test_fails_an_uncited_player_change(self):
        result = self.check(self.commit({"src/player/controller.ts": "export {};\n"}), "## tvOS source\n\nPending.\n")
        self.assertEqual(1, result.returncode, result.stdout)
        self.assertIn("changes src/player/controller.ts", result.stdout)

    def test_reads_rules_with_an_inline_comment_and_rejects_empty_rules(self):
        self.base = self.commit({".github/tvos-source.yml": "require: # paths\n  - src/ui/**\n"})
        head = self.commit({"src/ui/home.ts": "export {};\n"})
        self.assertEqual(1, self.check(head, "").returncode)
        self.base = self.commit({".github/tvos-source.yml": "require: []\n"})
        head = self.commit({"src/ui/home.ts": "export const a = 1;\n"})
        result = self.check(head, CITED)
        self.assertNotEqual(0, result.returncode)
        self.assertIn("no require paths", result.stdout + result.stderr)

    def test_shared_styles_and_shell_need_a_citation(self):
        base = self.base
        for path in ("src/theme.css", "src/app.css", "src/app.ts", "src/bootstrap.ts", "src/main.ts", "app/index.html", "src/i18n/catalog/en.json"):
            with self.subTest(path=path):
                self.git("reset", "-q", "--hard", base)  # each diff holds only the path under test
                head = self.commit({path: f"/* {path} */\n"})
                self.assertEqual(1, self.check(head, "").returncode)
                self.assertEqual(0, self.check(head, CITED).returncode)

    def test_label_waives_the_check(self):
        head = self.commit({"src/ui/home.ts": "export {};\n"})
        result = self.check(head, "", "bug,tvos-source-not-needed")
        self.assertEqual(0, result.returncode, result.stdout)
        self.assertIn("label is set", result.stdout)

    def test_uses_the_base_commits_rules(self):
        head = self.commit({".github/tvos-source.yml": "require:\n  - nothing/**\n", "src/ui/home.ts": "export {};\n"})
        result = self.check(head, "")
        self.assertEqual(1, result.returncode, result.stdout)


if __name__ == "__main__":
    unittest.main()
