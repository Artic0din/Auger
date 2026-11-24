# Contributing to Auger

> [!IMPORTANT]
> The most helpful way to contribute to Auger right now is a clear, accurate
> issue. Pull requests are welcome when accompanied by an issue.
> We close other pull requests without review.

## Write a useful issue

Open an [issue](https://github.com/Artic0din/Auger-Tizen/issues) for problems
in the Samsung TV app. Server and API problems belong in the upstream
[`silo-server`](https://github.com/Silo-Server/silo-server/issues/new/choose)
repository. Search first; if an issue already covers the problem, add what's
new there.

- One problem or proposal per issue.
- Describe what you observed before any theory about the cause.
- Give exact steps to reproduce, expected and actual behavior, the app version
  and build, your TV model and Tizen version, and the Silo server version.
- Paste raw logs rather than a summary. Redact credentials, tokens, personal
  data, and private media details, mark each redaction, and leave the rest
  untouched.
- For a feature, describe the problem it solves and who it affects.
- If you found the cause or have a fix in mind, add it under a Technical notes
  heading, apart from what you observed. Point to the files involved; a short
  code excerpt is fine. We may implement it differently.
- Disclose AI use: name the harness, tools, and models you used, and how
  much of the issue they wrote.

Report security vulnerabilities privately with **Report a vulnerability** on
the repository's Security tab, not in a public issue.

## Pull requests

Pull requests are welcome when accompanied by an issue. 
The rest of this guide applies to those pull requests.

## Before you start

Open an [issue](https://github.com/Artic0din/Auger-Tizen/issues) before
implementing a feature, navigation or behavior change, large refactor, or work
that changes the shared server contract. Documentation, narrow fixes, and
well-scoped parity corrections can go straight to a pull request.

This repository owns Auger, a third-party Samsung TV (Tizen) client for Silo.
Server/API work belongs in the upstream
[`silo-server`](https://github.com/Silo-Server/silo-server) repository. Client
behavior is checked against the upstream
[`silo-apple`](https://github.com/Silo-Server/silo-apple) and
[`silo-android`](https://github.com/Silo-Server/silo-android) apps, which are
read-only references; the Apple TV app is the reference for TV behavior.

## Development setup

Read [README.md](README.md) for prerequisites, build, and signing commands, [AGENTS.md](AGENTS.md) for platform invariants and context pointers, [docs/README.md](docs/README.md) for the documentation index, and [GLOSSARY.md](GLOSSARY.md) plus [docs/domain-model.md](docs/domain-model.md) for canonical terms.

A running Silo Server is required for live sign-in, browsing, and playback validation. Keep certificates, security profiles, passwords, DUIDs, generated build output, logs, and media fixtures out of Git.

## Validate your change

Run focused tests while iterating. Before opening a pull request, run the main local checks:

```sh
npm test
python3 scripts/test-release-version.py
```

`npm test` runs strict type checks, the production build, native tests, and Playwright screen tests. CI also runs `scripts/ci/check-no-api-v1.sh`, `scripts/ci/check-no-api-v1.test.sh`, repository baseline and PR hygiene, evidence, `tvOS source`, and parity-drift checks. For user-visible changes, package `dist/Auger.wgt` and capture same-state evidence following [docs/evidence/simulator-evidence.md](docs/evidence/simulator-evidence.md). Desktop Chromium and the Samsung TV simulator do not prove TV rendering, AVPlay playback, or physical remote behavior.

## Port from the tvOS source

AGENTS.md "Parity delivery gates" requires reading the affected Apple TV Swift source before any interface change.
Under the pull request's "tvOS source" heading, name the silo-apple commit you read and cite each Swift file and line range the change ports; the tvOS source check fails an interface change (`src/ui`, `src/player`, the top-level `src` scripts and stylesheets, the app shell, localisation) without one.
A maintainer adds the `tvos-source-not-needed` label when the change has no tvOS counterpart, such as AVPlay-only behaviour.

## Show visible changes

A pull request that changes what a user sees must show the change in its
Evidence section, so reviewers can see it without building the branch. In this
repository that means the Samsung TV app. A change is visible when it
alters any of these:

- layout, styling, copy, navigation, focus, empty and error states;
- which items a screen shows, or in what order: search results, home sections,
  recommendations, library browsing, collections, sorting, or filtering;
- what an item shows: titles, artwork, descriptions, ratings, badges, episode
  grouping, or availability;
- playback behavior a user notices, such as default audio or subtitle tracks,
  markers, controls, or resume position.

Provide evidence that fits the change:

- **Changes to a screen:** before-and-after screenshots of the same screen with
  the same data, one pair per affected surface. Add a short recording when
  motion, timing, focus movement, or a multi-step flow matters.
- **A Samsung TV running the signed `.wgt`:** capture the TV itself. When you
  could not use a TV, say so and name the runtime you used instead (Tizen TV
  emulator or Samsung TV simulator).
- **Apple TV parity:** add the same-state Apple TV screenshot. The result must
  match it; list any difference under Risks.
- Name the TV model and Tizen version, and the build or commit, for each
  capture.

Capture against a test library or public-domain media where you can, and keep
passwords, tokens, API keys and DUIDs out of every capture. Attach the
screenshots or recordings under the pull request's Evidence heading. Everything
on GitHub is public, so crop or blur hostnames, URLs, account names, and
personal library contents.

The pull request's `Evidence` check asks for evidence when the change touches
`app/` or `src/` (see [`.github/evidence.yml`](.github/evidence.yml)), or when a
maintainer adds the `evidence-required` label; a maintainer adds
`evidence-not-needed` when nothing visible changed.
Changes users cannot see write `Evidence: none, no user-visible change`; when such
a change touches `app/` or `src/`, the check stays red until a maintainer adds
`evidence-not-needed`, because the line alone is not proof. If you
could not capture evidence, say why; the reviewer decides whether the pull
request can merge without it.

## Open the pull request

Use a Conventional Commit title, fill in the pull request template, explain
which surfaces are affected, paste the actual validation results, and call out
any server, Apple or Android compatibility concerns. Fill in the template's
AI Disclosure section: the harness, tools, and models used, the level of AI
involvement, and any adversarial review, or "none" and "No AI used".

## Licensing of contributions

Auger is licensed under `AGPL-3.0-or-later` with the additional permission
in [PLATFORM-EXCEPTION.md](PLATFORM-EXCEPTION.md) (platform libraries).

By submitting a contribution, you agree that it is licensed under those
same terms, the AGPL *including* the additional permission. If you cannot
agree to the additional permission, say so in your pull request before it
is merged.

You retain copyright in your contribution; no assignment is requested.

## Instructions for coding agents

Read [AGENTS.md](AGENTS.md) (`CLAUDE.md` imports it) and [GLOSSARY.md](GLOSSARY.md) before changing the repository. This guide and the pull request template's AI Disclosure apply equally to agent and human authors.
