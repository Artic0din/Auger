# Change Account

Change Account lists saved accounts beside a server rail.
The profile menu and profile picker footer open it.
Settings > Server > Accounts opens account management; Accounts is not a Settings category on the Apple reference.
Accounts uses its own Settings pane header, value-and-chevron rows, and red removal action.
Back returns to General in the Settings rail while the active profile remains valid.
Account credentials stay in protected storage, bound to their original server URL and a device-made account ID.
The first launch copies the previous saved credential before making the new selection durable, without a network request.
An interrupted copy can retry from the retained legacy credential.
Expiry keeps the account row and asks the person to sign in again.
From the profile menu, Back moves from the accounts pane to the server rail, then returns to the selected browse tab with the menu closed.
Cancelling preserves the active profile; choosing an account clears its PIN authority.
Signing in again to a saved account retires its previous session owner before saving replacement credentials.

## Reference and proof boundary

Reference: silo-apple `ffa6e5188c70664090a6dc9beb8c7cbbc3ce43e7`, including the account change in `54cf0f34a4528795c69609268e6ad693d85e50b7`.
Navigation was rechecked at `bbd1e470f0e1d3a99f486d0d7246d11ed1c97d55`: `TVMainTabView.swift:720,1284-1286` sets bar focus on return from Change Account, and `TVChangeAccountView.swift:64` returns from the pane to the rail first.
`tvOS/Navigation/TVMainTabView.swift:1384-1387` routes both account screens inside its tvOS guard.
`Screens/Accounts/ChangeAccountView.swift` is guarded by `#if !os(tvOS)` and is excluded from this port.
Apple TV has no three-choice Add sheet: account and server actions are direct, and the profile picker's Add opens profile creation.
The Change Account view uses the reference's 88-point headline, 520 by 88 rail rows and 760 by 128 account cards at the 1920-wide design viewport.
Inter substitutes for Apple's system font.
Pane rows, the 520px rail, plain Add server, gradient account tiles, and marquee scrim were rechecked against `bef81e8652a89c23a1c3cf07e312e9444baa6c4c`.
Focus outlines, the shared backdrop stage, and the selected server fill were rechecked at `e28300c61f044a9322f588203c8819d6f06e6197`: focused rows and Cancel use the platter with no hairline. Change Account does not set `MarqueeScene.stage`, so the light stays warm after Who's watching and blue after sign-in, under `MarqueeScrim.leading`. An unfocused selected server is `siloChromeSelectedFill`, white at 0.14.
Who's watching row stillness (`abf4ac45aa0ded295dd1443b91457cdf42dffbf2`) already holds: moving focus does not move the other row.
Offline recovery says "Back to profiles" while a saved account can open profiles, otherwise "Change account".
Tizen has no downloads, so download deletion copy is omitted.
Desktop Chromium tests establish app behavior only; see [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for signed `.wgt` and Apple TV comparison gates.

Saved-server follow-up reference: silo-apple `2c03722c3eecee64c74272258190f13e3258d959`.
`TVChangeAccountView.swift:1` guards this screen with `#if os(tvOS)`.
Its Select action enters the account pane (`:275-279`), remembering the last card (`:92-94`); Back returns to the rail (`:281-285`).
The Samsung manual entry adds Back to saved servers and holds Back while connecting, matching the probe guard in `Screens/Auth/TVServerSetupView.swift:286-295`.
Discovery and nearby-phone setup remain outside this delivery.
Removal keeps its confirmation focused with a loading label until storage answers; failures offer Back without removing the failed saved entry.

## Native capture scope

Follow [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for signed `.wgt` asset verification and Apple TV comparison, covering: server-rail and account-pane focus/Back transitions (remembered last card on Select), Add server and Add an account flows (including unreachable address and delayed-answer cancellation), single-profile picker presentation, expired `SIGN IN AGAIN` state, Settings > Server > Accounts sign-out and Remove Server confirmations (including storage-failure Retry), and offline relaunch preservation.
