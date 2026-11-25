// Requests text in the shown language (silo-apple Screens/Requests/Core/RequestProgress.swift and RequestErrorCopy.swift):
// each status and notice reads from the catalog, and a language whose file has not landed reads English.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { decodeMediaRequest, decodeRequestTitle } from "../../src/contracts/v2/requests.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { registerCatalog, translate } from "../../src/i18n/translate.ts";
import { unconfirmedWriteMessage, writeFailureMessage } from "../../src/ui/errorState.ts";
import { requestProgress } from "../../src/ui/requestProgress.ts";
import { createRequests } from "../../src/ui/requestsModule.ts";
import { requestQuality } from "../../src/ui/requestsScene.ts";
import { settle } from "./support/clock.ts";
import { FakeRequests } from "./support/fakeRequests.ts";
import { problem } from "./support/fakeSilo.ts";
import { connected, signIn } from "./support/harness.ts";

// German lands; Arabic does not, so the last test can show a language that has not landed.
registerCatalog("de", JSON.parse(readFileSync(new URL("../../src/i18n/catalog/de.json", import.meta.url), "utf8")) as Record<string, string>);

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

async function inLanguageAsync<T>(tag: string | null, body: () => Promise<T>): Promise<T> {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return await body(); } finally { setAppLanguage(null); }
}

async function setupRequests(catalog = new FakeRequests()) {
    const h = await connected();
    await signIn(h);
    h.fake.catalog = catalog;
    const owner = (await h.core.profiles.list()).find(profile => profile.id === "p-owner");
    assert.ok(owner);
    h.core.profiles.select(owner);
    const mod = createRequests({ session: h.core.session, clock: h.clock });
    return { ...h, catalog, mod };
}

const title = (state: string, status: string) => decodeRequestTitle({ media_type: "movie", tmdb_id: 949, title: "Heat", availability: "missing", request: { requestable: false, following: false, requested_by_viewer: true, request_id: "r1", state, status } });

test("each request status reads in German, short and long", () => {
    const cases = [
        ["pending", "pending", "requests.short.pending", "requests.long.pending"],
        ["processing", "downloading", "requests.short.downloading", "requests.long.downloading"],
        ["processing", "queued", "requests.short.queued", "requests.long.queued"],
        ["processing", "completed", "requests.short.adding", "requests.long.adding"],
        ["partially_available", "downloading", "requests.short.partly", "requests.long.partly"],
        ["available", "completed", "requests.short.inLibrary", "requests.long.inLibrary"],
        ["declined", "pending", "requests.short.declined", "requests.long.declined"],
        ["failed", "failed", "requests.short.failed", "requests.long.failed"],
        ["cancelled", "pending", "requests.short.unavailable", "requests.detailTitle.unavailable"],
    ] as const;
    inLanguage("de", () => {
        for (const [state, status, short, long] of cases) {
            const progress = requestProgress(title(state, status));
            assert.equal(progress?.short, translate(short, undefined, "de"), `${state} short`);
            assert.equal(progress?.long, translate(long, undefined, "de"), `${state} long`);
        }
        assert.notEqual(requestProgress(title("pending", "pending"))?.long, "Waiting for approval", "German is not English");
    });
});

test("a request's quality summary, removal notice and write failures read in German", async () => {
    const h = await setupRequests();
    h.catalog.created = true;
    h.catalog.record.state = "failed";
    h.catalog.record.status = "approved";
    h.catalog.record.outcome = "failed";
    const page = h.mod.open({ kind: "hub" });
    page.arrive("push");
    await settle();
    const record = page.snapshot().visibleMine[0];
    assert.ok(record);

    await inLanguageAsync("de", async () => {
        const qualityRecord = decodeMediaRequest({ id: "r1", media_type: "movie", tmdb_id: 949, title: "Heat", state: "processing", status: "downloading", outcome: "active", requested_by_profile_id: "p",
            targets: [{ quality: "1080p", status: "downloading" }, { quality: "4K", status: "queued" }] });
        assert.equal(requestQuality(qualityRecord.targets), `${translate("requests.target.downloading", { quality: "1080p" }, "de")} · ${translate("requests.target.queued", { quality: "4K" }, "de")}`);
        await page.removeRecord(record, { zone: "mine", key: record.id });
        assert.equal(page.snapshot().notice, translate("requests.notice.removed", undefined, "de"));
        assert.notEqual(page.snapshot().notice, "Request removed");
        assert.equal(unconfirmedWriteMessage("create"), translate("requests.notice.unconfirmedCreate", undefined, "de"));
        assert.equal(unconfirmedWriteMessage("cancel"), translate("requests.notice.unconfirmedCancel", undefined, "de"));
        const refused = new ApiError({ kind: "problem", problem: { status: 422, id: "validation_failed", title: "Invalid", detail: "Server detail", instance: "/requests", errors: [] }, retryAfterSeconds: undefined });
        assert.equal(writeFailureMessage(refused), translate("requests.reason.validation_failed", undefined, "de"));
    });
    h.mod.dispose();
});

test("a language whose file has not landed reads English, and English is unchanged", async () => {
    for (const tag of ["ar", null]) {
        const h = await setupRequests();
        h.catalog.created = true;
        h.catalog.record.state = "failed";
        h.catalog.record.status = "approved";
        h.catalog.record.outcome = "failed";
        const page = h.mod.open({ kind: "hub" });
        page.arrive("push");
        await settle();
        const record = page.snapshot().visibleMine[0];
        assert.ok(record);
        await inLanguageAsync(tag, async () => {
            assert.equal(requestProgress(title("pending", "pending"))?.long, "Waiting for approval");
            await page.removeRecord(record, { zone: "mine", key: record.id });
            assert.equal(page.snapshot().notice, "Request removed");
            assert.equal(unconfirmedWriteMessage("create"), "We couldn't confirm the request. Check My Requests before trying again.");
        });
        h.mod.dispose();
    }
});

test("a held cancel or remove message follows the shown language and still clears when its holds settle", async () => {
    for (const [kind, key] of [["cancel", "requests.notice.unconfirmedCancel"], ["remove", "requests.notice.unconfirmedRemove"]] as const) {
        const h = await setupRequests();
        h.catalog.created = true;
        if (kind === "remove") {
            h.catalog.record.state = "failed";
            h.catalog.record.status = "approved";
            h.catalog.record.outcome = "failed";
        }
        const page = h.mod.open({ kind: "hub" });
        page.arrive("push");
        await settle();
        const record = page.snapshot().visibleMine[0];
        assert.ok(record);

        // Drop the mutation answer AND fail the immediate follow-up reread so the hold remains active.
        h.fake.dropNextAnswer(kind === "cancel" ? `/requests/${record.id}/cancel` : `/requests/${record.id}`);
        h.catalog.requestFailure = problem(503, "unavailable", "Offline");
        await inLanguageAsync("de", async () => {
            if (kind === "cancel") await page.cancelRecord(record, { zone: "mine", key: record.id });
            else await page.removeRecord(record, { zone: "mine", key: record.id });
            assert.equal(page.snapshot().listMessage, translate(key, undefined, "de"));
        });
        // Switching language re-renders the active hold message in English.
        assert.equal(inLanguage(null, () => page.snapshot().listMessage), translate(key, undefined, "en"), "a language change rewrites it");

        // Settling in another language than it was raised in still clears the hold message.
        h.catalog.requestFailure = undefined;
        await inLanguageAsync(null, async () => {
            page.markStale();
            page.arrive("reshow");
            await settle();
        });
        assert.equal(page.snapshot().listMessage, undefined, kind);
        h.mod.dispose();
    }

    // A non-unconfirmed error message stays when unrelated holds settle.
    const h = await setupRequests();
    h.catalog.created = true;
    const page = h.mod.open({ kind: "hub" });
    page.arrive("push");
    await settle();
    const record = page.snapshot().visibleMine[0];
    assert.ok(record);
    h.catalog.requestFailure = problem(409, "conflict", "Already requested");
    await page.cancelRecord(record, { zone: "mine", key: record.id });
    assert.equal(page.snapshot().listMessage, "Already requested");
    h.catalog.requestFailure = undefined;
    page.markStale();
    page.arrive("reshow");
    await settle();
    assert.equal(page.snapshot().listMessage, "Already requested", "any other message stays");
    h.mod.dispose();
});
