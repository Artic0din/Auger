// The error page's headline and message in the shown language (silo-apple Components/ErrorState.swift, ErrorView.swift): each reads
// from the catalog when the page is drawn, text the server sent stays as sent, and English is the text it always was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import { SessionError } from "../../src/session/session.ts";
import { errorHeadline, errorMessage, errorState, failureText, type Route } from "../../src/ui/browseRoutes.ts";
import { recoveryActions } from "../../src/ui/browseViews.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const http = (status: number): ApiError => new ApiError({ kind: "http", status, retryAfterSeconds: undefined });
const problem = (status: number, id: string, detail?: string): ApiError => new ApiError({ kind: "problem", problem: { id, status, title: "Title", instance: "urn:test", errors: [], ...(detail === undefined ? {} : { detail }) }, retryAfterSeconds: undefined });
const shown = (error: unknown): { headline: string; message: string } => { const state = errorState(error); return { headline: errorHeadline(state), message: errorMessage(state) }; };

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

const CASES = [
    [http(401), "shell.errorView.sessionExpired", "shell.error.sessionExpired"],
    [new SessionError("session_ended"), "shell.errorView.sessionExpired", "shell.error.sessionExpired"],
    [http(403), "shell.errorView.notAllowed", "requests.error.permission"],
    [http(404), "shell.errorView.notFound", "shell.error.notFound"],
    [http(408), "status.errorGeneric", "shell.error.timeout"],
    [http(429), "status.errorGeneric", "shell.error.tooManyRequests"],
    [http(503), "status.errorGeneric", "shell.error.serverProblem"],
    [new SessionError("unavailable"), "status.errorGeneric", "shell.error.serverProblem"],
    [http(418), "status.errorGeneric", "shell.error.generic"],
    [new ApiError({ kind: "network" }), "status.errorGeneric", "requests.error.network"],
    [new ApiError({ kind: "invalid_response", path: "x" }), "status.errorGeneric", "shell.error.decodingFailed"],
    [problem(410, "client_upgrade_required", "Hidden"), "shell.errorView.updateRequired", "update.appRequired"],
] as const;

test("every error page reads its headline and message from the catalog in German and Arabic", () => {
    for (const tag of ["de", "ar"]) {
        inLanguage(tag, () => {
            for (const [error, headline, message] of CASES) assert.deepEqual(shown(error), { headline: translate(headline, undefined, tag), message: translate(message, undefined, tag) });
        });
    }
});

test("a language that lands late changes the page the state was made in: the state holds keys, not text", () => {
    const state = errorState(http(404));
    assert.equal(errorHeadline(state), "Not found");
    inLanguage("de", () => assert.equal(errorHeadline(state), translate("shell.errorView.notFound", undefined, "de")));
    assert.equal(errorMessage(state), "We couldn't find what you were looking for. It may have been removed or moved.");
});

test("text the server sent stays as sent in every language", () => {
    for (const tag of [null, "de", "ar"]) {
        inLanguage(tag, () => {
            assert.equal(errorMessage(errorState(problem(403, "permission_denied", "Requests are not allowed."))), "Requests are not allowed.");
            assert.equal(errorMessage(errorState(problem(500, "internal", "The server's own words."))), "The server's own words.");
            assert.equal(errorMessage(errorState(problem(500, "internal"))), "Title");
        });
    }
});

test("recovery follows the kind, not the words: a German Not found still offers Go Back", () => {
    const retry = { key: "retry", element: {} as HTMLElement };
    const back = { key: "go-back", element: {} as HTMLElement };
    inLanguage("de", () => {
        assert.deepEqual(recoveryActions(errorState(http(404)), retry, back).map(item => item.key), ["go-back", "retry"]);
        assert.deepEqual(recoveryActions(errorState(http(403)), retry, back).map(item => item.key), ["go-back", "retry"]);
        assert.deepEqual(recoveryActions(errorState(http(500)), retry, back).map(item => item.key), ["retry"]);
    });
});

test("the route failure notes that have an Apple key read it, and the others stay English", () => {
    const library = { kind: "library" } as unknown as Route;
    const box = { kind: "boxSet" } as unknown as Route;
    const serverProblem = new ApiError({ kind: "http", status: 500, retryAfterSeconds: undefined });
    assert.equal(failureText(serverProblem, library), "The server ran into a problem. Try again in a moment.");
    inLanguage("de", () => {
        assert.equal(failureText(serverProblem, library), translate("shell.error.serverProblem", undefined, "de"));
        assert.equal(failureText(http(404), box), translate("boxSets.unavailableMessage", undefined, "de"));
        assert.equal(failureText(http(404), library), "This library is no longer available.", "no Apple key: English");
    });
});

test("every catalog key the error pages read is in the German and Arabic files", () => {
    const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
    const keys = new Set<string>();
    for (const name of ["errorState.ts", "browseRoutes.ts", "browseViews.ts", "sectionCatalog.ts"]) {
        const source = readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), "utf8");
        for (const [, key] of source.matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)"/g)) if (key !== undefined && Object.hasOwn(english, key) && /^(shell|status|requests\.error|update|rowPage|boxSets|common|player\.goBack|settings\.accounts\.signInAgain)/.test(key)) keys.add(key);
    }
    assert.ok(keys.size >= 20, `the pages read ${keys.size} keys`);
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        assert.deepEqual([...keys].filter(key => !Object.hasOwn(catalog, key)), [], `${tag} lacks keys the pages read`);
    }
});
