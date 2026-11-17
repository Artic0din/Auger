// The passive first frame of an audiobook's detail, after silo-apple TVItemDetailLoadingView.audiobookLayout
// (main 6eea7cf). It paints what the opening card knew, in the loaded page's geometry, with quiet placeholders
// for the rest. Apple's frame takes no focus; the remote still needs one owner here, so the page itself holds
// focus, as the Details loading frame does, and Back leaves.

import { backdrop } from "./audiobookView.ts";
import type { View } from "./browseFocus.ts";
import type { DetailSeed } from "./browseModel.ts";
import { artwork, type ViewContext } from "./browseViews.ts";
import { el } from "./screen.ts";
import { integerText } from "../i18n/numbers.ts";
import { translate } from "../i18n/translate.ts";

export interface AudiobookLoadingRoute {
    readonly seed?: DetailSeed | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function placeholder(width: number, height: number, radius: number): HTMLElement {
    const bar = el("span", "details-loading-bar");
    bar.style.width = `${width}px`;
    bar.style.height = `${height}px`;
    bar.style.borderRadius = `${radius}px`;
    return bar;
}

export function audiobookLoadingView(route: AudiobookLoadingRoute, context: ViewContext, back: () => void): View {
    const seed = route.seed;
    const title = nonEmpty(seed?.title);
    // Apple draws a plain placeholder where the cover is missing; the blank factory keeps the thumbhash preview and nothing else.
    const cover = artwork("audiobook-cover", nonEmpty(seed?.posterUrl), context.baseUrl, () => el("span", "audiobook-loading-blank"), seed?.posterThumbhash);

    const titleSlot = el("div", "audiobook-loading-title");
    titleSlot.append(title === undefined ? placeholder(680, 80, 12) : el("h1", "audiobook-title", title));
    const year = el("div", "audiobook-loading-year-row");
    year.append(placeholder(250, 22, 6));
    if (seed?.year !== undefined) year.append(el("span", "audiobook-loading-year", integerText(seed.year)));
    const lines = el("div", "audiobook-loading-lines");
    lines.append(placeholder(280, 24, 6), placeholder(190, 18, 5));
    const state = el("div", "audiobook-loading-state");
    state.append(el("span", "audiobook-loading-ring"), lines);
    const actions = el("div", "audiobook-loading-actions");
    actions.append(placeholder(340, 64, 14), placeholder(200, 64, 14), placeholder(180, 64, 14));
    const identity = el("div", "audiobook-identity");
    identity.append(placeholder(180, 18, 5), titleSlot, year, state, actions);

    const hero = el("section", "audiobook-hero");
    hero.append(cover, identity);
    const page = el("div", "audiobook-page audiobook-loading");
    page.dataset.mediaType = "audiobook";
    page.tabIndex = 0;
    page.dataset.focus = "loading";
    page.setAttribute("aria-busy", "true");
    page.setAttribute("aria-label", title === undefined ? translate("detail.loadingDetails") : translate("detail.loadingDetailsFor", { title }));
    page.append(backdrop(nonEmpty(seed?.posterUrl), context.baseUrl), hero);
    return {
        name: "audiobook:loading",
        content: [page],
        zones: [{ id: "loading", layout: "row", items: [{ key: "loading", element: page }] }],
        focus: { zone: "loading", key: "loading" },
        back,
    };
}
