import { ApiError } from "../api/errors.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";
import { SessionError, SessionRefreshError } from "../session/session.ts";

export type RequestWrite = "create" | "cancel" | "follow" | "unfollow";

/** What the error page is about; recovery follows it, and the headline reads from it, so neither depends on the shown language. */
export type ErrorKind = "generic" | "sessionExpired" | "notAllowed" | "notFound" | "updateRequired";
/** A catalog key read when the page is drawn, so a language that lands late redraws it; or text the server or the screen already worded. */
export type ErrorBody = { readonly key: MessageKey } | { readonly text: string };
export interface ErrorState {
    readonly kind: ErrorKind;
    readonly body: ErrorBody;
    readonly signIn: boolean;
    /** The route's own wording for a generic failure (`failureBody`), shown by the pages that keep it over Apple's message. */
    readonly route?: ErrorBody;
}

const HEADLINES = {
    generic: "status.errorGeneric", sessionExpired: "shell.errorView.sessionExpired", notAllowed: "shell.errorView.notAllowed",
    notFound: "shell.errorView.notFound", updateRequired: "shell.errorView.updateRequired",
} as const satisfies Readonly<Record<ErrorKind, MessageKey>>;

/** Apple ErrorView.headlineResource. */
export function errorHeadline(error: Pick<ErrorState, "kind">): string {
    return translate(HEADLINES[error.kind]);
}

export function errorMessage(error: Pick<ErrorState, "body">): string {
    return "key" in error.body ? translate(error.body.key) : error.body.text;
}

/** A generic error that says what a route or screen already worded. */
export function failureState(text: string): ErrorState {
    return { kind: "generic", body: { text }, signIn: false };
}

/** Apple ErrorState.humanize(statusCode:). */
function statusBody(status: number): ErrorBody {
    if (status === 401) return { key: "shell.error.sessionExpired" };
    if (status === 403) return { key: "requests.error.permission" };
    if (status === 404) return { key: "shell.error.notFound" };
    if (status === 408 || status === 504) return { key: "shell.error.timeout" };
    if (status === 429) return { key: "shell.error.tooManyRequests" };
    return status >= 500 && status <= 599 ? { key: "shell.error.serverProblem" } : { key: "shell.error.generic" };
}

/** Apple ErrorState and ErrorView.headline: a problem's own detail says more than its status, except where a headline already says it. */
export function errorState(error: unknown): ErrorState {
    const generic = (body: ErrorBody): ErrorState => ({ kind: "generic", body, signIn: false });
    const forStatus = (status: number, body: ErrorBody = statusBody(status)): ErrorState =>
        status === 401 ? { kind: "sessionExpired", body, signIn: true }
        : status === 403 ? { kind: "notAllowed", body, signIn: false }
        : status === 404 ? { kind: "notFound", body, signIn: false }
        : generic(body);
    if (error instanceof SessionError) return forStatus(error.reason === "unavailable" ? 503 : 401);
    if (!(error instanceof ApiError)) return generic(statusBody(0));
    const failure = error.failure;
    if (failure.kind === "http") return forStatus(failure.status);
    if (failure.kind === "invalid_response") return generic({ key: "shell.error.decodingFailed" });
    if (failure.kind !== "problem") return generic({ key: "requests.error.network" });
    const { status, id, title, detail } = failure.problem;
    // UpdateRequirement.app: only this problem is an update prompt; a bare 410 also ends playback sessions and sign-in codes.
    if (status === 410 && id === "client_upgrade_required") return { kind: "updateRequired", body: { key: "update.appRequired" }, signIn: false };
    if (status === 401 || status === 404) return forStatus(status);
    if (status === 403) return forStatus(403, id === "permission_denied" && detail?.trim() ? { text: detail } : statusBody(403));
    return forStatus(status, { text: detail?.trim() ? detail : title });
}

/** Apple RequestMutationFailure.isUncertain: only an answer from the server, or a refusal before sending, rules out a write having landed. */
export function writeMayHaveApplied(error: unknown): boolean {
    if (error instanceof SessionError || error instanceof SessionRefreshError) return false;
    return !(error instanceof ApiError) || (error.failure.kind !== "problem" && error.failure.kind !== "http");
}

/** Apple RequestErrorCopy.message(for:). */
export function writeFailureMessage(error: unknown): string {
    if (error instanceof ApiError && error.failure.kind === "problem") {
        const { id, detail } = error.failure.problem;
        if (id === "validation_failed") return translate("requests.reason.validation_failed");
        if (id === "capability_disabled" || id === "capability_not_configured" || id === "capability_unsupported") return translate("requests.reason.requests_disabled");
        if (detail?.trim()) return detail;
    }
    return errorMessage(errorState(error));
}

/** Apple RequestErrorCopy.unconfirmed*Message; Apple TV has no Follow, so it keeps this client's wording. */
export function unconfirmedWriteMessage(action: RequestWrite): string {
    if (action === "create") return translate("requests.notice.unconfirmedCreate");
    return action === "cancel" ? translate("requests.notice.unconfirmedCancel") : "Could not confirm the change. Refresh before trying again.";
}

/** What to tell the person, as a catalog key where Apple has the words; undefined for an error that is not a server or session answer (a defect). */
export function failureBody(error: unknown, current: { readonly kind: string }): ErrorBody | undefined {
    const text = (line: string): ErrorBody => ({ text: line });
    if (error instanceof SessionError) {
        return error.reason === "unavailable" ? { key: "shell.error.serverProblem" } : text("This TV is no longer signed in.");
    }
    if (!(error instanceof ApiError)) {
        return undefined;
    }
    const kind = error.failure.kind;
    if (kind === "network" || kind === "timeout") {
        return text("Could not reach the server. Check the connection and try again.");
    }
    if (error.status === 404) {
        if (current.kind === "calendar") return text("Could not load Calendar. Try again.");
        if (current.kind === "audiobook") return text("This audiobook is no longer available.");
        if (current.kind === "boxSet") return { key: "boxSets.unavailableMessage" };
        return text(current.kind === "library"
            ? "This library is no longer available."
            : current.kind === "season"
              ? "This season is no longer available."
              : current.kind === "person" ? "This person is no longer available." : "This title is no longer available.");
    }
    if (error.problemId === "invalid_cursor") {
        return text(current.kind === "homeSection" || current.kind === "person" ? "The list changed. Try again." : "The list changed. Go back and open it again.");
    }
    if (kind === "invalid_response") {
        return text("The server sent an answer this TV could not read.");
    }
    return error.transient ? { key: "shell.error.serverProblem" } : text("Something went wrong. Try again.");
}

/** What to tell the person, in the language shown now. */
export function failureText(error: unknown, current: { readonly kind: string }): string | undefined {
    const body = failureBody(error, current);
    return body === undefined ? undefined : errorMessage({ body });
}
