import assert from "node:assert/strict";
import { test } from "node:test";
import { detailOperations } from "../../src/api/detailOperations.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";
import type { Paint } from "../../src/ui/browseEnv.ts";
import type { FocusTarget } from "../../src/ui/browseFocus.ts";
import { createPerson } from "../../src/ui/person.ts";
import { ManualClock, settle } from "./support/clock.ts";
import { FakeDetails } from "./support/fakeDetails.ts";
import { FakeSilo, problem, type Reply } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

async function setup(catalog = new FakeDetails()) {
    const h = await connected();
    await signIn(h);
    h.fake.catalog = catalog;
    const owner = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner);
    h.core.profiles.select(owner);
    return { ...h, catalog };
}

function populateMany(catalog: FakeDetails, extra = 65): FakeDetails {
    for (const title of catalog.titles.values()) {
        if (title.type === "movie") catalog.add({ ...title, year: 2030 });
    }
    for (let i = 0; i < extra; i++) {
        const id = `movie:extra${i}`;
        catalog.add({ id, title: `Extra ${i}`, type: "movie", libraryId: "12", year: 2029 });
        catalog.personCredits.get("7")?.push(id);
    }
    return catalog;
}

function withPersonRoutes(
    catalog: FakeDetails,
    handlers: {
        person?: () => Reply;
        refresh?: () => Reply;
    },
): { dispatches: () => number; personReads: () => number } {
    const base = catalog.route.bind(catalog);
    let dispatches = 0;
    let personReads = 0;
    catalog.route = (method, path, profileId, body) => {
        if (method === "POST" && path === "/catalog/people/7/refresh") {
            dispatches++;
            return handlers.refresh ? handlers.refresh() : { status: 202, body: { status: "queued", person_id: "7" } };
        }
        if (method === "GET" && path === "/catalog/people/7") {
            personReads++;
            return handlers.person ? handlers.person() : base(method, path, profileId, body);
        }
        return base(method, path, profileId, body);
    };
    return { dispatches: () => dispatches, personReads: () => personReads };
}

test("Person refresh receipt and reads validate person identity; dispatch never replays", () => {
    const spec = detailOperations.refreshPerson("person/+7");
    assert.equal(spec.path, "/catalog/people/person%2F%2B7/refresh");
    assert.equal(spec.method, "POST");
    assert.equal(spec.retry, "never");
    assert.equal(spec.decode({ status: "queued", person_id: "person/+7" }), undefined);
    for (const receipt of [{ status: "queued", person_id: "8" }, { status: "done", person_id: "person/+7" }, {}]) {
        assert.throws(() => spec.decode(receipt), WireError);
    }
    assert.throws(() => detailOperations.person("7").decode({ id: "8", name: "Other" }), WireError);
});

test("incomplete Person dispatches once, polls after 3 s, settles after 5 unchanged reads, and does not restart on reveal", async () => {
    const h = await setup();
    const counts = withPersonRoutes(h.catalog, {
        person: () => ({ status: 200, body: { id: "7", name: "River Vale", bio: "  " } }),
    });
    const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
    person.arrive("push");
    await settle();
    assert.equal(counts.personReads(), 1);
    assert.equal(counts.dispatches(), 1);
    assert.equal(person.snapshot().heroLoading, true);

    await h.clock.advance(2999);
    assert.equal(counts.personReads(), 1);
    await h.clock.advance(1);
    assert.equal(counts.personReads(), 2);

    await h.clock.advance(12_000);
    assert.equal(counts.personReads(), 6, "initial read + 5 unchanged polls");
    assert.equal(person.snapshot().heroLoading, false);

    // Exhausted visit never restarts refresh on Back reveal.
    person.cover();
    person.arrive("reveal");
    await h.clock.advance(120_000);
    assert.equal(counts.dispatches(), 1);
    assert.equal(counts.personReads(), 6);
    person.retire();
});

test("complete Person metadata does not dispatch refresh or poll", async () => {
    const h = await setup();
    const counts = withPersonRoutes(h.catalog, {});
    const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
    person.arrive("push");
    await settle();
    await h.clock.advance(120_000);
    assert.equal(counts.dispatches(), 0);
    assert.equal(counts.personReads(), 1);
    assert.equal(person.snapshot().heroLoading, false);
    person.retire();
});

test("changed metadata resets settled count and complete metadata stops polling", async () => {
    const h = await setup();
    let body: Record<string, unknown> = { id: "7", name: "River Vale", bio: "  " };
    const counts = withPersonRoutes(h.catalog, {
        person: () => ({ status: 200, body }),
    });
    const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
    person.arrive("push");
    await settle();
    await h.clock.advance(12_000);
    assert.equal(person.snapshot().heroLoading, true);

    body = { id: "7", name: "River Vale", bio: "  ", imdb_id: "nm12345" };
    await h.clock.advance(3000);
    await h.clock.advance(12_000);
    assert.equal(person.snapshot().heroLoading, true, "changed metadata reset the 5-poll counter");

    body = { id: "7", name: "River Vale", bio: "Complete bio", photo_url: "/art/river.svg", birth_date: "1980-04-12" };
    await h.clock.advance(3000);
    assert.equal(person.snapshot().person?.bio, "Complete bio");
    assert.equal(person.snapshot().heroLoading, false);
    const readsAtComplete = counts.personReads();
    await h.clock.advance(120_000);
    assert.equal(counts.personReads(), readsAtComplete);
    person.retire();
});

for (const status of [400, 401, 403, 404, 422, 429, 500, 502, 503]) {
    test(`Person rejected refresh dispatch ${status} follows Apple's polling policy`, async () => {
        const h = await setup();
        const counts = withPersonRoutes(h.catalog, {
            person: () => ({ status: 200, body: { id: "7", name: "River Vale" } }),
            refresh: () => ({ status, body: { detail: "err" } }),
        });
        const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
        person.arrive("push");
        await settle();
        await h.clock.advance(3000);
        assert.equal(counts.dispatches(), 1);
        assert.equal(counts.personReads(), [429, 500, 502].includes(status) ? 2 : 1);
        person.retire();
    });
}

test("Person ambiguous network and invalid_response refresh dispatch polls without repeating POST", async () => {
    for (const mode of ["network", "invalid_response"] as const) {
        const h = await setup();
        const counts = withPersonRoutes(h.catalog, {
            person: () => ({ status: 200, body: { id: "7", name: "River Vale" } }),
            refresh: () => mode === "invalid_response" ? { status: 202, body: { unexpected: true } } : { status: 202, body: { status: "queued", person_id: "7" } },
        });
        if (mode === "network") h.fake.dropNextAnswer("/catalog/people/7/refresh");
        const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
        person.arrive("push");
        await settle();
        await h.clock.advance(3000);
        assert.equal(counts.personReads(), 2, `${mode} still polls`);
        assert.equal(h.fake.requests.filter(req => req.path === "/catalog/people/7/refresh").length, 1, `${mode} never repeats POST`);
        person.retire();
    }
});

test("failed polls stop at 120 s; cover cancels and reveal resumes polling without re-dispatch or reloading filmography", async () => {
    const h = await setup();
    let failPolls = false;
    const counts = withPersonRoutes(h.catalog, {
        person: () => failPolls ? problem(500, "internal_error", "Poll error") : { status: 200, body: { id: "7", name: "River Vale" } },
    });
    const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
    person.arrive("push");
    await settle();
    failPolls = true;
    await h.clock.advance(120_000);
    assert.equal(counts.personReads(), 41, "1 initial + 40 polls over 120 s");
    assert.equal(person.snapshot().heroLoading, false);
    person.cover();
    person.arrive("reveal");
    await h.clock.advance(3000);
    assert.equal(counts.personReads(), 41);
    person.retire();

    // Cover mid-poll and reveal back resumes without re-dispatching POST or reloading credits.
    const h2 = await setup();
    const counts2 = withPersonRoutes(h2.catalog, {
        person: () => ({ status: 200, body: { id: "7", name: "River Vale" } }),
    });
    const visit = createPerson({ id: "7", title: "River Vale", session: h2.core.session, clock: h2.clock });
    visit.arrive("push");
    await settle();
    const creditsBefore = h2.fake.requests.filter(req => req.path.startsWith("/catalog/query") && req.body?.limit !== 1).length;
    await h2.clock.advance(3000);
    assert.equal(counts2.personReads(), 2);

    visit.cover();
    await h2.clock.advance(9000);
    assert.equal(counts2.personReads(), 2);
    assert.equal(visit.snapshot().heroLoading, false);

    visit.arrive("reveal");
    await h2.clock.advance(3000);
    assert.equal(counts2.dispatches(), 1);
    assert.equal(counts2.personReads(), 3);
    const creditsAfter = h2.fake.requests.filter(req => req.path.startsWith("/catalog/query") && req.body?.limit !== 1).length;
    assert.equal(creditsAfter, creditsBefore, "reveal keeps loaded filmography without rereading credits");
    visit.retire();
});

test("late metadata answer after cover/retire cannot update state or emit onChange", async () => {
    const h = await setup();
    const held = h.fake.hold("/catalog/people/7", true);
    let changes = 0;
    const person = createPerson({
        id: "7",
        title: "River Vale",
        session: h.core.session,
        clock: h.clock,
        onChange: () => { changes++; },
    });
    person.arrive("push");
    await settle();
    const beforeCover = changes;
    person.cover();
    held.release();
    await settle();
    assert.equal(changes, beforeCover);
    assert.equal(person.snapshot().person, undefined);
    person.retire();
});

test("Person filmography paginates, recovers once from invalid_cursor, and retains cards on failed or cyclic append", async () => {
    const catalog = populateMany(new FakeDetails(), 65);
    const h = await setup(catalog);
    const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
    person.arrive("push");
    await settle();
    assert.equal(person.snapshot().page?.items.length, 60);
    assert.ok(person.snapshot().page?.nextCursor);

    // Failed append keeps cards and clears failure.
    catalog.personReplies.push(problem(500, "internal_error", "Transient"));
    person.loadMore();
    await settle();
    assert.equal(person.snapshot().page?.items.length, 60);
    assert.equal(person.snapshot().failure, undefined);

    // Next append succeeds.
    person.loadMore();
    await settle();
    assert.ok((person.snapshot().page?.items.length ?? 0) > 60);

    // Cyclic nextCursor on append is rejected without wiping cards.
    const previousCursor = h.fake.requests.filter(r => r.path.startsWith("/catalog/query") && r.body?.limit !== 1).at(-1)?.body?.cursor;
    assert.equal(typeof previousCursor, "string");
    catalog.personReplies.push({ status: 200, body: { items: [], total: 130, total_exact: true, window_cursor: "syn", page: { has_more: true, next_cursor: previousCursor } } });
    const countBeforeCyclic = person.snapshot().page?.items.length ?? 0;
    person.loadMore();
    await settle();
    assert.equal(person.snapshot().page?.items.length, countBeforeCyclic);
    assert.equal(person.snapshot().failure, undefined);

    // invalid_cursor on append restarts once from page 0 without reloading metadata, rotating feedKey.
    const metadataBefore = h.fake.requests.filter(r => r.path === "/catalog/people/7").length;
    const feedKeyBefore = person.snapshot().feedKey;
    catalog.personReplies.push(problem(400, "invalid_cursor", "Expired"));
    person.loadMore();
    await settle();
    assert.equal(person.snapshot().page?.items.length, 60);
    assert.notEqual(person.snapshot().feedKey, feedKeyBefore, "invalid_cursor recovery rotates feedKey");
    assert.equal(h.fake.requests.filter(r => r.path === "/catalog/people/7").length, metadataBefore);
    person.retire();
});

test("selecting a filter while availability probes are in flight keeps that chip and drops late probes", async () => {
    const clock = new ManualClock();
    const fake = new FakeSilo(clock);
    const catalog = new FakeDetails();
    catalog.personCredits.set("7", ["movie:m0001"]);
    fake.catalog = catalog;

    // Hold limit=1 availability probes before connect() binds fake.fetch.
    const baseFetch = fake.fetch;
    let releaseProbes = (): void => undefined;
    const hold = new Promise<void>(resolve => { releaseProbes = resolve; });
    (fake as { fetch: typeof fake.fetch }).fetch = async (url, init) => {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { source?: string; limit?: number } : undefined;
        if (body?.source === "person" && body.limit === 1) await hold;
        return baseFetch(url, init);
    };

    const h = await connected({ clock, fake });
    await signIn(h);
    const owner = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner);
    h.core.profiles.select(owner);

    const paints: (Paint | undefined)[] = [];
    const person = createPerson({
        id: "7",
        title: "River Vale",
        session: h.core.session,
        clock: h.clock,
        onChange: paint => paints.push(paint),
    });
    person.arrive("push");
    await settle();
    assert.equal(person.snapshot().page?.items.length, 1);
    assert.deepEqual(person.snapshot().availableFilters, ["video", "movie", "series"]);

    person.setFilter("series");
    await settle();
    assert.equal(person.snapshot().filter, "series");
    assert.equal(person.snapshot().page?.items.length, 0);
    assert.deepEqual(paints.find(p => p?.focus?.key === "filter:series")?.focus, { zone: "filters", key: "filter:series" });

    releaseProbes();
    await settle();
    assert.deepEqual(person.snapshot().availableFilters, ["video", "movie", "series"], "late availability probes after filter change are dropped");
    person.retire();
});

test("stale multi-page refresh preserves loaded depth and selects nearby grid card when focused item disappears", async () => {
    const catalog = populateMany(new FakeDetails(), 65);
    const h = await setup(catalog);
    let currentFocus: FocusTarget | undefined;
    const paints: (Paint | undefined)[] = [];
    const person = createPerson({
        id: "7",
        title: "River Vale",
        session: h.core.session,
        clock: h.clock,
        focus: { inputRevision: () => 0, focused: () => currentFocus },
        onChange: paint => {
            paints.push(paint);
            if (paint?.focus !== undefined) currentFocus = paint.focus;
        },
    });
    person.arrive("push");
    await settle();
    person.loadMore();
    await settle();
    const items = person.snapshot().page?.items ?? [];
    assert.ok(items.length > 60);
    const removed = items[5]!;
    const expectedNearby = items[6]!;
    currentFocus = { zone: "grid", key: removed.id };

    catalog.removed.add(removed.id);
    person.markStale();
    person.arrive("reshow");
    await settle();

    assert.deepEqual(currentFocus, { zone: "grid", key: expectedNearby.id });
    assert.ok((person.snapshot().page?.items.length ?? 0) > 60, "multi-page depth preserved on stale refresh");
    person.retire();
});

test("retry clears metadataFailure and reloads both metadata and filmography", async () => {
    const h = await setup();
    let fail = true;
    withPersonRoutes(h.catalog, {
        person: () => fail ? problem(500, "internal_error", "Down") : { status: 200, body: { id: "7", name: "River Vale", bio: "Bio", photo_url: "/art/river.svg", birth_date: "1980-04-12" } },
    });
    const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock });
    person.arrive("push");
    await settle();
    assert.ok(person.snapshot().metadataFailure);

    fail = false;
    person.retry();
    await settle();
    assert.equal(person.snapshot().metadataFailure, undefined);
    assert.equal(person.snapshot().person?.bio, "Bio");
    person.retire();
});
