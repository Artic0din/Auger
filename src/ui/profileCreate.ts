import { ApiError } from "../api/errors.ts";
import { operations } from "../api/operations.ts";
import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { ProfileCreateBody, ProfileSummary } from "../contracts/v2/wire.ts";
import type { ConnectedServer } from "../session/core.ts";
import { ProfileManagement } from "../session/profileManagement.ts";
import { errorMessage, errorState } from "./errorState.ts";
import { markEnglishOnly } from "../i18n/direction.ts";
import { integerText } from "../i18n/numbers.ts";
import { onCatalogLoaded, translate, type MessageKey } from "../i18n/translate.ts";
import { centredDialog } from "./confirmationDialog.ts";
import { pinProblem, pinScreen } from "./pinScreen.ts";
import { profileAvatar } from "./profilePicker.ts";
import { PROFILE_STYLES, profilePresets } from "./profilePresets.ts";
import { actions, button, el, type Control, type Screen } from "./screen.ts";
import { lateRedraw } from "./selectRelease.ts";

const CONTENT_RATINGS = [
    ["G", "newProfile.rating.g"],
    ["PG", "newProfile.rating.pg"],
    ["PG-13", "newProfile.rating.pg13"],
    ["R", "newProfile.rating.r"],
] as const satisfies readonly (readonly [string, MessageKey])[];

export interface ProfileCreateFlow { destroy(): void; }
interface Options {
    readonly server: ConnectedServer;
    readonly profiles: readonly ProfileSummary[];
    readonly show: (screen: Screen, focus?: string) => void;
    readonly finished: (profileId?: string, uncertain?: boolean) => void;
}

export function createProfileFlow(options: Options): ProfileCreateFlow {
    const management = new ProfileManagement(options.server);
    const controller = new AbortController();
    const bootstrap = options.profiles.length === 0;
    let ended = false;
    let submitting = false;
    let name = "", pin = "", style = "fun-emoji", batch = 0, selected = 0;
    let child = false, restricted = false, rating = "PG";
    const allowed = new Set<string>();
    let libraries: UserLibrary[] | undefined;
    let librariesFailed = false;
    let librariesError = "";
    let alert: { readonly title: string; readonly message: string; readonly returnFocus: string } | undefined;
    let updateLibraries = (): void => undefined;
    let redrawer: (() => void) | undefined;

    let blurTimer: number | undefined;
    let blurredField: HTMLInputElement | undefined;
    let catalogWaiting = false;
    const cancelPendingResume = (): void => {
        if (blurTimer !== undefined) { window.clearTimeout(blurTimer); blurTimer = undefined; }
        if (blurredField !== undefined) { blurredField.removeEventListener("blur", onFieldBlur); blurredField = undefined; }
    };
    const onFieldBlur = (): void => {
        if (blurTimer !== undefined) window.clearTimeout(blurTimer);
        blurTimer = window.setTimeout(() => {
            blurTimer = undefined;
            blurredField = undefined;
            if (!ended && catalogWaiting) late.arrived();
        }, 0);
    };
    const editing = (): boolean => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && (active.dataset.focus === "create-name" || active.dataset.focus === "create-pin")) {
            if (blurredField !== active) {
                blurredField?.removeEventListener("blur", onFieldBlur);
                blurredField = active;
                active.addEventListener("blur", onFieldBlur, { once: true });
            }
            return true;
        }
        return false;
    };
    const late = lateRedraw(editing, () => { catalogWaiting = false; cancelPendingResume(); if (!ended) redrawer?.(); });
    const stopCatalog = onCatalogLoaded(() => { catalogWaiting = true; late.arrived(); });
    const destroy = (): void => { ended = true; redrawer = undefined; catalogWaiting = false; cancelPendingResume(); stopCatalog(); late.clear(); controller.abort(); management.close(); pin = ""; };
    const finish = (profileId?: string, uncertain = false): void => {
        try { destroy(); }
        catch {
            const heading = el("h1", "signin-title", "Could not leave profile management");
            markEnglishOnly(heading, "Could not leave profile management");
            const retry = button("cleanup-retry", translate("common.tryAgain"), () => finish(profileId, uncertain));
            options.show({ name: "profile-cleanup", content: [heading, actions([retry])], controls: [retry], focus: retry.key, back: undefined, translated: true });
            return;
        }
        options.finished(profileId, uncertain);
    };
    const showProblem = (line: string): void => {
        redrawer = undefined;
        catalogWaiting = false;
        cancelPendingResume();
        late.clear();
        const heading = el("h1", "signin-title", "Profile could not be created");
        const detail = el("p", "signin-text signin-error", line);
        detail.setAttribute("role", "alert");
        const back = button("creation-back", "Choose profile", () => finish(undefined, submitting));
        markEnglishOnly(heading, "Profile could not be created");
        markEnglishOnly(detail, line);
        markEnglishOnly(back.element, "Choose profile");
        options.show({ name: "profile-create-error", content: [heading, detail, actions([back])], controls: [back], focus: back.key, back: () => finish(undefined, submitting) });
    };
    const loadLibraries = (): void => {
        librariesFailed = false;
        librariesError = "";
        void options.server.session.call({ ...operations.listUserLibraries(), profileScoped: true, signal: controller.signal }).then(found => {
            if (ended) return;
            libraries = found;
            updateLibraries();
        }, (failure: unknown) => {
            if (!ended) {
                librariesFailed = true;
                librariesError = errorMessage(errorState(failure));
                updateLibraries();
            }
        });
    };

    const render = (focus = "create-name"): void => {
        if (ended) return;
        catalogWaiting = false;
        cancelPendingResume();
        late.clear();
        const controls: Control[] = [];
        updateLibraries = () => undefined;
        let drawLibraries: (() => void) | undefined;
        let row = 0;
        const column = el("div", "profile-create-controls");
        const section = (title: string, content: HTMLElement, trailing?: HTMLElement): void => {
            const block = el("section", "profile-create-section");
            const heading = el("div", "profile-create-section-heading");
            heading.appendChild(el("h2", "profile-create-label", title));
            if (trailing !== undefined) heading.appendChild(trailing);
            block.append(heading, content);
            column.appendChild(block);
        };
        const rowButton = (key: string, label: string, run: () => void): Control => {
            const control = { ...button(key, label, () => { if (!submitting) run(); }), row };
            controls.push(control);
            return control;
        };
        const styles = el("div", "profile-style-row");
        for (const [id, key] of PROFILE_STYLES) {
            const control = rowButton(`style:${id}`, translate(key), () => { style = id; selected = 0; render(`style:${id}`); });
            control.element.setAttribute("aria-pressed", String(style === id));
            styles.appendChild(control.element);
        }
        row++;
        section(translate("profiles.form.style"), styles);
        const presets = profilePresets(style, batch);
        if (style !== "initials") {
            const shuffle = rowButton("shuffle-avatars", translate("profiles.form.shuffleAvatars"), () => { batch++; selected = 0; render("shuffle-avatars"); });
            const grid = el("div", "profile-preset-grid");
            presets.forEach((reference, index) => {
                row = 2 + Math.floor(index / 6);
                const control = rowButton(`preset:${index}`, translate("profiles.avatar.preset", { seed: integerText(index + 1) }), () => { selected = index; render(`preset:${index}`); });
                control.element.className = "profile-preset";
                control.element.setAttribute("aria-pressed", String(selected === index));
                const avatar = profileAvatar({ id: `preset-${index}`, name, hasPin: false, isPrimary: false, isChild: child, avatar: reference, avatarUrl: undefined }, options.server.server.http.base.baseUrl, 88);
                avatar.style.background = "none";
                avatar.querySelector(".navigation-avatar-fallback")?.remove();
                control.element.appendChild(avatar);
                grid.appendChild(control.element);
            });
            row = 5;
            section(translate("profiles.form.avatar"), grid, shuffle.element);
        } else section(translate("profiles.form.avatar"), el("p", "signin-text", translate("profiles.form.initialsTitle")));
        const nameInput = el("input", "signin-input");
        nameInput.id = "create-profile-name";
        nameInput.setAttribute("aria-label", translate("newProfile.namePlaceholder"));
        nameInput.value = name; nameInput.maxLength = 64; nameInput.autocomplete = "off";
        nameInput.setAttribute("data-focus", "create-name");
        controls.push({ key: "create-name", element: nameInput, row: row++, done: "create-pin" });
        section(translate("newProfile.name"), nameInput);
        const pinInput = el("input", "signin-input");
        pinInput.id = "create-profile-pin";
        pinInput.setAttribute("aria-label", translate("newProfile.pinPlaceholder"));
        pinInput.type = "password"; pinInput.inputMode = "numeric"; pinInput.maxLength = 4;
        pinInput.value = pin; pinInput.autocomplete = "off";
        pinInput.setAttribute("data-focus", "create-pin");
        controls.push({ key: "create-pin", element: pinInput, row: row++, done: "create-submit" });
        const pinHint = el("p", "profile-create-pin-hint", translate("newProfile.pinHint"));
        pinHint.id = "profile-create-pin-hint";
        pinHint.setAttribute("role", "status");
        pinInput.setAttribute("aria-describedby", pinHint.id);
        const pinAcceptable = (): boolean => pin === "" || /^\d{4}$/.test(pin);
        const isValid = (): boolean => name.trim() !== "" && pinAcceptable();
        const syncPinHint = (): void => { pinHint.hidden = pinAcceptable(); };
        syncPinHint();
        const pinBlock = el("div", "profile-create-pin-block");
        pinBlock.append(pinInput, pinHint);
        section(translate("newProfile.pin"), pinBlock);
        if (!bootstrap) {
            const switchGroup = el("div", "profile-create-switch");
            const toggle = rowButton("create-child", `${translate("newProfile.child")}: ${translate(child ? "newProfile.on" : "newProfile.off")}`, () => { child = !child; render("create-child"); });
            row++;
            const switchDetail = el("p", "profile-create-switch-detail", translate("newProfile.childDetail"));
            switchDetail.id = "profile-create-child-detail";
            toggle.element.setAttribute("aria-describedby", switchDetail.id);
            switchGroup.append(toggle.element, switchDetail);
            column.appendChild(switchGroup);
            if (child) {
                const ratingOption = CONTENT_RATINGS.find(([value]) => value === rating) ?? CONTENT_RATINGS[1];
                const limit = rowButton("create-rating", `${translate("newProfile.rating")}: ${translate(ratingOption[1])}`, () => {
                    const index = CONTENT_RATINGS.findIndex(([value]) => value === rating);
                    rating = (CONTENT_RATINGS[(index + 1) % CONTENT_RATINGS.length] ?? CONTENT_RATINGS[1])[0];
                    render("create-rating");
                });
                row++; column.appendChild(limit.element);
                const access = rowButton("create-libraries", `${translate("newProfile.restrict")}: ${translate(restricted ? "newProfile.on" : "newProfile.off")}`, () => { restricted = !restricted; render("create-libraries"); });
                row++; column.appendChild(access.element);
                if (restricted) {
                    const slot = el("div", "profile-library-options");
                    const firstRow = row;
                    let previous: Control[] = [];
                    drawLibraries = () => {
                        const active = document.activeElement;
                        const key = active instanceof HTMLElement ? active.dataset.focus : undefined;
                        for (const old of previous) { const index = controls.indexOf(old); if (index >= 0) controls.splice(index, 1); }
                        const content: HTMLElement[] = [];
                        previous = [];
                        if (libraries === undefined) {
                            content.push(el("p", "signin-text", librariesFailed ? translate("newProfile.librariesFailedDetail", { message: librariesError }) : translate("newProfile.librariesLoading")));
                            if (librariesFailed) { const retry = { ...button("libraries-retry", translate("profiles.access.retry"), loadLibraries), row: firstRow }; previous.push(retry); content.push(retry.element); }
                        } else if (libraries.length === 0) {
                            content.push(el("p", "signin-text", translate("newProfile.librariesEmpty")));
                        } else {
                            content.push(el("p", "profile-create-subheading", translate("newProfile.allowed")));
                            for (const library of libraries) {
                                const control = { ...button(`library:${library.id}`, `${library.name}: ${allowed.has(library.id) ? "Allowed" : "Blocked"}`, () => {
                                    if (submitting) return;
                                    if (allowed.has(library.id)) allowed.delete(library.id); else allowed.add(library.id);
                                    drawLibraries?.();
                                }), row: firstRow + previous.length };
                                control.element.setAttribute("aria-pressed", String(allowed.has(library.id)));
                                previous.push(control); content.push(control.element);
                            }
                        }
                        slot.replaceChildren(...content);
                        for (let index = 0; index < controls.length; index++) {
                            const control = controls[index];
                            if (control?.key === "create-submit") controls[index] = { ...control, row: firstRow + previous.length };
                        }
                        const index = controls.findIndex(control => control.key === "create-submit");
                        controls.splice(index < 0 ? controls.length : index, 0, ...previous);
                        if (active !== null && !active.isConnected) (controls.find(control => control.key === key) ?? controls.find(control => control.key === "create-submit"))?.element.focus();
                    };
                    column.appendChild(slot);
                }
            }
        }
        const submit = rowButton("create-submit", submitting ? "Creating profile" : translate("newProfile.create"), () => {
            name = nameInput.value; pin = pinInput.value;
            if (!isValid()) return;
            if (child && restricted && (libraries === undefined || allowed.size === 0)) {
                alert = { title: translate("newProfile.error.libraryTitle"), message: translate("newProfile.error.library"), returnFocus: "create-libraries" };
                render();
                return;
            }
            const body: ProfileCreateBody = { name: name.trim(), ...(style === "initials" ? {} : { avatar: presets[selected] }), ...(pin === "" ? {} : { pin }),
                ...(!bootstrap ? { is_child: child, ...(child ? { max_content_rating: rating, library_restrictions_enabled: restricted, ...(restricted ? { allowed_library_ids: [...allowed].sort() } : {}) } : {}) } : {}) };
            submitting = true; pin = ""; pinInput.value = "";
            syncPinHint();
            updatePreview();
            submit.element.setAttribute("aria-disabled", "false");
            submit.element.textContent = "Creating profile";
            markEnglishOnly(submit.element, "Creating profile");
            void management.create(body, controller.signal).then(profile => { if (!ended) finish(profile.id); }, (failure: unknown) => {
                if (ended) return;
                const httpStatus = failure instanceof ApiError ? failure.status : undefined;
                const certain = httpStatus !== undefined && [400, 403, 409, 422].includes(httpStatus);
                if (certain) {
                    submitting = false;
                    const title = httpStatus !== undefined && [403, 409, 422].includes(httpStatus)
                        ? translate("newProfile.refused.title")
                        : translate("newProfile.error.title");
                    const reason = failure instanceof ApiError && failure.failure.kind === "problem" && failure.failure.problem.detail?.trim()
                        ? failure.failure.problem.detail
                        : errorMessage(errorState(failure));
                    alert = { title, message: reason, returnFocus: "create-name" };
                    render();
                } else showProblem("The request may already have created this profile. Check the profile list before trying again.");
            });
        });
        if (submitting) markEnglishOnly(submit.element, "Creating profile");
        const syncValidity = (): void => {
            submit.element.setAttribute("aria-disabled", String(!submitting && !isValid()));
        };
        syncValidity();
        column.appendChild(actions([submit]));
        const preview = el("div", "profile-create-preview");
        const tilePreview = el("div", "profile-create-preview-tile");
        const previewHint = el("p", "profile-create-preview-hint", translate("newProfile.preview"));
        preview.append(tilePreview, previewHint);
        const updatePreview = (): void => {
            const previewName = name === "" ? translate("newProfile.previewName") : name;
            tilePreview.replaceChildren(
                profileAvatar({ id: "new-profile", name: previewName, hasPin: pin !== "", isPrimary: false, isChild: child, avatarUrl: undefined, ...(style === "initials" ? {} : { avatar: presets[selected] }) }, options.server.server.http.base.baseUrl),
                el("h2", "profile-name", previewName),
            );
            previewHint.hidden = name.trim() !== "";
        };
        nameInput.addEventListener("input", () => { name = nameInput.value; updatePreview(); syncValidity(); });
        pinInput.addEventListener("input", () => { pin = pinInput.value.replace(/\D/g, "").slice(0, 4); pinInput.value = pin; syncPinHint(); updatePreview(); syncValidity(); });
        updatePreview();
        const header = el("div", "profile-create-header");
        const headerCancel = { ...button("create-header-cancel", translate("common.cancel"), () => finish(undefined, submitting)), row: -1 };
        const closeIcon = el("span", "profile-create-cancel-icon");
        closeIcon.setAttribute("aria-hidden", "true");
        closeIcon.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 3l10 10M13 3 3 13"/></svg>';
        headerCancel.element.prepend(closeIcon);
        controls.unshift(headerCancel);
        const heading = el("div", "profile-create-heading");
        heading.append(el("h1", "profile-create-title", translate("newProfile.title")), el("p", "profile-create-subtitle", translate("newProfile.pickLook")));
        header.append(heading, headerCancel.element);
        const body = el("div", "profile-create-body"); body.append(preview, column);
        redrawer = () => {
            const active = document.activeElement;
            const currentFocus = active instanceof HTMLElement ? active.dataset.focus : undefined;
            render(currentFocus ?? focus);
        };
        if (alert !== undefined) {
            drawLibraries?.();
            updateLibraries = () => undefined;
            const currentAlert = alert;
            const dismiss = (): void => {
                alert = undefined;
                render(currentAlert.returnFocus);
            };
            const ok = button("refusal-ok", translate("newProfile.ok"), dismiss);
            options.show({
                name: "profile-create:alert",
                content: centredDialog({
                    style: "alert",
                    id: "profile-create-refused",
                    title: currentAlert.title,
                    message: currentAlert.message,
                    buttons: [ok.element],
                    behind: [header, body],
                }),
                controls: [ok],
                focus: "refusal-ok",
                back: dismiss,
                translated: true,
            }, "refusal-ok");
            return;
        }
        options.show({ name: "profile-create", content: [header, body], controls, focus, back: () => finish(undefined, submitting), translated: true }, focus);
        updateLibraries = drawLibraries ?? (() => undefined);
        drawLibraries?.();
    };

    const ready = (): void => { render(); if (!bootstrap) loadLibraries(); };
    const begin = management.begin(options.profiles);
    if (begin === "ready") ready();
    else if (begin === "pin_required" && management.primaryProfile !== undefined) {
        const primary = management.primaryProfile;
        const screen = pinScreen(primary, options.server.server.http.base.baseUrl, [], pin => {
            void management.verifyPin(pin, controller.signal).then(result => {
                if (ended) return;
                if (result.status === "verified") ready();
                else screen.reject(pinProblem(result), result.status === "wrong_pin" || result.status === "locked");
            }, () => { if (!ended) screen.reject("The PIN could not be checked. Try again.", false); });
        }, () => finish());
        options.show(screen.screen);
    } else showProblem(begin === "primary_missing" ? "The primary household profile is unavailable." : "Profile management ended. Choose a profile again.");
    return { destroy };
}
