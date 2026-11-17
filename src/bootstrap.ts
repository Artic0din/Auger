import { mountApp, type AppOptions, type SiloApp } from "./app.ts";
import { loadShownLanguage } from "./i18n/load.ts";
import { platformOptions } from "./platform.ts";
import { actions, button, el, ScreenHost } from "./ui/screen.ts";

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
            const host = new ScreenHost(root);
            root.classList.add("signin");
            const retry = button("retry", "Try again", start);
            host.show({ name: "startup-failed", content: [el("h1", "signin-title", "Silo could not start"), actions([retry])], controls: [retry], focus: "retry", back: undefined });
            current = { destroy: () => { host.destroy(); root.classList.remove("signin"); } };
            return;
        }
        current = mountApp(root, options);
    };
    start();
    return { destroy: () => current?.destroy() };
}
