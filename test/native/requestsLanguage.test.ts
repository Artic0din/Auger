// Requests text in the shown language (silo-apple Screens/Requests/Core/RequestProgress.swift and RequestErrorCopy.swift):
// each status and notice reads from the catalog, and a language whose file has not landed reads English.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeMediaRequest, decodeRequestTitle } from "../../src/contracts/v2/requests.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { registerCatalog, translate } from "../../src/i18n/translate.ts";
import { unconfirmedWriteMessage, writeFailureMessage } from "../../src/ui/browseRoutes.ts";
import { requestProgress } from "../../src/ui/requestProgress.ts";
import { removedNotice, unconfirmedCancelMessage } from "../../src/ui/requestRemoval.ts";
import { requestQuality } from "../../src/ui/requestsScene.ts";
import { ApiError } from "../../src/api/errors.ts";

// German lands; Arabic does not, so the last test can show a language that has not landed.
registerCatalog("de", JSON.parse(readFileSync(new URL("../../src/i18n/catalog/de.json", import.meta.url), "utf8")) as Record<string, string>);

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
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

test("a request's quality summary, removal notice and write failures read in German", () => {
    inLanguage("de", () => {
        const record = decodeMediaRequest({ id: "r1", media_type: "movie", tmdb_id: 949, title: "Heat", state: "processing", status: "downloading", outcome: "active", requested_by_profile_id: "p",
            targets: [{ quality: "1080p", status: "downloading" }, { quality: "4K", status: "queued" }] });
        assert.equal(requestQuality(record.targets), `${translate("requests.target.downloading", { quality: "1080p" }, "de")} · ${translate("requests.target.queued", { quality: "4K" }, "de")}`);
        assert.equal(removedNotice(), translate("requests.notice.removed", undefined, "de"));
        assert.equal(unconfirmedCancelMessage(), translate("requests.notice.unconfirmedCancel", undefined, "de"));
        assert.equal(unconfirmedWriteMessage("create"), translate("requests.notice.unconfirmedCreate", undefined, "de"));
        assert.equal(unconfirmedWriteMessage("cancel"), translate("requests.notice.unconfirmedCancel", undefined, "de"));
        const refused = new ApiError({ kind: "problem", problem: { status: 422, id: "validation_failed", title: "Invalid", detail: "Server detail", instance: "/requests", errors: [] }, retryAfterSeconds: undefined });
        assert.equal(writeFailureMessage(refused), translate("requests.reason.validation_failed", undefined, "de"));
        assert.notEqual(removedNotice(), "Request removed");
    });
});

test("a language whose file has not landed reads English, and English is unchanged", () => {
    for (const tag of ["ar", null]) {
        inLanguage(tag, () => {
            assert.equal(requestProgress(title("pending", "pending"))?.long, "Waiting for approval");
            assert.equal(removedNotice(), "Request removed");
            assert.equal(unconfirmedWriteMessage("create"), "We couldn't confirm the request. Check My Requests before trying again.");
        });
    }
});
