import assert from "node:assert/strict";
import { test } from "node:test";
import { requestOperations } from "../../src/api/requestOperations.ts";
import { decodeMediaRequest, decodeRequestsCapability, type MediaRequest, type RequestsCapability } from "../../src/contracts/v2/requests.ts";
import type { Paint } from "../../src/ui/browseEnv.ts";
import type { FocusTarget } from "../../src/ui/browseFocus.ts";
import { createRequests, REQUEST_NOTICE_MS, type RequestPage } from "../../src/ui/requestsModule.ts";
import { settle } from "./support/clock.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { fixture, problem, type Reply } from "./support/fakeSilo.ts";
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

function makeRecord(id: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        media_type: "movie",
        tmdb_id: 949,
        title: `Title ${id}`,
        overview: "Overview",
        requested_by_profile_id: "p-owner",
        state: "failed",
        status: "approved",
        outcome: "failed",
        ...patch,
    };
}

test("remove_failed_supported is optional and only counts while requests are available", () => {
    assert.equal(decodeRequestsCapability(fixture("request_status_ok")).removeFailed, true);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: true, state: "available", follow_supported: true }).removeFailed, false);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: false, state: "available", follow_supported: true, remove_failed_supported: true }).removeFailed, false);
    assert.equal(decodeRequestsCapability({ requests_enabled: true, allowed: true, state: "disabled", follow_supported: true, remove_failed_supported: true }).removeFailed, false);
    assert.throws(() => decodeRequestsCapability({ requests_enabled: true, allowed: true, state: "available", follow_supported: true, remove_failed_supported: "true" }));
});

test("DELETE /requests/{id} percent-encodes the id and is never retried", () => {
    const spec = requestOperations.remove("a/b?c");
    assert.equal(spec.method, "DELETE");
    assert.equal(spec.path, "/requests/a%2Fb%3Fc");
    assert.equal(spec.retry, "never");
    assert.equal(spec.decode(undefined), undefined);
});

test("rowActions enforces pending-only cancel, failed-without-completed-target remove, removeFailed capability, and active/held locks", async () => {
    const h = await setup();
    const mod = createRequests({ session: h.core.session, clock: h.clock });
    await mod.probe();
    const page = mod.open({ kind: "hub" });

    const failedPlain = decodeMediaRequest(makeRecord("failed-plain"));
    const failedEmptyTargets = decodeMediaRequest(makeRecord("failed-empty", { targets: [] }));
    const failedOnlyFailed = decodeMediaRequest(makeRecord("failed-only", { targets: [{ quality: "1080p", status: "failed" }] }));
    const failedDelivered = decodeMediaRequest(makeRecord("failed-delivered", { targets: [{ quality: "1080p", status: "completed" }, { quality: "2160p", status: "failed" }] }));
    const pending = decodeMediaRequest(makeRecord("pending", { state: "pending", status: "pending", outcome: "active" }));
    const declined = decodeMediaRequest(makeRecord("declined", { state: "declined", status: "approved", outcome: "declined" }));
    const cancelled = decodeMediaRequest(makeRecord("cancelled", { state: "cancelled", status: "approved", outcome: "cancelled" }));

    assert.deepEqual(page.rowActions(failedPlain), { cancel: false, remove: true });
    assert.deepEqual(page.rowActions(failedEmptyTargets), { cancel: false, remove: true });
    assert.deepEqual(page.rowActions(failedOnlyFailed), { cancel: false, remove: true });
    assert.deepEqual(page.rowActions(failedDelivered), { cancel: false, remove: false });
    assert.deepEqual(page.rowActions(pending), { cancel: true, remove: false });
    assert.deepEqual(page.rowActions(declined), { cancel: false, remove: false });
    assert.deepEqual(page.rowActions(cancelled), { cancel: false, remove: false });

    // Without remove_failed_supported, failed requests cannot be removed.
    h.catalog.removeFailed = false;
    await mod.probe();
    assert.deepEqual(page.rowActions(failedPlain), { cancel: false, remove: false });
    assert.deepEqual(page.rowActions(pending), { cancel: true, remove: false });
    mod.dispose();
});

test("hub loads discover and multi-page mine together, rejects cyclic cursors, and prioritizes refusal over non-refusal", async () => {
    const h = await setup();
    const pages: Record<string, Reply> = {
        "": { status: 200, body: { items: [makeRecord("r1", { state: "pending", status: "pending", outcome: "active" })], page: { has_more: true, next_cursor: "c2" } } },
        "c2": { status: 200, body: { items: [makeRecord("r2", { state: "pending", status: "pending", outcome: "active" })], page: { has_more: false } } },
    };
    const base = h.catalog.route.bind(h.catalog);
    h.catalog.route = (method, path, profileId, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/requests/mine") return pages[url.searchParams.get("cursor") ?? ""]!;
        return base(method, path, profileId, body);
    };

    const mod = createRequests({ session: h.core.session, clock: h.clock });
    const hub = mod.open({ kind: "hub" });
    hub.arrive("push");
    await settle();
    assert.deepEqual(hub.snapshot().visibleMine.map(item => item.id), ["r1", "r2"]);

    // Cyclic cursor fails the hub load cleanly as invalid_response without scheduling an uncaught throw.
    pages["c2"] = { status: 200, body: { items: [], page: { has_more: true, next_cursor: "c2" } } };
    hub.retry();
    await settle();
    await h.clock.advance(10);
    assert.ok(hub.snapshot().failure);

    // Refusal on mine triggers capability probe even if discover fails with 500.
    const capEvents: RequestsCapability[] = [];
    const mod2 = createRequests({
        session: h.core.session,
        clock: h.clock,
        onCapabilityChange: cap => capEvents.push(cap),
    });
    h.catalog.route = (method, path, profileId, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/requests/discover") return problem(500, "internal_error", "Discover down");
        if (url.pathname === "/requests/mine") {
            h.catalog.enabled = false;
            return problem(403, "permission_denied", "No access");
        }
        return base(method, path, profileId, body);
    };
    const hub2 = mod2.open({ kind: "hub" });
    hub2.arrive("push");
    await settle();
    assert.equal(mod2.capability.enabled, false);
    assert.equal(capEvents.at(-1)?.enabled, false);
    mod.dispose();
    mod2.dispose();
});

test("definite remove (200 and 404) captures pre-removal neighbor focus, publishes 3 s notice, tombstones stale reads, and respects moved focus", async () => {
    const h = await setup();
    let mineItems: Record<string, unknown>[] = [
        makeRecord("a", { created_at: "2026-01-03T00:00:00Z" }),
        makeRecord("b", { created_at: "2026-01-02T00:00:00Z" }),
    ];
    let deleteStatus = 204;
    const base = h.catalog.route.bind(h.catalog);
    h.catalog.route = (method, path, profileId, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/requests/mine") return { status: 200, body: { items: mineItems, page: { has_more: false } } };
        if (method === "DELETE" && url.pathname.startsWith("/requests/")) {
            const id = decodeURIComponent(url.pathname.slice("/requests/".length));
            mineItems = mineItems.filter(item => item.id !== id);
            return deleteStatus === 404 ? problem(404, "not_found", "Gone") : { status: 204 };
        }
        return base(method, path, profileId, body);
    };

    let revision = 0;
    let currentFocus: FocusTarget | undefined = { zone: "mine", key: "a" };
    const paints: (Paint | undefined)[] = [];
    const mod = createRequests({
        session: h.core.session,
        clock: h.clock,
        focus: { inputRevision: () => revision, focused: () => currentFocus },
        onChange: (_page, paint) => {
            paints.push(paint);
            if (paint?.focus !== undefined) currentFocus = paint.focus;
        },
    });
    const hub = mod.open({ kind: "hub" });
    hub.arrive("push");
    await settle();
    const [first, second] = hub.snapshot().visibleMine;
    assert.ok(first && second);

    // 204 removal moves focus to neighbor "b" and shows notice for 3000 ms.
    await hub.removeRecord(first, { zone: "mine", key: "a" });
    assert.deepEqual(hub.snapshot().visibleMine.map(item => item.id), ["b"]);
    assert.deepEqual(currentFocus, { zone: "mine", key: "b" });
    assert.equal(hub.snapshot().notice, "Request removed");
    assert.equal(REQUEST_NOTICE_MS, 3000);
    await h.clock.advance(2999);
    assert.equal(hub.snapshot().notice, "Request removed");
    await h.clock.advance(1);
    assert.equal(hub.snapshot().notice, undefined);

    // 404 not_found removal of the last mine item moves focus to the first discover card.
    deleteStatus = 404;
    await hub.removeRecord(second, { zone: "mine", key: "b" });
    assert.deepEqual(hub.snapshot().visibleMine, []);
    assert.deepEqual(currentFocus, { zone: "row:trending_movies", key: "movie:949" });
    assert.equal(hub.snapshot().notice, "Request removed");

    // Viewer moving focus during removal keeps moved focus if that target survives.
    mineItems = [makeRecord("c"), makeRecord("d")];
    deleteStatus = 204;
    hub.markStale();
    hub.arrive("reshow");
    await settle();
    const cRecord = hub.snapshot().visibleMine.find(item => item.id === "c");
    assert.ok(cRecord);
    const heldDelete = h.fake.hold("/requests/c", true);
    const removing = hub.removeRecord(cRecord, { zone: "mine", key: "c" });
    await settle();
    revision += 1;
    currentFocus = { zone: "row:trending_movies", key: "movie:949" };
    heldDelete.release();
    await removing;
    assert.deepEqual(currentFocus, { zone: "row:trending_movies", key: "movie:949" });

    // Empty hub falls back to requests-page; empty My Requests falls back to actions/refresh.
    h.catalog.requestsEmpty = true;
    mineItems = [makeRecord("e")];
    hub.markStale();
    hub.arrive("reshow");
    await settle();
    const eRecord = hub.snapshot().visibleMine[0];
    assert.ok(eRecord);
    await hub.removeRecord(eRecord, { zone: "mine", key: "e" });
    assert.deepEqual(currentFocus, { zone: "page", key: "requests-page" });

    mineItems = [makeRecord("f")];
    const mine = mod.open({ kind: "mine", cursor: undefined });
    hub.cover();
    mine.arrive("push");
    await settle();
    const fRecord = mine.snapshot().visibleMine[0];
    assert.ok(fRecord);
    await mine.removeRecord(fRecord, { zone: "mine", key: "f" });
    assert.deepEqual(currentFocus, { zone: "actions", key: "refresh" });
    mod.dispose();
});

test("uncertain remove or cancel holds the row visible until a later list or request-detail read settles it", async () => {
    const h = await setup();
    let mineItems: Record<string, unknown>[] = [
        makeRecord("pending-1", { state: "pending", status: "pending", outcome: "active" }),
        makeRecord("ended-1", { state: "cancelled", status: "approved", outcome: "cancelled" }),
    ];
    const base = h.catalog.route.bind(h.catalog);
    h.catalog.route = (method, path, profileId, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/requests/mine") return { status: 200, body: { items: mineItems, page: { has_more: false } } };
        if (url.pathname === "/requests/pending-1" && method === "GET") return { status: 200, body: mineItems[0]! };
        return base(method, path, profileId, body);
    };

    const mod = createRequests({ session: h.core.session, clock: h.clock });
    const hub = mod.open({ kind: "hub" });
    hub.arrive("push");
    await settle();
    // Ended row is hidden while idle.
    assert.deepEqual(hub.snapshot().visibleMine.map(item => item.id), ["pending-1"]);
    const pending = hub.snapshot().visibleMine[0]!;

    // Lost cancel answer + failed follow-up reread holds pending-1 and locks rowActions.
    h.fake.dropNextAnswer("/requests/pending-1/cancel");
    h.catalog.requestFailure = problem(503, "unavailable", "Offline");
    await hub.cancelRecord(pending, { zone: "mine", key: "pending-1" });
    assert.deepEqual(hub.snapshot().heldIds, ["pending-1"]);
    assert.equal(hub.snapshot().listMessage, "We couldn't confirm the cancellation. Reopen My Requests to check it.");
    assert.deepEqual(hub.rowActions(pending), { cancel: false, remove: false });

    // Even if server already moved pending-1 to cancelled, a held row stays visible until settled.
    mineItems[0] = makeRecord("pending-1", { state: "cancelled", status: "approved", outcome: "cancelled" });
    assert.deepEqual(hub.snapshot().visibleMine.map(item => item.id), ["pending-1"]);

    // Opening request detail for pending-1 settles that hold without touching unrelated holds.
    h.catalog.requestFailure = undefined;
    const detail = mod.open({ kind: "request", id: "pending-1" });
    hub.cover();
    detail.arrive("push");
    await settle();
    assert.deepEqual(hub.snapshot().heldIds, []);
    assert.equal(hub.snapshot().listMessage, undefined);
    mod.dispose();
});

test("conflict remove shows conflict copy; list cancel updates in place without reloading hub", async () => {
    const h = await setup();
    let mineItems: Record<string, unknown>[] = [
        makeRecord("failed-1"),
        makeRecord("pending-1", { state: "pending", status: "pending", outcome: "active" }),
    ];
    const base = h.catalog.route.bind(h.catalog);
    h.catalog.route = (method, path, profileId, body) => {
        const url = new URL(path, "https://fake.invalid");
        if (url.pathname === "/requests/mine") return { status: 200, body: { items: mineItems, page: { has_more: false } } };
        if (method === "DELETE" && url.pathname === "/requests/failed-1") return problem(409, "conflict", "Changed");
        if (method === "POST" && url.pathname === "/requests/pending-1/cancel") {
            return { status: 200, body: makeRecord("pending-1", { state: "cancelled", status: "approved", outcome: "cancelled" }) };
        }
        return base(method, path, profileId, body);
    };

    const mod = createRequests({ session: h.core.session, clock: h.clock });
    const hub = mod.open({ kind: "hub" });
    hub.arrive("push");
    await settle();
    const failed = hub.snapshot().visibleMine.find(item => item.id === "failed-1")!;
    const pending = hub.snapshot().visibleMine.find(item => item.id === "pending-1")!;

    await hub.removeRecord(failed, { zone: "mine", key: "failed-1" });
    assert.equal(hub.snapshot().listMessage, "This request changed since the list loaded, so it wasn't removed.");

    const discoverBefore = h.fake.requests.filter(req => req.path === "/requests/discover").length;
    const mineBefore = h.fake.requests.filter(req => req.path.startsWith("/requests/mine")).length;
    await hub.cancelRecord(pending, { zone: "mine", key: "pending-1" });
    assert.equal(h.fake.requests.filter(req => req.path === "/requests/discover").length, discoverBefore, "cancel does not reload discover");
    assert.equal(h.fake.requests.filter(req => req.path.startsWith("/requests/mine")).length, mineBefore, "cancel does not reload mine");
    assert.deepEqual(hub.snapshot().visibleMine.map(item => item.id), ["failed-1"]);
    mod.dispose();
});

test("detail write and list action share one mutation lock, and re-requesting on an ended request page switches source to media", async () => {
    const h = await setup();
    h.catalog.cancelled = true;
    const mod = createRequests({ session: h.core.session, clock: h.clock });
    const detail = mod.open({ kind: "request", id: h.catalog.record.id });
    detail.arrive("push");
    await settle();
    assert.equal(detail.source.kind, "request");

    // Hold POST /requests so a second write or list action cannot start concurrently.
    const heldCreate = h.fake.hold("/requests", true);
    detail.write("create");
    await settle();
    assert.equal(detail.snapshot().writing, true);
    detail.write("create");
    await detail.cancelRecord(decodeMediaRequest(h.catalog.record), { zone: "mine", key: h.catalog.record.id });
    assert.equal(h.fake.requests.filter(req => req.method === "POST" && req.path === "/requests").length, 1);
    assert.equal(h.fake.requests.filter(req => req.path.endsWith("/cancel")).length, 0);

    heldCreate.release();
    await settle();
    assert.equal(detail.source.kind, "media", "creating a new request switches an ended request page to the media subject");
    assert.equal(detail.snapshot().writing, false);
    assert.equal(detail.snapshot().uncertain, false);
    mod.dispose();
});

test("detail cancel captures post-paint focus so a definite failure keeps focus on the adjacent pill", async () => {
    const h = await setup();
    h.catalog.created = true;
    let currentFocus: FocusTarget | undefined = { zone: "mutations", key: "cancel" };
    const mod = createRequests({
        session: h.core.session,
        clock: h.clock,
        focus: { inputRevision: () => 0, focused: () => currentFocus },
        onChange: (page, paint) => {
            // Simulate FocusHost moving focus from the hidden cancel button to the adjacent status pill during write.
            if (page.snapshot().action === "cancel" && paint?.focus?.key === "cancel") {
                currentFocus = { zone: "mutations", key: "status" };
            } else if (paint?.focus !== undefined) {
                currentFocus = paint.focus;
            }
        },
    });
    const detail = mod.open({ kind: "request", id: h.catalog.record.id });
    detail.arrive("push");
    await settle();
    currentFocus = { zone: "mutations", key: "cancel" };
    h.catalog.requestFailure = problem(409, "conflict", "This request can no longer be changed");
    detail.write("cancel");
    await settle();
    assert.deepEqual(currentFocus, { zone: "mutations", key: "status" });
    mod.dispose();
});

test("requests capability probe updates admissible() and reports refreshSearch/fromProbe options", async () => {
    const h = await setup();
    const events: { readonly enabled: boolean; readonly refreshSearch: boolean; readonly fromProbe: boolean }[] = [];
    const mod = createRequests({
        session: h.core.session,
        clock: h.clock,
        onCapabilityChange: (cap, opts) => events.push({ enabled: cap.enabled, ...opts }),
    });
    const hub: RequestPage = mod.open({ kind: "hub" });
    assert.equal(hub.admissible(), false);

    await mod.probe({ refreshSearch: false });
    assert.equal(hub.admissible(), true);
    assert.deepEqual(events.at(-1), { enabled: true, refreshSearch: false, fromProbe: true });

    h.catalog.enabled = false;
    await mod.probe();
    assert.equal(hub.admissible(), false);
    assert.deepEqual(events.at(-1), { enabled: false, refreshSearch: true, fromProbe: true });
    mod.dispose();
});

test("request-record write(follow) ignores detail belonging to a different request_id", async () => {
    const h = await setup();
    Object.assign(h.catalog.record, { state: "failed", status: "approved", outcome: "failed" });
    const origTitle = h.catalog.title.bind(h.catalog);
    h.catalog.title = () => ({
        ...origTitle(),
        request: {
            requestable: false,
            following: false,
            requested_by_viewer: false,
            request_id: "different-pending-id",
            state: "pending",
            reason: "already_requested",
        },
    });
    const mod = createRequests({ session: h.core.session, clock: h.clock });
    await mod.probe();
    const detail = mod.open({ kind: "request", id: h.catalog.record.id });
    detail.arrive("push");
    await settle();
    const followsBefore = h.fake.requests.filter(req => req.path.startsWith("/requests/follows/")).length;
    detail.write("follow");
    await settle();
    const followsAfter = h.fake.requests.filter(req => req.path.startsWith("/requests/follows/")).length;
    assert.equal(followsAfter, followsBefore);
    mod.dispose();
});
