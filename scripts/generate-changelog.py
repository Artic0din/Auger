#!/usr/bin/env python3
"""Write release notes from the merged pull requests and Conventional Commits in a range.

`update` writes the technical CHANGELOG.md record from the commits alone.
Commits are grouped the way scripts/release-version.py bumps versions:

- a breaking change (`!` or a `BREAKING CHANGE:` footer) goes under Breaking
  Changes, with the footer's text when it has one;
- `feat` goes under New Features and `perf` under Improvements;
- `fix`, `revert` and `Revert "..."` go under Fixes, or under Security when the
  scope is `security` or `sec` or the subject names a security problem;
- `docs`, `chore`, `ci`, `test`, `refactor`, `style`, `build` and merge
  commits are left out unless they are breaking.

    generate-changelog.py release --version X.Y.Z [--date YYYY-MM-DD] [--from TAG] [--to HEAD] [--pr-notes-file PR.json]
    generate-changelog.py update --file CHANGELOG.md --version X.Y.Z [--date ...] [--from TAG] [--to HEAD]
    generate-changelog.py check-pr --title TITLE --body-file PATH [--from BASE [--to HEAD]]

`release` prints the user-facing GitHub Release body. For each commit whose
`(#123)` pull request body is in PR.json, it uses that body's `## Release Notes`
(or `## Release note`) section, then a legacy `Release note:` line, and otherwise
the commit itself. PR.json is `{"123": "<body>"}` or `[{"number": 123, "body": "<body>"}]`.
`update` adds the commit entry to a Keep a Changelog file below
`<!-- changelog:releases -->`, and leaves the file alone when it already has a
`## [X.Y.Z]` heading.
`check-pr` verifies that user-facing pull requests (`feat`, `fix`, `perf`,
`revert`, or breaking) include a populated `## Release Notes` section.
"""

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import ModuleType
from typing import Iterable, Mapping, Optional


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
DEFAULT_REPO = "Artic0din/Auger-Tizen"
NO_CHANGES = "General maintenance and stability improvements."
PR_SUFFIX = re.compile(r"(?:\s*\(#\d+\))+\s*$")
BREAKING_FOOTER = re.compile(r"^BREAKING[- ]CHANGE:[ \t]*(.*)$", re.MULTILINE)
TRAILER = re.compile(r"^(?:[A-Za-z][A-Za-z0-9-]*:[ \t]|[A-Za-z][A-Za-z0-9-]* #)")
CHANGELOG_BOT_SUBJECT = re.compile(
    r"^docs\(changelog\):\s+record v\d+\.\d+\.\d+ release notes(?:\s*\(#\d+\))?\Z",
    re.IGNORECASE,
)
MERGE_SUBJECT = re.compile(r"^(?:Merge pull request #\d+|Merge branch |merge:)", re.IGNORECASE)
SECURITY_SCOPES = {"security", "sec"}
INTERNAL_SCOPES = {"ci", "docs", "test", "tests", "scripts", "deps", "build"}
SECURITY_WORDS = re.compile(
    r"\b(?:vulnerab\w*|cve-\d+(?:-\d+)*|secret leak\w*|xss|csrf|ssrf|sql injection|command injection|auth bypass|privilege escalation)\b",
    re.IGNORECASE,
)
CATEGORY_BY_TYPE = {"feat": "FEATURES", "perf": "IMPROVEMENTS", "fix": "FIXES", "revert": "FIXES"}
CHANGELOG_CATEGORY_BY_TYPE = {
    "feat": "FEATURES",
    "perf": "PERFORMANCE",
    "fix": "FIXES",
    "revert": "FIXES",
    "refactor": "MAINTENANCE",
    "chore": "MAINTENANCE",
    "build": "MAINTENANCE",
    "style": "MAINTENANCE",
    "test": "TESTS",
    "docs": "DOCS",
    "ci": "CI",
}

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
    "ci": "CI",
    "deps": "Dependencies",
    "deps-dev": "Dependencies",
}

# Words whose casing a plain capitalize would break, keyed by their lower case.
TERMS = {
    term.lower(): term
    for term in (
        "AVPlay", "HDR", "HDR10", "PIN", "QR", "RTL", "TV", "Tizen", "Apps2Samsung",
        "TMDB", "Silo", "Auger", "HLS", "URL", "API", "CI", "README",
    )
}


class Category(Enum):
    BREAKING = "Breaking Changes"
    FEATURES = "New Features"
    IMPROVEMENTS = "Improvements"
    SECURITY = "Security"
    FIXES = "Fixes"


class ChangelogCategory(Enum):
    BREAKING = "Breaking Changes"
    FEATURES = "Features"
    PERFORMANCE = "Performance"
    SECURITY = "Security"
    FIXES = "Fixes"
    MAINTENANCE = "Refactors & Maintenance"
    TESTS = "Tests"
    DOCS = "Documentation"
    CI = "CI"
    OTHER = "Other Changes"


# Fixes read as plain sentences, as in the changelog-generator example.
LABELLED = {Category.BREAKING, Category.FEATURES, Category.IMPROVEMENTS, Category.SECURITY}


@dataclass(frozen=True)
class Entry:
    category: Category
    label: str
    text: str

    @property
    def item(self) -> str:
        if self.label and self.category in LABELLED:
            return f"**{self.label}**: {self.text}"
        return self.text

    @property
    def bullet(self) -> str:
        return f"- {self.item}"


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


def classify_subject(subject: str) -> tuple[str, str, str, bool, Optional[Category]]:
    normalized = subject.strip()
    header = release.HEADER.fullmatch(normalized)
    has_bang = bool(header and header.group("bang"))

    if header:
        kind = header.group("type").lower()
        scope = header.group("scope") or ""
        description = clean(header.group("description"))
    elif normalized.startswith('Revert "'):
        inner = PR_SUFFIX.sub("", normalized).removeprefix('Revert "').removesuffix('"')
        reverted = release.HEADER.fullmatch(inner)
        kind, scope = "revert", ""
        description = f"Reverted: {clean(reverted.group('description') if reverted else inner)}"
    else:
        kind, scope, description = "", "", clean(normalized)

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
    return kind, scope, description, has_bang, category


def entries_for(commit: CommitMessage) -> list[Entry]:
    _, scope, description, has_bang, category = classify_subject(commit.subject)
    footer = breaking_text(commit.body)
    is_breaking = bool(has_bang or release.BREAKING.search(commit.body))
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


class UserSection(Enum):
    BREAKING = "Breaking Changes"
    NEW = "New"
    IMPROVED = "Improved"
    SECURITY = "Security"
    FIXED = "Fixed"


USER_SECTION_BY_CATEGORY = {
    Category.BREAKING: UserSection.BREAKING,
    Category.FEATURES: UserSection.NEW,
    Category.IMPROVEMENTS: UserSection.IMPROVED,
    Category.SECURITY: UserSection.SECURITY,
    Category.FIXES: UserSection.FIXED,
}
SUBHEADINGS: dict[str, Optional[UserSection]] = {
    "highlights": None,
    "breaking changes": UserSection.BREAKING,
    "breaking": UserSection.BREAKING,
    "new": UserSection.NEW,
    "new features": UserSection.NEW,
    "added": UserSection.NEW,
    "improved": UserSection.IMPROVED,
    "improvements": UserSection.IMPROVED,
    "changed": UserSection.IMPROVED,
    "security": UserSection.SECURITY,
    "fixed": UserSection.FIXED,
    "fixes": UserSection.FIXED,
    "bug fixes": UserSection.FIXED,
}
NO_USER_CHANGE = {
    "none", "n/a", "no user-visible change", "no user-visible changes", "no user-facing change", "no user-facing changes",
}
HEADING = re.compile(r"^(#{1,6})[ \t]+(.*?)[ \t#]*$", re.MULTILINE)
BULLET = re.compile(r"^\s*[-*][ \t]+(.*)$")
LEGACY_NOTE = re.compile(r"^Release note:[ \t]*(.+)$", re.MULTILINE | re.IGNORECASE)
TRAILING_PR_NUMBER = re.compile(r"\(#(\d+)\)\s*$")
FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})")


def format_highlights(items: Iterable[str]) -> str:
    parts: list[str] = []
    previous_was_bullet = False
    for item in items:
        is_bullet = item.startswith("- ")
        if parts:
            parts.append("\n" if (is_bullet and previous_was_bullet) else "\n\n")
        parts.append(item)
        previous_was_bullet = is_bullet
    return "".join(parts)


@dataclass(frozen=True)
class ParsedPrNotes:
    suppressed: bool
    highlights: tuple[str, ...]
    sectioned: tuple[tuple[UserSection, tuple[str, ...]], ...]
    unsectioned: tuple[str, ...]


@dataclass(frozen=True)
class UserReleaseNotes:
    version: str
    date: str
    highlights: tuple[str, ...]
    sections: tuple[tuple[UserSection, tuple[str, ...]], ...]

    def render(self) -> str:
        # No H1: GitHub shows the release title above the body.
        items = dict(self.sections)
        blocks = [f"Released: {self.date}"]

        def add(title: str, bullets: Iterable[str]) -> None:
            blocks.append(f"## {title}\n\n" + "\n".join(f"- {text}" for text in bullets))

        if items.get(UserSection.BREAKING):
            add(UserSection.BREAKING.value, items[UserSection.BREAKING])
        if self.highlights:
            blocks.append("## Highlights\n\n" + format_highlights(self.highlights))
        for section in (UserSection.NEW, UserSection.IMPROVED, UserSection.SECURITY, UserSection.FIXED):
            if items.get(section):
                add(section.value, items[section])
        if len(blocks) == 1:
            add(UserSection.IMPROVED.value, [NO_CHANGES])
        return "\n\n".join(blocks) + "\n"


def heading_key(title: str) -> str:
    """`✨ New Features:` reads `new features`."""
    return re.sub(r"^[^\w]+", "", title).strip().rstrip(":").strip().lower()


def is_no_change(text: str) -> bool:
    cleaned = text.strip()
    if cleaned.startswith("- "):
        cleaned = cleaned[2:].strip()
    return cleaned.strip("*_`").strip().rstrip(".").strip().lower() in NO_USER_CHANGE


def strip_comments_and_fences(text: str) -> str:
    """Remove HTML comments and fenced code blocks in one linear pass so neither can open inside the other."""
    visible: list[str] = []
    fence_char = ""
    fence_len = 0
    comment_end = 0
    comments_can_close = True
    offset = 0
    for line in text.splitlines(keepends=True):
        line_start = offset
        offset += len(line)
        pos = max(0, comment_end - line_start)
        if pos >= len(line):
            continue
        if pos == 0:
            stripped = line.rstrip("\n")
            fence = FENCE.match(stripped)
            if fence:
                marker = fence.group(1)
                if not fence_char:
                    fence_char, fence_len = marker[0], len(marker)
                    continue
                if marker[0] == fence_char and len(marker) >= fence_len and not stripped[fence.end():].strip():
                    fence_char, fence_len = "", 0
                    continue
        if fence_char:
            continue
        while pos < len(line):
            start = line.find("<!--", pos) if comments_can_close else -1
            if start == -1:
                visible.append(line[pos:])
                break
            end = text.find("-->", line_start + start + 4)
            if end == -1:
                comments_can_close = False
                visible.append(line[pos:])
                break
            visible.append(line[pos:start])
            comment_end = end + 3
            pos = comment_end - line_start
    return "".join(visible)


def markdown_items(block: str, keep_bullets: bool = False) -> list[str]:
    """Each bullet (with its continuation lines) or paragraph, joined onto one line."""
    items: list[tuple[bool, list[str]]] = []
    current: Optional[list[str]] = None
    for line in block.splitlines():
        bullet = BULLET.match(line)
        if not line.strip():
            current = None
        elif bullet:
            current = [bullet.group(1).strip()]
            items.append((True, current))
        elif current is None:
            current = [line.strip()]
            items.append((False, current))
        else:
            current.append(line.strip())
    return [f"- {' '.join(parts)}" if (keep_bullets and is_bullet) else " ".join(parts) for is_bullet, parts in items]


RELEASE_NOTES_HEADINGS = {"release notes", "release note"}
MARKDOWN_LINK_TARGET = re.compile(r"\]\([^)]*\)")
RAW_TICKET_REF = re.compile(r"(?<![/\w&])#\d+\b")
CONVENTIONAL_PREFIX = re.compile(
    r"^(?:-\s+)?(?:feat|fix|perf|revert|chore|docs|ci|test|refactor|style|build)(?:\([^)]*\))?!?:\s+",
    re.IGNORECASE,
)


def release_notes_section(body: str) -> Optional[str]:
    headings = list(HEADING.finditer(body))
    for index, heading in enumerate(headings):
        level = len(heading.group(1))
        if level in (2, 3) and heading_key(heading.group(2)) in RELEASE_NOTES_HEADINGS:
            end = next((h.start() for h in headings[index + 1:] if len(h.group(1)) <= level), len(body))
            return body[heading.end():end]
    return None


def parse_release_notes_section(section: Optional[str]) -> Optional[ParsedPrNotes]:
    if section is None or not section.strip():
        return None
    if is_no_change(section):
        return ParsedPrNotes(True, (), (), ())
    highlights: list[str] = []
    sectioned: dict[UserSection, list[str]] = {}
    unsectioned: list[str] = []
    saw_no_change = False

    def keep(items: Iterable[str]) -> list[str]:
        nonlocal saw_no_change
        kept: list[str] = []
        for item in items:
            if is_no_change(item):
                saw_no_change = True
            else:
                kept.append(item)
        return kept

    subheadings = list(HEADING.finditer(section))
    unsectioned += keep(markdown_items(section[: subheadings[0].start()] if subheadings else section))
    for index, heading in enumerate(subheadings):
        end = subheadings[index + 1].start() if index + 1 < len(subheadings) else len(section)
        block = section[heading.end():end]
        key = heading_key(heading.group(2))
        if key == "highlights":
            highlights += keep(markdown_items(block, keep_bullets=True))
        elif key in SUBHEADINGS:
            sectioned.setdefault(SUBHEADINGS[key], []).extend(keep(markdown_items(block)))
        else:
            unsectioned += keep(markdown_items(block))
    sectioned_tuple = tuple((section_name, tuple(items)) for section_name, items in sectioned.items() if items)
    if highlights or sectioned_tuple or unsectioned:
        return ParsedPrNotes(False, tuple(highlights), sectioned_tuple, tuple(unsectioned))
    if saw_no_change:
        return ParsedPrNotes(True, (), (), ())
    return None


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def headline_signature(subject: str) -> tuple[release.BumpLevel, str, Optional[Category]]:
    kind, _, _, has_bang, category = classify_subject(subject)
    bump = release.classify_commit(CommitMessage(subject.strip(), ""))
    if has_bang:
        release_kind = "breaking"
    elif kind == "feat":
        release_kind = "feat"
    elif kind == "perf":
        release_kind = "perf"
    elif bump == release.BumpLevel.PATCH:
        release_kind = "fix"
    else:
        release_kind = "none"
    return (bump, release_kind, category)


def check_pr_release_notes(title: str, body: str, commits: Iterable[CommitMessage] = ()) -> list[str]:
    """Validate that a user-facing pull request supplies plain-language Release Notes."""
    cleaned = strip_comments_and_fences(normalize_newlines(body))
    commit_list = list(commits)
    errors: list[str] = []
    normalized_title = title.strip()

    if len(commit_list) == 1:
        lone = commit_list[0]
        lone_subject = lone.subject.strip()
        lone_body = normalize_newlines(lone.body)
        effective_commit = CommitMessage(lone_subject, lone_body, lone.sha)
        if headline_signature(normalized_title) != headline_signature(lone_subject):
            errors.append(
                "On a single-commit PR, GitHub sets the squash commit title from the commit headline "
                f"(`COMMIT_OR_PR_TITLE`). Align the PR title (`{normalized_title}`) and commit headline "
                f"(`{lone_subject}`) so they imply the same SemVer bump, breaking status, and release-notes category."
            )
    else:
        squash_body = "\n\n".join(normalize_newlines(commit.body) for commit in commit_list if commit.body)
        effective_commit = CommitMessage(normalized_title, squash_body)

    bump = release.classify_commit(effective_commit)
    is_breaking = bump == release.BumpLevel.MAJOR
    if release.BREAKING.search(cleaned) and not is_breaking:
        errors.append(
            "GitHub squash merges use commit messages (`COMMIT_MESSAGES`) and discard the PR body, "
            "so a `BREAKING CHANGE:` footer in the PR body alone will not trigger a breaking release. "
            "Move the `BREAKING CHANGE:` footer into a branch commit message, or add `!` to the PR title "
            "(and single-commit headline)."
        )

    entries = entries_for(effective_commit)
    parsed = parse_release_notes_section(release_notes_section(cleaned))
    if bump == release.BumpLevel.NONE:
        if parsed is not None and not parsed.suppressed:
            errors.append(
                "Non-releasing PRs do not publish a release; use `feat`, `fix`, `perf`, "
                "`revert`, or `!` when shipping user-facing changes, or set `## Release Notes` to `None`."
            )
        return errors
    if not entries and (parsed is None or parsed.suppressed):
        return errors
    if parsed is None:
        errors.append(
            "User-facing PRs (feat, fix, perf, revert, or breaking) must include a populated "
            "`## Release Notes` section with explicit category subheadings (`### Breaking Changes`, "
            "`### New`, `### Improved`, `### Security`, or `### Fixed`, plus optional `### Highlights`) "
            "written in plain language for Samsung TV users, or `None` for an internal-only fix."
        )
        return errors
    header = release.HEADER.fullmatch(effective_commit.subject.strip())
    kind = header.group("type").lower() if header else ""
    allows_none = not is_breaking and (not entries or all(entry.category == Category.FIXES for entry in entries))
    if parsed.suppressed:
        if is_breaking:
            errors.append(
                "Breaking PRs cannot use `None` in `## Release Notes`; explain what breaks "
                "and what users need to do."
            )
        elif not allows_none:
            errors.append(
                "Only internal-only fixes can use `None` in `## Release Notes`; "
                "describe the user-facing change in plain language."
            )
        return errors
    sections = {section for section, section_items in parsed.sectioned if section_items}
    if parsed.unsectioned or not sections:
        errors.append(
            "Group every bullet in `## Release Notes` under an explicit category subheading "
            "(`### Breaking Changes`, `### New`, `### Improved`, `### Security`, or `### Fixed`) "
            "so improvements and bug fixes are not misfiled under `## New`."
        )
    if is_breaking and UserSection.BREAKING not in sections:
        errors.append(
            "Breaking PRs must include a `### Breaking Changes` subsection inside `## Release Notes`."
        )
    if not is_breaking and UserSection.BREAKING in sections:
        errors.append(
            "Non-breaking PRs cannot include `### Breaking Changes` in `## Release Notes`; "
            "mark the PR title with `!` or add a `BREAKING CHANGE:` footer to a branch commit so the SemVer bump matches."
        )
    if sections and not is_breaking:
        if bump == release.BumpLevel.MINOR and not (sections & {UserSection.NEW, UserSection.IMPROVED}):
            errors.append(
                "`feat` PRs bump the minor version and must include `### New` or `### Improved` in "
                "`## Release Notes` (or use `fix:` for bug-fix-only changes)."
            )
        elif bump == release.BumpLevel.PATCH:
            if UserSection.NEW in sections:
                errors.append(
                    "Patch PRs (`fix`, `perf`, `revert`) cannot include `### New` in `## Release Notes`; "
                    "use a `feat` PR title so new functionality bumps the minor version."
                )
            if kind == "perf" and UserSection.IMPROVED not in sections:
                errors.append(
                    "`perf` PRs must include `### Improved` in `## Release Notes`."
                )
            if kind != "perf" and not (sections & {UserSection.FIXED, UserSection.SECURITY}):
                errors.append(
                    "`fix` and `revert` PRs must include `### Fixed` or `### Security` in `## Release Notes` "
                    "(or use `feat` when shipping enhancements without a bug fix)."
                )
    items = [
        *parsed.highlights,
        *(item for _, section_items in parsed.sectioned for item in section_items),
        *parsed.unsectioned,
    ]
    for item in items:
        visible = MARKDOWN_LINK_TARGET.sub("]", item)
        if RAW_TICKET_REF.search(visible):
            errors.append(
                f"Remove issue/PR numbers (`#123`) from `## Release Notes`: {item}"
            )
        if CONVENTIONAL_PREFIX.match(item):
            errors.append(
                f"Rewrite `## Release Notes` in plain user language without Conventional Commit prefixes: {item}"
            )
    return errors


def parse_pr_notes(body: str) -> Optional[ParsedPrNotes]:
    """A PR body's user-facing notes, or None when it has none to offer."""
    body = strip_comments_and_fences(normalize_newlines(body))
    parsed = parse_release_notes_section(release_notes_section(body))
    if parsed is not None:
        return parsed
    legacy = [note.strip() for note in LEGACY_NOTE.findall(body)]
    if legacy:
        if all(is_no_change(note) for note in legacy):
            return ParsedPrNotes(True, (), (), ())
        return ParsedPrNotes(False, (), (), tuple(note for note in legacy if not is_no_change(note)))
    return None


def notes_for_commit(commit: CommitMessage, pr_bodies: Mapping[int, str]) -> Optional[ParsedPrNotes]:
    # Only a trailing `(#N)` identifies the merged pull request for this commit.
    match = TRAILING_PR_NUMBER.search(commit.subject)
    if not match:
        return None
    pr_number = int(match.group(1))
    return parse_pr_notes(pr_bodies[pr_number]) if pr_number in pr_bodies else None


def build_user_notes(
    version: str, date: str, commits: Iterable[CommitMessage], pr_bodies: Mapping[int, str]
) -> UserReleaseNotes:
    highlights: list[str] = []
    bullets: dict[UserSection, list[str]] = {section: [] for section in UserSection}

    def add(section: UserSection, text: str) -> None:
        if text and text not in bullets[section]:
            bullets[section].append(text)

    for commit in commits:
        entries = entries_for(commit)
        breaking = [entry for entry in entries if entry.category == Category.BREAKING]
        notes = notes_for_commit(commit, pr_bodies)
        if notes is None:
            for entry in entries:
                add(USER_SECTION_BY_CATEGORY[entry.category], entry.item)
            continue
        written = {section for section, items in notes.sectioned if items}
        if notes.unsectioned:
            non_breaking = [entry for entry in entries if entry.category != Category.BREAKING]
            if non_breaking:
                default = USER_SECTION_BY_CATEGORY[non_breaking[0].category]
            elif breaking:
                default = UserSection.BREAKING
            else:
                # An internal commit (no entries) with written notes still changed something people see.
                default = UserSection.IMPROVED
            for text in notes.unsectioned:
                add(default, text)
            if default == UserSection.BREAKING and not breaking_text(commit.body):
                written.add(UserSection.BREAKING)
        for section, items in notes.sectioned:
            for text in items:
                add(section, text)
        for text in notes.highlights:
            if text not in highlights:
                highlights.append(text)
        # A breaking change is never hidden, even when the PR wrote None or skipped Breaking Changes.
        if UserSection.BREAKING not in written:
            for entry in breaking:
                add(UserSection.BREAKING, entry.item)
    sections = tuple((section, tuple(items)) for section, items in bullets.items() if items)
    return UserReleaseNotes(version, date, tuple(highlights), sections)


def load_pr_bodies(path: Path) -> dict[int, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise release.ReleaseError(f"{path} is not valid JSON: {error}.") from error
    if isinstance(data, dict):
        pairs = list(data.items())
    elif isinstance(data, list):
        if not all(isinstance(item, dict) for item in data):
            raise release.ReleaseError(f"{path} must list objects with number and body.")
        pairs = [(item.get("number"), item.get("body")) for item in data]
    else:
        raise release.ReleaseError(f"{path} must be a JSON object or array, got {type(data).__name__}.")
    bodies: dict[int, str] = {}
    for number, body in pairs:
        if isinstance(number, bool) or not re.fullmatch(r"\d+", str(number)) or not isinstance(body, (str, type(None))):
            raise release.ReleaseError(f"{path} has an invalid entry for pull request {number!r}.")
        bodies[int(number)] = body or ""
    return bodies


@dataclass(frozen=True)
class TechnicalChangelog:
    version: str
    date: str
    sections: tuple[tuple[ChangelogCategory, tuple[str, ...]], ...]

    def changelog_entry(self) -> str:
        lines = [f"## [{self.version}] - {self.date}"]
        for category, bullets in self.sections:
            lines += ["", f"### {category.value}", "", *bullets]
        return "\n".join(lines) + "\n"


def format_commit_refs(subject: str, sha: str, repo: str) -> str:
    refs: list[str] = []
    pr_match = TRAILING_PR_NUMBER.search(subject)
    if pr_match:
        pr = pr_match.group(1)
        refs.append(f"[#{pr}](https://github.com/{repo}/pull/{pr})" if repo else f"#{pr}")
    if sha:
        refs.append(f"[`{sha}`](https://github.com/{repo}/commit/{sha})" if repo else f"`{sha}`")
    return f" ({', '.join(refs)})" if refs else ""


def changelog_entries_for(commit: CommitMessage, repo: str = DEFAULT_REPO) -> list[tuple[ChangelogCategory, str]]:
    subject = commit.subject.strip()
    header = release.HEADER.fullmatch(subject)
    footer = breaking_text(commit.body)
    is_breaking = bool((header and header.group("bang")) or release.BREAKING.search(commit.body))
    if not is_breaking and (CHANGELOG_BOT_SUBJECT.match(subject) or MERGE_SUBJECT.match(subject)):
        return []

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
    category_name = CHANGELOG_CATEGORY_BY_TYPE.get(kind, "OTHER")
    category = ChangelogCategory[category_name]
    if category == ChangelogCategory.FIXES and (
        any(part in SECURITY_SCOPES for part in scope_parts) or (kind == "fix" and SECURITY_WORDS.search(description))
    ):
        category = ChangelogCategory.SECURITY

    label = scope_label(scope)
    if category == ChangelogCategory.SECURITY and label == "Security":
        label = ""
    refs = format_commit_refs(subject, commit.sha, repo)

    def bullet(text: str) -> str:
        prefix = f"**{label}**: " if label else ""
        return f"- {prefix}{text}{refs}"

    entries: list[tuple[ChangelogCategory, str]] = []
    if is_breaking:
        migration = sentence_case(footer) if footer else ""
        entries.append((ChangelogCategory.BREAKING, bullet(migration or description)))
        if not migration or migration == description:
            return entries
    entries.append((category, bullet(description)))
    return entries


def build_technical_changelog(
    version: str, date: str, commits: Iterable[CommitMessage], repo: str = DEFAULT_REPO
) -> TechnicalChangelog:
    bullets: dict[ChangelogCategory, list[str]] = {category: [] for category in ChangelogCategory}
    for commit in commits:
        for category, text in changelog_entries_for(commit, repo=repo):
            if text not in bullets[category]:
                bullets[category].append(text)
    sections = tuple((category, tuple(items)) for category, items in bullets.items() if items)
    if not sections:
        sections = ((ChangelogCategory.MAINTENANCE, (f"- {NO_CHANGES}",)),)
    return TechnicalChangelog(version, date, sections)


def read_commits(start: str, end: str) -> list[CommitMessage]:
    log_range = f"{start}..{end}" if start else end
    output = release.git(
        "log", "--abbrev=8", "--reverse", f"--format=%h{release.FIELD_END}%s{release.FIELD_END}%b{release.RECORD_END}", log_range
    ).stdout
    commits: list[CommitMessage] = []
    for record in output.split(release.RECORD_END):
        record = record.lstrip("\n")
        if not record:
            continue
        sha, _, rest = record.partition(release.FIELD_END)
        subject, _, body = rest.partition(release.FIELD_END)
        commits.append(CommitMessage(subject, body.strip(), sha.strip()))
    return commits


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
        if release.VERSION.fullmatch(heading_text):
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
        if name == "release":
            command.add_argument("--pr-notes-file", type=Path)
        if name == "update":
            command.add_argument("--file", type=Path, required=True)
            command.add_argument("--repo", default=DEFAULT_REPO)
    check_parser = commands.add_parser("check-pr")
    check_parser.add_argument("--title", required=True)
    check_parser.add_argument("--body-file", type=Path, required=True)
    check_parser.add_argument("--from", dest="start", default="")
    check_parser.add_argument("--to", dest="end", default="")
    args = parser.parse_args(argv)

    try:
        if args.command == "check-pr":
            if args.end and not args.start:
                raise release.ReleaseError("--to requires --from for check-pr.")
            commits = read_commits(args.start, args.end or "HEAD") if args.start else ()
            errors = check_pr_release_notes(
                args.title,
                args.body_file.read_text(encoding="utf-8"),
                commits=commits,
            )
            for error in errors:
                print(f"::error::{error}", file=sys.stderr)
            return 1 if errors else 0
        version = release.parse_version(args.version).text
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
            raise release.ReleaseError(f"Date must look like 2026-01-31, got {args.date!r}.")
        commits = read_commits(args.start, args.end)
        if args.command == "release":
            pr_bodies = load_pr_bodies(args.pr_notes_file) if args.pr_notes_file else {}
            sys.stdout.write(build_user_notes(version, args.date, commits, pr_bodies).render())
            return 0
        notes = build_technical_changelog(version, args.date, commits, repo=args.repo)
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
