import { mountApp, type AppOptions, type SiloApp } from "./app.ts";
import { loadShownLanguage } from "./i18n/load.ts";
import { platformOptions } from "./platform.ts";
import { actions, button, el, ScreenHost } from "./ui/screen.ts";
import { onCatalogLoaded, translate } from "./i18n/translate.ts";
import { lateRedraw } from "./ui/selectRelease.ts";

/** The screen shown when the platform's options cannot be read. Its button reads the shown language, and is drawn again if that language's file lands after the first draw (a cold launch fetches it while this draws). */
export function startupFailure(root: HTMLElement, retry: () => void): SiloApp {
    const host = new ScreenHost(root);
    root.classList.add("signin");
    const draw = (): void => {
        const again = button("retry", translate("common.tryAgain"), retry);
        host.show({ name: "startup-failed", content: [el("h1", "signin-title", "Silo could not start"), actions([again])], controls: [again], focus: "retry", back: undefined });
    };
    draw();
    const late = lateRedraw(() => false, draw);
    const stopCatalog = onCatalogLoaded(() => { late.arrived(); });
    return { destroy: () => { stopCatalog(); late.clear(); host.destroy(); root.classList.remove("signin"); } };
}

export function boot(root: HTMLElement, appVersion: string): SiloApp {
    // A TV set to Match Device starts fetching its own language before the profile says so.
    void loadShownLanguage();
    let current: SiloApp | undefined;
    const start = (): void => {
        current?.destroy();
        let options: AppOptions;
        try {
            options = platformOptions(appVersion);
        } catch {
            current = startupFailure(root, start);
            return;
        }
        current = mountApp(root, options);
    };
    start();
    return { destroy: () => current?.destroy() };
}
