#!/usr/bin/env python3

import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.error


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
                     "## Evidence\n\n`https://example.com/after.png`\n",
                     "## Evidence\n\n``a ` https://example.com/after.png``\n",
                     "## Evidence\n\n~~~markdown\n![a](https://example.com/after.png)\n~~~\n",
                     "## Evidence\r\n\r\n```\r\n![a](https://example.com/after.png)\r\n```\r\n",
                     "## Evidence\n\n- Example:\n\n    ```\n    ![a](https://example.com/after.png)\n    ```\n",
                     "## Evidence\n\n```\n![a](https://example.com/after.png)\n`````\n",
                     "## Evidence\n\nPending.\n\n# Risks\n\n![diagram](https://example.com/diagram.png)\n"):
            with self.subTest(body=body):
                result = self.check(head, body)
                self.assertEqual(1, result.returncode, result.stdout)
                self.assertIn("needs evidence because it changes src/ui/home.ts", result.stdout)

    def test_passes_captures_under_an_evidence_or_comparison_heading(self):
        head = self.commit({"app/index.html": "<html></html>\n"})
        for body in (f"## Evidence\n\n| Before | After |\n| --- | --- |\n| ![a]({CAPTURE}) | ![b]({CAPTURE}) |\n",
                     f"## Signed comparison\n\n<img src=\"{CAPTURE}\">\n",
                     "## Apple evidence\n\n### Home\n\n![home](https://example.com/home.png)\n",
                     f"# Evidence\n\n![tv]({CAPTURE})\n",
                     f"## Evidence\n\nRan ```npm test```.\n\n![tv]({CAPTURE})\n\n```\nlog\n```\n"):
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
        result = self.check(head)
        self.assertEqual(1, result.returncode, result.stderr)
        self.assertIn("needs evidence because it changes src/ui/home.ts", result.stdout)

    def test_fails_a_capture_left_by_a_failed_upload(self):
        head = self.commit({"src/ui/home.ts": "export {};\n"})
        body = f"## Evidence\n\n![a]({CAPTURE})\n![b](https://github.com/o/r/blob//805-after.png?raw=true)\n"
        result = self.check(head, body)
        self.assertEqual(1, result.returncode, result.stdout)
        self.assertIn("Evidence link does not load (an empty path segment)", result.stdout)


class BrokenCaptureTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("check_evidence", SCRIPT)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def test_reports_a_repository_link_that_does_not_resolve(self):
        missing = urllib.error.HTTPError("u", 404, "Not Found", {}, None)
        with mock.patch.object(self.module.urllib.request, "urlopen", side_effect=missing) as urlopen:
            self.assertEqual("HTTP 404", self.module.broken_capture("https://github.com/o/r/blob/abc/a.png"))
        self.assertEqual("HEAD", urlopen.call_args.args[0].get_method())

    def test_accepts_a_repository_link_that_resolves(self):
        response = mock.MagicMock(status=200)
        response.__enter__.return_value = response
        with mock.patch.object(self.module.urllib.request, "urlopen", return_value=response):
            self.assertIsNone(self.module.broken_capture("https://github.com/o/r/blob/abc/a.png"))

    def test_leaves_signed_in_and_other_hosts_unfetched(self):
        with mock.patch.object(self.module.urllib.request, "urlopen") as urlopen:
            self.assertIsNone(self.module.broken_capture(CAPTURE))
            self.assertIsNone(self.module.broken_capture("https://example.com/home.png"))
        urlopen.assert_not_called()


if __name__ == "__main__":
    unittest.main()
