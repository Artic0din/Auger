#!/usr/bin/env python3

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "ci" / "check-evidence.py"
RULES = "# comment\nrequire:\n  - app/**\n  - src/**\n"
CAPTURE = "https://github.com/user-attachments/assets/0a1b2c3d-0000-4000-8000-000000000000"


class CheckEvidenceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-q", "-b", "main")
        self.commit({".github/evidence.yml": RULES, "README.md": "fixture\n"})
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

    def test_skips_changes_outside_the_required_paths(self):
        result = self.check(self.commit({"docs/notes.md": "text\n"}))
        self.assertEqual(0, result.returncode, result.stdout)
        self.assertIn("Evidence not required", result.stdout)

    def test_fails_a_visible_change_without_captures(self):
        head = self.commit({"src/ui/home.ts": "export {};\n"})
        for body in ("", "## Evidence\n\n| Before | After |\n| ------ | ----- |\n| | |\n",
                     "## Evidence\n\n<!-- ![x](https://github.com/user-attachments/assets/a) -->\nPending.\n",
                     "## Validation\n\n![x](https://example.com/shot.png)\n\n## Evidence\n\nEvidence: none, no user-visible change\n",
                     "## Evidence\n\nStill need to capture before.png and after.png.\n",
                     "## Evidence\n\n`https://example.com/after.png`\n"):
            with self.subTest(body=body):
                result = self.check(head, body)
                self.assertEqual(1, result.returncode, result.stdout)
                self.assertIn("needs evidence because it changes src/ui/home.ts", result.stdout)

    def test_passes_captures_under_an_evidence_or_comparison_heading(self):
        head = self.commit({"app/index.html": "<html></html>\n"})
        for body in (f"## Evidence\n\n| Before | After |\n| --- | --- |\n| ![a]({CAPTURE}) | ![b]({CAPTURE}) |\n",
                     f"## Signed comparison\n\n<img src=\"{CAPTURE}\">\n",
                     "## Apple evidence\n\n### Home\n\n![home](https://example.com/home.png)\n"):
            with self.subTest(body=body):
                result = self.check(head, body)
                self.assertEqual(0, result.returncode, result.stdout)

    def test_moving_a_file_out_of_a_required_path_needs_evidence(self):
        self.base = self.commit({"app/logo.svg": "<svg/>\n"})
        (self.root / "docs").mkdir()
        self.git("mv", "app/logo.svg", "docs/logo.svg")
        self.git("commit", "-q", "-m", "move")
        result = self.check(self.git("rev-parse", "HEAD"))
        self.assertEqual(1, result.returncode, result.stdout)
        self.assertIn("app/logo.svg", result.stdout)

    def test_labels_override_the_paths(self):
        head = self.commit({"src/ui/home.ts": "export {};\n"})
        self.assertEqual(0, self.check(head, labels="bug, evidence-not-needed").returncode)
        docs = self.commit({"docs/notes.md": "text\n"})
        result = self.check(docs, labels="evidence-required")
        self.assertEqual(1, result.returncode, result.stdout)
        self.assertIn("the evidence-required label is set", result.stdout)

    def test_reads_the_rules_from_the_base_commit(self):
        head = self.commit({".github/evidence.yml": "require: []\n", "src/ui/home.ts": "export {};\n"})
        self.assertEqual(1, self.check(head).returncode)


if __name__ == "__main__":
    unittest.main()
