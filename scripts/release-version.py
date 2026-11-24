#!/usr/bin/env python3
"""Pick the next release version and tag from Conventional Commits.

The next version bumps the latest vX.Y.Z tag by the largest change since it:

- a breaking change (`feat!:`, `fix(ui)!:`, or a `BREAKING CHANGE:` line in the
  body) bumps the major version;
- `feat` bumps the minor version;
- `fix`, `perf` and `revert` (or a `Revert "..."` subject) bump the patch;
- anything else (`docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build`,
  merge commits) makes no release.

Older tester tags (vX.Y.Z-beta.B, vX.Y.Z+B) count as their X.Y.Z, below an
exact vX.Y.Z tag of the same version. A commit that is already at or behind
the latest exact release tag makes no release, so re-running is safe.

Tizen widget versions are X.Y.Z with X and Y at most 255 and Z at most 65535,
so every version this script picks is checked against those limits.

Prints key=value lines for $GITHUB_OUTPUT:

    release-version.py next [--bump auto|patch|minor|major] [--version X.Y.Z] [--target HEAD]
"""

import argparse
from dataclasses import dataclass
from enum import IntEnum
import re
import subprocess
import sys
from typing import Iterable, Optional

TAG = re.compile(r"v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?")
VERSION = re.compile(r"(\d+)\.(\d+)\.(\d+)")
HEADER = re.compile(r"([a-z]+)(?:\([^)]*\))?(!)?:\s+.+", re.IGNORECASE)
BREAKING = re.compile(r"^BREAKING[- ]CHANGE:", re.MULTILINE)
PATCH_TYPES = {"fix", "perf", "revert"}
MANUAL_BUMPS = ("patch", "minor", "major")

TIZEN_MAX_MAJOR = 255
TIZEN_MAX_MINOR = 255
TIZEN_MAX_PATCH = 65535

# git log separators: unit separator between subject and body, record separator after each commit.
FIELD_END = "\x1f"
RECORD_END = "\x1e"


class ReleaseError(Exception):
    pass


class BumpLevel(IntEnum):
    NONE = 0
    PATCH = 1
    MINOR = 2
    MAJOR = 3


@dataclass(frozen=True, order=True)
class SemVer:
    major: int
    minor: int
    patch: int

    @property
    def text(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"

    def bump(self, level: BumpLevel) -> "SemVer":
        if level == BumpLevel.MAJOR:
            return SemVer(self.major + 1, 0, 0)
        if level == BumpLevel.MINOR:
            return SemVer(self.major, self.minor + 1, 0)
        if level == BumpLevel.PATCH:
            return SemVer(self.major, self.minor, self.patch + 1)
        return self

    def check_tizen_limits(self) -> None:
        if self.major > TIZEN_MAX_MAJOR or self.minor > TIZEN_MAX_MINOR or self.patch > TIZEN_MAX_PATCH:
            raise ReleaseError(
                f"{self.text} doesn't fit a Tizen version (major and minor <= 255, patch <= 65535)."
            )


@dataclass(frozen=True)
class TagInfo:
    name: str
    version: SemVer
    is_prerelease: bool


@dataclass(frozen=True)
class CommitMessage:
    subject: str
    body: str = ""


@dataclass(frozen=True)
class ReleasePlan:
    should_release: bool
    version: str
    tag: str
    previous_tag: str
    bump: str


def parse_tag(name: str) -> Optional[TagInfo]:
    match = TAG.fullmatch(name)
    if not match:
        return None
    major, minor, patch = (int(part) for part in match.group(1, 2, 3))
    return TagInfo(name, SemVer(major, minor, patch), is_prerelease=name != f"v{major}.{minor}.{patch}")


def natural_key(name: str) -> tuple[tuple[int, int | str], ...]:
    return tuple((0, int(part)) if part.isdigit() else (1, part) for part in re.split(r"(\d+)", name))


def latest_tag(tags: Iterable[str]) -> Optional[TagInfo]:
    parsed = [tag for name in tags if (tag := parse_tag(name))]
    return max(parsed, key=lambda tag: (tag.version, 0 if tag.is_prerelease else 1, natural_key(tag.name)), default=None)


def classify_commit(commit: CommitMessage) -> BumpLevel:
    header = HEADER.fullmatch(commit.subject.strip())
    if (header and header.group(2)) or BREAKING.search(commit.body):
        return BumpLevel.MAJOR
    kind = header.group(1).lower() if header else ""
    if kind == "feat":
        return BumpLevel.MINOR
    if kind in PATCH_TYPES or commit.subject.startswith('Revert "'):
        return BumpLevel.PATCH
    return BumpLevel.NONE


def parse_version(text: str) -> SemVer:
    match = VERSION.fullmatch(text.removeprefix("v"))
    if not match:
        raise ReleaseError(f"Version must look like 1.2.0, got {text!r}.")
    major, minor, patch = (int(part) for part in match.groups())
    return SemVer(major, minor, patch)


def plan_release(
    tags: Iterable[str],
    commits: Iterable[CommitMessage],
    mode: str = "auto",
    explicit_version: str = "",
    target_already_released: bool = False,
) -> ReleasePlan:
    prev = latest_tag(tags)
    base = prev.version if prev else SemVer(0, 0, 0)
    previous_tag = prev.name if prev else ""

    if explicit_version:
        target = parse_version(explicit_version)
        if prev and target <= prev.version:
            raise ReleaseError(f"{target.text} is not newer than the latest tag, {prev.name}.")
        bump = "explicit"
    elif mode == "auto":
        level = max((classify_commit(commit) for commit in commits), default=BumpLevel.NONE)
        if target_already_released or level == BumpLevel.NONE:
            return ReleasePlan(False, "", "", previous_tag, "none")
        target = base.bump(level)
        bump = level.name.lower()
    elif mode in MANUAL_BUMPS:
        if target_already_released:
            return ReleasePlan(False, "", "", previous_tag, "none")
        target = base.bump(BumpLevel[mode.upper()])
        bump = mode
    else:
        raise ReleaseError(f"Unknown bump {mode!r}.")

    target.check_tizen_limits()
    return ReleasePlan(True, target.text, f"v{target.text}", previous_tag, bump)


def parse_git_log(output: str) -> list[CommitMessage]:
    commits = []
    for record in output.split(RECORD_END):
        record = record.lstrip("\n")
        if not record:
            continue
        subject, _, body = record.partition(FIELD_END)
        commits.append(CommitMessage(subject, body.strip()))
    return commits


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], check=check, capture_output=True, text=True)


def is_already_released(target: str, prev: Optional[TagInfo]) -> bool:
    if prev and not prev.is_prerelease and git("merge-base", "--is-ancestor", target, prev.name, check=False).returncode == 0:
        return True
    pointing = git("tag", "--points-at", target, "--list", "v*").stdout.split()
    return any((tag := parse_tag(name)) and not tag.is_prerelease for name in pointing)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    next_parser = commands.add_parser("next")
    next_parser.add_argument("--bump", choices=["auto", *MANUAL_BUMPS], default="auto")
    next_parser.add_argument("--version", default="")
    next_parser.add_argument("--target", default="HEAD")
    args = parser.parse_args(argv)

    try:
        target = git("rev-parse", "--verify", f"{args.target}^{{commit}}").stdout.strip()
        tags = git("tag", "--list", "v*").stdout.split()
        prev = latest_tag(tags)
        log_range = f"{prev.name}..{target}" if prev else target
        commits = parse_git_log(git("log", f"--format=%s{FIELD_END}%b{RECORD_END}", log_range).stdout)
        plan = plan_release(tags, commits, args.bump, args.version, is_already_released(target, prev))
    except subprocess.CalledProcessError as error:
        print(f"::error::git {' '.join(error.cmd[1:])} failed: {error.stderr.strip()}", file=sys.stderr)
        return 1
    except ReleaseError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    print(f"should_release={'true' if plan.should_release else 'false'}")
    print(f"version={plan.version}")
    print(f"tag={plan.tag}")
    print(f"previous_tag={plan.previous_tag}")
    print(f"bump={plan.bump}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
