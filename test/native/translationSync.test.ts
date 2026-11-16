// scripts/sync-translations.ts keeps the silo-translations keys a TV can show: the Apple scope,
// because tvOS is the parity target and Apple's keys use the shared ICU subset.
import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeCatalog } from "../../scripts/sync-translations.ts";

const arb = {
    "@@locale": "en",
    "b.second": "Second",
    "@b.second": { description: "d", "x-platforms": ["apple", "android"] },
    "a.first": "First {name}",
    "@a.first": { description: "d", placeholders: { name: { type: "String" } } },
    "c.android": "Android only",
    "@c.android": { description: "d", "x-platforms": ["android", "roku"] },
    "d.web": "Web only",
    "@d.web": { description: "d", "x-platforms": ["web"] },
    "apple.infoPlist.tvos.nsLocalNetworkUsageDescription": "Silo uses the network",
    "@apple.infoPlist.tvos.nsLocalNetworkUsageDescription": { description: "d", "x-platforms": ["apple"], "x-plistKey": "NSLocalNetworkUsageDescription" },
};

test("the scope keeps Apple's keys and shared ones, sorted, without metadata or Info.plist prompts", () => {
    const scoped = scopeCatalog(arb);
    assert.deepEqual(Object.entries(scoped), [["a.first", "First {name}"], ["b.second", "Second"]]);
});

test("a language file has no metadata, so its keys are scoped by the English key set", () => {
    const scoped = scopeCatalog({ "a.first": "Primero {name}", "c.android": "x", "z.unknown": "y" }, new Set(["a.first", "b.second"]));
    assert.deepEqual(scoped, { "a.first": "Primero {name}" });
});

test("a scoped message outside the shared ICU subset stops the sync", () => {
    assert.throws(() => scopeCatalog({ "a.bad": "{n, select, a {x} other {y}}", "@a.bad": { description: "d" } }), /a\.bad/);
});
