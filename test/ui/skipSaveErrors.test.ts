// Settings > Playback: a failed skip-interval save reads Apple's message for the interval and the cause (silo-apple 648091a7
// SeekIntervalPreferences.writeFailureMessage): a request that never reached the server, or an answer that did not parse, is
// `player.seekInterval.saveConnection…`; a 422 at the key is `saveUnsupported…`. Any other failure keeps Tizen's own wording, with its
// retry-after and reload advice: Apple's single `saveRejected…` line has no room for them (#592, option A). The strings are literal
// here so a key a language lacks cannot pass by falling back to English.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const MESSAGES = {
    en: {
        ConnectionVideoRewind: "Couldn't save the video rewind interval. Check the connection and try again.",
        ConnectionVideoFastForward: "Couldn't save the video fast-forward interval. Check the connection and try again.",
        ConnectionAudiobookRewind: "Couldn't save the audiobook rewind interval. Check the connection and try again.",
        ConnectionAudiobookFastForward: "Couldn't save the audiobook fast-forward interval. Check the connection and try again.",
        UnsupportedVideoRewind: "This server can't save the video rewind interval.",
        UnsupportedVideoFastForward: "This server can't save the video fast-forward interval.",
        UnsupportedAudiobookRewind: "This server can't save the audiobook rewind interval.",
        UnsupportedAudiobookFastForward: "This server can't save the audiobook fast-forward interval.",
    },
    de: {
        ConnectionVideoRewind: "Das Zurückspulintervall für Videos konnte nicht gespeichert werden. Prüfe die Verbindung und versuche es erneut.",
        ConnectionVideoFastForward: "Das Vorspulintervall für Videos konnte nicht gespeichert werden. Prüfe die Verbindung und versuche es erneut.",
        ConnectionAudiobookRewind: "Das Zurückspulintervall für Hörbücher konnte nicht gespeichert werden. Prüfe die Verbindung und versuche es erneut.",
        ConnectionAudiobookFastForward: "Das Vorspulintervall für Hörbücher konnte nicht gespeichert werden. Prüfe die Verbindung und versuche es erneut.",
        UnsupportedVideoRewind: "Dieser Server kann das Zurückspulintervall für Videos nicht speichern.",
        UnsupportedVideoFastForward: "Dieser Server kann das Vorspulintervall für Videos nicht speichern.",
        UnsupportedAudiobookRewind: "Dieser Server kann das Zurückspulintervall für Hörbücher nicht speichern.",
        UnsupportedAudiobookFastForward: "Dieser Server kann das Vorspulintervall für Hörbücher nicht speichern.",
    },
    ar: {
        ConnectionVideoRewind: "تعذّر حفظ فاصل الرجوع للفيديو. تحقق من الاتصال وحاول مرة أخرى.",
        ConnectionVideoFastForward: "تعذّر حفظ فاصل التقديم للفيديو. تحقق من الاتصال وحاول مرة أخرى.",
        ConnectionAudiobookRewind: "تعذّر حفظ فاصل الرجوع للكتاب الصوتي. تحقق من الاتصال وحاول مرة أخرى.",
        ConnectionAudiobookFastForward: "تعذّر حفظ فاصل التقديم للكتاب الصوتي. تحقق من الاتصال وحاول مرة أخرى.",
        UnsupportedVideoRewind: "لا يستطيع هذا الخادم حفظ فاصل الرجوع للفيديو.",
        UnsupportedVideoFastForward: "لا يستطيع هذا الخادم حفظ فاصل التقديم للفيديو.",
        UnsupportedAudiobookRewind: "لا يستطيع هذا الخادم حفظ فاصل الرجوع للكتاب الصوتي.",
        UnsupportedAudiobookFastForward: "لا يستطيع هذا الخادم حفظ فاصل التقديم للكتاب الصوتي.",
    },
} as const;

const SETTINGS = {
    settings: { en: "Settings", de: "Einstellungen", ar: "الإعدادات" },
} as const;

/** Each skip row, its setting key, and the picker choice that differs from the default, which the failure refuses. */
const INTERVALS = [
    { row: "seek-back", key: "player.video_skip_back_seconds", choice: 45, name: "VideoRewind" },
    { row: "seek-forward", key: "player.video_skip_forward_seconds", choice: 45, name: "VideoFastForward" },
    { row: "audiobook-seek-back", key: "player.audiobook_skip_back_seconds", choice: 45, name: "AudiobookRewind" },
    { row: "audiobook-seek-forward", key: "player.audiobook_skip_forward_seconds", choice: 45, name: "AudiobookFastForward" },
] as const;

type Language = keyof typeof MESSAGES;
type Cause = "Connection" | "Unsupported";

async function failingSave(language: Language, interval: typeof INTERVALS[number], fail: (tv: Tv) => Promise<void>): Promise<string> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    if (language !== "en") settings.profile().set(APP_LANGUAGE_KEY, language);
    try {
        await fail(tv);
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: SETTINGS.settings[language], exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(`[data-focus="${interval.row}"]`).click();
        await tv.page.locator(`[data-focus="${interval.row}:${interval.choice}"]`).click();
        const warning = tv.page.locator(".settings-warning");
        await warning.waitFor();
        return (await warning.innerText()).trim();
    } finally { await tv.page.context().close(); }
}

const refuse = (key: string, cause: Cause | "Rejected") => async (tv: Tv): Promise<void> => {
    await tv.page.route(`**/api/v2/settings/values/${key}**`, route => {
        if (route.request().method() !== "PUT") return route.fallback();
        if (cause === "Connection") return route.abort("connectionrefused");
        // A 422 at the key is Apple's unknown setting; a 422 at the body is a refused value.
        const location = cause === "Unsupported" ? "path.key" : "body.value";
        return route.fulfill({ status: 422, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Unprocessable", status: 422, errors: [{ location, code: "invalid" }] }) });
    });
};

for (const language of ["en", "de", "ar"] as const) for (const cause of ["Connection", "Unsupported"] as const) {
    test(`a failed ${cause === "Connection" ? "connection" : "unsupported"} skip-interval save reads Apple's message for its interval in ${language}`, async () => {
        for (const interval of INTERVALS) {
            const shown = await failingSave(language, interval, refuse(interval.key, cause));
            assert.equal(shown, MESSAGES[language][`${cause}${interval.name}`], `${interval.row}, ${cause}, ${language}`);
        }
    });
}

test("a refused value, a 403 and a 429 keep Tizen's own wording, with the retry-after and reload advice, whatever the language", async () => {
    const interval = INTERVALS[0];
    for (const language of ["en", "de"] as const) {
        assert.equal(await failingSave(language, interval, refuse(interval.key, "Rejected")), "The server refused this value. Reload settings before choosing another value.", `422 at the value, ${language}`);
        assert.equal(await failingSave(language, interval, async tv => { await tv.page.route(`**/api/v2/settings/values/${interval.key}**`, route => route.request().method() === "PUT" ? route.fulfill({ status: 403, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Forbidden", status: 403 }) }) : route.fallback()); }), "This profile cannot change the setting.", `403, ${language}`);
        assert.equal(await failingSave(language, interval, async tv => { await tv.page.route(`**/api/v2/settings/values/${interval.key}**`, route => route.request().method() === "PUT" ? route.fulfill({ status: 429, headers: { "Retry-After": "7" }, contentType: "application/problem+json", body: JSON.stringify({ type: "about:blank", title: "Too many", status: 429 }) }) : route.fallback()); }), "Too many requests. Try again after 7 seconds.", `429, ${language}`);
    }
});

test("a skip save error shown before the language file lands is translated when it does", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const interval = INTERVALS[0];
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    settings.profile().set(APP_LANGUAGE_KEY, "de");
    try {
        await tv.page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); });
        await refuse(interval.key, "Connection")(tv);
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "login");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(true));
        await tv.page.locator('[data-view="home"]').waitFor();
        await tv.page.locator('[data-focus="profiles"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
        await tv.page.locator('[data-focus="playback"]').click();
        await tv.page.locator(`[data-focus="${interval.row}"]`).click();
        await tv.page.locator(`[data-focus="${interval.row}:${interval.choice}"]`).click();
        const warning = tv.page.locator(".settings-warning");
        await warning.waitFor();
        assert.equal((await warning.innerText()).trim(), MESSAGES.en.ConnectionVideoRewind, "English until the file lands");
        release();
        await tv.eventually(async () => (await tv.page.locator(".settings-warning").innerText()).trim() === MESSAGES.de.ConnectionVideoRewind, "the warning reads German once the file lands");
    } finally { release(); await tv.page.context().close(); }
});
