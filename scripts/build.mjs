// Stage the Tizen web app in dist/wgt: static files from app/ plus one
// classic-script bundle of src/main.ts for Tizen 8.0's Chromium 108 engine.
// Usage: node scripts/build.mjs [--root <dir>]
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeCatalogFiles } from "./catalog-files.ts";

const DEFAULT_VERSION = "0.0.1";
const WIDGET_VERSION = /(<widget\b[^>]*\bversion=")([^"]+)(")/;
const EXACT_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function headReleaseVersion(cwd) {
    try {
        const tags = execFileSync("git", ["tag", "--points-at", "HEAD", "--list", "v*"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).split(/\s+/);
        let best;
        for (const tag of tags) {
            const match = EXACT_TAG.exec(tag);
            if (!match) continue;
            const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
            if (parts[0] > 255 || parts[1] > 255 || parts[2] > 65535) continue;
            if (
                !best ||
                parts[0] > best[0] ||
                (parts[0] === best[0] && (parts[1] > best[1] || (parts[1] === best[1] && parts[2] > best[2])))
            ) {
                best = parts;
            }
        }
        return best ? best.join(".") : undefined;
    } catch {
        return undefined;
    }
}

const { values } = parseArgs({
    options: {
        root: { type: "string" },
    },
});
if (values.root !== undefined && !values.root.trim()) {
    throw new Error("--root requires a directory path");
}
const root = values.root
    ? resolve(values.root)
    : join(dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = join(root, "dist", "wgt");
const config = readFileSync(join(root, "app", "config.xml"), "utf8");
const configVersion = WIDGET_VERSION.exec(config)?.[2];
if (configVersion === undefined) {
    throw new Error("The Tizen package version is missing");
}
const version = configVersion === DEFAULT_VERSION ? (headReleaseVersion(root) ?? configVersion) : configVersion;

rmSync(stageDir, { recursive: true, force: true });
cpSync(join(root, "app"), stageDir, { recursive: true });
if (version !== configVersion) {
    writeFileSync(join(stageDir, "config.xml"), config.replace(WIDGET_VERSION, `$1${version}$3`));
}

await build({
    entryPoints: [join(root, "src", "main.ts")],
    outfile: join(stageDir, "js", "main.js"),
    bundle: true,
    format: "iife",
    target: "chrome108",
    // app/fonts is copied beside js/; the stylesheet's relative URL must stay as written.
    external: ["../fonts/*"],
    define: { APP_VERSION: JSON.stringify(version) },
    logLevel: "info"
});

// English is in main.js; every other language is its own file, loaded when it is the language shown.
writeCatalogFiles(join(stageDir, "catalog"));
