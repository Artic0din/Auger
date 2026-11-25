#!/usr/bin/env bash
# Tests for discord-release-embed.sh. Does not post to Discord or read secrets.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
script="$dir/discord-release-embed.sh"
fixture="$dir/testdata/release-v0.7.0.json"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
ok() { echo "ok: $1"; }

run() {
  local src="$1" out="$2" err="$3"
  "$script" "$src" >"$out" 2>"$err" || fail "script exited $? for $src (stderr: $(cat "$err"))"
  jq -e . "$out" >/dev/null || fail "payload is not valid JSON: $(cat "$out")"
}

counts_of() {
  grep -E '^counts ' "$1" || fail "no counts line in $1"
}

# --- v0.7.0 fixture: real release notes, no truncation ---
run "$fixture" "$tmp/v070.json" "$tmp/v070.err"
jq -e '
  .username == "GitHub Releases"
  and .allowed_mentions == {"parse": []}
  and (.embeds | length) == 1
  and .embeds[0].title == "Auger 0.7.0"
  and .embeds[0].url == "https://github.com/Artic0din/Auger-Tizen/releases/tag/v0.7.0"
  and .embeds[0].color == 13563
  and (.embeds[0].color | type) == "number"
  and .embeds[0].footer.text == "v0.7.0"
  and .embeds[0].timestamp == "2026-11-25T10:46:15Z"
  and (.embeds[0].description | startswith("Released: 2026-11-25"))
' "$tmp/v070.json" >/dev/null || fail "v0.7.0 payload fields: $(cat "$tmp/v070.json")"
c="$(counts_of "$tmp/v070.err")"
[[ "$c" == "counts title=11 description=700 footer=6 embed=717 payload=968 truncated=false" ]] \
  || fail "v0.7.0 counts: $c"
ok "v0.7.0 payload, counts, and JSON"

# --- empty name falls back to tag; empty body omits description ---
jq -n '{tag_name:"v1.0.0", html_url:"https://example.com/r", name:"", body:"", published_at:"2026-01-01T00:00:00Z"}' \
  >"$tmp/empty.json"
run "$tmp/empty.json" "$tmp/empty.out" "$tmp/empty.err"
jq -e '
  .embeds[0].title == "v1.0.0"
  and (.embeds[0] | has("description") | not)
  and .embeds[0].footer.text == "v1.0.0"
  and .embeds[0].timestamp == "2026-01-01T00:00:00Z"
' "$tmp/empty.out" >/dev/null || fail "empty name/body: $(cat "$tmp/empty.out")"
grep -q 'truncated=false' "$tmp/empty.err" || fail "empty body marked truncated"
ok "empty name falls back to tag; empty body omits description"

# --- camelCase aliases from `gh release view --json` ---
jq -n '{tagName:"v1.0.0", url:"https://example.com/r", name:null, body:null, publishedAt:"2026-01-01T00:00:00Z"}' \
  >"$tmp/camel.json"
run "$tmp/camel.json" "$tmp/camel.out" "$tmp/camel.err"
jq -e '
  .embeds[0].title == "v1.0.0"
  and .embeds[0].url == "https://example.com/r"
  and .embeds[0].timestamp == "2026-01-01T00:00:00Z"
  and (.embeds[0] | has("description") | not)
' "$tmp/camel.out" >/dev/null || fail "camelCase: $(cat "$tmp/camel.out")"
ok "gh release view camelCase aliases"

# --- missing timestamp is omitted, not an empty embeds array ---
jq -n '{tag_name:"v1", html_url:"https://example.com/r", name:"N", body:"Hi"}' >"$tmp/nots.json"
run "$tmp/nots.json" "$tmp/nots.out" "$tmp/nots.err"
jq -e '
  .embeds[0].title == "N"
  and .embeds[0].description == "Hi"
  and (.embeds[0] | has("timestamp") | not)
  and (.embeds | length) == 1
' "$tmp/nots.out" >/dev/null || fail "missing timestamp: $(cat "$tmp/nots.out")"
ok "missing published_at omits timestamp and keeps the embed"

# --- required fields ---
jq -n '{html_url:"https://example.com/r"}' >"$tmp/notag.json"
if "$script" "$tmp/notag.json" >"$tmp/notag.out" 2>"$tmp/notag.err"; then
  fail "missing tag_name exited 0"
fi
grep -q 'missing tag_name' "$tmp/notag.err" || fail "missing tag message: $(cat "$tmp/notag.err")"
jq -n '{tag_name:"v1"}' >"$tmp/nourl.json"
if "$script" "$tmp/nourl.json" >"$tmp/nourl.out" 2>"$tmp/nourl.err"; then
  fail "missing html_url exited 0"
fi
grep -q 'missing html_url' "$tmp/nourl.err" || fail "missing url message: $(cat "$tmp/nourl.err")"
ok "missing tag_name or html_url fails"

# --- stdin ---
jq -n '{tag_name:"v1", html_url:"https://example.com/r", name:"N", body:"Hi"}' >"$tmp/stdin.in"
"$script" <"$tmp/stdin.in" >"$tmp/stdin.out" 2>"$tmp/stdin.err" || fail "stdin failed"
jq -e '.embeds[0].description == "Hi"' "$tmp/stdin.out" >/dev/null || fail "stdin payload"
ok "reads a release from stdin"

# --- description over 4096: line-boundary truncation and Full notes link ---
python3 - "$tmp/long.json" << 'PY'
import json, sys
body = "\n".join(["A" * 60] * 80)
json.dump({
    "name": "Rel",
    "tag_name": "v9.0.0",
    "html_url": "https://example.com/r/v9.0.0",
    "body": body,
    "published_at": "2026-01-01T00:00:00Z",
}, open(sys.argv[1], "w"))
PY
run "$tmp/long.json" "$tmp/long.out" "$tmp/long.err"
python3 - "$tmp/long.out" << 'PY'
import json, sys
payload = json.load(open(sys.argv[1]))
desc = payload["embeds"][0]["description"]
link = "[Full notes](https://example.com/r/v9.0.0)"
assert len(desc) <= 4096, len(desc)
assert desc.endswith(link), desc[-80:]
before = desc[: desc.rfind("\n\n[Full notes]")]
assert before.endswith("A" * 60), repr(before[-80:])
assert "\ufffd" not in desc
print(len(desc))
PY
grep -q 'truncated=true' "$tmp/long.err" || fail "long body not marked truncated: $(cat "$tmp/long.err")"
ok "long notes truncate at a line boundary and link to full notes"

# --- UTF-8: a 4-byte emoji at the cut is kept intact ---
python3 - "$tmp/utf8.json" << 'PY'
import json, sys
url = "https://example.com/r"
suffix = f"\n\n[Full notes]({url})"
cut = 4096 - len(suffix)
body = "x" * (cut - 1) + "🎵" + "y" * 200
json.dump({
    "name": "Rel",
    "tag_name": "v9.0.0",
    "html_url": url,
    "body": body,
    "published_at": "2026-01-01T00:00:00Z",
}, open(sys.argv[1], "w"))
PY
run "$tmp/utf8.json" "$tmp/utf8.out" "$tmp/utf8.err"
python3 - "$tmp/utf8.out" << 'PY'
import json, sys
desc = json.load(open(sys.argv[1]))["embeds"][0]["description"]
assert "🎵" in desc, repr(desc[-40:])
assert "\ufffd" not in desc
assert len(desc) <= 4096
assert desc.endswith("[Full notes](https://example.com/r)")
PY
ok "truncation does not split a multibyte character"

# --- whole-embed 6000 cap with a long title and footer ---
python3 - "$tmp/embed.json" << 'PY'
import json, sys
json.dump({
    "name": "T" * 256,
    "tag_name": "f" * 2000,
    "html_url": "https://example.com/r",
    "body": ("L" * 80 + "\n") * 80,
    "published_at": "2026-01-01T00:00:00Z",
}, open(sys.argv[1], "w"))
PY
run "$tmp/embed.json" "$tmp/embed.out" "$tmp/embed.err"
python3 - "$tmp/embed.out" << 'PY'
import json, sys
e = json.load(open(sys.argv[1]))["embeds"][0]
total = len(e["title"]) + len(e["description"]) + len(e["footer"]["text"])
assert total <= 6000, total
assert e["description"].endswith("[Full notes](https://example.com/r)")
assert len(e["title"]) == 256
print(total)
PY
c="$(counts_of "$tmp/embed.err")"
[[ "$c" == *"truncated=true"* ]] || fail "6000-cap counts: $c"
# Parse embed=N from counts and check N <= 6000
embed_n="${c#* embed=}"
embed_n="${embed_n%% *}"
[[ "$embed_n" -le 6000 ]] || fail "counts embed=$embed_n over 6000"
ok "whole embed stays at or under 6000 characters ($c)"

# --- unclosed code fence: close it so the Full notes link stays clickable ---
python3 - "$tmp/fence.json" << 'PY'
import json, sys
body = "```json\n" + "\n".join(["A" * 60] * 80)
json.dump({
    "name": "Rel",
    "tag_name": "v9.0.0",
    "html_url": "https://example.com/r/v9.0.0",
    "body": body,
    "published_at": "2026-01-01T00:00:00Z",
}, open(sys.argv[1], "w"))
PY
run "$tmp/fence.json" "$tmp/fence.out" "$tmp/fence.err"
python3 - "$tmp/fence.out" << 'PY'
import json, sys
desc = json.load(open(sys.argv[1]))["embeds"][0]["description"]
link = "[Full notes](https://example.com/r/v9.0.0)"
assert desc.endswith(link), repr(desc[-80:])
assert len(desc) <= 4096

def open_fence_at_end(text):
    open_fence = None
    for line in text.split("\n"):
        stripped = line.lstrip(" ")
        if (len(line) - len(stripped)) > 3:
            continue
        char = None
        if stripped.startswith("```"):
            char = "`"
        elif stripped.startswith("~~~"):
            char = "~"
        if char is None:
            continue
        n = 0
        while n < len(stripped) and stripped[n] == char:
            n += 1
        if n < 3:
            continue
        rest = stripped[n:]
        closes = rest.strip() == ""
        if open_fence is None:
            open_fence = (char, n)
        elif closes and char == open_fence[0] and n >= open_fence[1]:
            open_fence = None
    return open_fence

assert open_fence_at_end(desc) is None, "description ends with an open fence; link would be swallowed"
assert "\n```\n\n[Full notes]" in desc
PY
grep -q 'truncated=true' "$tmp/fence.err" || fail "fenced body not marked truncated: $(cat "$tmp/fence.err")"
ok "an unclosed truncated fence is closed before the Full notes link"

# --- already-closed fences are left alone ---
python3 - "$tmp/closed-fence.json" << 'PY'
import json, sys
body = "intro\n\n```\nshort\n```\n\n" + "\n".join(["B" * 60] * 80)
json.dump({
    "name": "Rel",
    "tag_name": "v9.0.0",
    "html_url": "https://example.com/r/v9.0.0",
    "body": body,
    "published_at": "2026-01-01T00:00:00Z",
}, open(sys.argv[1], "w"))
PY
run "$tmp/closed-fence.json" "$tmp/closed-fence.out" "$tmp/closed-fence.err"
python3 - "$tmp/closed-fence.out" << 'PY'
import json, sys
desc = json.load(open(sys.argv[1]))["embeds"][0]["description"]
assert "```\nshort\n```\n" in desc
assert "```\nshort\n```\n```" not in desc
assert desc.endswith("[Full notes](https://example.com/r/v9.0.0)")
assert len(desc) <= 4096
PY
ok "already-closed fences are not given an extra closer"

# --- title longer than Discord's 256 cap ---
jq -n --arg name "$(python3 -c 'print("N"*300)')" \
  '{tag_name:"v1", html_url:"https://example.com/r", name:$name, body:"Hi"}' >"$tmp/title.json"
run "$tmp/title.json" "$tmp/title.out" "$tmp/title.err"
jq -e '(.embeds[0].title | length) == 256' "$tmp/title.out" >/dev/null || fail "title cap"
ok "title is clamped to 256 characters"

# --- allowed_mentions stays empty even when notes mention @everyone ---
jq -n '{tag_name:"v1", html_url:"https://example.com/r", name:"N", body:"Hello @everyone and <@123>"}' \
  >"$tmp/mentions.json"
run "$tmp/mentions.json" "$tmp/mentions.out" "$tmp/mentions.err"
jq -e '.allowed_mentions == {"parse": []} and (.embeds[0].description | test("@everyone"))' \
  "$tmp/mentions.out" >/dev/null || fail "mentions: $(cat "$tmp/mentions.out")"
ok "allowed_mentions.parse is empty when notes contain mention text"

echo "ALL PASS"
