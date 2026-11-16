// Vendor the silo-translations strings a TV can show into src/i18n/catalog/, at an explicit commit,
// and record that commit in src/i18n/catalog/SOURCE:
//
//   src/i18n/catalog/<tag>.json   <- catalog/<tag>.arb, as key -> ICU message
//
// Scope: the keys Apple ships (no `x-platforms`, or one naming `apple`), because tvOS is the parity target
// and Apple's keys use the ICU subset src/i18n/icu.ts reads. Metadata (`@key`) and Info.plist prompts
// (`apple.infoPlist.*`) are left out. Every byte comes from the repository at <ref>, never a moving branch.
//
// English keeps every key. Another language keeps only the keys `src` names as strings: they all ship in
// one script until the catalogs load on demand, and a key a screen does not show is dead weight there.
// The exception is text the server names by key (`title_key`): no screen spells those keys, so every key under
// SERVER_KEY_PREFIXES stays.
//
// Usage: node scripts/sync-translations.ts <silo-translations-commit-or-tag> [--languages en,es,...]
//   --languages   the language files to vendor (default: every shipped language). Each must be in locales.json.
//
// Afterwards add each new language to SHIPPED_LANGUAGES (src/i18n/language.ts), then run npm test: the build
// packages its file as catalog/<tag>.js, and a test holds the shipped list to the files.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseMessage } from "../src/i18n/icu.ts";
import { SHIPPED_LANGUAGES } from "../src/i18n/language.ts";

const REPOSITORY = "Silo-Server/silo-translations";
const SCOPE_PLATFORM = "apple";
const EXCLUDED_PREFIX = "apple.infoPlist.";
/** Home section titles: the server sends the key (`home.section.recentlyAddedIn`) with the title it wrote. */
const SERVER_KEY_PREFIXES: readonly string[] = ["home.section."];

type ArbEntry = string | { readonly description?: string; readonly "x-platforms"?: readonly string[] };

/**
 * An `.arb` file's messages in scope, sorted by key. English carries the metadata that scopes keys, so a
 * translation file is scoped by the English key set instead.
 */
export function scopeCatalog(arb: Readonly<Record<string, ArbEntry>>, englishKeys?: ReadonlySet<string>): Record<string, string> {
    const scoped: Record<string, string> = {};
    for (const key of Object.keys(arb).sort()) {
        const message = arb[key];
        if (key.startsWith("@") || typeof message !== "string" || key.startsWith(EXCLUDED_PREFIX)) continue;
        if (englishKeys === undefined) {
            const meta = arb[`@${key}`];
            const platforms = typeof meta === "object" ? meta["x-platforms"] : undefined;
            if (platforms !== undefined && !platforms.includes(SCOPE_PLATFORM)) continue;
        } else if (!englishKeys.has(key)) {
            continue;
        }
        try {
            parseMessage(message);
        } catch (error) {
            throw new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
        scoped[key] = message;
    }
    return scoped;
}

const KEY_IN_SOURCE = /["'`]([A-Za-z][\w]*(?:\.[\w]+)+)["'`]/g;

/** The catalog keys a source text names as a string, and the keys the server names. A name that is not a catalog key is ignored. */
export function usedKeys(sources: readonly string[], catalogKeys: ReadonlySet<string>): Set<string> {
    const used = new Set<string>();
    for (const key of catalogKeys) if (SERVER_KEY_PREFIXES.some(prefix => key.startsWith(prefix))) used.add(key);
    for (const source of sources) {
        for (const [, name] of source.matchAll(KEY_IN_SOURCE)) if (name !== undefined && catalogKeys.has(name)) used.add(name);
    }
    return used;
}

function readSources(directory: string): string[] {
    return readdirSync(directory, { recursive: true, encoding: "utf8" }).filter(name => name.endsWith(".ts")).map(name => readFileSync(join(directory, name), "utf8"));
}

async function download(path: string, commit: string): Promise<Record<string, ArbEntry>> {
    const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${path}`);
    if (!response.ok) throw new Error(`${path} at ${commit}: HTTP ${response.status}`);
    return await response.json() as Record<string, ArbEntry>;
}

async function resolveCommit(ref: string): Promise<string> {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/commits/${encodeURIComponent(ref)}`, { headers: { Accept: "application/vnd.github+json" } });
    if (!response.ok) throw new Error(`${ref}: HTTP ${response.status}`);
    const { sha } = await response.json() as { sha: string };
    return sha;
}

const USAGE = "usage: node scripts/sync-translations.ts <silo-translations-commit-or-tag> [--languages en,es,...]";

/** The language files to vendor. With no option, every shipped language: a file the build imports must survive a refresh. */
export function languagesToSync(options: readonly string[]): string[] {
    const languages = options[0] === "--languages" ? (options[1] ?? "").split(",") : options.length === 0 ? [...SHIPPED_LANGUAGES] : [];
    if (languages[0] !== "en") throw new Error(USAGE);
    return languages;
}

async function main(): Promise<void> {
    const [ref, ...options] = process.argv.slice(2);
    if (ref === undefined || ref.startsWith("--")) throw new Error(USAGE);
    const languages = languagesToSync(options);
    const commit = await resolveCommit(ref);
    const english = scopeCatalog(await download("catalog/en.arb", commit));
    const englishKeys = new Set(Object.keys(english));
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const used = usedKeys(readSources(join(root, "src")), englishKeys);
    // Everything is downloaded and checked before any vendored file changes.
    const catalogs = new Map<string, Record<string, string>>();
    for (const tag of languages) catalogs.set(tag, tag === "en" ? english : scopeCatalog(await download(`catalog/${tag}.arb`, commit), used));
    const destination = join(root, "src", "i18n", "catalog");
    mkdirSync(destination, { recursive: true });
    for (const stale of readdirSync(destination)) if (stale.endsWith(".json")) rmSync(join(destination, stale));
    for (const [tag, messages] of catalogs) {
        writeFileSync(join(destination, `${tag}.json`), `${JSON.stringify(messages, null, 1)}\n`);
        console.log(`${tag}: ${Object.keys(messages).length} messages`);
    }
    writeFileSync(join(destination, "SOURCE"), `${commit}\n`);
    console.log(`silo-translations ${commit}`);
}

if (import.meta.main) await main();
