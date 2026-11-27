import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { PRIMARY_MENU_KEY } from "../../src/contracts/v2/navigation.ts";
import { HIDDEN_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeRequests } from "../native/support/fakeRequests.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { afterPaint, homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function start(tv: Tv, catalog: FakeRequests = new FakeRequests(), offerSignOut = false): Promise<void> {
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.profile().set(PRIMARY_MENU_KEY, null);
    settings.profile().set(HIDDEN_KEY, catalog.households.get("p-owner")?.hidden ?? null);
    await tv.page.evaluate(() => window.browseHarness.connect());
    await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
    tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
    await tv.jump(5000);
    await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
    await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
    await tv.page.evaluate(offer => window.browseHarness.mount(offer), offerSignOut);
    await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
    await homeDetailsRead(tv);
    await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "initial startup answers delivered");
    await afterPaint(tv);
}

test("Home content DOM nodes stay identical across top-bar dropdowns, flyouts, Back, and Down off For You", async () => {
    const tv = await openTv(browser, { app: "browse" });
    try {
        const catalog = new FakeRequests();
        const owner = catalog.households.get("p-owner");
        assert.ok(owner);
        owner.libraries.push({ id: "20", name: "4K Films", type: "movies", sort_order: 4 });
        await start(tv, catalog);
        await tv.page.locator('[data-focus="movies"]').waitFor();

        await tv.page.evaluate(() => {
            const w = window as unknown as {
                __homeContent: Element[];
                __homeCard: Element | null;
                __outgoingSeen: number;
            };
            w.__homeContent = Array.from(document.querySelectorAll(".browse > .skyline-content > *"));
            w.__homeCard = document.querySelector('.browse > .skyline-content [data-section="recently_added"] .browse-card');
            w.__outgoingSeen = 0;
            new MutationObserver((records) => {
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if (node instanceof Element && node.classList.contains("skyline-route-outgoing")) w.__outgoingSeen++;
                    }
                }
            }).observe(document.body, { childList: true, subtree: true });
        });

        const assertRetained = async (step: string): Promise<void> => {
            const state = await tv.page.evaluate(() => {
                const w = window as unknown as {
                    __homeContent: Element[];
                    __homeCard: Element | null;
                    __outgoingSeen: number;
                };
                const current = Array.from(document.querySelectorAll(".browse > .skyline-content > *"));
                const card = document.querySelector('.browse > .skyline-content [data-section="recently_added"] .browse-card');
                return {
                    countMatch: current.length === w.__homeContent.length && current.length > 0,
                    sectionsIdentical: current.length === w.__homeContent.length && current.every((el, index) => el === w.__homeContent[index]),
                    cardIdentical: card !== null && card === w.__homeCard,
                    outgoingSeen: w.__outgoingSeen,
                };
            });
            assert.equal(state.countMatch, true, `${step}: expected Home content sections to remain populated`);
            assert.equal(state.sectionsIdentical, true, `${step}: Home .skyline-content children should be strictly retained`);
            assert.equal(state.cardIdentical, true, `${step}: Home card DOM node should stay ===`);
            assert.equal(state.outgoingSeen, 0, `${step}: dropdown navigation should not clone .skyline-route-outgoing`);
        };

        // Movies dropdown (library list) + flyout
        await tv.page.locator('[data-focus="movies"]').focus();
        await tv.jump(250);
        await tv.page.locator('.skyline-selector [data-focus="library:12"]').waitFor();
        await assertRetained("after Movies dropdown opens");

        await tv.remote(40);
        assert.equal(await tv.focused(), "library:12");
        await tv.jump(150);
        await tv.page.locator('.skyline-flyout [data-focus="section:Recommended"]').waitFor();
        await assertRetained("after Movies flyout opens");

        // Switch directly to Series dropdown
        await tv.page.locator('[data-focus="series"]').focus();
        await tv.jump(250);
        await tv.page.locator('.skyline-selector:not(.skyline-flyout) [data-focus="section:Recommended"]').waitFor();
        await assertRetained("after switching to Series dropdown");

        // Open For You dropdown, dismiss with Back, then reopen and Down off last row into Home content
        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.jump(250);
        await tv.page.locator('.skyline-selector [data-focus="watchlist"]').waitFor();
        await assertRetained("after For You dropdown opens");

        await tv.remote(10009);
        assert.equal(await tv.focused(), "for_you");
        assert.equal(await tv.page.locator(".skyline-selector:not(.skyline-flyout)").isVisible(), false);
        await assertRetained("after Back dismisses For You dropdown");

        for (let step = 0; step < 4; step++) await tv.remote(40);
        assert.equal(await tv.focused(), "movie:m0001");
        await assertRetained("after Down off For You lands on Home content");
    } finally {
        await tv.page.context().close();
    }
});

test("Profile dropdown, rebuildProfile(), Sign Out confirmation inert/aria-hidden, and Cancel keep Home DOM and preserve focus", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const heldRequests = tv.fake.hold("/requests/status", true);
    try {
        await start(tv, new FakeRequests(), true);
        await tv.page.evaluate(() => {
            const w = window as unknown as { __homeContent: Element[]; __homeCard: Element | null };
            w.__homeContent = Array.from(document.querySelectorAll(".browse > .skyline-content > *"));
            w.__homeCard = document.querySelector('.browse > .skyline-content [data-section="recently_added"] .browse-card');
        });

        // Open profile menu with Requests not yet enabled, move down to Settings
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(40);
        assert.equal(await tv.focused(), "history");
        await tv.remote(40);
        assert.equal(await tv.focused(), "settings");

        // Late /requests/status arrival triggers rebuildProfile(): Requests row appears while Settings keeps focus (never bounces to nav)
        const navFocuses = await tv.page.evaluate(() => {
            let count = 0;
            document.querySelector(".browse-nav")?.addEventListener("focusin", () => { count++; });
            (window as unknown as { __getNavFocuses: () => number }).__getNavFocuses = () => count;
            return true;
        });
        assert.equal(navFocuses, true);
        heldRequests.release();
        await tv.page.locator('.skyline-selector[data-menu-kind="profile"] [data-focus="requests"]').waitFor();
        assert.equal(await tv.focused(), "settings");
        assert.equal(await tv.page.evaluate(() => (window as unknown as { __getNavFocuses: () => number }).__getNavFocuses()), 0);

        // Move to Sign Out and open confirmation
        await tv.page.locator('.skyline-selector [data-focus="signout"]').click();
        await tv.page.getByRole("alertdialog", { name: "Sign Out", exact: true }).waitFor();
        assert.equal(await tv.focused(), "cancel-signout");
        assert.deepEqual(await tv.page.evaluate(() => ({
            navInert: document.querySelector<HTMLElement>(".browse-nav")?.inert,
            navHidden: document.querySelector(".browse-nav")?.getAttribute("aria-hidden"),
            bodyInert: document.querySelector<HTMLElement>(".skyline-content")?.inert,
            bodyHidden: document.querySelector(".skyline-content")?.getAttribute("aria-hidden"),
        })), { navInert: true, navHidden: "true", bodyInert: true, bodyHidden: "true" });

        // Cancel confirmation restores interactive nav and Home content
        await tv.page.locator('[data-focus="cancel-signout"]').click();
        assert.equal(await tv.focused(), "profiles");
        assert.deepEqual(await tv.page.evaluate(() => ({
            navInert: document.querySelector<HTMLElement>(".browse-nav")?.inert,
            navHidden: document.querySelector(".browse-nav")?.getAttribute("aria-hidden"),
            bodyInert: document.querySelector<HTMLElement>(".skyline-content")?.inert,
            bodyHidden: document.querySelector(".skyline-content")?.getAttribute("aria-hidden"),
        })), { navInert: false, navHidden: null, bodyInert: false, bodyHidden: null });

        const retained = await tv.page.evaluate(() => {
            const w = window as unknown as { __homeContent: Element[]; __homeCard: Element | null };
            const current = Array.from(document.querySelectorAll(".browse > .skyline-content > *"));
            const card = document.querySelector('.browse > .skyline-content [data-section="recently_added"] .browse-card');
            return current.length === w.__homeContent.length && current.every((el, i) => el === w.__homeContent[i]) && card === w.__homeCard;
        });
        assert.equal(retained, true, "Home content DOM nodes remained identical across profile rebuild and Sign Out cancel");
    } finally {
        heldRequests.release();
        await tv.page.context().close();
    }
});
