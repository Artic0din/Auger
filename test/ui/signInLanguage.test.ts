// The sign-in screens in German and Arabic (silo-apple Screens/Auth/TVServerSetupView.swift, TVLoginView.swift and
// DesignSystem/Marquee/MarqueeLayout.swift at 0e17c3e3): the text reads from the catalog, each screen follows the shown
// language instead of carrying lang=en, and in Arabic the whole screen mirrors as MarqueeTVScreen's leading and
// trailing alignments do. English stays as it was.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

const LEFT = 37;
const RIGHT = 39;
const IME_DONE = 65376;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

async function withTv(locale: string | undefined, body: (tv: Tv) => Promise<void>, origin?: string): Promise<void> {
    const tv = await openTv(browser, { ...(locale === undefined ? {} : { locale }), ...(origin === undefined ? {} : { origin }) });
    try {
        await body(tv);
        assert.deepEqual(tv.console, [], "the page logs nothing");
    } finally {
        await tv.page.context().close();
    }
}

async function section(tv: Tv, name: string) {
    const root = tv.page.locator(`[data-screen="${name}"]`);
    await root.waitFor();
    return root;
}

async function connectTo(tv: Tv, address = "silo.example.test"): Promise<void> {
    await tv.page.fill("#signin-address", address);
    await tv.remote(IME_DONE);
    await tv.page.keyboard.press("Enter");
}

async function codeScreen(tv: Tv): Promise<void> {
    await connectTo(tv);
    await tv.page.locator('[data-screen="code"]').waitFor();
}

const headlineText = async (tv: Tv, selector = "h1"): Promise<string> => (await tv.page.locator(`.signin-screen ${selector}`).first().innerText()).replace(/\n/g, "\n");

test("the server address screen reads in German and carries lang=de", async () => {
    await withTv("de-DE", async tv => {
        const root = await section(tv, "entry");
        await tv.eventually(async () => await root.getAttribute("lang") === "de", "the German file lands and the screen redraws");
        const entry = await section(tv, "entry");
        assert.equal(await entry.getAttribute("lang"), "de");
        assert.equal(await headlineText(tv), text("setup.headline", "de"));
        assert.equal(await entry.locator(".marquee-lead").innerText(), text("setup.body", "de"));
        assert.equal(await entry.locator('[data-focus="connect"]').innerText(), text("setup.connect", "de"));
        assert.equal(await entry.locator('[data-focus="advanced"]').innerText(), text("setup.advanced.show", "de"));
        await entry.locator('[data-focus="advanced"]').click();
        const advanced = await section(tv, "entry");
        assert.equal(await advanced.locator('[data-focus="advanced"]').innerText(), text("setup.advanced.hide", "de"));
        assert.equal(await advanced.locator('[data-focus="scheme-auto"]').innerText(), text("setup.scheme.auto", "de"));
        assert.equal(await advanced.locator("#signin-port").getAttribute("placeholder"), text("setup.port.placeholder", "de"));
        await connectTo(tv, "");
        await tv.page.getByText(text("setup.error.empty", "de"), { exact: true }).waitFor();
        await tv.page.fill("#signin-address", "http://");
        await tv.page.locator('[data-focus="connect"]').click();
        await tv.page.getByText(text("setup.error.invalidAddress", "de"), { exact: true }).waitFor();
    });
});

test("the code screen reads in German: title, lead, status, password button and the server's badge", async () => {
    await withTv("de-DE", async tv => {
        await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === "de", "German on the address screen");
        await codeScreen(tv);
        const code = tv.page.locator('[data-screen="code"]');
        assert.equal(await code.getAttribute("lang"), "de");
        const server = await code.locator(".marquee-server-name").first().innerText();
        assert.equal(await code.locator("[data-server-headline]").innerText(), text("tvSignIn.title", "de", { server }));
        assert.equal(await code.locator(".marquee-lead").innerText(), translate("tvSignIn.appleTv.lead", { page: await code.locator(".signin-typed-url").innerText() }, "de").replace(/Apple TV/gi, "TV"));
        assert.equal(await code.locator(".signin-status-text").innerText(), text("tvSignIn.status.waiting", "de"));
        assert.equal(await code.locator('[data-focus="password"]').innerText(), text("tvSignIn.action.password", "de"));
        // The fake server answers over HTTPS, so the badge says Secure (drawn in capitals).
        assert.equal(await code.locator(".marquee-badge").innerText(), text("firstRun.badge.secure", "de").toLocaleUpperCase("de"));
        assert.equal(await code.locator('[data-focus="change"]').innerText(), text("common.changeServer", "de"));
    });
});

test("the password screen reads in German, and an empty username is refused in German", async () => {
    await withTv("de-DE", async tv => {
        await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === "de", "German on the address screen");
        await codeScreen(tv);
        await tv.page.locator('[data-focus="password"]').click();
        const password = await section(tv, "credentials");
        assert.equal(await password.getAttribute("lang"), "de");
        assert.equal(await headlineText(tv), text("signIn.headline", "de"));
        assert.equal(await tv.page.locator("#signin-username").getAttribute("placeholder"), text("tvSignIn.form.usernamePlaceholder", "de"));
        assert.equal(await tv.page.locator("#signin-password").getAttribute("placeholder"), text("tvSignIn.form.passwordPlaceholder", "de"));
        assert.equal(await tv.page.locator('[data-focus="toggle"]').getAttribute("aria-label"), text("signIn.showPassword", "de"));
        assert.equal(await tv.page.locator('[data-focus="signin"]').innerText(), text("tvSignIn.form.submit", "de"));
        assert.equal(await tv.page.locator('[data-focus="phone"]').innerText(), text("tvSignIn.form.usePhone", "de"));
        await tv.page.locator('[data-focus="signin"]').click();
        await tv.page.getByText(text("signIn.error.usernameMissing", "de"), { exact: true }).waitFor();
        await tv.page.fill("#signin-username", "laura");
        await tv.page.locator('[data-focus="signin"]').click();
        await tv.page.getByText(text("signIn.error.passwordMissing", "de"), { exact: true }).waitFor();
    });
});

test("the plain-HTTP question reads in German", async () => {
    await withTv("de-DE", async tv => {
        await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === "de", "German on the address screen");
        await connectTo(tv);
        // The HTTPS attempt and its one transport retry fail, then the question shows.
        await tv.eventually(async () => {
            if (await tv.screen() === "insecure") return true;
            await tv.jump(1000);
            return false;
        }, "the cleartext question");
        assert.equal(await tv.page.locator(".signin-alert-title").innerText(), text("setup.cleartext.title", "de"));
        assert.equal(await tv.page.locator(".signin-alert-text").innerText(), text("setup.cleartext.body", "de", { host: "silo.example.test" }));
        assert.equal(await tv.page.locator('[data-focus="cancel"]').innerText(), text("common.cancel", "de"));
        assert.equal(await tv.page.locator('[data-focus="connect"]').innerText(), text("setup.cleartext.connect", "de"));
    }, "http://silo.example.test");
});

test("in Arabic the address screen mirrors: the card is on the left, the copy on the right, the TV's name top left", async () => {
    await withTv("ar-SA", async tv => {
        await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === "ar", "Arabic on the address screen");
        const entry = await section(tv, "entry");
        assert.equal(await entry.getAttribute("dir"), "rtl");
        assert.equal(await headlineText(tv), text("setup.headline", "ar"));
        const edges = await tv.page.evaluate(() => {
            const left = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().left ?? Number.NaN;
            const right = (selector: string): number => document.querySelector(selector)?.getBoundingClientRect().right ?? Number.NaN;
            return { copyLeft: left(".marquee-copy"), cardRight: right(".marquee-card"), chipLeft: left(".marquee-chip"), chipRight: right(".marquee-chip"), wordmarkRight: right(".signin-wordmark") };
        });
        assert.ok(edges.cardRight <= edges.copyLeft, `the card is left of the copy: ${JSON.stringify(edges)}`);
        assert.ok(edges.chipRight < 960, `the TV's name chip hangs from the left edge: ${JSON.stringify(edges)}`);
        assert.ok(edges.wordmarkRight > 960, `the wordmark hangs from the right edge: ${JSON.stringify(edges)}`);
        const scrim = await tv.page.evaluate(() => getComputedStyle(document.querySelector(".signin-screen") as Element).backgroundImage);
        assert.ok(scrim.includes("to left"), `the scrim's dark side moves with the layout: ${scrim}`);
    });
});

test("in Arabic Left and Right step through the code screen's buttons as the mirrored layout draws them", async () => {
    await withTv("ar-SA", async tv => {
        await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === "ar", "Arabic on the address screen");
        await codeScreen(tv);
        const code = tv.page.locator('[data-screen="code"]');
        assert.equal(await code.getAttribute("dir"), "rtl");
        assert.equal(await code.locator("[data-server-headline]").innerText(), text("tvSignIn.title", "ar", { server: `⁨${await code.locator(".marquee-server-name").first().innerText()}⁩` }));
        const order = await tv.page.evaluate(() => ["password", "change"].map(key => document.querySelector(`[data-focus="${key}"]`)?.getBoundingClientRect().left ?? Number.NaN));
        const stacked = await tv.page.evaluate(() => document.querySelector(".marquee-actions")?.classList.contains("marquee-actions-stack") === true);
        if (!stacked) assert.ok((order[0] ?? 0) > (order[1] ?? 0), `the password button is right of Change server: ${JSON.stringify(order)}`);
        await tv.page.locator('[data-focus="password"]').focus();
        await tv.remote(stacked ? 40 : LEFT);
        assert.equal(await tv.focused(), "change");
        await tv.remote(stacked ? 38 : RIGHT);
        assert.equal(await tv.focused(), "password");
    });
});

test("the address screen reads English and left to right when English is shown", async () => {
    await withTv(undefined, async tv => {
        const entry = await section(tv, "entry");
        assert.equal(await entry.getAttribute("lang"), "en");
        assert.equal(await entry.getAttribute("dir"), "ltr");
        assert.equal(await headlineText(tv), "Enter your\nserver address");
        assert.equal(await entry.locator('[data-focus="connect"]').innerText(), "Connect");
        const edges = await tv.page.evaluate(() => ({ copyLeft: document.querySelector(".marquee-copy")?.getBoundingClientRect().left ?? Number.NaN, cardLeft: document.querySelector(".marquee-card")?.getBoundingClientRect().left ?? Number.NaN }));
        assert.ok(edges.copyLeft < edges.cardLeft, `the copy is left of the card: ${JSON.stringify(edges)}`);
    });
});

test("German's file landing after the first draw redraws the address screen in German and keeps what was typed", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tv = await openTv(browser, { locale: "de-DE" });
    try {
        // Routes added after the harness's own answer first: hold German's file, then load the page again.
        await tv.page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); });
        await tv.page.reload({ waitUntil: "commit" });
        const entry = await section(tv, "entry");
        assert.equal(await headlineText(tv), "Enter your\nserver address", "English until the file lands");
        assert.equal(await entry.getAttribute("lang"), "en");
        await tv.page.fill("#signin-address", "silo.example.test");
        release();
        await tv.eventually(async () => await headlineText(tv) === text("setup.headline", "de"), "the screen redraws in German");
        assert.equal(await tv.page.locator("#signin-address").inputValue(), "silo.example.test", "the typed address survives the redraw");
        assert.equal(await tv.page.locator('[data-screen="entry"]').getAttribute("lang"), "de");
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
});
