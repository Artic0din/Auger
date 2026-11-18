#!/usr/bin/env python3
"""Fail a pull request that changes visible code without attaching captures under an Evidence heading.

Implements the Evidence check described in CONTRIBUTING.md ("Show visible changes") and .github/evidence.yml.
It proves captures are attached, not that they show the right device or state; reviewers still judge that.
"""

import fnmatch
import os
import re
import subprocess
import sys

NOT_NEEDED = "evidence-not-needed"
REQUIRED = "evidence-required"
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
EVIDENCE_HEADING = re.compile(r"evidence|comparison", re.IGNORECASE)
# A capture is a URL: a GitHub upload, or an http(s) link to an image or video. Bare filenames are not captures.
MEDIA = re.compile(
    r"https://github\.com/user-attachments/(assets|files)/\S+"
    r"|https://(private-)?user-images\.githubusercontent\.com/\S+"
    r"|https?://[^\s)\"'<>]+\.(png|jpe?g|gif|webp|mp4|mov|webm)\b",
    re.IGNORECASE,
)


def git(*arguments: str) -> str:
    return subprocess.run(["git", *arguments], capture_output=True, text=True, check=True).stdout


def required_patterns(base: str) -> list[str]:
    # The base commit's rules apply, so a pull request cannot relax its own requirement.
    shown = subprocess.run(["git", "show", f"{base}:.github/evidence.yml"], capture_output=True, text=True)
    if shown.returncode != 0:
        return []
    patterns, in_require = [], False
    for line in shown.stdout.splitlines():
        if re.match(r"^require:\s*$", line):
            in_require = True
        elif in_require and (match := re.match(r"^\s+-\s+(\S+)\s*$", line)):
            patterns.append(match.group(1).strip("'\""))
        elif line.strip() and not line.startswith((" ", "#")):
            in_require = False
    return patterns


def evidence_text(body: str) -> str:
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    body = re.sub(r"```.*?```", "", body, flags=re.DOTALL)
    body = re.sub(r"`[^`\n]*`", "", body)
    sections, level = [], None
    for line in body.splitlines():
        heading = HEADING.match(line)
        if heading:
            depth = len(heading.group(1))
            if level is not None and depth <= level:
                level = None
            if level is None and EVIDENCE_HEADING.search(heading.group(2)):
                level = depth
            continue
        if level is not None:
            sections.append(line)
    return "\n".join(sections)


def main() -> int:
    env = os.environ
    labels = {label.strip() for label in env.get("LABELS", "").split(",") if label.strip()}
    if NOT_NEEDED in labels:
        print(f"Evidence not needed: the {NOT_NEEDED} label is set")
        return 0
    patterns = required_patterns(env["BASE"])
    # Without rename detection, moving a file out of app/ or src/ still counts as changing it.
    changed = [path for path in git("diff", "-z", "--no-renames", "--name-only", f"{env['BASE']}...{env['HEAD']}").split("\0") if path]
    touched = [path for path in changed if any(fnmatch.fnmatch(path, pattern) for pattern in patterns)]
    if REQUIRED not in labels and not touched:
        print("Evidence not required: no changed path matches .github/evidence.yml")
        return 0
    if MEDIA.search(evidence_text(env.get("BODY") or "")):
        print("Evidence attached")
        return 0
    reason = f"the {REQUIRED} label is set" if REQUIRED in labels else f"it changes {', '.join(touched[:3])}"
    print(
        f"::error::This pull request needs evidence because {reason}. Attach same-state before-and-after captures "
        "(Samsung TV and Apple TV) under the Evidence heading, as CONTRIBUTING.md \"Show visible changes\" describes. "
        f"A maintainer adds the {NOT_NEEDED} label when nothing visible changed."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
