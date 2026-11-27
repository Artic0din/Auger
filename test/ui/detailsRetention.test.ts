import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { build } from "esbuild";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY, TITLE_ART_KEY } from "../../src/contracts/v2/settings.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { afterPaint, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LOCAL_TRAILER = { content_id: "extra:1", title: "Official Trailer", kind: "trailer", duration: 90 };
const BOX_SET = {
    id: "1241",
    library_id: "12",
    title: "Harbor Collection",
    overview: "Coastal stories.",
    poster_url: "/art/potter.svg",
    movie_count: 2,
    played_count: 0,
    first_year: 2020,
    last_year: 2022,
    items: [
        { content_id: "movie:m0001", type: "movie", title: "The Last Signal", year: 2020, poster_url: "/art/hp1.svg" },
        { content_id: "movie:m0002", type: "movie", title: "Second Signal", year: 2022, poster_url: "/art/hp2.svg" },
    ],
};

async function startDetails(prepare?: (tv: Tv, details: FakeDetails, settings: FakeSettings) => Promise<void> | void): Promise<{ tv: Tv; details: FakeDetails; settings: FakeSettings }> {
    const tv = await openTv(browser, { app: "browse", locale: "en-AU" });
    const details = new FakeDetails();
    tv.fake.catalog = details;
    const settings = new FakeSettings(tv.fake);
    await prepare?.(tv, details, settings);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(() => window.browseHarness.mount());
    await tv.page.locator('[data-view="home"] .browse-card').first().waitFor();
    if (!tv.fake.heldReplies) {
        await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith("/settings/values/effective?") && request.path.includes("keys=ui.title_art")), "Home title-art read");
        await afterPaint(tv);
    }
    return { tv, details, settings };
}

async function routeSeries(tv: Tv, details: FakeDetails): Promise<void> {
    const listed = details.route("GET", "/catalog/series/series%3As1/seasons", "p-owner")?.body as { items: Record<string, unknown>[] };
    const episodes = details.route("GET", "/catalog/series/series%3As1/seasons/1/episodes", "p-owner")?.body as { items: Record<string, unknown>[] };
    const seriesBody = details.route("GET", "/catalog/items/series%3As1", "p-owner")?.body as Record<string, unknown>;
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons?**", route => route.fulfill({
        json: { items: [{ ...listed.items[0], content_id: "season:1", season_number: 1, title: "Season 1", episode_count: 4 }] },
    }));
    await tv.page.route("**/api/v2/catalog/series/series%3As1/seasons/1/episodes?**", route => route.fulfill({
        json: {
            items: Array.from({ length: 4 }, (_, index) => ({
                ...episodes.items[0],
                content_id: `episode:ret:${index + 1}`,
                season_number: 1,
                episode_number: index + 1,
                title: `Chapter ${index + 1}`,
                overview: `Overview for chapter ${index + 1}.`,
                air_date: `2024-02-0${index + 1}`,
                runtime: 40 + index,
            })),
        },
    }));
    await tv.page.route("**/api/v2/catalog/items/series%3As1?**", route => route.fulfill({
        json: { ...seriesBody, logo_url: "/art/last-signal-logo.svg", extras: [LOCAL_TRAILER] },
    }));
    await tv.page.route("**/api/v2/catalog/items/episode%3Aret%3A*", route => {
        const match = /episode%3Aret%3A(\d+)/.exec(route.request().url());
        const num = Number(match?.[1] ?? "1");
        const epTemplate = details.route("GET", "/catalog/items/episode%3As1e11", "p-owner")?.body as Record<string, unknown>;
        return route.fulfill({
            json: {
                ...epTemplate,
                content_id: `episode:ret:${num}`,
                season_number: 1,
                episode_number: num,
                title: `Chapter ${num}`,
                overview: `Detailed synopsis ${num}.`,
                backdrop_url: "/art/harbor.svg",
            },
        });
    });
}

test("moving focus along series episodes retains unchanged backdrop, wash, title, cast, trailers, related and facts DOM nodes", async () => {
    const { tv, details } = await startDetails();
    try {
        await routeSeries(tv, details);
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:ret:4"]').waitFor();
        await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
        await tv.page.locator(".details-people .browse-card").first().waitFor();
        await tv.page.locator(".details-extras .browse-card").first().waitFor();
        await tv.page.locator(".details-hero .details-logo").waitFor();
        await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "initial Details reads settled");
        await afterPaint(tv);

        // Snapshot exact DOM references before episode navigation.
        await tv.page.evaluate(() => {
            (window as unknown as { __retRef: Record<string, Element | null> }).__retRef = {
                wash: document.querySelector(".details-page-wash"),
                hero: document.querySelector(".details-hero"),
                backdrop: document.querySelector(".details-hero .skyline-hero-backdrop"),
                title: document.querySelector(".details-editorial h1"),
                logo: document.querySelector(".details-editorial .details-logo"),
                castTitle: document.querySelector(".details-people")?.previousElementSibling ?? null,
                castRow: document.querySelector(".details-people"),
                extrasTitle: document.querySelector(".details-extras")?.previousElementSibling ?? null,
                extrasRow: document.querySelector(".details-extras"),
                relatedTitle: document.querySelector('[data-detail-section="related"]')?.previousElementSibling ?? null,
                relatedRow: document.querySelector('[data-detail-section="related"]'),
                facts: document.querySelector(".details-facts"),
                episodesRow: document.querySelector(".details-episodes"),
            };
        });

        await tv.page.locator('[data-focus="episode:ret:1"]').focus();
        await tv.jump(200);
        await tv.remote(39); // -> episode:ret:2
        await tv.jump(200);
        await tv.remote(39); // -> episode:ret:3
        await tv.jump(200);
        await tv.eventually(async () => (await tv.page.locator(".details-editorial .browse-overview").textContent())?.includes("Chapter 3") === true, "episode 3 overview updates");

        const preserved = await tv.page.evaluate(() => {
            const ref = (window as unknown as { __retRef: Record<string, Element | null> }).__retRef;
            const cur: Record<string, Element | null> = {
                wash: document.querySelector(".details-page-wash"),
                hero: document.querySelector(".details-hero"),
                backdrop: document.querySelector(".details-hero .skyline-hero-backdrop"),
                title: document.querySelector(".details-editorial h1"),
                logo: document.querySelector(".details-editorial .details-logo"),
                castTitle: document.querySelector(".details-people")?.previousElementSibling ?? null,
                castRow: document.querySelector(".details-people"),
                extrasTitle: document.querySelector(".details-extras")?.previousElementSibling ?? null,
                extrasRow: document.querySelector(".details-extras"),
                relatedTitle: document.querySelector('[data-detail-section="related"]')?.previousElementSibling ?? null,
                relatedRow: document.querySelector('[data-detail-section="related"]'),
                facts: document.querySelector(".details-facts"),
                episodesRow: document.querySelector(".details-episodes"),
            };
            const diff = Object.keys(ref).filter(key => ref[key] === null || ref[key] !== cur[key]);
            return { diff, loadingAttr: cur.hero?.getAttribute("data-focus"), ariaBusy: cur.hero?.getAttribute("aria-busy") };
        });
        assert.deepEqual(preserved.diff, [], `Expected all invariant sections to retain DOM identity, replaced: ${preserved.diff.join(", ")}`);
        assert.equal(preserved.loadingAttr, null);
        assert.equal(preserved.ariaBusy, null);
        assert.equal(await tv.focused(), "episode:ret:3");
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("popovers and failure alerts clear inert and aria-hidden from all retained Details sections on dismiss", async () => {
    const { tv, details } = await startDetails();
    try {
        details.searchCapabilities = { ...details.searchCapabilities, box_sets: true };
        const body = details.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as Record<string, unknown>;
        await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: { ...body, extras: [LOCAL_TRAILER] } }));
        await tv.page.route("**/api/v2/catalog/items/movie%3Am0001/box-set?**", route => route.fulfill({ json: { box_set: BOX_SET } }));
        details.mutationFailure = { status: 500, body: { type: "about:blank", title: "Failed", status: 500 } };

        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('.box-set-row [data-focus="box-set-explore"]').waitFor();
        await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
        await tv.page.locator(".details-people .browse-card").first().waitFor();
        await tv.page.locator(".details-extras .browse-card").first().waitFor();
        await tv.page.locator(".details-hero .details-logo").waitFor();

        const readSectionStates = (): Promise<unknown[]> => tv.page.evaluate(() => {
            const nodes = [
                document.querySelector(".details-page-wash"),
                document.querySelector(".details-hero"),
                document.querySelector(".details-people"),
                document.querySelector(".details-extras"),
                document.querySelector(".box-set-row"),
                document.querySelector('[data-detail-section="related"]'),
                document.querySelector(".details-facts"),
            ];
            return nodes.map(node => node === null ? "missing" : { inert: (node as HTMLElement).inert, hidden: node.getAttribute("aria-hidden") });
        });

        // Open and close Audio popover.
        await tv.page.locator('[data-focus="audio"]').click();
        await tv.page.getByRole("dialog", { name: "Audio" }).waitFor();
        await tv.remote(10009);
        await tv.page.getByRole("dialog", { name: "Audio" }).waitFor({ state: "detached" });
        for (const state of await readSectionStates()) assert.deepEqual(state, { inert: false, hidden: null });

        // Trigger and dismiss failure alert.
        await tv.page.locator('[data-focus="watchlist"]').click();
        await tv.page.getByRole("alertdialog").waitFor();
        await tv.page.getByRole("button", { name: "OK", exact: true }).click();
        await tv.page.getByRole("alertdialog").waitFor({ state: "detached" });
        for (const state of await readSectionStates()) assert.deepEqual(state, { inert: false, hidden: null });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("retained title and lower sections rebuild when titleArt or Related data changes", async () => {
    let hold: { release(): void } | undefined;
    const { tv, details, settings } = await startDetails((page, _details) => {
        hold = page.fake.hold("/settings/contract", true);
    });
    try {
        await routeSeries(tv, details);
        let releaseRelated: (() => void) | undefined;
        await tv.page.route("**/api/v2/recommendations/similar/**", route => {
            releaseRelated = () => { void route.fallback().catch(() => undefined); };
        });
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator(".details-related-placeholder").first().waitFor();
        await tv.page.locator(".details-hero .details-logo").waitFor();
        await tv.page.evaluate(() => {
            (window as unknown as { __inv: { related: Element | null; title: Element | null } }).__inv = {
                related: document.querySelector('[data-detail-section="related"]'),
                title: document.querySelector(".details-editorial h1"),
            };
        });
        releaseRelated?.();
        await tv.page.locator('[data-detail-section="related"] .browse-card').first().waitFor();
        settings.profile().set(TITLE_ART_KEY, false);
        hold?.release();
        await tv.eventually(async () => await tv.page.locator(".details-editorial h1 .details-logo").count() === 0, "logo reverts to text title");
        const rebuilt = await tv.page.evaluate(() => {
            const prev = (window as unknown as { __inv: { related: Element | null; title: Element | null } }).__inv;
            return {
                relatedReplaced: document.querySelector('[data-detail-section="related"]') !== prev.related,
                titleReplaced: document.querySelector(".details-editorial h1") !== prev.title,
            };
        });
        assert.deepEqual(rebuilt, { relatedReplaced: true, titleReplaced: true });
        assert.deepEqual(tv.console, []);
    } finally { hold?.release(); await tv.page.context().close(); }
});

test("prepareEpisodeRow avoids reassigning paddingRight when unchanged across repaints", async () => {
    const { tv, details } = await startDetails();
    try {
        await routeSeries(tv, details);
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:ret:4"]').waitFor();
        await afterPaint(tv);

        // Count DOM style attribute mutations on .details-episodes during horizontal episode moves.
        await tv.page.evaluate(() => {
            const row = document.querySelector<HTMLElement>(".details-episodes");
            if (row === null) throw new Error("missing episode row");
            (window as unknown as { __padWrites: number }).__padWrites = 0;
            const observer = new MutationObserver(() => {
                (window as unknown as { __padWrites: number }).__padWrites += 1;
            });
            observer.observe(row, { attributes: true, attributeFilter: ["style"] });
            (window as unknown as { __padObserver: MutationObserver }).__padObserver = observer;
        });

        await tv.page.locator('[data-focus="episode:ret:1"]').focus();
        await tv.jump(200);
        await tv.remote(39);
        await tv.jump(200);
        await tv.remote(39);
        await tv.jump(200);
        const writes = await tv.page.evaluate(() => {
            (window as unknown as { __padObserver: MutationObserver }).__padObserver.disconnect();
            return (window as unknown as { __padWrites: number }).__padWrites;
        });
        assert.equal(writes, 0, `expected 0 redundant style attribute writes during horizontal episode focus, got ${writes}`);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("retained lower sections rebuild when shownLanguage changes mid-visit", async () => {
    let releaseLanguage: (() => void) | undefined;
    const { tv, details, settings } = await startDetails(async (page, _details, prefs) => {
        prefs.revision = 28;
        await page.page.route("**/api/v2/settings/values/effective?**", route => {
            const url = new URL(route.request().url());
            if (url.searchParams.get("keys") === APP_LANGUAGE_KEY && releaseLanguage === undefined) {
                releaseLanguage = () => { void route.fallback().catch(() => undefined); };
                return;
            }
            return route.fallback();
        });
    });
    try {
        details.searchCapabilities = { ...details.searchCapabilities, box_sets: true };
        const body = details.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body as Record<string, unknown>;
        await tv.page.route("**/api/v2/catalog/items/movie%3Am0001?**", route => route.fulfill({ json: { ...body, extras: [LOCAL_TRAILER] } }));
        await tv.page.route("**/api/v2/catalog/items/movie%3Am0001/box-set?**", route => route.fulfill({ json: { box_set: BOX_SET } }));
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first().click();
        await tv.page.locator('.box-set-row [data-focus="box-set-explore"]').waitFor();
        await tv.page.locator(".details-facts dt").first().waitFor();
        assert.equal(await tv.page.locator(".details-facts dt").first().textContent(), "DIRECTOR");
        await tv.page.evaluate(() => {
            (window as unknown as { __invLang: Record<string, Element | null> }).__invLang = {
                cast: document.querySelector(".details-people"),
                extras: document.querySelector(".details-extras"),
                box: document.querySelector(".box-set-row"),
                related: document.querySelector('[data-detail-section="related"]'),
                facts: document.querySelector(".details-facts"),
            };
        });
        settings.profile().set(APP_LANGUAGE_KEY, "de");
        releaseLanguage?.();
        await tv.eventually(async () => await tv.page.locator(".details-facts dt").first().textContent() === "REGIE", "German facts label after language answer");
        const replaced = await tv.page.evaluate(() => {
            const prev = (window as unknown as { __invLang: Record<string, Element | null> }).__invLang;
            return {
                cast: document.querySelector(".details-people") !== prev.cast,
                extras: document.querySelector(".details-extras") !== prev.extras,
                box: document.querySelector(".box-set-row") !== prev.box,
                related: document.querySelector('[data-detail-section="related"]') !== prev.related,
                facts: document.querySelector(".details-facts") !== prev.facts,
            };
        });
        assert.deepEqual(replaced, { cast: true, extras: true, box: true, related: true, facts: true });
        assert.deepEqual(tv.console, []);
    } finally { releaseLanguage?.(); await tv.page.context().close(); }
});

test("transiently failing Details logo retries and renders on the next episode focus repaint", async () => {
    const { tv, details } = await startDetails();
    let logoHits = 0;
    let allowLogo = false;
    try {
        await tv.page.route("**/art/last-signal-logo.svg", route => {
            logoHits++;
            if (!allowLogo) return route.fulfill({ status: 500 });
            return route.fallback();
        });
        await routeSeries(tv, details);
        await tv.page.locator('[data-section="recently_added"] [data-focus="series:s1"]').first().click();
        await tv.page.locator('[data-focus="episode:ret:4"]').waitFor();
        await tv.eventually(async () => logoHits >= 1, "initial logo request");
        await afterPaint(tv);
        assert.equal(await tv.page.locator(".details-hero .details-logo").count(), 0);

        allowLogo = true;
        const hitsBeforeMove = logoHits;
        await tv.page.locator('[data-focus="episode:ret:1"]').focus();
        await tv.jump(150);
        await tv.remote(39);
        await tv.eventually(async () => await tv.page.locator(".details-hero .details-logo").count() === 1, "retried logo renders after repaint");
        assert.ok(logoHits > hitsBeforeMove, `expected logo retry request, saw ${logoHits} (before move ${hitsBeforeMove})`);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("box-set rail rebuilds on an asset-only CardOverlayPrefs object replacement", async () => {
    const details = new FakeDetails();
    const itemWire = details.route("GET", "/catalog/items/movie%3Am0001", "p-owner")?.body;
    const bundled = await build({
        stdin: {
            resolveDir: process.cwd(),
            contents: `
                import { itemView } from "./src/ui/browseDetails.ts";
                import { DetailsState } from "./src/ui/detailsState.ts";
                import { BoxSetRowState } from "./src/ui/boxSetRow.ts";
                import { parseOverlayPrefs } from "./src/ui/cardOverlays.ts";
                import { decodeCatalogBoxSetDetail } from "./src/contracts/v2/boxSets.ts";
                import { decodeItemDetail } from "./src/contracts/v2/catalog.ts";

                window.__runBoxSetRetention = (itemRaw, boxSetRaw) => {
                    const detail = decodeItemDetail(itemRaw);
                    const boxSetDetail = decodeCatalogBoxSetDetail(boxSetRaw);
                    const fakeSession = {
                        call: async () => { throw new Error("unexpected network call"); },
                        authoritySignal: new AbortController().signal,
                    };
                    const state = new DetailsState(detail, fakeSession, () => undefined, async () => undefined);
                    const boxSet = new BoxSetRowState(fakeSession, detail.id, async () => true, () => undefined);
                    boxSet.detail = boxSetDetail;
                    const ref = "b".repeat(64) + ".webp";
                    const basePrefs = parseOverlayPrefs({
                        version: 2,
                        preset: "classic",
                        order: [],
                        items: { resolution: { enabled: true, position: "top-left", valueImages: { "2160p": ref } } },
                    });
                    const prefs1 = { ...basePrefs, images: new Map([[ref, { url: "/art/badge-1.svg", aspect: 2.5 }]]) };
                    const prefs2 = { ...basePrefs, images: new Map([[ref, { url: "/art/badge-2.svg", aspect: 2.5 }]]) };
                    let currentPrefs = prefs1;
                    const context = { baseUrl: "http://127.0.0.1", cardOverlays: () => currentPrefs, open: () => undefined };
                    const boxNode = (view) => view.content.find((node) => node.classList.contains("box-set-row")) ?? null;
                    const row1 = boxNode(itemView(detail, [], context, () => undefined, () => undefined, state, boxSet));
                    const row2 = boxNode(itemView(detail, [], context, () => undefined, () => undefined, state, boxSet));
                    currentPrefs = prefs2;
                    const row3 = boxNode(itemView(detail, [], context, () => undefined, () => undefined, state, boxSet));
                    return {
                        jsonSame: JSON.stringify(prefs1) === JSON.stringify(prefs2),
                        retainedSameRef: row1 !== null && row1 === row2,
                        rebuiltOnAssetSwap: row3 !== null && row3 !== row2,
                    };
                };
            `,
            loader: "ts",
        },
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
    });
    const page = await browser.newPage();
    try {
        await page.setContent("<!doctype html><html><body></body></html>");
        await page.addScriptTag({ content: bundled.outputFiles[0]?.text ?? "" });
        const result = await page.evaluate(
            ({ itemRaw, boxSetRaw }) => (window as unknown as {
                __runBoxSetRetention: (a: unknown, b: unknown) => { jsonSame: boolean; retainedSameRef: boolean; rebuiltOnAssetSwap: boolean };
            }).__runBoxSetRetention(itemRaw, boxSetRaw),
            { itemRaw: itemWire, boxSetRaw: BOX_SET },
        );
        assert.deepEqual(result, { jsonSame: true, retainedSameRef: true, rebuiltOnAssetSwap: true });
    } finally {
        await page.close();
    }
});
