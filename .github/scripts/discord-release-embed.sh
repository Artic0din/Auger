#!/usr/bin/env bash
# Build a Discord webhook payload for a published GitHub release.
#
# Usage:
#   discord-release-embed.sh [release.json]
#   discord-release-embed.sh < release.json
#
# Reads a GitHub Release object in REST/event shape (name, tag_name, html_url,
# body, published_at) or the camelCase aliases from `gh release view --json`.
# Prints compact webhook JSON on stdout and a counts line on stderr:
#   counts title=… description=… footer=… embed=… payload=… truncated=true|false
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "discord-release-embed: jq is required" >&2
  exit 2
fi

usage() {
  echo "Usage: discord-release-embed.sh [release.json]" >&2
  exit 2
}

input="-"
if [[ $# -gt 0 ]]; then
  case "$1" in
    -h|--help) usage ;;
    -) input="-" ;;
    -*) echo "discord-release-embed: unknown argument: $1" >&2; usage ;;
    *) input="$1" ;;
  esac
  shift
  [[ $# -eq 0 ]] || usage
fi

dir="$(cd "$(dirname "$0")" && pwd)"
filter="$dir/discord-release-embed.jq"
if [[ ! -f "$filter" ]]; then
  echo "discord-release-embed: missing filter $filter" >&2
  exit 2
fi

payload="$(jq -c -f "$filter" "$input")"

printf '%s\n' "$payload"

jq -r --arg plen "${#payload}" '
  .embeds[0] as $e
  | (($e.title // "") | length) as $title
  | (($e.description // "") | length) as $description
  | (($e.footer.text // "") | length) as $footer
  | (
      ($e.fields // [])
      | map(((.name // "") | length) + ((.value // "") | length))
      | add // 0
    ) as $fields
  | ($title + $description + $footer + $fields) as $embed
  | ($e.description // "" | test("\\[Full notes\\]\\(")) as $truncated
  | "counts title=\($title) description=\($description) footer=\($footer) embed=\($embed) payload=\($plen) truncated=\($truncated)"
' <<<"$payload" >&2
