#!/usr/bin/env python3

import importlib.util
from pathlib import Path
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("pr_gate", Path(__file__).resolve().parent / "pr-gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

HEAD = "350887ea7ddadc34d4b53c7eb489fd56c6a6f704"


def check(name, conclusion="SUCCESS", started="2026-11-22T06:00:00Z", status="COMPLETED"):
    return {"name": name, "status": status, "conclusion": conclusion, "startedAt": started}


def ready_pr(**changes):
    pr = {"state": "OPEN", "mergeable": "MERGEABLE", "headRefOid": HEAD,
          "statusCheckRollup": [check(name) for name in gate.REQUIRED_CHECKS], "comments": []}
    pr.update(changes)
    return pr


class VerdictTest(unittest.TestCase):
    def test_ready_when_every_gate_passes(self):
        self.assertEqual(f"READY {HEAD}", gate.verdict(ready_pr(), [{"isResolved": True, "path": "a", "line": 1}]))

    def test_a_later_passing_run_replaces_a_stale_failure(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Typecheck, build, and native unit tests", "FAILURE", "2026-11-22T05:00:00Z")]
        self.assertTrue(gate.verdict(ready_pr(statusCheckRollup=rollup), []).startswith("READY"))
        rollup.append(check("Typecheck, build, and native unit tests", "FAILURE", "2026-11-22T07:00:00Z"))
        self.assertEqual("check not passing: Typecheck, build, and native unit tests=FAILURE", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_a_running_check_is_pending(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Kody Code Review", None, "2026-11-22T07:00:00Z", "IN_PROGRESS")]
        self.assertEqual("check not passing: Kody Code Review=PENDING", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_a_queued_rerun_outranks_an_older_pass(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Typecheck, build, and native unit tests", None, "0001-01-01T00:00:00Z", "QUEUED")]
        self.assertEqual("check not passing: Typecheck, build, and native unit tests=PENDING", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_a_stuck_older_run_does_not_mask_a_newer_pass(self):
        rollup = ready_pr()["statusCheckRollup"] + [check("Typecheck, build, and native unit tests", None, "2026-11-22T05:00:00Z", "IN_PROGRESS")]
        self.assertTrue(gate.verdict(ready_pr(statusCheckRollup=rollup), []).startswith("READY"))

    def test_unknown_mergeability_asks_for_a_retry(self):
        self.assertEqual("mergeability UNKNOWN: GitHub is still computing it, run again shortly",
                         gate.verdict(ready_pr(mergeable="UNKNOWN"), []))

    def test_a_conflicting_branch_names_the_fix_not_the_missing_checks(self):
        result = gate.verdict(ready_pr(mergeable="CONFLICTING", statusCheckRollup=[]), [])
        self.assertEqual("conflicts with main: merge main into the branch", result)

    def test_a_required_check_that_never_reported_fails(self):
        for name in (
            "Playwright UI tests (shard 3/3)",
            "All build and test checks",
            "Package and sign .wgt",
            "Gitleaks secret scan",
            "API v2 guard and automation script tests",
            "Standards / Repository baseline",
            "Standards / Pull request hygiene",
        ):
            with self.subTest(name=name):
                rollup = [c for c in ready_pr()["statusCheckRollup"] if c["name"] != name]
                self.assertEqual(f"check not reported: {name}", gate.verdict(ready_pr(statusCheckRollup=rollup), []))

    def test_unresolved_threads_are_listed(self):
        threads = [{"isResolved": False, "path": "src/ui/a.ts", "line": 4}, {"isResolved": True, "path": "b", "line": 1}]
        self.assertEqual("1 unresolved thread(s): src/ui/a.ts:4", gate.verdict(ready_pr(), threads))



class MainTest(unittest.TestCase):
    def test_a_push_between_reads_asks_for_a_rerun(self):
        threads = {"data": {"repository": {"pullRequest": {"headRefOid": "0" * 40,
                   "reviewThreads": {"totalCount": 0, "nodes": []}}}}}
        with mock.patch.object(gate, "gh", side_effect=[ready_pr(), threads]), \
                mock.patch.object(gate.sys, "argv", ["pr-gate.py", "826"]), \
                mock.patch("builtins.print") as printed:
            self.assertEqual(1, gate.main())
        printed.assert_called_once_with("#826 was pushed to while being checked; run again")

if __name__ == "__main__":
    unittest.main()
