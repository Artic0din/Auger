// What the sign-in screens say for each outcome of the session core. Kept apart from the
// controller so every state's wording is in one place.

import type { ApiError } from "../api/errors.ts";
import { isolated } from "../i18n/direction.ts";
import { type MessageKey, translate, translateTv } from "../i18n/translate.ts";
import type { ServerUrlProblem } from "../api/serverUrl.ts";
import type { ConnectResult } from "../session/core.ts";
import type { DeviceLoginState } from "../session/deviceLogin.ts";
import type { LogoutResult, RestoreResult } from "../session/session.ts";

export function connectProblem(result: Exclude<ConnectResult, { readonly status: "connected" | "needs_setup" }>): string {
    switch (result.status) {
        case "invalid_url":
            return urlProblem(result.problem);
        case "unreachable":
            // ServerSetupViewModel's words once every address tried has failed.
            return translate("setup.error.unreachable");
        case "not_silo_v2":
            return "This server can't be used with this app. It needs a Silo server with the version 2 API.";
        case "server_error":
            return "The server had a problem. Try again in a moment.";
    }
}

function urlProblem(problem: ServerUrlProblem): string {
    switch (problem) {
        // ServerSetupValidationError's missingHost and invalidHost, word for word. The other problems have no Apple key.
        case "empty":
            return translate("setup.error.empty");
        case "invalid":
            return translate("setup.error.invalidAddress");
        case "unsupported_scheme":
            return "Use an address that starts with https:// or http://.";
        case "has_credentials":
            return "Remove the user name and password from the address.";
        case "has_query_or_fragment":
            return "Remove everything from ? or # onwards in the address.";
        case "has_api_path":
            return "Enter the server address without /api at the end.";
    }
}

// The Apple TV app's question before anything is sent over plain HTTP, word for word.
export const cleartextTitle = (): string => translate("setup.cleartext.title");

/** TVLoginView.signInHeadline: the server's name, isolated in a right-to-left sentence. Adding an account from Change Account reads "Add an account on". */
export function signInTitle(serverName: string, addingAccount = false): string {
    return translate(addingAccount ? "tvSignIn.addAccountTitle" : "tvSignIn.title", { server: isolated(serverName) });
}

export function cleartextWarning(host: string): string {
    return translate("setup.cleartext.body", { host: isolated(host) });
}

export const cleartextDeclined = (): string => translate("setup.error.httpsOnly");

// TVServerNeedsSetupView and ServerNeedsSetupRetryModel, word for word.
export const serverNotReadyTitle = (): string => translate("notReady.headline");
export const serverNotReadyBody = (): string => translate("notReady.body");
export const setupNeeded = (): string => translate("notReady.badge");
export const stillNeedsSetup = (): string => translate("notReady.still");
export const setupUnreachable = (): string => translate("notReady.unreachable");

export function restoreNotice(restore: RestoreResult): string | undefined {
    switch (restore) {
        case "storage_corrupt":
            return "The sign-in saved on this TV could not be read, so it was removed. Sign in again.";
        case "storage_unavailable":
            return "This TV could not read its saved sign-in. Sign in again.";
        default:
            return undefined;
    }
}

export const PREVIOUS_SESSION_KEPT =
    "This TV could not remove the sign-in it saved before. If that account appears after the app restarts, sign out of it.";

export const SESSION_ONLY = "This TV can't store your sign-in securely, so you will need to sign in again after the app closes.";

/** AppRouter.LoginNotice.sessionExpired (AppRouter.swift:1014-1016 at silo-apple 54cf0f34). */
export function sessionExpiredNotice(serverName: string): string {
    return translate("signIn.expired", { server: isolated(serverName) });
}

export function signedOutNotice(result: LogoutResult): string[] {
    const lines = ["Signed out on this TV."];
    if (result.server === "unreachable") {
        lines.push("The server could not be reached, so it may still list this TV's session.");
    }
    if (result.storage === "failed") {
        lines.push(PREVIOUS_SESSION_KEPT);
    }
    return lines;
}

// The Apple TV app's code-screen copy (TVSignInPresentation, TVLoginView), with "this TV" for its
// platform noun.

/**
 * `<host>/activate` as people type it: the verification address (or the QR link without its
 * query when that is blank) with no trailing slash. Only https:// is dropped; browsers try https
 * for a bare host, so a plain-HTTP server keeps its scheme on screen.
 */
export function typedUrl(verificationUri: string, verificationUriComplete: string): string {
    let text = verificationUri.trim();
    if (text === "") {
        text = verificationUriComplete.split("?")[0]?.trim() ?? "";
    }
    text = text.replace(/\/+$/, "");
    return /^https:\/\//i.test(text) ? text.slice("https://".length) : text;
}

/** TVServerNeedsSetupView.hostLabel: the hostname, plus a non-default port. */
export function serverHostLabel(serverUrl: string): string {
    let url: URL;
    try {
        url = new URL(serverUrl);
    } catch {
        return serverUrl;
    }
    if (url.hostname === "") {
        return serverUrl;
    }
    return url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
}

/** The host people recognise for a server, port included so two servers on one machine stay apart. */
export function serverHost(serverUrl: string): string {
    const text = serverUrl.trim();
    const scheme = text.indexOf("://");
    const rest = scheme === -1 ? text : text.slice(scheme + 3);
    return rest.split(/[/?]/)[0] ?? rest;
}

/**
 * The paragraph under the headline. It points at the code on screen, so a declined sign-in,
 * which withdraws the code, says what to do instead.
 */
export function codeLead(status: CodeStatus, typed: string | undefined): string {
    if (status.kind === "denied") {
        return translate("tvSignIn.declinedLead");
    }
    // Apple's text says "this Apple TV"; this TV is a TV.
    // Without a typed address the catalog text names the page's path itself; a right-to-left sentence would move its slash behind it ("activate/").
    return typed === undefined ? translateTv("tvSignIn.appleTv.leadNoPage").replace("/activate", isolated("/activate")) : translateTv("tvSignIn.appleTv.lead", { page: isolated(typed) });
}

/**
 * What the code screen shows: QRLoginViewModel.Status, for this TV. Device-login phases map onto it
 * in the sign-in controller, which also owns renewal, start retries and the failure grace periods.
 */
export type CodeStatus =
    | { readonly kind: "getting_code" }
    | { readonly kind: "waiting"; readonly renewed: boolean }
    | { readonly kind: "opened" }
    | { readonly kind: "unreachable" }
    | { readonly kind: "rate_limited" }
    | { readonly kind: "approved"; readonly account: string | undefined }
    | { readonly kind: "could_not_finish" }
    | { readonly kind: "denied" }
    | { readonly kind: "paused" }
    | { readonly kind: "failed"; readonly message: string };

/** States left only by a person's action. */
export function isTerminal(status: CodeStatus): boolean {
    return !["getting_code", "waiting", "opened", "unreachable", "rate_limited"].includes(status.kind);
}

/** The status line under the code (a polite live region). */
export function statusLine(status: CodeStatus, host: string): string {
    switch (status.kind) {
        case "getting_code":
            return translate("tvSignIn.status.gettingCode");
        case "waiting":
            return translate(status.renewed ? "tvSignIn.status.newCode" : "tvSignIn.status.waiting");
        case "opened":
            return translate("tvSignIn.status.opened");
        case "approved":
            return status.account === undefined ? translate("tvSignIn.status.signedIn") : translate("tvSignIn.status.signedInAs", { account: isolated(status.account) });
        case "could_not_finish":
            return translate("tvSignIn.status.couldntFinish");
        case "denied":
            return translate("tvSignIn.status.denied");
        case "paused":
            return translate("tvSignIn.status.paused");
        case "unreachable":
            return translate("tvSignIn.status.unreachable", { host: isolated(host) });
        case "rate_limited":
            return translate("tvSignIn.status.tooMany");
        case "failed":
            return status.message;
    }
}

/** The one action beside a state, when it has one. */
export function stateAction(status: CodeStatus): string | undefined {
    switch (status.kind) {
        case "could_not_finish":
        case "unreachable":
        case "rate_limited":
        case "failed":
            return translate("common.tryAgain");
        case "denied":
        case "paused":
            return translate("tvSignIn.action.newCode");
        default:
            return undefined;
    }
}

/** States that end the attempt take focus to their action; retrying in the background does not. */
export function actionTakesFocus(status: CodeStatus): boolean {
    return ["could_not_finish", "denied", "paused", "failed"].includes(status.kind);
}

/** A device-login failure this TV can't retry by itself, worded as before. */
export function failedMessage(state: Extract<DeviceLoginState, { readonly phase: "failed" }>): string {
    return failure(state);
}

// The card beside the address and password forms. The Apple TV app points at the keyboard
// notification on nearby iPhones; this TV offers its own on-screen keyboard and, per Samsung's
// 2023 TV e-Manual, USB and Bluetooth keyboards.
// No Apple key: Apple's own card (`tvSignIn.appleTv.typeOnPhoneBody`) points at the iPhone keyboard notification.
export const KEYBOARD_TITLE = "Type with a keyboard";
export const KEYBOARD_TEXT = "When you select a field, this TV's on-screen keyboard opens. You can also type on a USB or Bluetooth keyboard connected to the TV.";

// The Apple TV manual entry (TVServerSetupView.manualEntry).
export const entryTitle = (): string => translate("setup.headline");
export const entryLead = (): string => translate("setup.body");
export const invalidPort = (): string => translate("setup.error.invalidPort");

function failure(state: Extract<DeviceLoginState, { readonly phase: "failed" }>): string {
    switch (state.reason) {
        case "unreachable":
            return "Could not reach the server. Check the TV's internet connection, then try again.";
        case "rate_limited": {
            const wait = state.retryAfterSeconds;
            return wait === undefined
                ? "Too many sign-in attempts. Wait a minute, then try again."
                : `Too many sign-in attempts. Wait ${waitText(wait)}, then try again.`;
        }
        case "server_error":
            return "The server had a problem. Try again in a moment.";
        case "unexpected_response":
            return "The server sent an answer this app does not understand. Check that the server and this app are up to date.";
        case "temporary_session_refused":
            return "The server offered a temporary session, which this TV does not use. Try again.";
    }
}

export function waitText(seconds: number): string {
    if (seconds <= 1) {
        return "1 second";
    }
    if (seconds < 90) {
        return `${seconds} seconds`;
    }
    return `${Math.ceil(seconds / 60)} minutes`;
}

/**
 * `ErrorState.passwordChangeRequiredMessage` on tvOS (`ErrorState.swift`). Apple TV has no
 * password change, so the profile picker shows this instead of the server's protocol detail.
 */
export const passwordChangeRequiredMessage = (): string => translate("profiles.error.passwordReset");

// The Apple TV app's password screen (TVLoginView, LoginViewModel), word for word.
export const passwordTitle = (): string => translate("signIn.headline");
export const enterUsername = (): string => translate("signIn.error.usernameMissing");
export const enterPassword = (): string => translate("signIn.error.passwordMissing");

/** `serverName` is the host (and port) until the server's branding name is read. */
export function passwordLead(serverName: string, passwordOnly: boolean): string {
    return passwordOnly ? translate("tvSignIn.passwordOnly") : translate("signIn.body", { server: isolated(serverName) });
}

/** Single sign-on accounts have no Silo password; one provider is named, several read as single sign-on. */
export function phoneHint(oauthProviders: readonly string[]): string | undefined {
    const first = oauthProviders[0];
    if (first === undefined) {
        return undefined;
    }
    return oauthProviders.length === 1 ? translate("tvSignIn.form.providerHint", { provider: isolated(providerName(first)) }) : translate("signIn.phoneHintSso");
}

function providerName(displayName: string): string {
    const name = displayName.trim();
    for (const prefix of ["sign in with ", "log in with ", "login with ", "continue with "]) {
        const rest = name.toLowerCase().startsWith(prefix) ? name.slice(prefix.length).trim() : "";
        if (rest !== "") {
            return rest;
        }
    }
    return name === "" ? "single sign-on" : name;
}

const REFUSALS: Readonly<Record<string, MessageKey>> = {
    not_permitted: "signIn.provider.reason.notPermitted",
    email_in_use: "signIn.error.emailInUse",
    identity_linked_elsewhere: "signIn.provider.reason.linkedElsewhere",
    provider_unavailable: "signIn.provider.reason.unavailable",
    password_expired: "signIn.provider.reason.passwordExpired",
    account_required: "tvSignIn.error.accountRequired",
};

/**
 * A refused password sign-in. Only a problem document blames the credentials: a bare 401 or 403
 * comes from something in front of the server. `hint` follows a wrong password.
 */
export function passwordProblem(error: ApiError, hint: string | undefined, phoneRoute: boolean): string {
    const id = error.problemId;
    if (id === "local_login_disabled") {
        return translate(phoneRoute ? "tvSignIn.error.localLoginDisabled" : "signIn.error.passwordOff");
    }
    const refusal = id === undefined ? undefined : REFUSALS[id];
    if (refusal !== undefined) {
        return translate(refusal);
    }
    const status = error.status;
    if (status === 429) {
        return translate("signIn.error.tooManyAttempts");
    }
    if (id !== undefined && status === 401) {
        return hint === undefined ? translate("tvSignIn.error.invalidCredentials") : translate("signIn.error.invalidWithHint", { hint: isolated(hint) });
    }
    if (id !== undefined && status === 403) {
        return translate("signIn.error.cantSignIn");
    }
    if (id !== undefined && (status === 400 || status === 422)) {
        return translate("signIn.error.checkCredentials");
    }
    // Where the Apple TV app shows the system's description of the failure.
    const kind = error.failure.kind;
    if (kind === "network" || kind === "timeout") {
        return failure({ phase: "failed", reason: "unreachable", retryAfterSeconds: undefined });
    }
    if (kind === "invalid_response") {
        return failure({ phase: "failed", reason: "unexpected_response", retryAfterSeconds: undefined });
    }
    return failure({ phase: "failed", reason: "server_error", retryAfterSeconds: undefined });
}
