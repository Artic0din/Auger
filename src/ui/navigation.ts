import type { UserLibrary } from "../contracts/v2/catalog.ts";
import type { PrimaryMenu } from "../contracts/v2/navigation.ts";
import { type MessageKey, translate } from "../i18n/translate.ts";

export type NavigationRoot = { readonly key: "home" | "movies" | "series" | "music" | "audiobooks" | "for_you" | "calendar"; readonly title: string };

const LIBRARY_ROOT_TITLES = { movies: "topBar.movies", series: "topBar.series", music: "topBar.music" } as const satisfies Record<string, MessageKey>;

/** Apple TVRootDestination.visibleRoots: fixed roots filtered by visible library types. */
export function navigationRoots(_menu: PrimaryMenu | null, libraries: readonly UserLibrary[], _requests: boolean, showAudiobooks = false): NavigationRoot[] {
    const roots: NavigationRoot[] = [{ key: "home", title: translate("topBar.home") }];
    for (const key of ["movies", "series", "music"] as const) {
        if (libraries.some(library => library.type === key || (key !== "music" && library.type === "mixed"))) {
            roots.push({ key, title: translate(LIBRARY_ROOT_TITLES[key]) });
        }
    }
    // Audiobooks is opt-in (nav.show_audiobooks) and needs a library the profile can see.
    if (showAudiobooks && libraries.some(library => library.type === "audiobooks")) roots.push({ key: "audiobooks", title: translate("topBar.audiobooks") });
    return [...roots, { key: "for_you", title: translate("topBar.forYou") }, { key: "calendar", title: translate("topBar.calendar") }];
}
