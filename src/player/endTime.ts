// PlayerEndTime.swift (silo-apple main 3289bedb): the wall-clock finish shown beside the time remaining.
import { isolated } from "../i18n/direction.ts";
import { shortTime } from "../i18n/format.ts";
import { translate } from "../i18n/translate.ts";

/** When playback finishes at `speed` (1 when it is not a positive number), or undefined when nothing is left to play. */
export function endDate(nowMs: number, remainingSeconds: number, speed: number): Date | undefined {
    if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) return undefined;
    const rate = Number.isFinite(speed) && speed > 0 ? speed : 1;
    return new Date(nowMs + (remainingSeconds / rate) * 1000);
}

/** `time`, followed by "· Ends 11:42 PM" in the shown language when there is a finish time. */
export function withEndTime(time: string, nowMs: number, remainingSeconds: number, speed: number): string {
    const end = endDate(nowMs, remainingSeconds, speed);
    if (end === undefined) return time;
    return `${time} · ${isolated(translate("player.scrubber.endsAt", { time: shortTime(end) }))}`;
}
