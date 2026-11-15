import assert from "node:assert/strict";
import type { Tv } from "./tv.ts";

/** Reads the rendered look and samples real CSS transitions without advancing app timers. */
export async function assertSelectLook(tv: Tv, key: string, expected: {
    focusScale: number; heldScale: number; opacity: number; focusMs: number; pressMs?: number; face?: string;
}): Promise<void> {
    const control = tv.page.locator(`[data-focus="${key}"]`);
    const handle = await control.elementHandle();
    assert.ok(handle !== null);
    await control.evaluate(node => {
        if (!(node instanceof HTMLElement)) throw new Error("control missing");
        node.blur();
        for (const animation of document.getAnimations()) animation.finish();
        void node.offsetWidth;
        node.dataset.testActivations = "0";
        node.addEventListener("click", () => { node.dataset.testActivations = String(Number(node.dataset.testActivations) + 1); });
        // Freeze each transition in the event's task, before a slow protocol round trip can finish it.
        node.addEventListener("keydown", () => {
            for (const animation of node.getAnimations()) animation.pause();
        }, { once: true });
        node.focus();
        for (const animation of node.getAnimations({ subtree: true })) animation.pause();
    });
    const focus = await control.evaluate((node, face) => {
        const target = face === undefined ? node : node.querySelector(face);
        if (target === null) throw new Error("focus face missing");
        const animations = target.getAnimations();
        const durations = animations.map(animation => Number(animation.effect?.getTiming().duration));
        for (const animation of document.getAnimations()) animation.finish();
        return { scale: new DOMMatrix(getComputedStyle(target).transform).a, opacity: getComputedStyle(node).opacity, durations };
    }, expected.face);
    assert.equal(focus.scale, expected.focusScale, "focused scale matches Apple");
    assert.equal(focus.opacity, "1");
    if (expected.focusMs > 0) assert.ok(focus.durations.includes(expected.focusMs), `focus durations ${focus.durations} include ${expected.focusMs}ms`);
    else assert.deepEqual(focus.durations, [], "reduced motion has no focus animation");

    await tv.page.keyboard.down("Enter");
    assert.equal(await control.getAttribute("data-pressed"), "");
    assert.equal(await handle.getAttribute("data-test-activations"), "0", "keydown waits for release");
    const held = await control.evaluate((node, face) => {
        const target = face === undefined ? node : node.querySelector(face);
        if (target === null) throw new Error("focus face missing");
        const opacityAnimation = node.getAnimations().find(animation => animation instanceof CSSTransition && animation.transitionProperty === "opacity");
        let midpoint: number | undefined;
        if (opacityAnimation !== undefined) {
            opacityAnimation.pause();
            opacityAnimation.currentTime = Number(opacityAnimation.effect?.getTiming().duration) / 2;
            midpoint = Number(getComputedStyle(node).opacity);
            opacityAnimation.finish();
        }
        const style = getComputedStyle(node);
        return { scale: new DOMMatrix(getComputedStyle(target).transform).a, opacity: Number(style.opacity),
            pressMs: Number(opacityAnimation?.effect?.getTiming().duration ?? 0), midpoint,
            easing: opacityAnimation?.effect?.getTiming().easing,
            transformAnimating: target.getAnimations().some(animation => animation instanceof CSSTransition && animation.transitionProperty === "transform") };
    }, expected.face);
    assert.equal(held.scale, expected.heldScale, "held scale matches Apple immediately");
    assert.equal(held.opacity, expected.opacity, "held opacity matches Apple");
    assert.equal(held.pressMs, expected.pressMs ?? 0, "only the primary button animates its press");
    assert.equal(held.transformAnimating, false, "press does not animate the focus scale");
    if (expected.pressMs) {
        assert.ok(Math.abs((held.midpoint ?? 0) - 0.9) < 0.001, `halfway opacity is ${held.midpoint}`);
        assert.equal(held.easing, "ease-in-out");
    }
    await tv.page.keyboard.up("Enter");
    assert.equal(await handle.getAttribute("data-test-activations"), "1", "release activates once");
    assert.equal(await handle.getAttribute("data-pressed"), null);
}
