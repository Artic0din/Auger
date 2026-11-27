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
                __homeSubtree: Element[];
                __homeCard: Element | null;
                __outgoingSeen: number;
            };
            w.__homeContent = Array.from(document.querySelectorAll(".browse > .skyline-content > *"));
            w.__homeSubtree = Array.from(document.querySelectorAll(".browse > .skyline-content, .browse > .skyline-content *"));
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
                    __homeSubtree: Element[];
                    __homeCard: Element | null;
                    __outgoingSeen: number;
                };
                const current = Array.from(document.querySelectorAll(".browse > .skyline-content > *"));
                const subtree = Array.from(document.querySelectorAll(".browse > .skyline-content, .browse > .skyline-content *"));
                const card = document.querySelector('.browse > .skyline-content [data-section="recently_added"] .browse-card');
                return {
                    countMatch: current.length === w.__homeContent.length && current.length > 0,
                    sectionsIdentical: current.length === w.__homeContent.length && current.every((el, index) => el === w.__homeContent[index]),
                    subtreeIdentical: subtree.length === w.__homeSubtree.length && subtree.every((el, index) => el === w.__homeSubtree[index]),
                    cardIdentical: card !== null && card === w.__homeCard,
                    outgoingSeen: w.__outgoingSeen,
                };
            });
            assert.equal(state.countMatch, true, `${step}: expected Home content sections to remain populated`);
            assert.equal(state.sectionsIdentical, true, `${step}: Home .skyline-content children should be strictly retained`);
            assert.equal(state.subtreeIdentical, true, `${step}: Home .skyline-content descendants (including card contents) should be strictly retained`);
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

test("held Select on a Home card survives background /requests/status arrival for both short release and long hold", async () => {
    const waitCapabilitySettled = async (tv: Tv): Promise<void> => {
        await tv.eventually(
            async () => tv.fake.requests.some(request => request.path === "/requests/status") && tv.pendingReplies <= tv.fake.heldReplies,
            "capability probe answered",
        );
        await afterPaint(tv);
    };

    // Part A: short press release while /requests/status finishes mid-press opens Details.
    {
        const tv = await openTv(browser, { app: "browse" });
        const heldRequests = tv.fake.hold("/requests/status", true);
        try {
            await start(tv, new FakeRequests());
            const card = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first();
            await card.focus();
            await tv.page.keyboard.down("Enter");
            assert.equal(await card.getAttribute("data-pressed"), "");
            heldRequests.release();
            await waitCapabilitySettled(tv);
            await tv.page.keyboard.up("Enter");
            await tv.page.locator('[data-view="item:movie:m0001"]').waitFor();
            assert.deepEqual(tv.console, []);
        } finally {
            heldRequests.release();
            await tv.page.context().close();
        }
    }

    // Part B: long press held across /requests/status probe arrival still triggers quick-actions menu at 650 ms.
    {
        const tv = await openTv(browser, { app: "browse" });
        const heldRequests = tv.fake.hold("/requests/status", true);
        try {
            await start(tv, new FakeRequests());
            const card = tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').first();
            await card.focus();
            await tv.page.keyboard.down("Enter");
            assert.equal(await card.getAttribute("data-pressed"), "");
            heldRequests.release();
            await waitCapabilitySettled(tv);
            await tv.jump(700);
            await tv.page.getByRole("menu").waitFor();
            await tv.page.keyboard.up("Enter");
            assert.deepEqual(tv.console, []);
        } finally {
            heldRequests.release();
            await tv.page.context().close();
        }
    }
});

test("held Select on a profile menu row transfers across rebuildProfile() and activates on release", async () => {
    const tv = await openTv(browser, { app: "browse" });
    const heldRequests = tv.fake.hold("/requests/status", true);
    try {
        await start(tv, new FakeRequests(), true);
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.remote(40);
        await tv.remote(40);
        assert.equal(await tv.focused(), "settings");

        await tv.page.keyboard.down("Enter");
        assert.equal(await tv.page.locator('.skyline-selector [data-focus="settings"]').getAttribute("data-pressed"), "");
        heldRequests.release();
        await tv.page.locator('.skyline-selector[data-menu-kind="profile"] [data-focus="requests"]').waitFor();
        assert.equal(await tv.focused(), "settings");
        await tv.page.keyboard.up("Enter");
        await tv.page.locator(".settings-pane").waitFor();
        assert.deepEqual(tv.console, []);
    } finally {
        heldRequests.release();
        await tv.page.context().close();
    }
});

test("deferred Home libraries arrival while a dropdown is open preserves Home DOM, avatar, and active tab on close", async () => {
    const tv = await openTv(browser, { app: "browse" });
    let heldLibraries: ReturnType<typeof tv.fake.hold> | undefined;
    try {
        const catalog = new FakeRequests();
        const owner = catalog.households.get("p-owner");
        assert.ok(owner);
        const savedLibraries = owner.libraries.splice(0, owner.libraries.length);
        tv.fake.catalog = catalog;
        const settings = new FakeSettings(tv.fake);
        settings.profile().set(PRIMARY_MENU_KEY, null);
        settings.profile().set(HIDDEN_KEY, owner.hidden ?? null);
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        heldLibraries = tv.fake.hold("/user/libraries", true);
        owner.libraries.push(...savedLibraries);
        await tv.page.evaluate(() => window.browseHarness.mount(false));
        await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
        await homeDetailsRead(tv);
        await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "non-held startup answers settled");
        await afterPaint(tv);
        assert.equal(await tv.page.locator('.browse-nav [data-focus="movies"]').count(), 0);

        const initialAvatar = await tv.page.locator(".skyline-profile .navigation-avatar").getAttribute("data-avatar-identity");
        assert.ok(initialAvatar !== null && initialAvatar !== "");

        await tv.page.locator('[data-focus="for_you"]').focus();
        await tv.jump(250);
        await tv.page.locator('.skyline-selector [data-focus="watchlist"]').waitFor();
        heldLibraries.release();
        await tv.eventually(async () => tv.pendingReplies <= tv.fake.heldReplies, "libraries delivered while dropdown open");
        assert.equal(await tv.page.locator('.browse-nav [data-focus="movies"]').count(), 0, "nav rebuild defers until dropdown closes");
        await tv.page.evaluate(() => {
            (window as unknown as { __homeSubtree: Element[] }).__homeSubtree = Array.from(
                document.querySelectorAll(".browse > .skyline-content, .browse > .skyline-content *"),
            );
        });

        await tv.remote(10009);
        await tv.page.locator('.browse-nav [data-focus="movies"]').waitFor();
        const afterClose = await tv.page.evaluate(() => {
            const prev = (window as unknown as { __homeSubtree: Element[] }).__homeSubtree;
            const current = Array.from(document.querySelectorAll(".browse > .skyline-content, .browse > .skyline-content *"));
            const homeTab = document.querySelector('.browse-nav [data-focus="home"]');
            const avatar = document.querySelector(".skyline-profile .navigation-avatar") as HTMLElement | null;
            return {
                subtreeIdentical: current.length > 0 && current.length === prev.length && current.every((el, i) => el === prev[i]),
                ariaCurrent: homeTab?.getAttribute("aria-current"),
                ariaSelected: homeTab?.getAttribute("aria-selected"),
                avatarIdentity: avatar?.dataset.avatarIdentity ?? null,
            };
        });
        assert.deepEqual(afterClose, {
            subtreeIdentical: true,
            ariaCurrent: "page",
            ariaSelected: "true",
            avatarIdentity: initialAvatar,
        });
        assert.deepEqual(tv.console, []);
    } finally {
        heldLibraries?.release();
        await tv.page.context().close();
    }
});
