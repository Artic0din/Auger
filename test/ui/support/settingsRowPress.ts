import assert from "node:assert/strict";
import type { Locator } from "playwright";
import type { Tv } from "./tv.ts";

/** TVSettingsComponents.swift:208,214,272,279 and SiloTheme.swift:164 at silo-apple 08ff656f. */
export async function focusSettingsRow(row: Locator): Promise<void> {
    await row.focus();
    const style = await row.evaluate(node => {
        // Settle the row at rest before measuring a real focus transition on the same node.
        (node as HTMLElement).blur();
        getComputedStyle(node).transform;
        for (const animation of node.getAnimations()) animation.finish();
        getComputedStyle(node).transform;
        (node as HTMLElement).focus();
        const animations = node.getAnimations();
        for (const animation of animations) { animation.pause(); animation.currentTime = 60; }
        const halfway = Number(new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
        for (const animation of animations) animation.finish();
        const css = getComputedStyle(node);
        return { halfway, transform: css.transform, property: css.transitionProperty, duration: css.transitionDuration, easing: css.transitionTimingFunction };
    });
    assert.ok(style.halfway > 1 && style.halfway < 1.012, `focus animates through an intermediate scale: ${style.halfway}`);
    assert.equal(style.transform, "matrix(1.012, 0, 0, 1.012, 0, 0)");
    assert.equal(style.duration, "0.12s");
    assert.equal(style.easing, "ease-out");
    assert.notEqual(style.property, "all", "only focus changes animate");
    assert.notEqual(style.property, "transform", "press and release must not transition the transform");
}

export async function holdSettingsRow(tv: Tv, row: Locator): Promise<void> {
    await tv.page.keyboard.down("Enter");
    assert.equal(await row.getAttribute("data-pressed"), "");
    const style = await row.evaluate(node => {
        const css = getComputedStyle(node);
        return { transform: css.transform, duration: css.transitionDuration, animations: node.getAnimations().length };
    });
    assert.deepEqual(style, { transform: "matrix(0.98, 0, 0, 0.98, 0, 0)", duration: "0s", animations: 0 });
}
