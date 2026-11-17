import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operations } from "../../src/api/operations.ts";
import { WireError } from "../../src/contracts/v2/wire.ts";

// APIv2Client+Ratings.swift at silo-apple 6eea7cf7: shown sources are the listed `source` names, and only while the state is available.
const decode = operations.ratingSources().decode;

test("the ratings capability is one safe profile read", () => {
    const spec = operations.ratingSources();
    assert.equal(spec.method, "GET");
    assert.equal(spec.path, "/capabilities/ratings");
    assert.equal(spec.retry, "safe");
});

test("the vendored ratings capability lists IMDb and TMDB as shown", () => {
    const body: unknown = JSON.parse(readFileSync(new URL("../../src/contracts/v2/fixtures/get_ratings_capability_ok.json", import.meta.url), "utf8"));
    assert.deepEqual([...decode(body)].sort(), ["imdb", "tmdb"]);
});

test("a source a plugin declares and an administrator turned on is shown", () => {
    const body = { state: "available", allowed: true, revision: "r", sources: [{ source: "imdb", name: "IMDb" }, { source: "rt_critic", name: "Rotten Tomatoes" }, { source: "rt_audience", name: "RT Audience" }] };
    assert.deepEqual([...decode(body)].sort(), ["imdb", "rt_audience", "rt_critic"]);
});

test("a capability that is not available shows no source, whatever it lists", () => {
    for (const state of ["disabled", "not_configured", "unsupported", "something_new"]) {
        assert.equal(decode({ state, sources: [{ source: "rt_critic", name: "RT" }] }).size, 0, state);
    }
});

test("an available capability with no sources member shows none", () => {
    assert.equal(decode({ state: "available" }).size, 0);
});

test("a malformed capability is a contract break, so the caller keeps its previous answer", () => {
    assert.throws(() => decode(null), WireError);
    assert.throws(() => decode({ sources: [] }), WireError);
    assert.throws(() => decode({ state: "available", sources: "imdb" }), WireError);
    assert.throws(() => decode({ state: "available", sources: [{ name: "IMDb" }] }), WireError);
});
