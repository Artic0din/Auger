#!/usr/bin/env python3
"""Fail a pull request that changes the TV interface without citing the silo-apple tvOS source it ports.

Implements the tvOS source check described in CONTRIBUTING.md ("Port from the tvOS source") and
.github/tvos-source.yml. It proves a Swift file and line are cited, not that the port is faithful;
reviewers still judge that.
"""

import os
import re
import subprocess
import sys

NOT_NEEDED = "tvos-source-not-needed"
HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
SOURCE_HEADING = re.compile(r"tvos\s+source", re.IGNORECASE)
# A citation is a Swift file with a line or line range, such as tvOS/Screens/Detail/TVSeriesDetailView.swift:852-854.
CITATION = re.compile(r"[\w./-]+\.swift:\d+(?:-\d+)?")
# AGENTS.md "Parity delivery gates" asks for the source revision, so a line in the section names the silo-apple commit.
REVISION = re.compile(r"silo-apple\b[^\n]*?\b[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\b[^\n]*?silo-apple", re.IGNORECASE)
FENCE = re.compile(r"^[ \t>]*(`{3,}|~{3,})[^`\n]*\n.*?^[ \t>]*\1\1?[`~]*[ \t]*$", re.DOTALL | re.MULTILINE)


def matches(path: str, pattern: str) -> bool:
    # Path-aware glob: "*" stays within one folder and "**" crosses folders, so src/*.ts doesn't match src/api/http.ts.
    regex = "".join(".*" if part == "**" else "[^/]*" if part == "*" else "[^/]" if part == "?" else re.escape(part)
                    for part in re.split(r"(\*\*|\*|\?)", pattern))
    return re.fullmatch(regex, path) is not None


def git(*arguments: str) -> str:
    return subprocess.run(["git", *arguments], capture_output=True, text=True, check=True).stdout


def required_patterns(base: str) -> list[str]:
    # The base commit's rules apply, so a pull request cannot relax its own requirement.
    shown = subprocess.run(["git", "show", f"{base}:.github/tvos-source.yml"], capture_output=True, text=True)
    if shown.returncode != 0:
        return []
    patterns, in_require = [], False
    for line in shown.stdout.splitlines():
        if re.match(r"^require:\s*(#.*)?$", line):
            in_require = True
        elif in_require and (match := re.match(r"^\s+-\s+(\S+)\s*$", line)):
            patterns.append(match.group(1).strip("'\""))
        elif line.strip() and not line.startswith((" ", "#")):
            in_require = False
    if not patterns:
        # A rules file that yields no paths would silently pass everything.
        raise SystemExit("::error::.github/tvos-source.yml has no require paths this check can read")
    return patterns


def source_text(body: str) -> str:
    body = body.replace("\r\n", "\n")  # GitHub sends PR bodies with CRLF line endings.
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    body = FENCE.sub("", body)
    sections, level = [], None
    for line in body.splitlines():
        heading = HEADING.match(line)
        if heading:
            depth = len(heading.group(1))
            if level is not None and depth <= level:
                level = None
            if level is None and SOURCE_HEADING.search(heading.group(2)):
                level = depth
            continue
        if level is not None:
            sections.append(line)
    return "\n".join(sections)


def main() -> int:
    env = os.environ
    labels = {label.strip() for label in env.get("LABELS", "").split(",") if label.strip()}
    if NOT_NEEDED in labels:
        print(f"tvOS source not needed: the {NOT_NEEDED} label is set")
        return 0
    patterns = required_patterns(env["BASE"])
    changed = [path for path in git("diff", "-z", "--no-renames", "--name-only", f"{env['BASE']}...{env['HEAD']}").split("\0") if path]
    touched = [path for path in changed if any(matches(path, pattern) for pattern in patterns)]
    if not touched:
        print("tvOS source not required: no changed path matches .github/tvos-source.yml")
        return 0
    section = source_text(env.get("BODY") or "")
    if CITATION.search(section) and REVISION.search(section):
        print("tvOS source cited")
        return 0
    print(
        f"::error::This pull request changes {', '.join(touched[:3])}, so it needs the silo-apple tvOS source it ports. "
        "Under a \"tvOS source\" heading, name the silo-apple commit you read and cite each Swift file and line range "
        "(for example tvOS/Screens/Detail/TVSeriesDetailView.swift:852-854), as CONTRIBUTING.md \"Port from the tvOS source\" describes. "
        f"A maintainer adds the {NOT_NEEDED} label when the change has no tvOS counterpart."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
