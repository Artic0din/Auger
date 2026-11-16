import assert from "node:assert/strict";
import type { Locator } from "playwright";
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
        node.getBoundingClientRect();
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

export interface PressedExpectation {
    /** Layout scale of the control (or its `face`) when focused and at rest. */
    focusScale: number;
    heldScale: number;
    heldOpacity: number;
    /** A descendant that carries the scale, such as a card's artwork. */
    face?: string;
    /** The property Apple animates as Select goes down and comes up (0.12 s ease-out); absent where Apple snaps. */
    animates?: "scale" | "opacity";
}

/**
 * Holds Select on a focused control without releasing it, then ends the press with another key (as tvOS does when focus moves).
 * Layout scale is the transform times the individual `scale` property.
 */
export async function assertPressedLook(tv: Tv, control: Locator, expected: PressedExpectation, reduced: boolean): Promise<void> {
    const handle = await control.elementHandle();
    assert.ok(handle !== null);
    const read = (): Promise<{ scale: number; opacity: number; transitions: { property: string; duration: number; easing: string }[] }> =>
        control.evaluate((node, face) => {
            const target = face === undefined ? node : node.querySelector(face);
            if (target === null) throw new Error("scale face missing");
            const css = getComputedStyle(target);
            const individual = css.scale === "none" ? 1 : Number.parseFloat(css.scale);
            const transitions = [...node.getAnimations({ subtree: true })]
                .filter((animation): animation is CSSTransition => animation instanceof CSSTransition && ["scale", "transform", "opacity"].includes(animation.transitionProperty))
                .map(animation => ({ property: animation.transitionProperty, duration: Number(animation.effect?.getTiming().duration), easing: String(animation.effect?.getTiming().easing) }));
            return { scale: new DOMMatrix(css.transform).a * individual, opacity: Number(getComputedStyle(node).opacity), transitions };
        }, expected.face);
    const settle = (): Promise<void> => control.evaluate(node => { for (const animation of node.getAnimations({ subtree: true })) animation.finish(); node.getBoundingClientRect(); });
    const near = (actual: number, wanted: number, what: string): void => assert.ok(Math.abs(actual - wanted) < 1e-6, `${what}: ${actual}, wanted ${wanted}`);

    await control.evaluate(node => {
        node.blur();
        for (const animation of node.getAnimations({ subtree: true })) animation.finish();
        node.getBoundingClientRect();
        node.dataset.testActivations = "0";
        node.addEventListener("click", () => { node.dataset.testActivations = String(Number(node.dataset.testActivations) + 1); });
        node.focus();
    });
    await settle();
    const focused = await read();
    near(focused.scale, expected.focusScale, "focused scale");
    near(focused.opacity, 1, "focused opacity");

    await tv.page.keyboard.down("Enter");
    assert.equal(await control.getAttribute("data-pressed"), "");
    // Reduce Motion keeps the look and drops the animation.
    const press = expected.animates !== undefined && !reduced;
    const names = async (): Promise<string[]> => (await read()).transitions.map(transition => transition.property);
    const starting = await read();
    if (press) {
        assert.deepEqual(starting.transitions.map(transition => transition.property), [expected.animates], "only the press property animates");
        assert.equal(starting.transitions[0]?.duration, 120);
        assert.equal(starting.transitions[0]?.easing, "ease-out");
    } else assert.deepEqual(starting.transitions, [], "the press snaps");
    await settle();
    const held = await read();
    near(held.scale, expected.heldScale, "held scale");
    near(held.opacity, expected.heldOpacity, "held opacity");
    assert.equal(await handle.getAttribute("data-test-activations"), "0", "keydown waits for release");

    // Focus leaving the control ends the press without running it, as on tvOS.
    await control.evaluate(node => { (node as HTMLElement).blur(); });
    assert.equal(await control.getAttribute("data-pressed"), null);
    // Losing focus also ends the focus lift, so other properties may animate alongside.
    if (press) assert.ok((await names()).some(name => name === expected.animates), "the release animates too");
    await settle();
    await control.evaluate(node => { (node as HTMLElement).focus(); });
    await settle();
    const released = await read();
    near(released.scale, expected.focusScale, "released scale");
    near(released.opacity, 1, "released opacity");
    await tv.page.keyboard.up("Enter");
    assert.equal(await handle.getAttribute("data-test-activations"), "0", "a cancelled press runs nothing");
}
