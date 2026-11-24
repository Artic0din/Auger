import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tryLock } from "../../scripts/run-ui-tests.ts";

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ui-lock-test-")), "suite.lock");
}

test("a free lock is taken and records its owner", () => {
  const lock = lockPath();
  assert.equal(tryLock(lock, 4242, "/work/a"), undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")), { pid: 4242, cwd: "/work/a" });
});

test("a lock held by a running suite makes the next one wait", () => {
  const lock = lockPath();
  assert.equal(tryLock(lock, process.pid, "/work/a"), undefined);
  assert.deepEqual(tryLock(lock, 4243, "/work/b"), { pid: process.pid, cwd: "/work/a" });
});

test("a lock left by a suite that exited is taken over", async () => {
  const lock = lockPath();
  const exited = spawn(process.execPath, ["-e", ""]);
  const pid = exited.pid ?? 0;
  await new Promise((resolve) => exited.on("exit", resolve));
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, cwd: "/work/a" }));
  assert.equal(tryLock(lock, 4244, "/work/b"), undefined);
  assert.equal(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid, 4244);
});

test("a just-made lock without an owner yet is treated as held", () => {
  const lock = lockPath();
  mkdirSync(lock);
  assert.deepEqual(tryLock(lock, 4245, "/work/b"), { pid: 0, cwd: "unknown" });
});
