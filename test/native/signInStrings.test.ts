// The sign-in screens' text in the shown language (silo-apple Screens/Auth/TVServerSetupView, TVLoginView, TVSignInPresentation,
// ServerSetupViewModel, LoginViewModel, ExternalSignIn, tvOS/Screens/Auth/TVServerNeedsSetupView at 0e17c3e3): each sentence the
// screens say reads from the catalog in German and Arabic, English is the text it always was, and a name inside a sentence is
// isolated in a right-to-left language. A sentence Apple has no key for stays English.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiError } from "../../src/api/errors.ts";
import { SHIPPED_LANGUAGES, setAppLanguage } from "../../src/i18n/language.ts";
import { translate } from "../../src/i18n/translate.ts";
import {
    cleartextDeclined, cleartextTitle, cleartextWarning, codeLead, type CodeStatus, connectProblem, enterPassword, enterUsername, entryLead, entryTitle,
    invalidPort, passwordLead, passwordProblem, passwordTitle, phoneHint, serverNotReadyBody, serverNotReadyTitle, sessionExpiredNotice, setupNeeded,
    setupUnreachable, stateAction, statusLine, stillNeedsSetup,
} from "../../src/ui/signInText.ts";
import { registerSourceCatalogs } from "./support/catalogs.ts";

registerSourceCatalogs();

const FSI = "⁨";
const PDI = "⁩";
const english = JSON.parse(readFileSync(new URL("../../src/i18n/catalog/en.json", import.meta.url), "utf8")) as Record<string, string>;
const source = (name: string): string => readFileSync(new URL(`../../src/ui/${name}`, import.meta.url), "utf8");

function inLanguage<T>(tag: string | null, body: () => T): T {
    setAppLanguage(tag, SHIPPED_LANGUAGES, ["en-AU"]);
    try { return body(); } finally { setAppLanguage(null); }
}

const problem = (status: number, id: string): ApiError => new ApiError({ kind: "problem", problem: { status, id } as never, retryAfterSeconds: undefined });
const STATUSES: readonly CodeStatus[] = [
    { kind: "getting_code" }, { kind: "waiting", renewed: false }, { kind: "waiting", renewed: true }, { kind: "opened" },
    { kind: "approved", account: "laura" }, { kind: "approved", account: undefined }, { kind: "could_not_finish" }, { kind: "denied" },
    { kind: "paused" }, { kind: "unreachable" }, { kind: "rate_limited" },
];

test("every catalog key the sign-in screens read is in the German and Arabic files", () => {
    const keys = new Set<string>();
    for (const name of ["signInText.ts", "signIn.ts", "credentialsScreen.ts", "codeScreen.ts", "marquee.ts"]) {
        for (const [, key] of source(name).matchAll(/"([a-z][A-Za-z]*(?:\.[A-Za-z0-9]+)+)"/g)) if (key !== undefined && Object.hasOwn(english, key)) keys.add(key);
    }
    assert.ok(keys.size > 60, `the screens read ${keys.size} catalog keys`);
    for (const tag of ["de", "ar"]) {
        const catalog = JSON.parse(readFileSync(new URL(`../../src/i18n/catalog/${tag}.json`, import.meta.url), "utf8")) as Record<string, string>;
        assert.deepEqual([...keys].filter(key => !Object.hasOwn(catalog, key)), [], `${tag} lacks keys the screens read`);
    }
});

test("English reads the text the screens always showed", () => {
    assert.equal(entryTitle(), "Enter your\nserver address");
    assert.equal(entryLead(), "Type the address you use for Silo.");
    assert.equal(invalidPort(), "Port must be a number between 1 and 65535.");
    assert.equal(cleartextTitle(), "Connect without encryption?");
    assert.equal(cleartextWarning("silo.test:8090"), "Your password and what you watch will be sent unencrypted to silo.test:8090. Only do this on a network you trust.");
    assert.equal(cleartextDeclined(), "Could not reach a Silo server at that address over HTTPS.");
    assert.equal(serverNotReadyTitle(), "This server\nisn't ready");
    assert.equal(serverNotReadyBody(), "Ask the server administrator to finish setup. When it is ready, check again.");
    assert.equal(setupNeeded(), "Setup needed");
    assert.equal(stillNeedsSetup(), "This server still needs administrator setup.");
    assert.equal(setupUnreachable(), "Couldn't reach the server. Check it's running and try again.");
    assert.equal(sessionExpiredNotice("Home"), "You were signed out of Home. Sign in again.");
    assert.equal(passwordTitle(), "Sign in with\na password");
    assert.equal(enterUsername(), "Please enter your username.");
    assert.equal(enterPassword(), "Please enter your password.");
    assert.equal(passwordLead("Home", false), "Use your Home username and password.");
    assert.equal(passwordLead("Home", true), "This server only supports password sign-in.");
    assert.equal(phoneHint(["Sign in with Google"]), "If you sign in with Google, use your phone instead.");
    assert.equal(phoneHint(["Google", "Okta"]), "If you sign in with single sign-on, use your phone instead.");
    assert.equal(phoneHint([]), undefined);
    assert.equal(connectProblem({ status: "unreachable" }), "Could not reach a Silo server at that address.");
    assert.equal(connectProblem({ status: "invalid_url", problem: "empty" }), "Please enter a server host.");
    assert.equal(connectProblem({ status: "invalid_url", problem: "invalid" }), "Please enter a valid server host.");
    assert.equal(connectProblem({ status: "invalid_url", problem: "has_api_path" }), "Enter the server address without /api at the end.");
    assert.equal(connectProblem({ status: "server_error" }), "The server had a problem. Try again in a moment.");
    assert.equal(codeLead({ kind: "waiting", renewed: false }, "silo.test/activate"), "Scan the code with your phone's camera, or go to silo.test/activate and enter it. Approve on your phone and this TV signs in by itself.");
    assert.equal(codeLead({ kind: "waiting", renewed: false }, undefined), "Scan the code with your phone's camera, or go to your server's /activate page and enter it. Approve on your phone and this TV signs in by itself.");
    assert.equal(codeLead({ kind: "denied" }, "x"), "Show a new code to try again.");
    assert.equal(statusLine({ kind: "unreachable" }, "silo.test"), "Can't reach silo.test. Check this TV's connection.");
    assert.equal(statusLine({ kind: "approved", account: "laura" }, "silo.test"), "Signed in as laura");
    assert.equal(stateAction({ kind: "paused" }), "Show a new code");
    assert.equal(stateAction({ kind: "unreachable" }), "Try again");
    assert.equal(passwordProblem(problem(401, "invalid_credentials"), "If you sign in with Google, use your phone instead.", true), "Incorrect username or password. If you sign in with Google, use your phone instead.");
    assert.equal(passwordProblem(problem(401, "invalid_credentials"), undefined, true), "Incorrect username or password.");
    assert.equal(passwordProblem(problem(403, "account_disabled"), undefined, true), "This account can't sign in. Contact your server administrator.");
    assert.equal(passwordProblem(problem(422, "validation"), undefined, true), "Check your username and password, then try again.");
    assert.equal(passwordProblem(problem(429, "rate_limited"), undefined, true), "Too many sign-in attempts. Wait a moment, then try again.");
    assert.equal(passwordProblem(problem(400, "local_login_disabled"), undefined, true), "Password sign-in is turned off on this server. Use your phone instead.");
    assert.equal(passwordProblem(problem(400, "local_login_disabled"), undefined, false), "Password sign-in is turned off on this server.");
    assert.equal(passwordProblem(problem(403, "not_permitted"), undefined, true), "Your account at the sign-in provider isn't allowed to use this server.");
});

test("the server entry, not-ready and password text reads in German", () => {
    inLanguage("de", () => {
        assert.equal(entryTitle(), "Gib deine\nServeradresse ein");
        assert.equal(entryTitle(), translate("setup.headline", undefined, "de"));
        assert.equal(entryLead(), translate("setup.body", undefined, "de"));
        assert.equal(invalidPort(), translate("setup.error.invalidPort", undefined, "de"));
        assert.equal(connectProblem({ status: "invalid_url", problem: "empty" }), "Bitte gib einen Server-Host ein.");
        assert.equal(connectProblem({ status: "unreachable" }), translate("setup.error.unreachable", undefined, "de"));
        assert.equal(cleartextTitle(), translate("setup.cleartext.title", undefined, "de"));
        assert.equal(cleartextWarning("silo.test"), "Dein Passwort und was du ansiehst, werden unverschlüsselt an silo.test gesendet. Tu das nur in einem Netzwerk, dem du vertraust.");
        assert.equal(cleartextDeclined(), translate("setup.error.httpsOnly", undefined, "de"));
        assert.equal(setupNeeded(), "Einrichtung nötig");
        assert.equal(serverNotReadyTitle(), translate("notReady.headline", undefined, "de"));
        assert.equal(serverNotReadyBody(), translate("notReady.body", undefined, "de"));
        assert.equal(stillNeedsSetup(), translate("notReady.still", undefined, "de"));
        assert.equal(setupUnreachable(), translate("notReady.unreachable", undefined, "de"));
        assert.equal(sessionExpiredNotice("Home"), "Du wurdest von Home abgemeldet. Melde dich erneut an.");
        assert.equal(passwordTitle(), "Mit Passwort\nanmelden");
        assert.equal(enterUsername(), translate("signIn.error.usernameMissing", undefined, "de"));
        assert.equal(enterPassword(), translate("signIn.error.passwordMissing", undefined, "de"));
        assert.equal(passwordLead("Home", false), translate("signIn.body", { server: "Home" }, "de"));
        assert.equal(passwordLead("Home", true), translate("tvSignIn.passwordOnly", undefined, "de"));
        assert.equal(phoneHint(["Google"]), "Wenn du dich mit Google anmeldest, verwende stattdessen dein Smartphone.");
        assert.equal(phoneHint(["Google", "Okta"]), "Wenn du dich per Single Sign-On anmeldest, verwende stattdessen dein Smartphone.");
        assert.equal(passwordProblem(problem(403, "account_disabled"), undefined, true), "Dieses Konto kann sich nicht anmelden. Wende dich an deinen Server-Administrator.");
        assert.equal(passwordProblem(problem(401, "invalid_credentials"), "Hinweis.", true), "Benutzername oder Passwort falsch. Hinweis.");
        assert.equal(passwordProblem(problem(401, "invalid_credentials"), undefined, true), translate("tvSignIn.error.invalidCredentials", undefined, "de"));
        assert.equal(passwordProblem(problem(400, "local_login_disabled"), undefined, true), translate("tvSignIn.error.localLoginDisabled", undefined, "de"));
        assert.equal(passwordProblem(problem(400, "local_login_disabled"), undefined, false), translate("signIn.error.passwordOff", undefined, "de"));
        assert.equal(passwordProblem(problem(429, "rate_limited"), undefined, true), translate("signIn.error.tooManyAttempts", undefined, "de"));
        assert.equal(passwordProblem(problem(422, "validation"), undefined, true), translate("signIn.error.checkCredentials", undefined, "de"));
        assert.equal(passwordProblem(problem(403, "email_in_use"), undefined, true), translate("signIn.error.emailInUse", undefined, "de"));
        assert.equal(passwordProblem(problem(403, "account_required"), undefined, true), translate("tvSignIn.error.accountRequired", undefined, "de"));
    });
});

test("the code screen's lead, status lines and actions read in German, and \"this Apple TV\" says \"this TV\"", () => {
    const englishLines = STATUSES.map(status => statusLine(status, "h"));
    inLanguage("de", () => {
        const lead = codeLead({ kind: "waiting", renewed: false }, "silo.test/activate");
        assert.equal(lead, "Scanne den Code mit der Kamera deines Smartphones oder öffne silo.test/activate und gib ihn dort ein. Bestätige auf deinem Smartphone, dann meldet sich dieses TV von selbst an.");
        assert.equal(codeLead({ kind: "waiting", renewed: false }, undefined), "Scanne den Code mit der Kamera deines Smartphones oder öffne die Seite /activate deines Servers und gib ihn dort ein. Bestätige auf deinem Smartphone, dann meldet sich dieses TV von selbst an.");
        assert.equal(codeLead({ kind: "denied" }, "x"), translate("tvSignIn.declinedLead", undefined, "de"));
        assert.equal(statusLine({ kind: "getting_code" }, "h"), "Anmeldecode wird abgerufen…");
        assert.equal(statusLine({ kind: "unreachable" }, "silo.test"), "silo.test ist nicht erreichbar. Überprüfe die Verbindung dieses Fernsehers.");
        assert.equal(statusLine({ kind: "approved", account: "laura" }, "h"), translate("tvSignIn.status.signedInAs", { account: "laura" }, "de"));
        assert.equal(statusLine({ kind: "waiting", renewed: true }, "h"), translate("tvSignIn.status.newCode", undefined, "de"));
        assert.equal(stateAction({ kind: "denied" }), "Neuen Code anzeigen");
        assert.equal(stateAction({ kind: "rate_limited" }), translate("common.tryAgain", undefined, "de"));
        assert.equal(stateAction({ kind: "getting_code" }), undefined);
        STATUSES.forEach((status, index) => assert.notEqual(statusLine(status, "h"), englishLines[index], `German reads ${status.kind}`));
    });
});

test("in Arabic a server, host, account or page inside a sentence is isolated, and the text is Arabic", () => {
    inLanguage("ar", () => {
        assert.equal(sessionExpiredNotice("Home"), `تم تسجيل خروجك من ${FSI}Home${PDI}. سجّل الدخول مرة أخرى.`);
        assert.equal(statusLine({ kind: "unreachable" }, "silo.test:8090"), `تعذّر الوصول إلى ${FSI}silo.test:8090${PDI}. تحقق من اتصال هذا التلفزيون.`);
        assert.equal(statusLine({ kind: "approved", account: "laura" }, "h"), translate("tvSignIn.status.signedInAs", { account: `${FSI}laura${PDI}` }, "ar"));
        assert.equal(cleartextWarning("silo.test"), translate("setup.cleartext.body", { host: `${FSI}silo.test${PDI}` }, "ar"));
        assert.equal(codeLead({ kind: "waiting", renewed: false }, "silo.test/activate"), translate("tvSignIn.appleTv.lead", { page: `${FSI}silo.test/activate${PDI}` }, "ar").replace(/Apple TV/gi, "TV"));
        assert.equal(passwordLead("Home", false), translate("signIn.body", { server: `${FSI}Home${PDI}` }, "ar"));
        assert.equal(phoneHint(["Google"]), translate("tvSignIn.form.providerHint", { provider: `${FSI}Google${PDI}` }, "ar"));
        assert.equal(entryTitle(), "أدخل عنوان\nخادمك");
        assert.equal(passwordTitle(), "تسجيل الدخول\nبكلمة المرور");
        assert.equal(stateAction({ kind: "paused" }), "عرض رمز جديد");
        assert.equal(passwordProblem(problem(401, "invalid_credentials"), "تلميح.", true), `اسم المستخدم أو كلمة المرور غير صحيحة. ${FSI}تلميح.${PDI}`);
    });
});

test("in Arabic the page path in the lead is isolated, so \"/activate\" does not read \"activate/\"", () => {
    inLanguage("ar", () => {
        const lead = codeLead({ kind: "waiting", renewed: false }, undefined);
        assert.ok(lead.includes(`${FSI}/activate${PDI}`), `the path is isolated: ${lead}`);
        assert.equal(lead.replaceAll(FSI, "").replaceAll(PDI, ""), translate("tvSignIn.appleTv.leadNoPage", undefined, "ar").replace(/Apple TV/gi, "TV"));
    });
    // English keeps its text byte for byte.
    assert.ok(!codeLead({ kind: "waiting", renewed: false }, undefined).includes(FSI));
});

test("a sentence Apple has no key for stays English in every language", () => {
    for (const tag of ["de", "ar"]) {
        inLanguage(tag, () => {
            assert.equal(connectProblem({ status: "server_error" }), "The server had a problem. Try again in a moment.");
            assert.equal(connectProblem({ status: "invalid_url", problem: "has_api_path" }), "Enter the server address without /api at the end.");
            assert.equal(connectProblem({ status: "invalid_url", problem: "unsupported_scheme" }), "Use an address that starts with https:// or http://.");
        });
    }
});
