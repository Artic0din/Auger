import assert from "node:assert/strict";
import { test } from "node:test";
import { handleRequest } from "../../workers/diagnostics-relay/worker.js";
import { CASES, runRelayCases } from "./fixtures/diagnostics-relay/relayCases.js";

// The cases live in a plain ES module so the same assertions also run in a browser harness on the TV.
for (const entry of CASES) {
    test(`diagnostics relay: ${entry.name}`, async () => {
        const [result] = await runRelayCases(handleRequest, [entry.name]);
        assert.ok(result !== undefined, "case did not run");
        assert.ok(result.ok, result.message ?? "case failed");
    });
}
