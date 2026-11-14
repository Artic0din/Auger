// Poster badge layout against silo-apple 5780c84 CardOverlays.swift, OverlayPresets.swift and OverlayIcon.swift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "./support/tv.ts";

// theme.css's Inter face points at the package path, which fails here and would shadow the embedded face.
const theme = readFileSync(new URL("../../src/theme.css", import.meta.url), "utf8").replace(/@font-face\s*\{[^}]*\}/, "");
const browse = readFileSync(new URL("../../src/ui/browse.css", import.meta.url), "utf8");
const font = readFileSync(new URL("../../app/fonts/InterVariable.woff2", import.meta.url)).toString("base64");
const CAP_SCALE = 0.9685;

let browser: Browser;
let bundle: string;
before(async () => {
    browser = await launchBrowser();
    const built = await build({
        stdin: { contents: `import { overlayLayer, parseOverlayPrefs } from "./src/ui/cardOverlays.ts"; Object.assign(window, { overlayLayer, parseOverlayPrefs });`, resolveDir: new URL("../..", import.meta.url).pathname, loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    bundle = built.outputFiles[0]?.text ?? "";
});
after(async () => { await browser.close(); });

interface Badge { readonly text: string; readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly style: Record<string, string>; readonly ring: Record<string, string>; readonly labelShadow: string; readonly labelSpacing: string; readonly labelWidth: number; readonly labelLeft: number; readonly icon?: { readonly width: number; readonly height: number; readonly path: string; readonly fillRule: string; readonly color: string; readonly frameWidth: number; readonly beforeLabel: boolean }; readonly mark?: { readonly text: string; readonly width: number; readonly height: number; readonly fontSize: string; readonly fontWeight: string; readonly letterSpacing: string; readonly color: string } }
interface Band { readonly edge: string; readonly left: number; readonly right: number; readonly top: number; readonly bottom: number; readonly backgroundImage: string; readonly padding: string; readonly shown: string[]; readonly dividers: { readonly width: number; readonly height: number; readonly color: string; readonly gapBefore: number; readonly gapAfter: number }[]; readonly rowLeft: number; readonly rowRight: number; readonly shownLeft: number; readonly shownRight: number }
interface Render { readonly badges: Badge[]; readonly stacks: Record<string, { left: number; right: number; top: number; bottom: number }>; readonly bands: Band[]; readonly chips: { readonly text: string; readonly color: string; readonly background: string; readonly padding: string; readonly radius: string; readonly height: number; readonly truncated: boolean; readonly overflow: string; readonly textOverflow: string; readonly whiteSpace: string }[] }

/** Renders one card's badge layer on a `width` × `height` artwork at the page origin. */
async function render(doc: unknown, card: Record<string, unknown>, width: number, height: number, variant: "poster" | "wide" = "poster"): Promise<Render> {
    const page: Page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent(`<!doctype html><style>@font-face { font-family: Inter; src: url(data:font/woff2;base64,${font}) format("woff2"); font-weight: 100 900; }</style><main style="font-family:var(--silo-font)"><div class="browse-art" id="art" style="position:absolute;left:0;top:0;width:${width}px;height:${height}px"></div></main>`);
        await page.addStyleTag({ content: `${theme}\n${browse}\n* { transition: none !important; } body { margin: 0; }` });
        await page.addScriptTag({ content: bundle });
        // fonts.ready resolves before anything uses Inter, so load it: labels must measure in Inter, not a fallback.
        const loaded = await page.evaluate(async () => {
            await Promise.all(["600 12px Inter", "700 12px Inter"].map(spec => document.fonts.load(spec)));
            return [...document.fonts].some(face => face.family.replace(/"/g, "") === "Inter" && face.status === "loaded");
        });
        assert.equal(loaded, true, "Inter loaded");
        return await page.evaluate(({ doc, card, width, variant }) => {
            const api = window as unknown as { overlayLayer: (card: unknown, prefs: unknown, variant: string, width: number) => HTMLElement | undefined; parseOverlayPrefs: (raw: unknown) => unknown };
            const layer = api.overlayLayer({ id: "series:1", type: "series", title: "Show", ...card }, api.parseOverlayPrefs(doc), variant, width);
            const art = document.getElementById("art");
            if (layer === undefined || art === null) return { badges: [], stacks: {}, bands: [], chips: [] };
            art.append(layer);
            const props = ["fontSize", "fontWeight", "letterSpacing", "lineHeight", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "borderTopLeftRadius", "borderTopRightRadius", "borderBottomLeftRadius", "borderBottomRightRadius", "backgroundColor", "backgroundImage", "color", "boxShadow", "textShadow", "textTransform"] as const;
            const badges = [...layer.querySelectorAll<HTMLElement>(".card-overlay")].map(node => {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                const svg = node.querySelector("svg");
                const iconRect = svg?.getBoundingClientRect();
                const iconStyle = svg === null ? undefined : getComputedStyle(svg);
                const icon = iconRect === undefined || iconStyle === undefined ? undefined : {
                    width: iconRect.width, height: iconRect.height,
                    color: iconStyle.color,
                    frameWidth: svg?.parentElement?.getBoundingClientRect().width ?? 0,
                    beforeLabel: svg?.parentElement?.nextElementSibling?.classList.contains("card-overlay-label") === true,
                };
                const markNode = node.querySelector<HTMLElement>(".card-overlay-mark");
                const markRect = markNode?.getBoundingClientRect();
                const markStyle = markNode === null ? undefined : getComputedStyle(markNode);
                const ring = getComputedStyle(node, "::before");
                const label = node.querySelector(".card-overlay-label");
                const labelLeft = label?.getBoundingClientRect().left ?? 0;
                return { text: node.textContent ?? "", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, style: Object.fromEntries(props.map(prop => [prop, style[prop]])), ring: { content: ring.content, boxShadow: ring.boxShadow, left: ring.left, right: ring.right, clipPath: ring.clipPath }, labelShadow: label === null ? "" : getComputedStyle(label).textShadow, labelSpacing: label === null ? "" : getComputedStyle(label).letterSpacing, labelWidth: label?.getBoundingClientRect().width ?? 0, labelLeft, ...(icon === undefined ? {} : { icon: { ...icon, path: [...(svg?.querySelectorAll("path") ?? [])].map(path => path.getAttribute("d")).join(" "), fillRule: svg?.querySelector("path") === null || svg?.querySelector("path") === undefined ? "" : getComputedStyle(svg.querySelector("path") as Element).fillRule } }), ...(markNode === null || markRect === undefined || markStyle === undefined ? {} : { mark: { text: markNode.textContent ?? "", width: markRect.width, height: markRect.height, fontSize: markStyle.fontSize, fontWeight: markStyle.fontWeight, letterSpacing: markStyle.letterSpacing, color: markStyle.color } }) };
            });
            const stacks = Object.fromEntries([...layer.querySelectorAll<HTMLElement>(".card-overlay-stack")].map(stack => {
                const name = [...stack.classList].find(cls => cls !== "card-overlay-stack" && cls.startsWith("card-overlay-"))?.slice("card-overlay-".length) ?? "";
                const rect = stack.getBoundingClientRect();
                return [name, { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }];
            }));
            const bands = [...layer.querySelectorAll<HTMLElement>(".card-overlay-band")].map(strip => {
                const rect = strip.getBoundingClientRect();
                const row = strip.querySelector(".card-overlay-band-row")?.getBoundingClientRect();
                const visible = [...strip.querySelectorAll<HTMLElement>(".card-overlay-band-item")].filter(item => row !== undefined && item.getBoundingClientRect().top < row.bottom);
                const shownBadges = visible.map(item => item.querySelector(".card-overlay")?.getBoundingClientRect());
                const dividers = visible.flatMap(item => {
                    const divider = item.querySelector<HTMLElement>(".card-overlay-band-divider");
                    if (divider === null) return [];
                    const box = divider.getBoundingClientRect();
                    const before = (item.previousElementSibling?.querySelector(".card-overlay") as HTMLElement | null)?.getBoundingClientRect();
                    const after = item.querySelector(".card-overlay")?.getBoundingClientRect();
                    return [{ width: box.width, height: box.height, color: getComputedStyle(divider).backgroundColor, gapBefore: box.left - (before?.right ?? 0), gapAfter: (after?.left ?? 0) - box.right }];
                });
                return { edge: strip.classList.contains("card-overlay-band-top") ? "top" : "bottom", left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, backgroundImage: getComputedStyle(strip).backgroundImage, padding: getComputedStyle(strip).padding, shown: visible.map(item => item.querySelector(".card-overlay")?.textContent ?? ""), dividers, rowLeft: row?.left ?? 0, rowRight: row?.right ?? 0, shownLeft: Math.min(...shownBadges.map(box => box?.left ?? 0)), shownRight: Math.max(...shownBadges.map(box => box?.right ?? 0)) };
            });
            const chips = [...layer.querySelectorAll<HTMLElement>(".card-overlay-chip")].map(chip => { const style = getComputedStyle(chip); return { text: chip.textContent ?? "", color: style.color, background: style.backgroundColor, padding: style.padding, radius: style.borderTopLeftRadius, height: chip.getBoundingClientRect().height, truncated: chip.scrollWidth > chip.clientWidth, overflow: style.overflowX, textOverflow: style.textOverflow, whiteSpace: style.whiteSpace }; });
            return { badges, stacks, bands, chips };
        }, { doc, card, width, variant });
    } finally { await page.close(); }
}

const near = (actual: number | undefined, expected: number, message: string, tolerance = 0.51): void => assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${message}: ${actual} for ${expected}`);
const px = (value: string | undefined): number => parseFloat(value ?? "");
const only = (items: Record<string, unknown>) => ({ version: 2, preset: "classic", order: [], items: { resolution: { enabled: false, position: "top-left" }, hdr: { enabled: false, position: "top-left" }, audio: { enabled: false, position: "top-left" }, release_type: { enabled: false, position: "bottom-left" }, ...items } });
const RETURNING = { showStatus: "returning series" };

// tvOS 27.3 ImageRenderer at 8x: native boxes at 10.2pt semibold, not square font-size boxes.
// OverlayIcon.swift:29-54, OverlayPresets.swift:95-104 at silo-apple 08ff656.
for (const symbol of [
    { name: "display", label: "1080p", width: 14.75, height: 12.25, labelOffset: 26.75 },
    { name: "speaker.wave.2.fill", label: "EAC3", width: 15.125, height: 10.875, labelOffset: 27.125 },
]) {
    test(`Vibrant ${symbol.name} uses its native symbol box and label x offset`, async () => {
        for (const width of [185, 220, 260]) {
            const scale = width / 185;
            const { badges } = await render({ ...only({ resolution: { enabled: true }, audio: { enabled: true } }), preset: "vibrant" }, { overlay: { resolution: "1080p", audio: "EAC3" } }, width, width * 1.5);
            assert.deepEqual(badges.map(badge => badge.text), ["1080p", "EAC3"]);
            const badge = badges.find(badge => badge.text === symbol.label);
            assert.ok(badge?.icon, `${symbol.name} has a symbol`);
            near(badge.icon.width, symbol.width * scale, `${symbol.name} symbol box width`, 0.05);
            near(badge.icon.height, symbol.height * scale, `${symbol.name} symbol box height`, 0.05);
            near(badge.icon.frameWidth, symbol.width * scale, `${symbol.name} keeps its advance width`, 0.05);
            near(badge.labelLeft - badge.left, symbol.labelOffset * scale, `${symbol.name} label x offset`, 0.05);
            assert.equal(badge.icon.color, badge.style.color);
            assert.equal(badge.icon.color, "rgb(0, 0, 0)");
            assert.equal(badge.icon.beforeLabel, true, "symbol precedes its label");
        }
    });
}

for (const preset of ["plate", "band"] as const) {
    test(`${preset} keeps generic symbol boxes with preset, item and style overrides`, async () => {
        const width = 220, scale = width / 185;
        for (const symbol of [
            { id: "resolution", value: "1080p", width: 14.75, height: 12.25 },
            { id: "audio", value: "EAC3", width: 15.125, height: 10.875 },
        ]) {
            for (const config of [
                { showIcon: undefined, size: 1 },
                { showIcon: true, size: 1 },
                { showIcon: false, size: 1 },
                { showIcon: true, size: 1.5 },
            ]) {
                const styled = config.size !== 1;
                const { badges } = await render({
                    ...only({ [symbol.id]: { enabled: true, showIcon: config.showIcon } }), preset,
                    ...(styled ? { style: { size: config.size, textColor: "#abcdef", fontWeight: "regular", uppercase: false } } : {}),
                }, { overlay: { [symbol.id]: symbol.value } }, width, 330);
                const badge = badges[0];
                assert.equal(badge?.text, symbol.value, "a generic symbol keeps its label");
                const shown = config.showIcon ?? preset === "plate";
                if (!shown) {
                    assert.equal(badge?.icon, undefined, "the item overrides the preset's icon preference");
                    continue;
                }
                assert.ok(badge?.icon);
                // Measured at a 12pt icon size; both presets use 13pt before the style and poster scales.
                const iconScale = 13 / 12 * config.size * scale;
                near(badge.icon.width, symbol.width * iconScale, "native symbol width", 0.05);
                near(badge.icon.height, symbol.height * iconScale, "native symbol height", 0.05);
                near(badge.icon.frameWidth, symbol.width * iconScale, "the frame preserves a wider glyph", 0.05);
                near(badge.labelLeft - badge.left, px(badge.style.paddingLeft) + symbol.width * iconScale + (preset === "plate" ? 5 : 3) * config.size * scale, "symbol and gap precede the label", 0.05);
                assert.equal(badge.icon.beforeLabel, true);
                assert.equal(badge.icon.color, badge.style.color);
                assert.equal(badge.mark, undefined, "a symbol never becomes a wordmark");
                if (styled) {
                    assert.equal(badge.icon.color, "rgb(171, 205, 239)");
                    assert.equal(badge.style.fontWeight, "400");
                }
            }
        }
    });
}

test("generic badges use Apple's registry symbols and honour per-item icon overrides", async () => {
    // OverlayRegistry.swift:115-249, :300-318, :349-382, :436-455 at 08ff656.
    const cases: readonly [string, Record<string, unknown>, string][] = [
        ["audio_channels", { overlay: { audioChannels: "5.1" } }, "M10 17.125H18.5"],
        ["video_codec", { overlay: { videoCodec: "HEVC" } }, "M4 3H20"],
        ["aspect_ratio", { overlay: { aspectRatio: "1.78" } }, "M4 5H20"],
        ["multi_audio", { overlay: { multiAudio: true } }, "M2 5H14"],
        ["multi_sub", { overlay: { multiSub: true } }, "M3 4H21"],
        ["content_rating", { contentRating: "PG" }, "M12 2C15 4"],
        ["advisory_age", { advisoryAge: 12 }, "M4.2 2.1"],
        ["runtime", { runtimeMinutes: 90 }, "M12 2A10"],
        ["original_language", { originalLanguage: "en" }, "M12 2A10"],
        ["studio", { studios: ["Studio"] }, "M3 21V7"],
        ["network", { networks: ["Network"] }, "M"],
    ];
    for (const [id, card, path] of cases) {
        const shown = await render(only({ [id]: { enabled: true, showIcon: true } }), card, 185, 277.5);
        assert.equal(shown.badges.length, 1, id);
        assert.ok(shown.badges[0]?.icon?.path.includes(path), `${id} has its registry symbol`);
        assert.equal(shown.badges[0]?.icon?.color, shown.badges[0]?.style.color, id);
        assert.equal(shown.badges[0]?.mark, undefined, `${id} keeps its text label instead of becoming a wordmark`);
    }
    const hidden = await render({ ...only({ resolution: { enabled: true, showIcon: false }, audio: { enabled: true, showIcon: false } }), preset: "vibrant" }, { overlay: { resolution: "1080p", audio: "EAC3" } }, 185, 277.5);
    assert.deepEqual(hidden.badges.map(badge => badge.icon), [undefined, undefined], "showIcon false overrides an icon preset");
    const missing = await render({ ...only({ resolution: { enabled: true }, audio: { enabled: true } }), preset: "vibrant" }, {}, 185, 277.5);
    assert.deepEqual(missing.badges, [], "missing metadata does not leave orphan icons");
});
/**
 * Inter's per-letter shortfall against SF Pro Text at badge sizes, in em of Apple's point size: CoreText SF Pro
 * advances against InterVariable at the cap-scaled size, over twelve badge labels from 8 to 14pt.
 */
const interShortfall = (points: number, weight: 600 | 700): number => Math.max(0, (weight === 600 ? 0.044 : 0.051) - 0.0062 * (points - 10));

// Search's 220 × 330 poster (issue #453): Apple draws the badge about 165 below the top.
test("a stored top-right status badge is a classic tab flush on the right rail, centred down the poster", async () => {
    const width = 220;
    const scale = width / 185;
    const { badges } = await render(only({ show_status: { enabled: true, position: "top-right" } }), RETURNING, width, 330);
    assert.equal(badges.length, 1);
    const [badge] = badges;
    assert.equal(badge?.text, "Returning");
    near(badge?.right, width, "flush against the right edge (CardOverlays.swift:75-78, :101-106)");
    near(((badge?.top ?? 0) + (badge?.bottom ?? 0)) / 2, 165, "centred on the side edge");
    // OverlayPresets.swift:57-85: 10pt semibold, tracking-wide, 8 × 2 padding, capsule, a 1pt white 15% border.
    near((badge?.bottom ?? 0) - (badge?.top ?? 0), (10 + 2 * 2 + 1 * 2) * scale, "font line, padding and border (CardOverlays.swift:392-398, :430-438)", 0.05);
    near(px(badge?.style.fontSize), 10 * scale * CAP_SCALE, "font size", 0.02);
    near(px(badge?.style.lineHeight), 10 * scale, "leading-none line", 0.02);
    // CardOverlays.swift:433 tracks every label by trackingEm × the font size; the label must not take theme.css's -0.015em.
    near(px(badge?.labelSpacing), (0.025 + interShortfall(10 * scale, 600)) * 10 * scale, "tracking-wide plus Inter's shortfall", 0.01);
    // SF Pro semibold 11.89pt "RETURNING" with 0.3pt tracking is 73.43pt wide (CoreText, macOS SF Pro); the S95C drew ≈60.
    near(badge?.labelWidth, 73.43, "Apple's word width", 1.5);
    assert.equal(badge?.style.fontWeight, "600");
    assert.equal(badge?.style.textTransform, "uppercase");
    near(px(badge?.style.paddingLeft), (8 + 1) * scale, "inline padding and the border outside it", 0.02);
    near(px(badge?.style.paddingRight), 8 * scale, "no border padding on the flush side", 0.02);
    near(px(badge?.style.paddingTop), (2 + 1) * scale, "block padding and the border", 0.02);
    // strokeBorder at 1 × scale, unsnapped; on a tab it runs past the card edge and is clipped (CardOverlays.swift:409-418).
    assert.match(badge?.ring.boxShadow ?? "", /rgba\(255, 255, 255, 0\.15\) 0px 0px 0px 1\.19px inset/);
    assert.equal(badge?.ring.right, "-1.19px");
    assert.equal(badge?.ring.clipPath, "inset(0px 1.19px 0px 0px)");
    assert.equal(badge?.style.borderTopRightRadius, "0px", "a tab's flush corners are square");
    assert.equal(badge?.style.borderBottomRightRadius, "0px");
    assert.equal(badge?.style.borderTopLeftRadius, "999px", "capsule on the open side");
    assert.equal(badge?.style.backgroundColor, "rgba(0, 0, 0, 0.6)");
    assert.equal(badge?.style.color, "rgb(255, 255, 255)");
});

test("ratings default to the left rail as tabs and a filled accent mixes like CSS color-mix", async () => {
    const { badges } = await render(only({ rating_imdb: { enabled: true } }), { ratingImdb: 8.46 }, 185, 277.5);
    const [badge] = badges;
    assert.equal(badge?.text, "IMDb 8.5");
    near(badge?.left, 0, "flush against the left edge");
    near(((badge?.top ?? 0) + (badge?.bottom ?? 0)) / 2, 277.5 / 2, "centred on the side edge");
    assert.equal(badge?.ring.left, "-1px", "the left tab's ring runs past the left edge");
    assert.equal(badge?.style.paddingLeft, "8px", "no border padding on the flush side");
    assert.equal(badge?.style.borderTopLeftRadius, "0px");
    // #f5c518 at 28% over black 60%, premultiplied (OverlayColor.swift:52-67): alpha .712, which Chromium stores as 182 / 255.
    assert.equal(badge?.style.backgroundColor, "rgba(96, 77, 9, 0.714)");
});

test("the top-left corner stops short of the watch-status corner and draws three badges at most", async () => {
    const width = 260;
    const scale = width / 185;
    const doc = { version: 2, preset: "classic", order: [], items: { video_codec: { enabled: true, position: "top-left" } } };
    const { badges, stacks } = await render(doc, { overlay: { resolution: "2160p", hdr: "HDR10", audio: "TrueHD Atmos", videoCodec: "HEVC" } }, width, 390);
    assert.deepEqual(badges.map(badge => badge.text), ["4K", "HDR10", "TrueHD Atmos"], "maxBadgesPerCorner (CardOverlays.swift:35)");
    near(stacks["top-left"]?.left, 8 * scale, "edge inset");
    near(stacks["top-left"]?.top, 8 * scale, "edge inset");
    near(stacks["top-left"]?.right, width - (8 + 22 + 8) * scale, "inset plus CardWatchStatus.size plus the edge gap (CardOverlays.swift:68-72)");
    const wide = await render(doc, { overlay: { resolution: "2160p" } }, 400, 225, "wide");
    near(wide.stacks["top-left"]?.right, 400 - 8, "wide cards draw no watch status");
});

test("a rail draws four badges at most within 60% of the card width", async () => {
    const doc = only({ rating_imdb: { enabled: true }, rating_tmdb: { enabled: true }, rating_rt: { enabled: true }, rating_rt_audience: { enabled: true }, network: { enabled: true, position: "left-edge" } });
    const { badges } = await render(doc, { ratingImdb: 7, ratingTmdb: 6, ratingRtCritic: 90, ratingRtAudience: 80, networks: ["A Very Long Network Name Indeed"] }, 185, 277.5);
    assert.deepEqual(badges.map(badge => badge.text), ["IMDb 7.0", "TMDB 6.0", "RT 90%", "RT Audience 80%"], "maxBadgesPerRail (CardOverlays.swift:36)");
    const long = await render(only({ network: { enabled: true, position: "left-edge" } }), { networks: ["A Very Long Network Name Indeed"] }, 185, 277.5);
    assert.ok((long.badges[0]?.right ?? 999) <= 185 * 0.6 + 0.5, `railMaxWidth (CardOverlays.swift:38, :97): ${long.badges[0]?.right}`);
});

test("the bottom corners share a row and a pair too wide wraps the right badge onto its own line", async () => {
    const width = 220;
    const scale = width / 185;
    const doc = only({ release_type: { enabled: true, position: "bottom-left" }, content_rating: { enabled: true, position: "bottom-right" } });
    const shared = await render(doc, { overlay: { releaseType: "WEB-DL" }, contentRating: "PG-13" }, width, 330);
    const [left, right] = shared.badges;
    near(left?.left, 8 * scale, "bottom-left inset");
    near(right?.right, width - 8 * scale, "bottom-right inset");
    near(left?.bottom, 330 - 8 * scale, "bottom inset");
    near(right?.bottom, 330 - 8 * scale, "one row");
    const wrapped = await render(only({ edition: { enabled: true, position: "bottom-left" }, studio: { enabled: true, position: "bottom-right" } }), { overlay: { edition: "Extended Director's Cut" }, studios: ["Long Studio Name"] }, 120, 180);
    const [edition, studio] = wrapped.badges;
    assert.ok((studio?.top ?? 0) >= (edition?.bottom ?? 999) - 0.5, `the right badge wraps below (CardOverlays.swift:238-290): ${JSON.stringify(wrapped.badges.map(b => [b.top, b.bottom]))}`);
    near(studio?.right, 120 - 8 * 120 / 185, "the wrapped badge stays on the right");
    near(studio?.bottom, 180 - 8 * 120 / 185, "the lower row sits on the bottom inset");
});

test("minimal keeps its rails inset with the text shadow; vibrant and pill paint the web's colours", async () => {
    const scale = 220 / 185;
    const minimal = await render({ ...only({ show_status: { enabled: true } }), preset: "minimal" }, RETURNING, 220, 330);
    near(minimal.badges[0]?.right, 220 - 8 * scale, "a transparent badge keeps the corner inset (CardOverlays.swift:75-78)");
    assert.equal(minimal.badges[0]?.style.color, "rgba(255, 255, 255, 0.85)");
    near(px(minimal.badges[0]?.labelSpacing), (0.1 + interShortfall(9 * scale, 600)) * 9 * scale, "tracking-widest", 0.01);
    assert.match(minimal.badges[0]?.labelShadow ?? "", /rgba\(0, 0, 0, 0\.85\) 0px 1\.19px 2\.38px/);
    const vibrant = await render({ ...only({ show_status: { enabled: true } }), preset: "vibrant" }, RETURNING, 220, 330);
    assert.equal(vibrant.badges[0]?.style.backgroundColor, "rgba(220, 220, 220, 0.95)");
    assert.equal(vibrant.badges[0]?.style.color, "rgb(0, 0, 0)");
    assert.equal(vibrant.badges[0]?.style.fontWeight, "700");
    near(px(vibrant.badges[0]?.labelSpacing), (0.025 + interShortfall(10 * scale, 700)) * 10 * scale, "bold tracking-wide", 0.01);
    assert.match(vibrant.badges[0]?.style.boxShadow ?? "", /rgba\(0, 0, 0, 0\.25\) 0px 1\.19px 2\.38px/);
    near(px(vibrant.badges[0]?.style.borderTopLeftRadius), 10 * scale, "the web default theme's vibrant radius", 0.02);
    // OverlayIcon.swift:29-36: the symbol at 85% of iconSize, at least iconSize wide.
    near(vibrant.badges[0]?.icon?.width, 12 * 0.85 * 73 / 48 * scale, "tv symbol width", 0.05);
    const pill = await render({ ...only({ show_status: { enabled: true, accentColor: "#00ff00" } }), preset: "pill" }, RETURNING, 220, 330);
    assert.equal(pill.badges[0]?.style.backgroundColor, "rgba(15, 82, 22, 0.76)", "#00ff00 at 20% over rgb(20 20 30 / .7), premultiplied");
    near(px(pill.badges[0]?.style.paddingTop), (4 + 1) * scale, "pill block padding and border", 0.02);
    near(px(pill.badges[0]?.style.paddingLeft), (10 + 1) * scale, "pill inline padding and border", 0.02);
});

test("square draws its accent bar on the left side except on a left-rail tab", async () => {
    const scale = 185 / 185;
    const right = await render({ ...only({ show_status: { enabled: true, accentColor: "#ff0000" } }), preset: "square" }, RETURNING, 185, 277.5);
    assert.equal(right.badges[0]?.style.color, "rgb(255, 0, 0)");
    assert.equal(right.badges[0]?.style.backgroundColor, "rgba(0, 0, 0, 0.8)");
    assert.match(right.badges[0]?.style.backgroundImage ?? "", /linear-gradient/);
    near(px(right.badges[0]?.style.paddingLeft), (6 + 2) * scale, "inline padding plus the 2pt bar", 0.02);
    near(px(right.badges[0]?.style.borderTopLeftRadius), 8 * scale, "the web default theme's square radius", 0.02);
    const left = await render({ ...only({ rating_imdb: { enabled: true } }), preset: "square" }, { ratingImdb: 7 }, 185, 277.5);
    assert.equal(left.badges[0]?.style.backgroundImage, "none", "a left tab drops the bar (CardOverlays.swift:374)");
    assert.equal(left.badges[0]?.ring.content, "none", "square has no border");
    near(px(left.badges[0]?.style.paddingLeft), 6 * scale, "no bar padding", 0.02);
});

// OverlayRegistry.swift:15-30, :63-101, :136-173 at silo-apple 5780c84.
test("the combined Resolution + HDR + Audio badge shows the parts the file has and hides the badges it covers", async () => {
    const doc = { version: 2, preset: "classic", order: [], items: { resolution_hdr_audio: { enabled: true, position: "top-left" }, resolution_hdr: { enabled: true, position: "top-left" } } };
    const both = await render(doc, { overlay: { resolution: "2160p", hdr: "DV HDR10", audio: "TrueHD Atmos" } }, 185, 277.5);
    assert.deepEqual(both.badges.map(badge => badge.text), ["4K DV TrueHD Atmos"], "covers resolution, hdr, audio and resolution_hdr (:19-22)");
    const audioOnly = await render(doc, { overlay: { audio: "EAC3" } }, 185, 277.5);
    assert.deepEqual(audioOnly.badges.map(badge => badge.text), ["EAC3"], "a file without a resolution still shows its audio (:159-166)");
    const pair = await render({ version: 2, preset: "classic", order: [], items: { resolution_hdr: { enabled: true, position: "top-left" } } }, { overlay: { resolution: "2160p", hdr: "HDR10+", audio: "AAC" } }, 185, 277.5);
    assert.deepEqual(pair.badges.map(badge => badge.text), ["4K HDR10+", "AAC"], "compactHdrSuffix keeps HDR10+ (:63-69)");
});

// OverlayIcon.swift:14-28, :60-83 and CardOverlays.swift:196-202 at silo-apple 5780c84.
test("wordmarks are black-weight text at 10/12 of the icon size, ATMOS at 9/12 with half a unit of tracking", async () => {
    const scale = 220 / 185;
    const icons = (items: Record<string, unknown>) => ({ ...only(items), preset: "pill" });
    const hdr = await render(icons({ hdr: { enabled: true, position: "top-left" } }), { overlay: { hdr: "HDR10" } }, 220, 330);
    const mark = hdr.badges[0]?.mark;
    assert.equal(hdr.badges[0]?.text, "HDR10", "the label repeating the wordmark is dropped");
    assert.equal(mark?.text, "HDR10");
    assert.equal(mark?.fontWeight, "900");
    near(px(mark?.fontSize), 12 * 10 / 12 * scale * CAP_SCALE, "pill iconSize 12, 10 units of 12", 0.02);
    near(mark?.height, 12 * scale, "an iconSize-high frame", 0.05);
    // CoreText SF Pro black 10pt "HDR10" is 36.85 wide and 11.89pt about 43.16; Inter 900 at the cap-scaled size runs short.
    near(mark?.width, 43.16, "Apple's mark width", 0.4);
    const reference = await render(icons({ hdr: { enabled: true, position: "top-left" } }), { overlay: { hdr: "HDR10" } }, 185, 277.5);
    near(reference.badges[0]?.mark?.width, 36.85, "Apple's mark width at the reference poster", 0.4);
    assert.equal(mark?.color, "rgb(255, 255, 255)", "the badge's text colour");
    const atmos = await render(icons({ audio: { enabled: true, position: "top-left" } }), { overlay: { audio: "Atmos" } }, 220, 330);
    near(px(atmos.badges[0]?.mark?.fontSize), 12 * 9 / 12 * scale * CAP_SCALE, "ATMOS at 9 units", 0.02);
    // SF Pro black 9pt "ATMOS" is 35.60 wide before Apple's 0.5-unit tracking on each of its five letters.
    const atmosReference = await render(icons({ audio: { enabled: true, position: "top-left" } }), { overlay: { audio: "Atmos" } }, 185, 277.5);
    near(atmosReference.badges[0]?.mark?.width, 35.60 + 5 * 0.5, "ATMOS width with its tracking", 0.4);
    const truehd = await render(icons({ audio: { enabled: true, position: "top-left" } }), { overlay: { audio: "TrueHD Atmos" } }, 220, 330);
    assert.equal(truehd.badges[0]?.mark, undefined, "ATMOS only for a value it fully expresses (OverlayRegistry.swift:90-96)");
    assert.equal(truehd.badges[0]?.text, "TrueHD Atmos");
});

test("Dolby Vision is a drawn ring with its right half filled, beside the whole label", async () => {
    const scale = 220 / 185;
    const dv = await render({ ...only({ hdr: { enabled: true, position: "top-left" } }), preset: "pill" }, { overlay: { hdr: "DV HDR10" } }, 220, 330);
    const badge = dv.badges[0];
    assert.equal(badge?.text, "DV HDR10", "DV has no wordmark, so the label always shows (OverlayTypes.swift:254-266)");
    assert.equal(badge?.mark, undefined);
    near(badge?.icon?.width, 12 * scale, "an iconSize square", 0.05);
    near(badge?.icon?.height, 12 * scale, "an iconSize square", 0.05);
    assert.equal(badge?.icon?.path, "M14 8A6 6 0 1 1 2 8A6 6 0 1 1 14 8ZM8 3.5A4.5 4.5 0 0 0 8 12.5Z", "a 6-unit disc less the left half of a 4.5-unit one, in 16 units");
    assert.equal(badge?.icon?.fillRule, "evenodd");
});

// OverlayPresets.swift:174-201 and CardOverlays.swift:364-449 at silo-apple 5780c84.
test("plate draws a heavy rounded plate, and a rating's source as an accent chip ahead of its score", async () => {
    const scale = 220 / 185;
    const { badges, chips } = await render({ ...only({ rating_imdb: { enabled: true } }), preset: "plate" }, { ratingImdb: 8.46 }, 220, 330);
    const badge = badges[0];
    assert.equal(badge?.text, "IMDb8.5", "the chip, then the bare score");
    assert.equal(badge?.style.fontWeight, "800");
    near(px(badge?.style.fontSize), 12 * scale * CAP_SCALE, "12pt", 0.02);
    assert.equal(badge?.style.backgroundColor, "rgba(0, 0, 0, 0.72)");
    assert.equal(badge?.style.borderTopRightRadius, "7.14px", "a left-rail tab, 6pt corners on its open side");
    assert.match(badge?.style.boxShadow ?? "", /rgba\(0, 0, 0, 0\.35\) 0px 2\.38px 7\.14px/);
    assert.match(badge?.ring.boxShadow ?? "", /rgba\(245, 197, 24, 0\.45\) 0px 0px 0px 1\.19px inset/, "the accent at 45% on the border");
    near(px(badge?.style.paddingRight), (7 + 1) * scale, "inline padding and the border", 0.02);
    const chip = chips[0];
    assert.equal(chip?.text, "IMDb");
    assert.equal(chip?.background, "rgb(245, 197, 24)");
    assert.equal(chip?.color, "rgb(0, 0, 0)", "black reads on IMDb yellow (OverlayColor.swift:84-87)");
    assert.equal(chip?.padding, `${Math.round(12 * 0.15 * scale * 100) / 100}px ${Math.round(12 * 0.35 * scale * 100) / 100}px`);
    near(px(chip?.radius), 12 * 0.2 * scale, "0.2 of the font size", 0.02);
    near(chip?.height, 12 * 1.3 * scale, "the line and its block padding", 0.1);
    const plain = await render({ ...only({ rating_imdb: { enabled: true } }), preset: "classic" }, { ratingImdb: 8.46 }, 220, 330);
    assert.equal(plain.chips.length, 0, "other presets keep the one label");
});

for (const rating of [
    { name: "IMDb at size 2", id: "rating_imdb", card: { ratingImdb: 8.46 }, source: "IMDb", score: "8.5", size: 2 },
    { name: "RT Audience at default size", id: "rating_rt_audience", card: { ratingRtAudience: 80 }, source: "RT Audience", score: "80%", size: 1 },
]) {
    test(`Plate right-rail ${rating.name} truncates its source and keeps the whole score inside the poster`, async () => {
        const width = 185;
        const { badges, chips, stacks } = await render({ ...only({ [rating.id]: { enabled: true, position: "right-edge" } }), preset: "plate", style: { size: rating.size } }, rating.card, width, width * 1.5);
        const badge = badges[0];
        const chip = chips[0];
        assert.ok(badge);
        assert.ok(chip);
        assert.equal(badge.text, rating.source + rating.score);
        near(badge.right, width, "Plate tab is flush with the poster's right edge");
        assert.ok(badge.labelLeft >= badge.left, "score starts inside the plate");
        assert.ok(badge.labelLeft + badge.labelWidth <= badge.right - px(badge.style.paddingRight) + 0.02,
            `whole score ends inside the plate: ${badge.labelLeft + badge.labelWidth} <= ${badge.right - px(badge.style.paddingRight)}`);
        assert.ok(badge.labelLeft + badge.labelWidth <= width, "whole score stays inside the poster");
        assert.ok(badge.right - badge.left <= width * 0.6 + 0.02, "plate respects the rail's 60% maximum width");
        near(stacks["right-edge"]?.right, width, "right rail stays on the poster edge");
        assert.equal(chip.truncated, true, "source text exceeds its rendered chip width");
        assert.equal(chip.whiteSpace, "nowrap", "source stays on one line");
        assert.equal(chip.overflow, "hidden", "source is clipped to the chip");
        assert.equal(chip.textOverflow, "ellipsis", "source truncates at the tail");
    });
}

// OverlayPresets.swift:203-226 and CardOverlays.swift:74-119, :146-157, :295-330.
test("the edge band draws each edge as one strip of marks with dividers over a scrim", async () => {
    const width = 220, scale = width / 185;
    const doc = { version: 2, preset: "band", order: [], items: { video_codec: { enabled: true, position: "top-left" }, year: { enabled: true, position: "bottom-left" }, studio: { enabled: true, position: "bottom-right" } } };
    const { bands, badges } = await render(doc, { year: 2024, studios: ["A24"], overlay: { resolution: "1080p", hdr: "HDR10", audio: "AAC", videoCodec: "HEVC", releaseType: "WEB-DL" } }, width, 330);
    const top = bands.find(band => band.edge === "top");
    const bottom = bands.find(band => band.edge === "bottom");
    assert.ok(top !== undefined && bottom !== undefined);
    near(top.left, 0, "the strip spans the edge");
    near(top.right, width, "the strip spans the edge");
    near(top.top, 0, "from the top edge");
    const inset = Math.round(8 * scale * 100) / 100;
    assert.equal(top.padding, `${inset}px ${Math.round((8 + 22 + 8) * scale * 100) / 100}px ${Math.round(24 * scale * 100) / 100}px ${inset}px`, "inset, the watch-status clearance and three insets below");
    assert.equal(top.backgroundImage, "linear-gradient(rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.6) 55%, rgba(0, 0, 0, 0) 100%)");
    assert.equal(bottom.backgroundImage, "linear-gradient(to top, rgba(0, 0, 0, 0.85) 0%, rgba(0, 0, 0, 0.6) 55%, rgba(0, 0, 0, 0) 100%)");
    near(bottom.bottom, 330, "to the bottom edge");
    assert.deepEqual(bottom.shown, ["WEB-DL", "2024", "A24"], "one strip for the whole bottom edge, left corner first");
    near((bottom.shownLeft + bottom.shownRight) / 2, width / 2, "centred", 0.6);
    assert.equal(top.dividers.length, top.shown.length - 1);
    const divider = top.dividers[0];
    near(divider?.width, 1, "a 1pt divider, unscaled");
    near(divider?.height, 12.5 * 0.9 * scale, "0.9 of the font size", 0.05);
    assert.equal(divider?.color, "rgba(255, 255, 255, 0.4)");
    near(divider?.gapBefore, 7 * scale, "the stack gap on each side", 0.05);
    near(divider?.gapAfter, 7 * scale, "the stack gap on each side", 0.05);
    const mark = badges.find(badge => badge.text === "1080P" || badge.text === "1080p");
    assert.equal(mark?.style.fontWeight, "800");
    assert.equal(mark?.style.backgroundColor, "rgba(0, 0, 0, 0)");
    near(px(mark?.style.paddingLeft), 0, "no inline padding", 0.01);
    near(px(mark?.style.paddingTop), 1 * scale, "1pt block padding", 0.02);
    assert.match(mark?.labelShadow ?? "", /rgba\(0, 0, 0, 0\.75\) 0px 1\.19px 3\.57px/);
    // CoreText SF Pro heavy at 14.86pt with tracking-wide: 1080P 50.93, HDR10 53.25, AAC 33.93, plus two dividers and
    // their gaps, is 173.4 against a 165.3 row, so Apple drops AAC too.
    assert.deepEqual(top.shown, ["1080p", "HDR10"], "the marks that fit whole");
    const narrow = await render(doc, { overlay: { resolution: "1080p", hdr: "HDR10", audio: "TrueHD Atmos" } }, 150, 225);
    const strip = narrow.bands.find(band => band.edge === "top");
    assert.deepEqual(strip?.shown, ["1080p", "HDR10"], "TrueHD Atmos does not fit whole, so it is dropped with its divider");
    assert.equal(strip?.dividers.length, 1);
    assert.ok((strip?.shownRight ?? Infinity) <= (strip?.rowRight ?? 0) + 0.01, "the marks shown stay inside the row");
    const alone = await render(doc, { overlay: { audio: "Dolby TrueHD Atmos 7.1 Lossless" } }, 150, 225);
    const cut = alone.badges.find(badge => badge.text.startsWith("Dolby"));
    assert.ok(cut !== undefined && cut.labelWidth < 150 - (8 + 38) * 150 / 185 + 0.5, "only a first mark too wide on its own truncates");
});

test("the edge band keeps its rails inset, and a style turns capitals off", async () => {
    const width = 185;
    const banded = await render({ ...only({ show_status: { enabled: true } }), preset: "band" }, RETURNING, width, 277.5);
    near(banded.badges[0]?.right, width - 8, "a band rail keeps the corner inset (CardOverlays.swift:77)");
    const lower = await render({ ...only({ show_status: { enabled: true } }), preset: "classic", style: { uppercase: false, size: 1.5 } }, RETURNING, width, 277.5);
    assert.equal(lower.badges[0]?.style.textTransform, "none");
    near(px(lower.badges[0]?.style.fontSize), 15 * CAP_SCALE, "size 1.5", 0.02);
});
