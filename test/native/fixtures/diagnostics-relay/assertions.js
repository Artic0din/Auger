// Assertion helpers shared by the relay case modules. Plain ES module, so the same cases run under node:test and on the TV.

class CaseFailure extends Error {}

export function check(condition, message) {
  if (!condition) throw new CaseFailure(message);
}

export function equal(actual, expected, message) {
  check(actual === expected, `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function includes(text, fragment, message) {
  check(typeof text === "string" && text.includes(fragment), `${message}: missing ${JSON.stringify(fragment)}`);
}

export function excludes(text, fragment, message) {
  check(typeof text === "string" && !text.includes(fragment), `${message}: leaked ${JSON.stringify(fragment)}`);
}

// Synthetic sensitive markers; none may appear in any outbound title, body, comment or decoded metadata.
export const SENSITIVE = [
  "synthetic.example.invalid",
  "SYNTHTOKEN",
  "SYNTH_TITLE",
  "synth_title_the_movie",
  "192.0.2.77",
  "AA:BB:CC:DD:EE:FF",
  "SYNTHSSID",
  "synthssid",
  "synth-nas.local",
  "SYNTH_PROFILE",
  "synth_profile",
  "SYNTHBEARER",
  "SYNTHSTACK",
  "SYNTH_TRACK",
  "SYNTH_SUBTITLE",
  "SYNTHSERIAL",
  "SYNTH_PATH",
];

export function assertNoSensitive(destination, label) {
  for (const text of destination.publishedText()) {
    for (const value of SENSITIVE) excludes(text, value, label);
  }
}
