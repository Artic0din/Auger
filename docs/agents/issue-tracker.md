# Issue tracker: GitHub

Issues and specs for this repository live in `Artic0din/Auger` on GitHub. Use the `gh` CLI for every tracker operation.

## Repository guardrail

Target only `Artic0din/Auger`. Pass `--repo Artic0din/Auger` to every `gh issue` and `gh pr` command (reads and writes alike), and use `repos/Artic0din/Auger/` in every `gh api` path. Never infer the repository from git remotes or `gh` defaults, and never file or edit issues in `Silo-Server/*` repositories from here. Stop if an item is outside `Artic0din/Auger`.

**PRs as a request surface: no.** External pull requests stay outside issue triage. Because GitHub shares one number space across issues and pull requests, resolve a bare `#N` with `gh pr view <n> --repo Artic0din/Auger` and fall back to `gh issue view <n> --repo Artic0din/Auger`.

## Issue operations

- **Create ("publish to the issue tracker"):** `gh issue create --repo Artic0din/Auger --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read ("fetch the relevant ticket"):** `gh issue view <number> --repo Artic0din/Auger --json number,title,body,labels,comments`.
- **List:** `gh issue list --repo Artic0din/Auger --state open --json number,title,body,author,labels,comments --jq '[.[] | {number, title, body, author: .author.login, labels: [.labels[].name], comments: [.comments[] | {body, author: .author.login, createdAt}]}]'` with `--label` and `--state` filters. Pass `-L <n>` when more than 30 issues are needed.
- **Attach sub-issue:** `gh issue create --repo Artic0din/Auger --parent <parent> ...` or `gh issue edit <parent> --repo Artic0din/Auger --add-sub-issue <child>` (`gh` 2.94+). On older `gh`, run `gh api --method POST repos/Artic0din/Auger/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>` using the numeric database id from `gh api repos/Artic0din/Auger/issues/<n> --jq .id`. Where sub-issues are unavailable, put `Part of #<parent>` at the top of the child body.
- **Record blocker:** use GitHub native issue dependencies via `gh issue create --repo Artic0din/Auger --blocked-by <n>,<n> ...` or `gh issue edit <child> --repo Artic0din/Auger --add-blocked-by <blocker>` (`gh` 2.94+). On older `gh`, run `gh api --method POST repos/Artic0din/Auger/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` (numeric database id, not `#number` or `node_id`). Fall back to `Blocked by: #<n>, #<n>` at the top of the child body when native dependencies are unavailable.
- **Count open blockers:** `gh api repos/Artic0din/Auger/issues/<n> --jq .issue_dependencies_summary.blocked_by` (returns 0 when startable). When using `gh issue view <n> --repo Artic0din/Auger --json blockedBy`, filter to open items: `--jq '[.blockedBy.nodes[] | select(.state == "OPEN")] | length'`. Also check whether any issue referenced in a `Blocked by:` body fallback line is still open.
- **Comment:** `gh issue comment <number> --repo Artic0din/Auger --body "..."`.
- **Edit labels:** `gh issue edit <number> --repo Artic0din/Auger --add-label "..."` or `gh issue edit <number> --repo Artic0din/Auger --remove-label "..."`.
- **Close:** post the explanation with `gh issue comment <number> --repo Artic0din/Auger --body "..."`, then run `gh issue close <number> --repo Artic0din/Auger` (separately, because `gh issue close --comment` drops comments on already-closed issues).

## Wayfinding operations (`/wayfinder`)

The **map** is one issue labelled `wayfinder:map` with child tickets as sub-issues.

1. **Create map:** `gh issue create --repo Artic0din/Auger --label wayfinder:map --title "..." --body-file <file>` holding Notes, Decisions-so-far, and Fog.
2. **Create child ticket:** link it to the map as a sub-issue (or task list item plus `Part of #<map>`) with label `wayfinder:<type>` (`research`, `prototype`, `grilling`, or `task`).
3. **Query frontier:** list open children (`gh api --paginate repos/Artic0din/Auger/issues/<map>/sub_issues` or the map task list), keep only children in `Artic0din/Auger` with zero open blockers (checking both native dependencies and any open issues listed in a `Blocked by:` body fallback line) and no assignee, and pick the first in map order.
4. **Claim ticket:** run `gh issue edit <n> --repo Artic0din/Auger --add-assignee @me` as the first write. If that command fails or times out, stop without changing assignees and report the ticket number, error, and current `gh issue view <n> --repo Artic0din/Auger --json state,assignees` state to a maintainer before proceeding or unassigning. If it succeeds, re-read `gh issue view <n> --repo Artic0din/Auger --json state,assignees,body` and recount open blockers (both native dependencies and any open issues listed in a `Blocked by:` body fallback line). Proceed only if open, unblocked, and assigned solely to you; otherwise remove yourself (`gh issue edit <n> --repo Artic0din/Auger --remove-assignee @me`) and rerun the frontier query. Run at most one Wayfinder session per GitHub account at a time.
5. **Resolve ticket:** post the answer with `gh issue comment <n> --repo Artic0din/Auger --body "<answer>"`, append a context pointer (gist and link) to the map's Decisions-so-far, and then close the child with `gh issue close <n> --repo Artic0din/Auger`. If the map update or close fails after the answer posts, re-read `gh issue view <n> --repo Artic0din/Auger --json state,assignees` first; only if the child is still open and assigned solely to you, add the existing answer link to Decisions-so-far if missing and close the child without reposting the answer (otherwise stop and report to a maintainer).
