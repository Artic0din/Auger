#!/usr/bin/env python3

import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("pr_gate", Path(__file__).resolve().parent / "pr-gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

HEAD = "350887ea7ddadc34d4b53c7eb489fd56c6a6f704"


def codex(sha, status="completed", login="chatgpt-codex-connector"):
    state = f'{{"code_review":{{"commit_sha":"{sha}","status":"{status}"}},"security_review":{{}}}}'
    return {"author": {"login": login}, "body": f"<!-- codex-review-state:v1 {state} -->\nCodex Review Summary"}


def check(name, conclusion="SUCCESS", started="2026-11-22T06:00:00Z", status="COMPLETED"):
    return {"name": name, "status": status, "conclusion": conclusion, "startedAt": started}


def ready_pr(**changes):
    pr = {"state": "OPEN", "mergeable": "MERGEABLE", "headRefOid": HEAD,
          "statusCheckRollup": [check(name) for name in gate.REQUIRED_CHECKS], "comments": [codex(HEAD)]}
    pr.update(changes)
    return pr


class VerdictTest(unittest.TestCase):
    def test_ready_when_every_gate_passes(self):
        self.assertEqual(f"READY {HEAD}", gate.verdict(ready_pr(), [{"isResolved": True, "path": "a", "line": 1}]))

    def test_a_later_passing_run_replaces_a_stale_failure(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Evidence", "FAILURE", "2026-11-22T05:00:00Z")]
        self.assertTrue(gate.verdict(ready_pr(statusCheckRollup=rollup), []).startswith("READY"))
        rollup.append(check("Evidence", "FAILURE", "2026-11-22T07:00:00Z"))
        self.assertEqual("check not passing: Evidence=FAILURE", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_a_running_check_is_pending(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Kody Code Review", None, "2026-11-22T07:00:00Z", "IN_PROGRESS")]
        self.assertEqual("check not passing: Kody Code Review=PENDING", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_a_queued_rerun_outranks_an_older_pass(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Evidence", None, "0001-01-01T00:00:00Z", "QUEUED")]
        self.assertEqual("check not passing: Evidence=PENDING", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_a_stuck_older_run_does_not_mask_a_newer_pass(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Evidence", None, "2026-11-22T05:00:00Z", "IN_PROGRESS")]
        self.assertTrue(gate.verdict(ready_pr(statusCheckRollup=rollup), []).startswith("READY"))

    def test_unknown_mergeability_asks_for_a_retry(self):
        self.assertEqual("mergeability UNKNOWN: GitHub is still computing it, run again shortly",
                         gate.verdict(ready_pr(mergeable="UNKNOWN"), []))

    def test_a_conflicting_branch_names_the_fix_not_the_missing_checks(self):
        result = gate.verdict(ready_pr(mergeable="CONFLICTING", statusCheckRollup=[]), [])
        self.assertEqual("conflicts with main: merge main into the branch", result)

    def test_a_required_check_that_never_reported_fails(self):
        rollup = [c for c in ready_pr()["statusCheckRollup"] if c["name"] != "tvOS source"]
        self.assertEqual("check not reported: tvOS source", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_codex_must_have_completed_the_head_commit(self):
        for comments in ([], [codex("0" * 40)], [codex(HEAD, "running")], [codex(HEAD), codex("0" * 40)],
                         [codex(HEAD, login="someone")]):
            with self.subTest(comments=comments):
                self.assertEqual("Codex has not completed a review of 350887ea",
                                 gate.verdict(ready_pr(comments=comments), []))

    def test_unresolved_threads_are_listed(self):
        threads = [{"isResolved": False, "path": "src/ui/a.ts", "line": 4}, {"isResolved": True, "path": "b", "line": 1}]
        self.assertEqual("1 unresolved thread(s): src/ui/a.ts:4", gate.verdict(ready_pr(), threads))


if __name__ == "__main__":
    unittest.main()
