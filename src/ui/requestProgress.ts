import type { MediaRequest, RequestTitle } from "../contracts/v2/requests.ts";
import { translate } from "../i18n/translate.ts";

export type RequestDisplay = "pending" | "onTheWay" | "inLibrary" | "needsAttention" | "unavailable";
export interface RequestProgress { readonly display: RequestDisplay; readonly short: string; readonly long: string; readonly completed: number; readonly current: number | undefined }

/** Apple RequestProgress: display state wins over the finer download phase. */
export function requestProgress(item: RequestTitle | MediaRequest): RequestProgress | undefined {
    const state = "request" in item ? item.request.state : item.state;
    const status = "request" in item ? item.request.status : item.status;
    const result = (display: RequestDisplay, short: string, long = short, completed = 0, current: number | undefined = undefined): RequestProgress => ({ display, short, long, completed, current });
    if (state === "available") return result("inLibrary", translate("requests.short.inLibrary"), translate("requests.long.inLibrary"), 4);
    if (state === "cancelled") return result("unavailable", translate("requests.short.unavailable"), translate("requests.detailTitle.unavailable"));
    if (state === "declined") return result("needsAttention", translate("requests.short.declined"), translate("requests.long.declined"), 1, 1);
    if (state === "failed") return result("needsAttention", translate("requests.short.failed"), translate("requests.long.failed"), 2, 2);
    if (state === "pending") return result("pending", translate("requests.short.pending"), translate("requests.long.pending"), 1, 1);
    if (state === "partially_available") return result("onTheWay", translate("requests.short.partly"), translate("requests.long.partly"), 3, 3);
    const inFlight = (): RequestProgress => {
        if (status === "completed") return result("onTheWay", translate("requests.short.adding"), translate("requests.long.adding"), 3, 3);
        if (status === "downloading") return result("onTheWay", translate("requests.short.downloading"), translate("requests.long.downloading"), 2, 2);
        if (status === "approved" || status === "queued") return result("onTheWay", translate("requests.short.queued"), translate("requests.long.queued"), 2, 2);
        return result("onTheWay", translate("requests.short.onTheWay"), translate("requests.long.onTheWay"), 2, 2);
    };
    if (state === "approved" || state === "processing") return inFlight();
    if ("availability" in item && item.availability === "available") return result("inLibrary", translate("requests.short.inLibrary"), translate("requests.long.inLibrary"), 4);
    if (!("request" in item)) {
        if (item.outcome === "declined") return result("needsAttention", translate("requests.short.declined"), translate("requests.long.declined"), 1, 1);
        if (item.outcome === "failed") return result("needsAttention", translate("requests.short.failed"), translate("requests.long.failed"), 2, 2);
        if (item.outcome === "cancelled") return result("unavailable", translate("requests.short.unavailable"), translate("requests.detailTitle.unavailable"));
    }
    if (status !== undefined) {
        if (status === "pending") return result("pending", translate("requests.short.pending"), translate("requests.long.pending"), 1, 1);
        if (status === "completed") return result("inLibrary", translate("requests.short.inLibrary"), translate("requests.long.inLibrary"), 4);
        if (status === "failed") return result("needsAttention", translate("requests.short.failed"), translate("requests.long.failed"), 2, 2);
        return inFlight();
    }
    return "request" in item && item.request.requestable ? undefined : result("unavailable", translate("requests.short.unavailable"), translate("requests.detailTitle.unavailable"));
}

export function orderRequests(records: readonly MediaRequest[]): MediaRequest[] {
    return records.flatMap(record => {
        const display = requestProgress(record)?.display;
        if (display === undefined || display === "unavailable") return [];
        const bucket = display === "inLibrary" ? 2 : display === "needsAttention" ? 1 : 0;
        return [{ record, bucket }];
    }).sort((left, right) => left.bucket - right.bucket || (right.record.createdAt ?? 0) - (left.record.createdAt ?? 0)).map(item => item.record);
}
