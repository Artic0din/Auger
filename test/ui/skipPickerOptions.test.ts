// A skip-interval picker lists Apple's seven choices and nothing else: silo-apple's TVPlaybackSettingsView builds its options as
// `SeekIntervalContract.choices.map { … }` with no `TVSettingsOptions.useProfileSetting` in front (silo-apple 648091a7, line 556), unlike Resolution
// and Maximum Bitrate. So a stored value cannot be cleared from the picker, only replaced, which is also how Apple TV behaves.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { AUDIOBOOK_SEEK_BACK_KEY, AUDIOBOOK_SEEK_FORWARD_KEY, SEEK_BACK_KEY, SEEK_FORWARD_KEY } from "../../src/contracts/v2/settings.ts";
import { FakeCatalog } from "../native/support/fakeCatalog.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const CHOICES = ["5 seconds", "10 seconds", "15 seconds", "30 seconds", "45 seconds", "60 seconds", "90 seconds"];
const PICKERS = [
    { row: "seek-back", key: SEEK_BACK_KEY }, { row: "seek-forward", key: SEEK_FORWARD_KEY },
    { row: "audiobook-seek-back", key: AUDIOBOOK_SEEK_BACK_KEY }, { row: "audiobook-seek-forward", key: AUDIOBOOK_SEEK_FORWARD_KEY },
] as const;

async function withPlayback(stored: boolean, body: (tv: Tv, settings: FakeSettings) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    tv.fake.catalog = new FakeCatalog();
    const settings = new FakeSettings(tv.fake);
    settings.revision = 28;
    if (stored) for (const { key } of PICKERS) settings.profile().set(key, 45);
    try {
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
        await tv.page.locator('[data-focus="seek-back"]').waitFor();
        await body(tv, settings);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

for (const stored of [true, false]) {
    test(`each skip picker lists Apple's seven choices and nothing else, ${stored ? "with a value stored" : "with none stored"}`, async () => {
        await withPlayback(stored, async (tv, settings) => {
            for (const { row, key } of PICKERS) {
                await tv.page.locator(`[data-focus="${row}"]`).click();
                await tv.page.getByRole("radio", { name: "5 seconds", exact: true }).waitFor();
                const controls = await tv.page.locator(".settings-modal [data-focus]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-focus") ?? ""));
                assert.deepEqual(controls, CHOICES.map(choice => `${row}:${parseInt(choice, 10)}`), `${row}: exactly the seven choices, in order`);
                assert.deepEqual(await tv.page.getByRole("radio").allTextContents(), CHOICES, `${row}: their labels`);
                assert.equal(await tv.page.getByText("Use inherited default", { exact: true }).count(), 0, `${row}: no reset row`);
                assert.equal(await tv.page.locator('.settings-modal [data-focus="reset"]').count(), 0, `${row}: no reset control`);
                await tv.remote(10009);
                await tv.page.getByRole("dialog").waitFor({ state: "detached" });
                assert.equal(settings.profile().has(key), stored, `${row}: opening the picker changes nothing`);
            }
        });
    });
}
