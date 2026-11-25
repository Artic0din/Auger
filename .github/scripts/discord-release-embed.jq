# Build a Discord webhook payload from a GitHub Release object.
# Used by discord-release-embed.sh. Color 13563 is Auger signal blue #0034fb.
def text_or_empty:
  if . == null then "" else tostring end;

def is_blank:
  text_or_empty | test("^\\s*$");

def tag:
  (.tag_name // .tagName // "") | text_or_empty;

def title_text:
  if (.name | is_blank) then tag else (.name | text_or_empty) end;

def release_url:
  (.html_url // .url // "") | text_or_empty;

def body_text:
  if (.body | is_blank) then "" else (.body | text_or_empty) end;

def timestamp:
  (.published_at // .publishedAt // "") | text_or_empty;

# Prefer a newline in the last 200 characters (or the last quarter, if smaller)
# so truncation does not leave a partial line when a clean break is nearby.
def truncate_clean($max):
  if $max <= 0 then ""
  elif length <= $max then .
  else
    .[0:$max]
    | (rindex("\n") // -1) as $nl
    | ([200, ($max / 4)] | min | floor) as $window
    | if $nl >= ($max - $window) and $nl > 0 then .[0:$nl] else . end
    | sub("\\s+$"; "")
  end;

def clamp($max):
  if length <= $max then . else .[0:$max] end;

. as $rel
| ($rel | tag) as $tag
| ($rel | release_url) as $url
| (if ($tag | is_blank) then
    "discord-release-embed: release is missing tag_name\n" | halt_error(2)
  else . end)
| (if ($url | is_blank) then
    "discord-release-embed: release is missing html_url\n" | halt_error(2)
  else . end)
| ($rel | title_text | clamp(256)) as $title
| ($tag | clamp(2048)) as $footer
| ($rel | body_text) as $body
| ("\n\n[Full notes](\($url))") as $suffix
| ([4096, (6000 - ($title | length) - ($footer | length))] | min) as $desc_budget
| (if ($body | length) == 0 then
    {text: "", truncated: false}
  elif ($body | length) <= $desc_budget then
    {text: $body, truncated: false}
  elif ($suffix | length) >= $desc_budget then
    # Pathological URL: keep a truncated body inside the budget, no suffix.
    {text: ($body | truncate_clean($desc_budget)), truncated: true}
  else
    {text: (($body | truncate_clean($desc_budget - ($suffix | length))) + $suffix), truncated: true}
  end) as $desc
| {
    username: "GitHub Releases",
    allowed_mentions: {parse: []},
    embeds: [
      (
        {
          title: $title,
          url: $url,
          color: 13563,
          footer: {text: $footer}
        }
        + (if ($desc.text | length) == 0 then {} else {description: $desc.text} end)
        + (if ($rel | timestamp | is_blank) then {} else {timestamp: ($rel | timestamp)} end)
      )
    ]
  }
