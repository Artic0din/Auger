// Change Account and Settings › Accounts in German and Arabic (silo-apple tvOS/Screens/Auth/TVChangeAccountView.swift and
// tvOS/Screens/Settings/TVAccountsSettingsView.swift): the text reads from the catalog, the screen follows the shown language
// instead of carrying lang=en, and in Arabic it mirrors. A server's name and an account's username stay as saved.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { formattingLocale } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { ACTIVE, openChangeAccount, openSettingsAccounts, seedAccounts, signIn, withSignedInTv } from "./support/accounts.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37;
const RIGHT = 39;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);
const upper = (value: string, language: string): string => value.toLocaleUpperCase(formattingLocale(language, "en-US"));

async function seed(tv: Tv): Promise<{ owner: string; baseUrl: string }> {
    return seedAccounts(tv, 10, [
        { id: "second", baseUrl: ACTIVE, username: "Second", profileCount: 3, needsSignIn: false, lastUsedAt: 5 },
        { id: "stale", baseUrl: ACTIVE, username: "Stale", profileCount: 0, needsSignIn: true, lastUsedAt: 1 },
    ]);
}

test("Change Account reads in German and carries lang=de, not lang=en", async () => {
    await withSignedInTv(browser, async tv => {
        const { owner } = await seed(tv);
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", "German top bar");
        await openChangeAccount(tv);
        const root = tv.page.locator(".accounts-screen");
        assert.equal(await root.getAttribute("lang"), "de");
        assert.equal(await tv.page.locator(".accounts-title").innerText(), text("accounts.headline", "de"));
        assert.equal(await tv.page.locator(".accounts-screen .signin-text").innerText(), text("accounts.body", "de"));
        assert.equal((await tv.page.locator('.accounts-rail [data-focus="add-server"]').innerText()).replace(/^\+/, ""), text("accounts.addServer", "de"));
        const cards = await tv.page.locator(".accounts-pane .account-card").allInnerTexts();
        assert.ok(cards.some(card => card.includes(text("account.profiles.count", "de", { count: 3 }))), `a profile count in German: ${JSON.stringify(cards)}`);
        assert.deepEqual(await tv.page.locator(`.accounts-pane [data-focus="${owner}"] .account-badge`).allInnerTexts(), [upper(text("changeAccount.current", "de"), "de")]);
        assert.deepEqual(await tv.page.locator('.accounts-pane [data-focus="stale"] .account-badge').allInnerTexts(), [upper(text("accounts.badge.signInAgain", "de"), "de")]);
        const add = await tv.page.locator('.accounts-pane [data-focus="add-account"]').innerText();
        assert.ok(add.includes(text("changeAccount.addAccount", "de")), add);
        assert.ok(add.includes(text("changeAccount.signInOn", "de", { server: new URL(await tv.page.evaluate(() => location.origin)).host })), add);
        assert.equal(await tv.page.locator('.accounts-pane [data-focus="second"] .account-name').first().innerText().then(name => name.split("\n")[0]), "Second", "an account's name stays as saved");
    }, "de");
});

test("Settings › Accounts and its confirmations read in German", async () => {
    await withSignedInTv(browser, async tv => {
        await seed(tv);
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", "German top bar");
        await openSettingsAccounts(tv);
        const panel = tv.page.locator(".accounts-settings");
        assert.equal(await panel.locator("h1").innerText(), text("accounts.title", "de"));
        assert.equal(await panel.locator("header p").innerText(), text("servers.accounts.blurbAppleTv", "de").replace(/Apple TV/gi, "TV"));
        assert.equal(await tv.page.locator(".accounts-settings > p").innerText(), text("settings.accounts.footerAppleTv", "de").replace(/Apple TV/gi, "TV"));
        assert.equal(await tv.page.locator('[data-focus="add-server"]').innerText(), text("settings.accounts.addServer", "de"));
        assert.equal(await tv.page.locator('[data-focus^="remove:"]').first().innerText(), text("settings.accounts.remove", "de"));
        assert.equal(await tv.page.locator('[data-focus="stale"] .accounts-row-value').innerText(), text("accounts.badge.signInAgain", "de"));
        assert.equal(await tv.page.locator('[data-focus="second"] .accounts-row-value').innerText(), text("account.profiles.count", "de", { count: 3 }));
        await tv.page.locator('[data-focus^="remove:"]').first().click();
        const title = await tv.page.locator(".skyline-confirm-title").innerText();
        assert.equal(title, text("servers.remove.title", "de", { server: new URL(await tv.page.evaluate(() => location.origin)).host }));
        assert.equal(await tv.page.locator('[data-focus="cancel"]').innerText(), text("common.cancel", "de"));
        assert.equal(await tv.page.locator('[data-focus="confirm"]').innerText(), text("servers.remove.confirm", "de"));
        assert.equal(await tv.page.locator(".skyline-confirm-message").innerText(), text("account.removeServer.signsOutMany", "de", { count: 3 }));
    }, "de");
});

test("in Arabic Change Account is mirrored: its rail is on the right, its badge words are Arabic and Left enters the cards", async () => {
    await withSignedInTv(browser, async tv => {
        const { owner } = await seed(tv);
        await tv.eventually(async () => await tv.page.evaluate(() => document.documentElement.getAttribute("dir")) === "rtl", "dir rtl");
        await openChangeAccount(tv);
        const root = tv.page.locator(".accounts-screen");
        assert.equal(await root.getAttribute("lang"), "ar");
        assert.equal(await root.getAttribute("dir"), "rtl");
        assert.equal(await tv.page.locator(".accounts-title").innerText(), text("accounts.headline", "ar"));
        assert.deepEqual(await tv.page.locator(`.accounts-pane [data-focus="${owner}"] .account-badge`).allInnerTexts(), [upper(text("changeAccount.current", "ar"), "ar")]);
        const edges = await tv.page.evaluate(() => ({
            rail: document.querySelector(".accounts-rail")?.getBoundingClientRect().left ?? Number.NaN,
            pane: document.querySelector(".accounts-pane")?.getBoundingClientRect().left ?? Number.NaN,
            wordmark: document.querySelector(".accounts-wordmark")?.getBoundingClientRect().left ?? Number.NaN,
        }));
        assert.ok(edges.rail > edges.pane, `the server rail is on the right: ${JSON.stringify(edges)}`);
        assert.ok(edges.wordmark > 960, `the wordmark hangs from the right edge: ${JSON.stringify(edges)}`);
        await tv.page.locator(`.accounts-rail [data-focus]`).first().focus();
        await tv.remote(LEFT);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".accounts-pane") !== null), true, "Left from the rail enters the cards on its left");
        await tv.remote(RIGHT);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.closest(".accounts-rail") !== null), true, "Right returns to the rail");
    }, "ar");
});

test("Change Account in English carries the page's language and stays left to right", async () => {
    await withSignedInTv(browser, async tv => {
        await seed(tv);
        await openChangeAccount(tv);
        const root = tv.page.locator(".accounts-screen");
        assert.equal(await root.getAttribute("lang"), "en");
        assert.equal(await tv.page.locator(".accounts-title").innerText(), "Change account");
        assert.equal(await tv.page.locator('.accounts-pane [data-focus="second"] .account-count').innerText(), "3 profiles");
    });
});

test("the expired-session dialog reads in German", async () => {
    await withSignedInTv(browser, async tv => {
        await seed(tv);
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", "German top bar");
        await openSettingsAccounts(tv);
        await tv.page.locator('[data-focus="stale"]').click();
        await tv.page.locator('[data-view="account-expired"]').waitFor();
        assert.equal(await tv.page.locator(".confirm-dialog .skyline-confirm-title").innerText(), text("settings.accounts.expiredTitleAppleTv", "de", { account: "Stale" }));
        assert.equal(await tv.page.locator(".confirm-dialog .skyline-confirm-message").count(), 0);
        assert.equal(await tv.page.locator('.confirm-dialog [data-focus="signin"]').innerText(), text("account.signInAgain", "de"));
        const signOut = tv.page.locator('.confirm-dialog [data-focus="signout"]');
        assert.equal(await signOut.innerText(), text("settings.accounts.signOut", "de"));
        assert.equal(await signOut.evaluate(node => node.classList.contains("skyline-destructive")), true);
        assert.equal(await tv.page.locator('.confirm-dialog [data-focus="cancel"]').innerText(), text("common.cancel", "de"));
    }, "de");
});

test("a failed account switch shows the German alert over Change Account", async () => {
    await withSignedInTv(browser, async tv => {
        await seed(tv);
        await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").first().innerText()) !== "Home", "German top bar");
        await tv.page.evaluate(() => {
            window.appHarness.mountAccounts(() => Promise.reject(new Error("Switch failed")));
        });
        await tv.page.locator('[data-view="change-account"]').waitFor();
        await tv.page.locator('.accounts-pane [data-focus="second"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator(".signin-alert").waitFor();
        assert.equal(await tv.page.locator(".signin-alert-title").innerText(), text("account.alertTitle", "de"));
        assert.equal(await tv.page.locator(".signin-alert-text").innerText(), "Switch failed");
        assert.equal(await tv.page.locator('.signin-alert [data-focus="ok"]').innerText(), text("shell.notice.ok", "de"));
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('[data-view="change-account"]').waitFor();
        assert.equal(await tv.focused(), "second");
    }, "de");
});

test("a German catalog that lands while Change Account is up redraws it in German", async () => {
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tv = await openTv(browser, { app: "application" });
    // Registered after the harness's own routes, so it sees the request first and passes it on once released.
    await tv.page.route("**/catalog/de.js", async route => { await held; await route.fallback(); });
    const catalog = new FakeCatalog();
    catalog.fileIds.set("movie:m0001", "42");
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "de");
    try {
        await signIn(tv);
        await seed(tv);
        await openChangeAccount(tv);
        assert.equal(await tv.page.locator(".accounts-title").innerText(), "Change account", "English until the file lands");
        assert.equal(await tv.page.locator(".accounts-screen").getAttribute("lang"), "en");
        release?.();
        await tv.eventually(async () => (await tv.page.locator(".accounts-title").innerText()) === text("accounts.headline", "de"), "German headline");
        assert.equal(await tv.page.locator(".accounts-screen").getAttribute("lang"), "de");
        assert.equal(await tv.page.locator('.accounts-pane [data-focus="second"] .account-count').innerText(), text("account.profiles.count", "de", { count: 3 }));
    } finally { release?.(); await tv.page.context().close(); }
});

/** Signs in with German stored but its file held, so Change Account and Settings › Accounts first draw in English. */
async function withHeldGerman(body: (tv: Tv, land: () => Promise<void>) => Promise<void>): Promise<void> {
    let release: (() => void) | undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tv = await openTv(browser, { app: "application" });
    await tv.page.route("**/catalog/de.js", async route => { await held; await route.fallback(); });
    const catalog = new FakeCatalog();
    catalog.fileIds.set("movie:m0001", "42");
    tv.fake.catalog = catalog;
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "de");
    try {
        await signIn(tv);
        await seed(tv);
        await body(tv, async () => { release?.(); await tv.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))); });
        assert.deepEqual(tv.console, []);
    } finally { release?.(); await tv.page.context().close(); }
}

test("a catalog that lands while a confirmation is open leaves the dialog alone and the screen redraws when it closes", async () => {
    await withHeldGerman(async (tv, land) => {
        await openSettingsAccounts(tv);
        await tv.page.locator('[data-focus^="remove:"]').first().click();
        const dialog = await tv.page.locator(".skyline-confirm-title").elementHandle();
        assert.ok(dialog);
        const english = await dialog.innerText();
        assert.match(english, /^Remove .*\?$/);
        await land();
        assert.equal(await dialog.evaluate(node => node.isConnected), true, "the dialog is still the one on screen");
        assert.equal(await tv.page.locator(".skyline-confirm-title").innerText(), english, "and still in English");
        await tv.page.locator('[data-focus="cancel"]').click();
        await tv.eventually(async () => (await tv.page.locator(".accounts-settings h1").innerText()) === text("accounts.title", "de"), "German pane after the dialog closes");
    });
});

test("a catalog that lands while Select is held waits for the release", async () => {
    await withHeldGerman(async (tv, land) => {
        await openChangeAccount(tv);
        const rail = tv.page.locator(".accounts-rail [data-focus]").first();
        await rail.focus();
        await tv.page.keyboard.down("Enter");
        await land();
        assert.equal(await tv.page.locator(".accounts-title").innerText(), "Change account", "the press is not replaced under the viewer");
        await tv.page.keyboard.up("Enter");
        await tv.eventually(async () => (await tv.page.locator(".accounts-title").innerText()) === text("accounts.headline", "de"), "German headline after release");
    });
});

test("a catalog that lands while Add server has focus keeps focus on it", async () => {
    await withHeldGerman(async (tv, land) => {
        await openChangeAccount(tv);
        await tv.page.locator('[data-focus="add-server"]').first().focus();
        assert.equal(await tv.focused(), "add-server");
        await land();
        await tv.eventually(async () => (await tv.page.locator(".accounts-title").innerText()) === text("accounts.headline", "de"), "German headline");
        assert.equal(await tv.focused(), "add-server", "focus stays on Add server, not on the selected server");
    });
});

test("a catalog that lands while the second account has focus keeps focus on that account", async () => {
    await withHeldGerman(async (tv, land) => {
        await openChangeAccount(tv);
        await tv.page.locator('.accounts-pane [data-focus="second"]').focus();
        assert.equal(await tv.focused(), "second");
        await land();
        await tv.eventually(async () => (await tv.page.locator(".accounts-title").innerText()) === text("accounts.headline", "de"), "German headline");
        assert.equal(await tv.focused(), "second", "focus stays on the second account, by its id");
    });
});
