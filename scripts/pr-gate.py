#!/usr/bin/env python3
"""Print whether a pull request meets the merge gate, as READY or the first gate it fails.

Usage: python3 scripts/pr-gate.py <number>

The gate: open and mergeable, every check's latest run passed (including Evidence,
tvOS source and the UI shards), Codex reviewed the head commit, Kody finished,
and no review thread is unresolved. Exit status is 0 only for READY.
"""

import json
import re
import subprocess
import sys

REPOSITORY = "Artic0din/silo-tizen"
REQUIRED_CHECKS = ("Evidence", "tvOS source", "Build and native tests",
                   "UI tests (1/3)", "UI tests (2/3)", "UI tests (3/3)", "Kody Code Review")
PASSING = {"SUCCESS", "SKIPPED", "NEUTRAL"}
CODEX_STATE = re.compile(r"codex-review-state:v1 (\{.*?\}) -->")
CODEX_LOGIN = "chatgpt-codex-connector"
THREADS = """query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){
pullRequest(number:$number){headRefOid reviewThreads(first:100){totalCount nodes{isResolved path line}}}}}"""


def latest_checks(rollup: list[dict]) -> dict[str, str]:
    """Map each check name to the outcome of its most recent run; a re-run replaces a stale failure."""
    latest: dict[str, tuple[str, str]] = {}
    for check in rollup:
        name = check.get("name") or check.get("context") or ""
        started = check.get("startedAt") or check.get("createdAt") or ""
        if check.get("status") not in (None, "COMPLETED"):
            outcome = "PENDING"
        else:
            outcome = check.get("conclusion") or check.get("state") or "PENDING"
        if started.startswith("0001-"):
            started = ""  # gh prints Go's zero time for a run that has not started.
        if not started and outcome == "PENDING":
            started = "\uffff"  # A queued re-run has no start time yet and must not lose to the run it replaces.
        if name not in latest or started >= latest[name][0]:
            latest[name] = (started, outcome)
    return {name: outcome for name, (_, outcome) in latest.items()}


def codex_reviewed(comments: list[dict], head: str) -> bool:
    for comment in reversed(comments):
        if (comment.get("author") or {}).get("login") != CODEX_LOGIN:
            continue
        if match := CODEX_STATE.search(comment.get("body", "")):
            review = json.loads(match.group(1)).get("code_review") or {}
            return review.get("commit_sha") == head and review.get("status") == "completed"
    return False


def verdict(pr: dict, threads: list[dict]) -> str:
    if pr["state"] != "OPEN":
        return f"not open ({pr['state']})"
    if pr["mergeable"] == "CONFLICTING":
        # A conflicting pull request runs no CI, so its check list looks short rather than red.
        return "conflicts with main: merge main into the branch"
    if pr["mergeable"] != "MERGEABLE":
        return f"mergeability {pr['mergeable']}: GitHub is still computing it, run again shortly"
    checks = latest_checks(pr["statusCheckRollup"])
    missing = [name for name in REQUIRED_CHECKS if name not in checks]
    if missing:
        return f"check not reported: {', '.join(missing)}"
    failing = [f"{name}={outcome}" for name, outcome in sorted(checks.items()) if outcome not in PASSING]
    if failing:
        return f"check not passing: {', '.join(failing)}"
    head = pr["headRefOid"]
    if not codex_reviewed(pr["comments"], head):
        return f"Codex has not completed a review of {head[:8]}"
    open_threads = [f"{t['path']}:{t['line']}" for t in threads if not t["isResolved"]]
    if open_threads:
        return f"{len(open_threads)} unresolved thread(s): {', '.join(open_threads)}"
    return f"READY {head}"


def gh(*arguments: str) -> dict:
    return json.loads(subprocess.run(["gh", *arguments], capture_output=True, text=True, check=True).stdout)


def main() -> int:
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    number = sys.argv[1]
    pr = gh("pr", "view", number, "-R", REPOSITORY,
            "--json", "state,mergeable,headRefOid,statusCheckRollup,comments")
    owner, name = REPOSITORY.split("/")
    page = gh("api", "graphql", "-f", f"query={THREADS}", "-F", f"owner={owner}", "-F", f"name={name}",
              "-F", f"number={number}")["data"]["repository"]["pullRequest"]
    if page["headRefOid"] != pr["headRefOid"]:
        print(f"#{number} was pushed to while being checked; run again")
        return 1
    page = page["reviewThreads"]
    if page["totalCount"] > len(page["nodes"]):
        print(f"#{number} has {page['totalCount']} review threads; check the ones past 100 by hand")
        return 1
    result = verdict(pr, page["nodes"])
    print(f"#{number} {result}")
    return 0 if result.startswith("READY") else 1


if __name__ == "__main__":
    sys.exit(main())
