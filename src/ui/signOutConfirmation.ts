import { translate } from "../i18n/translate.ts";

/** What Apple's `DeviceNoun` says for this device: the catalog's `{device}` reads "this TV" here, as Settings does. */
const DEVICE_NOUN = "TV";

/**
 * Apple tvOS sign-out confirmation (`confirmSignOut` / `signOutMessage` in
 * `AppRouter+Accounts.swift`, silo-apple 2ef3a171). "this TV" stands in for
 * DeviceNoun "Apple TV". This TV does not keep downloads, so that sentence is omitted.
 */

/** True when this sign-out leaves the server with no saved account, so the TV removes it. An unreadable directory reports false. */
export function signOutRemovesServer(readAccounts: () => readonly { readonly baseUrl: string }[], baseUrl: string | undefined, signingOut = 1): boolean {
    try {
        return readAccounts().filter(row => row.baseUrl === baseUrl).length === signingOut;
    } catch {
        return false;
    }
}

export function signOutConfirmationCopy(accountName: string | undefined, serverName: string | undefined, removesServer: boolean): { readonly title: string; readonly message: string } {
    const account = accountName?.trim() || translate("account.fallback.thisAccount");
    const server = serverName?.trim() || translate("account.fallback.thisServer");
    const message = removesServer
        ? translate("account.signOut.leavesRemovingServer", { device: DEVICE_NOUN, server })
        : translate("account.signOut.leaves", { device: DEVICE_NOUN });
    return { title: translate("shell.signOut.titleNamed", { account, server }), message };
}
