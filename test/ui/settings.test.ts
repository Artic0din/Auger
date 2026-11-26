import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { decodeDiagnosticsReportHash, DIAGNOSTICS_RELAY_URL, DIAGNOSTICS_REPORT_URL } from "../../src/diagnostics.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { AUDIO_KEY, AUDIOBOOK_SEEK_BACK_KEY, HDR_KEY, HIDDEN_KEY, QUALITY_KEY, BITRATE_KEY, SEEK_BACK_KEY, SUBTITLE_LANGUAGE_KEY, SUBTITLE_MODE_KEY, SHOW_FORCED_KEY } from "../../src/contracts/v2/settings.ts";
import { fixture, problem } from "../native/support/fakeSilo.ts";
import { assertSignOutDialog } from "./support/signOutDialog.ts";
import { assertDisabledRowsFullBrightness } from "./support/disabledRows.ts";
import { focusSettingsRow, holdSettingsRow } from "./support/settingsRowPress.ts";
import { launchBrowser, openTv, pauseTvClock, readLive, type Tv } from "./support/tv.ts";

const DOLBY_VISION_KEY = "player.dolby_vision_enabled";
const SEEK_CACHE_KEY = "player.seek_cache_enabled";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function setup(devicePlayback = false, accountRole?: string | null) {
    const tv = await openTv(browser, { app: "browse", ...(process.env.SETTINGS_CAPTURE_DIR === undefined ? {} : { video: process.env.SETTINGS_CAPTURE_DIR }) });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.devicePlayback = devicePlayback;
    if (accountRole !== undefined) tv.fake.accountRole = accountRole;
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(async () => await tv.page.evaluate(() => window.browseHarness.loginPhase) === "signed_in", "sign in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount(true));
    await tv.page.locator('[data-view="home"]').waitFor();
    // Home reads title art and poster badges when it loads; let those settle before scripting settings replies.
    await tv.eventually(async () => ["keys=ui.title_art", "keys=ui.card_overlays"].every(key => tv.fake.requests.some(request => request.path.startsWith("/settings/values/effective?") && request.path.includes(key))), "Home settings reads");
    return { tv, settings };
}
async function openSettings(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').focus();
    await tv.page.keyboard.press("Enter");
    assert.equal(await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).count(), 1, "avatar menu exposes Settings");
    await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).waitFor();
}

// TVSettingsView.swift:514-517 (silo-apple 449ba47): a server with a name of its own shows its address on a second row (#773).
test("the Server pane adds Address under a server's own name (#773)", async () => {
    const { tv } = await setup();
    try {
        await tv.page.evaluate(() => window.browseHarness.seedServerName("Living room library"));
        await openSettings(tv);
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.locator(".settings-info-row").first().waitFor();
        const rows = await tv.page.locator(".settings-info-row").evaluateAll(nodes => nodes.map(row => [row.firstElementChild?.textContent, row.querySelector(".settings-row-value")?.textContent]));
        assert.deepEqual(rows.slice(0, 2), [["Server", "Living room library"], ["Address", "https://silo.example.test"]]);
    } finally { await tv.page.context().close(); }
});

test("Settings rail symbols match Apple's per-symbol ink boxes and medium strokes", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.keyboard.press("ArrowRight");
        await tv.jump(300);
        for (const [key, width, height] of [["general", 24, 24], ["playback", 26, 20], ["subtitles", 24, 22], ["server", 24, 20]] as const) {
            const icon = tv.page.locator(`[data-focus="${key}"] .settings-category-icon svg`);
            const encoded = (await icon.screenshot()).toString("base64");
            const ink = await tv.page.evaluate(async data => {
                const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
                const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
                const pixels = context.getImageData(0, 0, image.width, image.height).data;
                let left = image.width, right = -1, top = image.height, bottom = -1;
                for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
                    if ((pixels[(y * image.width + x) * 4] ?? 0) <= 150) continue;
                    left = Math.min(left, x); right = Math.max(right, x);
                    top = Math.min(top, y); bottom = Math.max(bottom, y);
                }
                return { width: right - left + 1, height: bottom - top + 1 };
            }, encoded);
            assert.ok(Math.abs(ink.width - width) <= 1 && Math.abs(ink.height - height) <= 1, `${key}: painted ${ink.width}×${ink.height}, expected approximately ${width}×${height}`);
            const stroke = await icon.evaluate(node => Number.parseFloat(getComputedStyle(node).strokeWidth) * Number.parseFloat(getComputedStyle(node).width) / (node as SVGSVGElement).viewBox.baseVal.width);
            assert.ok(stroke >= 1.7 && stroke <= 2, `${key}: medium stroke is 1.7–2px, got ${stroke}`);
        }
        const gear = tv.page.locator('[data-focus="general"] svg path');
        assert.match(await gear.getAttribute("d") ?? "", /^M9 3H15/);
        assert.equal(await tv.page.locator('.settings-category-icon').first().evaluate(node => getComputedStyle(node).width), "34px");
    } finally { await tv.page.context().close(); }
});

test("Settings rail subtitles stay regular and muted through focus changes", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const subtitle = tv.page.locator('[data-focus="general"] .settings-category-detail');
        const appearance = () => subtitle.evaluate(node => {
            const style = getComputedStyle(node);
            return { weight: style.fontWeight, size: style.fontSize, opacity: style.opacity, color: style.color };
        });
        assert.deepEqual(await appearance(), { weight: "400", size: "15.496px", opacity: "0.62", color: "rgb(0, 0, 0)" });
        await tv.page.keyboard.press("ArrowRight");
        assert.deepEqual(await appearance(), { weight: "400", size: "15.496px", opacity: "0.62", color: "rgb(237, 237, 237)" });
        await tv.page.keyboard.press("ArrowLeft");
        assert.deepEqual(await appearance(), { weight: "400", size: "15.496px", opacity: "0.62", color: "rgb(0, 0, 0)" });
    } finally { await tv.page.context().close(); }
});

test("Settings uses drawn semibold chevrons for profile and picker rows", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        for (const [key, height, opacity] of [["settings-profile", "17px", "0.5"], ["paired-profile", "18px", "0.55"], ["remember-profile", "18px", "0.55"]]) {
            const chevron = tv.page.locator(`[data-focus="${key}"] .settings-chevron`);
            assert.deepEqual(await chevron.evaluate(node => ({ tag: node.tagName, height: getComputedStyle(node).height, opacity: getComputedStyle(node).opacity, hidden: node.getAttribute("aria-hidden"), text: node.textContent })),
                { tag: "svg", height, opacity, hidden: "true", text: "" });
        }
    } finally { await tv.page.context().close(); }
});

test("Settings aligns Sign Out with Apple's category icon and text columns", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.keyboard.press("ArrowRight");
        await tv.jump(300);
        const columns = await tv.page.evaluate(() => {
            const category = document.querySelector('[data-focus="server"]')!;
            const signout = document.querySelector('[data-focus="settings-signout"]')!;
            const text = [...signout.childNodes].find(node => node.nodeType === Node.TEXT_NODE)!;
            const range = document.createRange(); range.selectNodeContents(text);
            return {
                rowLeft: signout.getBoundingClientRect().left - category.getBoundingClientRect().left,
                width: signout.getBoundingClientRect().width,
                iconLeft: signout.querySelector('.settings-signout-icon')!.getBoundingClientRect().left - category.querySelector('.settings-category-icon')!.getBoundingClientRect().left,
                textLeft: range.getBoundingClientRect().left - category.querySelector('.settings-category-title')!.getBoundingClientRect().left,
                padding: getComputedStyle(signout).paddingLeft,
            };
        });
        assert.deepEqual(columns, { rowLeft: 0, width: 490, iconLeft: 0, textLeft: 0, padding: "20px" });
    } finally { await tv.page.context().close(); }
});

test("Settings places Sign Out below Server with Apple's captured baseline gap", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        for (const height of [1080, 1200]) {
            await tv.page.setViewportSize({ width: 1920, height });
            const placement = await tv.page.evaluate(() => {
                const server = document.querySelector('[data-focus="server"]')!.getBoundingClientRect();
                const signoutNode = document.querySelector('[data-focus="settings-signout"]')!;
                const signout = signoutNode.getBoundingClientRect();
                const padding = Number.parseFloat(getComputedStyle(signoutNode).paddingTop);
                const version = document.querySelector('.settings-version')!.getBoundingClientRect();
                const title = document.querySelector('[data-focus="server"] .settings-category-title')!;
                const titleStyle = getComputedStyle(title);
                const style = getComputedStyle(signoutNode);
                const context = document.createElement("canvas").getContext("2d")!;
                const baseline = (top: number, lineHeight: number, font: CSSStyleDeclaration): number => {
                    context.font = `${font.fontWeight} ${font.fontSize} ${font.fontFamily}`;
                    const metrics = context.measureText("Server");
                    return top + (lineHeight - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 + metrics.fontBoundingBoxAscent;
                };
                const baselineGap = baseline(signout.top + padding, Number.parseFloat(style.lineHeight), style)
                    - baseline(title.getBoundingClientRect().top, Number.parseFloat(titleStyle.lineHeight), titleStyle);
                return { afterCategories: signout.top - server.bottom, contentAfterCategories: signout.top + padding - server.bottom, height: signout.height, versionGap: version.top - signout.bottom, baselineGap };
            });
            assert.ok(Math.abs(placement.baselineGap - 135) <= 2, `Server to Sign Out baseline gap at ${height}: ${placement.baselineGap}, expected about 135px`);
            const { baselineGap: _baselineGap, ...bounds } = placement;
            assert.deepEqual(bounds, { afterCategories: 50, contentAfterCategories: 65, height: 63, versionGap: 16 });
        }
    } finally { await tv.page.context().close(); }
});

test("Settings profile placeholder paints Apple's dark circle at rest and on focus", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        for (const focused of [false, true]) {
            if (focused) {
                await tv.page.locator('[data-focus="settings-profile"]').focus();
                await tv.jump(300);
            }
            const avatar = tv.page.locator('.settings-profile .navigation-avatar');
            const encoded = (await avatar.screenshot()).toString("base64");
            const pixel = await tv.page.evaluate(async data => {
                const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
                const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
                const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
                return [...context.getImageData(10, Math.floor(image.height / 2), 1, 1).data];
            }, encoded);
            assert.deepEqual(pixel, [14, 15, 18, 255], `filled circle ${focused ? "on focus" : "at rest"}`);
            assert.deepEqual(await avatar.evaluate(node => {
                const style = getComputedStyle(node);
                const fallback = node.querySelector('.navigation-avatar-fallback')!;
                return { width: style.width, height: style.height, radius: style.borderRadius, color: style.color, size: getComputedStyle(fallback).fontSize, weight: getComputedStyle(fallback).fontWeight, initial: fallback.textContent };
            }), { width: "68px", height: "68px", radius: "50%", color: "rgb(237, 237, 237)", size: "23.12px", weight: "600", initial: "L" });
        }
    } finally { await tv.page.context().close(); }
});

test("Settings Sign Out uses Apple's medium font, cap height and destructive colour", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const appearance = await tv.page.locator('[data-focus="settings-signout"]').evaluate(node => {
            const style = getComputedStyle(node);
            const canvas = document.createElement("canvas"); const context = canvas.getContext("2d")!;
            context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const metrics = context.measureText("Sign Out");
            return { size: Number.parseFloat(style.fontSize), weight: style.fontWeight, color: style.color, capHeight: context.measureText("H").actualBoundingBoxAscent, inkWidth: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight };
        });
        assert.ok(Math.abs(appearance.size - 27 * .9685) < .001, `27pt in the existing Inter/SF cap-height scale: ${appearance.size}`);
        assert.equal(appearance.weight, "500");
        assert.equal(appearance.color, "rgb(176, 0, 32)");
        assert.ok(Math.abs(appearance.capHeight - 27 * .7046) < 1, `Apple's cap height: ${appearance.capHeight}`);
        assert.ok(appearance.inkWidth < 105, `Sign Out ink should be smaller than the previous bold label: ${appearance.inkWidth}`);
    } finally { await tv.page.context().close(); }
});

test("the subtitle preview draws sans-serif in the bundled semibold face", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        const preview = tv.page.locator(".settings-pane .settings-subtitle-preview span");
        await preview.waitFor();
        const face = (): Promise<{ family: string; weight: string }> => preview.evaluate(node => {
            const style = getComputedStyle(node);
            return { family: style.fontFamily.replaceAll('"', ""), weight: style.fontWeight };
        });
        assert.deepEqual(await face(), { family: "Inter, sans-serif", weight: "600" });
        for (const [label, family] of [["Serif", "serif, sans-serif"], ["Monospace", "monospace, sans-serif"]] as const) {
            await tv.page.getByRole("button", { name: /Font Family/ }).click();
            await tv.page.getByRole("radio", { name: label, exact: true }).click();
            await tv.eventually(async () => (await face()).family === family, `${label} preview face`);
            assert.deepEqual(await face(), { family, weight: "600" });
        }
        // Selecting Drop Shadow scales the drop-shadow and outline offsets by the preview's 0.5 factor (#780).
        await tv.page.getByRole("button", { name: /Background Style/ }).click();
        await tv.page.getByRole("radio", { name: "Drop Shadow", exact: true }).click();
        await tv.eventually(async () => (await preview.evaluate(node => getComputedStyle(node).textShadow)).includes("0.75px 1px 1.5px"), "scaled preview drop shadow");
        const shadowOnly = await preview.evaluate(node => getComputedStyle(node).textShadow);
        assert.equal(shadowOnly, "rgba(0, 0, 0, 0.85) 0.75px 1px 1.5px");
        await tv.page.getByRole("switch", { name: /Text Outline/ }).click();
        await tv.eventually(async () => (await preview.evaluate(node => getComputedStyle(node).textShadow)).includes("0.87px"), "scaled preview outline + drop shadow");
        const outlineAndShadow = await preview.evaluate(node => getComputedStyle(node).textShadow);
        assert.ok(outlineAndShadow.includes("0.87px 0.87px 0px") && outlineAndShadow.includes("0.75px 1px 1.5px"), outlineAndShadow);
    } finally { await tv.page.context().close(); }
});

test("Settings pins its rail, resets pane scroll and keeps modal background geometry", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await pauseTvClock(tv);
        const rail = await tv.page.evaluate(() => {
            const first = document.querySelector<HTMLElement>('[data-focus="general"]')!;
            const second = document.querySelector<HTMLElement>('[data-focus="playback"]')!;
            for (const animation of first.getAnimations()) animation.finish();
            return { width: Number(first.getBoundingClientRect().width.toFixed(3)), height: Number(first.getBoundingClientRect().height.toFixed(3)), pitch: Number((second.getBoundingClientRect().top - first.getBoundingClientRect().top).toFixed(3)), icons: document.querySelectorAll('.settings-category-icon').length };
        });
        // The focused 490×82 row grows around its centre by Apple's 1.012.
        assert.deepEqual(rail, { width: 495.88, height: 82.984, pitch: 88.492, icons: 5 });
        const railDetails = await tv.page.evaluate(() => ({
            signOutIcon: document.querySelector('[data-focus="settings-signout"] svg') !== null,
            iconSize: getComputedStyle(document.querySelector('.settings-category-icon svg')!).width,
            profileGap: getComputedStyle(document.querySelector('.settings-profile')!).gap,
            versionTop: getComputedStyle(document.querySelector('.settings-version')!).marginTop,
        }));
        assert.deepEqual(railDetails, { signOutIcon: true, iconSize: "29.5px", profileGap: "18px", versionTop: "10px" });
        await tv.page.locator('[data-focus="subtitles"]').click();
        const appearance = await tv.page.evaluate(() => {
            const first = document.querySelector('[data-focus="appearance-fontSize"]')!.getBoundingClientRect();
            const second = document.querySelector('[data-focus="appearance-fontFamily"]')!.getBoundingClientRect();
            return { height: first.height, pitch: second.top - first.top,
                order: [...document.querySelectorAll('.settings-pane .settings-subtitle-preview, .settings-pane [data-focus^="appearance-"], .settings-pane [data-focus="reset-appearance"]')].map(node => node.getAttribute('data-focus') ?? 'preview') };
        });
        assert.equal(appearance.height, 66);
        assert.equal(appearance.pitch, 74);
        assert.deepEqual(appearance.order.slice(0, 3), ["preview", "appearance-device", "appearance-fontSize"]);
        const previewBox = await tv.page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>(".settings-pane");
            const preview = document.querySelector<HTMLElement>(".settings-subtitle-preview");
            if (pane === null || preview === null) return null;
            const previous = pane.style.maxHeight;
            pane.style.maxHeight = "320px";
            const box = preview.getBoundingClientRect();
            const style = getComputedStyle(preview);
            const result = {
                height: box.height,
                width: box.width,
                flexShrink: style.flexShrink,
                minHeight: style.minHeight,
                constrained: pane.scrollHeight > pane.clientHeight,
                direction: getComputedStyle(pane).flexDirection,
            };
            pane.style.maxHeight = previous;
            return result;
        });
        assert.deepEqual(previewBox, { height: 150, width: 958, flexShrink: "0", minHeight: "150px", constrained: true, direction: "column" });
        assert.equal(appearance.order.at(-1), "reset-appearance");
        assert.equal(await tv.page.locator('[data-focus="metadata-language"]').count(), 0, "metadata AI is unavailable");
        assert.equal(await tv.page.locator('[data-focus="appearance-textOutlineColor"] .settings-row-value').textContent(), "—");
        await tv.page.locator('[data-focus="appearance-position"]').focus();
        await tv.jump(300);
        const before = await tv.page.evaluate(() => ({ rail: document.querySelector('.settings-categories')!.getBoundingClientRect().top, header: document.querySelector('.settings-pane-header')!.getBoundingClientRect().top, top: document.querySelector('.settings-pane')!.scrollTop }));
        assert.ok(before.top > 0);
        await tv.page.locator('[data-focus="appearance-position"]').click();
        assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["Bottom", "Lower Third", "Top"]);
        assert.equal(await tv.page.getByText("Choose an option", { exact: true }).count(), 1);
        assert.equal(await tv.page.getByText("Menu to close", { exact: true }).count(), 1);
        // TVSettingsComponents.swift:713-724, 748-750 (#773): title and "Choose an option" 6 pt apart, 42 bold and 19 regular, the hint 17
        // medium, then a 1 pt siloChromeRestingBorder divider above the options, all times the cap scale.
        const header = await tv.page.evaluate(() => {
            const card = document.querySelector<HTMLElement>(".settings-modal[role=dialog]")!;
            const title = card.querySelector<HTMLElement>(".browse-title")!;
            const subtitle = card.querySelector<HTMLElement>(".settings-picker-subtitle")!;
            const hint = card.querySelector<HTMLElement>(".settings-picker-hint")!;
            const divider = card.querySelector<HTMLElement>(".settings-picker-divider")!;
            const options = card.querySelector<HTMLElement>(".settings-modal-options")!;
            const cap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--silo-sf-cap-scale"));
            const css = (node: HTMLElement): CSSStyleDeclaration => getComputedStyle(node);
            return {
                follows: title.nextElementSibling === subtitle,
                gap: Math.round(subtitle.getBoundingClientRect().top - title.getBoundingClientRect().bottom),
                sizes: [title, subtitle, hint].map(node => Math.round(parseFloat(css(node).fontSize) / cap * 100) / 100),
                weights: [css(title).fontWeight, css(subtitle).fontWeight, css(hint).fontWeight],
                divider: { height: divider.getBoundingClientRect().height, color: css(divider).backgroundColor, beforeOptions: divider.nextElementSibling === options },
            };
        });
        assert.deepEqual(header, { follows: true, gap: 6, sizes: [42, 19, 17], weights: ["700", "400", "500"], divider: { height: 1, color: "rgba(255, 255, 255, 0.09)", beforeOptions: true } });
        const during = await tv.page.evaluate(() => ({ rail: document.querySelector('.settings-categories')!.getBoundingClientRect().top, header: document.querySelector('.settings-pane-header')!.getBoundingClientRect().top }));
        assert.equal(during.rail, before.rail, JSON.stringify(await tv.page.evaluate(() => [...document.querySelectorAll(".settings, .settings-panes, .settings-pane, .settings-categories")].map(n => ({name: n.className, height: n.clientHeight, scroll: n.scrollTop, rect: n.getBoundingClientRect().toJSON(), style: getComputedStyle(n).overflowY})))));
        assert.equal(during.header, before.header);
        const save = tv.fake.hold("/settings/values/playback.subtitle_appearance", true);
        await tv.page.getByRole("radio", { name: "Top", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(request => request.method === "PUT" && request.path.includes("playback.subtitle_appearance")), "appearance save pending");
        const savingHeader = await tv.page.locator('.settings-pane-header').evaluate(node => node.getBoundingClientRect().top);
        save.release();
        assert.equal(savingHeader, before.header, "saving rerenders keep the background pane offset");
        await tv.page.getByRole("dialog").waitFor({ state: "detached" });
        await tv.page.locator('[data-focus="general"]').click();
        assert.equal(await tv.page.locator('.settings-pane').evaluate(node => node.scrollTop), 0);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator('.settings-pane').evaluate(node => node.scrollTop), 0, "returning to a category starts at the top too");
    } finally { await tv.page.context().close(); }
});

test("Settings rail rows animate focus and snap pressed until Select release opens the pane", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const row = tv.page.locator('[data-focus="playback"]');
        await focusSettingsRow(row);
        await holdSettingsRow(tv, row);
        assert.equal(await tv.focused(), "playback", "the rail waits for release");
        await tv.page.keyboard.up("Enter");
        await tv.eventually(async () => await tv.focused() === "quality", "release opens the pane");
    } finally { await tv.page.context().close(); }
});

test("Settings pane rows snap on press and cancellation, then open on Select release", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const row = tv.page.locator('[data-focus="quality"]');
        await focusSettingsRow(row);
        await holdSettingsRow(tv, row);
        assert.equal(await tv.page.getByRole("radio").count(), 0, "holding does not open the picker");
        await tv.page.keyboard.press("Shift");
        assert.equal(await row.getAttribute("data-pressed"), null);
        assert.deepEqual(await row.evaluate(node => ({ transform: getComputedStyle(node).transform, animations: node.getAnimations().length })),
            { transform: "matrix(1.012, 0, 0, 1.012, 0, 0)", animations: 0 }, "ending a press snaps back without animating");
        await tv.page.keyboard.up("Enter");
        assert.equal(await tv.page.getByRole("radio").count(), 0, "the cancelled release does not run");
        await holdSettingsRow(tv, row);
        await tv.page.keyboard.up("Enter");
        await tv.page.getByRole("radio").first().waitFor();
    } finally { await tv.page.context().close(); }
});

test("Acknowledgements Done uses Settings row focus and pressed motion and closes on release", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.locator('[data-focus="acknowledgements"]').click();
        const row = tv.page.locator('[data-focus="done"]');
        await focusSettingsRow(row);
        await holdSettingsRow(tv, row);
        assert.equal(await tv.page.locator(".acknowledgements-panel").count(), 1);
        await tv.page.keyboard.up("Enter");
        await tv.page.locator(".acknowledgements-panel").waitFor({ state: "detached" });
        assert.equal(await tv.focused(), "acknowledgements");
    } finally { await tv.page.context().close(); }
});

test("remaining settings expose only honoured rows and save profile appearance", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    tv.fake.script("/capabilities/metadata-ai", { status: 200, body: { revision: "test", allowed: true, state: "available", on_view: "button" } });
    try {
        await openSettings(tv);
        assert.equal(await tv.page.getByRole("button", { name: /Poster Size/ }).count(), 1, "Poster Size row is available");
        await tv.page.getByRole("button", { name: /Poster Size/ }).click();
        await tv.page.getByRole("radio", { name: "Large", exact: true }).click();
        await tv.page.locator('[data-focus="poster-size"]').waitFor();
        assert.deepEqual(settings.device("p-owner", "client:tv").get("ui.card_presentation"), { poster_size: "large", caption: "title_metadata" });
        const posterWrite = tv.fake.requests.find(request => request.method === "PUT" && request.path.includes("ui.card_presentation"));
        assert.equal(posterWrite?.path, "/settings/values/ui.card_presentation?scope=profile_client");
        assert.equal(posterWrite?.headers["x-silo-client-family"], "tv");
        await tv.page.getByRole("switch", { name: "Show Advisory Age", exact: true }).click();
        await tv.eventually(async () => settings.profile().get("catalog.show_advisory_age") === true, "advisory profile write");
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.getByRole("button", { name: /Auto-Play Next Episode/ }).click();
        await tv.page.getByRole("radio", { name: "Off", exact: true }).click();
        await tv.page.locator('[data-focus="auto-next"]').waitFor();
        assert.equal(tv.fake.requests.find(request => request.method === "PUT" && request.path.includes("auto_play_next"))?.path, "/settings/values/playback.auto_play_next?scope=profile_device");
        assert.equal(settings.profile().has("playback.auto_play_next"), false);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: /Font Size/ }).click();
        await tv.page.getByRole("radio", { name: "Small", exact: true }).click();
        await tv.eventually(async () => JSON.stringify(settings.profile().get("playback.subtitle_appearance"))?.includes('"fontSize":"small"') === true, "appearance profile write");
        await tv.page.locator('[data-focus="appearance-fontSize"]').waitFor();
        const caption = await tv.page.locator(".settings-subtitle-preview span").evaluate(node => {
            const element = node as HTMLElement;
            return { fontSize: element.style.fontSize, align: getComputedStyle(element).textAlign, weight: getComputedStyle(element).fontWeight };
        });
        // Small's 43 pt at the preview's half size, times the cap scale for the bundled sans-serif (#789).
        assert.deepEqual(caption, { fontSize: "calc(21.5px * var(--silo-sf-cap-scale))", align: "center", weight: "600" });
        const previewLook = () => tv.page.locator(".settings-subtitle-preview").evaluate(node => {
            const box = node.getBoundingClientRect();
            const text = node.querySelector("span") as HTMLElement;
            const rect = text.getBoundingClientRect();
            const style = getComputedStyle(node);
            const textStyle = getComputedStyle(text);
            return {
                gradient: style.backgroundImage,
                border: style.borderTopWidth,
                radius: style.borderTopLeftRadius,
                padding: textStyle.padding,
                textRadius: textStyle.borderTopLeftRadius,
                centred: Math.abs((rect.left + rect.right) / 2 - (box.left + box.right) / 2) < 1,
                hugsText: rect.width < box.width / 2,
                bottomGap: Math.round(box.bottom - rect.bottom),
            };
        });
        assert.deepEqual(await previewLook(), {
            gradient: "linear-gradient(98.9deg, rgb(82, 82, 82), rgb(15, 15, 15))",
            border: "0px",
            radius: "18px",
            padding: "4px 10px",
            textRadius: "4px",
            centred: true,
            hugsText: true,
            bottomGap: 12,
        });
        assert.equal(await tv.page.locator(".settings-subtitle-preview span").evaluate(node => getComputedStyle(node).lineHeight), "24.9873px", "the line scales with the Small preview size (25.8 px times the cap scale)");
        await tv.page.getByRole("button", { name: /Position/ }).click();
        await tv.page.getByRole("radio", { name: "Lower Third", exact: true }).click();
        await tv.page.locator('[data-focus="appearance-position"]').waitFor();
        assert.equal((await previewLook()).bottomGap, 33);
        await tv.page.getByRole("button", { name: /Position/ }).click();
        await tv.page.getByRole("radio", { name: "Top", exact: true }).click();
        await tv.page.locator('[data-focus="appearance-position"]').waitFor();
        assert.equal(await tv.page.locator(".settings-subtitle-preview").evaluate(node => Math.round((node.querySelector("span") as Element).getBoundingClientRect().top - node.getBoundingClientRect().top)), 12);
        await tv.page.getByRole("button", { name: /Position/ }).click();
        await tv.page.getByRole("radio", { name: "Bottom", exact: true }).click();
        await tv.page.locator('[data-focus="appearance-position"]').waitFor();
        const deviceId = tv.fake.requests.find(request => request.path === "/settings/contract/capabilities")?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).click();
        await tv.eventually(async () => settings.device("p-owner", deviceId).has("playback.subtitle_appearance"), "device appearance copied");
        await tv.page.getByRole("button", { name: /Font Color/ }).click();
        await tv.page.getByRole("radio", { name: "Red", exact: true }).click();
        await tv.eventually(async () => JSON.stringify(settings.device("p-owner", deviceId).get("playback.subtitle_appearance"))?.includes('"fontColor":"#ef4444"') === true, "device appearance write");
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        await tv.page.locator('[data-focus="appearance-fontColor"]').waitFor();
        await tv.page.getByRole("button", { name: /Font Color/ }).click();
        await tv.remote(10009);
        await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).click();
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).getAttribute("aria-checked") === "false", "profile appearance restored");
        assert.equal(await tv.page.getByRole("alert").count(), 0, "device reset is confirmed at the deleted scope");
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).click();
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).getAttribute("aria-checked") === "true", "device override enabled again");
        await tv.page.getByRole("button", { name: "Reset Appearance", exact: true }).click();
        await tv.page.getByRole("button", { name: "Reset", exact: true }).click();
        await tv.page.locator('[data-focus="reset-appearance"]').waitFor();
        assert.equal(JSON.stringify(settings.device("p-owner", deviceId).get("playback.subtitle_appearance")).includes('"fontSize":"large"'), true);
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        await tv.page.getByRole("button", { name: /Metadata Language/ }).click();
        await tv.page.getByRole("radio", { name: "fr", exact: true }).click();
        await tv.eventually(async () => settings.profile().get("catalog.metadata_language") === "fr", "metadata profile write");
        await tv.page.locator('[data-focus="metadata-language"]').waitFor();
        // TVSubtitleSettingsView.swift:101: the Metadata Language row's footer (#773).
        assert.equal(await tv.page.locator('[data-focus="metadata-language"] + .settings-value').textContent(), "Translates descriptions and taglines into your preferred language when available. Titles are never translated.");
        await tv.page.locator('[data-focus="server"]').click();
        // TVSettingsView.swift:514-517: Address shows only when the server's name is not its URL (#773).
        await tv.page.locator(".settings-info-row").first().waitFor();
        assert.equal(await tv.page.getByText("Address", { exact: true }).count(), 0, "with no server name the Server row already shows the URL");
        await tv.page.getByRole("button", { name: "Privacy Policy", exact: true }).click();
        assert.equal(await tv.page.getByRole("img", { name: "Privacy Policy QR code" }).count(), 1);
        assert.equal(await tv.page.getByRole("button", { name: /HDR|Dolby Vision|Lossless|Seek Cache/ }).count(), 0);
        assert.equal(await tv.page.locator(".settings-hdr-footer").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("revision 25 subtitle rows and Show Next Up stay available without incidental writes", async () => {
    const { tv, settings } = await setup(true);
    settings.revision = 25;
    settings.profileSubtitles = true;
    const contract = fixture("settings_contract_ok");
    const definitions = [
        { key: SUBTITLE_MODE_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: ["profile"], value_schema: { type: "enum", values: [{ value: "auto", label: "Auto" }, { value: "always", label: "Always" }, { value: "off", label: "Off" }] }, default_value: "auto", recommended_control: "select" },
        { key: SHOW_FORCED_KEY, introduced_in: 1, persistence: "remote", allowed_scopes: ["profile"], value_schema: { type: "boolean" }, default_value: true, recommended_control: "switch" },
        { key: "playback.next_up_prompt_seconds", introduced_in: 1, persistence: "remote", allowed_scopes: ["profile", "profile_device"], value_schema: { type: "integer", minimum: 0, maximum: 120 }, default_value: 30, recommended_control: "slider" },
    ];
    tv.fake.script("/settings/contract", { status: 200, body: { ...contract, revision: 25, definitions: [...contract.definitions as object[], ...definitions] } });
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator('[data-focus="subtitle-mode"]').count(), 1);
        assert.equal(await tv.page.getByRole("switch", { name: "Show Forced Subtitles", exact: true }).count(), 1);
        await tv.page.locator('[data-focus="playback"]').click();
        assert.equal(await tv.page.locator('[data-focus="next-up"]').count(), 1);
        const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        assert.equal(settings.device("p-owner", deviceId).has("playback.next_up_prompt_seconds"), false);
        assert.equal(settings.profile().has("playback.next_up_prompt_seconds"), false);
        assert.equal(await tv.page.getByRole("alert").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Show Next Up follows Apple episode order, timing choices and profile inheritance", async () => {
    const { tv, settings } = await setup(true);
    settings.remainingRows = true;
    settings.profile().set("playback.next_up_prompt_seconds", 30);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const episodeRows = await tv.page.locator('.settings-pane [data-focus]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")).filter(id => ["auto-next", "next-up", "skip-intros", "skip-credits"].includes(id ?? "")));
        assert.deepEqual(episodeRows, ["auto-next", "next-up", "skip-intros", "skip-credits"]);
        await tv.page.locator('[data-focus="next-up"]').click();
        assert.deepEqual(await tv.page.locator('.settings-modal button').allTextContents(), ["Use Profile Setting", "At end", "10 seconds before end", "30 seconds before end", "1 minute before end", "2 minutes before end"]);
        assert.equal(await tv.page.locator('[data-focus="reset-row"]').getAttribute("aria-checked"), "true");
        const reads = tv.fake.requests.length;
        await tv.remote(40);
        assert.equal(tv.fake.requests.length, reads);
        await tv.page.getByRole("radio", { name: "1 minute before end", exact: true }).click();
        await tv.page.locator('[data-focus="next-up"]').waitFor();
        const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        assert.equal(settings.device("p-owner", deviceId).get("playback.next_up_prompt_seconds"), 60);
        assert.equal(settings.profile().get("playback.next_up_prompt_seconds"), 30);
        await tv.page.locator('[data-focus="next-up"]').click();
        await tv.page.getByRole("button", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="next-up"]').waitFor();
        assert.equal(settings.device("p-owner", deviceId).has("playback.next_up_prompt_seconds"), false);
        assert.match(await tv.page.locator('[data-focus="next-up"]').innerText(), /30 seconds before end/);
        assert.equal(await tv.focused(), "next-up");
    } finally { await tv.page.context().close(); }
});

for (const failFirst of [false, true]) test(`Playback profile reset confirms and clears device overrides with retry=${failFirst}`, async () => {
    const { tv, settings } = await setup(true);
    settings.profile().set(QUALITY_KEY, "720p");
    const deviceId = tv.fake.requests.find(request => request.headers['x-silo-device-id'])?.headers['x-silo-device-id'];
    assert.ok(deviceId);
    const device = settings.device('p-owner', deviceId);
    device.set(QUALITY_KEY, "1080p");
    device.set(BITRATE_KEY, 1500);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.getByRole('button', { name: 'Use Profile Settings', exact: true }).click();
        const alertDialog = tv.page.getByRole('alertdialog');
        await alertDialog.waitFor();
        assert.equal(await tv.page.locator('.dialog-behind-dimmed').count(), 1);
        assert.equal(await tv.focused(), 'cancel-playback-reset');
        await tv.remote(38);
        assert.equal(await tv.focused(), 'confirm-playback-reset');
        assert.equal(await alertDialog.getByRole('button', { name: 'Use Profile Settings', exact: true }).count(), 1);
        await tv.remote(40);
        assert.equal(await tv.focused(), 'cancel-playback-reset');
        const playbackLayout = await tv.page.evaluate(() => {
            const confirm = document.querySelector('[data-focus="confirm-playback-reset"]');
            const cancel = document.querySelector('[data-focus="cancel-playback-reset"]');
            if (confirm === null || cancel === null) return null;
            return {
                confirmTop: confirm.getBoundingClientRect().top,
                cancelTop: cancel.getBoundingClientRect().top,
                confirmColor: getComputedStyle(confirm).color,
                destructive: confirm.classList.contains('skyline-destructive'),
            };
        });
        assert.ok(playbackLayout !== null && playbackLayout.confirmTop < playbackLayout.cancelTop);
        assert.equal(playbackLayout.destructive, true);
        assert.equal(playbackLayout.confirmColor, 'rgb(255, 69, 58)');
        await tv.remote(10009);
        assert.equal(device.get(QUALITY_KEY), '1080p');
        await tv.page.getByRole('button', { name: 'Use Profile Settings', exact: true }).click();
        if (failFirst) tv.fake.script(`/settings/values/${QUALITY_KEY}?scope=profile_device`, problem(503, 'unavailable', 'Try again'));
        await tv.remote(38);
        await tv.page.keyboard.press("Enter");
        if (failFirst) {
            await alertDialog.getByRole('button', { name: 'Check and retry', exact: true }).waitFor();
            assert.equal(await tv.page.locator('[data-focus="confirm-playback-reset"]').getAttribute('aria-disabled'), 'true');
            const alertErrorColor = await alertDialog.locator('[role="alert"]').evaluate(node => getComputedStyle(node).color);
            assert.equal(alertErrorColor, 'rgb(255, 105, 97)');
            await tv.remote(40);
            assert.equal(await tv.focused(), 'cancel-playback-reset');
            await tv.remote(40);
            assert.equal(await tv.focused(), 'retry');
            await tv.remote(38);
            assert.equal(await tv.focused(), 'cancel-playback-reset');
            await tv.remote(38);
            assert.equal(await tv.focused(), 'cancel-playback-reset', 'skipDisabled keeps Up off disabled destructive confirm button');
            await tv.remote(40);
            assert.equal(await tv.focused(), 'retry');
            await tv.jump(5000);
            await tv.page.keyboard.press("Enter");
        }
        await tv.eventually(async () => !device.has(QUALITY_KEY) && !device.has(BITRATE_KEY), 'device playback reset');
        assert.equal(settings.profile().get(QUALITY_KEY), '720p');
        assert.ok(tv.fake.requests.filter(r => r.method === 'DELETE').every(r => r.path.includes('scope=profile_device')));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Playback reset alert grows for long wrapped button labels without vertical clipping", async () => {
    const { tv, settings } = await setup(true);
    settings.device('p-owner', tv.fake.requests.find(r => r.headers['x-silo-device-id'])!.headers['x-silo-device-id']!).set(QUALITY_KEY, "1080p");
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.getByRole('button', { name: 'Use Profile Settings', exact: true }).click();
        const fit = await tv.page.locator('[data-focus="confirm-playback-reset"]').evaluate(node => {
            node.textContent = "Використовувати налаштування профілю";
            const style = getComputedStyle(node);
            return { clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, minHeight: style.minHeight };
        });
        assert.equal(fit.minHeight, "66px");
        assert.ok(fit.scrollHeight <= fit.clientHeight, JSON.stringify(fit));
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Subtitle appearance reset uses centred alert dialog for profile and device scopes with retry", async () => {
    const { tv, settings } = await setup(true);
    settings.remainingRows = true;
    settings.profile().set("playback.subtitle_appearance", { fontSize: "small", position: "bottom" });
    const deviceId = tv.fake.requests.find(request => request.headers['x-silo-device-id'])?.headers['x-silo-device-id'];
    assert.ok(deviceId);
    let held: { release(): void } | undefined;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: "Reset Appearance", exact: true }).click();
        const alertDialog = tv.page.getByRole("alertdialog");
        await alertDialog.waitFor();
        assert.equal(await tv.page.locator(".dialog-behind-dimmed").count(), 1);
        assert.equal(await tv.focused(), "cancel");
        assert.equal(await alertDialog.getByText("Reset Appearance?", { exact: true }).count(), 1);
        assert.equal(await alertDialog.getByText("This restores this profile's subtitle appearance to the defaults on all devices.", { exact: true }).count(), 1);
        const appearanceLayout = await tv.page.evaluate(() => {
            const confirm = document.querySelector('[data-focus="reset"]');
            const cancel = document.querySelector('[data-focus="cancel"]');
            if (confirm === null || cancel === null) return null;
            return {
                confirmTop: confirm.getBoundingClientRect().top,
                cancelTop: cancel.getBoundingClientRect().top,
                confirmColor: getComputedStyle(confirm).color,
                destructive: confirm.classList.contains("skyline-destructive"),
            };
        });
        assert.ok(appearanceLayout !== null && appearanceLayout.confirmTop < appearanceLayout.cancelTop);
        assert.equal(appearanceLayout.destructive, true);
        assert.equal(appearanceLayout.confirmColor, "rgb(255, 69, 58)");
        await tv.remote(10009);
        assert.equal(await alertDialog.count(), 0);
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).click();
        await tv.eventually(async () => await tv.page.getByRole("switch", { name: "Only on This TV", exact: true }).getAttribute("aria-checked") === "true", "device override enabled");
        await tv.page.getByRole("button", { name: "Reset Appearance", exact: true }).click();
        await alertDialog.waitFor();
        assert.equal(await alertDialog.getByText("This restores this TV's subtitle appearance to the defaults.", { exact: true }).count(), 1);
        tv.fake.script(`/settings/values/playback.subtitle_appearance?scope=profile_device`, problem(503, "unavailable", "Try again"));
        held = tv.fake.hold("/settings/values/playback.subtitle_appearance", true);
        await tv.remote(38);
        assert.equal(await tv.focused(), "reset");
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.locator('[data-focus="cancel"]').getAttribute("aria-disabled") === "true", "Cancel disabled while reset is in flight");
        assert.equal(await alertDialog.getByRole("status").textContent(), "Saving…");
        await tv.remote(10009);
        assert.equal(await alertDialog.count(), 1, "Back is ignored while appearance reset is in flight");
        held.release();
        await alertDialog.getByRole("button", { name: "Check and retry", exact: true }).waitFor();
        assert.equal(await alertDialog.locator('[role="alert"]').evaluate(node => getComputedStyle(node).color), "rgb(255, 105, 97)");
        await tv.remote(40);
        await tv.remote(40);
        assert.equal(await tv.focused(), "retry");
        await tv.jump(5000);
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-focus="reset-appearance"]').waitFor();
        assert.equal(await alertDialog.count(), 0);
        assert.equal(await tv.focused(), "reset-appearance");
        assert.equal(JSON.stringify(settings.device("p-owner", deviceId).get("playback.subtitle_appearance")).includes('"fontSize":"large"'), true);
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "small", position: "bottom" });
        assert.deepEqual(tv.console, []);
    } finally { held?.release(); await tv.page.context().close(); }
});

test("Playback reset alert shows Saving status in flight and clears stale reset queue after Reload settings", async () => {
    const { tv, settings } = await setup(true);
    settings.bufferingRows = true;
    settings.profile().set(QUALITY_KEY, "720p");
    const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
    assert.ok(deviceId);
    const device = settings.device("p-owner", deviceId);
    device.set(QUALITY_KEY, "1080p");
    device.set("playback.buffering_quality_mode", "never");
    let held: { release(): void } | undefined;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.getByRole("button", { name: "Use Profile Settings", exact: true }).click();
        const alertDialog = tv.page.getByRole("alertdialog");
        await alertDialog.waitFor();
        tv.fake.script(`/settings/values/${QUALITY_KEY}?scope=profile_device`, problem(403, "forbidden", "Denied"));
        held = tv.fake.hold(`/settings/values/${QUALITY_KEY}`, true);
        await tv.remote(38);
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => await tv.page.locator('[data-focus="cancel-playback-reset"]').getAttribute("aria-disabled") === "true", "Cancel disabled while playback reset is in flight");
        assert.equal(await alertDialog.getByRole("status").textContent(), "Saving…");
        held.release();
        await alertDialog.getByRole("button", { name: "Reload settings", exact: true }).waitFor();

        // Scope changes on the server before Reload settings: QUALITY_KEY becomes profile-only, while buffering remains profile_device.
        settings.devicePlayback = false;
        await alertDialog.getByRole("button", { name: "Reload settings", exact: true }).click();
        await tv.eventually(async () => await alertDialog.getByRole("button", { name: "Reload settings", exact: true }).count() === 0, "reload completed");

        const requestsBefore = tv.fake.requests.length;
        await alertDialog.getByRole("button", { name: "Use Profile Settings", exact: true }).click();
        await tv.eventually(async () => !device.has("playback.buffering_quality_mode"), "remaining device override cleared");
        const newDeletes = tv.fake.requests.slice(requestsBefore).filter(r => r.method === "DELETE").map(r => r.path);
        assert.equal(newDeletes.some(path => path.includes(QUALITY_KEY)), false, `unexpected delete for ${QUALITY_KEY}: ${newDeletes.join(", ")}`);
        assert.equal(settings.profile().get(QUALITY_KEY), "720p");
        assert.deepEqual(tv.console, []);
    } finally { held?.release(); await tv.page.context().close(); }
});

test("Subtitles warns on low legibility below the preview and previews Font Family on focus", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator(".settings-low-legibility").count(), 0);

        await tv.page.getByRole("button", { name: /Background Style/ }).click();
        await tv.page.getByRole("radio", { name: "Drop Shadow", exact: true }).click();
        await tv.page.getByRole("button", { name: /Font Color/ }).click();
        await tv.page.getByRole("radio", { name: "Black", exact: true }).click();
        const warning = tv.page.locator(".settings-low-legibility");
        await warning.waitFor();
        assert.equal(await warning.textContent(), "Low legibility — very transparent or dark text without a box or outline can be hard to read.");
        const ordered = await tv.page.evaluate(() => {
            const preview = document.querySelector(".settings-pane .settings-subtitle-preview");
            const footer = document.querySelector(".settings-pane .settings-low-legibility");
            const toggle = document.querySelector('[data-focus="appearance-device"]');
            const follows = (a: Element | null, b: Element | null): boolean => Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
            return follows(preview, footer) && follows(footer, toggle);
        });
        assert.equal(ordered, true);

        await tv.page.getByRole("button", { name: /Background Style/ }).click();
        await tv.page.getByRole("radio", { name: "Box", exact: true }).click();
        await warning.waitFor({ state: "detached" });

        await tv.page.getByRole("button", { name: /Text Opacity/ }).click();
        await tv.page.getByRole("radio", { name: "25%", exact: true }).click();
        await warning.waitFor();
        await tv.page.getByRole("button", { name: /Text Opacity/ }).click();
        await tv.page.getByRole("radio", { name: "100%", exact: true }).click();
        await warning.waitFor({ state: "detached" });

        const requestsBefore = tv.fake.requests.length;
        await tv.page.getByRole("button", { name: /Font Family/ }).click();
        const dialog = tv.page.getByRole("dialog", { name: "Font Family" });
        await dialog.waitFor();
        assert.equal(await dialog.locator(".settings-subtitle-preview").count(), 1);
        assert.deepEqual(await dialog.getByRole("radio").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label"))), ["Sans-serif", "Serif", "Monospace"]);
        assert.deepEqual(await dialog.locator(".settings-font-sample").allTextContents(), ["Subtitle sample", "Subtitle sample", "Subtitle sample"]);
        assert.deepEqual(await dialog.locator(".settings-font-sample").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).style.fontFamily)), ["Inter, sans-serif", "serif, sans-serif", "monospace, sans-serif"]);
        const previewFont = (): Promise<string> => dialog.locator(".settings-subtitle-preview span").evaluate(node => (node as HTMLElement).style.fontFamily);
        assert.equal(await previewFont(), "Inter, sans-serif");
        await tv.remote(40);
        assert.equal(await tv.focused(), "choice:serif");
        assert.equal(await previewFont(), "serif, sans-serif");
        await tv.remote(40);
        assert.equal(await tv.focused(), "choice:monospace");
        assert.equal(await previewFont(), "monospace, sans-serif");
        assert.equal(tv.fake.requests.length, requestsBefore, "moving focus in Font Family issues zero network requests");
        await tv.remote(10009);
        await dialog.waitFor({ state: "detached" });
        assert.equal(await tv.focused(), "appearance-fontFamily");
        assert.equal(await tv.page.locator(".settings-pane .settings-subtitle-preview span").evaluate(node => (node as HTMLElement).style.fontFamily), "Inter, sans-serif");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("measured Settings pickers centre the selected choice and privacy handoff", async () => {
    const { tv, settings } = await setup(true);
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="remember-profile"]').click();
        assert.equal(await tv.page.getByRole("dialog").count(), 1);
        assert.equal(await tv.page.getByRole("radio", { checked: true }).evaluate(node => node === document.activeElement), true);
        assert.equal(await tv.page.getByRole("dialog").getByText("Show Who's Watching whenever you return to Auger.", { exact: true }).count(), 1);
        assert.equal(await tv.page.locator('.settings-checkmark').count(), 1);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "remember-profile");
        assert.equal(await tv.page.locator('[data-focus="settings-back"]').count(), 0);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        assert.equal(await tv.page.locator('.settings-modal [data-focus]').first().getAttribute("data-focus"), "reset");
        assert.equal(await tv.focused(), "reset");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.locator('[data-focus="privacy"]').click();
        assert.equal(await tv.page.getByRole("dialog").count(), 1);
        assert.equal(await tv.focused(), "back", "Privacy Done keeps initial focus inside the text column");
        assert.equal(await tv.page.locator('.settings-privacy-copy [data-focus="back"]').count(), 1);
        const hand = await tv.page.locator('.settings-privacy-copy > svg path').evaluate(node => {
            const bounds = (node as SVGGraphicsElement).getBBox();
            return { y: bounds.y, height: bounds.height };
        });
        assert.ok(hand.y >= 0 && hand.y + hand.height <= 24, "the hand stays inside its icon viewBox");
        assert.equal(await tv.page.getByText("Scan this code with your phone or tablet to read Silo's privacy policy.", { exact: true }).count(), 1);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "privacy");
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: /Text Opacity/ }).click();
        const selected = tv.page.getByRole("radio", { name: "100%", exact: true });
        const inList = async (): Promise<boolean> => selected.evaluate(node => {
            const list = node.closest(".settings-modal-options");
            if (list === null) return false;
            const bounds = node.getBoundingClientRect();
            const viewport = list.getBoundingClientRect();
            return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
        });
        await tv.jump(250);
        assert.equal(await inList(), true, "selected option opens inside its scroll viewport");
        for (let index = 0; index < 19; index++) await tv.remote(38);
        for (let index = 0; index < 19; index++) await tv.remote(40);
        await tv.jump(250);
        assert.equal(await tv.focused(), "choice:100");
        assert.equal(await inList(), true, "remote movement reveals the last option");
    } finally { await tv.page.context().close(); }
});

test("a settling poster save preserves navigation after leaving its picker", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    const held = tv.fake.hold("/settings/values/ui.card_presentation", true);
    try {
        await openSettings(tv);
        await tv.page.getByRole("button", { name: /Poster Size/ }).click();
        await tv.page.getByRole("radio", { name: "Large", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(request => request.method === "PUT" && request.path.includes("ui.card_presentation")), "poster save waiting");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="server"]').click();
        await tv.page.locator('[data-focus="privacy"]').focus();
        const pane = await tv.page.locator(".settings-pane").elementHandle();
        held.release();
        await tv.eventually(async () => settings.device("p-owner", "client:tv").has("ui.card_presentation"), "poster save settled");
        await tv.page.getByRole("status").waitFor({ state: "detached" });
        await tv.page.waitForFunction(node => node !== null && !node.isConnected, pane);
        await tv.jump(0);
        assert.equal(await tv.focused(), "privacy");
    } finally { held.release(); await tv.page.context().close(); }
});

test("appearance edits reject an intervening change instead of replacing unrelated fields", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    settings.profile().set("playback.subtitle_appearance", { fontSize: "small" });
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: /Font Color/ }).click();
        settings.profile().set("playback.subtitle_appearance", { fontSize: "large" });
        await tv.page.getByRole("radio", { name: "Red", exact: true }).click();
        await tv.page.getByRole("alert").filter({ hasText: "The setting changed on another device." }).waitFor();
        assert.deepEqual(settings.profile().get("playback.subtitle_appearance"), { fontSize: "large" });
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT" && request.path.includes("subtitle_appearance")).length, 0);
    } finally { await tv.page.context().close(); }
});

test("poster controls are omitted and Server Support is shown when the server cannot support synced interface settings", async () => {
    for (const missing of ["revision", "family", "batch", "shortcuts", "scope"] as const) {
        const { tv, settings } = await setup();
        settings.remainingRows = true;
        if (missing === "revision") settings.revision = 4;
        if (missing === "family") settings.clientFamilies = [];
        if (missing === "batch") settings.supportsBatchedEffective = false;
        if (missing === "shortcuts") settings.supportsAtomicShortcuts = false;
        if (missing === "scope") settings.scopes = ["profile", "profile_device"];
        try {
            if (missing === "revision") {
                await tv.page.locator('[data-focus="profiles"]').focus();
                await tv.page.keyboard.press("Enter");
                await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
                await tv.page.getByText("SERVER SUPPORT", { exact: true }).waitFor();
            } else {
                await openSettings(tv);
            }
            assert.equal(await tv.page.locator('[data-focus="poster-size"]').count(), 0);
            const headers = await tv.page.locator(".settings-pane .settings-section-header").allTextContents();
            assert.ok(headers.includes("SERVER SUPPORT"), missing);
            assert.ok(headers.indexOf("SERVER SUPPORT") < headers.indexOf("CARDS & POSTERS"), JSON.stringify(headers));
            await tv.page.getByText("Update this Silo server to use synced interface settings.", { exact: true }).waitFor();
            await tv.page.locator('[data-focus="playback"]').click();
            await tv.page.locator('[data-focus="quality"]').waitFor();
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    }
});

test("Show Advisory Age controls the detail badge when the server supplies an age", async () => {
    for (const enabled of [false, true]) {
        const { tv, settings } = await setup();
        settings.profile().set("catalog.show_advisory_age", enabled);
        await tv.page.route("**/catalog/items/movie%3Am0001*", async route => { await route.fulfill({ status: 200, json: { ...fixture("get_catalog_item_ok"), content_id: "movie:m0001", advisory_age: 13 } }); });
        try {
            await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
            await tv.page.keyboard.press("Enter");
            await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
            const chip = tv.page.locator(".details-editorial [data-advisory-age]");
            if (enabled) {
                await chip.waitFor();
                assert.equal(await chip.textContent(), "13+");
                assert.equal(await tv.page.locator(".details-editorial .browse-meta").count(), 1);
            } else {
                await tv.page.locator(".details-editorial .browse-meta").waitFor();
                assert.equal(await chip.count(), 0);
            }
        } finally { await tv.page.context().close(); }
    }
});

test("Use Synced TV Settings appears under Sync Source above Cards and removes only the older poster device override", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
    assert.ok(deviceId);
    settings.device("p-owner", deviceId).set("ui.card_presentation", { poster_size: "compact", caption: "title_metadata" });
    settings.device("p-owner", "client:tv").set("ui.card_presentation", { poster_size: "large", caption: "title_metadata" });
    try {
        await openSettings(tv);
        assert.equal(await tv.page.locator('[data-focus="poster-size"]').getAttribute("aria-disabled"), "true");
        assert.equal(await tv.page.locator('[data-focus="poster-profile-default"]').count(), 0);
        const layout = await tv.page.evaluate(() => {
            const headers = [...document.querySelectorAll(".settings-pane .settings-section-header")].map(node => node.textContent);
            const syncSource = [...document.querySelectorAll(".settings-pane .settings-section-header")].find(node => node.textContent === "SYNC SOURCE");
            const cards = [...document.querySelectorAll(".settings-pane .settings-section-header")].find(node => node.textContent === "CARDS & POSTERS");
            const button = document.querySelector('[data-focus="use-synced-tv"]');
            const footer = button?.nextElementSibling;
            const poster = document.querySelector('[data-focus="poster-size"]');
            const follows = (a: Element | null | undefined, b: Element | null | undefined): boolean => Boolean(a && b && (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
            return {
                headers,
                footerText: footer?.textContent,
                syncedBeforeCards: follows(syncSource, button) && follows(button, cards) && follows(cards, poster),
            };
        });
        assert.equal(layout.syncedBeforeCards, true, JSON.stringify(layout));
        assert.equal(layout.footerText, "This TV has older device-specific settings. Clear them to use the TV-family choices shared by this profile.");
        assert.equal(await tv.page.getByText("SERVER SUPPORT", { exact: true }).count(), 0);
        await tv.page.locator('[data-focus="use-synced-tv"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.eventually(async () => !settings.device("p-owner", deviceId).has("ui.card_presentation"), "older device override cleared");
        await tv.page.locator('[data-focus="use-synced-tv"]').waitFor({ state: "detached" });
        assert.equal(await tv.focused(), "poster-size");
        assert.equal(await tv.page.locator('[data-focus="poster-size"]').getAttribute("aria-disabled"), null);
        assert.equal(await tv.page.locator('[data-focus="poster-size"] .settings-row-value').textContent(), "Large");
        assert.equal(settings.device("p-owner", "client:tv").has("ui.card_presentation"), true);
        assert.equal(await tv.page.locator('[data-focus="use-synced-tv"]').count(), 0);
        assert.equal(await tv.page.getByText("SYNC SOURCE", { exact: true }).count(), 0);
        assert.equal(await tv.page.getByRole("button", { name: "Use Profile Default", exact: true }).count(), 1);
        await tv.page.getByRole("button", { name: "Use Profile Default", exact: true }).click();
        await tv.eventually(async () => !settings.device("p-owner", "client:tv").has("ui.card_presentation"), "TV-family override cleared");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("a poster size overridden on this TV is disabled and drawn at full brightness, as on Apple TV", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
    assert.ok(deviceId);
    settings.device("p-owner", deviceId).set("ui.card_presentation", { poster_size: "compact", caption: "title_metadata" });
    try {
        await openSettings(tv);
        await assertDisabledRowsFullBrightness(tv, ["poster-size"]);
    } finally { await tv.page.context().close(); }
});

test("rows disabled while a save is in flight are drawn at full brightness, as on Apple TV", async () => {
    const { tv } = await setup();
    const held = tv.fake.hold("/settings/values/ui.title_art", true);
    try {
        await openSettings(tv);
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).click();
        await tv.eventually(async () => tv.fake.requests.some(request => request.method === "PUT" && request.path.includes("ui.title_art")), "title art save waiting");
        await assertDisabledRowsFullBrightness(tv, ["title-art", "title-art-all"]);
    } finally { held.release(); await tv.page.context().close(); }
});

test("profile subtitle editors read and compare profile values while narrower overrides remain active", async () => {
    const { tv, settings } = await setup();
    settings.profileSubtitles = true;
    settings.profile().set(SUBTITLE_LANGUAGE_KEY, "en");
    settings.profile().set(SUBTITLE_MODE_KEY, "always");
    settings.profile().set(SHOW_FORCED_KEY, false);
    settings.overrides.set(SUBTITLE_LANGUAGE_KEY, "fr");
    settings.overrides.set(SUBTITLE_MODE_KEY, "off");
    settings.overrides.set(SHOW_FORCED_KEY, true);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator('[data-focus="subtitle-language"] .settings-row-value').textContent(), "en");
        assert.equal(await tv.page.locator('[data-focus="subtitle-mode"] .settings-row-value').textContent(), "Always");
        assert.equal(await tv.page.locator('[data-focus="subtitle-forced"]').getAttribute("aria-checked"), "false");
        await tv.page.locator('[data-focus="subtitle-language"]').click();
        assert.equal(await tv.page.getByRole("radio", { name: "en", exact: true }).getAttribute("aria-checked"), "true");
        await tv.page.getByRole("radio", { name: "fr", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-language"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_LANGUAGE_KEY), "fr", "a value equal to the override still updates the profile");
        await tv.page.locator('[data-focus="subtitle-mode"]').click();
        await tv.page.getByRole("radio", { name: "Off", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-mode"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_MODE_KEY), "off");
        await tv.page.locator('[data-focus="subtitle-forced"]').click();
        await tv.eventually(async () => settings.profile().get(SHOW_FORCED_KEY) === true, "toggle the profile value");
        assert.equal(settings.overrides.get(SUBTITLE_LANGUAGE_KEY), "fr");
        assert.equal(settings.overrides.get(SUBTITLE_MODE_KEY), "off");
        assert.equal(settings.overrides.get(SHOW_FORCED_KEY), true);
        await tv.page.getByText(/Override active/).waitFor();
    } finally { await tv.page.context().close(); }
});

test("Profile Selection caption follows the chosen launch behavior", async () => {
    const { tv } = await setup();
    const captions = {
        "Every Time": "Show Who's Watching whenever you return to Auger.",
        "After 1 Hour": "Show Who's Watching when you've been away from Auger for 1 hour.",
        "After 12 Hours": "Show Who's Watching when you've been away from Auger for 12 hours.",
        Automatic: "Use the profile selected for the current TV user. A protected profile can reopen without asking for its PIN.",
    } as const;
    try {
        await openSettings(tv);
        const caption = async (): Promise<string | null> => tv.page.locator('[data-focus="remember-profile"] + .settings-value').textContent();
        assert.equal(await caption(), captions["Every Time"]);
        for (const [name, text] of Object.entries(captions)) {
            if (name === "Every Time") continue;
            await tv.page.locator('[data-focus="remember-profile"]').click();
            if (name === "Automatic") {
                assert.equal(await tv.page.getByRole("dialog").locator(".settings-option-detail").nth(0).textContent(), text);
            }
            await tv.page.getByRole("radio", { name, exact: true }).click();
            await tv.eventually(async () => await caption() === text, `${name} caption`);
        }
    } finally { await tv.page.context().close(); }
});

test("Settings pane spacing matches Apple's section gaps", async () => {
    const { tv, settings } = await setup();
    settings.profileSubtitles = true;
    try {
        await openSettings(tv);
        const general = await tv.page.evaluate(() => {
            const header = document.querySelector(".settings-pane-header");
            const user = document.querySelector(".settings-pane > .settings-section-header");
            const paired = document.querySelector('[data-focus="paired-profile"]');
            const footer = document.querySelector('[data-focus="paired-profile"] + .settings-value');
            const launch = [...document.querySelectorAll(".settings-pane > .settings-section-header")].find(node => node.textContent === "PROFILE AT LAUNCH");
            const titleArt = document.querySelector('[data-focus="title-art"]');
            const titleArtAll = document.querySelector('[data-focus="title-art-all"]');
            if (!header || !user || !paired || !footer || !launch || !titleArt || !titleArtAll) return null;
            const userStyle = getComputedStyle(user);
            const footerStyle = getComputedStyle(footer);
            const launchStyle = getComputedStyle(launch);
            const box = (node: Element) => node.getBoundingClientRect();
            const textTop = (node: Element): number => node.getBoundingClientRect().top + parseFloat(getComputedStyle(node).paddingTop);
            const labels = [...document.querySelectorAll(".settings-pane > .settings-section-header")];
            const captionHeight = box(footer).height - parseFloat(footerStyle.paddingTop) - parseFloat(footerStyle.paddingBottom);
            return {
                headerToSectionText: box(user).top + parseFloat(userStyle.paddingTop) - box(header).bottom,
                sectionPaddingTop: userStyle.paddingTop,
                sectionPaddingBottom: userStyle.paddingBottom,
                sectionToRow: box(paired).top - box(user).bottom,
                rowToFooterText: box(footer).top + parseFloat(footerStyle.paddingTop) - box(paired).bottom,
                footerPaddingTop: footerStyle.paddingTop,
                footerLineHeight: footerStyle.lineHeight,
                footerToNextSectionText: box(launch).top + parseFloat(launchStyle.paddingTop) - box(footer).bottom,
                rowPitch: box(titleArtAll).top - box(titleArt).bottom,
                sectionText: labels.slice(0, 3).map(textTop),
                firstRow: box(paired).top,
                captionHeight,
            };
        });
        assert.deepEqual(general, {
            headerToSectionText: 52,
            sectionPaddingTop: "26px",
            sectionPaddingBottom: "6px",
            sectionToRow: 8,
            rowToFooterText: 12,
            footerPaddingTop: "4px",
            footerLineHeight: "23px",
            footerToNextSectionText: 34,
            rowPitch: 8,
            sectionText: [240, 458, 630],
            firstRow: 277,
            captionHeight: 69,
        });
        await tv.page.locator('[data-focus="playback"]').click();
        const playback = await tv.page.evaluate(() => {
            const header = document.querySelector(".settings-pane > .settings-section-header");
            const row = document.querySelector('[data-focus="quality"]');
            if (!header || !row) return null;
            return { gap: row.getBoundingClientRect().top - header.getBoundingClientRect().bottom, row: row.getBoundingClientRect().top };
        });
        assert.deepEqual(playback, { gap: 8, row: 277 });
        await tv.page.locator('[data-focus="subtitles"]').click();
        const subtitles = await tv.page.evaluate(() => document.querySelector('[data-focus="subtitle-language"]')?.getBoundingClientRect().top ?? null);
        assert.equal(subtitles, 277);
    } finally { await tv.page.context().close(); }
});

test("Settings rows use Apple's regular label and resting stroke", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const row = await tv.page.locator('[data-focus="title-art"]').evaluate(node => {
            const style = getComputedStyle(node);
            const on = getComputedStyle(node.querySelector(".settings-row-value")!);
            const off = getComputedStyle(document.querySelector('[data-focus="title-art-all"] .settings-row-value')!);
            const offRow = document.querySelector('[data-focus="title-art-all"]')!;
            return { weight: style.fontWeight, border: style.borderTopWidth, borderColor: style.borderTopColor, on: on.fontWeight, off: off.fontWeight, onOpacity: on.opacity, offOpacity: off.opacity, fill: style.backgroundColor, offFill: getComputedStyle(offRow).backgroundColor };
        });
        // Colors.swift:70 siloChromeRestingFill, and TVSettingsToggleRow's opacity for each state.
        assert.deepEqual(row, { weight: "400", border: "1px", borderColor: "rgba(255, 255, 255, 0.09)", on: "600", off: "400", onOpacity: "0.9", offOpacity: "0.55", fill: "rgba(255, 255, 255, 0.07)", offFill: "rgba(255, 255, 255, 0.07)" });
    } finally { await tv.page.context().close(); }
});

test("Title Art caption uses Apple's sentence for the current scope", async () => {
    const { tv } = await setup();
    const device = "Use logo artwork as the title when available. Only affects this TV. Your other devices keep their own setting.";
    const every = (state: "on" | "off"): string => `Title art is ${state} on every device signed into this profile. Changing it here changes it everywhere. Turn off Apply to All Devices to choose for this TV only.`;
    try {
        await openSettings(tv);
        const caption = async (): Promise<string | null> => tv.page.locator('[data-focus="title-art-all"] + .settings-value').textContent();
        assert.equal(await caption(), device);
        await tv.page.getByRole("switch", { name: "Apply to All Devices", exact: true }).click();
        await tv.eventually(async () => await caption() === every("on"), "profile title art caption");
        await tv.page.getByRole("switch", { name: "Show Title Art", exact: true }).click();
        await tv.eventually(async () => await caption() === every("off"), "title art off caption");
    } finally { await tv.page.context().close(); }
});

test("Paired Silo Profile shows the profile this TV reopens and opens the profile picker", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        assert.equal(await tv.page.locator(".settings-section-header").first().textContent(), "TV USER");
        assert.equal(await tv.page.locator('[data-focus="paired-profile"] .settings-row-value').textContent(), "Not paired");
        await tv.page.getByText("This TV user context is not set to keep separate app preferences. Auger uses the profile pairing available to the current app context, and you can change it here at any time. Ask Every Time is on, so Auger will still show Who's Watching at launch.", { exact: true }).waitFor();
        await tv.page.locator('[data-focus="remember-profile"]').click();
        await tv.page.getByRole("radio", { name: "Automatic", exact: true }).click();
        await tv.eventually(async () => await tv.page.locator('[data-focus="paired-profile"] .settings-row-value').textContent() === "Laura", "remembered profile name");
        assert.equal(await tv.page.getByText(/Ask Every Time is on/).count(), 0);
        await tv.page.locator('[data-focus="paired-profile"]').click();
        assert.equal(await tv.page.evaluate(() => window.browseHarness.chooseProfileCalls.length), 1);
        assert.equal(await tv.page.locator(".settings").count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Subtitles, the profile account line and sign-out confirmation follow Apple TV", async () => {
    const { tv, settings } = await setup();
    settings.profileSubtitles = true;
    try {
        await openSettings(tv);
        assert.deepEqual(await tv.page.locator(".settings-categories [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["settings-profile", "general", "playback", "subtitles", "diagnostics", "server", "settings-signout"]);
        const profile = tv.page.locator('[data-focus="settings-profile"]');
        assert.equal(await profile.locator(".settings-profile-name").textContent(), "Laura");
        assert.equal(await profile.locator(".settings-profile-account").textContent(), "laura");
        assert.equal(await tv.page.locator(".settings-version").textContent(), "Auger 0.0.1");
        assert.equal(await tv.page.getByRole("button", { name: /^Diagnostics,/ }).count(), 1);
        assert.equal(await tv.page.locator('[data-focus="subtitles"] .settings-category-detail').textContent(), "Language and appearance");
        // The version uses siloSecondaryText at 0.7 (TVSettingsView.swift:201-203, #773); category subtitles dim the row foreground instead.
        const secondary = await tv.page.locator('[data-focus="subtitles"] .settings-category-detail, .settings-version').evaluateAll(nodes => nodes.map(node => ({ color: getComputedStyle(node).color, opacity: getComputedStyle(node).opacity })));
        assert.deepEqual(secondary, [{ color: "rgb(237, 237, 237)", opacity: "0.62" }, { color: "rgba(237, 237, 237, 0.6)", opacity: "0.7" }]);
        await tv.page.locator('[data-focus="subtitles"]').click();
        assert.equal(await tv.page.locator(".settings-blurb").textContent(), "Language, behavior, and on-screen appearance.");
        assert.equal(await tv.page.locator('[data-focus="subtitle-language"] .settings-row-value').textContent(), "None");
        assert.equal(await tv.page.locator('[data-focus="subtitle-mode"] .settings-row-value').textContent(), "Auto");
        assert.equal(await tv.page.locator('[data-focus="subtitle-forced"]').getAttribute("aria-checked"), "true");
        await tv.page.getByText("Used to pick a matching track when one is available. Forced subtitles cover foreign-language dialogue even when subtitles are off or set to auto.", { exact: true }).waitFor();
        await tv.page.locator('[data-focus="subtitle-language"]').click();
        await tv.page.getByRole("radio", { name: "en", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-language"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_LANGUAGE_KEY), "en");
        assert.equal(await tv.page.locator('[data-focus="subtitle-language"] .settings-row-value').textContent(), "en");
        await tv.page.locator('[data-focus="subtitle-mode"]').click();
        assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["Auto", "Always", "Off"]);
        await tv.page.getByRole("radio", { name: "Always", exact: true }).click();
        await tv.page.locator('[data-focus="subtitle-mode"]').waitFor();
        assert.equal(settings.profile().get(SUBTITLE_MODE_KEY), "always");
        await tv.page.locator('[data-focus="subtitle-forced"]').click();
        await tv.eventually(async () => settings.profile().get(SHOW_FORCED_KEY) === false, "forced subtitles off");
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT" && request.path.startsWith(`/settings/values/${SHOW_FORCED_KEY}?scope=profile`)).length, 1);
        await tv.page.locator('[data-focus="settings-signout"]').click();
        await tv.page.getByRole("heading", { name: "Sign out of laura on this server?" }).waitFor();
        await tv.page.getByText("This account's profiles and settings leave this TV, and this server will be removed from it.", { exact: true }).waitFor();
        assert.equal(await tv.focused(), "cancel-signout");
        await assertSignOutDialog(tv.page, "Sign out of laura on this server?");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "confirm-signout");
        await tv.page.keyboard.press("ArrowLeft");
        assert.equal(await tv.focused(), "cancel-signout", "focus stays inside the dialog");
        await tv.remote(10009);
        await tv.page.locator('[data-focus="settings-signout"]').waitFor();
        assert.equal(await tv.focused(), "settings-signout", "Back cancels and returns to Sign Out");
        assert.equal(await tv.page.getByRole("alertdialog").count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Apple Settings rail enters the first row, shows separate values and restores modal focus", async () => {
    const { tv } = await setup(true);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').focus();
        await tv.remote(39);
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "quality");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-title').textContent(), "Resolution");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "Auto");
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("radio", { name: "6 Mbps", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "bitrate");
        assert.equal(await tv.page.locator('[data-focus="bitrate"] .settings-row-value').textContent(), "6 Mbps");
        await tv.remote(37);
        await tv.remote(39);
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "quality");
        await tv.page.locator('[data-focus="settings-signout"]').click();
        await tv.page.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal(await tv.page.locator(":focus").getAttribute("data-focus"), "settings-signout");
        assert.equal(await tv.page.getByText(/Auger 0\.0\.1/).count(), 1);
        assert.equal(await tv.page.getByRole("button", { name: /nav.*menu|synced.*menu/i }).count(), 0);
    } finally { await tv.page.context().close(); }
});

test("Settings profile and confirmed sign out use the existing browse callbacks", async () => {
    const first = await setup();
    try {
        await openSettings(first.tv);
        await first.tv.page.locator('[data-focus="settings-profile"]').click();
        assert.equal(await first.tv.page.evaluate(() => window.browseHarness.chooseProfileCalls.length), 1);
        assert.equal(await first.tv.page.locator(".settings").count(), 0);
    } finally { await first.tv.page.context().close(); }
    const second = await setup();
    try {
        await openSettings(second.tv);
        await second.tv.page.locator('[data-focus="settings-signout"]').click();
        assert.equal(await second.tv.focused(), "cancel-signout");
        await second.tv.page.keyboard.press("ArrowUp");
        assert.equal(await second.tv.focused(), "cancel-signout");
        await second.tv.page.locator('[data-focus="confirm-signout"]').click();
        assert.equal(await second.tv.page.evaluate(() => window.browseHarness.signOutCalls), 1);
        assert.equal(await second.tv.page.locator(".settings").count(), 0);
    } finally { await second.tv.page.context().close(); }
});

test("device pickers preserve profile, show inheritance, retain legacy audio null and survive Back/reentry", async () => {
    const { tv, settings } = await setup(true);
    try {
        const deviceId = tv.fake.requests.find(r => r.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        const device = settings.device("p-owner", deviceId);
        settings.profile().set(AUDIO_KEY, "fr");
        settings.profile().set(QUALITY_KEY, "1080p");
        settings.profile().set(BITRATE_KEY, 6000);
        device.set(AUDIO_KEY, "yue-Hant-HK");
        device.set(QUALITY_KEY, "480p");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.page.locator('[data-focus="audio:yue-Hant-HK"]').getAttribute("aria-checked"), "true");
        assert.equal(await tv.page.locator('[data-focus="audio:null"]').count(), 0);
        await tv.page.getByRole("radio", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(device.has(AUDIO_KEY), false);
        assert.equal(settings.profile().get(AUDIO_KEY), "fr");
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByRole("radio", { name: "720p", exact: true }).click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(device.get(QUALITY_KEY), "720p");
        assert.equal(settings.profile().get(QUALITY_KEY), "1080p");
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("button", { name: "No limit", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(device.has(BITRATE_KEY), true);
        assert.equal(device.get(BITRATE_KEY), null);
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("radio", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(device.has(BITRATE_KEY), false);
        assert.equal(settings.profile().get(BITRATE_KEY), 6000);
        await tv.remote(10009);
        await tv.remote(10009);
        device.set(AUDIO_KEY, null);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.page.locator('[data-focus="audio:null"]').getAttribute("aria-checked"), "true");
        await tv.page.locator('[data-focus="audio:null"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(device.has(AUDIO_KEY), true);
        assert.equal(device.get(AUDIO_KEY), null);
        await tv.page.locator('[data-focus="quality"]').click();
        assert.equal(await tv.page.locator('[data-focus="quality:720p"]').getAttribute("aria-checked"), "true");
        await tv.page.getByRole("radio", { name: "Use Profile Setting", exact: true }).click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "1080p");
        assert.equal(device.has(QUALITY_KEY), false);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("quality footer and bitrate labels follow Apple TV", async () => {
    const { tv, settings } = await setup();
    settings.profile().set(QUALITY_KEY, "2160p");
    settings.profile().set(BITRATE_KEY, 999);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const footer = "Plays the original file up to 4K. Larger files are converted. Files above this bitrate are converted to fit.";
        await tv.page.getByText(footer, { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="bitrate"] .settings-row-value').textContent(), "999 kbps");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "4K");
        const order = await tv.page.evaluate(() => {
            const bitrate = document.querySelector('[data-focus="bitrate"]');
            const note = document.querySelector(".settings-quality-footer");
            const streaming = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "STREAMING");
            if (bitrate === null || note === null || streaming === undefined) return false;
            return Boolean(bitrate.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(note.compareDocumentPosition(streaming) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        assert.equal(order, true);
        await tv.page.locator('[data-focus="bitrate"]').click();
        const dialog = tv.page.getByRole("dialog", { name: "Maximum Bitrate" });
        await dialog.waitFor();
        const choices = await dialog.locator('.settings-modal-options [data-focus^="bitrate:"], .settings-modal-options [data-focus="no-limit"]').allTextContents();
        assert.deepEqual(choices, ["No limit", "200 Mbps", "100 Mbps", "60 Mbps", "40 Mbps", "20 Mbps", "15 Mbps", "10 Mbps", "6 Mbps", "4 Mbps", "2 Mbps", "1.5 Mbps", "999 kbps"]);
        assert.equal(await dialog.locator('[data-focus="bitrate:999"]').getAttribute("aria-checked"), "true");
        assert.equal(await dialog.getByRole("textbox").count(), 0);
        assert.equal(await dialog.getByRole("button", { name: "Save", exact: true }).count(), 0);
    } finally { await tv.page.context().close(); }
});

const BUFFERING_MODE_KEY = "playback.buffering_quality_mode";
const BUFFERING_SENTENCES = "What Auger does on Auto when playback keeps buffering. Auger always asks before lowering a quality you picked.";

test("Lower quality when buffering follows Apple's QUALITY rows and saves for this TV only", async () => {
    const { tv, settings } = await setup(true);
    settings.bufferingRows = true;
    try {
        const deviceId = tv.fake.requests.find(r => r.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        const device = settings.device("p-owner", deviceId);
        settings.profile().set(BUFFERING_MODE_KEY, "ask");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const row = tv.page.locator('[data-focus="buffering-mode"]');
        await row.waitFor();
        assert.equal(await row.locator(".settings-row-title").textContent(), "Lower quality when buffering");
        assert.equal(await row.locator(".settings-row-value").textContent(), "Ask first");
        // TVPlaybackSettingsView.swift:60-90: Resolution, Maximum Bitrate, the buffering row, then one footer with both sentences.
        const order = await tv.page.evaluate(() => {
            const keys = ["quality", "bitrate", "buffering-mode"].map(key => document.querySelector(`[data-focus="${key}"]`));
            const footer = document.querySelector(".settings-quality-footer");
            const streaming = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "STREAMING");
            const nodes = [...keys, footer, streaming];
            if (nodes.some(node => node === null || node === undefined)) return false;
            return nodes.every((node, index) => index === 0 || (((nodes[index - 1] as Node).compareDocumentPosition(node as Node)) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
        });
        assert.equal(order, true);
        assert.equal(await tv.page.locator(".settings-quality-footer").textContent(), `Plays the original file whenever your device and connection can handle it. ${BUFFERING_SENTENCES}`);
        await row.click();
        const dialog = tv.page.getByRole("dialog", { name: "Lower quality when buffering" });
        await dialog.waitFor();
        assert.deepEqual(await dialog.locator(".settings-modal-options [data-focus]").allTextContents(), ["Use Profile Setting", "Never", "Ask first", "Automatically"]);
        // No device value yet: the profile's Ask first applies, so Use Profile Setting is the checked choice.
        assert.equal(await dialog.locator('[data-focus="reset-row"]').getAttribute("aria-checked"), "true");
        assert.equal(await dialog.locator('[data-focus="choice:ask"]').getAttribute("aria-checked"), "false");
        await dialog.locator('[data-focus="choice:never"]').click();
        await row.waitFor();
        assert.equal(await tv.focused(), "buffering-mode");
        assert.equal(device.get(BUFFERING_MODE_KEY), "never");
        assert.equal(settings.profile().get(BUFFERING_MODE_KEY), "ask");
        assert.equal(await row.locator(".settings-row-value").textContent(), "Never");
        await row.click();
        await tv.page.locator('[data-focus="reset-row"]').click();
        await row.waitFor();
        assert.equal(device.has(BUFFERING_MODE_KEY), false);
        assert.equal(await row.locator(".settings-row-value").textContent(), "Ask first");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Lower quality when buffering defaults to Automatically and is hidden where the server lacks it", async () => {
    const shown = await setup(true);
    shown.settings.bufferingRows = true;
    try {
        await openSettings(shown.tv);
        await shown.tv.page.locator('[data-focus="playback"]').click();
        assert.equal(await shown.tv.page.locator('[data-focus="buffering-mode"] .settings-row-value').textContent(), "Automatically");
    } finally { await shown.tv.page.context().close(); }
    const hidden = await setup(true);
    try {
        await openSettings(hidden.tv);
        await hidden.tv.page.locator('[data-focus="playback"]').click();
        await hidden.tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(await hidden.tv.page.locator('[data-focus="buffering-mode"]').count(), 0);
        assert.equal(await hidden.tv.page.locator(".settings-quality-footer").textContent(), "Plays the original file whenever your device and connection can handle it.");
    } finally { await hidden.tv.page.context().close(); }
});

test("Playback restores video skip intervals after episodes and focus moves do not write settings", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        assert.equal(await tv.page.locator('[data-focus="seek-back"], [data-focus="seek-forward"]').count(), 2);
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["QUALITY", "STREAMING", "EPISODES", "SPOILERS", "VIDEO", "AUDIOBOOKS"]);
        const requests = tv.fake.requests.length;
        await tv.page.locator('[data-focus="quality"]').focus();
        await tv.remote(40); await tv.remote(40);
        assert.equal(tv.fake.requests.length, requests);
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE").length, 0);
    } finally { await tv.page.context().close(); }
});

test("Playback offers audiobook skip intervals in their own group, saved apart from video's", async () => {
    const { tv, settings } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audiobook-seek-back"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus="audiobook-seek-back"], [data-focus="audiobook-seek-forward"]').count(), 2);
        assert.deepEqual(await tv.page.locator('[data-focus="audiobook-seek-back"] .settings-row-value, [data-focus="audiobook-seek-forward"] .settings-row-value').allTextContents(), ["10 seconds", "30 seconds"]);
        assert.equal(await tv.page.locator(".settings-value", { hasText: "Used by the audiobook player's skip buttons." }).count(), 1);
        await tv.page.locator('[data-focus="audiobook-seek-back"]').click();
        await tv.page.getByRole("heading", { name: "Audiobook Skip Back", exact: true }).waitFor();
        await tv.page.getByRole("radio", { name: "45 seconds", exact: true }).click();
        await tv.eventually(async () => settings.profile().get(AUDIOBOOK_SEEK_BACK_KEY) === 45, "audiobook back interval saved");
        await tv.page.getByRole("dialog").waitFor({ state: "detached" });
        assert.equal(settings.profile().has(SEEK_BACK_KEY), false, "video's interval is not written");
        assert.equal(await tv.page.locator('[data-focus="audiobook-seek-back"] .settings-row-value').textContent(), "45 seconds");
        assert.equal(await tv.page.locator('[data-focus="seek-back"] .settings-row-value').textContent(), "10 seconds");
        assert.equal(await tv.focused(), "audiobook-seek-back", "Back from the picker returns to its row");
    } finally { await tv.page.context().close(); }
});

test("Settings uses the measured Apple pane margins and borderless sign out", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const geometry = await readLive(tv, () => {
            const rail = document.querySelector('[data-focus="general"]');
            const row = document.querySelector('[data-focus="title-art"]');
            const header = document.querySelector('.settings-pane-header');
            const signout = document.querySelector('[data-focus="settings-signout"]');
            if (!rail?.isConnected || !row?.isConnected || !header?.isConnected || !signout?.isConnected) return null;
            for (const animation of rail.getAnimations()) animation.finish();
            const signoutBox = signout.getBoundingClientRect();
            return { rail: Number(rail.getBoundingClientRect().x.toFixed(3)), row: row.getBoundingClientRect().x, width: row.getBoundingClientRect().width, header: header.getBoundingClientRect().y, signoutX: signoutBox.x, signoutWidth: signoutBox.width, signoutHeight: signoutBox.height, border: getComputedStyle(signout).borderWidth };
        }, null, () => true, "live Settings geometry");
        // Focus moves the rail's drawn left edge to 164 - 490 × (1.012 - 1) / 2.
        assert.deepEqual(geometry, { rail: 161.06, row: 728, width: 1006, header: 108, signoutX: 164, signoutWidth: 490, signoutHeight: 63, border: "0px" });
    } finally { await tv.page.context().close(); }
});

test("Settings rail rows are unframed at rest and on focus", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const focused = await readLive(tv, () => {
            const row = document.querySelector<HTMLElement>('[data-focus="general"]');
            if (row === null || document.activeElement !== row) return null;
            for (const animation of row.getAnimations()) animation.finish();
            const style = getComputedStyle(row);
            return { border: style.borderTopWidth, background: style.backgroundColor, color: style.color, width: Number(row.getBoundingClientRect().width.toFixed(3)), height: Number(row.getBoundingClientRect().height.toFixed(3)) };
        }, null, () => true, "focused rail row");
        assert.deepEqual(focused, { border: "0px", background: "rgb(237, 237, 237)", color: "rgb(0, 0, 0)", width: 495.88, height: 82.984 });
        const resting = await tv.page.locator('[data-focus="server"]').evaluate(node => {
            const style = getComputedStyle(node);
            return { border: style.borderTopWidth, background: style.backgroundColor };
        });
        assert.deepEqual(resting, { border: "0px", background: "rgba(0, 0, 0, 0)" });
        await tv.page.keyboard.press("ArrowRight");
        const selected = await tv.page.locator('[data-focus="general"]').evaluate(node => {
            const style = getComputedStyle(node);
            return { border: style.borderTopWidth, background: style.backgroundColor, current: node.getAttribute("aria-current") };
        });
        assert.deepEqual(selected, { border: "0px", background: "rgba(255, 255, 255, 0.14)", current: "page" });
    } finally { await tv.page.context().close(); }
});

test("Playback reset is red with an icon at rest and while focused", async () => {
    const { tv, settings } = await setup(true);
    const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
    assert.ok(deviceId);
    settings.device("p-owner", deviceId).set(QUALITY_KEY, "1080p");
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const reset = tv.page.locator('[data-focus="reset-playback"]');
        await reset.waitFor();
        const resting = await reset.evaluate(node => {
            const style = getComputedStyle(node);
            return { color: style.color, icon: node.querySelector("svg") !== null, name: node.textContent };
        });
        assert.deepEqual(resting, { color: "rgb(176, 0, 32)", icon: true, name: "Use Profile Settings" });
        await focusPaneRow(tv, "reset-playback");
        const focused = await readLive(tv, () => {
            const row = document.querySelector<HTMLElement>('[data-focus="reset-playback"]');
            if (row === null || document.activeElement !== row) return null;
            const style = getComputedStyle(row);
            return { color: style.color, background: style.backgroundColor };
        }, null, () => true, "focused playback reset");
        assert.deepEqual(focused, { color: "rgb(210, 47, 63)", background: "rgb(237, 237, 237)" });
    } finally { await tv.page.context().close(); }
});

test("Administrator is shown for an admin role and a missing role stays the account name", async () => {
    const admin = await setup(false, "admin");
    try {
        await openSettings(admin.tv);
        assert.equal(await admin.tv.page.locator(".settings-profile-name").textContent(), "Laura");
        assert.equal(await admin.tv.page.locator(".settings-profile-account").textContent(), "Administrator");
    } finally { await admin.tv.page.context().close(); }
    const missing = await setup(false, null);
    try {
        await openSettings(missing.tv);
        assert.equal(await missing.tv.page.locator(".settings-profile-name").textContent(), "Laura");
        assert.equal(await missing.tv.page.locator(".settings-profile-account").textContent(), "laura");
    } finally { await missing.tv.page.context().close(); }
});

async function focusPaneRow(tv: Tv, key: string): Promise<void> {
    await tv.page.keyboard.press("ArrowRight");
    for (let step = 0; step < 40 && await tv.focused() !== key; step += 1) await tv.page.keyboard.press("ArrowDown");
    assert.equal(await tv.focused(), key);
    await tv.jump(400);
}

test("Subtitles keeps its descriptive footer visible below Reset", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await focusPaneRow(tv, "reset-appearance");
        const visible = await readLive(tv, () => {
            const footer = document.querySelector('.settings-appearance-footer');
            const pane = document.querySelector<HTMLElement>('.settings-pane');
            if (!footer?.isConnected || !pane?.isConnected) return null;
            return { bottom: footer.getBoundingClientRect().bottom, paneBottom: pane.getBoundingClientRect().bottom, scrollTop: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight };
        }, null, value => value.bottom <= value.paneBottom + 0.5, 'subtitle footer geometry');
        assert.ok(visible.bottom <= visible.paneBottom, JSON.stringify(visible));
        assert.ok(visible.max - visible.scrollTop < 96, JSON.stringify(visible));
        assert.equal(await tv.page.locator('[data-focus="appearance-device"] .settings-row-value').textContent(), 'Off');
        assert.equal(await tv.page.locator('.settings-nested-group [data-focus="appearance-textOutline"][role="switch"]').count(), 1);
        await tv.page.locator('[data-focus="playback"]').click();
        const playbackLast = await tv.page.locator('.settings-pane [data-focus]').last().getAttribute('data-focus');
        assert.ok(playbackLast);
        await focusPaneRow(tv, playbackLast);
        const playback = await readLive(tv, () => {
            const pane = document.querySelector<HTMLElement>('.settings-pane');
            const footer = pane?.querySelector('.settings-value:last-of-type');
            if (!footer?.isConnected || !pane?.isConnected) return null;
            return { bottom: footer.getBoundingClientRect().bottom, paneBottom: pane.getBoundingClientRect().bottom, scrollTop: pane.scrollTop, max: pane.scrollHeight - pane.clientHeight };
        }, null, value => value.bottom <= value.paneBottom + 0.5, 'playback footer geometry');
        assert.ok(playback.bottom <= playback.paneBottom, JSON.stringify(playback));
        assert.ok(playback.max - playback.scrollTop < 96, JSON.stringify(playback));
    } finally { await tv.page.context().close(); }
});

test("Settings uses category, row and picker Back focus with no requests on focus", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        assert.equal(await tv.focused(), "general");
        const requests = tv.fake.requests.length;
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "playback");
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "quality");
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("heading", { name: "Resolution" }).waitFor();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "quality");
        await tv.remote(10009);
        assert.equal(await tv.focused(), "playback");
        assert.equal(tv.fake.requests.length, requests);
        await tv.remote(10009);
        assert.equal(await tv.focused(), "home");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Server pane omits Restore All Libraries even when hidden libraries exist (#773)", async () => {
    for (const hidden of [[15, 999], undefined] as const) {
        const { tv, settings } = await setup();
        if (hidden !== undefined) settings.profile().set(HIDDEN_KEY, [...hidden]);
        try {
            await openSettings(tv);
            await tv.page.locator('[data-focus="server"]').click();
            await tv.page.locator('[data-focus="privacy"]').waitFor();
            assert.equal(await tv.page.locator('[data-focus="hidden"], [data-focus="restore-libraries"]').count(), 0);
            assert.equal(await tv.page.getByText("Restore All Libraries", { exact: true }).count(), 0);
            assert.equal(tv.fake.requests.filter(r => r.method === "PUT" || r.method === "DELETE").length, 0);
            assert.deepEqual(tv.console, []);
        } finally { await tv.page.context().close(); }
    }
});

test("changing Metadata Language invalidates catalogs on Settings Back", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    tv.fake.extraRoutes.push((method, path) => method === "GET" && path.startsWith("/capabilities/metadata-ai")
        ? { status: 200, body: { revision: "test", allowed: true, state: "available", on_view: "button" } }
        : undefined);
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="subtitles"]').click();
        await tv.page.getByRole("button", { name: /Metadata Language/ }).click();
        await tv.page.getByRole("radio", { name: "fr", exact: true }).click();
        await tv.eventually(async () => settings.profile().get("catalog.metadata_language") === "fr", "metadata write");
        await tv.page.locator('[data-focus="metadata-language"]').waitFor();
        await tv.page.getByText("Saving…", { exact: true }).waitFor({ state: "detached" });
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.eventually(async () => tv.fake.requests.filter(r => r.path === "/user/libraries").length === 2, "catalog refreshed");
        assert.equal(await tv.focused(), "home", "catalog invalidation returns to the refreshed Home route");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("audio picker preserves unfamiliar explicit tags, null and inherited reset with narrower override", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(AUDIO_KEY, "en-AU");
        settings.overrides.set(AUDIO_KEY, "fr");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="audio"]').click();
        assert.equal(await tv.page.locator('[data-focus="audio:en-AU"][aria-checked="true"]').count(), 1);
        await tv.page.locator('[data-focus="audio:null"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(settings.profile().get(AUDIO_KEY), null);
        assert.equal(await tv.page.locator('[data-focus="audio"] .settings-row-value').textContent(), "fr");
        await tv.page.locator('[data-focus="audio"]').click();
        await tv.page.locator('[data-focus="reset"]').click();
        await tv.page.locator('[data-focus="audio"]').waitFor();
        assert.equal(settings.profile().has(AUDIO_KEY), false);
        assert.equal(settings.overrides.get(AUDIO_KEY), "fr");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("settings refusal is retryable by reload, and a late answer cannot outlive profile authority", async () => {
    const { tv } = await setup();
    try {
        tv.fake.script("/settings/contract/capabilities", problem(403, "permission_denied", "Denied"));
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.getByRole("alert").waitFor();
        const hold = tv.fake.hold("/settings/contract/capabilities", true);
        await tv.page.getByRole("button", { name: "Reload settings" }).click();
        await tv.page.getByRole("status").waitFor();
        assert.ok(await tv.page.locator('[data-focus="general"]').isVisible());
        await tv.page.evaluate(() => window.browseHarness.clearProfile());
        hold.release();
        await tv.page.locator("#successor").waitFor();
        assert.equal(await tv.page.locator(".settings").count(), 0);
        assert.equal(tv.fake.requests.filter(request => request.method === "PUT" || request.method === "DELETE").length, 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("quality picker uses server labels, keeps legacy current values honest and preserves overrides", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(QUALITY_KEY, "original");
        settings.overrides.set(QUALITY_KEY, "480p");
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByText("Current profile value: Original quality · Not offered", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality:original"]').count(), 0);
        assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), ["Auto", "4K", "1080p", "720p", "480p"]);
        assert.equal(tv.fake.requests.filter(r => r.method === "PUT").length, 0);
        await tv.page.getByRole("radio", { name: "4K", exact: true }).click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(await tv.focused(), "quality");
        assert.equal(settings.profile().get(QUALITY_KEY), "2160p");
        assert.equal(settings.overrides.get(QUALITY_KEY), "480p");
        assert.equal(await tv.page.locator('[data-focus="quality"] .settings-row-value').textContent(), "480p");
        assert.equal(await tv.page.getByText("Saved", { exact: true }).count(), 0);
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.locator('[data-focus="reset"]').click();
        await tv.page.locator('[data-focus="quality"]').waitFor();
        assert.equal(settings.profile().has(QUALITY_KEY), false);
        assert.equal(settings.overrides.get(QUALITY_KEY), "480p");
        settings.profile().set(QUALITY_KEY, "future-quality");
        await tv.remote(10009);
        await tv.remote(10009);
        await tv.remote(10009);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="quality"]').click();
        await tv.page.getByText("Current profile value: future-quality · Not offered", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="quality:future-quality"]').count(), 0);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("bitrate No limit stays distinct from inherited reset and the picker has no custom field", async () => {
    const { tv, settings } = await setup();
    try {
        settings.profile().set(BITRATE_KEY, 6000);
        settings.overrides.set(BITRATE_KEY, 1500);
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="bitrate"]').click();
        const dialog = tv.page.getByRole("dialog", { name: "Maximum Bitrate" });
        await dialog.waitFor();
        assert.equal(await dialog.getByRole("textbox").count(), 0);
        assert.equal(await dialog.getByRole("button", { name: "Save", exact: true }).count(), 0);
        const choices = await dialog.locator('.settings-modal-options [data-focus^="bitrate:"], .settings-modal-options [data-focus="no-limit"]').allTextContents();
        assert.deepEqual(choices, ["No limit", "200 Mbps", "100 Mbps", "60 Mbps", "40 Mbps", "20 Mbps", "15 Mbps", "10 Mbps", "6 Mbps", "4 Mbps", "2 Mbps", "1.5 Mbps"]);
        await tv.page.getByRole("button", { name: "No limit", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(settings.profile().get(BITRATE_KEY), null);
        await tv.page.locator('[data-focus="bitrate"]').click();
        await tv.page.getByRole("button", { name: "Use inherited default", exact: true }).click();
        await tv.page.locator('[data-focus="bitrate"]').waitFor();
        assert.equal(settings.profile().has(BITRATE_KEY), false);
        assert.equal(settings.overrides.get(BITRATE_KEY), 1500);
        assert.equal(await tv.page.locator('[data-focus="bitrate"] .settings-row-value').textContent(), "1.5 Mbps");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("quality controls remain absent for unsupported manifests and empty Playback keeps Back reachable", async () => {
    const { tv } = await setup();
    try {
        const contract = fixture("settings_contract_ok");
        contract.definitions = [];
        // Home loads the spoiler and theme-music preferences once capabilities arrive, which can be after setup returns; count from after they landed.
        await tv.eventually(async () => ["keys=catalog.hide_unwatched_episode_images", "keys=ui.theme_music_enabled"].every(key => tv.fake.requests.some(request => request.path.startsWith("/settings/values/effective?") && request.path.includes(key))), "Home's preference reads");
        await tv.eventually(async () => tv.pendingReplies === 0, "the launch reads answered");
        const requests = tv.fake.requests.length;
        tv.fake.script("/settings/contract", { status: 200, body: contract });
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="remember-profile"]').waitFor();
        await tv.page.locator('[data-focus="playback"]').click();
        // Playback is no longer empty on a revision-24 server: the spoiler switches come from capabilities, not the emptied contract. The old assertion expected "No supported settings in this category."
        await tv.page.locator('[data-focus="spoiler-images"]').waitFor();
        assert.equal(await tv.page.getByText("No supported settings in this category.", { exact: true }).count(), 0);
        assert.equal(await tv.page.locator('[data-focus="quality"], [data-focus="bitrate"]').count(), 0);
        assert.equal(await tv.page.locator('[data-focus="settings-back"]').count(), 0);
        assert.equal(tv.fake.requests.slice(requests).filter(r => r.path.startsWith("/settings/values")).length, 0);
        await tv.page.locator('[data-focus="spoiler-images"]').focus();
        await tv.remote(10009);
        assert.equal(await tv.focused(), "playback");
    } finally { await tv.page.context().close(); }
});

test("Playback shows HDR after the Streaming rows and never shows or writes Dolby Vision", async () => {
    const { tv, settings } = await setup();
    settings.hdrRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const order = await tv.page.locator(".settings-pane [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
        const audio = order.indexOf("audio");
        const hdr = order.indexOf("hdr");
        assert.equal(order.includes("dolby-vision"), false, order.join(","));
        assert.equal(await tv.page.getByRole("switch", { name: "Dolby Vision", exact: true }).count(), 0);
        assert.ok(audio >= 0 && audio < hdr && order[hdr + 1] === "still-watching", order.join(","));
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["QUALITY", "STREAMING", "EPISODES", "SPOILERS", "VIDEO", "AUDIOBOOKS", "RESET"]);
        assert.equal(await tv.page.locator('[data-focus="hdr"] .settings-row-value').innerText(), "On");
        assert.equal(await tv.page.getByRole("switch", { name: "HDR", exact: true }).getAttribute("aria-checked"), "true");
        // TVPlaybackSettingsView.swift:248-258, after the STREAMING rows. The first sentence of
        // SettingsViewModel.swift:136-143, without "without Dolby Vision". The original-file sentence is omitted.
        assert.equal(await tv.page.locator(".settings-hdr-footer").innerText(), "With HDR off, videos the server converts for this device are sent in SDR.");
        const place = await tv.page.evaluate(() => {
            const streaming = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "STREAMING");
            const hdrRow = document.querySelector('[data-focus="hdr"]');
            const note = document.querySelector(".settings-hdr-footer");
            const episodes = [...document.querySelectorAll(".settings-section-header")].find(node => node.textContent === "EPISODES");
            if (streaming === undefined || hdrRow === null || note === null || episodes === undefined) return false;
            return Boolean(streaming.compareDocumentPosition(hdrRow) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(hdrRow.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING)
                && Boolean(note.compareDocumentPosition(episodes) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        assert.equal(place, true);
        const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        const device = settings.device("p-owner", deviceId);
        await tv.page.getByRole("switch", { name: "HDR", exact: true }).click();
        await tv.eventually(async () => device.get(HDR_KEY) === false, "hdr write");
        assert.equal(device.has(HDR_KEY), true);
        assert.equal(settings.profile().has(HDR_KEY), false);
        assert.equal([...device.keys()].join(" ").includes(DOLBY_VISION_KEY), false);
        assert.equal(tv.fake.requests.some(request => request.method !== "GET" && request.path.includes(DOLBY_VISION_KEY)), false);
        assert.equal(tv.fake.requests.some(request => request.path.includes(DOLBY_VISION_KEY)), false);
        await tv.page.locator('[data-focus="hdr"]').focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "still-watching");
    } finally { await tv.page.context().close(); }
});

// Apple's STREAMING pane also lists these rows (TVPlaybackSettingsView.swift:206-248, silo-apple e958f584). AVPlay has no control for any of them
// (docs/settings.md), so Samsung hides them, as Apple hides TrueHD Atmos and DTS:X when its build cannot render them.
test("Playback offers no Streaming row AVPlay cannot honour, even when the server offers the key", async () => {
    const { tv, settings } = await setup();
    settings.hdrRows = true;
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        const order = await tv.page.locator(".settings-pane [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
        assert.deepEqual(order.slice(order.indexOf("audio"), order.indexOf("still-watching")), ["audio", "hdr"]);
        const text = await tv.page.locator(".settings-pane").innerText();
        for (const name of ["Seek Cache", "Buffer Ahead", "Lossless", "TrueHD", "DTS:X", "Deinterlacing"]) assert.equal(text.includes(name), false, name);
        assert.equal(await tv.page.getByRole("switch", { name: /Seek Cache|Lossless|TrueHD/ }).count(), 0);
        assert.equal(await tv.page.getByRole("button", { name: /Buffer Ahead|Deinterlacing/ }).count(), 0);
        assert.equal(tv.fake.requests.some(request => request.path.includes(SEEK_CACHE_KEY)), false);
        const deviceId = tv.fake.requests.find(request => request.headers["x-silo-device-id"])?.headers["x-silo-device-id"];
        assert.ok(deviceId);
        assert.equal([...settings.device("p-owner", deviceId).keys()].includes(SEEK_CACHE_KEY as never), false);
    } finally { await tv.page.context().close(); }
});

test("Server settings open Acknowledgements with TMDB's logo and required notice, and Back returns to the row", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="server"]').click();
        assert.deepEqual(await tv.page.locator(".settings-section-header").allTextContents(), ["ACTIVE SERVER", "ABOUT", "EXTRA FEATURES"]);
        await tv.page.getByRole("button", { name: "Acknowledgements", exact: true }).click();
        const credits = tv.page.locator(".acknowledgements-document");
        await credits.waitFor();
        const count = tv.fake.requests.length;
        assert.equal(await tv.focused(), "document", "the document is the first focus stop, as Apple's overlay");
        assert.equal(await tv.page.locator(".acknowledgements-eyebrow").innerText(), "CREDITS");
        const logo = credits.locator("img.acknowledgements-logo");
        assert.equal(await logo.getAttribute("alt"), "TMDB");
        await tv.eventually(async () => await logo.evaluate(image => (image as HTMLImageElement).naturalWidth > 0), "TMDB logo");
        await credits.getByText("This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.", { exact: true }).waitFor();
        await credits.getByText("Profile avatars", { exact: true }).waitFor();
        assert.match(await credits.textContent() ?? "", /Davis Uche.*creativecommons\.org\/licenses\/by\/4\.0/);
        await credits.getByText("These names and logos belong to their owners. Auger is not affiliated with or endorsed by them.", { exact: true }).waitFor();
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "done", "Up from the top of the document reaches Done");
        await tv.page.keyboard.press("ArrowDown");
        assert.equal(await tv.focused(), "document");
        await tv.remote(10009);
        await tv.page.getByRole("button", { name: "Acknowledgements", exact: true }).waitFor();
        assert.equal(await tv.focused(), "acknowledgements", "Back returns to the row that opened it");
        assert.equal(tv.fake.requests.length, count, "credits are local and read nothing");
    } finally { await tv.page.context().close(); }
});

// Apple's TVSettingsView makes each pane a `.focusSection()`: "vertical movement stays in-pane and Left/Right bridges panes natively"
// (silo-apple dce56e3c). Up from a pane's first row and Down from its last row do nothing; Left reaches the rail.
test("Up from a pane's first row and Down from its last row stay in the pane, and Left still reaches the rail", async () => {
    const { tv, settings } = await setup();
    settings.remainingRows = true;
    try {
        await openSettings(tv);
        for (const category of ["general", "playback", "subtitles", "server"]) {
            await tv.page.locator(`[data-focus="${category}"]`).focus();
            await tv.page.keyboard.press("ArrowRight");
            const first = await tv.focused();
            assert.notEqual(first, category, `${category}: Right enters the pane`);
            await tv.page.keyboard.press("ArrowUp");
            assert.equal(await tv.focused(), first, `${category}: Up at the first row stays put`);
            let last = first;
            for (let step = 0; step < 60; step += 1) {
                await tv.page.keyboard.press("ArrowDown");
                const now = await tv.focused();
                if (now === last) break;
                last = now;
            }
            await tv.page.keyboard.press("ArrowDown");
            assert.equal(await tv.focused(), last, `${category}: Down at the last row stays put`);
            await tv.page.keyboard.press("ArrowUp");
            assert.notEqual(await tv.focused(), last, `${category}: Up still moves inside the pane`);
            await tv.page.keyboard.press("ArrowLeft");
            assert.equal(await tv.focused(), category, `${category}: Left reaches the rail`);
        }
    } finally { await tv.page.context().close(); }
});

test("Up from Paired Silo Profile, the first General row, stays on it", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="general"]').focus();
        await tv.page.keyboard.press("ArrowRight");
        assert.equal(await tv.focused(), "paired-profile");
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), "paired-profile");
    } finally { await tv.page.context().close(); }
});

test("the rail's own Up and Down are unchanged", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        const keys = await tv.page.locator(".settings-categories [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus")));
        await tv.page.locator(`[data-focus="${keys[0]}"]`).focus();
        for (const key of keys.slice(1)) {
            await tv.page.keyboard.press("ArrowDown");
            assert.equal(await tv.focused(), key, "Down walks the rail in order");
        }
        for (const key of keys.slice(0, -1).reverse()) {
            await tv.page.keyboard.press("ArrowUp");
            assert.equal(await tv.focused(), key, "Up walks the rail back");
        }
        await tv.page.keyboard.press("ArrowUp");
        assert.equal(await tv.focused(), keys[0], "Up at the first rail item stays");
    } finally { await tv.page.context().close(); }
});

// The rail is a `.focusSection()` too (TVSettingsView.swift, silo-apple dce56e3c): Down from Sign Out, its last item, stays on it.
test("Down from Sign Out, the last rail item, stays on it in every pane", async () => {
    const { tv } = await setup();
    try {
        await openSettings(tv);
        for (const category of ["general", "playback", "subtitles", "diagnostics", "server"]) {
            await tv.page.locator(`[data-focus="${category}"]`).focus();
            await tv.page.locator('[data-focus="settings-signout"]').focus();
            await tv.page.keyboard.press("ArrowDown");
            assert.equal(await tv.focused(), "settings-signout", `${category}: Down from Sign Out stays`);
            await tv.page.keyboard.press("ArrowUp");
            assert.notEqual(await tv.focused(), "settings-signout", `${category}: Up still leaves Sign Out`);
        }
    } finally { await tv.page.context().close(); }
});

test("Diagnostics sends a redacted report to the relay and offers the QR helper as backup (#847)", async () => {
    const { tv } = await setup();
    const helperHtml = readFileSync(new URL("../../pages/report/index.html", import.meta.url), "utf8");
    const sentPayloads: string[] = [];
    await tv.page.route(DIAGNOSTICS_RELAY_URL, async route => {
        sentPayloads.push(route.request().postData() ?? "");
        await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ok: true, status: "created", issueNumber: 901, reportId: "AUG-901" }) });
    });
    try {
        await openSettings(tv);
        await tv.page.locator('[data-focus="diagnostics"]').click();
        await tv.page.locator('[data-focus="send-diagnostics"]').waitFor();
        assert.equal(await tv.page.locator(".settings-blurb").textContent(), "Send a redacted bug report directly to GitHub, or share via QR code.");

        // A viewer can report a symptom even when the app has not detected an error.
        await tv.page.locator('[data-focus="send-diagnostics"]').click();
        await tv.page.locator('[data-focus="send-diagnostics-playback"]').waitFor();
        await tv.page.locator('[data-focus="cancel-send-diagnostics"]').click();
        assert.equal(sentPayloads.length, 0);

        // Automatic Error Reports defaults to Off and toggles On/Off cleanly.
        const autoRow = tv.page.locator('[data-focus="auto-diagnostics"]');
        assert.equal(await autoRow.getAttribute("aria-checked"), "false");
        assert.match(await autoRow.ariaSnapshot(), /Automatic Error Reports/);
        await tv.page.getByText("Turning this on sends redacted error reports from all profiles on this TV to public GitHub issues.", { exact: true }).waitFor();
        await autoRow.click();
        assert.equal(await autoRow.getAttribute("aria-checked"), "true");
        await autoRow.click();
        assert.equal(await autoRow.getAttribute("aria-checked"), "false");

        await tv.page.evaluate(() => window.browseHarness.seedDiagnostics());
        await tv.page.getByText("Remuxed · MKV", { exact: true }).waitFor();
        await tv.page.getByText("Recorded events", { exact: true }).waitFor();

        // Primary action: Send Diagnostics Report opens the 4-button triage picker.
        await tv.page.locator('[data-focus="send-diagnostics"]').click();
        await tv.page.locator('[data-focus="send-diagnostics-playback"]').waitFor();
        await tv.page.locator('[data-focus="send-diagnostics-audio_subtitles"]').waitFor();
        await tv.page.locator('[data-focus="send-diagnostics-buffering"]').waitFor();
        await tv.page.locator('[data-focus="send-diagnostics-app_ui"]').waitFor();
        await tv.page.locator('[data-focus="send-diagnostics-playback"]').click();
        await tv.page.getByText("Report sent — GitHub issue #901 (AUG-901).", { exact: true }).waitFor();
        assert.equal(sentPayloads.length, 1);
        assert.ok(!sentPayloads[0]!.includes("silo.example.test"), "server hostname must never be sent to relay");
        assert.equal(JSON.parse(sentPayloads[0]!).app, "0.0.1");
        assert.equal(JSON.parse(sentPayloads[0]!).cat, "playback");
        assert.equal(JSON.parse(sentPayloads[0]!).play.m, "Remuxed · MKV");

        // Re-sending the exact same category & state is blocked locally in 0ms without a second network request.
        await tv.page.locator('[data-focus="send-diagnostics"]').click();
        await tv.page.locator('[data-focus="send-diagnostics-playback"]').click();
        await tv.page.getByText("Already sent as AUG-901. Play or reproduce a new issue to send another.", { exact: true }).waitFor();
        assert.equal(sentPayloads.length, 1);

        // Backup action: Share via QR Code.
        await tv.page.locator('[data-focus="share-diagnostics"]').click();
        const card = tv.page.locator(".settings-privacy-card");
        await card.waitFor();
        const reportUrl = await card.getAttribute("data-report-url") ?? "";
        assert.ok(reportUrl.startsWith(`${DIAGNOSTICS_REPORT_URL}#d=`));
        assert.ok(reportUrl.length <= 960);
        assert.ok(!reportUrl.includes("silo.example.test"), "server hostname must never be included in QR URL");
        const qrPath = await tv.page.locator(".settings-privacy-qr svg path").getAttribute("d") ?? "";
        assert.ok(qrPath.length > 50, "QR SVG path is drawn");
        const decoded = decodeDiagnosticsReportHash(reportUrl.slice(reportUrl.indexOf("#")));
        assert.equal(decoded?.app, "0.0.1");
        assert.equal(decoded?.tv, "Samsung TV");
        assert.equal(decoded?.play?.m, "Remuxed · MKV");

        // Close the QR modal and verify focus returns to Share via QR Code, then Clear Session Log actually clears seeded playback + events.
        await tv.remote(10009);
        assert.equal(await tv.focused(), "share-diagnostics");
        await tv.page.locator('[data-focus="clear-diagnostics"]').click();
        await tv.page.getByText("Session log cleared.", { exact: true }).waitFor();
        await tv.page.getByText("No playback recorded yet in this session.", { exact: true }).waitFor();
        await tv.page.getByText("No events recorded yet.", { exact: true }).waitFor();
        assert.equal(await tv.page.getByText("Remuxed · MKV", { exact: true }).count(), 0);

        // Load the actual zero-backend pages/report/index.html with the emitted #d= hash in Playwright.
        const helperPage = await browser.newPage();
        try {
            await helperPage.route("https://artic0din.github.io/Auger-Tizen/report/**", route => route.fulfill({ status: 200, contentType: "text/html", body: helperHtml }));
            await helperPage.goto(reportUrl);
            await helperPage.locator("#content").waitFor({ state: "visible" });
            assert.equal(await helperPage.locator("#empty").isVisible(), false);
            const playbackRowsText = await helperPage.locator("#playback-rows").innerText();
            assert.ok(playbackRowsText.includes("HDR setting") && playbackRowsText.includes("On"), playbackRowsText);
            assert.ok(playbackRowsText.includes("Route fallbacks") && playbackRowsText.includes("2"), playbackRowsText);
            assert.ok(playbackRowsText.includes("AVPlay error") && playbackRowsText.includes("PLAYER_ERROR_NOT_SUPPORTED_FORMAT"), playbackRowsText);
            const rawText = await helperPage.locator("#raw-text").inputValue();
            assert.ok(rawText.includes("**Auger Bug Report**"));
            assert.ok(rawText.includes("Auger: 0.0.1"));
            assert.ok(rawText.includes("HDR setting: On"), rawText);
            assert.ok(rawText.includes("Route fallbacks: 2"), rawText);
            assert.ok(rawText.includes("AVPlay error: PLAYER_ERROR_NOT_SUPPORTED_FORMAT"), rawText);
            const githubHref = await helperPage.locator("#open-github").getAttribute("href") ?? "";
            const githubUrl = new URL(githubHref);
            assert.equal(githubUrl.searchParams.get("template"), "bug-report.yml");
            assert.equal(githubUrl.searchParams.get("app-version"), "0.0.1");
            assert.equal(githubUrl.searchParams.get("device-details"), "Samsung TV");
            assert.equal(githubUrl.searchParams.get("firmware-version"), null);
            assert.equal(githubUrl.searchParams.get("tizen-version"), null);
            const githubPlayback = githubUrl.searchParams.get("playback-details") ?? "";
            assert.ok(githubPlayback.includes("HDR setting: On"), githubPlayback);
            assert.ok(githubPlayback.includes("Route fallbacks: 2"), githubPlayback);
            assert.ok(githubPlayback.includes("AVPlay error: PLAYER_ERROR_NOT_SUPPORTED_FORMAT"), githubPlayback);

            const devicePayload = { ...decoded, tv: "UE50CU7095", fw: "1650", os: "Tizen 8.0", ua: "Chromium 108", scr: "1920x1080" };
            const deviceHash = Buffer.from(JSON.stringify(devicePayload)).toString("base64url");
            await helperPage.goto(`${DIAGNOSTICS_REPORT_URL}#d=${deviceHash}`);
            await helperPage.reload();
            const deviceUrl = new URL(await helperPage.locator("#open-github").getAttribute("href") ?? "");
            assert.equal(deviceUrl.searchParams.get("device-details"), "UE50CU7095");
            assert.equal(deviceUrl.searchParams.get("firmware-version"), "1650");
            assert.equal(deviceUrl.searchParams.get("tizen-version"), "Tizen 8.0");
            assert.match(deviceUrl.searchParams.get("technical-notes") ?? "", /Web engine: Chromium 108\nScreen: 1920x1080/);
        } finally { await helperPage.close(); }
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Settings Playback shows NOT SAVED with Try Again and Discard Held Change when Auto-play retries run out (#810)", async () => {
    const { tv, settings } = await setup(true);
    try {
        settings.remainingRows = true;
        settings.profile().set("playback.auto_play_next", true);
        // Script 6 transient 503 replies (initial debounced PUT + 5 automatic retries) so the write becomes held.
        tv.fake.script("/settings/values/playback.auto_play_next?scope=profile_device", ...Array.from({ length: 6 }, () => ({ status: 503, body: { error: "unavailable" } })));
        await tv.page.evaluate(() => window.browseHarness.enqueuePlayerSetting("playback.auto_play_next", false));
        const putCount = (): number => tv.fake.requests.filter(request => request.method === "PUT" && request.path.includes("playback.auto_play_next")).length;
        for (const [index, delay] of [750, 1000, 2000, 4000, 8000, 16000].entries()) {
            const before = await tv.page.evaluate(() => window.browseHarness.playerSettingsNotificationCount());
            await tv.jump(delay);
            await tv.eventually(
                async () => putCount() >= index + 1 && (await tv.page.evaluate(() => window.browseHarness.playerSettingsNotificationCount())) > before,
                `auto_play_next attempt ${index + 1} settled`,
            );
        }
        await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.heldPlayerSettings())).includes("playback.auto_play_next"), "auto_play_next held");

        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="held-retry"]').waitFor();
        await tv.page.locator('[data-focus="held-discard"]').waitFor();
        await tv.page.getByText("NOT SAVED", { exact: true }).waitFor();
        await tv.page.getByText("A change couldn't be saved to the server. It stays on this device until you try again or discard it.", { exact: true }).waitFor();
        // Auto-play row reflects the unsettled local value (Off) while held.
        assert.equal(await tv.page.locator('[data-focus="auto-next"] .settings-row-value').textContent(), "Off");

        // Discard while server cannot be reached keeps the held change and shows the offline discard message.
        tv.fake.script("/settings/values/effective?keys=playback.auto_play_next", { status: 503, body: { error: "unavailable" } });
        await tv.page.locator('[data-focus="held-discard"]').click();
        await tv.page.getByText("Couldn't reach the server to discard this change. It stays on this device until the server can be reached.", { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="held-discard"]').count(), 1);

        // Once the server answers again, Try Again commits the held value and removes the NOT SAVED section.
        await tv.page.locator('[data-focus="held-retry"]').click();
        await tv.eventually(async () => await tv.page.locator('[data-focus="held-retry"]').count() === 0, "NOT SAVED cleared after retry");
        const puts = tv.fake.requests.filter(request => request.method === "PUT" && request.path.includes("playback.auto_play_next"));
        assert.deepEqual(puts.at(-1)?.body, { value: false });
        assert.equal(await tv.page.locator('[data-focus="auto-next"] .settings-row-value').textContent(), "Off");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Settings Playback shows Still watching prompt after Auto-play next, defaults to 3 episodes, and persists locally (#796)", async () => {
    const { tv, settings } = await setup(true);
    try {
        settings.remainingRows = true;
        await openSettings(tv);
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator('[data-focus="still-watching"]').waitFor();
        const episodeRows = await tv.page.locator(".settings-pane [data-focus]").evaluateAll(nodes =>
            nodes.map(node => node.getAttribute("data-focus")).filter(id => ["auto-next", "still-watching", "next-up", "skip-intros", "skip-credits"].includes(id ?? "")));
        assert.deepEqual(episodeRows, ["auto-next", "still-watching", "next-up", "skip-intros", "skip-credits"]);
        assert.equal(await tv.page.locator('[data-focus="still-watching"] .settings-row-title').textContent(), "Still watching prompt");
        assert.equal(await tv.page.locator('[data-focus="still-watching"] .settings-row-value').textContent(), "3 episodes");

        const writesBefore = tv.fake.requests.filter(request => request.method !== "GET").length;
        await tv.page.locator('[data-focus="still-watching"]').click();
        await tv.page.locator('[data-focus="still-watching:0"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus^="still-watching:"]').count(), 21);
        assert.equal(await tv.page.locator('[data-focus="still-watching:0"]').textContent(), "Off");
        assert.equal(await tv.page.locator('[data-focus="still-watching:1"]').textContent(), "1 episode");
        assert.equal(await tv.page.locator('[data-focus="still-watching:3"]').getAttribute("aria-checked"), "true");
        assert.equal(await tv.page.locator('[data-focus="still-watching:20"]').textContent(), "20 episodes");

        await tv.page.locator('[data-focus="still-watching:0"]').click();
        await tv.page.locator('[data-focus="still-watching"]').waitFor();
        assert.equal(await tv.focused(), "still-watching");
        assert.equal(await tv.page.locator('[data-focus="still-watching"] .settings-row-value').textContent(), "Off");
        assert.equal(tv.fake.requests.filter(request => request.method !== "GET").length, writesBefore, "Still watching prompt is client-local and never writes to the server");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("Settings sign-out confirmation fades scrim and card together over 0.2 s ease-out without clamping three-line titles", async () => {
    const { tv } = await setup();
    try {
        await tv.page.evaluate(() => window.browseHarness.seedServerName("Very Long Living Room Media Library Server Name Extended Across Multiple Wrapped Lines"));
        await openSettings(tv);
        await tv.page.locator('[data-focus="settings-signout"]').click();
        const dialog = tv.page.locator(".confirm-dialog");
        await dialog.waitFor();
        const layout = await dialog.evaluate(node => {
            const scrim = document.querySelector<HTMLElement>(".confirm-dialog-scrim");
            const title = node.querySelector<HTMLElement>(".skyline-confirm-title");
            const cardStyle = getComputedStyle(node);
            const scrimStyle = scrim === null ? null : getComputedStyle(scrim);
            const titleStyle = title === null ? null : getComputedStyle(title);
            return {
                cardAnimation: [cardStyle.animationName, cardStyle.animationDuration, cardStyle.animationTimingFunction],
                scrimAnimation: scrimStyle === null ? null : [scrimStyle.animationName, scrimStyle.animationDuration, scrimStyle.animationTimingFunction],
                webkitLineClamp: titleStyle?.webkitLineClamp ?? "",
                lineHeight: titleStyle === null ? 0 : parseFloat(titleStyle.lineHeight),
                titleHeight: title?.getBoundingClientRect().height ?? 0,
            };
        });
        assert.deepEqual(layout.cardAnimation, ["skyline-appear", "0.2s", "ease-out"]);
        assert.deepEqual(layout.scrimAnimation, ["skyline-appear", "0.2s", "ease-out"]);
        assert.equal(layout.webkitLineClamp, "none");
        assert.ok(layout.titleHeight >= layout.lineHeight * 2.9, `expected >=3 unclamped lines, got height=${layout.titleHeight} lineHeight=${layout.lineHeight}`);
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const reduced = await dialog.evaluate(node => {
            const scrim = document.querySelector<HTMLElement>(".confirm-dialog-scrim");
            return [getComputedStyle(node).animationName, scrim === null ? "" : getComputedStyle(scrim).animationName];
        });
        assert.deepEqual(reduced, ["none", "none"]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});
