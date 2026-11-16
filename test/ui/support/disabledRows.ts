import assert from "node:assert/strict";
import type { Tv } from "./tv.ts";

/**
 * Apple's TVSettingsPaneRowStyle sets an explicit foreground, so `.disabled(true)` rows are drawn at full brightness.
 * Every disabled Settings row on screen must show at opacity 1, counting its ancestors, and the `expected` rows must be among them.
 */
export async function assertDisabledRowsFullBrightness(tv: Tv, expected: readonly string[]): Promise<void> {
    const rows = await tv.page.locator('.settings [aria-disabled="true"]').evaluateAll(nodes => nodes.map(node => {
        let opacity = 1;
        for (let up: Element | null = node; up !== null; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity);
        return { key: node.getAttribute("data-focus") ?? "", opacity };
    }));
    assert.deepEqual(rows.map(row => row.key).filter(key => expected.includes(key)).sort(), [...expected].sort(), "the rows under test are disabled");
    for (const row of rows) assert.equal(row.opacity, 1, `${row.key} is disabled and drawn at full brightness`);
}
