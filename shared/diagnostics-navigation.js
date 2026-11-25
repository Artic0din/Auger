// Navigation evidence vocabulary shared by the TV client (src/diagnosticsNavigation.ts) and the relay
// (workers/diagnostics-relay/navigation.js). Every public value is one of these words or a bounded integer.

/** Where the viewer was: the browse route, Settings, or unknown when no browse screen owned the remote. */
export const NAV_SCREENS = [
  "home", "details", "library", "search", "person", "calendar", "requests", "audiobook", "personal", "watchParty", "for_you",
  "settings", "unknown",
];

/**
 * Focus zone families. A zone id's text after its first colon is a server identifier (`section:<id>`), so only the
 * family before it may leave the TV; a family missing here is published as "other".
 */
export const NAV_ZONES = [
  "about", "accounts", "acknowledgements-actions", "acknowledgements-document", "actions", "alert", "band", "box-set",
  "chapters", "choice", "choices", "classic", "collections", "controls", "days", "dialog", "empty", "end", "episode-rail",
  "episode-retry", "episodes", "episodes-retry", "episodes-top", "error", "extras", "facts", "field", "filters", "flyout",
  "grid", "invite", "letters", "loading", "lobby-actions", "lobby-ballot", "lobby-seats", "lobby-top", "minimal",
  "mutations", "narrations", "nav", "options", "page", "pager", "panel", "party", "people", "picker-retry", "picker-top",
  "pill", "pills", "plate", "rail", "related", "rows", "search", "search-box-sets", "search-filters", "search-people",
  "search-requests", "seasons", "section", "selector", "servers", "settings-categories", "settings-confirm",
  "settings-picker", "settings-rows", "shelf", "square", "state", "status", "vibrant", "other", "none",
];

export const NAV_ACTIONS = ["up", "down", "left", "right", "enter", "back", "play_pause", "play", "pause", "stop", "rewind", "fast_forward"];

/**
 * Arrow outcomes compare focus before and after the press: moved within its zone, into another zone, stayed put
 * (a trap or an edge), lost (nothing focusable holds focus) or restored (focus had been lost). Other keys are "pressed":
 * their effect (a click on release, a route change) is not a focus move.
 */
export const NAV_OUTCOMES = ["moved", "zone", "stayed", "lost", "restored", "pressed"];

/** Safe API operation families, matched against the path below /api/v2 with its query removed. */
const API_ROUTES = [
  [/^\/home\/sections$/, "home_sections"],
  [/^\/home\//, "home"],
  [/^\/catalog\/items\/[^/]+$/, "item_detail"],
  [/^\/catalog\/items\//, "item_related"],
  [/^\/catalog\/series\/[^/]+\/seasons\/[^/]+\/episodes$/, "episodes"],
  [/^\/catalog\/series\/[^/]+\/seasons$/, "seasons"],
  [/^\/catalog\/box-sets/, "box_sets"],
  [/^\/catalog\/people/, "people"],
  [/^\/catalog\/audiobook-groups/, "audiobooks"],
  [/^\/catalog(?:\/query)?$/, "catalog_page"],
  [/^\/user\/libraries/, "libraries"],
  [/^\/recommendations\//, "recommendations"],
  [/^\/watch\/[^/]+\/trickplay/, "trickplay"],
  [/^\/watch\//, "watch_detail"],
  [/^\/calendar/, "calendar"],
  [/^\/requests/, "requests"],
  [/^\/settings\//, "settings"],
  [/^\/playback\//, "playback"],
  [/^\/auth\//, "auth"],
  [/^\/profiles/, "profiles"],
];

export const NAV_API_OPERATIONS = [...API_ROUTES.map(([, name]) => name), "other"];

/** The public family of a focus zone id. */
export function navZone(id) {
  if (typeof id !== "string") return "none";
  const colon = id.indexOf(":");
  const family = colon === -1 ? id : id.slice(0, colon);
  return NAV_ZONES.includes(family) ? family : "other";
}

/** The safe operation family of an /api/v2 request URL, or undefined for any other URL. */
export function navApiOperation(url) {
  if (typeof url !== "string") return undefined;
  const at = url.indexOf("/api/v2/");
  if (at === -1) return undefined;
  const end = url.search(/[?#]/);
  const path = url.slice(at + "/api/v2".length, end === -1 ? undefined : end);
  return API_ROUTES.find(([pattern]) => pattern.test(path))?.[1] ?? "other";
}

/** Retained breadcrumb steps per capture; repeated identical steps collapse into one with a count. */
export const NAV_MAX_STEPS = 8;
export const NAV_MAX_REPEAT = 99;
