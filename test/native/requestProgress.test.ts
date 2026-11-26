import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeMediaRequest, decodeRequestTitle } from "../../src/contracts/v2/requests.ts";
import { requestProgress, requestReasonCopy } from "../../src/ui/requestProgress.ts";
import { requestRowStatus, requestTargetSummary } from "../../src/ui/requestsScene.ts";

test("request stage precedence and unknown labels never expose raw processing or object properties", () => {
    const title = (state: string | undefined, status: string | undefined, availability = "missing") => decodeRequestTitle({ media_type: "movie", tmdb_id: 949, title: "Heat", availability, request: { requestable: true, following: false, requested_by_viewer: false, state, status } });
    for (const [state, status, label, complete] of [
        ["processing", "queued", "Queued", 2], ["processing", "downloading", "Downloading", 2],
        ["processing", "completed", "Adding to library", 3], ["partially_available", "downloading", "Partly in library", 3],
        ["pending", "completed", "Pending", 1], ["available", "pending", "In library", 4],
        ["failed", "completed", "Failed", 2], ["cancelled", "downloading", "Unavailable", 0],
        ["constructor", "queued", "Queued", 2], ["__proto__", "queued", "Queued", 2],
    ] as const) {
        const progress = requestProgress(title(state, status));
        assert.equal(progress?.short, label); assert.equal(progress?.completed, complete);
    }
    assert.equal(requestProgress(title(undefined, undefined)), undefined);
    assert.equal(requestProgress(title("processing", "queued", "available"))?.short, "Queued");
    for (const state of ["pending", "failed", "declined", "partially_available", "cancelled"]) {
        assert.equal(requestProgress(title(state, "downloading", "available"))?.short, requestProgress(title(state, "downloading"))?.short);
    }
    assert.equal(requestProgress(title("new_state", "queued", "available"))?.short, "In library");
    assert.equal(requestProgress(title(undefined, "completed"))?.short, "In library");
    assert.equal(requestProgress(title(undefined, "new_stage"))?.short, "On the way");
    for (const [outcome, label] of [["declined", "Declined"], ["failed", "Failed"], ["cancelled", "Unavailable"]]) {
        const record = decodeMediaRequest({ id: "r1", media_type: "series", tmdb_id: 1, title: "Series", state: "new_state", status: "completed", outcome });
        assert.equal(requestProgress(record)?.short, label);
    }
});

test("requestReasonCopy maps server reason tokens and humanizes unknown tokens", () => {
    assert.equal(requestReasonCopy(undefined), undefined);
    assert.equal(requestReasonCopy(""), undefined);
    assert.equal(requestReasonCopy("___"), undefined);
    for (const [token, expected] of [
        ["already_requested", "Already requested"],
        ["already_available", "Already in your library"],
        ["quota_exceeded", "Request limit reached"],
        ["limit_reached", "Request limit reached"],
        ["requests_disabled", "Requests are turned off"],
        ["requesting_blocked", "You can't request media right now"],
        ["blocked", "You can't request media right now"],
        ["validation_failed", "That request couldn't be submitted"],
        ["invalid_state", "This request can no longer be changed"],
        ["not_found", "This title is no longer available"],
        ["request_unconfirmed", "Not confirmed yet"],
        ["indexer_timeout", "Indexer Timeout"],
        ["rate-limited_now", "Rate Limited Now"],
        ["constructor", "Constructor"],
        ["__proto__", "Proto"],
    ] as const) {
        assert.equal(requestReasonCopy(token), expected);
    }
});

test("requestTargetSummary and requestRowStatus append multi-target phases or lastError on hub previews", () => {
    assert.equal(requestTargetSummary(undefined), undefined);
    assert.equal(requestTargetSummary([{ quality: "1080p", status: "downloading" }]), undefined);
    assert.equal(requestTargetSummary([{ quality: "1080p", status: "downloading" }, { quality: "4K", status: "queued" }, { quality: "720p", status: "future_phase" }]), "1080p downloading · 4K queued");
    assert.equal(requestTargetSummary([{ quality: "1080p", status: "future" }, { quality: "", status: "completed" }]), undefined);

    const record = (fields: Record<string, unknown>) => decodeMediaRequest({
        id: "r1", media_type: "movie", tmdb_id: 949, title: "Heat", state: "failed", status: "approved", outcome: "failed", ...fields,
    });
    const failedWithReason = record({ last_error: "quota_exceeded" });
    assert.equal(requestRowStatus(failedWithReason, requestProgress(failedWithReason)!), "Request failed · Request limit reached");
    const failedHumanized = record({ last_error: "indexer_timeout" });
    assert.equal(requestRowStatus(failedHumanized, requestProgress(failedHumanized)!), "Request failed · Indexer Timeout");
    const declinedNoReason = record({ state: "declined", outcome: "declined", last_error: null });
    assert.equal(requestRowStatus(declinedNoReason, requestProgress(declinedNoReason)!), "Declined");

    const multiTarget = record({ state: "processing", status: "downloading", outcome: "active", targets: [{ quality: "1080p", status: "downloading" }, { quality: "4K", status: "queued" }] });
    assert.equal(requestRowStatus(multiTarget, requestProgress(multiTarget)!), "Downloading · 1080p downloading · 4K queued");
    const singleTarget = record({ state: "processing", status: "downloading", outcome: "active", targets: [{ quality: "1080p", status: "downloading" }] });
    assert.equal(requestRowStatus(singleTarget, requestProgress(singleTarget)!), "Downloading");
    const pendingWithTargets = record({ state: "pending", status: "pending", outcome: "active", targets: [{ quality: "1080p", status: "pending" }, { quality: "4K", status: "pending" }] });
    assert.equal(requestRowStatus(pendingWithTargets, requestProgress(pendingWithTargets)!), "Waiting for approval");
});
