import assert from "node:assert/strict";
import { test } from "node:test";
import type { Arrival, Paint, RouteEntry } from "../../src/ui/browseEnv.ts";
import type { FocusTarget } from "../../src/ui/browseFocus.ts";
import type { BrowseSignal } from "../../src/ui/browseSignals.ts";
import { createBrowseStack } from "../../src/ui/browseStack.ts";
import { createPerson } from "../../src/ui/person.ts";
import { createRequests } from "../../src/ui/requestsModule.ts";
import { createSearch } from "../../src/ui/search.ts";
import { settle } from "./support/clock.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { connected, signIn } from "./support/harness.ts";

async function setup(catalog = new FakeRequests()) {
    const h = await connected();
    await signIn(h);
    h.fake.catalog = catalog;
    const owner = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner);
    h.core.profiles.select(owner);
    return { ...h, catalog };
}

function stubRoute(kind: string, options?: { root?: boolean; data?: boolean; admissible?: () => boolean }) {
    const events: string[] = [];
    const signals: { readonly signal: BrowseSignal; readonly visible: boolean }[] = [];
    let staleCount = 0;
    const entry: RouteEntry & {
        readonly events: string[];
        readonly signals: { readonly signal: BrowseSignal; readonly visible: boolean }[];
        readonly staleCount: () => number;
    } = {
        kind,
        ...(options?.root ? { root: true } : {}),
        focus: undefined,
        hasData: () => options?.data ?? true,
        ...(options?.admissible === undefined ? {} : { admissible: options.admissible }),
        arrive(why: Arrival, focus?: FocusTarget) {
            events.push(`arrive:${why}:${focus?.key ?? ""}`);
        },
        cover() {
            events.push("cover");
        },
        retire() {
            events.push("retire");
        },
        markStale() {
            staleCount++;
        },
        onSignal(signal, visible) {
            signals.push({ signal, visible });
        },
        events,
        signals,
        staleCount: () => staleCount,
    };
    return entry;
}

test("BrowseStack orders cover-before-arrive and retire across push, pop, and replaceTop", async () => {
    const h = await setup();
    const trace: string[] = [];
    const tracked = (name: string): RouteEntry => ({
        kind: name,
        focus: undefined,
        hasData: () => true,
        arrive(why) { trace.push(`${name}:arrive:${why}`); },
        cover() { trace.push(`${name}:cover`); },
        retire() { trace.push(`${name}:retire`); },
        markStale() { trace.push(`${name}:stale`); },
    });
    const home = tracked("home");
    const first = tracked("first");
    const second = tracked("second");
    const stack = createBrowseStack({ session: h.core.session, home, clock: h.clock });
    stack.start();
    stack.push(first);
    stack.replaceTop(second);
    stack.pop();
    // Popping down to home is a no-op.
    assert.equal(stack.pop(), undefined);
    assert.deepEqual(trace, [
        "home:arrive:push",
        "home:cover",
        "first:arrive:push",
        "first:cover",
        "first:retire",
        "second:arrive:push",
        "second:cover",
        "second:retire",
        "home:arrive:reveal",
    ]);

    // Popping a retained root does not retire it so selecting that root again still works.
    const tab = tracked("movies");
    stack.setRoot("movies", tab);
    stack.selectRoot(tab);
    stack.pop();
    assert.equal(trace.includes("movies:retire"), false, "popping a retained root must not retire it");
    stack.selectRoot(tab);
    assert.equal(trace.at(-1), "movies:arrive:push");
    stack.dispose();
});

test("BrowseStack publishes signals once per deduplicated route across roots and stack", async () => {
    const h = await setup();
    const home = stubRoute("home", { root: true });
    const movies = stubRoute("library", { root: true });
    const detail = stubRoute("item");
    const stack = createBrowseStack({ session: h.core.session, home, clock: h.clock });
    stack.setRoot("movies", movies);
    stack.start();
    stack.selectRoot(movies);
    stack.push(detail);

    // home and movies are in BOTH roots and stack, yet each receives the signal once.
    stack.publish({ kind: "catalog.changed" });
    assert.equal(home.signals.length, 1);
    assert.equal(home.signals[0]?.visible, false);
    assert.equal(movies.signals.length, 1);
    assert.equal(movies.signals[0]?.visible, false);
    assert.equal(detail.signals.length, 1);
    assert.equal(detail.signals[0]?.visible, true);

    // playback.resumed skips roots not currently in stack.
    const calendar = stubRoute("calendar", { root: true });
    stack.setRoot("calendar", calendar);
    stack.publish({ kind: "playback.resumed" });
    assert.equal(calendar.signals.length, 0);
    assert.equal(detail.signals.length, 2);
    stack.dispose();
});

test("Requests capability loss closes consecutive Requests pages on top, preserves Search above it, and clears Search Requests supplement without cross-imports", async () => {
    const h = await setup();
    const home = stubRoute("home", { root: true, data: true });
    const arrivals: { readonly kind: string; readonly paint: Paint }[] = [];
    const stack = createBrowseStack({
        session: h.core.session,
        home,
        clock: h.clock,
        onArrive: (entry, paint) => arrivals.push({ kind: entry.kind, paint }),
    });
    const requests = createRequests({
        session: h.core.session,
        clock: h.clock,
        foreground: stack.foreground,
        onCapabilityChange: (cap, { refreshSearch }) => {
            stack.publish({ kind: "requests.capability", enabled: cap.enabled, refreshSearch });
            if (!cap.enabled) {
                stack.deleteRoot("requests");
                stack.closeInadmissible();
            }
        },
        onStale: () => stack.publish({ kind: "requests.changed" }),
    });
    const search = createSearch({
        session: h.core.session,
        clock: h.clock,
        foreground: stack.foreground,
        audiobooksEnabled: () => false,
        requestsEnabled: () => requests.capability.enabled,
    });

    await requests.probe();
    assert.equal(requests.capability.enabled, true);

    // Case 1: Requests hub + detail on top -> capability loss closes both and focuses home content.
    const hub = requests.open({ kind: "hub" });
    const detail = requests.open({ kind: "request", id: h.catalog.record.id });
    stack.start();
    stack.push(hub);
    stack.push(detail);
    await settle();

    h.catalog.enabled = false;
    await requests.probe();
    assert.equal(stack.top(), home);
    assert.equal(arrivals.at(-1)?.kind, "home");
    assert.equal(arrivals.at(-1)?.paint.enter, true, "closing the root hub enters origin content");

    // Case 2: Search sitting ABOVE Requests hub -> capability loss clears Search's Requests supplement, keeps Search open, and closes hub on Back.
    h.catalog.enabled = true;
    await requests.probe();
    const hub2 = requests.open({ kind: "hub" });
    stack.push(hub2);
    stack.push(search);
    search.setQuery("Heat");
    await h.clock.advance(300);
    await settle();
    assert.ok((search.snapshot().requests?.length ?? 0) > 0, "Search loaded Requests supplement while enabled");

    h.catalog.enabled = false;
    await requests.probe();
    assert.equal(stack.top(), search, "Search above Requests hub stays open");
    assert.deepEqual(search.snapshot().requests, [], "Search cleared Requests supplement via BrowseSignal");

    // Popping Search exposes inadmissible hub2 -> BrowseStack automatically closes hub2 and lands on home.
    stack.pop();
    assert.equal(stack.top(), home);
    assert.equal(arrivals.at(-1)?.paint.enter, true);

    requests.dispose();
    stack.dispose();
});

test("clearPersonalRoot truncates to the underlying tab so personal roots replace each other", async () => {
    const h = await setup();
    const home = stubRoute("home", { root: true });
    const movies = stubRoute("library", { root: true });
    const watchlist = stubRoute("personal", { root: true });
    const item = stubRoute("item");
    const requestsHub = stubRoute("requests", { root: true });
    const stack = createBrowseStack({ session: h.core.session, home, clock: h.clock });
    stack.setRoot("movies", movies);
    stack.start();
    stack.selectRoot(movies);
    stack.push(watchlist);
    stack.push(item);
    assert.equal(stack.entries().length, 4);

    // clearPersonalRoot pops from the first personal root at index >= 1 (movies is index 1 and is retained, so it stays untouched).
    // Give movies root: false for personal-root distinction via custom adapter, or test with requestsHub over home.
    const stack2 = createBrowseStack({
        session: h.core.session,
        home,
        clock: h.clock,
        adapter: {
            hasData: entry => entry.hasData(),
            isRoot: entry => entry.root === true,
            isPersonalRoot: entry => entry.kind === "personal" || entry.kind === "requests",
            isProfileMenu: entry => entry.kind === "personal" || entry.kind === "requests",
            tabFocus: () => ({ zone: "nav", key: "movies" }),
            cover: entry => entry.cover(),
            retire: entry => entry.retire(),
            arrive: (entry, why, focus) => entry.arrive(why, focus),
        },
    });
    stack2.setRoot("movies", movies);
    stack2.start();
    stack2.selectRoot(movies);
    stack2.push(watchlist);
    stack2.push(item);
    assert.equal(stack2.clearPersonalRoot(), true);
    assert.deepEqual(stack2.entries(), [home, movies]);
    assert.ok(watchlist.events.includes("retire"));
    assert.ok(item.events.includes("retire"));
    stack2.push(requestsHub);
    stack2.pop();
    assert.equal(stack2.top(), movies);
    assert.equal(movies.events.at(-1), "arrive:reveal:movies", "fromProfileMenu restores tab focus");

    stack.dispose();
    stack2.dispose();
});

test("Authority change tears down BrowseStack, aborts foreground reads, retires Person/Search/Requests, and ignores later calls", async () => {
    const h = await setup();
    const home = stubRoute("home", { root: true });
    let disposedCallback = 0;
    const stack = createBrowseStack({
        session: h.core.session,
        home,
        clock: h.clock,
        onDispose: () => { disposedCallback++; },
    });
    const person = createPerson({ id: "7", title: "River Vale", session: h.core.session, clock: h.clock, foreground: stack.foreground });
    const heldPerson = h.fake.hold("/catalog/people/7", true);
    const heldQuery = h.fake.hold("/catalog/query", true);
    stack.start();
    stack.push(person);
    await settle();
    assert.equal(stack.foreground.busy(), true);

    // Switching profile changes Authority and triggers teardown.
    const other = (await h.core.profiles.list()).find(profile => profile.id !== "p-owner");
    assert.ok(other);
    h.core.profiles.select(other);

    assert.equal(stack.disposed, true);
    assert.equal(disposedCallback, 1);
    assert.equal(stack.foreground.busy(), false);
    assert.equal(stack.top(), undefined);
    assert.ok(home.events.includes("retire"));

    // Late answers after Authority teardown and subsequent push/pop/publish are ignored.
    heldPerson.release();
    heldQuery.release();
    await settle();
    assert.equal(person.snapshot().person, undefined);
    stack.push(stubRoute("late"));
    assert.equal(stack.top(), undefined);
    stack.dispose();
    assert.equal(disposedCallback, 1, "dispose is idempotent");
});
