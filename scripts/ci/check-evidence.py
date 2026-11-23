#!/usr/bin/env python3
"""Fail a pull request that changes visible code without attaching captures under an Evidence heading.

Implements the Evidence check described in CONTRIBUTING.md ("Show visible changes") and .github/evidence.yml.
It proves captures are attached and that repository links load, not that they show the right device or state; reviewers still judge that.
"""

import fnmatch
import http.client
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

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


# Repository file links on this public repository resolve without credentials, so CI can confirm them.
# GitHub user-attachments links need a signed-in session and are only checked for shape.
FETCHED_HOSTS = {"github.com", "raw.githubusercontent.com"}


def broken_capture(url: str) -> str | None:
    """Return why a capture link cannot load, or None when it loads."""
    parts = urlsplit(url)
    # An upload that failed silently leaves an empty commit segment, such as blob//shot.png.
    if "//" in parts.path:
        return "an empty path segment"
    if parts.hostname not in FETCHED_HOSTS or "/user-attachments/" in parts.path:
        return None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=15) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    except (OSError, http.client.HTTPException, ValueError) as error:
        return f"no response ({error})"
    return None if status == 200 else f"HTTP {status}"


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
    body = body.replace("\r\n", "\n")  # GitHub sends PR bodies with CRLF line endings.
    body = re.sub(r"<!--.*?-->", "", body, flags=re.DOTALL)
    body = re.sub(r"^[ \t>]*(`{3,}|~{3,})[^`\n]*\n.*?^[ \t>]*\1\1?[`~]*[ \t]*$", "", body, flags=re.DOTALL | re.MULTILINE)
    body = re.sub(r"(`+)[^\n]*?\1", "", body)
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
    captures = [match.group(0) for match in MEDIA.finditer(evidence_text(env.get("BODY") or ""))]
    if captures:
        broken = [(url, reason) for url in dict.fromkeys(captures) if (reason := broken_capture(url))]
        for url, reason in broken:
            print(f"::error::Evidence link does not load ({reason}): {url}. Upload it again and update the link.")
        if broken:
            return 1
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
