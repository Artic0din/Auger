// The sign-in screens in German and Arabic (silo-apple Screens/Auth/TVServerSetupView.swift, TVLoginView.swift and
// DesignSystem/Marquee/MarqueeLayout.swift at 0e17c3e3): the text reads from the catalog, each screen follows the shown
// language instead of carrying lang=en, and in Arabic the whole screen mirrors as MarqueeTVScreen's leading and
// trailing alignments do. English stays as it was.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { translate } from "../../src/i18n/translate.ts";
import { fixture } from "../native/support/fakeSilo.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

const LEFT = 37;
const RIGHT = 39;
const DOWN = 40;
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

        const hold = tv.fake.hold("/system/info", true);
        await tv.page.fill("#signin-address", "silo.example.test");
        await tv.page.locator('[data-focus="connect"]').click();
        const connecting = await section(tv, "connecting");
        assert.equal(await connecting.locator('[data-focus="connect"]').innerText(), text("setup.connecting", "de"));
        assert.equal(await connecting.locator('[data-focus="cancel"]').innerText(), text("common.cancel", "de"));
        await connecting.locator('[data-focus="cancel"]').click();
        hold.release();
        await tv.eventually(async () => tv.pendingReplies === 0, "released probe settled");
        await section(tv, "entry");
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

test("in Arabic the port hint and protocol read Apple's Arabic text, and the keyboard card's English reads left to right with its full stop at the end", async () => {
    await withTv("ar-SA", async tv => {
        await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === "ar", "Arabic on the address screen");
        await tv.page.locator('[data-focus="advanced"]').click();
        // Apple's tvOS port field reads `setup.port.placeholder`, "منفذ: تلقائي" ("Port: auto"); its protocol button reads `setup.scheme.auto`, "تلقائي".
        assert.equal(await tv.page.locator("#signin-port").getAttribute("placeholder"), text("setup.port.placeholder", "ar"));
        assert.equal(await tv.page.locator("#signin-port").getAttribute("placeholder"), "منفذ: تلقائي");
        assert.equal(await tv.page.locator('[data-focus="scheme-auto"]').innerText(), "تلقائي");
        // The card's text is English whatever language is shown, so it carries that language and direction, and its full stop stays last.
        for (const selector of [".marquee-card-title", ".marquee-card-text"]) {
            assert.equal(await tv.page.locator(`.marquee-card ${selector}`).getAttribute("lang"), "en", selector);
            assert.equal(await tv.page.locator(`.marquee-card ${selector}`).evaluate(node => getComputedStyle(node).direction), "ltr", selector);
        }
        const stop = await tv.page.locator(".marquee-card .marquee-card-text").evaluate(node => {
            const text = node.firstChild as Text;
            const at = (offset: number): number => { const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + 1); return range.getBoundingClientRect().left; };
            const last = (text.textContent ?? "").length - 1;
            return { stop: at(last), before: at(last - 1) };
        });
        assert.ok(stop.stop > stop.before, `the full stop follows the last letter: ${JSON.stringify(stop)}`);
    });
});

test("in Arabic a refusal and a notice with no Apple key read as English, left to right, while translated ones follow the page", async () => {
    await withTv("ar-SA", async tv => {
        await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === "ar", "Arabic on the address screen");
        // A refusal with no Apple key: the shared error helper marks it as the English it is, so its full stop stays at the end.
        await connectTo(tv, "ftp://silo.example.test");
        const keyless = tv.page.locator(".marquee-error span", { hasText: "Use an address that starts with" });
        await keyless.waitFor();
        assert.equal(await keyless.getAttribute("lang"), "en");
        assert.equal(await keyless.evaluate(node => getComputedStyle(node).direction), "ltr");
        // A refusal Apple does word is Arabic and carries no override.
        await connectTo(tv, "");
        const translated = tv.page.locator(".marquee-error span", { hasText: text("setup.error.empty", "ar") });
        await translated.waitFor();
        assert.equal(await translated.getAttribute("lang"), null);
        // A notice with no Apple key (shown after a sign-out) is marked the same way by the note helper.
        await tv.page.evaluate(() => window.harness.mount({ storage: "cleared", server: "revoked" }));
        const notice = tv.page.locator(".marquee-chip span", { hasText: "Signed out on this TV." });
        await notice.waitFor();
        assert.equal(await notice.getAttribute("lang"), "en");
        assert.equal(await notice.evaluate(node => getComputedStyle(node).direction), "ltr");
    });
});

for (const [locale, name, spacing] of [["de-DE", "German", 4], ["ar-SA", "Arabic", 2.5]] as const) {
    test(`the ${name} password screen shows every action label whole, inside the copy column, and nothing overlaps`, async () => {
        await withTv(locale, async tv => {
            await tv.eventually(async () => await tv.page.locator('[data-screen="entry"]').getAttribute("lang") === locale.slice(0, 2), `${name} on the address screen`);
            // The TV's own font is wider than the test browser's; letter spacing stands in for it so the longest labels outgrow the column.
            await tv.page.addStyleTag({ content: `.signin-auth .marquee-button { letter-spacing: ${spacing}px; }` });
            // Started from Change Account: the longest leave label, "Zurück zu den Konten" in German.
            await tv.page.evaluate(() => window.harness.mount(undefined, false, true));
            await codeScreen(tv);
            await tv.page.locator('[data-focus="password"]').click();
            await section(tv, "credentials");
            const shown = await tv.page.evaluate(() => {
                const column = document.querySelector(".marquee-copy")?.getBoundingClientRect();
                const buttons = [...document.querySelectorAll<HTMLElement>(".marquee-actions .marquee-button")];
                return {
                    column: column === undefined ? undefined : { left: column.left, right: column.right },
                    stacked: document.querySelector(".marquee-actions")?.classList.contains("marquee-actions-stack") === true,
                    buttons: buttons.map(node => {
                        const label = node.querySelector<HTMLElement>("span:not(.marquee-spinner)");
                        const range = document.createRange();
                        if (label !== null) range.selectNodeContents(label);
                        const box = node.getBoundingClientRect();
                        const text = label === null ? box : range.getBoundingClientRect();
                        return {
                            key: node.getAttribute("data-focus"), left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                            // A cut label has more text than its box shows, or is drawn past the button.
                            cut: label !== null && (label.scrollWidth > label.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1 || text.left < box.left - 1 || text.right > box.right + 1),
                            ellipsis: label !== null && getComputedStyle(label).textOverflow === "ellipsis" && label.scrollWidth > label.clientWidth,
                        };
                    }),
                };
            });
            assert.ok(shown.column !== undefined && shown.buttons.length === 3, JSON.stringify(shown));
            assert.deepEqual(shown.buttons.filter(box => box.cut || box.ellipsis).map(box => box.key), [], `a label is cut: ${JSON.stringify(shown)}`);
            for (const box of shown.buttons) assert.ok(box.left >= shown.column.left - 1 && box.right <= shown.column.right + 1, `a button leaves the column: ${JSON.stringify({ column: shown.column, box })}`);
            for (let at = 0; at < shown.buttons.length; at++) for (let other = at + 1; other < shown.buttons.length; other++) {
                const a = shown.buttons[at]!;
                const b = shown.buttons[other]!;
                assert.ok(a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5, `buttons overlap: ${JSON.stringify([a, b])}`);
            }
            if (shown.stacked) {
                // One button per line: Down steps from Sign in to the next, as on the code screen.
                await tv.page.locator('[data-focus="signin"]').focus();
                await tv.remote(DOWN);
                assert.equal(await tv.focused(), "phone", "Down reaches the next stacked button");
                await tv.remote(DOWN);
                assert.equal(await tv.focused(), "change");
            }
        });
    });
}

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

/** Holds German's file, loads the page again so it reads English first, and returns what lets the file land. */
async function withHeldGerman(body: (tv: Tv, release: () => void) => Promise<void>): Promise<void> {
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
        await body(tv, release);
        assert.deepEqual(tv.console, []);
    } finally {
        await tv.page.context().close();
    }
}

test("German's file landing after the first draw redraws the address screen in German", async () => {
    await withHeldGerman(async (tv, release) => {
        release();
        await tv.eventually(async () => await headlineText(tv) === text("setup.headline", "de"), "the screen redraws in German");
        assert.equal(await tv.page.locator('[data-screen="entry"]').getAttribute("lang"), "de");
    });
});

test("a language file landing while an address is typed waits for the typing to end, then redraws and keeps the address", async () => {
    await withHeldGerman(async (tv, release) => {
        await tv.page.fill("#signin-address", "silo.example.test");
        const input = await tv.page.locator("#signin-address").elementHandle();
        assert.ok(input);
        release();
        await tv.page.waitForTimeout(300);
        assert.equal(await headlineText(tv), "Enter your\nserver address", "still English while the address is being typed");
        assert.equal(await input.evaluate(node => node.isConnected), true, "the field the TV keyboard edits is not replaced");
        await tv.remote(IME_DONE);
        await tv.eventually(async () => await headlineText(tv) === text("setup.headline", "de"), "the screen redraws once the typing ends");
        assert.equal(await tv.page.locator("#signin-address").inputValue(), "silo.example.test", "the typed address survives the redraw");
    });
});

for (const [name, select] of [["a key event", (tv: Tv) => tv.page.keyboard.press("Enter")], ["the remote's keyCode-only Select", (tv: Tv) => tv.remote(13)]] as const) {
    test(`a language file landing while an empty field is selected with ${name} waits, since the TV keyboard may be open, and redraws when focus leaves it`, async () => {
        await withHeldGerman(async (tv, release) => {
            const input = await tv.page.locator("#signin-address").elementHandle();
            assert.ok(input);
            // Select opens the TV keyboard on the field before a first character is typed.
            await tv.page.locator("#signin-address").focus();
            await select(tv);
            release();
            await tv.page.waitForTimeout(300);
            assert.equal(await headlineText(tv), "Enter your\nserver address", "still English while the keyboard may be open");
            assert.equal(await input.evaluate(node => node.isConnected), true, "the field the TV keyboard edits is not replaced");
            await tv.remote(40);
            await tv.eventually(async () => await headlineText(tv) === text("setup.headline", "de"), "the screen redraws once focus leaves the field");
        });
    });
}

test("a redraw that waited for a field redraws when focus leaves it without a key release", async () => {
    await withHeldGerman(async (tv, release) => {
        await tv.page.fill("#signin-address", "silo.example.test");
        release();
        await tv.page.waitForTimeout(300);
        assert.equal(await headlineText(tv), "Enter your\nserver address", "waiting while the address is typed");
        // A pointer click on the backdrop moves focus off the field with no key press and no handler of its own.
        await tv.page.mouse.click(5, 5);
        await tv.eventually(async () => await headlineText(tv) === text("setup.headline", "de"), "the screen redraws on blur");
    });
});

test("an address problem shown before German's file lands reads in German after it", async () => {
    await withHeldGerman(async (tv, release) => {
        await connectTo(tv, "");
        await tv.page.getByText("Please enter a server host.", { exact: true }).waitFor();
        release();
        await tv.page.getByText(text("setup.error.empty", "de"), { exact: true }).waitFor();
    });
});

test("a refused password form shown before German's file lands reads in German after it", async () => {
    await withHeldGerman(async (tv, release) => {
        await codeScreen(tv);
        await tv.page.locator('[data-focus="password"]').click();
        await section(tv, "credentials");
        await tv.page.locator('[data-focus="signin"]').click();
        await tv.page.getByText("Please enter your username.", { exact: true }).waitFor();
        release();
        await tv.page.getByText(text("signIn.error.usernameMissing", "de"), { exact: true }).waitFor();
    });
});

test("a code that was opened on the phone still says so after German's file lands", async () => {
    await withHeldGerman(async (tv, release) => {
        await codeScreen(tv);
        const [code] = [...tv.fake.devices.keys()].slice(-1);
        assert.ok(code);
        tv.fake.open(code);
        await tv.jump(5000);
        await tv.page.getByText("Continue on your phone", { exact: true }).waitFor();
        release();
        // The redraw alone, with no poll after it, must show the status the screen had.
        await tv.page.locator('[data-screen="code"][lang="de"]').waitFor();
        assert.equal(await tv.page.locator(".signin-status-text").innerText(), text("tvSignIn.status.opened", "de"));
    });
});

test("a password form that went password-only stays so when German's file lands: no phone button, and Back leaves for the address", async () => {
    await withHeldGerman(async (tv, release) => {
        const capability = tv.fake.hold("/auth/device/capability");
        tv.fake.script("/auth/device/capability", { status: 200, body: { ...fixture("get_device_login_capability_ok"), state: "disabled" } });
        await connectTo(tv);
        await tv.page.locator('[data-focus="password"]').click();
        await section(tv, "credentials");
        capability.release();
        await tv.page.getByText("This server only supports password sign-in.", { exact: true }).waitFor();
        release();
        await tv.page.getByText(text("tvSignIn.passwordOnly", "de"), { exact: true }).waitFor();
        assert.equal(await tv.page.locator('[data-focus="phone"]').count(), 0, "the phone route stays removed");
        await tv.remote(10009);
        assert.equal(await tv.screen(), "entry", "Back uses the password-only route");
    });
});
