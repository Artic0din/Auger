import { translate, translateTv } from "../i18n/translate.ts";
import type { LaunchBehavior } from "../session/profileLaunch.ts";

// TVGeneralSettingsView.swift:24-33,213-230 and AppleTVUserContext.swift:18-23
// at silo-apple e28300c6. Tizen has no TVUserManager, so this is Apple's branch
// for a context that does not keep a separate pairing, with "Apple TV" removed
// the same way the other Settings copy says "this TV".

/** Apple's paired-profile value: the active name only when it is the profile this TV reopens. */
export function pairedProfileLabel(rememberedId: string | undefined, activeId: string | undefined, activeName: string): string {
    if (rememberedId === undefined) return translate("settings.general.notPaired");
    if (activeId === undefined || rememberedId !== activeId) return translate("settings.general.savedProfile");
    return activeName;
}

export function pairedProfileDescription(askEveryTime: boolean): string {
    return translateTv(askEveryTime ? "settings.general.pairingSharedAskEveryTime" : "settings.general.pairingShared");
}

// ProfileLaunchBehavior.tvDescription at silo-apple 2ef3a171 (ProfileLaunchBehavior.swift:51-58).
// Automatic names the current TV user where Apple says "Apple TV user".
export function profileSelectionCaption(behavior: LaunchBehavior): string {
    switch (behavior) {
        case "automatic":
            return translateTv("settings.profileLaunch.automatic.detailAppleTv");
        case "askEveryLaunch":
            return translate("settings.profileLaunch.askEveryLaunch.detail");
        case "afterOneHour":
            return translate("settings.profileLaunch.afterOneHour.detail");
        case "afterTwelveHours":
            return translate("settings.profileLaunch.afterTwelveHours.detail");
        default: {
            const exhaustive: never = behavior;
            return exhaustive;
        }
    }
}
