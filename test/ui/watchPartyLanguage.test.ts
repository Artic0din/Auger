// Watch Party in German and Arabic (silo-apple Screens/WatchParty/*, WatchParty/WatchPartyLobbyState.swift): the hub, lobby, Ready,
// ballot, picker, confirmation page and invitation read from the catalog under Apple's keys; the host's and members' names stay as the
// server sent them, isolated inside an Arabic sentence; in Arabic the pages mirror and Left and Right follow the layout.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Browser, Page } from "playwright";
import { APP_LANGUAGE_KEY } from "../../src/contracts/v2/settings.ts";
import { translate } from "../../src/i18n/translate.ts";
import { registerSourceCatalogs } from "../native/support/catalogs.ts";
import { FakeSettings } from "../native/support/fakeSettings.ts";
import { FakeWatchParty } from "../native/support/fakeWatchParty.ts";
import { launchBrowser, openTv, type Tv } from "./support/tv.ts";
import { button, menuTitles, openHub, start } from "./support/watchParty.ts";

registerSourceCatalogs();

let browser: Browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await browser.close(); });

const RIGHT = 39;
const text = (key: Parameters<typeof translate>[0], language: string, args?: Parameters<typeof translate>[1]): string => translate(key, args, language);
const view = (tv: Tv, name: string) => tv.page.locator(`.browse[data-view="${name}"]`);
/** The text as a screen reads it: a line break the layout honours is a space for comparison. */
const flat = (value: string | null): string => (value ?? "").replace(/\s+/g, " ").trim();
const isolate = (value: string): string => `⁨${value}⁩`;

async function inLanguage(language: string, body: (tv: Tv, fake: FakeWatchParty) => Promise<void>, configure: (fake: FakeWatchParty) => void = () => undefined, prepare: (page: Page) => Promise<void> = async () => undefined): Promise<void> {
    const tv = await openTv(browser, { app: "browse" });
    await prepare(tv.page);
    const fake = new FakeWatchParty();
    configure(fake);
    try {
        await start(tv, fake, true, () => {
            const settings = new FakeSettings(tv.fake);
            settings.revision = 28;
            settings.profile().set(APP_LANGUAGE_KEY, language);
        });
        await tv.eventually(async () => (await menuTitles(tv)).includes(text("watchParty.menu.open", language)), `${language} entry offered`);
        await body(tv, fake);
        assert.deepEqual(tv.console, []);
    } finally { await tv.page.context().close(); }
}

async function enterRoom(tv: Tv, fake: FakeWatchParty, how: "create" | "vote" | "join", language = "de"): Promise<void> {
    await openHub(tv);
    if (how === "join") {
        await tv.page.locator('[data-focus="code"]').fill("K7M2QX");
        await button(tv, "join").click();
    } else await button(tv, how).click();
    await view(tv, "watchParty:lobby").waitFor();
    await tv.eventually(async () => fake.sockets.length === 1 && !fake.sockets[0]?.closed, "room socket open");
    const waiting = [text("watchParty.connection.connecting", language), text("watchParty.connection.reconnecting", language)];
    await tv.eventually(async () => !waiting.includes(await tv.page.locator(".watch-party-connection").textContent() ?? waiting[0] ?? ""), "lobby connected");
}

async function stageMovie(tv: Tv): Promise<void> {
    await button(tv, "choose").click();
    await view(tv, "watchParty:picker:shelves").waitFor();
    await button(tv, "movie:m0004").click();
    await view(tv, "watchParty:choice").waitFor();
    await button(tv, "confirm").click();
    await view(tv, "watchParty:lobby").waitFor();
}

test("the hub reads in German: headline, sections, buttons and the code field", async () => {
    await inLanguage("de", async tv => {
        await openHub(tv);
        assert.equal(flat(await tv.page.locator(".watch-party-title").textContent()), flat(text("watchParty.page.headline", "de")));
        assert.equal(await tv.page.locator(".watch-party-body").textContent(), text("watchParty.page.body", "de"));
        assert.deepEqual(await tv.page.locator(".watch-party-eyebrow").allTextContents(), [text("watchParty.title", "de"), text("watchParty.hub.hostSection", "de"), text("watchParty.hub.joinSection", "de")]);
        assert.equal(await button(tv, "create").textContent(), text("watchParty.page.start", "de"));
        assert.equal(await button(tv, "vote").textContent(), text("watchParty.page.startVote", "de"));
        assert.equal(await button(tv, "join").textContent(), text("watchParty.code.joinParty", "de"));
        assert.equal(await button(tv, "code").getAttribute("placeholder"), text("watchParty.hub.codeField", "de"));
        assert.equal(await button(tv, "code").getAttribute("aria-label"), text("watchParty.hub.codeField", "de"));
    });
});

test("the hub's own errors read in German: an invitation link and a missing server answer", async () => {
    await inLanguage("de", async tv => {
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').fill("https://silo.example.test/rooms/join?token=x");
        await button(tv, "join").click();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-banner-text").allTextContents()).includes(text("watchParty.error.invalidInvitation", "de")), "invalid invitation in German");
    });
});

test("the host's empty lobby reads in German with the host's name left as the server sent it", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create");
        assert.equal(await tv.page.locator(".watch-party-room-name").textContent(), text("watchParty.title", "de"));
        assert.equal(await tv.page.locator(".watch-party-code-label").textContent(), text("watchParty.codePill.label", "de"));
        assert.equal(await button(tv, "lobby-code").getAttribute("aria-label"), text("watchParty.codePill.description", "de", { code: "K 7 M 2 Q X" }));
        assert.equal(await button(tv, "options").getAttribute("aria-label"), text("watchParty.options.title", "de"));
        assert.equal(await button(tv, "options").locator(".watch-party-circle-label").textContent(), text("watchParty.options.button", "de"));
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), text("watchParty.eyebrow.open", "de"));
        assert.equal(flat(await tv.page.locator(".watch-party-hero-title").textContent()), flat(text("watchParty.hero.pick", "de")));
        assert.equal(await tv.page.locator(".watch-party-lead").textContent(), text("watchParty.hero.pickCaption", "de"));
        assert.equal(await button(tv, "choose").textContent(), text("watchParty.button.chooseTitle", "de"));
        assert.equal(await tv.page.locator(".watch-party-here-heading .watch-party-eyebrow").textContent(), text("watchParty.seats.hereNow", "de"));
        assert.equal(await tv.page.locator(".watch-party-here").getAttribute("aria-label"), text("watchParty.seats.members", "de"));
        assert.equal(await button(tv, "invite").getAttribute("aria-label"), text("watchParty.invite.friends", "de"));
        assert.equal(await button(tv, "invite").locator(".watch-party-seat-name").textContent(), text("watchParty.seat.invite", "de"));
        assert.equal(await tv.page.locator(".watch-party-seat-name").first().textContent(), "Owner", "the member's name is the server's");
        assert.equal(await tv.page.locator(".watch-party-seat-detail").first().textContent(), `${text("watchParty.seat.host", "de")} · ${text("watchParty.seat.you", "de")}`);
        assert.equal(await tv.page.locator(".watch-party-connection").textContent(), text("watchParty.connection.here", "de", { count: 2 }));
    });
});

test("the lobby reads in German once a title is staged: Start, Change title, hero facts and the host's hint", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create");
        await stageMovie(tv);
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), text("watchParty.eyebrow.upNext", "de"));
        assert.equal(await tv.page.locator(".watch-party-caption").textContent(), text("watchParty.hero.youChose", "de"));
        assert.equal(await button(tv, "change").textContent(), text("watchParty.button.changeTitle", "de"));
        assert.equal(await button(tv, "start").textContent(), text("watchParty.button.startForEveryone", "de"));
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), text("watchParty.hint.notReady.oneName", "de", { first: "Sam" }));
        assert.equal(await tv.page.locator(".watch-party-presence").textContent(), text("watchParty.presence.ready", "de", { ready: "1", total: 2 }));
    });
});

test("a guest's lobby reads in German: Ready, the host's pick, what the host does next and the seat states", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "join");
        assert.equal(flat(await tv.page.locator(".watch-party-hero-title").textContent()), flat(text("watchParty.hero.waiting", "de", { host: "Owner" })));
        assert.equal(await tv.page.locator(".watch-party-lead").textContent(), text("watchParty.hero.waitingCaption", "de", { host: "Owner" }));
        assert.equal(await button(tv, "ready").textContent(), text("watchParty.button.imReady", "de"));
        await button(tv, "ready").click();
        await tv.eventually(async () => (await button(tv, "ready").textContent())?.startsWith(text("watchParty.button.youreReady", "de")) === true, "You're ready in German");
        assert.equal(await tv.page.locator(".watch-party-undo").textContent(), text("watchParty.button.tapToUndo", "de"));
        assert.equal(await tv.page.locator(".watch-party-seat").nth(0).getAttribute("aria-label"), ["Owner", text("watchParty.seat.a11yHost", "de"), text("watchParty.seat.a11yReady", "de")].join(", "));
        assert.equal(await tv.page.locator(".watch-party-seat").nth(1).getAttribute("aria-label"), ["Sam", text("watchParty.seat.youLower", "de"), text("watchParty.seat.a11yReady", "de")].join(", "));
    }, fake => { fake.role = "guest"; });
});

test("Party options, End and the invitation read in German", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create");
        await button(tv, "options").click();
        await view(tv, "watchParty:options").waitFor();
        assert.equal(await tv.page.locator(".watch-party-sheet-title").textContent(), text("watchParty.options.title", "de"));
        assert.deepEqual(await tv.page.locator(".watch-party-option-title").allTextContents(), [text("watchParty.options.whoChooses", "de"), text("watchParty.options.playbackControls", "de"), text("watchParty.options.end", "de"), text("watchParty.options.leave", "de"), text("watchParty.options.close", "de")]);
        assert.deepEqual(await tv.page.locator(".watch-party-option-value").allTextContents(), [text("watchParty.options.hostChooses", "de"), text("watchParty.options.hostOnly", "de")]);
        await button(tv, "end").click();
        await view(tv, "watchParty:end").waitFor();
        assert.equal(await tv.page.locator(".watch-party-sheet-title").textContent(), text("watchParty.end.confirmTitle", "de"));
        assert.deepEqual(await tv.page.locator(".watch-party-end-actions button").allTextContents(), [text("common.cancel", "de"), text("watchParty.end.confirm", "de")]);
        await button(tv, "cancel").click();
        await view(tv, "watchParty:lobby").waitFor();
        await button(tv, "lobby-code").click();
        await view(tv, "watchParty:invite").waitFor();
        assert.equal(await tv.page.locator(".watch-party-invite .watch-party-eyebrow").textContent(), text("watchParty.invite.friends", "de"));
        assert.equal(await tv.page.locator(".watch-party-invite-title").textContent(), text("watchParty.invite.title", "de"));
        assert.equal(await tv.page.locator(".watch-party-invite-copy .watch-party-lead").textContent(), text("watchParty.invite.body", "de"));
        assert.equal(await tv.page.locator(".watch-party-invite-code").getAttribute("aria-label"), text("watchParty.partyCode", "de", { code: "K, 7, M, 2, Q, X" }));
        assert.equal(await tv.page.locator(".watch-party-invite-copy .watch-party-caption").textContent(), text("watchParty.invite.scan", "de"));
        assert.equal(await tv.page.locator(".watch-party-qr svg").getAttribute("aria-label"), text("watchParty.invite.qrDescription", "de"));
        assert.equal(await button(tv, "done").textContent(), text("common.done", "de"));
    });
});

test("a vote room reads in German: the question, tallies, vote labels and the Suggest card", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "vote");
        assert.equal(await tv.page.locator(".watch-party-lead").first().textContent(), text("watchParty.hero.voteCaption.manager", "de"));
        assert.equal(flat(await tv.page.locator(".watch-party-hero-title").textContent()), text("watchParty.hero.voteTitle", "de"));
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), text("watchParty.eyebrow.voting", "de", { count: 0 }));
        assert.equal(await tv.page.locator(".watch-party-hint").textContent(), text("watchParty.hint.suggestToStart", "de"));
        assert.equal(await button(tv, "ballot-suggest").getAttribute("aria-label"), text("watchParty.button.suggestTitle", "de"));
        assert.equal(await button(tv, "ballot-suggest").locator(".watch-party-candidate-title").textContent(), text("watchParty.button.suggestTitle", "de"));
        assert.equal(await button(tv, "ballot-suggest").locator(".watch-party-candidate-line").textContent(), text("watchParty.ballot.addCaption", "de"));
    });
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "vote");
        await tv.eventually(async () => await button(tv, "suggestion:heat").count() === 1, "the ballot");
        assert.equal(await tv.page.locator(".watch-party-eyebrow").first().textContent(), text("watchParty.eyebrow.voting", "de", { count: 2 }));
        assert.equal(await button(tv, "suggestion:heat").getAttribute("aria-label"), text("watchParty.ballot.removeVote", "de", { title: "Heat" }));
        assert.equal(await button(tv, "suggestion:dune").getAttribute("aria-label"), text("watchParty.ballot.vote", "de", { title: "Dune" }));
        assert.equal(await button(tv, "suggestion:heat").locator(".watch-party-vote-label").textContent(), text("watchParty.ballot.votesLabel", "de", { count: 1 }));
        // The label is Apple's action; the tally and the leader reach a screen reader as the button's description.
        const badge = button(tv, "suggestion:heat").locator(".watch-party-vote-badge");
        assert.equal(await badge.getAttribute("aria-label"), text("watchParty.ballot.candidateLeading", "de", { title: "Heat", count: 1 }));
        assert.equal(await button(tv, "suggestion:heat").getAttribute("aria-describedby"), await badge.getAttribute("id"));
        assert.equal(await button(tv, "suggestion:dune").locator(".watch-party-vote-badge").getAttribute("aria-label"), text("watchParty.ballot.candidate", "de", { title: "Dune", count: 0 }));
        assert.equal(await button(tv, "suggestion:dune").locator(".watch-party-candidate-line").textContent(), text("watchParty.ballot.note", "de", { note: "Popcorn night" }));
        await button(tv, "suggestion:dune").click();
        await tv.eventually(async () => (await button(tv, "suggestion:dune").getAttribute("aria-label")) === text("watchParty.ballot.removeVote", "de", { title: "Dune" }), "Remove vote in German");
    }, fake => { fake.suggest("heat", "Heat", ["p-owner"]); fake.suggest("dune", "Dune", [], { note: "Popcorn night" }); });
});

test("the picker and the confirmation page read in German", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create");
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        assert.equal(await tv.page.locator(".watch-party-picker-name").textContent(), text("watchParty.picker.select", "de"));
        assert.equal(await button(tv, "picker-close").textContent(), text("watchParty.picker.close", "de"));
        const titles = await tv.page.locator(".watch-party-shelf .browse-section-title").allTextContents();
        assert.ok(titles.length > 0 && titles.every(title => [text("watchParty.picker.continueTogether", "de"), text("watchParty.picker.watchlists", "de")].includes(title)), titles.join(" | "));
        await button(tv, "movie:m0004").click();
        await view(tv, "watchParty:choice").waitFor();
        assert.equal(await tv.page.locator(".watch-party-choice .watch-party-eyebrow").textContent(), text("watchParty.picker.watchTogether", "de"));
        assert.equal(await button(tv, "confirm").textContent(), text("watchParty.confirm.choose", "de"));
    });
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "vote");
        await button(tv, "ballot-suggest").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        assert.equal(await tv.page.locator(".watch-party-picker-name").textContent(), text("watchParty.picker.suggest", "de"));
        await button(tv, "movie:m0004").click();
        await view(tv, "watchParty:choice").waitFor();
        assert.equal(await tv.page.locator(".watch-party-choice .watch-party-eyebrow").textContent(), text("watchParty.picker.suggestToParty", "de"));
        assert.equal(await button(tv, "confirm").textContent(), text("watchParty.confirm.addSuggestion", "de"));
    });
});

test("a series' episodes read in German: the eyebrow, Close, the numbered title and Apple's S and E code", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create");
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s2").click();
        await view(tv, "watchParty:episodes").waitFor();
        await tv.page.locator(".watch-party-episode").first().waitFor();
        assert.equal(await tv.page.locator(".watch-party-episodes-head .watch-party-eyebrow").textContent(), text("watchParty.eyebrow.chooseEpisode", "de"));
        assert.equal(await button(tv, "episodes-close").textContent(), text("watchParty.picker.close", "de"));
        const first = tv.page.locator(".watch-party-episode").first();
        const title = (await first.locator(".watch-party-episode-title").textContent()) ?? "";
        assert.ok(title.startsWith(text("watchParty.episodes.numbered", "de", { number: "1", title: "" })), title);
        await first.click();
        await view(tv, "watchParty:choice").waitFor();
        const facts = await tv.page.locator(".watch-party-choice-facts").textContent();
        assert.ok((facts ?? "").startsWith(text("watchParty.episodes.line", "de", { season: "1", episode: "1" })), facts ?? "");
    });
});

test("a series the group is part-way through shows Apple's S and E code in the lobby in German", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create");
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s1").click();
        await view(tv, "watchParty:choice").waitFor();
        assert.ok((await tv.page.locator(".watch-party-choice-facts").textContent() ?? "").startsWith(text("watchParty.episodes.line", "de", { season: "1", episode: "2" })));
        await button(tv, "confirm").click();
        await view(tv, "watchParty:lobby").waitFor();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-facts").textContent() ?? "").includes(text("watchParty.facts.episodeCode", "de", { season: "1", episode: "2" })), "the lobby's episode code");
    });
});

test("an empty season and a failed read use Apple's words in German", async () => {
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create");
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s2").click();
        await view(tv, "watchParty:episodes").waitFor();
        await tv.page.locator(".watch-party-empty-title").waitFor();
        assert.equal(await tv.page.locator(".watch-party-empty-title").textContent(), text("watchParty.episodes.noneTitle", "de"));
        assert.equal(await tv.page.locator(".watch-party-episodes .watch-party-lead").textContent(), text("watchParty.episodes.noneBody", "de"));
        assert.equal(await button(tv, "episodes-retry").textContent(), text("shell.errorView.tryAgain", "de"));
    }, fake => { fake.episodesReply = { status: 200, body: { items: [] } }; });
});

test("Watch Party reads English while German's file is on its way, then German with no new press", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await inLanguage("de", async tv => {
        await openHub(tv);
        assert.equal(await button(tv, "create").textContent(), text("watchParty.page.start", "en"), "English until the file lands");
        assert.equal(await button(tv, "code").getAttribute("placeholder"), text("watchParty.hub.codeField", "en"));
        release();
        await tv.eventually(async () => await button(tv, "create").textContent() === text("watchParty.page.start", "de"), "the hub relabels in German");
        assert.equal(await button(tv, "code").getAttribute("placeholder"), text("watchParty.hub.codeField", "de"), "the retained field relabels too");
        assert.equal(await button(tv, "code").getAttribute("aria-label"), text("watchParty.hub.codeField", "de"));
    }, () => undefined, async page => { await page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); }); });
});

test("the picker's shelf titles read English while German's file is on its way, then German with no new press", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create", "en");
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        assert.deepEqual([...new Set(await tv.page.locator(".watch-party-shelf .browse-section-title").allTextContents())].sort(), [text("watchParty.picker.continueTogether", "en"), text("watchParty.picker.watchlists", "en")].sort());
        release();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-shelf .browse-section-title").allTextContents()).every(title => [text("watchParty.picker.continueTogether", "de"), text("watchParty.picker.watchlists", "de")].includes(title)), "the shelves relabel in German");
    }, () => undefined, async page => { await page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); }); });
});

test("a chosen episode and a raised notice read English while German's file is on its way, then German with no new press", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create", "en");
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s1").click();
        await view(tv, "watchParty:choice").waitFor();
        assert.ok((await tv.page.locator(".watch-party-choice-facts").textContent() ?? "").startsWith("S1 · E2"), "English while the file is held");
        await button(tv, "confirm").click();
        await view(tv, "watchParty:lobby").waitFor();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-facts").textContent() ?? "").includes("S1:E2"), "the staged episode in English");
        release();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-facts").textContent() ?? "").includes(text("watchParty.facts.episodeCode", "de", { season: "1", episode: "2" })), "the lobby relabels in German");
    }, () => undefined, async page => { await page.route("**/tv/catalog/de.js", async route => { await held; await route.fallback(); }); });
    let releaseChoice: () => void = () => undefined;
    const heldChoice = new Promise<void>(resolve => { releaseChoice = resolve; });
    await inLanguage("de", async (tv, fake) => {
        await enterRoom(tv, fake, "create", "en");
        await button(tv, "choose").click();
        await view(tv, "watchParty:picker:shelves").waitFor();
        await button(tv, "series:s1").click();
        await view(tv, "watchParty:choice").waitFor();
        releaseChoice();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-choice-facts").textContent() ?? "").startsWith(text("watchParty.episodes.line", "de", { season: "1", episode: "2" })), "the confirmation page relabels in German");
    }, () => undefined, async page => { await page.route("**/tv/catalog/de.js", async route => { await heldChoice; await route.fallback(); }); });
    let releaseNotice: () => void = () => undefined;
    const heldNotice = new Promise<void>(resolve => { releaseNotice = resolve; });
    await inLanguage("de", async tv => {
        await openHub(tv);
        await tv.page.locator('[data-focus="code"]').fill("https://silo.example.test/rooms/join?token=x");
        await button(tv, "join").click();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-banner-text").allTextContents()).includes(text("watchParty.error.invalidInvitation", "en")), "the notice in English");
        releaseNotice();
        await tv.eventually(async () => (await tv.page.locator(".watch-party-banner-text").allTextContents()).includes(text("watchParty.error.invalidInvitation", "de")), "the notice relabels in German");
    }, () => undefined, async page => { await page.route("**/tv/catalog/de.js", async route => { await heldNotice; await route.fallback(); }); });
});

test("the hub mirrors in Arabic: its text is Arabic and its page follows the layout direction", async () => {
    await inLanguage("ar", async tv => {
        await openHub(tv);
        assert.equal(await button(tv, "create").textContent(), text("watchParty.page.start", "ar"));
        assert.equal(await button(tv, "join").textContent(), text("watchParty.code.joinParty", "ar"));
        assert.equal(flat(await tv.page.locator(".watch-party-title").textContent()), flat(text("watchParty.page.headline", "ar")));
        const layout = await tv.page.evaluate(() => {
            const page = document.querySelector<HTMLElement>(".watch-party")!;
            const intro = document.querySelector<HTMLElement>(".watch-party-intro")!.getBoundingClientRect();
            const actions = document.querySelector<HTMLElement>(".watch-party-actions")!.getBoundingClientRect();
            return { direction: getComputedStyle(page).direction, pinned: page.closest("[dir]")?.getAttribute("dir"), introRight: intro.left > actions.left };
        });
        assert.deepEqual(layout, { direction: "rtl", pinned: "rtl", introRight: true }, "the intro column sits on the right and the actions on the left, as SwiftUI's leading edge does");
    });
});

test("in Arabic a guest's sentence keeps the host's name in its own direction, and Left and Right follow the mirrored row", async () => {
    await inLanguage("ar", async (tv, fake) => {
        await enterRoom(tv, fake, "join", "ar");
        assert.equal(flat(await tv.page.locator(".watch-party-hero-title").textContent()), flat(text("watchParty.hero.waiting", "ar", { host: isolate("Owner") })));
        assert.equal(await tv.page.locator(".watch-party-lead").textContent(), text("watchParty.hero.waitingCaption", "ar", { host: isolate("Owner") }));
        assert.equal(await tv.page.locator(".watch-party-seat-name").first().textContent(), "Owner", "the seat name is the server's text, with no marks added");
        assert.equal(await tv.page.locator(".watch-party-seat-name").first().evaluate(node => getComputedStyle(node).unicodeBidi), "plaintext");
    }, fake => { fake.role = "guest"; });
    await inLanguage("ar", async (tv, fake) => {
        await enterRoom(tv, fake, "create", "ar");
        await stageMovie(tv);
        const rows = await tv.page.evaluate(() => {
            const left = (key: string): number => document.querySelector<HTMLElement>(`[data-focus="${key}"]`)!.getBoundingClientRect().left;
            return { changeRightOfStart: left("change") > left("start") };
        });
        assert.equal(rows.changeRightOfStart, true, "the first button of the row is the rightmost one");
        await button(tv, "start").focus();
        await tv.remote(RIGHT);
        assert.equal(await tv.page.evaluate(() => document.activeElement?.getAttribute("data-focus")), "change", "Right on the remote steps toward the row's start, which is on the right");
    });
});
