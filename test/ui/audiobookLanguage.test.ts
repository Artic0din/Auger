// The audiobook detail and its chapter picker in German and Arabic (silo-apple tvOS/Screens/Detail/TVAudiobook*.swift at d49d7bd): the
// text reads from the catalog, the page follows the shown language and direction (in Arabic the action row reads from the right and Left
// steps to the next pill), a late language file redraws the page, and English is unchanged. Text with no Apple key stays English.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { durationText } from "../../src/i18n/duration.ts";
import { integerText } from "../../src/i18n/numbers.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeAudiobooks } from "../native/support/fakeAudiobooks.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37;
const TIDE = "audiobook:tide";
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);
/** Arabic-Indic digits to ASCII and the right-to-left isolates away, so a line reads against a message built from plain numbers. */
const plain = (value: string): string => value.replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit))).replace(/[⁨⁩]/g, "");

async function inLanguage(language: string, body: (tv: Tv) => Promise<void>, hold?: Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    try {
        if (hold !== undefined) await tv.page.route(`**/tv/catalog/${language}.js`, async route => { await hold; await route.fallback(); });
        tv.fake.catalog = new FakeAudiobooks();
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        settings.profile().set(APP_LANGUAGE_KEY, language);
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount());
        await tv.page.locator('.browse[data-view="home"] .browse-card').first().waitFor();
        await homeDetailsRead(tv);
        if (hold === undefined) await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(text("topBar.forYou", language)), `${language} top bar`);
        await body(tv);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

async function openTide(tv: Tv): Promise<void> {
    await tv.page.locator(`[data-section="shelf"] [data-focus="${TIDE}"]`).click();
    await tv.page.locator(`.browse[data-view="audiobook:${TIDE}"]`).waitFor();
}

for (const language of ["de", "ar"]) {
    test(`the audiobook detail reads ${language}: eyebrow, series, state, actions and sections`, async () => {
        await inLanguage(language, async tv => {
            await openTide(tv);
            const left = durationText(111, false, language);
            assert.equal(await tv.page.locator(".audiobook-eyebrow").innerText(), text("detail.audiobook.labelWithGenre", language, { genre: "FANTASY" }));
            assert.equal(plain(await tv.page.locator(".audiobook-state-line").innerText()), plain(text("detail.audiobook.currentChapter", language, { number: integerText(2), title: "What the Tide Owes" })));
            assert.ok(plain(await tv.page.locator(".audiobook-state-detail").innerText()).includes(plain(left)), await tv.page.locator(".audiobook-state-detail").innerText());
            assert.equal(await tv.page.locator('[data-focus="play"]').innerText(), text("detail.resume", language));
            assert.equal(await tv.page.locator('[data-focus="chapters"]').innerText(), text("detail.audiobook.chapters", language));
            assert.equal(await tv.page.locator('[data-focus="start-over"]').innerText(), text("detail.startOver", language));
            const titles = await tv.page.locator(".audiobook-section-title").allInnerTexts();
            assert.equal(titles[0], text("detail.audiobook.about", language));
            assert.equal(titles[1], text("detail.audiobook.narrations", language));
            assert.deepEqual(titles.slice(3), [text("detail.audiobook.moreByAuthor", language), text("detail.audiobook.related", language)]);
            assert.equal(plain(await tv.page.locator(".audiobook-rail .browse-card-subtitle").first().innerText()), plain(text("detail.audiobook.bookNumber", language, { number: integerText(1) })));
        });
    });

    test(`the chapter picker reads ${language}: title, subline and NOW badge`, async () => {
        await inLanguage(language, async tv => {
            await openTide(tv);
            await tv.page.locator('[data-focus="chapters"]').click();
            await tv.page.locator(`.browse[data-view="audiobook:${TIDE}:chapters"]`).waitFor();
            assert.equal(await tv.page.locator(".audiobook-picker-title").innerText(), text("detail.audiobook.chapters", language));
            assert.equal(await tv.page.locator(".audiobook-picker").getAttribute("aria-label"), text("detail.audiobook.chapters", language));
            assert.ok(plain(await tv.page.locator(".audiobook-picker-subline").innerText()).includes(plain(text("detail.audiobook.chapterOf", language, { number: integerText(2), total: integerText(3) }))), await tv.page.locator(".audiobook-picker-subline").innerText());
            assert.equal(await tv.page.locator('[data-focus="chapter-1"] .audiobook-chapter-now').innerText(), text("detail.audiobook.nowBadge", language));
        });
    });
}

test("in Arabic the page is mirrored: the actions read from the right and Left steps to the next pill", async () => {
    await inLanguage("ar", async tv => {
        await openTide(tv);
        assert.equal(await tv.page.evaluate(() => document.documentElement.getAttribute("dir")), "rtl");
        const lefts = await tv.page.evaluate(() => ["play", "chapters", "start-over"].map(key => Math.round(document.querySelector(`[data-focus="${key}"]`)?.getBoundingClientRect().left ?? Number.NaN)));
        assert.ok(lefts[0]! > lefts[1]! && lefts[1]! > lefts[2]!, `Resume is rightmost: ${lefts.join(",")}`);
        await tv.page.locator('[data-focus="play"]').focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "chapters", "Left goes to the pill drawn on the left");
    });
});

test("a language file that lands after the audiobook page drew redraws it in German", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await inLanguage("de", async tv => {
        await openTide(tv);
        assert.equal(await tv.page.locator('[data-focus="chapters"]').innerText(), "Chapters", "English until the file lands");
        release();
        await tv.eventually(async () => (await tv.page.locator('[data-focus="chapters"]').innerText()) === text("detail.audiobook.chapters", "de"), "the page is German");
        assert.equal(await tv.page.locator('[data-focus="play"]').innerText(), text("detail.resume", "de"));
    }, held);
});

test("the audiobook detail in English is the text it always was", async () => {
    await inLanguage("en", async tv => {
        await openTide(tv);
        assert.equal(await tv.page.locator(".audiobook-eyebrow").innerText(), "AUDIOBOOK · FANTASY");
        assert.equal(await tv.page.locator(".audiobook-credits").innerText(), "by Brandon Sanderson  ·  read by Michael Kramer & Kate Reading");
        assert.equal(await tv.page.locator(".audiobook-state-detail").innerText(), "8:32 into the chapter · 1h 51m left in the book");
    });
});
