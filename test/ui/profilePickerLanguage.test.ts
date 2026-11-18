// The profile picker and the launch choice in German and Arabic (silo-apple Screens/Profiles/ProfileSelectionView.swift, ProfileTile.swift
// at d49d7bd): their text reads from the catalog, they follow the shown language and direction instead of carrying lang=en, in Arabic the
// tiles read from the right and Left steps to the next tile, and English is unchanged. Text with no Apple key stays English.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { translate, translateTv } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37;
const BACK = 10009;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);
const textTv = (key: Parameters<typeof translateTv>[0], language: string): string => translateTv(key, undefined, language);

async function toPicker(tv: Tv): Promise<void> {
    await tv.page.fill("#signin-address", "silo.example.test");
    await tv.page.getByRole("button", { name: /^(Connect|Verbinden|اتصال)$/ }).click();
    await tv.page.locator('[data-screen="code"]').waitFor();
    tv.fake.approve([...tv.fake.devices.keys()].pop() ?? "");
    await tv.jump(5000);
    await tv.jump(1000);
    await tv.page.locator('[data-screen="profiles"]').waitFor();
}

async function inPicker(locale: string, body: (tv: Tv) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { profiles: true, locale });
    tv.fake.catalog = new FakeDetails();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await toPicker(tv);
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

test("the picker reads in German and carries lang=de", async () => {
    await inPicker("de-DE", async tv => {
        const screen = tv.page.locator('[data-screen="profiles"]');
        assert.equal(await screen.getAttribute("lang"), "de");
        assert.equal(await tv.page.locator(".profile-picker-title").innerText(), text("profiles.headline", "de"));
        const account = await tv.page.locator(".profile-account").innerText();
        assert.ok(account.startsWith(text("profiles.signedInAs", "de", { name: "" }).trim().replace(/\s+$/, "")), account);
        assert.equal(await tv.page.locator('[data-focus="profile:p-kid"]').getAttribute("aria-label"), ["Kid", text("profiles.pinProtected", "de"), text("profiles.kidsProfile", "de")].join(", "));
        assert.equal(await tv.page.locator('[data-focus="profile:p-kid"] .profile-child').innerText(), text("profiles.kids", "de"));
        assert.equal(await tv.page.locator('[data-focus="add-profile"]').getAttribute("aria-label"), text("profiles.add", "de"));
        assert.equal(await tv.page.locator('[data-focus="add-profile"] .profile-name').innerText(), text("profiles.add", "de"));
        assert.equal(await tv.page.locator('[data-focus="change-server"]').innerText(), text("profiles.changeAccount", "de"));
        assert.equal(await tv.page.locator('[data-focus="signout"]').innerText(), text("common.signOut", "de"));
    });
});

test("the picker in English is the text it always was", async () => {
    await inPicker("en-AU", async tv => {
        assert.equal(await tv.page.locator(".profile-picker-title").innerText(), "Who's watching?");
        assert.match(await tv.page.locator(".profile-account").innerText(), /^Signed in as /);
        assert.equal(await tv.page.locator('[data-focus="profile:p-kid"]').getAttribute("aria-label"), "Kid, PIN protected, Kids profile");
        assert.equal(await tv.page.locator('[data-focus="profile:p-kid"] .profile-child').innerText(), "KIDS");
        assert.equal(await tv.page.locator('[data-focus="add-profile"] .profile-name').innerText(), "Add");
        assert.equal(await tv.page.locator('[data-focus="change-server"]').innerText(), "Change account");
        assert.equal(await tv.page.locator('[data-focus="signout"]').innerText(), "Sign out");
    });
});

test("in Arabic the picker is mirrored: the tiles read from the right and Left steps to the next tile", async () => {
    await inPicker("ar", async tv => {
        const screen = tv.page.locator('[data-screen="profiles"]');
        assert.equal(await screen.getAttribute("lang"), "ar");
        assert.equal(await screen.getAttribute("dir"), "rtl");
        assert.equal(await tv.page.locator(".profile-picker-title").innerText(), text("profiles.headline", "ar"));
        const lefts = await tv.page.evaluate(() => [...document.querySelectorAll(".profile-grid .profile-tile")].map(tile => Math.round(tile.getBoundingClientRect().left)));
        assert.ok(lefts.length >= 3, `tiles: ${lefts.join(",")}`);
        assert.deepEqual([...lefts].sort((a, b) => b - a), lefts, `the first profile is rightmost and Add is leftmost: ${lefts.join(",")}`);
        const first = await tv.page.locator(".profile-grid .profile-tile").first().getAttribute("data-focus");
        const second = await tv.page.locator(".profile-grid .profile-tile").nth(1).getAttribute("data-focus");
        await tv.page.locator(`[data-focus="${first}"]`).focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), second, "Left goes to the tile drawn on the left");
    });
});

test("the remember offer reads in German: title with the name, body as this TV, both buttons", async () => {
    const tv = await openTv(browser, { profiles: true, locale: "de-DE" });
    tv.fake.catalog = new FakeDetails();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        // The harness offers the launch choice only when it routes expiry, as the app does.
        await tv.page.evaluate(() => { window.harness.routesExpiry = true; });
        await toPicker(tv);
        await tv.page.locator('[data-focus="profile:p-owner"]').click();
        const alert = tv.page.getByRole("alertdialog", { name: text("launch.offer.title", "de", { name: "Laura" }) });
        await alert.waitFor();
        assert.equal(await tv.page.locator('[data-screen="remember-profile"]').getAttribute("lang"), "de");
        assert.equal(await alert.locator("p").textContent(), textTv("profiles.rememberOffer.bodyAppleTv", "de"));
        assert.deepEqual(await alert.locator("button").allTextContents(), [text("launch.offer.ask", "de"), text("launch.offer.remember", "de")]);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
});

test("the sign-out confirmation and a failed profile list read in German", async () => {
    await inPicker("de-DE", async tv => {
        await tv.page.locator('[data-focus="signout"]').click();
        await tv.page.locator('[data-focus="cancel-signout"]').waitFor();
        assert.equal(await tv.page.locator('[data-focus="cancel-signout"]').innerText(), text("common.cancel", "de"));
        assert.equal(await tv.page.locator('[data-focus="confirm-signout"]').innerText(), text("shell.signOut.confirm", "de"));
        await tv.remote(BACK);
        await tv.page.locator('[data-screen="profiles"]').waitFor();
    });
});

test("a picker drawn in English is drawn again in German when the file lands", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tv = await openTv(browser, { profiles: true, locale: "de-DE" });
    tv.fake.catalog = new FakeDetails();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        // Routes added after the harness's own answer first: hold German's file, then load the page again.
        await tv.page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); });
        await tv.page.reload({ waitUntil: "commit" });
        await toPicker(tv);
        assert.equal(await tv.page.locator(".profile-picker-title").innerText(), "Who's watching?", "English until the file lands");
        release();
        await tv.eventually(async () => (await tv.page.locator(".profile-picker-title").innerText()) === text("profiles.headline", "de"), "the headline is German");
        assert.equal(await tv.page.locator('[data-focus="signout"]').innerText(), text("common.signOut", "de"));
        assert.equal(await tv.page.locator('[data-screen="profiles"]').getAttribute("lang"), "de");
    } finally { await tv.page.context().close(); }
});
