import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the packaged app requires Tizen 8.0", () => {
    const config = readFileSync(new URL("../../dist/wgt/config.xml", import.meta.url), "utf8");
    assert.match(config, /<tizen:application\b[^>]*\brequired_version="8\.0"/);
});

test("the package allows generated artwork and its own player without relaxing scripts", () => {
    const config = readFileSync(new URL("../../dist/wgt/config.xml", import.meta.url), "utf8");
    const policy = config.match(/<tizen:content-security-policy>([^<]+)<\/tizen:content-security-policy>/)?.[1];
    assert.ok(policy, "the package declares its content policy");
    const directives = Object.fromEntries(policy.split(";").filter(part => part.trim()).map(part => {
        const [name, ...sources] = part.trim().split(/\s+/);
        return [name, sources];
    }));
    assert.deepEqual(directives, {
        "default-src": ["*"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["*", "data:"],
        "object-src": ["'self'"],
    });
});

test("build stamps staged config.xml and APP_VERSION from an exact release tag without dirtying app/config.xml", () => {
    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const buildScript = join(repoRoot, "scripts", "build.mjs");
    const workDir = mkdtempSync(join(tmpdir(), "auger-build-version-"));
    try {
        cpSync(join(repoRoot, "app"), join(workDir, "app"), { recursive: true });
        symlinkSync(join(repoRoot, "src"), join(workDir, "src"));
        symlinkSync(join(repoRoot, "node_modules"), join(workDir, "node_modules"));
        const cleanEnv = Object.fromEntries(
            Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        );
        const gitEnv = {
            ...cleanEnv,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
        };
        const git = (...args: string[]) => execFileSync("git", args, { cwd: workDir, env: gitEnv, stdio: "ignore" });
        const runBuild = () =>
            execFileSync(process.execPath, [buildScript], {
                cwd: workDir,
                env: { ...cleanEnv, AUGER_BUILD_ROOT: workDir },
                stdio: "ignore",
            });

        git("init", "--quiet", "--initial-branch=main");
        git("commit", "--quiet", "--allow-empty", "-m", "chore: initial");
        git("tag", "v0.11.0-rc.1");
        git("tag", "v256.0.0");
        runBuild();
        assert.match(readFileSync(join(workDir, "dist", "wgt", "config.xml"), "utf8"), /<widget\b[^>]*\bversion="0\.0\.1"/);

        git("tag", "v0.9.0");
        git("tag", "v0.10.0");
        runBuild();
        const stagedConfig = readFileSync(join(workDir, "dist", "wgt", "config.xml"), "utf8");
        assert.match(stagedConfig, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
        assert.match(stagedConfig, /<widget\b[^>]*\bversion="0\.10\.0"/);
        assert.match(readFileSync(join(workDir, "app", "config.xml"), "utf8"), /<widget\b[^>]*\bversion="0\.0\.1"/);
        assert.match(readFileSync(join(workDir, "dist", "wgt", "js", "main.js"), "utf8"), /"0\.10\.0"/);

        const sourceConfig = readFileSync(join(workDir, "app", "config.xml"), "utf8");
        writeFileSync(
            join(workDir, "app", "config.xml"),
            sourceConfig.replace(/(<widget\b[^>]*\bversion=")[^"]+(")/, "$11.2.3$2"),
        );
        runBuild();
        assert.match(readFileSync(join(workDir, "dist", "wgt", "config.xml"), "utf8"), /<widget\b[^>]*\bversion="1\.2\.3"/);
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
});
