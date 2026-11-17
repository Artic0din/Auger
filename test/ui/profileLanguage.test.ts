// The PIN screen and Add Profile in German and Arabic (silo-apple Screens/Profiles/PINEntryView.swift, AddProfileFromMenu.swift
// and ProfileCreateView): their text reads from the catalog, they follow the shown language instead of carrying lang=en, and
// in Arabic the number pad and form mirror. Text with no Apple key stays English.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const IME_DONE = 65376;
const LEFT = 37;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);

async function openPin(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.remote(IME_DONE);
    await tv.page.keyboard.press("Enter");
    await tv.page.locator('[data-screen="code"]').waitFor();
    const code = [...tv.fake.devices.keys()].pop();
    assert.ok(code !== undefined);
    tv.fake.approve(code);
    await tv.jump(5000);
    await tv.jump(1000);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
    await tv.page.locator('[data-focus="profile:p-kid"]').click();
    await tv.page.locator('[data-screen="pin"]').waitFor();
}

async function withPin(locale: string, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { profiles: true, locale });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await openPin(tv);
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("the PIN screen reads in German and carries lang=de", async () => {
    await withPin("de-DE", async tv => {
        assert.equal(await tv.page.locator('[data-screen="pin"]').getAttribute("lang"), "de");
        assert.equal(await tv.page.locator(".pin-status").innerText(), text("pin.prompt", "de"));
        assert.equal(await tv.page.locator(".pin-cancel").innerText(), text("common.cancel", "de"));
        assert.equal(await tv.page.locator(".pin-dots").getAttribute("aria-label"), text("pin.progress.digits", "de", { filled: "0", total: 4 }));
        await tv.page.locator('[data-focus="1"]').click();
        assert.equal(await tv.page.locator(".pin-dots").getAttribute("aria-label"), text("pin.progress.digits", "de", { filled: "1", total: 4 }));
        for (const digit of ["1", "1", "1"]) await tv.page.locator(`[data-focus="${digit}"]`).click();
        await tv.eventually(async () => (await tv.page.locator(".pin-status").innerText()) === text("pin.wrong", "de"), "German wrong-PIN line");
    });
});

test("in Arabic the PIN screen is mirrored: its pad reads from the right and Left steps toward the next column", async () => {
    await withPin("ar", async tv => {
        const screen = tv.page.locator('[data-screen="pin"]');
        assert.equal(await screen.getAttribute("lang"), "ar");
        assert.equal(await screen.getAttribute("dir"), "rtl");
        assert.equal(await tv.page.locator(".pin-status").innerText(), text("pin.prompt", "ar"));
        const lefts = await tv.page.evaluate(() => Object.fromEntries(["1", "2", "3"].map(key => [key, document.querySelector(`[data-focus="${key}"]`)?.getBoundingClientRect().left ?? Number.NaN])));
        assert.ok(lefts["1"]! > lefts["2"]! && lefts["2"]! > lefts["3"]!, `1 is rightmost: ${JSON.stringify(lefts)}`);
        await tv.page.locator('[data-focus="5"]').focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "6", "Left goes to the key drawn on the left, 6");
    });
});

test("the sign-in screens keep lang=en while the PIN screen follows the shown language", async () => {
    const tv = await openTv(browser, { profiles: true, locale: "de-DE" });
    try {
        await tv.page.locator("section.signin-screen").first().waitFor();
        assert.equal(await tv.page.locator("section.signin-screen").first().getAttribute("lang"), "en");
    } finally { await tv.page.context().close(); }
});

async function withAddProfile(locale: string, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "application", locale });
    const catalog = new FakeCatalog();
    catalog.fileIds.set("movie:m0001", "42");
    tv.fake.catalog = catalog;
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        const items = tv.fake.profiles.items;
        assert.ok(Array.isArray(items));
        const owner = items.find(item => typeof item === "object" && item !== null && (item as { id?: unknown }).id === "p-owner");
        assert.ok(owner !== undefined);
        // One profile with no PIN skips the picker, and the profile menu then offers Add Profile.
        tv.fake.profiles = { ...tv.fake.profiles, items: [owner] };
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.getByRole("button", { name: /^(Connect|Verbinden|اتصال)$/ }).click();
        await tv.page.locator('[data-screen="code"]').waitFor();
        tv.fake.approve([...tv.fake.devices.keys()].pop() ?? "");
        await tv.jump(5000);
        await tv.page.locator('[data-screen="approved"], [data-screen="notice"], [data-view="home"], [data-screen="remember-profile"]').first().waitFor();
        if (await tv.screen() === "approved") await tv.jump(1000);
        await tv.page.locator('[data-screen="notice"], [data-view="home"], [data-screen="remember-profile"]').first().waitFor();
        if (await tv.screen() === "notice") await tv.page.locator('[data-focus="continue"]').click();
        if (await tv.screen() === "remember-profile") await tv.page.locator('[data-focus="ask-every-launch"]').click();
        await tv.page.locator('[data-view="home"] [data-focus="movie:m0001"]').first().waitFor();
        await tv.page.locator('[data-focus="profiles"]').click();
        await tv.page.locator('[data-focus="add-profile"]').click();
        await tv.page.locator('[data-screen="profile-create"]').waitFor();
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("Add Profile reads in German and carries lang=de", async () => {
    await withAddProfile("de-DE", async tv => {
        const screen = tv.page.locator('[data-screen="profile-create"]');
        assert.equal(await screen.getAttribute("lang"), "de");
        assert.equal(await tv.page.locator(".profile-create-title").innerText(), text("newProfile.title", "de"));
        assert.deepEqual(await tv.page.locator(".profile-create-label").allTextContents(), [text("profiles.form.style", "de"), text("profiles.form.avatar", "de"), text("newProfile.name", "de"), text("newProfile.pin", "de")]);
        assert.deepEqual(await tv.page.locator(".profile-style-row [data-focus]").allInnerTexts(), ["identicon", "initials", "bottts", "funEmoji", "pixelArt"].map(style => text(`profiles.avatarStyle.${style}` as Parameters<typeof translate>[0], "de")));
        assert.equal(await tv.page.locator('[data-focus="create-submit"]').innerText(), text("newProfile.create", "de"));
        assert.equal(await tv.page.locator('[data-focus="create-cancel"]').innerText(), text("common.cancel", "de"));
        assert.equal(await tv.page.locator("#create-profile-name").getAttribute("aria-label"), text("newProfile.namePlaceholder", "de"));
        assert.equal(await tv.page.locator("#create-profile-pin").getAttribute("aria-label"), text("newProfile.pinPlaceholder", "de"));
        assert.equal(await tv.page.locator('[data-focus="shuffle-avatars"]').innerText(), text("profiles.form.shuffleAvatars", "de"));
        assert.equal(await tv.page.locator('[data-focus="preset:0"]').getAttribute("aria-label") ?? await tv.page.locator('[data-focus="preset:0"]').innerText(), text("profiles.avatar.preset", "de", { seed: "1" }));
        assert.equal(await tv.page.locator('[data-focus="create-child"]').innerText(), `${text("newProfile.child", "de")}: ${text("newProfile.off", "de")}`);
        await tv.page.locator('[data-focus="create-child"]').click();
        assert.equal(await tv.page.locator('[data-focus="create-child"]').innerText(), `${text("newProfile.child", "de")}: ${text("newProfile.on", "de")}`);
        assert.equal(await tv.page.locator('[data-focus="create-libraries"]').innerText(), `${text("newProfile.restrict", "de")}: ${text("newProfile.off", "de")}`);
    });
});

test("in Arabic Add Profile is mirrored: its form leads on the right and its labels are Arabic", async () => {
    await withAddProfile("ar", async tv => {
        const screen = tv.page.locator('[data-screen="profile-create"]');
        assert.equal(await screen.getAttribute("dir"), "rtl");
        assert.equal(await tv.page.locator(".profile-create-title").innerText(), text("newProfile.title", "ar"));
        const sides = await tv.page.evaluate(() => ({ preview: document.querySelector(".profile-create-preview")?.getBoundingClientRect().left ?? Number.NaN, controls: document.querySelector(".profile-create-controls")?.getBoundingClientRect().left ?? Number.NaN }));
        assert.ok(sides.preview > sides.controls, `the preview leads on the right: ${JSON.stringify(sides)}`);
    });
});

/** Opens the PIN screen with the device's German file held back, so the screen first draws in English. */
async function withHeldCatalog(body: (tv: Tv, land: () => Promise<void>) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, {
        profiles: true, locale: "de-DE",
        // The page appends the language's script itself; hold that one until the test lands it.
        prepare: async page => { await page.addInitScript(() => {
            const original = Element.prototype.append;
            const waiting: (() => void)[] = [];
            Reflect.set(window, "landCatalog", () => { for (const release of waiting.splice(0)) release(); });
            Element.prototype.append = function (this: Element, ...nodes: (Node | string)[]): void {
                const held = nodes.find(node => node instanceof HTMLScriptElement && node.src.endsWith("/catalog/de.js"));
                if (held === undefined) { original.apply(this, nodes); return; }
                waiting.push(() => original.apply(this, nodes));
            };
        }); },
    });
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await openPin(tv);
        await body(tv, async () => { await tv.page.evaluate(() => { (Reflect.get(window, "landCatalog") as () => void)(); }); await tv.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))); });
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("a catalog that lands while the PIN screen is up redraws its prompt, Cancel and lang in German", async () => {
    await withHeldCatalog(async (tv, land) => {
        assert.equal(await tv.page.locator(".pin-status").innerText(), "Enter your PIN");
        assert.equal(await tv.page.locator('[data-screen="pin"]').getAttribute("lang"), "en");
        await land();
        await tv.eventually(async () => (await tv.page.locator(".pin-status").innerText()) === text("pin.prompt", "de"), "German prompt");
        assert.equal(await tv.page.locator(".pin-cancel").innerText(), text("common.cancel", "de"));
        assert.equal(await tv.page.locator('[data-screen="pin"]').getAttribute("lang"), "de");
    });
});

test("a catalog that lands while Select is held on the PIN pad waits for the release", async () => {
    await withHeldCatalog(async (tv, land) => {
        await tv.page.locator('[data-focus="5"]').focus();
        await tv.page.keyboard.down("Enter");
        await land();
        assert.equal(await tv.page.locator(".pin-status").innerText(), "Enter your PIN", "the held key is not replaced");
        await tv.page.keyboard.up("Enter");
        await tv.eventually(async () => (await tv.page.locator(".pin-status").innerText()) === text("pin.prompt", "de"), "German prompt after release");
    });
});

for (const exit of ["the Cancel button", "the Back key", "the right PIN"] as const) {
    test(`a PIN screen left by ${exit} stops listening for catalogs`, async () => {
        await withHeldCatalog(async (tv, land) => {
            // Keep the left screen's Cancel button: a screen still subscribed would rewrite its text when the catalog lands.
            await tv.page.evaluate(() => { Reflect.set(window, "leftCancel", document.querySelector(".pin-cancel")); });
            if (exit === "the Cancel button") await tv.page.locator(".pin-cancel").click();
            else if (exit === "the Back key") await tv.remote(10009);
            else for (const digit of "2468") await tv.page.locator(`[data-focus="${digit}"]`).click();
            await tv.eventually(async () => await tv.page.locator('[data-screen="pin"]').count() === 0, "the PIN screen left");
            await land();
            assert.equal(await tv.page.evaluate(() => (Reflect.get(window, "leftCancel") as HTMLElement).textContent), "Cancel", "the left screen was not redrawn");
        });
    });
}
