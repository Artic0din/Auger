// Run the Playwright screen tests with one suite per machine.
//
// Each suite starts headless Chromium per test file, so two suites at once (two worktrees, or two agents)
// can exhaust a Mac's CPU and memory. A lock directory in /tmp makes a second suite wait
// for the first. A lock left by a process that no longer runs is taken over.
//
// Usage: node scripts/run-ui-tests.ts [node --test options]
// CI runs its shards with node --test directly, one suite per runner, so it does not take the lock.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// A fixed path rather than os.tmpdir(): agent sandboxes can set their own TMPDIR, which would hide the lock.
const LOCK = "/tmp/silo-tizen-ui-suite.lock";
const POLL_MS = 5000;
const UNOWNED_LOCK_MS = 30_000;

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take the lock, or return the pid and directory of the suite that holds it. */
export function tryLock(lock: string, pid = process.pid, cwd = process.cwd()): { pid: number; cwd: string } | undefined {
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let holder: { pid: number; cwd: string } | undefined;
    try {
      holder = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as { pid: number; cwd: string };
    } catch {
      // A holder writes its owner just after making the directory; one that never did has crashed.
      let madeAt: number;
      try {
        madeAt = statSync(lock).mtimeMs;
      } catch {
        return tryLock(lock, pid, cwd); // Released in the meantime.
      }
      if (Date.now() - madeAt < UNOWNED_LOCK_MS) return { pid: 0, cwd: "unknown" };
    }
    if (holder && running(holder.pid)) return holder;
    // shortcut: two suites taking over the same stale lock at once can both run; rare enough for a dev helper.
    rmSync(lock, { recursive: true, force: true });
    return tryLock(lock, pid, cwd);
  }
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, cwd }));
  return undefined;
}

async function main(): Promise<void> {
  let announced = false;
  for (let holder = tryLock(LOCK); holder; holder = tryLock(LOCK)) {
    if (!announced) console.error(`Waiting for the UI suite already running in ${holder.cwd} (pid ${holder.pid}).`);
    announced = true;
    await sleep(POLL_MS);
  }
  const release = () => rmSync(LOCK, { recursive: true, force: true });
  // Options must come before the file pattern; node --test ignores ones placed after it.
  const child = spawn(process.execPath, ["--test", "--test-concurrency=2", "--test-timeout=60000",
    ...process.argv.slice(2), "test/ui/*.test.ts"], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  child.on("exit", (code, signal) => {
    release();
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (import.meta.main) await main();
