import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { launchBrowser } from "./support/tv.ts";

// Apple's tvOS reds (silo-apple Theme/Colors.swift): siloError #B00020 on settings rows, siloErrorInk #FF6961 on every other error text.
const SILO_ERROR = "rgb(176, 0, 32)";
const SILO_ERROR_INK = "rgb(255, 105, 97)";
const WHITE = "rgb(255, 255, 255)";

const SOURCES = ["theme.css", "ui/signIn.css", "ui/browse.css", "ui/confirmationDialog.css", "ui/accounts.css", "player/player.css"] as const;
const STYLES = SOURCES.map(name => readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8")).join("\n");

// Each surface is the markup a screen builds for it: the selector is the node whose colour is read.
const SURFACES: readonly (readonly [string, string, string])[] = [
    ["settings warning footer (TVSettingsWarningFooter)", '<div class="settings-pane"><p id="s" class="browse-text browse-error settings-warning">Could not save</p></div>', SILO_ERROR],
    ["settings launch-choice failure", '<div class="settings-modal"><p id="s" class="browse-error settings-warning">Could not save the launch choice.</p></div>', SILO_ERROR],
    ["settings destructive row", '<div class="settings-pane"><button id="s" class="settings-destructive">Sign Out</button></div>', SILO_ERROR],
    ["sign-in and profile error text (MarqueeErrorText)", '<p id="s" class="signin-text signin-error">Wrong password</p>', SILO_ERROR_INK],
    ["first-run inline error (MarqueeErrorText)", '<p id="s" class="marquee-error">Could not connect</p>', SILO_ERROR_INK],
    ["PIN status", '<p id="s" class="pin-status-error">Incorrect PIN</p>', SILO_ERROR_INK],
    ["inline note on a browse page", '<p id="s" class="browse-text browse-error">Could not load title information.</p>', SILO_ERROR_INK],
    ["profile alert text", '<div class="profiles-flow"><div class="signin-alert"><p id="s" class="signin-alert-text signin-error">Could not save.</p></div></div>', SILO_ERROR_INK],
    ["player completion failure text", '<div class="player-error"><p id="s" class="player-error-text">Could not confirm playback.</p></div>', SILO_ERROR_INK],
    ["player error wall text (PlayerView.errorView)", '<div class="player-error player-error-wall"><p id="s" class="player-error-text">Can\'t reach the server.</p></div>', WHITE],
    ["player error wall mark", '<div class="player-error player-error-wall"><div id="s" class="player-error-mark"></div></div>', SILO_ERROR],
];

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

for (const [name, markup, expected] of SURFACES) {
    test(`${name} uses ${expected}`, async () => {
        const page = await browser.newPage();
        try {
            await page.setContent(`<!DOCTYPE html><html><head><style>${STYLES}</style></head><body>${markup}</body></html>`);
            assert.equal(await page.locator("#s").evaluate(node => getComputedStyle(node).color), expected);
        } finally { await page.close(); }
    });
}

test("every error line Settings builds carries settings-warning", () => {
    // The surfaces above use hand-written markup; this ties the Settings ones to what mountSettings really emits.
    const settings = readFileSync(new URL("../../src/ui/settings.ts", import.meta.url), "utf8");
    const errors = settings.match(/"[^"]*\bbrowse-error\b[^"]*"/g) ?? [];
    assert.equal(errors.length, 6);
    for (const classes of errors) assert.match(classes, /\bsettings-warning\b/);
});

test("the single pink token is gone", () => {
    assert.doesNotMatch(STYLES, /#ffb4ab/i);
});
