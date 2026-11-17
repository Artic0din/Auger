// Person hero facts and portrait. Age and dates follow the tvOS person page at
// silo-apple f334794 (unchanged at 1a7ccee): a Gregorian YYYY-MM-DD, local
// calendar components, age only while the person is living.

import type { Person } from "../contracts/v2/details.ts";
import { graphemeSegments } from "unicode-segmenter/grapheme";
import { isolated } from "../i18n/direction.ts";
import { deviceLanguages, formattingLocale, shownLanguage } from "../i18n/language.ts";
import { translate } from "../i18n/translate.ts";
import { artworkUrl } from "./browseModel.ts";
import { el } from "./screen.ts";
import { thumbhashCanvas } from "./heroBackdrop.ts";
import { episodeAirDate } from "./episodeCaption.ts";

const PERSON_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDate {
    readonly year: number;
    readonly month: number;
    readonly day: number;
}

/** A real Gregorian calendar day. Invalid and non-`YYYY-MM-DD` values are absent. */
function parsePersonDate(value: string | undefined): CalendarDate | undefined {
    const trimmed = value?.trim();
    const match = trimmed === undefined ? null : PERSON_DATE.exec(trimmed);
    if (trimmed === undefined || trimmed === "" || match === null) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    // Local components only. `new Date("YYYY-MM-DD")` is UTC and can shift the day.
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined;
    return { year, month, day };
}

/**
 * A date-only value as the pages show it outside the Person page (the marquee's aired date): the shared medium air-date form in every language.
 * Blank is no date, and a value that is not an ISO date shows as sent.
 */
export function airDateText(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    return parsePersonDate(trimmed) === undefined ? trimmed : episodeAirDate(trimmed);
}

/**
 * silo-apple `formattedPersonDate` (PersonDetailView.swift:903-906): `LocaleFormat.dateFormatter(dateStyle: .medium, calendar: Calendar(identifier: .gregorian))`
 * in `AppLanguage.formattingLocale`, the device's locale with its language replaced (AppLanguage.swift:50-61; LocaleFormat.swift:168-184).
 * English reads that medium date, the one the air dates use. Only a person's Born and Died use this function; every other date goes through `airDateText`.
 *
 * shortcut: outside English the source does not explain what Apple TV draws. `.medium` in `de` is "17.08.1943", yet the S95C-paired Apple TV
 * captures show "17/8/1943" and "١٧/٨/١٩٤٣": the region's numeric order, no leading zeros, the language's digits. The one unusual step in the source is
 * `formatter.calendar = <gregorian built without a locale>` between the locale and `dateStyle` (LocaleFormat.swift:179-180), whose effect on the pattern is
 * Foundation's, not the source's. This writes what the captures show; recheck it against Apple TV with another region or language, and replace it by
 * the exact pattern if Foundation's rule is found. `deviceLocale` is for tests; the app reads the TV's.
 */
export function formatPersonDate(value: string | undefined, deviceLocale: string | undefined = deviceLanguages()[0]): string | undefined {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed === "") return undefined;
    const parsed = parsePersonDate(trimmed);
    if (parsed === undefined) return trimmed;
    const language = shownLanguage();
    if (new Intl.Locale(language).language === "en") return episodeAirDate(trimmed);
    // The shown language's digits: a system the device chose itself (`-u-nu-`) or Arabic's Arabic-Indic (`formattingLocale`), else the language's own default.
    // `Intl.Locale.numberingSystem` is only an explicit setting, so the default is read from a formatter; without it the region's own digits would leak in.
    const digits = new Intl.Locale(formattingLocale(language, deviceLocale)).numberingSystem ?? new Intl.NumberFormat(language).resolvedOptions().numberingSystem;
    const region = new Intl.Locale(deviceLocale ?? language, { calendar: "gregory", numberingSystem: digits });
    const date = new Date(0);
    date.setFullYear(parsed.year, parsed.month - 1, parsed.day);
    date.setHours(12, 0, 0, 0);
    return new Intl.DateTimeFormat(region.toString(), { day: "numeric", month: "numeric", year: "numeric" }).formatToParts(date)
        // Day and month are written as numbers, not two-digit fields, whichever digits the language uses.
        .map(part => (part.type === "day" || part.type === "month") && part.value.length > 1 ? part.value.replace(/^[0\u0660\u06F0]/, "") : part.value).join("");
}

/** Whole years from `birthValue` to `today`'s local date, or absent when that is not a living age. */
export function personAge(birthValue: string | undefined, today: Date): number | undefined {
    const birth = parsePersonDate(birthValue);
    if (birth === undefined) return undefined;
    let years = today.getFullYear() - birth.year;
    const month = today.getMonth() + 1;
    const day = today.getDate();
    if (month < birth.month || (month === birth.month && day < birth.day)) years -= 1;
    return years >= 0 ? years : undefined;
}

/** Born, then either Died or a living age, then birthplace. Blank facts are omitted. */
export function personMetadataBadges(person: { readonly birthDate?: string | undefined; readonly deathDate?: string | undefined; readonly birthplace?: string | undefined }, today: Date, deviceLocale: string | undefined = deviceLanguages()[0]): string[] {
    const badges: string[] = [];
    const birth = formatPersonDate(person.birthDate, deviceLocale);
    if (birth !== undefined) badges.push(translate("person.born", { date: isolated(birth) }));
    const death = formatPersonDate(person.deathDate, deviceLocale);
    if (death !== undefined) badges.push(translate("person.died", { date: isolated(death) }));
    else {
        const age = personAge(person.birthDate, today);
        if (age !== undefined) badges.push(translate("person.yearsOld", { count: age }));
    }
    const birthplace = person.birthplace?.trim();
    if (birthplace !== undefined && birthplace !== "") badges.push(birthplace);
    return badges;
}

/** First grapheme of each of the first two space-separated words, or "?". */
export function personInitials(name: string): string {
    const value = name.split(" ").filter(word => word !== "").slice(0, 2).map(firstGrapheme).join("").toLocaleUpperCase("en-US");
    return value === "" ? "?" : value;
}

function firstGrapheme(word: string): string {
    // Chromium 108's Intl.Segmenter (ICU 72) lacks the Unicode 15.1 Indic conjunct rule.
    return graphemeSegments(word).next().value?.segment ?? "";
}

/**
 * The person portrait. No photo shows initials. A photo shows its thumbhash
 * underneath until the image loads, and drops the request when the portrait leaves the page.
 */
export function personPortrait(person: Person, baseUrl: string): HTMLElement {
    const box = el("div", "person-portrait browse-art browse-detail-art");
    const src = photoSource(person.photoUrl, baseUrl);
    if (src === undefined) {
        box.classList.add("browse-art-missing");
        box.dataset.personPortrait = "initials";
        box.appendChild(el("span", "person-portrait-initials", personInitials(person.name)));
        return box;
    }
    box.dataset.personPortrait = "loading";
    const preview = thumbhashCanvas(person.photoThumbhash, "person-portrait-thumbhash");
    if (preview !== undefined) box.appendChild(preview);
    const image = el("img", "person-portrait-photo browse-art-image");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    let closed = false;
    const observer = new MutationObserver(() => {
        if (!box.isConnected) cancel();
    });
    const cancel = (): void => {
        if (closed) return;
        closed = true;
        image.onload = null;
        image.onerror = null;
        // Replacing the URL aborts the in-flight photo. An empty string would fetch the page itself.
        image.src = "data:,";
        image.removeAttribute("src");
        observer.disconnect();
    };
    image.onload = () => {
        if (closed || !box.isConnected) {
            cancel();
            return;
        }
        box.dataset.personPortrait = "loaded";
    };
    image.onerror = () => {
        if (closed || !box.isConnected) {
            cancel();
            return;
        }
        closed = true;
        observer.disconnect();
        image.onload = null;
        image.onerror = null;
        image.remove();
        box.classList.add("browse-art-missing");
        box.dataset.personPortrait = "error";
        const mark = el("span", "person-portrait-missing");
        mark.setAttribute("aria-hidden", "true");
        box.appendChild(mark);
    };
    box.appendChild(image);
    queueMicrotask(() => {
        if (closed || !box.isConnected) {
            cancel();
            return;
        }
        observer.observe(document.documentElement, { childList: true, subtree: true });
        image.src = src;
    });
    return box;
}

function photoSource(reference: string | undefined, baseUrl: string): string | undefined {
    const trimmed = reference?.trim();
    return trimmed === undefined || trimmed === "" ? undefined : artworkUrl(trimmed, baseUrl);
}

