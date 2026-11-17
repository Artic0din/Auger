// The Person page in German and Arabic (silo-apple Screens/People/PersonDetailView.swift at 0e17c3e3): the facts, filters,
// Filmography heading and count, the empty state and the metadata-refresh status read from the catalog, and in Arabic the page
// follows the mirrored layout (the portrait and the grid read from the right). English keeps its text. The error page and the
// non-exact "About N titles" count have no Apple text of the same English and stay as they were.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { formattingLocale } from "../../src/i18n/language.ts";
import { integerText } from "../../src/i18n/numbers.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeDetails } from "../native/support/fakeDetails.ts";
import { problem } from "../native/support/fakeSilo.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { afterPaint, homeDetailsRead, launchBrowser, openTv, type Tv } from "./support/tv.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const LEFT = 37;
const RIGHT = 39;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);

async function onPersonPage(language: string | null, prepare: (tv: Tv) => Promise<void>, body: (tv: Tv, catalog: FakeDetails) => Promise<void>): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    const catalog = new FakeDetails();
    try {
        await tv.page.emulateMedia({ reducedMotion: "reduce" });
        tv.fake.catalog = catalog;
        const settings = new FakeSettings(tv.fake);
        settings.revision = 28;
        if (language !== null) settings.profile().set(APP_LANGUAGE_KEY, language);
        await prepare(tv);
        await tv.page.evaluate(() => window.browseHarness.connect());
        await tv.eventually(async () => tv.fake.devices.size > 0, "device code");
        tv.fake.approve([...tv.fake.devices.keys()][0] ?? "");
        await tv.jump(5000);
        await tv.eventually(() => tv.page.evaluate(() => window.browseHarness.loginPhase === "signed_in"), "signed in");
        await tv.page.evaluate(() => window.browseHarness.selectProfile("p-owner"));
        await tv.page.evaluate(() => window.browseHarness.mount(false));
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
        await homeDetailsRead(tv);
        if (language !== null) await tv.eventually(async () => (await tv.page.locator(".skyline-roots [data-focus]").allInnerTexts()).includes(text("topBar.forYou", language)), `${language} top bar`);
        await afterPaint(tv);
        await tv.page.locator('[data-section="recently_added"] [data-focus="movie:m0001"]').focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('.details-people [data-focus^="credit:7:"]').first().focus();
        await tv.page.keyboard.press("Enter");
        await tv.page.locator('.browse[data-view="person:7"] .browse-grid .browse-card').first().waitFor();
        await body(tv, catalog);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

const none = async (): Promise<void> => undefined;
const facts = (tv: Tv): Promise<string[]> => tv.page.locator(".person-fact").allInnerTexts();

test("the Person page reads in German: facts, filters, Filmography and its count", async () => {
    await onPersonPage("de", none, async tv => {
        const [born, age, place] = await facts(tv);
        assert.match(born ?? "", /^Geboren am /);
        assert.match(age ?? "", /^\d+ Jahre alt$/);
        assert.equal(place, "Melbourne", "the birthplace stays as the server sent it");
        assert.equal(await tv.page.locator(".person-filmography-filters [data-focus]").allInnerTexts().then(labels => labels.join("|")), "Alle|Filme|Serien");
        assert.equal(await tv.page.locator(".person-filmography-heading h2").innerText(), "Filmografie");
        const count = await tv.page.locator(".person-title-count").innerText();
        const total = Number.parseInt(count, 10);
        assert.ok(total > 0, count);
        assert.equal(count, text("library.titleCount", "de", { count: total, count_text: integerText(total, formattingLocale("de", "en-AU")) }));
    });
});

test("an empty Filmography reads in German", async () => {
    await onPersonPage("de", none, async (tv, catalog) => {
        // The page has opened with credits; a failed filter read and its retry then find none.
        catalog.personReplies.push(problem(500, "internal_error", "Synthetic failure"));
        await tv.page.locator('[data-focus="filter:movie"]').click();
        await tv.page.locator('[data-focus="retry"]').waitFor();
        catalog.empty = true;
        await tv.page.locator('[data-focus="retry"]').click();
        await tv.page.locator(".person-filmography-empty").waitFor();
        assert.equal(await tv.page.locator(".person-filmography-empty .search-state-title").innerText(), "Keine Titel gefunden");
        assert.equal(await tv.page.locator(".person-filmography-empty .search-state-description").innerText(), text("person.emptyBody", "de"));
    });
});

test("the metadata refresh status reads in German", async () => {
    await onPersonPage("de", async tv => {
        await tv.page.route("**/api/v2/catalog/people/7", route => route.fulfill({ json: { id: "7", name: "River Vale", bio: "Updated biography", birth_date: "1980-04-12" } }));
        await tv.page.route("**/api/v2/catalog/people/7/refresh", route => route.fulfill({ status: 202, json: { status: "queued", person_id: "7" } }));
    }, async tv => {
        await tv.page.getByText("Metadaten werden geladen", { exact: true }).waitFor();
    });
});

test("in Arabic the Person page is mirrored: the portrait and the grid read from the right, and facts use Arabic text and digits", async () => {
    await onPersonPage("ar", none, async tv => {
        const view = tv.page.locator('.browse[data-view="person:7"]');
        assert.equal(await view.getAttribute("dir"), null, "the page follows the page's direction");
        const [born, age] = await facts(tv);
        assert.match(born ?? "", /^الميلاد: /);
        assert.match(age ?? "", /[٠-٩]/);
        assert.equal(await tv.page.locator(".person-filmography-heading h2").innerText(), "الأعمال");
        const edges = await tv.page.evaluate(() => ({
            portrait: document.querySelector(".details-person-hero .person-portrait")?.getBoundingClientRect().left ?? Number.NaN,
            info: document.querySelector(".details-person-hero .browse-detail-info")?.getBoundingClientRect().left ?? Number.NaN,
            cards: [...document.querySelectorAll('.browse[data-view="person:7"] .browse-grid .browse-card')].slice(0, 3).map(node => node.getBoundingClientRect().left),
        }));
        assert.ok(edges.portrait > edges.info, `the portrait is right of the facts: ${JSON.stringify(edges)}`);
        assert.ok(edges.cards[0]! > edges.cards[1]! && edges.cards[1]! > edges.cards[2]!, `the first card is rightmost: ${JSON.stringify(edges)}`);
        // The grid starts where the filters start, on the leading edge: the right edge in Arabic, so its first card is not pushed past the page's gutter.
        const lead = await tv.page.evaluate(() => ({
            filter: document.querySelector(".person-filmography-filters [data-focus]")?.getBoundingClientRect().right ?? Number.NaN,
            card: document.querySelector('.browse[data-view="person:7"] .browse-grid .browse-card')?.getBoundingClientRect().right ?? Number.NaN,
        }));
        assert.ok(Math.abs(lead.card - lead.filter) <= 3, `the first card ends where the first filter does: ${JSON.stringify(lead)}`);
        const cards = tv.page.locator('.browse[data-view="person:7"] .browse-grid .browse-card');
        // SwiftUI aligns a card's text by the layout, so Latin titles end where their card does on an Arabic page.
        const align = await cards.evaluateAll(nodes => nodes.slice(0, 3).flatMap(node => [...node.querySelectorAll<HTMLElement>(".browse-card-title, .browse-card-subtitle")]).filter(label => (label.textContent ?? "") !== "").map(label => {
            const range = document.createRange();
            range.selectNodeContents(label);
            return { text: label.textContent, gap: label.getBoundingClientRect().right - range.getBoundingClientRect().right };
        }));
        assert.ok(align.length > 0 && align.every(line => line.gap < 3), `the Person grid's card text is right-aligned: ${JSON.stringify(align)}`);
        const first = await cards.first().getAttribute("data-focus");
        const second = await cards.nth(1).getAttribute("data-focus");
        await cards.first().focus();
        await tv.remote(LEFT);
        assert.equal(await tv.focused(), second, "Left goes to the card drawn on the left");
        await tv.remote(RIGHT);
        assert.equal(await tv.focused(), first);
    });
});

test("the Person page keeps its English text and left-to-right layout in English", async () => {
    await onPersonPage(null, none, async tv => {
        const [born, age, place] = await facts(tv);
        assert.match(born ?? "", /^Born /);
        assert.match(age ?? "", /^\d+ years old$/);
        assert.equal(place, "Melbourne");
        assert.equal(await tv.page.locator(".person-filmography-filters [data-focus]").allInnerTexts().then(labels => labels.join("|")), "All|Movies|Series");
        assert.equal(await tv.page.locator(".person-filmography-heading h2").innerText(), "Filmography");
        assert.match(await tv.page.locator(".person-title-count").innerText(), /^\d+ titles?$/);
        const lead = await tv.page.evaluate(() => ({
            filter: document.querySelector(".person-filmography-filters [data-focus]")?.getBoundingClientRect().left ?? Number.NaN,
            card: document.querySelector('.browse[data-view="person:7"] .browse-grid .browse-card')?.getBoundingClientRect().left ?? Number.NaN,
        }));
        assert.ok(Math.abs(lead.card - lead.filter) <= 3, `English: the first card starts where the first filter does: ${JSON.stringify(lead)}`);
        const left = await tv.page.evaluate(() => ({ portrait: document.querySelector(".details-person-hero .person-portrait")?.getBoundingClientRect().left ?? Number.NaN, info: document.querySelector(".details-person-hero .browse-detail-info")?.getBoundingClientRect().left ?? Number.NaN }));
        assert.ok(left.portrait < left.info, `English reads left to right: ${JSON.stringify(left)}`);
    });
});
