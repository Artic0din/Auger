#!/usr/bin/env python3
"""Write user-facing release notes from the Conventional Commits in a range.

Commits are grouped the way scripts/release-version.py bumps versions:

- a breaking change (`!` or a `BREAKING CHANGE:` footer) goes under Breaking
  Changes, with the footer's text when it has one;
- `feat` goes under New Features and `perf` under Improvements;
- `fix`, `revert` and `Revert "..."` go under Fixes, or under Security when the
  scope is `security` or `sec` or the subject names a security problem;
- `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build` and merge
  commits are left out unless they are breaking.

    generate-changelog.py release --version X.Y.Z [--date YYYY-MM-DD] [--from TAG] [--to HEAD]
    generate-changelog.py update --file CHANGELOG.md --version X.Y.Z [--date ...] [--from TAG] [--to HEAD]

`release` prints a GitHub Release body. `update` adds the same entry to a
Keep a Changelog file below `<!-- changelog:releases -->`, and leaves the file
alone when it already has a `## [X.Y.Z]` heading.
"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import ModuleType
from typing import Iterable, Optional


def load_release_version() -> ModuleType:
    path = Path(__file__).resolve().parent / "release-version.py"
    spec = importlib.util.spec_from_file_location("release_version", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The commit grammar lives in release-version.py, so notes and bumps never disagree.
release = load_release_version()
CommitMessage = release.CommitMessage

RELEASES_MARKER = "<!-- changelog:releases -->"
NO_CHANGES = "General maintenance and stability improvements."
PR_SUFFIX = re.compile(r"(?:\s*\(#\d+\))+\s*$")
BREAKING_FOOTER = re.compile(r"^BREAKING[- ]CHANGE:[ \t]*(.*)$", re.MULTILINE)
TRAILER = re.compile(r"^(?:[A-Za-z][A-Za-z0-9-]*:[ \t]|[A-Za-z][A-Za-z0-9-]* #)")
SECURITY_SCOPES = {"security", "sec"}
INTERNAL_SCOPES = {"ci", "docs", "test", "tests", "scripts", "deps", "build"}
SECURITY_WORDS = re.compile(
    r"\b(?:vulnerab\w*|cve-\d+(?:-\d+)*|secret leak\w*|xss|csrf|ssrf|sql injection|command injection|auth bypass|privilege escalation)\b",
    re.IGNORECASE,
)
CATEGORY_BY_TYPE = {"feat": "FEATURES", "perf": "IMPROVEMENTS", "fix": "FIXES", "revert": "FIXES"}

SCOPE_LABELS = {
    "player": "Playback",
    "playback": "Playback",
    "subtitles": "Subtitles",
    "ui": "Interface",
    "settings": "Settings",
    "auth": "Sign-In",
    "sign-in": "Sign-In",
    "profiles": "Profiles",
    "accounts": "Accounts",
    "home": "Home",
    "browse": "Browse",
    "library": "Browse",
    "details": "Details",
    "search": "Search",
    "calendar": "Calendar",
    "requests": "Requests",
    "person": "Person",
    "watch-party": "Watch Party",
    "audiobooks": "Audiobooks",
    "i18n": "Languages",
    "brand": "Branding",
    "release": "Releases",
    "security": "Security",
}

# Words whose casing a plain capitalize would break, keyed by their lower case.
TERMS = {
    term.lower(): term
    for term in (
        "AVPlay", "HDR", "HDR10", "PIN", "QR", "RTL", "TV", "Tizen", "Apps2Samsung",
        "TMDB", "Silo", "Auger", "HLS", "URL", "API",
    )
}


class Category(Enum):
    BREAKING = "⚠️ Breaking Changes"
    FEATURES = "✨ New Features"
    IMPROVEMENTS = "🔧 Improvements"
    SECURITY = "🔒 Security"
    FIXES = "🐛 Fixes"


# Fixes read as plain sentences, as in the changelog-generator example.
LABELLED = {Category.BREAKING, Category.FEATURES, Category.IMPROVEMENTS, Category.SECURITY}


@dataclass(frozen=True)
class Entry:
    category: Category
    label: str
    text: str

    @property
    def bullet(self) -> str:
        if self.label and self.category in LABELLED:
            return f"- **{self.label}**: {self.text}"
        return f"- {self.text}"


@dataclass(frozen=True)
class ReleaseNotes:
    version: str
    date: str
    sections: tuple[tuple[Category, tuple[str, ...]], ...]

    def markdown(self, title: str, level: int) -> str:
        heading = "#" * level
        lines = [title]
        for category, bullets in self.sections:
            lines += ["", f"{heading} {category.value}", "", *bullets]
        return "\n".join(lines) + "\n"

    def release_body(self) -> str:
        return self.markdown(f"# Updates - Auger v{self.version} ({self.date})", level=2)

    def changelog_entry(self) -> str:
        return self.markdown(f"## [{self.version}] - {self.date}", level=3)


# A leading plain lower-case word; `config.xml`, `avPlay` or `x_y` are identifiers and keep their case.
PLAIN_WORD = re.compile(r"[a-z][a-z'-]*(?![\w./`])")


def sentence_case(text: str) -> str:
    text = text.strip()
    word = re.match(r"\w+", text)
    if word and word.group().lower() in TERMS and not re.match(r"[\w./`]", text[word.end():word.end() + 1]):
        return TERMS[word.group().lower()] + text[word.end():]
    if PLAIN_WORD.match(text):
        return text[0].upper() + text[1:]
    return text


def scope_label(scope: str) -> str:
    """`player` reads Playback; an unknown `up-next` reads Up Next."""
    labels = []
    for part in (piece.strip().lower() for piece in scope.split(",") if piece.strip()):
        words = (TERMS.get(word, word.capitalize()) for word in re.split(r"[-_\s]+", part) if word)
        labels.append(SCOPE_LABELS.get(part) or " ".join(words))
    return ", ".join(labels)


def clean(description: str) -> str:
    return sentence_case(PR_SUFFIX.sub("", description))


def breaking_text(body: str) -> str:
    """The paragraph after `BREAKING CHANGE:`, stopping at a blank line or next trailer."""
    match = BREAKING_FOOTER.search(body)
    if not match:
        return ""
    lines = []
    first = match.group(1).strip()
    if first:
        lines.append(first)
    rest = body[match.end():]
    if rest.startswith("\r\n"):
        rest = rest[2:]
    elif rest.startswith("\n"):
        rest = rest[1:]
    for line in rest.splitlines():
        if not line.strip() or TRAILER.match(line):
            break
        lines.append(line.strip())
    return " ".join(lines)


def entries_for(commit: CommitMessage) -> list[Entry]:
    subject = commit.subject.strip()
    header = release.HEADER.fullmatch(subject)
    footer = breaking_text(commit.body)
    is_breaking = bool((header and header.group("bang")) or release.BREAKING.search(commit.body))

    if header:
        kind = header.group("type").lower()
        scope = header.group("scope") or ""
        description = clean(header.group("description"))
    elif subject.startswith('Revert "'):
        inner = PR_SUFFIX.sub("", subject).removeprefix('Revert "').removesuffix('"')
        reverted = release.HEADER.fullmatch(inner)
        kind, scope = "revert", ""
        description = f"Reverted: {clean(reverted.group('description') if reverted else inner)}"
    else:
        kind, scope, description = "", "", clean(subject)

    scope_parts = [part.strip().lower() for part in scope.split(",") if part.strip()]
    category_name = CATEGORY_BY_TYPE.get(kind)
    category = Category[category_name] if category_name else None
    is_internal = kind in ("fix", "perf") and bool(scope_parts) and all(part in INTERNAL_SCOPES for part in scope_parts)
    if is_internal:
        category = None
    elif category and any(part in SECURITY_SCOPES for part in scope_parts):
        category = Category.SECURITY
    elif kind == "fix" and SECURITY_WORDS.search(description):
        category = Category.SECURITY
    label = scope_label(scope)
    if category == Category.SECURITY and label == "Security":
        label = ""

    entries = []
    if is_breaking:
        migration = sentence_case(footer) if footer else ""
        entries.append(Entry(Category.BREAKING, label, migration or description))
        if not migration or migration == description:
            return entries
    if category is not None:
        entries.append(Entry(category, label, description))
    return entries


def build_notes(version: str, date: str, commits: Iterable[CommitMessage]) -> ReleaseNotes:
    bullets: dict[Category, list[str]] = {category: [] for category in Category}
    for commit in commits:
        for entry in entries_for(commit):
            if entry.bullet not in bullets[entry.category]:
                bullets[entry.category].append(entry.bullet)
    sections = tuple((category, tuple(items)) for category, items in bullets.items() if items)
    if not sections:
        sections = ((Category.IMPROVEMENTS, (f"- {NO_CHANGES}",)),)
    return ReleaseNotes(version, date, sections)


def read_commits(start: str, end: str) -> list[CommitMessage]:
    log_range = f"{start}..{end}" if start else end
    output = release.git(
        "log", "--reverse", f"--format=%s{release.FIELD_END}%b{release.RECORD_END}", log_range
    ).stdout
    return release.parse_git_log(output)


def insert_entry(changelog: str, version: str, entry: str) -> Optional[str]:
    """Insert entry in descending SemVer order, or return None if version is already listed."""
    if re.search(rf"^## \[{re.escape(version)}\]", changelog, re.MULTILINE):
        return None
    target_version = release.parse_version(version)
    marker = re.search(rf"^{re.escape(RELEASES_MARKER)}[ \t]*\n?", changelog, re.MULTILINE)
    if marker:
        search_from = marker.end()
    else:
        unreleased = re.search(r"^## \[Unreleased\].*$", changelog, re.MULTILINE | re.IGNORECASE)
        search_from = unreleased.end() if unreleased else 0

    at: Optional[int] = None
    for heading in re.finditer(r"^## \[([^\]]+)\]", changelog[search_from:], re.MULTILINE):
        heading_text = heading.group(1)
        if re.fullmatch(r"\d+\.\d+\.\d+", heading_text):
            if target_version > release.parse_version(heading_text):
                at = search_from + heading.start()
                break
        else:
            # First non-SemVer section (such as [Earlier changes]): insert before it.
            at = search_from + heading.start()
            break
    if at is None:
        at = len(changelog)

    before = changelog[:at].rstrip("\n")
    rest = changelog[at:].lstrip("\n")
    return f"{before}\n\n{entry.rstrip()}\n" + (f"\n{rest}" if rest else "")


def write_atomically(path: Path, text: str) -> None:
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as temp:
            temp.write(text)
        shutil.copymode(path, temp_name)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("release", "update"):
        command = commands.add_parser(name)
        command.add_argument("--version", required=True)
        command.add_argument("--date", default=datetime.now(timezone.utc).date().isoformat())
        command.add_argument("--from", dest="start", default="")
        command.add_argument("--to", dest="end", default="HEAD")
        if name == "update":
            command.add_argument("--file", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        version = release.parse_version(args.version).text
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
            raise release.ReleaseError(f"Date must look like 2026-01-31, got {args.date!r}.")
        notes = build_notes(version, args.date, read_commits(args.start, args.end))
        if args.command == "release":
            sys.stdout.write(notes.release_body())
            return 0
        updated = insert_entry(args.file.read_text(encoding="utf-8"), version, notes.changelog_entry())
        if updated is None:
            print(f"{args.file} already lists {version}.", file=sys.stderr)
            return 0
        write_atomically(args.file, updated)
        print(f"Added {version} to {args.file}.", file=sys.stderr)
        return 0
    except subprocess.CalledProcessError as error:
        print(f"::error::git {' '.join(error.cmd[1:])} failed: {error.stderr.strip()}", file=sys.stderr)
    except release.ReleaseError as error:
        print(f"::error::{error}", file=sys.stderr)
    except OSError as error:
        print(f"::error::{error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
