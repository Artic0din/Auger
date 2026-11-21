// Settings > Server > Acknowledgements: the outside services whose data Silo shows, then the open
// source code built into this app. Copy follows silo-apple 1a7ccee `Screens/Settings/ThirdPartyCredits.swift`
// and `OpenSourceAcknowledgementsView.swift` (TVOpenSourceAcknowledgementsOverlay), listing only the
// services this app names or shows.

import { translate } from "../i18n/translate.ts";
import { el } from "./screen.ts";

/** TMDB's approved "alt short" logo, shipped unmodified (app/third-party/README.md). */
export const TMDB_LOGO_PATH = "third-party/tmdb-logo.svg";

interface Credit {
    readonly name: string;
    readonly use: string;
    readonly notice?: string;
    readonly logo?: string;
}

/** Built when the document opens, so it reads in the language on screen. Lines Apple words differently stay as this app words them. */
const credits = (): readonly Credit[] => [
    // TMDB's API terms (section 3) require this notice and TMDB's logo wherever its data is shown.
    {
        name: "TMDB",
        use: "Ratings, and the search results and discovery rows in Requests.",
        notice: "This application uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.",
        logo: TMDB_LOGO_PATH,
    },
    { name: "IMDb", use: translate("settings.about.creditImdb") },
    { name: "YouTube", use: "Trailer thumbnails and listings supplied by your server." },
    { name: "Rotten Tomatoes", use: translate("settings.about.creditRottenTomatoes") },
    { name: "Common Sense Media and MDBList", use: translate("settings.about.creditAdvisoryAges") },
    { name: "Profile avatars", use: "Fun Emoji remixes Fun Emoji Set by Davis Uche, via DiceBear, under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Artwork source: https://www.figma.com/community/file/968125295144990435. Bottts Neutral uses Bottts by Pablo Stanley (https://bottts.com/), via DiceBear. Identicon and Pixel Art Neutral are by DiceBear, under CC0 1.0. Styles and terms: https://www.dicebear.com/licenses/. Generated avatars are displayed with circular or rounded cropping." },
];

const OPEN_SOURCE: readonly string[] = [
    "Auger for Samsung TV is free software under the GNU Affero General Public License, version 3 or later, and comes with no warranty. Source code: https://github.com/Artic0din/silo-tizen",
    "ThumbHash decoder by Evan Wallace — MIT License",
    "unicode-segmenter by Hyeseong Kim — MIT License",
    "uqr — MIT License",
];

/** The passive document: credits first, then the trademark and open source notices. */
export function acknowledgementsDocument(): HTMLElement {
    const document = el("div", "acknowledgements-document");
    for (const credit of credits()) {
        const row = el("div", "acknowledgements-credit");
        if (credit.logo !== undefined) {
            // The logo replaces the name, smaller than Silo's own marks as TMDB's terms ask.
            const logo = el("img", "acknowledgements-logo");
            logo.src = credit.logo;
            logo.alt = credit.name;
            row.appendChild(logo);
        } else {
            row.appendChild(el("p", "acknowledgements-name", credit.name));
        }
        row.appendChild(el("p", "acknowledgements-detail", credit.use));
        if (credit.notice !== undefined) row.appendChild(el("p", "acknowledgements-detail", credit.notice));
        document.appendChild(row);
    }
    document.appendChild(el("p", "acknowledgements-detail", translate("settings.about.trademarkNotice")));
    for (const line of OPEN_SOURCE) document.appendChild(el("p", "acknowledgements-license", line));
    return document;
}
