// The audiobook library cascade, card and detail, driven by remote keys in Chromium against a fake Silo
// that holds an audiobook library. Desktop Chromium is not the TV's Chromium 108: this proves behavior,
// not TV rendering. Set EVIDENCE_DIR to also write 1920x1080 screenshots.

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Browser, Route } from "playwright";
import { FakeAudiobooks } from "../native/support/fakeAudiobooks.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { selectLibraryMode } from "./support/library.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

const BACK = 10009;
const ENTER = 13;
const IME_DONE = 65376;
const TIDE = "audiobook:tide";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

function audiobookTest(name: string, body: (tv: Tv, catalog: FakeAudiobooks) => Promise<void>, setup?: (catalog: FakeAudiobooks) => void): void {
    test(name, async () => {
        const tv = await openTv(browser, { app: "browse" });
        try {
            const catalog = new FakeAudiobooks();
            setup?.(catalog);
            tv.fake.catalog = catalog;
            await tv.page.emulateMedia({ reducedMotion: "reduce" });
            await tv.page.evaluate(() => window.browseHarness.connect());
            await tv.eventually(async () => tv.fake.devices.size > 0, "a device code");
            tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
            await tv.jump(5000);
            await tv.eventually(async () => (await tv.page.evaluate(() => window.browseHarness.loginPhase)) === "signed_in", "sign-in");
            assert.equal(await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner")), "selected");
            await tv.page.evaluate(() => window.browseHarness.mount());
            await showing(tv, "home");
            await body(tv, catalog);
            assert.deepEqual(tv.console, [], "the page logs nothing");
        } finally {
            await tv.page.context().close();
        }
    });
}

const view = (tv: Tv): Promise<string | null> => tv.page.evaluate(() => document.querySelector(".browse")?.getAttribute("data-view") ?? null);
const showing = (tv: Tv, name: string): Promise<void> => tv.eventually(async () => (await view(tv)) === name, `the ${name} view`);

async function shoot(tv: Tv, name: string): Promise<void> {
    const dir = process.env.EVIDENCE_DIR;
    if (dir === undefined) return;
    await mkdir(dir, { recursive: true });
    await tv.page.screenshot({ path: `${dir}/${name}.png` });
}

async function showAudiobooks(tv: Tv): Promise<void> {
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="settings"]').click();
    const row = tv.page.locator('[data-focus="show-audiobooks"]');
    await row.waitFor();
    if (await row.getAttribute("aria-checked") !== "true") await row.click();
    assert.equal(await row.getAttribute("aria-checked"), "true");
    await leaveSettings(tv);
}

/** Back leaves the General pane for the category list, and the list for Home. */
async function leaveSettings(tv: Tv): Promise<void> {
    for (let presses = 0; presses < 3 && !(await tv.page.locator('[data-view="home"]').isVisible()); presses++) await tv.remote(BACK);
    await tv.page.locator('[data-view="home"]').waitFor();
}

audiobookTest("Home draws an all-audiobook row square, keeps Continue Listening as stills, and opens a card on its detail", async tv => {
    const shelf = tv.page.locator('[data-section="shelf"] .browse-card:not(.skyline-explore)');
    assert.equal(await shelf.count(), 4);
    for (const box of await shelf.locator(".browse-art").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect()))) {
        assert.ok(Math.abs(box.width - box.height) < 1, `a square cover, got ${box.width}x${box.height}`);
    }
    assert.equal(await tv.page.locator('[data-section="listen"] .browse-card').first().getAttribute("class").then(value => value?.includes("skyline-continue")), true);
    assert.equal(await tv.page.locator('[data-section="listen"] .browse-card-square').count(), 0, "Apple checks the still rows before the square rule");
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:dune"]').focus();
    await shoot(tv, "audiobook-card-home-row");
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:dune"]').click();
    await showing(tv, "audiobook:audiobook:dune");
});

audiobookTest("the audiobook detail shows the cover, hero height, action pills, circle buttons, and state", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    assert.equal(await tv.page.locator(".audiobook-title").innerText(), "The Tide Owes");
    assert.equal(await tv.page.locator(".audiobook-eyebrow").innerText(), "AUDIOBOOK · FANTASY");
    assert.equal(await tv.page.locator(".audiobook-series").innerText(), "THE STORMLIGHT ARCHIVE · BOOK 5 OF 5");
    assert.equal(await tv.page.locator(".audiobook-credits").innerText(), "by Brandon Sanderson  ·  read by Michael Kramer & Kate Reading");
    assert.equal(await tv.page.locator(".audiobook-state-line").innerText(), "Chapter 2 · What the Tide Owes");
    assert.equal(await tv.page.locator(".audiobook-state-detail").innerText(), "8:32 into the chapter · 1h 51m left in the book");
    assert.equal(await tv.page.locator(".audiobook-ring-label").innerText(), "38%");
    await tv.page.locator('[data-focus="favorite"][aria-pressed]').waitFor();
    const cover = await tv.page.locator(".audiobook-cover").evaluate(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; });
    assert.deepEqual(cover, [460, 460]);
    const heroHeight = await tv.page.locator(".audiobook-hero").evaluate(node => Math.round(node.getBoundingClientRect().height));
    assert.equal(heroHeight, 860, "TVAudiobookDetailView.heroHeight is 860");
    const play = tv.page.locator('[data-focus="play"]');
    const chapters = tv.page.locator('[data-focus="chapters"]');
    const startOver = tv.page.locator('[data-focus="start-over"]');
    assert.equal(await play.innerText(), "Resume");
    assert.equal(await play.getAttribute("aria-disabled"), "true");
    assert.equal(await play.evaluate(n => n.classList.contains("audiobook-pill-primary")), true);
    assert.equal(await chapters.evaluate(n => n.classList.contains("audiobook-pill-secondary")), true);
    assert.equal(await startOver.evaluate(n => n.classList.contains("audiobook-pill-secondary")), true);
    assert.equal(await play.evaluate(n => getComputedStyle(n).backgroundColor), "rgba(255, 255, 255, 0.7)");
    assert.notEqual(await play.evaluate(n => getComputedStyle(n).boxShadow), "none");
    assert.equal(await chapters.evaluate(n => getComputedStyle(n).backgroundColor), "rgba(0, 0, 0, 0.52)");
    assert.equal(await tv.page.locator(".audiobook-actions").evaluate(n => getComputedStyle(n).columnGap), "18px");
    const pillGap = await tv.page.evaluate(() => {
        const a = document.querySelector('[data-focus="play"]')?.getBoundingClientRect();
        const b = document.querySelector('[data-focus="chapters"]')?.getBoundingClientRect();
        return a === undefined || b === undefined ? -1 : Math.round(b.left - a.right);
    });
    assert.equal(pillGap, 18, "adjacent action pills are separated by 18 px, not extra margin");
    assert.equal(await tv.focused(), "play", "initial focus is the primary action, as on Apple");
    const before = tv.fake.requests.length;
    await tv.remote(ENTER);
    assert.equal(await view(tv), `audiobook:${TIDE}`, "Play opens nothing until playback lands");
    assert.equal(tv.fake.requests.slice(before).filter(request => /playback|stream|shuffle/.test(request.path)).length, 0);
    await shoot(tv, "audiobook-detail");
    await tv.remote(39);
    assert.equal(await tv.focused(), "chapters");
    await tv.remote(39);
    assert.equal(await tv.focused(), "start-over");
    await tv.remote(39);
    assert.equal(await tv.focused(), "favorite");
    await tv.remote(39);
    assert.equal(await tv.focused(), "finished");
});

audiobookTest("Start Over hides without resume progress, and Favorite and Finished circle buttons toggle state", async (tv, catalog) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:hail"]').click();
    await showing(tv, "audiobook:audiobook:hail");
    assert.equal(await tv.page.locator('[data-focus="play"]').innerText(), "Play");
    assert.equal(await tv.page.locator('[data-focus="start-over"]').count(), 0, "no Start Over without resume progress");

    const favorite = tv.page.locator('[data-focus="favorite"]');
    const finished = tv.page.locator('[data-focus="finished"]');
    await tv.eventually(async () => await favorite.getAttribute("aria-pressed") === "false", "initial favorite membership read");
    assert.equal(await finished.getAttribute("aria-pressed"), "false");

    await favorite.focus();
    assert.equal(await favorite.locator("svg").getAttribute("data-symbol"), "heart");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await favorite.getAttribute("aria-pressed") === "true", "favorite added");
    assert.equal(await favorite.locator("svg").getAttribute("data-symbol"), "heart.fill");
    assert.equal(await tv.focused(), "favorite");
    assert.ok(catalog.mutations.includes("PUT /favorites/audiobook%3Ahail"));
    await tv.eventually(
      async () => tv.fake.requests.filter(r => r.path.startsWith("/favorites/audiobook%3Ahail")).length >= 3,
      "favorite write and readback settled",
    );

    await finished.focus();
    assert.equal(await finished.locator("svg").getAttribute("data-symbol"), "checkmark.circle");
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await finished.getAttribute("aria-pressed") === "true", "marked finished");
    assert.equal(await finished.locator("svg").getAttribute("data-symbol"), "checkmark.circle.fill");
    assert.equal(await finished.evaluate(n => getComputedStyle(n).getPropertyValue("--icon-ink").trim()), "#fff", "focused filled circle checkmark uses inverse ink");
    assert.equal(await tv.focused(), "finished");
    assert.ok(catalog.mutations.includes("POST /watched/audiobook%3Ahail"));
});

audiobookTest("personalSupported=false hides Favorite while keeping Finished, and write failures surface the alert", async (tv, catalog) => {
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:hail"]').click();
    await showing(tv, "audiobook:audiobook:hail");
    const finished = tv.page.locator('[data-focus="finished"]');
    await finished.focus();
    catalog.mutationFailure = problem(503, "unavailable", "Try again");
    await tv.page.keyboard.press("Enter");
    const alertDialog = tv.page.getByRole("alertdialog");
    await alertDialog.waitFor();
    await tv.page.getByRole("button", { name: "OK", exact: true }).click();
    await tv.eventually(async () => await alertDialog.count() === 0, "alert dismissed");
    await finished.focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => await finished.getAttribute("aria-pressed") === "true", "retry marked finished");

    catalog.capability = false;
    await tv.remote(BACK);
    await showing(tv, "home");
    await tv.page.evaluate(() => { window.browseHarness.clearResponseCache(); window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:hail"]').click();
    await showing(tv, "audiobook:audiobook:hail");
    await tv.eventually(async () => await tv.page.locator('[data-focus="favorite"]').count() === 0, "Favorite hidden when personal lists unavailable");
    assert.equal(await tv.page.locator('[data-focus="finished"]').count(), 1, "Finished remains available");
});

const DUNE = "audiobook:dune";
const duneDetail = "**/api/v2/catalog/items/audiobook%3Adune?**";

/** Remounts Home with nothing cached, so the next open of a book reads its detail again. */
async function remountHome(tv: Tv): Promise<void> {
    await tv.page.evaluate(() => { window.browseHarness.clearResponseCache(); window.browseHarness.destroy(); window.browseHarness.mount(); });
    await showing(tv, "home");
    await tv.page.locator(`[data-section="shelf"] [data-focus="${DUNE}"]`).waitFor();
}

audiobookTest("an audiobook opens on Apple's loading frame, painted from its card, until the book is read", async tv => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await tv.page.route(duneDetail, async route => { await gate; await route.fallback(); });
    await remountHome(tv);
    await tv.page.locator(`[data-section="shelf"] [data-focus="${DUNE}"]`).click();
    const page = tv.page.locator(".audiobook-loading");
    await page.waitFor();
    assert.equal(await page.getAttribute("aria-busy"), "true");
    assert.equal(await page.getAttribute("aria-label"), "Loading details for Dune");
    assert.equal(await tv.focused(), "loading", "the passive frame holds focus so Back still leaves");
    assert.equal(await page.locator(".audiobook-title").innerText(), "Dune", "the card's title, before the book arrives");
    assert.match(await page.locator(".audiobook-loading-year").innerText(), /^1965$/);
    assert.match(await page.locator(".audiobook-cover img").getAttribute("src") ?? "", /audiobook%3Adune|audiobook:dune/, "the card's cover");
    assert.deepEqual(await page.locator(".audiobook-cover").evaluate(node => { const box = node.getBoundingClientRect(); return [box.width, box.height]; }), [460, 460]);
    assert.equal(await page.evaluate(n => Math.round(n.getBoundingClientRect().height), await page.elementHandle()), 860, "loading frame uses 860 hero height");
    assert.equal(await tv.page.locator('[data-focus="play"]').count(), 0, "no action until the book is read");
    await shoot(tv, "audiobook-loading");
    release();
    await showing(tv, `audiobook:${DUNE}`);
    assert.equal(await tv.focused(), "play");
});

audiobookTest("Back from an audiobook's loading frame returns to its card", async tv => {
    await tv.page.route(duneDetail, () => undefined);
    await remountHome(tv);
    await tv.page.locator(`[data-section="shelf"] [data-focus="${DUNE}"]`).click();
    await tv.page.locator(".audiobook-loading").waitFor();
    await tv.remote(BACK);
    await showing(tv, "home");
    assert.equal(await tv.focused(), DUNE);
});

audiobookTest("a book that is gone shows Apple's Not found page; Try Again reads it again and Go Back returns to its card", async tv => {
    const missing = (route: Route): Promise<void> => route.fulfill({ status: 404, contentType: "application/problem+json", body: JSON.stringify({ type: "not_found", title: "Not found", status: 404 }) });
    await tv.page.route(duneDetail, missing);
    await remountHome(tv);
    await tv.page.locator(`[data-section="shelf"] [data-focus="${DUNE}"]`).click();
    await tv.page.locator(".details-failure").waitFor();
    assert.equal(await tv.page.locator(".details-failure").innerText().then(text => text.split("\n")[0]), "Not found");
    assert.match(await tv.page.locator(".details-failure").innerText(), /We couldn't find what you were looking for\. It may have been removed or moved\./);
    assert.deepEqual(await tv.page.locator(".details-failure .browse-button").allInnerTexts(), ["Go Back", "Try Again"], "Apple ErrorView: a 404 prefers leaving");
    assert.equal(await tv.focused(), "go-back");
    await tv.page.unroute(duneDetail, missing);
    await tv.page.locator('[data-focus="retry"]').click();
    await showing(tv, `audiobook:${DUNE}`);
    assert.equal(await tv.focused(), "play", "Try Again reads the book and opens it on Play");
    await tv.remote(BACK);
    await showing(tv, "home");
    await tv.page.route(duneDetail, missing);
    await tv.page.evaluate(() => window.browseHarness.clearResponseCache());
    await tv.page.locator(`[data-section="shelf"] [data-focus="${DUNE}"]`).click();
    await tv.page.locator(".details-failure").waitFor();
    await tv.page.locator('[data-focus="go-back"]').click();
    await showing(tv, "home");
    assert.equal(await tv.focused(), DUNE, "Go Back restores the card");
});

audiobookTest("Chapters opens a picker on the current chapter and Back returns to the button", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    await tv.page.locator('[data-focus="chapters"]').click();
    await showing(tv, `audiobook:${TIDE}:chapters`);
    assert.equal(await tv.page.locator(".audiobook-picker-subline").innerText(), "38% · Chapter 2 of 3 · 1h 51m left");
    assert.deepEqual(await tv.page.locator(".audiobook-chapter .audiobook-row-title").allInnerTexts(), ["Opening", "What the Tide Owes", "Chapter 3"]);
    assert.equal(await tv.focused(), "chapter-1");
    assert.equal(await tv.page.locator('[data-focus="chapter-1"] .audiobook-chapter-now').innerText(), "NOW");
    assert.equal(await tv.page.locator('[data-focus="chapter-0"] .audiobook-chapter-done').count(), 1);
    await shoot(tv, "audiobook-chapters");
    await tv.remote(BACK);
    await showing(tv, `audiobook:${TIDE}`);
    assert.equal(await tv.focused(), "chapters");
});

audiobookTest("below the fold the detail lists About facts, narrations and rails, strips series prefixes, and opens a selection", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    assert.equal(await tv.page.locator(".audiobook-about").innerText(), "The war for Roshar reaches its last turn, and the oaths that bound the Radiants are tested one more time.");
    assert.equal(await tv.page.locator(".audiobook-about-more").isVisible(), false, "short overview hides MORE badge");
    const factLabels = await tv.page.locator(".audiobook-fact-label").allInnerTexts();
    const factValues = await tv.page.locator(".audiobook-fact-value").allInnerTexts();
    assert.deepEqual(factLabels, ["AUTHOR", "NARRATORS", "PUBLISHER", "RELEASED", "LENGTH", "FORMAT"]);
    assert.deepEqual(factValues, ["Brandon Sanderson", "Michael Kramer & Kate Reading", "Tor Books", "December 6, 2024", "3h", "AAC · M4B"]);
    assert.equal(await tv.page.locator('[data-focus="narration:audiobook:fresh"] [data-symbol="person.wave.2"]').count(), 1);
    assert.deepEqual(await tv.page.locator(".audiobook-section-title").allInnerTexts(), ["About", "Narrations", "The Stormlight Archive", "More by Author", "Related"]);
    assert.equal(await tv.page.locator(".audiobook-rail .browse-card-square").count(), 16);
    assert.equal(await tv.page.locator('.audiobook-section', { hasText: 'The Stormlight Archive' }).locator('.browse-card-title').first().innerText(), "The Way of Kings", "series prefix is stripped on series rail cards");
    assert.equal(await tv.page.locator(".audiobook-rail .browse-card-subtitle").first().innerText(), "Book 1");
    assert.equal(await tv.page.locator('.audiobook-section', { hasText: 'More by Author' }).locator('.browse-card-subtitle').first().innerText(), "2006");
    await tv.page.locator('[data-focus="narration:audiobook:fresh"]').click();
    await showing(tv, "audiobook:audiobook:fresh");
    await tv.remote(BACK);
    await showing(tv, `audiobook:${TIDE}`);
});

audiobookTest("the remote reaches About, narrations and every rail card, and a long rail scrolls to the focused card", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    const down = 40;
    const up = 38;
    await tv.remote(down);
    assert.equal(await tv.focused(), "about", "Down from the actions reaches the About text");
    const focused = await tv.page.locator('[data-focus="about"]').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.match(focused, /rgba\(0, 0, 0, 0\)|transparent/, "focus keeps the text readable: no white fill");
    await tv.remote(down);
    assert.equal(await tv.focused(), "narration:audiobook:fresh");
    assert.equal(await tv.page.locator('[data-focus="narration:audiobook:fresh"]').evaluate(n => getComputedStyle(n).borderRadius), "8px");
    assert.notEqual(await tv.page.locator('[data-focus="narration:audiobook:fresh"]').evaluate(n => getComputedStyle(n).boxShadow), "none");
    await tv.remote(down);
    assert.match(await tv.focused() ?? "", /^audiobook:/, "Down enters the first rail");
    await tv.remote(down); await tv.remote(down);
    const related = tv.page.locator(".audiobook-section", { hasText: "Related" }).locator(".audiobook-rail");
    const railGap = await related.evaluate(rail => {
        const cards = rail.querySelectorAll<HTMLElement>(".browse-card");
        if (cards.length < 2) return -1;
        return Math.round(cards[1]!.getBoundingClientRect().left - cards[0]!.getBoundingClientRect().right);
    });
    assert.equal(railGap, 40, "rail cards use a 40 px horizontal gap");
    for (let step = 0; step < 11; step++) await tv.remote(39);
    assert.equal(await tv.focused(), "audiobook:similar11");
    const inside = await tv.page.locator('[data-focus="audiobook:similar11"]').evaluate((card, row) => {
        const box = card.getBoundingClientRect(), bounds = row.getBoundingClientRect();
        return box.left >= bounds.left && box.right <= bounds.right;
    }, await related.elementHandle());
    assert.equal(inside, true, "the last card is revealed inside its row");
    for (let step = 0; step < 5; step++) await tv.remote(up);
    assert.equal(await tv.focused(), "play", "Up returns to primary pill");
    assert.equal(await tv.page.evaluate(() => document.querySelector(".browse")?.scrollTop ?? -1), 0, "returning to hero actions restores top scroll");
});

audiobookTest("the Audiobooks Browse page offers no video Shuffle even when the server advertises it", async tv => {
    await tv.page.route("**/api/v2/shuffles/capabilities", route => route.fulfill({ json: { allowed: true, state: "available", scope_kinds: ["library"] } }));
    await showAudiobooks(tv);
    await tv.page.locator('[data-focus="audiobooks"]').click();
    await showing(tv, "library:14");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.browse-grid .browse-card-square').first().waitFor();
    assert.equal(await tv.page.locator('[data-focus="shuffle"]').count(), 0);
});

audiobookTest("a library the server types \"audiobook\" opens under the Audiobooks tab as Apple TV does", async tv => {
    await showAudiobooks(tv);
    const tab = tv.page.locator('[data-focus="audiobooks"]');
    await tab.waitFor();
    await tab.click();
    await showing(tv, "library:14");
    await tv.page.locator('[data-section] .browse-card-square').first().waitFor();
}, catalog => {
    const library = catalog.households.get("p-owner")?.libraries.find(entry => entry.id === "14");
    if (library === undefined) throw new Error("Missing synthetic audiobook library");
    library.type = "audiobook";
});

audiobookTest("Audiobooks stays off until Show Audiobooks is on, then opens the library with square covers", async tv => {
    assert.equal(await tv.page.locator('[data-focus="audiobooks"]').count(), 0, "off by default");
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="settings"]').click();
    const row = tv.page.locator('[data-focus="show-audiobooks"]');
    await row.waitFor();
    assert.equal(await row.getAttribute("aria-checked"), "false");
    assert.equal(await tv.page.locator(".settings-section-header", { hasText: "TOP MENU" }).count(), 1);
    assert.match(await tv.page.locator("body").innerText(), /Adds an Audiobooks tab when an audiobook library is available\./);
    await row.click();
    assert.equal(await row.getAttribute("aria-checked"), "true");
    await leaveSettings(tv);
    const tab = tv.page.locator('[data-focus="audiobooks"]');
    await tab.waitFor();
    assert.deepEqual(await tv.page.locator(".skyline-roots [role=tab]").allInnerTexts(), ["Home", "Movies", "Series", "Audiobooks", "For You", "Calendar"]);
    await tab.click();
    await showing(tv, "library:14");
    const covers = tv.page.locator('[data-section] .browse-card-square');
    await covers.first().waitFor();
    assert.equal(await covers.count(), 4);
    await shoot(tv, "audiobook-library");
    const first = await covers.first().getAttribute("data-focus");
    await covers.first().click();
    await showing(tv, `audiobook:${first}`);
});

const roots = (tv: Tv): Promise<string[]> => tv.page.locator(".skyline-roots [role=tab]").allInnerTexts();

audiobookTest("Show Audiobooks adds no tab while the profile has no visible audiobook library", async tv => {
    await showAudiobooks(tv);
    assert.equal(await tv.focused(), "home", "leaving Settings lands on Home");
    assert.deepEqual(await roots(tv), ["Home", "Movies", "Series", "For You", "Calendar"], "the switch alone adds nothing");
}, catalog => {
    const owner = catalog.households.get("p-owner");
    if (owner === undefined) throw new Error("Missing synthetic household");
    owner.hidden = [14, 15];
});

audiobookTest("the Audiobooks tab appears and goes with the switch and focus is never lost", async tv => {
    await showAudiobooks(tv);
    assert.equal(await tv.focused(), "home", "the new tab does not take focus");
    await tv.remote(39); await tv.remote(39); await tv.remote(39);
    assert.equal(await tv.focused(), "audiobooks", "Right walks the bar onto the new tab after Series");
    await tv.page.locator('[data-focus="audiobooks"]').click();
    await showing(tv, "library:14");
    await tv.page.locator('[data-focus="profiles"]').click();
    await tv.page.locator('[data-focus="settings"]').click();
    const row = tv.page.locator('[data-focus="show-audiobooks"]');
    await row.click();
    assert.equal(await row.getAttribute("aria-checked"), "false");
    await leaveSettings(tv);
    assert.equal(await tv.page.locator('[data-focus="audiobooks"]').count(), 0, "the tab goes with the switch");
    assert.deepEqual(await roots(tv), ["Home", "Movies", "Series", "For You", "Calendar"]);
    assert.equal(await tv.focused(), "home", "turning the switch off from the Audiobooks tab returns focus to Home, not to nothing");
});

audiobookTest("the Audiobooks library Browse grid queries by library alone and offers Apple's audiobook sorts", async tv => {
    await showAudiobooks(tv);
    await tv.page.locator('[data-focus="audiobooks"]').click();
    await showing(tv, "library:14");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.browse-grid .browse-card-square').first().waitFor();
    const query = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query") && request.body?.library_id === "14").at(-1);
    assert.ok(query !== undefined);
    assert.equal(query.body?.type, undefined, "an audiobook library sends no type");
    await tv.page.locator('[data-focus="sort"]').click();
    assert.deepEqual(await tv.page.locator('.browse-sort-panel [data-focus^="sort:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))), ["sort:title", "sort:added_at", "sort:release_date", "sort:year", "sort:runtime", "sort:bitrate", "sort:progress", "sort:date_viewed", "sort:plays", "sort:author", "sort:narrator", "sort:series"]);
});

audiobookTest("the Audiobooks library Browse grid offers only audiobook filter facets and lowers them to rules", async tv => {
    await tv.page.route("**/api/v2/catalog/filters**", route => route.fulfill({
        json: {
            genres: ["Fantasy"], studios: ["Tor"], networks: ["HBO"], countries: ["US"], original_languages: ["en"], content_ratings: ["R"],
            authors: ["Brandon Sanderson"], narrators: ["Michael Kramer"], series: ["Stormlight"],
            technical: { resolutions: ["2160p"], audio_languages: ["en"], subtitle_languages: ["en"] },
        },
    }));
    await showAudiobooks(tv);
    await tv.page.locator('[data-focus="audiobooks"]').click();
    await showing(tv, "library:14");
    await selectLibraryMode(tv, "Browse");
    await tv.page.locator('.browse-grid .browse-card-square').first().waitFor();
    await tv.page.locator('[data-focus="filter"]').click();
    await tv.page.locator('[data-focus="facet:author"]').waitFor();
    assert.deepEqual(
        await tv.page.locator('.browse-filter-panel [data-focus^="facet:"]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus"))),
        ["facet:genre", "facet:author", "facet:narrator", "facet:series", "facet:decade", "facet:watchStatus"],
    );
    await tv.page.locator('[data-focus="facet:author"]').click();
    assert.equal(await tv.focused(), "value:Brandon Sanderson");
    await tv.page.locator('[data-focus="value:Brandon Sanderson"]').click();
    await tv.remote(BACK);
    await tv.page.locator('[data-focus="done"]').click();
    await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith("/catalog/query") && JSON.stringify(request.body?.groups ?? []).includes('"author"')), "author filter query sent");
    const query = tv.fake.requests.filter(request => request.path.startsWith("/catalog/query") && request.body?.library_id === "14").at(-1);
    assert.equal(query?.body?.type, undefined);
    assert.deepEqual(query?.body?.groups, [{ match: "any", rules: [{ field: "author", op: "is", value: "Brandon Sanderson" }] }]);
});

audiobookTest("with Show Audiobooks off, Search offers no Audiobooks filter and keeps to a video scope", async tv => {
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(await tv.page.locator("#browse-search").getAttribute("placeholder"), "Search movies and series...", "search.fieldPrompt.video");
    await tv.page.fill("#browse-search", "Dune"); await tv.remote(IME_DONE);
    await tv.page.getByText("Try a different search term").first().waitFor();
    assert.equal(await tv.page.locator('[data-focus="search-filter:audiobook"]').count(), 0, "no Audiobooks filter while the opt-in is off");
    const types = tv.fake.requests.filter(request => request.path.startsWith("/catalog?")).map(request => new URL(request.path, "https://fake.invalid").searchParams.get("type"));
    assert.ok(types.length > 0 && types.every(type => type === "video" || type === "video_with_episodes"), `search names a video scope, got ${types.join()}`);
});

audiobookTest("with Show Audiobooks on, Search offers Audiobooks, names no scope for All, and opens a result on its detail", async tv => {
    await showAudiobooks(tv);
    await tv.page.locator('[data-focus="search"]').click();
    assert.equal(await tv.page.locator("#browse-search").getAttribute("placeholder"), "Search movies, series, audiobooks...", "search.fieldPrompt.audiobooks (SearchView.swift:132-137)");
    await tv.page.fill("#browse-search", "Dune"); await tv.remote(IME_DONE);
    const book = tv.page.locator('.browse-grid [data-focus="audiobook:dune"]');
    await book.waitFor();
    assert.ok((await book.getAttribute("class"))?.includes("browse-card-square"));
    const all = tv.fake.requests.filter(request => request.path.startsWith("/catalog?q=")).at(-1);
    assert.ok(all !== undefined);
    assert.equal(new URL(all.path, "https://fake.invalid").searchParams.get("type"), null, "All names no type while audiobooks take part");
    await tv.page.locator('[data-focus="search-filter:audiobook"]').focus();
    await tv.eventually(async () => tv.fake.requests.some(request => request.path.startsWith("/catalog?q=") && new URL(request.path, "https://fake.invalid").searchParams.get("type") === "audiobook"), "the Audiobooks read");
    await shoot(tv, "audiobook-search");
    await book.click();
    await showing(tv, "audiobook:audiobook:dune");
});

audiobookTest("reopening a book from its own rail starts at Play and Back restores the rail card", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await showing(tv, `audiobook:${TIDE}`);
    const rail = tv.page.locator(`.audiobook-rail [data-focus="${TIDE}"]`);
    await rail.focus();
    await tv.jump(500);
    await rail.click();
    await tv.eventually(async () => { await tv.jump(500); return (await view(tv)) === `audiobook:${TIDE}`; }, "the nested detail");
    assert.equal(await tv.focused(), "play", "a fresh presentation starts at its primary action");
    assert.equal(await tv.page.locator(".browse").evaluate(node => node.scrollTop), 0, "a fresh presentation starts at the hero");
    await tv.remote(BACK);
    await showing(tv, `audiobook:${TIDE}`);
    await tv.eventually(async () => (await tv.focused()) === TIDE, "the outer page's rail card");
});

audiobookTest("a truncated About shows MORE and opens the scrollable full description overlay; Back returns to About", async tv => {
    await tv.page.locator(`[data-section="shelf"] [data-focus="audiobook:fresh"]`).click();
    await showing(tv, "audiobook:audiobook:fresh");
    await tv.eventually(async () => (await tv.focused()) === "play", "the primary action");
    await tv.eventually(async () => await tv.page.locator(".audiobook-about-more").isVisible(), "MORE pill reveals for clamped overview");
    await tv.remote(40);
    assert.equal(await tv.focused(), "about", "Down from the actions enters About");
    assert.equal(await tv.page.locator('[data-focus="about"] .audiobook-about, [data-focus="about"] .audiobook-facts').count(), 0, "overview and facts live outside the button subtree");
    assert.equal(await tv.page.locator('[data-focus="about"]').getAttribute("aria-describedby"), null, "About button does not recite the full overview or facts on focus");
    assert.equal(await tv.page.locator('[data-focus="about"]').getAttribute("aria-haspopup"), "dialog");
    assert.equal(await tv.page.locator('[data-focus="about"]').getAttribute("aria-label"), "About: MORE");
    assert.equal(await tv.page.locator('[data-focus="about"]').evaluate(node => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)");
    await tv.page.keyboard.press("Enter");
    await showing(tv, "audiobook:audiobook:fresh:description");
    assert.equal(await tv.page.locator('.audiobook-description[role="dialog"]').count(), 1);
    assert.equal(await tv.focused(), "passage:0");
    const count = await tv.page.locator(".audiobook-passage").count();
    assert.ok(count >= 6, `split across passages, got ${count}`);
    for (let step = 0; step < count - 1; step++) await tv.remote(40);
    assert.equal(await tv.focused(), `passage:${count - 1}`);
    const bodyScroll = await tv.page.locator(".audiobook-description-body").evaluate(node => node.scrollTop);
    assert.ok(bodyScroll > 0, `passages scrolled description body: ${bodyScroll}`);
    await tv.remote(BACK);
    await showing(tv, "audiobook:audiobook:fresh");
    assert.equal(await tv.focused(), "about");
});

audiobookTest("near-end progress with played=false syncs the Finished toggle and state to finished", async (tv, catalog) => {
    catalog.progress.set("audiobook:hail", 10797);
    await tv.page.locator('[data-section="shelf"] [data-focus="audiobook:hail"]').click();
    await showing(tv, "audiobook:audiobook:hail");
    assert.equal(await tv.page.locator('[data-focus="play"]').innerText(), "Play Again");
    const finished = tv.page.locator('[data-focus="finished"]');
    assert.equal(await finished.getAttribute("aria-pressed"), "true");
    assert.equal(await finished.locator("svg").getAttribute("data-symbol"), "checkmark.circle.fill");
    await finished.focus();
    await tv.page.keyboard.press("Enter");
    await tv.eventually(async () => catalog.mutations.includes("DELETE /watched/audiobook%3Ahail"), "toggling near-end finished sends DELETE /watched");
});
