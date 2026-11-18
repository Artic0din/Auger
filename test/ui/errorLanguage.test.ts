// The error pages and the shared empty states in German and Arabic (silo-apple Components/ErrorState.swift, ErrorView.swift,
// Screens/Sections/SectionCatalogView.swift): the headline, the message and the recovery buttons read from the catalog and
// are drawn again when the language's file lands late; text the server sent stays as it sent it; English is unchanged.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page, Route } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { FakeHome } from "../native/support/fakeHome.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { PROBLEM_BASE } from "../native/support/fakeSilo.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const BACK = 10009;
const CARD = '[data-section="recent/12"] [data-focus="movie:m0004"]';
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);

async function inLanguage(language: string, prepare: (page: Page) => Promise<void>, body: (tv: Tv, catalog: FakeHome) => Promise<void>, fileFirst = true): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeHome();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await prepare(tv.page);
        tv.fake.catalog = catalog;
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        settings.profile().set(APP_LANGUAGE_KEY, language);
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"] [data-section]').first().waitFor();
        await homeDetailsRead(tv);
        if (fileFirst) await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(text("topBar.forYou", language)), `${language} top bar`);
        await body(tv, catalog);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

/** The error page's headline, message and buttons, top to bottom. */
async function errorPage(tv: Tv): Promise<{ headline: string; message: string; buttons: string[] }> {
    const page = tv.page.locator(".details-failure");
    await page.waitFor();
    return {
        headline: await page.locator(".search-state-title").innerText(),
        message: await page.locator(".search-state-description").innerText(),
        buttons: await page.locator(".browse-button").evaluateAll(nodes => nodes.map(node => node.textContent ?? "")),
    };
}

const TRY_AGAIN = (language: string): string => text("shell.errorView.tryAgain", language);
const GO_BACK = (language: string): string => text("player.goBack", language);

for (const language of ["de", "ar"]) {
    test(`a missing title reads Apple's Not found page in ${language}, with Go Back first`, async () => {
        await inLanguage(language, async () => undefined, async (tv, catalog) => {
            catalog.removed.add("movie:m0004");
            await tv.page.locator(CARD).click();
            await tv.page.locator('[data-view="item:failed"]').waitFor();
            assert.deepEqual(await errorPage(tv), { headline: text("shell.errorView.notFound", language), message: text("shell.error.notFound", language), buttons: [GO_BACK(language), TRY_AGAIN(language)] });
            if (language === "ar") assert.equal(await tv.page.evaluate(() => document.documentElement.getAttribute("dir")), "rtl");
        });
    });

    test(`a refused title keeps the server's reason as sent under ${language}'s Not allowed headline`, async () => {
        const refusal = { type: `${PROBLEM_BASE}permission_denied`, title: "Forbidden", status: 403, detail: "This title is not available to this profile." };
        await inLanguage(language, async () => undefined, async tv => {
            await tv.page.route("**/api/v2/catalog/items/movie%3Am0004**", route => route.fulfill({ status: 403, contentType: "application/problem+json", body: JSON.stringify(refusal) }));
            await tv.page.locator(CARD).click();
            await tv.page.locator('[data-view="item:failed"]').waitFor();
            assert.deepEqual(await errorPage(tv), { headline: text("shell.errorView.notAllowed", language), message: refusal.detail, buttons: [GO_BACK(language), TRY_AGAIN(language)] });
            // English with no right-to-left letter in it is its own language and direction, so Arabic's page does not move its full stop.
            if (language === "ar") {
                assert.equal(await tv.page.locator(".details-failure .search-state-description").getAttribute("lang"), "en");
                assert.equal(await tv.page.locator(".details-failure .search-state-description").getAttribute("dir"), "ltr");
            }
        });
    });

    test(`a failed Explore all page reads Apple's generic error in ${language}`, async () => {
        const problem = { type: "about:blank", title: "Server error", status: 500 };
        await inLanguage(language, async () => undefined, async tv => {
            await tv.page.route("**/api/v2/catalog/query**", async (route: Route) => route.request().method() === "POST" && route.request().postDataJSON()?.source === "section"
                ? route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify(problem) })
                : route.fallback());
            await tv.page.locator('[data-focus="expand:recent/12"]').click();
            assert.deepEqual(await errorPage(tv), { headline: text("status.errorGeneric", language), message: text("shell.error.serverProblem", language), buttons: [TRY_AGAIN(language)] });
        });
    });

    test(`an expired session offers Sign In Again in ${language}`, async () => {
        await inLanguage(language, async () => undefined, async tv => {
            await tv.page.route("**/api/v2/catalog/query**", route => route.request().method() === "POST" && route.request().postDataJSON()?.source === "section"
                ? route.fulfill({ status: 401, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unauthorized", status: 401 }) })
                : route.fallback());
            await tv.page.locator('[data-focus="expand:recent/12"]').click();
            assert.deepEqual(await errorPage(tv), { headline: text("shell.errorView.sessionExpired", language), message: text("shell.error.sessionExpired", language), buttons: [text("settings.accounts.signInAgain", language), TRY_AGAIN(language)] });
        });
    });
}

test("an error page drawn in English is drawn again in German when the file lands", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await inLanguage("de", async page => { await page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); }); }, async (tv, catalog) => {
        catalog.removed.add("movie:m0004");
        await tv.page.locator(CARD).click();
        await tv.page.locator('[data-view="item:failed"]').waitFor();
        assert.equal((await errorPage(tv)).headline, "Not found", "English until the file lands");
        release();
        await tv.eventually(async () => (await errorPage(tv)).headline === text("shell.errorView.notFound", "de"), "the headline is German");
        assert.deepEqual(await errorPage(tv), { headline: text("shell.errorView.notFound", "de"), message: text("shell.error.notFound", "de"), buttons: [GO_BACK("de"), TRY_AGAIN("de")] });
        await tv.remote(BACK);
    }, false);
});

test("a generic server error drawn in English keeps its catalog message and is drawn again in German when the file lands", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const problem = { type: "about:blank", title: "Server error", status: 500 };
    await inLanguage("de", async page => { await page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); }); }, async tv => {
        await tv.page.route("**/api/v2/catalog/query**", route => route.request().method() === "POST" && route.request().postDataJSON()?.source === "section"
            ? route.fulfill({ status: 500, contentType: "application/problem+json", body: JSON.stringify(problem) })
            : route.fallback());
        await tv.page.locator('[data-focus="expand:recent/12"]').click();
        assert.deepEqual(await errorPage(tv), { headline: "Something went wrong", message: "The server ran into a problem. Try again in a moment.", buttons: ["Try Again"] }, "English until the file lands");
        release();
        await tv.eventually(async () => (await errorPage(tv)).message === text("shell.error.serverProblem", "de"), "the message is German");
        assert.deepEqual(await errorPage(tv), { headline: text("status.errorGeneric", "de"), message: text("shell.error.serverProblem", "de"), buttons: [TRY_AGAIN("de")] });
        await tv.remote(BACK);
    }, false);
});
