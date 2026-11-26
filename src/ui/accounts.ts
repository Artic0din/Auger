import { applyScreenDirection } from "../i18n/direction.ts";
import { shownLocale } from "../i18n/format.ts";
import { onCatalogLoaded, translate, translateTv } from "../i18n/translate.ts";
import { lateRedraw } from "./selectRelease.ts";
import { AccountDirectory, accountsByRecentUse, profileCountLabel, serversByRecentUse, type SavedAccount } from "../session/accounts.ts";
import type { ConnectedServer, SessionCoreDeps } from "../session/core.ts";
import { signOutSavedAccount } from "../session/core.ts";
import { FocusHost, type FocusItem } from "./browseFocus.ts";
import { actionButton } from "./browseViews.ts";
import { MarqueeBackdrop, marqueeScene } from "./marqueeBackdrop.ts";
import { systemClock } from "../api/clock.ts";
import { el } from "./screen.ts";
import { spinner } from "./marquee.ts";
import { cachedBranding } from "./brandingCache.ts";
import { navigationIcon } from "./navigationIcon.ts";
import { signOutConfirmationCopy, signOutRemovesServer } from "./signOutConfirmation.ts";
import { centredDialog } from "./confirmationDialog.ts";

export interface AccountsScreen { destroy(): void }
export function mountAccounts(root: HTMLElement, core: SessionCoreDeps, current: ConnectedServer | undefined,
    open: (account: SavedAccount | undefined, address?: string, inPlace?: boolean) => Promise<void> | void, back: () => void, manage = false, onCurrentSignOut?: () => void): AccountsScreen {
    const container = el("section", "accounts-screen");
    applyScreenDirection(container);
    const backdrop = new MarqueeBackdrop(core.clock ?? systemClock);
    // TVChangeAccountView does not write MarqueeScene. The stage stays wherever the previous
    // screen left it: 2 after Who's watching, 1 after a sign-in screen, 0 before a server answers.
    backdrop.setStage(marqueeScene.stage);
    backdrop.setAccent(current ? cachedBranding(core.publicStorage, current.server.http.base.baseUrl)?.accentColor : undefined);
    const scrim = el("div", "accounts-scrim");
    container.append(backdrop.element);
    root.append(container);
    const host = new FocusHost(container);
    const directory = current?.accounts.directory ?? new AccountDirectory(core.publicStorage, core.randomBytes);
    const activeAddress = current?.server.http.base.baseUrl;
    let selected = activeAddress;
    let paneEntry: string | undefined;
    let destroyed = false;
    let removalPending = false;
    /** ChangeAccountModel.openingAccountId: the account being opened while Change Account stays up. */
    let opening: { readonly id: string } | undefined;
    let overflow: readonly OverflowColumn[] = [];
    /** A confirmation, the expired-session dialog or an error is on screen in place of the list. */
    let dialogOpen = false;
    // A language file that lands after the screen drew (a cold start) redraws it in that language, once no dialog, press or operation is in the way.
    const late = lateRedraw(() => dialogOpen || removalPending || opening !== undefined, () => { applyScreenDirection(container); render(); });
    const stopCatalog = onCatalogLoaded(() => { if (!destroyed) late.arrived(); });
    const destroy = (): void => { if (destroyed) return; destroyed = true; stopCatalog(); late.clear(); for (const column of overflow) column.disconnect(); host.destroy(); backdrop.destroy(); container.remove(); };
    const go = (account: SavedAccount | undefined, address?: string): void => { if (opening !== undefined) return; destroy(); void open(account, address); };
    // The card spins until the app replaces this screen or the switch cannot open quietly. Like Apple, nothing cancels it.
    const choose = (row: SavedAccount): void => {
        if (opening !== undefined) return;
        if (row.needsSignIn || row.id === current?.accounts.localAccountId) { go(row); return; }
        const mine = { id: row.id };
        opening = mine;
        refresh();
        const settle = (failed: boolean, error?: unknown): void => {
            if (destroyed || opening !== mine) return;
            opening = undefined;
            if (failed) {
                const text = error instanceof Error && error.message.trim() !== "" ? error.message : "Could not open the account. Try again.";
                showError(text, host.focused()?.zone === "servers" ? "servers" : "accounts", row.id);
            } else refresh();
        };
        void (async () => open(row, undefined, true))().then(() => settle(false), (error: unknown) => settle(true, error));
    };
    /** Redraws in place: focus stays in the column it was in. */
    const refresh = (zone = host.focused()?.zone): void => { render(zone === "servers", zone === "accounts"); };
    const showError = (message: string, returnZone?: string, returnKey?: string): void => {
        // Draw the underlying list cleanly first so no card stays spinning and no prior dialog remains inert.
        if (manage) render();
        else render(returnZone === "servers");
        dialogOpen = true;
        const leave = (): void => {
            if (manage) render();
            else if (returnZone === "servers") render(true);
            else render(false, true, false, returnKey);
        };
        const ok = actionButton("ok", translate("shell.notice.ok"), leave);
        const behind = manage
            ? Array.from(container.querySelectorAll<HTMLElement>(".accounts-settings"))
            : Array.from(container.children).filter((node): node is HTMLElement =>
                node instanceof HTMLElement && !node.classList.contains("marquee-backdrop") && !node.classList.contains("accounts-scrim"));
        const dialog = centredDialog({ style: "alert", id: "accounts-error", title: translate("account.alertTitle"), message, buttons: [ok.element], behind });
        const content = manage ? dialog : [backdrop.element, scrim, ...dialog];
        host.show({ name: "accounts-error", content, zones: [{ id: "error", layout: "column", items: [ok] }], focus: { zone: "error", key: "ok" }, back: leave });
    };
    const confirm = (targets: readonly SavedAccount[], removeServer: boolean): void => {
        dialogOpen = true;
        const dismiss = (): void => { render(false, false, removeServer); };
        let panel: HTMLElement = el("div", "confirm-dialog");
        const cancel = actionButton("cancel", translate("common.cancel"), dismiss);
        const accept = actionButton("confirm", translate(removeServer ? "servers.remove.confirm" : "settings.accounts.signOut"), () => {
            if (removalPending) return;
            removalPending = true;
            cancel.element.setAttribute("disabled", "");
            accept.element.setAttribute("aria-disabled", "true");
            accept.element.textContent = removeServer ? "Removing…" : "Signing out…";
            panel.setAttribute("aria-busy", "true");
            accept.element.focus({ preventScroll: true });
            void (async () => {
                for (const row of targets) {
                    if (row.id === current?.accounts.localAccountId) onCurrentSignOut?.();
                    const cleared = row.id === current?.accounts.localAccountId ? (await current.session.logout()).storage : await signOutSavedAccount(row, core);
                    if (cleared === "failed") throw new Error("Could not remove the saved sign-in. Try again.");
                    directory.remove(row.id);
                }
                removalPending = false;
                if (!destroyed) render();
            })().catch((error: unknown) => { removalPending = false; if (!destroyed) showError(error instanceof Error ? error.message : "Could not sign out"); });
        });
        const address = targets[0]?.baseUrl;
        const serverName = address ? cachedBranding(core.publicStorage, address)?.serverName ?? new URL(address).host : translate("account.fallback.thisServer");
        const dialog = { id: "dialog", layout: "row" as const, skipDisabled: true, items: [cancel, accept] };
        const view = { name: "accounts-confirm", zones: [dialog], focus: { zone: "dialog", key: "cancel" }, back: dismiss };
        const removesServer = !removeServer && signOutRemovesServer(() => directory.list(), address, targets.length);
        const copy = removeServer
            ? {
                id: "accounts-remove",
                title: translate("servers.remove.title", { server: serverName }),
                message: targets.length === 1 ? translate("account.removeServer.signsOutOne", { account: targets[0]?.username ?? translate("account.fallback.itsAccount") })
                    : targets.length > 1 ? translate("account.removeServer.signsOutMany", { count: targets.length }) : "",
            }
            : { id: "accounts-signout", ...signOutConfirmationCopy(targets[0]?.username, serverName, removesServer) };
        // AccountRemovalConfirmation on tvOS: the same centred confirmation as Who's watching and Settings, over the settings pane.
        const behind = container.querySelector<HTMLElement>(".accounts-settings");
        const content = centredDialog({ style: "confirmation", id: copy.id, title: copy.title, message: copy.message,
            buttons: [cancel.element, accept.element], destructive: accept.element, behind: behind === null ? [] : [behind],
            onDismiss: () => { if (!removalPending) dismiss(); } });
        panel = content[content.length - 1] ?? panel;
        host.show({ ...view, content });
    };
    function render(railFocus = false, enterPane = false, focusFirst = false, accountKey?: string): void {
        if (removalPending) return;
        // Drawing the list afresh reads the shown language, so a redraw that was waiting is done.
        dialogOpen = false;
        applyScreenDirection(container);
        late.clear();
        const rows = accountsByRecentUse(directory.list());
        const addresses = serversByRecentUse(rows, activeAddress);
        if (manage) {
            const panel = el("div", "accounts-settings");
            const header = el("header", "accounts-settings-header");
            const icon = el("span", "accounts-settings-icon");
            icon.append(navigationIcon("switch-server"));
            icon.setAttribute("aria-hidden", "true");
            const copy = el("div", "");
            copy.append(el("h1", "", translate("accounts.title")), el("p", "", translateTv("servers.accounts.blurbAppleTv")));
            header.append(icon, copy); panel.append(header);
            const controls: FocusItem[] = [];
            const paneRow = (key: string, title: string, action: () => void, value?: string, destructive = false): FocusItem => {
                const item = actionButton(key, "", action);
                item.element.append(el("span", "accounts-row-title", title));
                if (value) item.element.append(el("span", "accounts-row-value", value));
                if (destructive) item.element.classList.add("accounts-destructive");
                else {
                    const arrow = el("span", "accounts-chevron");
                    const icon = navigationIcon("chevron-right");
                    icon.setAttribute("viewBox", "7 3 11 18");
                    arrow.append(icon); item.element.append(arrow);
                }
                return item;
            };
            for (const address of addresses) {
                const serverName = cachedBranding(core.publicStorage, address)?.serverName ?? new URL(address).host;
                panel.append(el("h2", "accounts-section-header", serverName.toUpperCase()));
                for (const row of rows.filter(row => row.baseUrl === address)) {
                    const detail = row.needsSignIn ? translate("accounts.badge.signInAgain") : profileCountLabel(row.profileCount);
                    const item = paneRow(row.id, row.username, () => row.needsSignIn ? expired(row) : confirm([row], false), detail);
                    controls.push(item); panel.append(item.element);
                }
                const add = paneRow(`add:${address}`, translate("accounts.addAccountOnServer", { server: serverName }), () => go(undefined, address));
                const remove = paneRow(`remove:${address}`, translate("settings.accounts.remove"), () => confirm(rows.filter(row => row.baseUrl === address), true), undefined, true);
                controls.push(add, remove); panel.append(add.element, remove.element);
            }
            const add = paneRow("add-server", translate("settings.accounts.addServer"), () => go(undefined));
            controls.push(add); panel.append(add.element, el("p", "signin-text", translateTv("settings.accounts.footerAppleTv")));
            container.classList.add("accounts-management");
            const entry = controls[0] === undefined ? undefined : { zone: "rows", key: controls[0].key };
            host.show({ name: "accounts-settings", content: [panel], zones: [{ id: "rows", layout: "column", items: controls }], focus: entry, back: () => { destroy(); back(); } }, focusFirst ? entry : undefined);
            return;
        }
        if (!addresses.includes(selected ?? "")) selected = addresses[0];
        const rail = el("div", "accounts-rail");
        const pane = el("div", "accounts-pane");
        const serverItems = addresses.map(address => {
            const brand = cachedBranding(core.publicStorage, address);
            const item = actionButton(address, brand?.serverName ?? new URL(address).host, () => { selected = address; render(false, true); });
            const mark = el("img", "accounts-server-mark"); mark.src = brand?.markUrl ?? "img/auger-mark.png"; mark.alt = "";
            item.element.prepend(mark);
            item.element.addEventListener("focus", () => { if (selected !== address) { selected = address; paneEntry = undefined; render(true); } });
            item.element.setAttribute("aria-selected", String(address === selected));
            return item;
        });
        const addServer = actionButton("add-server", translate("accounts.addServer"), () => go(undefined));
        const plus = el("span", "accounts-server-mark accounts-plus", "+"); plus.setAttribute("aria-hidden", "true");
        addServer.element.prepend(plus);
        serverItems.push(addServer);
        const accounts: FocusItem[] = rows.filter(row => row.baseUrl === selected).map(row => {
            const item = actionButton(row.id, "", () => choose(row));
            item.element.classList.add("account-card");
            const tile = el("span", row.needsSignIn ? "account-initial account-initial-dim" : "account-initial", row.username.slice(0, 1).toUpperCase());
            item.element.append(tile, el("span", "account-name", row.username));
            const name = item.element.lastElementChild!;
            const count = profileCountLabel(row.profileCount);
            if (count !== undefined) name.append(el("span", "account-count", count));
            if (opening?.id === row.id) { item.element.append(spinner()); item.element.setAttribute("aria-busy", "true"); }
            else if (row.needsSignIn) item.element.append(accountBadge(translate("accounts.badge.signInAgain").toLocaleUpperCase(shownLocale()), true));
            else if (row.id === current?.accounts.localAccountId) item.element.append(accountBadge(translate("changeAccount.current").toLocaleUpperCase(shownLocale()), false));
            return item;
        });
        const addAccount = actionButton("add-account", "", () => go(undefined, selected));
        const name = el("span", "account-name", translate("changeAccount.addAccount"));
        name.append(el("span", "account-count", translate("changeAccount.signInOn", { server: selected ? cachedBranding(core.publicStorage, selected)?.serverName ?? new URL(selected).host : translate("account.fallback.thisServer") })));
        addAccount.element.classList.add("account-card");
        addAccount.element.append(el("span", "account-initial", "+"), name);
        if (selected) accounts.push(addAccount);
        for (const item of accounts) item.element.addEventListener("focus", () => { paneEntry = item.key; });
        rail.append(...serverItems.map(item => item.element)); pane.append(...accounts.map(item => item.element));
        // The screen rebuilds on every server move; the keys carry each column's scroll across it (browseFocus).
        rail.dataset.scrollKey = "accounts-rail"; pane.dataset.scrollKey = `accounts-pane:${selected ?? ""}`;
        const previousColumns = overflow;
        const [previousRail, previousPane] = previousColumns;
        overflow = [overflowColumn(rail, "accounts-column-rail", previousRail), overflowColumn(pane, "accounts-column-pane", previousPane)];
        for (const column of previousColumns) column.disconnect();
        const columns = el("div", "accounts-columns"); columns.append(...overflow.map(column => column.element));
        const mark = el("img", "accounts-wordmark"); mark.src = "img/auger-wordmark.png"; mark.alt = "Auger";
        host.show({ name: "change-account", content: [backdrop.element, scrim, mark, el("h1", "accounts-title", translate("accounts.headline")), el("p", "signin-text", translate("accounts.body")), columns],
            zones: [{ id: "servers", layout: "column", right: "accounts", items: serverItems }, { id: "accounts", layout: "column", left: "servers", items: accounts }],
            focus: accounts.length === 0 ? { zone: "servers", key: "add-server" } : { zone: "accounts", key: accounts.find(row => row.key === current?.accounts.localAccountId)?.key ?? accounts[0]!.key },
            back: () => {
                if (host.focused()?.zone === "accounts") { render(true); return; }
                if (opening !== undefined) return;
                destroy(); back();
            } }, railFocus ? { zone: "servers", key: selected ?? "add-server" } : enterPane ? { zone: "accounts", key: accountKey ?? paneEntry ?? accounts.find(row => row.key === current?.accounts.localAccountId)?.key ?? accounts[0]!.key } : undefined);
        // Before the first paint, so the restored scroll never shows the chevrons fading back in.
        for (const column of overflow) column.sync();
    }
    function expired(row: SavedAccount): void {
        dialogOpen = true;
        const signin = actionButton("signin", translate("account.signInAgain"), () => go(row));
        const signout = actionButton("signout", translate("settings.accounts.signOut"), () => confirm([row], false));
        const cancel = actionButton("cancel", translate("common.cancel"), () => render());
        const controls = [signin, signout, cancel];
        const behind = container.querySelector<HTMLElement>(".accounts-settings");
        const content = centredDialog({
            style: "confirmation",
            id: "account-expired",
            title: translate("settings.accounts.expiredTitleAppleTv", { account: row.username }),
            message: "",
            buttons: controls.map(item => item.element),
            destructive: signout.element,
            behind: behind === null ? [] : [behind],
            onDismiss: () => render(),
        });
        host.show({ name: "account-expired", content, zones: [{ id: "choices", layout: "row", items: controls }], focus: { zone: "choices", key: "signin" }, back: () => render() });
    }
    host.listen(); render();
    return { destroy };
}

/** TVChangeAccountBadge: CURRENT, or SIGN IN AGAIN in the warning colour with the open lock. */
function accountBadge(text: string, warning: boolean): HTMLElement {
    const badge = el("span", warning ? "account-badge account-badge-warning" : "account-badge");
    if (warning) {
        const lock = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        lock.setAttribute("viewBox", "0 0 24 24");
        lock.setAttribute("aria-hidden", "true");
        const shackle = document.createElementNS(lock.namespaceURI, "path");
        shackle.setAttribute("d", "M8 11V7a4 4 0 0 1 7.6-1.7");
        shackle.setAttribute("fill", "none");
        shackle.setAttribute("stroke", "currentColor");
        shackle.setAttribute("stroke-width", "3");
        shackle.setAttribute("stroke-linecap", "round");
        const body = document.createElementNS(lock.namespaceURI, "path");
        body.setAttribute("d", "M5 10.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 20v-8A1.5 1.5 0 0 1 5 10.5Z");
        body.setAttribute("fill", "currentColor");
        lock.append(shackle, body);
        badge.append(lock);
    }
    badge.append(text);
    return badge;
}

const SVG_NS = "http://www.w3.org/2000/svg";

interface OverflowColumn { readonly element: HTMLElement; readonly scroller: HTMLElement; sync(): void; disconnect(): void }

/**
 * TVOverflowColumn: a scrolling column with a chevron row under it. Edges with rows hidden beyond them fade,
 * and the matching chevron shows. The data flags drive both in CSS; they clear within 1px of an end.
 */
function overflowColumn(scroller: HTMLElement, className: string, previous?: OverflowColumn): OverflowColumn {
    const wrapper = el("div", `accounts-column ${className}`);
    const chevrons = el("div", "accounts-chevrons");
    chevrons.setAttribute("aria-hidden", "true");
    for (const path of ["M6 15 12 9 18 15", "M6 9 12 15 18 9"]) {
        const icon = document.createElementNS(SVG_NS, "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        const line = document.createElementNS(SVG_NS, "path");
        line.setAttribute("d", path);
        icon.append(line);
        chevrons.append(icon);
    }
    // A rebuilt column starts from the flags it had, so its chevrons do not fade out and back in on every repaint.
    if (previous !== undefined && previous.scroller.dataset.scrollKey === scroller.dataset.scrollKey) {
        scroller.dataset.overflowAbove = previous.scroller.dataset.overflowAbove;
        scroller.dataset.overflowBelow = previous.scroller.dataset.overflowBelow;
    }
    const sync = (): void => {
        scroller.dataset.overflowAbove = String(scroller.scrollTop > 1);
        scroller.dataset.overflowBelow = String(scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1);
    };
    scroller.addEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(scroller);
    // The scroller's own box stays fixed when a row grows (a web font loading), so watch the rows too.
    for (const row of Array.from(scroller.children)) observer.observe(row);
    wrapper.append(scroller, chevrons);
    return { element: wrapper, scroller, sync, disconnect: () => observer.disconnect() };
}
