import { canonicalLanguageKey } from "./trackLabels.ts";
import { languageChoices } from "./subtitleAppearance.ts";
import type { SubtitleAIQuota } from "../contracts/v2/subtitleAI.ts";
import { integerText } from "../i18n/numbers.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";

// SubtitleTranslateMenu (silo-apple main): the viewer picks one language and the menu picks the method. It translates an existing
// text subtitle when one is in another language, else transcribes the spoken audio, and translates the transcript when the
// language differs from the spoken one.

/** A text subtitle track with a resolvable server index: the only kind that can be translated. */
export interface AISource { readonly index: number; readonly language: string | undefined; readonly selected: boolean; readonly isDefault: boolean }

export interface AIInputs {
    readonly translateEnabled: boolean;
    readonly transcribeEnabled: boolean;
    readonly sources: readonly AISource[];
    /** Every audio track, by server index. */
    readonly audio: readonly AISource[];
    /** The balance was read. SubtitleAI sends no transcription without it. */
    readonly quotaKnown: boolean;
    /** Transcription quota is known to be used up. */
    readonly quotaExhausted: boolean;
}

export interface AIRoute {
    readonly kind: "translate" | "transcribe" | "transcribe_translate";
    readonly sourceIndex: number;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
}

export interface AIMenuRow { readonly code: string; readonly label: string; readonly hint: MessageKey | undefined; readonly disabled: boolean }
export interface AIMenu {
    /** Transcribe in whatever language the server detects: offered when translation is off and the spoken language is unknown. */
    readonly detected: AIMenuRow | undefined;
    readonly suggested: readonly AIMenuRow[];
    readonly other: readonly AIMenuRow[];
}

/** Not a language code: the "Spoken language" row's identity. */
export const DETECTED_LANGUAGE = "ai-detected-spoken-language";

export function hasActionableSource(inputs: AIInputs): boolean {
    return (inputs.translateEnabled && inputs.sources.length > 0) || (inputs.transcribeEnabled && inputs.audio.length > 0);
}

/** The audio whose language counts as spoken: the selected one, else the default, else the first. */
function spoken(inputs: AIInputs): AISource | undefined {
    return inputs.audio.find(track => track.selected) ?? inputs.audio.find(track => track.isDefault) ?? inputs.audio[0];
}

function offersDetected(inputs: AIInputs): boolean {
    return !inputs.translateEnabled && inputs.transcribeEnabled && inputs.audio.length > 0 && canonicalLanguageKey(spoken(inputs)?.language) === undefined;
}

function isSpoken(inputs: AIInputs, target: string): boolean {
    if (target === DETECTED_LANGUAGE) return offersDetected(inputs);
    const key = canonicalLanguageKey(spoken(inputs)?.language);
    return key !== undefined && key === canonicalLanguageKey(target);
}

/** A track in another language, or one with no language (the server detects it); English first, then the selected, default and first. */
function bestSource(inputs: AIInputs, target: string): AISource | undefined {
    if (!inputs.translateEnabled) return undefined;
    const targetKey = canonicalLanguageKey(target);
    const candidates = inputs.sources.filter(track => {
        const key = canonicalLanguageKey(track.language);
        return key === undefined || key !== targetKey;
    });
    return candidates.find(track => canonicalLanguageKey(track.language) === "en") ?? candidates.find(track => track.selected) ?? candidates.find(track => track.isDefault) ?? candidates[0];
}

/** What the language choice sends, or undefined when the server cannot serve it now. */
/**
 * The catalog lists the server's translation targets. With translation off, the spoken language's row only transcribes, which needs no
 * target, so the menu offers it even when unlisted, as SubtitleLanguageChoices always offers the original language.
 */
function unlistedSpoken(inputs: AIInputs, languages: readonly string[]): string | undefined {
    const code = spoken(inputs)?.language;
    const key = canonicalLanguageKey(code);
    if (inputs.translateEnabled || key === undefined || languages.some(candidate => canonicalLanguageKey(candidate) === key)) return undefined;
    return code;
}

export function aiRoute(inputs: AIInputs, target: string): AIRoute | undefined {
    const source = target === DETECTED_LANGUAGE ? undefined : bestSource(inputs, target);
    if (source !== undefined) return { kind: "translate", sourceIndex: source.index, sourceLanguage: source.language ?? "", targetLanguage: target };
    if (!inputs.transcribeEnabled || inputs.audio.length === 0 || inputs.quotaExhausted || !inputs.quotaKnown) return undefined;
    if (target === DETECTED_LANGUAGE ? !offersDetected(inputs) : !inputs.translateEnabled && !isSpoken(inputs, target)) return undefined;
    const translated = isSpoken(inputs, target) ? undefined : target;
    // -1 is the server's default audio track, for a spoken track with no known ordinal.
    return { kind: translated === undefined ? "transcribe" : "transcribe_translate", sourceIndex: spoken(inputs)?.index ?? -1, sourceLanguage: "", targetLanguage: translated ?? "" };
}

/** Whether a language needs transcription, and so spends quota. */
function needsTranscription(inputs: AIInputs, target: string): boolean {
    return bestSource(inputs, target) === undefined;
}

export function aiMenu(inputs: AIInputs, languages: readonly string[], preferred: string | undefined): AIMenu {
    const row = (code: string, label: string, hint: MessageKey | undefined): AIMenuRow => ({ code, label, hint, disabled: aiRoute(inputs, code) === undefined });
    const catalog = languages.map(code => ({ code }));
    const spokenCode = spoken(inputs)?.language;
    const listed = (code: string | undefined): string | undefined => {
        const key = canonicalLanguageKey(code);
        return key === undefined ? undefined : languages.find(candidate => canonicalLanguageKey(candidate) === key);
    };
    const preferredCode = listed(preferred);
    const unlisted = unlistedSpoken(inputs, languages);
    const originalCode = listed(spokenCode) ?? unlisted;
    const choices = languageChoices(unlisted === undefined ? catalog : [...catalog, { code: unlisted }], preferredCode);
    const suggested = choices.suggested.map(choice => row(choice.code, choice.label, choice.hint));
    const rest = choices.other.filter(choice => choice.code !== originalCode);
    if (originalCode !== undefined && !suggested.some(item => item.code === originalCode)) {
        const original = choices.other.find(choice => choice.code === originalCode);
        if (original !== undefined) suggested.push(row(original.code, original.label, "subtitleSearch.originalLanguage"));
    }
    return {
        detected: offersDetected(inputs) ? { code: DETECTED_LANGUAGE, label: translate("player.aiTranslate.spokenLanguage"), hint: "player.aiTranslate.detectedFromAudio", disabled: aiRoute(inputs, DETECTED_LANGUAGE) === undefined } : undefined,
        suggested,
        other: rest.map(choice => row(choice.code, choice.label, undefined)),
    };
}

/** Whether any listed language, or the detected row, relies on transcription: then the quota is worth showing. */
export function relyOnTranscription(inputs: AIInputs, languages: readonly string[]): boolean {
    const unlisted = unlistedSpoken(inputs, languages);
    const offered = unlisted === undefined ? languages : [...languages, unlisted];
    return inputs.transcribeEnabled && inputs.audio.length > 0 && (offersDetected(inputs) || offered.some(code => needsTranscription(inputs, code)));
}

/** `player.aiTranslate.quota*`; the period is the server's own token, shown as sent. */
export function quotaText(quota: (Pick<SubtitleAIQuota, "limited" | "remaining" | "period"> & { readonly used?: number | undefined; readonly limit?: number | undefined }) | undefined): string | undefined {
    if (quota === undefined || !quota.limited) return undefined;
    if (quota.remaining <= 0) return translate("player.aiTranslate.quotaReached");
    const used = integerText(quota.used ?? 0);
    if (quota.limit !== undefined) {
        const limit = integerText(quota.limit);
        return quota.period === "" ? translate("player.aiTranslate.quotaUsed", { used, limit }) : translate("player.aiTranslate.quotaUsedPeriod", { used, limit, period: quota.period });
    }
    return translate("player.aiTranslate.quotaRemaining", { remaining: integerText(quota.remaining) });
}
