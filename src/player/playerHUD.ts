import type { PlayerChapter } from "../contracts/v2/chapters.ts";
import type { PlaybackPlan } from "../contracts/v2/playback.ts";
import type { ItemDetail } from "../contracts/v2/catalog.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";

export function currentChapter(chapters: readonly PlayerChapter[], seconds: number): number {
    for (let index = chapters.length - 1; index >= 0; index--) if (chapters[index]!.seconds <= seconds) return index;
    return -1;
}

export const DISPLAY_MODES = { Fit: "PLAYER_DISPLAY_MODE_LETTER_BOX", Stretch: "PLAYER_DISPLAY_MODE_FULL_SCREEN" } as const;
export type PlayerAspect = keyof typeof DISPLAY_MODES;

const ASPECT_KEYS = { Fit: "player.aspect.fit", Stretch: "player.aspect.stretch" } as const satisfies Readonly<Record<PlayerAspect, MessageKey>>;
/** The aspect's name in the shown language; `Fit` and `Stretch` stay the ids the screen and AVPlay use. */
export function aspectLabel(aspect: PlayerAspect): string {
    return translate(ASPECT_KEYS[aspect]);
}

const STAT_KEYS: Readonly<Record<string, MessageKey>> = { Engine: "player.stats.sectionEngine", Delivery: "player.stats.delivery", Container: "player.stats.container" };
/** A stats row's label in the shown language where Apple has the same text; the rest of the rows keep their English. */
export function statLabel(label: string): string {
    const key = STAT_KEYS[label];
    return key === undefined ? label : translate(key);
}

export function videoOptions(speed: boolean, aspect: boolean, protocol: string | undefined): { speeds: readonly number[]; aspects: readonly PlayerAspect[] } {
    return { speeds: speed && protocol === "http_progressive" ? [1, 2] : [], aspects: aspect ? ["Fit", "Stretch"] : [] };
}

export interface PlayerHUD {
    readonly metadata?: ItemDetail | undefined;
    readonly metadataFailed?: boolean;
    readonly chapters: readonly PlayerChapter[];
    readonly chapterState: "loading" | "ready" | "failed";
    readonly overview?: string | undefined;
    readonly stats: readonly (readonly [string, string])[];
    readonly speeds: readonly number[];
    readonly aspects: readonly PlayerAspect[];
    readonly speed: number | undefined;
    readonly aspect: PlayerAspect | undefined;
    readonly autoNext?: boolean | undefined;
    readonly busy: boolean;
    readonly message?: string | undefined;
}

/** Report plan facts as output configuration, never as measured throughput. */
export function planStats(plan: PlaybackPlan): readonly (readonly [string, string])[] {
    const rows: [string, string][] = [["Engine", "AVPlay"], ["Delivery", plan.delivery]];
    if (plan.streamProtocol) rows.push(["Protocol", plan.streamProtocol]);
    if (plan.streamContainer) rows.push(["Container", plan.streamContainer]);
    if (plan.recipe) {
        const recipe = plan.recipe;
        rows.push(["Video codec", recipe.videoCodec], ["Audio codec", recipe.audioCodec]);
        if (recipe.width > 0 && recipe.height > 0) rows.push(["Output resolution", `${recipe.width} × ${recipe.height}`]);
        if (recipe.bitrateKbps > 0) rows.push(["Configured bitrate", `${recipe.bitrateKbps} kbps`]);
    }
    return rows;
}
