// Buffering / Quality evidence (`bq`) rendered for issue bodies, from values BUFFERING_CONTRACT validated.

const MODE_LABELS = { always: "Always", ask: "Ask first", never: "Never" };
const LEARNED_LIMIT_LABELS = {
  unsupported: "Not supported by the server",
  ignored: "Ignored while lowering is off",
  server: "Applied by the server when set (value not visible on the TV)",
  cleared: "Cleared by Restore quality",
};
const NETWORK_LABELS = { wifi: "Wi-Fi", ethernet: "Ethernet", cellular: "Cellular", other: "Other", unavailable: "Not reported by the TV" };
const SPEED_LABELS = {
  unsupported: "Not supported by the server",
  offline: "None: offline at start",
  metered: "None: not used on a metered network",
  none: "No stored reading",
};
const REASON_LABELS = { auto: "Automatic lowering after stalls", prompt: "Viewer chose Lower quality", restore: "Viewer chose Restore quality" };
const OUTCOME_LABELS = { pending: "No answer before capture", adopted: "New plan adopted", not_adopted: "No plan adopted", not_sent: "Not sent" };

const NOT_REPORTED = "Not reported";
const kbpsText = (value) => (value === undefined ? NOT_REPORTED : `${value} kbps`);
const secondsText = (ms) => `${(ms / 1000).toFixed(1)} s`;

function ageText(seconds) {
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

function speedText(spd) {
  if (spd === undefined) return NOT_REPORTED;
  if (typeof spd === "string") return SPEED_LABELS[spd];
  const source = spd.src === "probe" ? "speed test" : "playback sample";
  return `${spd.kbps} kbps from a ${source}, ${ageText(spd.age)} old at capture, ${spd.fresh ? "fresh" : "stale (too old to send)"}`;
}

function preferenceText(q) {
  if (q === undefined) return NOT_REPORTED;
  return q === "auto" ? "Automatic quality (auto)" : `Fixed quality (${q})`;
}

function stallText(st) {
  if (st === undefined) return NOT_REPORTED;
  if (st.n === 0) return "None measured";
  const recent = st.d?.length > 0 ? `; recent: ${st.d.map(secondsText).join(", ")}` : "";
  return `${st.n}${recent}${st.lg === undefined ? "" : `; longest ${secondsText(st.lg)}`}`;
}

const planText = (quality, kbps) => [quality ?? "unknown quality", kbps === undefined ? undefined : `${kbps} kbps`].filter(Boolean).join(" ");

function stepLine(step, index) {
  const parts = [
    REASON_LABELS[step.r],
    `${planText(step.fq, step.fk)} → ${step.o === "adopted" ? planText(step.tq, step.tk) : "no new plan"}`,
    step.est === undefined ? undefined : `step-down estimate ${step.est} kbps`,
    step.thr === undefined ? "measured throughput not available" : `measured throughput ${step.thr} kbps`,
    OUTCOME_LABELS[step.o],
  ].filter(Boolean);
  return `${index + 1}. ${parts.join(" · ")}`;
}

function rows(bq) {
  return [
    ["Lower quality when buffering", MODE_LABELS[bq.md]],
    ["Quality preference", preferenceText(bq.q)],
    ["Bitrate cap from Settings", bq.mc === undefined ? NOT_REPORTED : bq.mc === "none" ? "None" : `${bq.mc} kbps (forced cap)`],
    ["Learned connection limit", bq.ll === undefined ? NOT_REPORTED : LEARNED_LIMIT_LABELS[bq.ll]],
    ["Playing plan quality", bq.pq ?? NOT_REPORTED],
    ["Planned bitrate", kbpsText(bq.pk)],
    ["Source bitrate", kbpsText(bq.sk)],
    ["Output bitrate", bq.ok === undefined ? "None named (not transcoded or not reported)" : `${bq.ok} kbps`],
    ["Connection estimate sent at start", bq.est === undefined ? "None sent" : `${bq.est} kbps (from a stored reading)`],
    ["Last stored speed reading", speedText(bq.spd)],
    ["Network type", bq.net === undefined ? NOT_REPORTED : NETWORK_LABELS[bq.net.t]],
    ["Effective connection class (browser estimate)", bq.net?.ec === undefined || bq.net.ec === "unavailable" ? "Not reported by the TV" : bq.net.ec],
    ["Stalls of 1 s or more (outages and startup excluded)", stallText(bq.st)],
  ];
}

/** Body lines for the evidence, or none when the report carries no `bq`. */
export function bufferingSection(bq, table) {
  if (bq === undefined) return [];
  const lines = ["", "### Buffering and quality", "", ...table(rows(bq))];
  if (bq.sd?.length > 0) lines.push("", "#### Quality changes", "", ...bq.sd.map(stepLine));
  return lines;
}
