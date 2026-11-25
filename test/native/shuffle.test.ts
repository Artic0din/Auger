import assert from "node:assert/strict";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";

test("Shuffle operations retain the pinned retry and scope contracts", () => {
    assert.equal(operations.shuffleCapabilities().path, "/shuffles/capabilities");
    const create = operations.createShuffle("12");
    assert.equal(create.retry, "never");
    assert.deepEqual(create.body, { scope: { kind: "library", id: "12" } });
    for (const kind of ["library_collection", "user_collection"] as const) {
        const collection = operations.createShuffle("opaque/id", kind);
        assert.deepEqual(collection.body, { scope: { kind, id: "opaque/id" } });
        assert.equal(collection.retry, "never");
    }
    const get = operations.getShuffle("sh/1");
    assert.equal(get.method, "GET");
    assert.equal(get.retry, "safe");
    assert.equal(get.path, "/shuffles/sh%2F1");
    const advance = operations.advanceShuffle("sh/1", "movie:done");
    assert.equal(advance.retry, "safe");
    assert.equal(advance.path, "/shuffles/sh%2F1/advance");
    assert.deepEqual(advance.body, { from_content_id: "movie:done" });
    const skip = operations.skipShuffleItem("sh/1", "movie:pick");
    assert.equal(skip.method, "POST");
    assert.equal(skip.retry, "safe");
    assert.equal(skip.path, "/shuffles/sh%2F1/skip");
    assert.deepEqual(skip.body, { next_content_id: "movie:pick" });
    const remove = operations.deleteShuffle("sh/1");
    assert.equal(remove.method, "DELETE");
    assert.equal(remove.retry, "never");
    assert.equal(remove.path, "/shuffles/sh%2F1");
    assert.equal(remove.decode(undefined), undefined);
});

test("Shuffle decoding admits only the consumed typed fields", () => {
    const capability = operations.shuffleCapabilities().decode;
    assert.deepEqual(capability({ allowed: true, state: "available", scope_kinds: ["library"] }), { usable: true, scopeKinds: ["library"] });
    assert.throws(() => capability({ allowed: false, scope_kinds: ["library"] }));
    assert.throws(() => capability({ allowed: true, state: "available", scope_kinds: [null] }));
    const decode = operations.createShuffle("12").decode;
    assert.deepEqual(decode({ id: "sh1", current: { content_id: "movie:1" }, next: { content_id: "movie:2" } }), { id: "sh1", current: { id: "movie:1" }, next: { id: "movie:2" } });
    assert.throws(() => decode({ id: "", current: { id: "movie:1" }, next: { id: "movie:2" } }));
    assert.throws(() => decode({ id: "sh1", current: [], next: { id: "movie:2" } }));
});

test("Shuffle decoding derives scopeLabel from scope title and parent_title (#778)", () => {
    const decode = operations.createShuffle("12").decode;
    assert.equal(decode({ id: "sh1", scope: { kind: "library", id: "12", title: "Movies" }, current: { content_id: "movie:1" }, next: { content_id: "movie:2" } }).scopeLabel, "Movies");
    assert.equal(decode({ id: "sh1", scope: { kind: "season", id: "s2", title: "Season 2", parent_title: "Breaking Bad" }, current: { content_id: "movie:1" }, next: { content_id: "movie:2" } }).scopeLabel, "Breaking Bad · Season 2");
});
