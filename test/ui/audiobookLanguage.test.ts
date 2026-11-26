// The audiobook detail and its chapter picker in German and Arabic (silo-apple tvOS/Screens/Detail/TVAudiobook*.swift at d49d7bd): the
// text reads from the catalog, the page follows the shown language and direction (in Arabic the action row reads from the right and Left
// steps to the next pill), a late language file redraws the page, and English is unchanged. Text with no Apple key stays English.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { build } from "esbuild";
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
let bundle: string;
before(async () => {
    browser = await launchBrowser();
    const built = await build({
        stdin: { contents: `import { audiobookView } from "./src/ui/audiobookView.ts"; import { setAppLanguage, SHIPPED_LANGUAGES } from "./src/i18n/language.ts"; import { registerCatalog } from "./src/i18n/translate.ts"; Object.assign(window, { audiobookView, setAppLanguage, SHIPPED_LANGUAGES, registerCatalog });`, resolveDir: fileURLToPath(new URL("../..", import.meta.url)), loader: "ts" },
        bundle: true, write: false, format: "iife", platform: "browser",
    });
    bundle = built.outputFiles[0]?.text ?? "";
});
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
            const factLabels = await tv.page.locator(".audiobook-fact-label").allInnerTexts();
            assert.equal(factLabels.length, 6);
            assert.equal(factLabels[2], text("detail.facts.publisher", language).toLocaleUpperCase(language));
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
            assert.equal(plain(await tv.page.locator('[data-focus="chapter-2"] .audiobook-row-title').innerText()), plain(text("detail.audiobook.chapter", language, { number: integerText(3) })));
            assert.equal(await tv.page.locator('[data-focus="chapter-1"] .audiobook-chapter-now').innerText(), text("detail.audiobook.nowBadge", language));
        });
    });
}

test("in Arabic the page is mirrored: the actions read from the right, Left steps pills, and chapter progress fills left to right", async () => {
    await inLanguage("ar", async tv => {
        await openTide(tv);
        assert.equal(await tv.page.evaluate(() => document.documentElement.getAttribute("dir")), "rtl");
        const lefts = await tv.page.evaluate(() => ["play", "chapters", "start-over", "favorite", "finished"].map(key => Math.round(document.querySelector(`[data-focus="${key}"]`)?.getBoundingClientRect().left ?? Number.NaN)));
        assert.ok(lefts[0]! > lefts[1]! && lefts[1]! > lefts[2]! && lefts[2]! > lefts[3]! && lefts[3]! > lefts[4]!, `Resume is rightmost: ${lefts.join(",")}`);
        await tv.page.locator('[data-focus="play"]').focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), "chapters", "Left goes to the pill drawn on the left");

        await tv.page.locator('[data-focus="chapters"]').click();
        await tv.page.locator(`.browse[data-view="audiobook:${TIDE}:chapters"]`).waitFor();
        // The current chapter hides its underline while focused, so move focus before measuring left-to-right progress.
        await tv.page.locator('[data-focus="chapter-0"]').focus();
        const bar = await tv.page.locator('[data-focus="chapter-1"]').evaluate(row => {
            const fill = row.querySelector(".audiobook-chapter-progress");
            if (fill === null) return null;
            const r = row.getBoundingClientRect(), f = fill.getBoundingClientRect();
            return { rowLeft: r.left, rowRight: r.right, fillLeft: f.left, fillRight: f.right };
        });
        assert.ok(bar !== null && Math.abs(bar.fillLeft - bar.rowLeft) <= 2 && bar.fillRight < bar.rowRight, `LTR progress grows from left edge: ${JSON.stringify(bar)}`);
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

const catalogs = Object.fromEntries(["de", "ar"].map(tag => [tag, JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>]));
const FSI = "\u2068";
const PDI = "\u2069";

type Credits = { authors: readonly string[]; narrators: readonly string[] };
/** The credits line the page draws for these people in this language: its text, and the text of each bold name in order. */
async function creditsLine(language: string | null, credits: Credits): Promise<{ text: string; bold: string[] }> {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
        await page.setContent("<!doctype html><main></main>");
        await page.addScriptTag({ content: bundle });
        return await page.evaluate(([tag, files, people]) => {
            const api = window as unknown as { audiobookView: (book: unknown, handlers: unknown) => { content: HTMLElement[] }; setAppLanguage: (tag: string | null, shipped: readonly string[], device: readonly string[]) => void; registerCatalog: (tag: string, catalog: Record<string, string>) => void; SHIPPED_LANGUAGES: readonly string[] };
            for (const [name, catalog] of Object.entries(files)) api.registerCatalog(name, catalog);
            api.setAppLanguage(tag, api.SHIPPED_LANGUAGES, ["en-AU"]);
            const person = (name: string) => ({ name, personId: undefined, photoUrl: undefined });
            const book = { id: "audiobook:x", title: "Title", overview: undefined, year: undefined, genres: [], posterUrl: undefined, position: 0, played: false, duration: 3600, parts: [{ fileId: "1", duration: 3600, offset: 0 }], chapters: [],
                detail: { authors: people.authors.map(person), narrators: people.narrators.map(person), publisher: undefined, totalDurationSeconds: undefined, series: undefined, otherNarrations: [], alsoByAuthor: [], similar: [] } };
            const view = api.audiobookView(book, { context: { baseUrl: "https://silo.invalid" }, pickerOpen: false, setPicker: () => undefined, back: () => undefined });
            const line = view.content[0]?.querySelector(".audiobook-credits");
            return { text: line?.textContent ?? "", bold: [...(line?.querySelectorAll("strong") ?? [])].map(node => node.textContent ?? "") };
        }, [language, catalogs, credits] as const);
    } finally { await page.close(); }
}

for (const language of ["de", "ar"]) {
    const iso = (name: string): string => language === "ar" ? `${FSI}${name}${PDI}` : name;
    test(`the credits line is one ${language} message with each name bold in place, including an author who also narrates and names with regex characters`, async () => {
        // Author and narrator: the message is Apple's one catalog string, the names are restyled where they stand.
        const both = await creditsLine(language, { authors: ["A.B. (Jr)"], narrators: ["C+D [Sr]"] });
        assert.equal(both.text, text("detail.audiobook.byAuthorReadBy", language, { author: iso("A.B. (Jr)"), narrator: iso("C+D [Sr]") }));
        assert.deepEqual(both.bold.sort(), ["A.B. (Jr)", "C+D [Sr]"].sort());
        // An author who narrates appears twice in the line, and both occurrences are bold.
        const same = await creditsLine(language, { authors: ["Ann Lee"], narrators: ["Ann Lee"] });
        assert.equal(same.text, text("detail.audiobook.byAuthorReadBy", language, { author: iso("Ann Lee"), narrator: iso("Ann Lee") }));
        assert.deepEqual(same.bold, ["Ann Lee", "Ann Lee"]);
        // One list alone reads its own key.
        const authorOnly = await creditsLine(language, { authors: ["A.B. (Jr)"], narrators: [] });
        assert.equal(authorOnly.text, text("detail.audiobook.byAuthor", language, { author: iso("A.B. (Jr)") }));
        assert.deepEqual(authorOnly.bold, ["A.B. (Jr)"]);
        const narratorOnly = await creditsLine(language, { authors: [], narrators: ["C+D [Sr]"] });
        assert.equal(narratorOnly.text, text("detail.audiobook.readBy", language, { narrator: iso("C+D [Sr]") }));
        assert.deepEqual(narratorOnly.bold, ["C+D [Sr]"]);
    });
}

test("the English credits line keeps its two spaces around the dot and bolds both names", async () => {
    const line = await creditsLine(null, { authors: ["A.B. (Jr)"], narrators: ["C+D [Sr]"] });
    assert.equal(line.text, "by A.B. (Jr)  ·  read by C+D [Sr]");
    assert.deepEqual(line.bold, ["A.B. (Jr)", "C+D [Sr]"]);
});
