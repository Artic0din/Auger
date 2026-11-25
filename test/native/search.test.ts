import assert from "node:assert/strict";
import { test } from "node:test";
import type { Paint } from "../../src/ui/browseEnv.ts";
import type { FocusTarget } from "../../src/ui/browseFocus.ts";
import { createSearch, SEARCH_DELAY_MS } from "../../src/ui/search.ts";
import { settle } from "./support/clock.ts";
import { FakeCatalog } from "./support/fakeCatalog.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { fixture, problem, type Reply } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

class FakeSearchCatalog extends FakeCatalog {
    readonly requests = new FakeRequests();
    readonly capabilitiesReply: Record<string, unknown> = {
        ...fixture("get_catalog_search_capabilities_ok"),
        video_with_episodes_scope: true,
        people_media_scope: true,
        box_sets: true,
    };
    peopleItems: Record<string, unknown>[] = [{ id: "7", name: "River Vale" }];
    peopleFails = false;
    boxSetItems: Record<string, unknown>[] = [{
        id: "bs-1",
        library_id: "12",
        title: "Heat Trilogy",
        movie_count: 3,
        played_count: 1,
    }];
    boxSetsFails = false;
    readonly itemReplies: Reply[] = [];
    requestsReply: Reply | undefined;

    override route(method: string, path: string, profileId: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        const url = new URL(path, "https://example.test");
        if (method === "GET" && url.pathname === "/catalog/search/capabilities") {
            return { status: 200, body: this.capabilitiesReply };
        }
        if (method === "GET" && url.pathname === "/catalog/people") {
            return this.peopleFails ? problem(500, "internal_error", "People failed") : { status: 200, body: { items: this.peopleItems } };
        }
        if (method === "GET" && url.pathname === "/catalog/box-sets") {
            return this.boxSetsFails ? problem(500, "internal_error", "Box sets failed") : { status: 200, body: { items: this.boxSetItems } };
        }
        if (url.pathname.startsWith("/requests")) {
            if (this.requestsReply !== undefined) return this.requestsReply;
            return this.requests.route(method, path, profileId, body);
        }
        if (method === "GET" && url.pathname === "/catalog" && url.searchParams.has("q")) {
            const scripted = this.itemReplies.shift();
            if (scripted !== undefined) return scripted;
        }
        return super.route(method, path, profileId, body);
    }
}

async function setup(catalog = new FakeSearchCatalog()) {
    const h = await connected();
    await signIn(h);
    h.fake.catalog = catalog;
    const owner = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner);
    h.core.profiles.select(owner);
    return { ...h, catalog };
}

test("Search debounces input by 300 ms, aborts obsolete reads immediately, and clears on blank query", async () => {
    const h = await setup();
    let boxSetsCap: boolean | undefined;
    const search = createSearch({
        session: h.core.session,
        clock: h.clock,
        audiobooksEnabled: () => false,
        requestsEnabled: () => true,
        onBoxSetsCapability: supported => { boxSetsCap = supported; },
    });
    search.arrive("push");
    assert.equal(search.snapshot().status, "idle");

    search.setQuery("H");
    await h.clock.advance(SEARCH_DELAY_MS - 1);
    assert.equal(h.fake.requests.filter(r => r.path.startsWith("/catalog?")).length, 0);
    assert.deepEqual(search.snapshot().requests, [], "1-char query clears Request matches immediately");

    search.setQuery("Heat");
    await h.clock.advance(SEARCH_DELAY_MS);
    await settle();
    const s = search.snapshot();
    assert.equal(s.status, "ready");
    assert.equal(s.resultsFor, "Heat");
    assert.equal(boxSetsCap, true);
    assert.equal(s.people.length, 1);
    assert.equal(s.boxSets.length, 1);
    assert.equal(s.requests?.length, 1);

    search.setQuery("   ");
    const cleared = search.snapshot();
    assert.equal(cleared.status, "idle");
    assert.equal(cleared.page, undefined);
    assert.equal(cleared.people.length, 0);
    assert.equal(cleared.boxSets.length, 0);
    assert.equal(cleared.requests, undefined);
    search.retire();
});

test("Search Done submit moves focus to selected filter chip and box sets only query All or Movies", async () => {
    const h = await setup();
    const paints: (Paint | undefined)[] = [];
    const search = createSearch({
        session: h.core.session,
        clock: h.clock,
        audiobooksEnabled: () => false,
        requestsEnabled: () => false,
        onChange: paint => paints.push(paint),
    });
    search.arrive("push");
    search.submit("Heat", true);
    await settle();
    assert.deepEqual(paints.find(p => p?.focus?.zone === "search-filters")?.focus, { zone: "search-filters", key: "search-filter:all" });
    assert.equal(search.snapshot().boxSets.length, 1);

    search.setFilter("series");
    await settle();
    assert.equal(search.snapshot().filter, "series");
    assert.deepEqual(search.snapshot().boxSets, [], "Series filter suppresses box sets");
    const boxSetQueries = h.fake.requests.filter(r => r.path.startsWith("/catalog/box-sets"));
    assert.equal(boxSetQueries.length, 1, "no box-set query sent for series filter");
    search.retire();
});

test("Search loadMore skips duplicate-only pages, restarts once on invalid_cursor, then fails on a second rejection", async () => {
    const h = await setup();
    const card = (id: string, title: string) => ({ content_id: id, type: "movie", title, year: 2024 });
    h.catalog.itemReplies.push(
        { status: 200, body: { items: [card("movie:1", "One")], total: 3, total_exact: true, page: { has_more: true, next_cursor: "c1" } } },
        // Duplicate-only page should be skipped transparently to c2.
        { status: 200, body: { items: [card("movie:1", "One")], total: 3, total_exact: true, page: { has_more: true, next_cursor: "c2" } } },
        { status: 200, body: { items: [card("movie:2", "Two")], total: 3, total_exact: true, page: { has_more: true, next_cursor: "c3" } } },
        // First invalid_cursor triggers one restart from page 0.
        problem(400, "invalid_cursor", "Expired"),
        { status: 200, body: { items: [card("movie:10", "Fresh")], total: 2, total_exact: true, page: { has_more: true, next_cursor: "fresh-c1" } } },
        // Second invalid_cursor after restart surfaces error instead of looping.
        problem(400, "invalid_cursor", "Expired again"),
    );

    const search = createSearch({
        session: h.core.session,
        clock: h.clock,
        audiobooksEnabled: () => false,
        requestsEnabled: () => false,
    });
    search.arrive("push");
    search.submit("One", false);
    await settle();
    const firstKey = search.snapshot().feedKey;
    assert.deepEqual(search.snapshot().page?.items.map(i => i.id), ["movie:1"]);

    search.loadMore();
    await settle();
    assert.equal(search.snapshot().feedKey, firstKey, "append keeps feedKey stable");
    assert.deepEqual(search.snapshot().page?.items.map(i => i.id), ["movie:1", "movie:2"]);

    search.loadMore();
    await settle();
    assert.notEqual(search.snapshot().feedKey, firstKey, "restart rotates feedKey");
    assert.deepEqual(search.snapshot().page?.items.map(i => i.id), ["movie:10"]);
    assert.equal(search.snapshot().failure, undefined);

    search.loadMore();
    await settle();
    assert.ok(search.snapshot().failure, "second invalid_cursor surfaces error");
    search.retire();
});

test("Search failed new search clears titles, people, and box sets; People failure recovers via retryPeople", async () => {
    const h = await setup();
    const search = createSearch({
        session: h.core.session,
        clock: h.clock,
        audiobooksEnabled: () => false,
        requestsEnabled: () => false,
    });
    search.arrive("push");
    h.catalog.peopleFails = true;
    search.submit("Heat", false);
    await settle();
    assert.equal(search.snapshot().peopleFailure, true);
    assert.deepEqual(search.snapshot().people, []);

    h.catalog.peopleFails = false;
    search.retryPeople();
    await settle();
    assert.equal(search.snapshot().peopleFailure, false);
    assert.equal(search.snapshot().people.length, 1);

    h.catalog.itemReplies.push(problem(500, "internal_error", "Boom"));
    search.submit("Crash", false);
    await settle();
    const failed = search.snapshot();
    assert.equal(failed.status, "failed");
    assert.equal(failed.page, undefined);
    assert.deepEqual(failed.people, []);
    assert.deepEqual(failed.boxSets, []);
    search.retire();
});

test("Search Request supplement notifies refusal callback, responds to invalidation, and restores search-requests return focus", async () => {
    const h = await setup();
    let refused = 0;
    const paints: (Paint | undefined)[] = [];
    let currentFocus: FocusTarget | undefined;
    const search = createSearch({
        session: h.core.session,
        clock: h.clock,
        focus: { inputRevision: () => 0, focused: () => currentFocus },
        audiobooksEnabled: () => false,
        requestsEnabled: () => true,
        onRequestsRefused: () => { refused++; },
        onChange: paint => {
            paints.push(paint);
            if (paint?.focus !== undefined) currentFocus = paint.focus;
        },
    });
    search.arrive("push");
    search.submit("Heat", false);
    await settle();
    assert.equal(search.snapshot().requests?.length, 1);
    const key = `${search.snapshot().requests![0]!.mediaType}:${search.snapshot().requests![0]!.tmdbId}`;

    // Simulate pushing into a Request card, mutating (invalidating covered Search), and popping back.
    search.cover();
    search.onSignal?.({ kind: "requests.changed" }, false);
    assert.equal(search.snapshot().requests, undefined);

    search.arrive("reveal", { zone: "search-requests", key });
    await settle();
    assert.deepEqual(currentFocus, { zone: "search-requests", key }, "return focus restored once Requests rail lands");

    // Capability refusal triggers callback without importing Requests.
    h.catalog.requestsReply = problem(403, "capability_disabled", "Disabled");
    search.onSignal?.({ kind: "requests.changed" }, true);
    await settle();
    assert.equal(refused, 1);
    assert.deepEqual(search.snapshot().requests, []);

    // requests.capability(enabled: false) clears immediately on capability loss.
    search.onSignal?.({ kind: "requests.capability", enabled: false, refreshSearch: false }, true);
    assert.deepEqual(search.snapshot().requests, []);
    search.retire();
});
