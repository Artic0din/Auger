# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

<!-- changelog:releases -->

## [0.5.0] - 2026-11-25

### ✨ New Features

- **Playback**: Land Up Next, Auto-play, Shuffle, and Still Watching stack

## [0.3.0] - 2026-11-24

### ✨ New Features

- **Settings**: Add local Diagnostics tab with relay and QR report handoff

### 🐛 Fixes

- Hide Add Profile when the account's profile limit is reached

## [0.2.1] - 2026-11-24

### 🐛 Fixes

- Draw Up Next's text at Apple's points times the cap scale

## [0.2.0] - 2026-11-24

### ✨ New Features

- **Profiles**: Match the TV picker and add profile creation
- **Browse**: Share Skyline presentation on Recommended
- **Details**: Consolidate actions and inline season episodes
- **Details**: Play episodes directly with fresh resume
- **Requests**: Match the Apple TV Requests screens
- **Search**: Match the Apple TV Search experience
- **Person**: Show inline filmography and Apple TV filters
- **Lists**: Align Watchlist Favorites and History with Apple TV
- **Collections**: Align Apple TV collection browsing
- **Calendar**: Align the week agenda and event presentation with Apple TV
- **Accounts**: Add Change Account and several accounts per server
- **Details**: Align series navigation and playback controls
- **Sign-In**: Match Apple TV's current sign-in screens
- **Details**: Add description translation
- **Details**: Show the Trailers & More rail
- **Settings**: Align supported Apple TV menus
- **Settings**: Hide unwatched episode stills and descriptions
- **Box Sets**: Browse, search, and show movie box sets
- **Sign-In**: Show when a server still needs setup
- **Browse**: Show cached content when the server is unreachable
- **Requests**: Remove your own failed requests
- **Session**: Paint saved route before reconciliation
- **Settings**: Add the remaining Apple TV settings rows
- **Settings**: Show connection speed and test it from Playback settings
- **Playback**: Match the Apple TV player panel and scrubber
- **Playback**: Play embedded subtitles from the stream and switch in place
- **Playback**: Show Up Next before playback ends
- **Playback**: Add chapters, stats and video controls
- **Playback**: Add subtitle search and in-player controls
- **Playback**: Claim HDR10 when this TV reports HDR
- **Accounts**: Match Apple TV account order, counts and badges
- **Accounts**: Show overflow fade and chevrons on Change Account columns
- **Person**: Match Apple TV load-more paging and metadata refresh
- **Playback**: Port the buffering-quality decision logic
- **Playback**: Send the fresh bandwidth estimate on playback start
- **Playback**: Lower quality when buffering like Apple TV
- **Playback**: Play every part of a multi-part shuffle pick like Apple TV
- **Watch Together**: Add the Watch Party contracts and API
- **Settings**: Add Apple's buffering quality rows
- **Audiobooks**: Add audiobook contracts and API operations
- **Watch Together**: Add the Watch Party entry and hub
- **Watch Together**: Add Apple's Watch Party lobby over HTTP
- **Watch Together**: Keep the Watch Party lobby live over the room socket
- **Audiobooks**: Add the Audiobooks library cascade and detail
- **Watch Together**: Add the Watch Party ballot and lobby Ready
- **Settings**: Play theme music on Details like Apple TV
- **Settings**: Add Apple TV's App Language row to General
- **Focus**: Draw Apple TV's pressed look on pill buttons and Details extras
- **Languages**: Add the string catalog, lookup and Accept-Language
- **Languages**: Show Settings in the chosen language and list Apple's languages
- **Languages**: Show Details and Search text from the string catalog
- **Languages**: Show the top bar, its menus and Home's states in the chosen language
- **Languages**: Show card captions, For You and the library tabs in the chosen language
- **Languages**: Show Arabic right to left and mirror the remote's Left and Right
- **Languages**: Mirror Search in Arabic, as Apple TV does
- **Browse**: Offer Apple's full list of Browse sorts
- **Languages**: Move Requests, Calendar and Accounts onto the catalog and mirror them in Arabic
- **Languages**: Move Watch Party onto the catalog and mirror it in Arabic
- **Audiobooks**: Open a book on Apple TV's loading frame
- **Languages**: Move the Watchlist, Favorites and History pages onto the catalog and mirror them in Arabic
- **Languages**: Move the sign-in screens onto the catalog and mirror them in Arabic
- **Languages**: Move the Person page onto the catalog and mirror it in Arabic
- **Languages**: Move the error pages and empty rows onto the catalog
- **Languages**: Move the profile picker and launch choice onto the catalog
- **Languages**: Move the audiobook page and chapter list onto the catalog
- **Languages**: Move the audit's leftover Apple-keyed lines onto the catalog
- **Languages**: Translate the generic-word buttons on Tizen-only screens
- **Home**: Show rows of collections on Home and library pages
- **Recommendations**: Add Not interested to the card menu
- **Home**: Give each corner of the backdrop wash its own colour
- **Settings**: List audiobook skip intervals under Playback
- **Home**: Name the owner of a shared collection in the hero
- **Home**: Crossfade the backdrop colour wash over 0.7 s
- **Details**: Add Not interested to a movie or series page
- **Languages**: Move the skip-interval connection and unsupported save errors onto Apple's keys
- **Playback**: Add Secondary subtitles to the Subtitles tab
- **Playback**: Add Sync to Audio and Reset Timing to the Subtitles tab
- **Playback**: Replace the two AI rows with AI Subtitles… and its language menu
- **Languages**: Move the player onto the catalog
- **Playback**: Mirror the options panel, Up Next, buffering card and error page in Arabic
- **Languages**: Show Stats' status, delivery and subtitle search lines in the chosen language
- **Playback**: Draw the Up Next card as Apple TV does
- **Branding**: Rename the TV app from Silo to Auger
- **Playback**: Give Info and Stats Apple's focus ring and section paging
- **Playback**: Load an embedded subtitle's file when switching mid-video
- **Playback**: Show the next episode's air date and runtime in Up Next
- **Playback**: Add Up Next's Auto-play toggle and save it for this TV

### 🔧 Improvements

- **Home**: Read item detail after the marquee rests
- **Details**: Send the episode read before the dwell repaint
- **Details**: Repaint once per frame for async Details answers
- **Languages**: Load the shown language's text on demand
- **Browse**: Keep one tint wash as a bitmap under Home's backdrops
- **Browse**: Draw Home's hero once per swap, with one masked layer fewer

### 🐛 Fixes

- Lift Library Recommended artwork without scaling captions
- Make Enter skip while a skip marker shows
- Read the rating only after an in-flight write settles
- Retry AI subtitle polling and keep duplicate-job blocks
- Load related titles from the server collection
- Request sharp Home and detail backdrops
- Omit overlay fields from library section queries
- Match Apple TV Home row cards and scroll
- Align card focus with Apple TV source
- Stop the marquee and hidden-library focus races
- Align profile menu and Requests navigation
- Match Apple TV shelves and section menu
- Keep the column on Down and pin hero title art
- Paint Home rows without the long waiting state
- Match Search reveal, shadow and card badges
- Retry a row-cap read cancelled by leaving Home
- Stabilize portrait cancellation and Search navigation
- Port Apple episode rail window and anchors
- Align More and rewatch actions with Apple TV
- Complete saved-server selection navigation
- Preserve device playback scope and align supported controls
- Cancel featured translation dwell when focus moves
- Open the series from episode and season results
- Open episode context on card Select
- Preserve visits and reveal section headings
- Select seasons on resting pill focus
- Restore the last hero action on Up
- Show the full hero on every focused episode
- Preserve episode request ownership and bound retained owners
- Refresh the visible hub after list cancel settles
- Settle visible detail and keep removal focus
- Add Find Trailers and match the remaining hero differences
- Blur More glass and preserve Apple cast entries
- Preserve cast focus and interrupted trailer discovery
- Match cast inset and More styling to Apple TV
- Keep cast focus keys stable when roles appear
- Keep a settled cancel on the Requests page that is open
- Keep cast selectors and trailers through watched reload
- Tombstone cancelled rows against in-flight hub loads
- Share one cancel gate across list and detail
- Keep Enter latched across remove confirmation
- Hold unconfirmed detail cancels in the shared gate
- Settle detail cancel holds and keep neighbor focus
- Keep hub card while detail cancel owns the gate
- Keep detail cancel hub rows without duplicate notices
- Capture neighbor focus before uncertain readback
- Refresh profile chrome after cold reconcile
- Gate offline restore against deployment reuse
- Keep the hero anchor across visits and repaints
- Snap the hero anchor after a Details repaint
- Offer Retry after playback startup and recovery failures
- Keep focus on Play when a movie opens
- Match Browse pills and row edges
- Match where Back from Settings lands
- Match where Down from the People row lands
- Match focus outlines and the Change Account backdrop
- Match the supporting headings and badge row
- Keep the decoded title logo across repaints
- Show noon and the first Search person on the TV
- Match Apple TV quality labels
- Match Apple TV text width
- Match row fill and switch value brightness
- Keep a selected season focused while Play claims focus
- Match the TV sweep's layout differences
- Match the subtitle preview caption height
- Place the person name on Apple's 85px line
- Match the person biography line to Apple's font
- Keep the scrub thumbnail on the loaded clock line
- Draw sans-serif captions semibold on the TV
- Ask before signing out from Who's watching
- Shift the episode rail when its window includes the first season
- Open a lone PIN-less profile and route an expired sign-in
- Forget a remembered profile when storage refuses the clear
- Retry an aborted previous season at the rail edge
- Keep the series line and send known subtitles on start
- List subtitles the plan flags unplayable as unavailable
- Draw Apple's progress bar on Continue Watching
- Bind the remembered profile to a sign-in epoch
- Retry removing a replaced PIN proof the key store refused
- Finish the unplayable subtitle edge cases
- Retry failed and cancelled seasons at the rail edge
- Keep the top bar on the Requests page
- Hide the rail edge error while its retry runs
- Match Apple TV's PIN keypad
- Match Apple TV's skip intro, recap and credits pills
- Match Apple's rail edge failure copy and reset
- Rank versions and label them like Apple TV
- Draw Apple's default artwork for missing or failed images
- Start shuffle picks from the beginning like Apple TV
- Finish skip pill timing and visibility parity
- Rank and cap versions for next-episode and shuffle picks
- Use Apple TV's secondary text colour
- Use Apple TV wording for the subtitle options
- Match Apple TV's hero text size, spacing and measure
- Match Apple TV's row heading size and icon spacing
- Show Apple's error screen on every failed page
- Match Apple TV's Who's watching, remember offer and avatar
- Match Apple TV's action row
- Match Apple TV's hero, meta lines and screen states
- Match Apple TV's seasons, episodes and lower rails
- Match Apple TV's card menu and Home page states
- Match Apple TV's Details popovers, menus and failure alerts
- Scale the Related reveal with Poster Size
- Match Apple TV text size and tracking on Details
- Match Apple TV's hero timing and card presentation
- Match Apple TV text size and tracking on Person
- Drop a series' remembered season with its cached page
- Remove the loading lines Apple TV doesn't show
- Match Apple TV's top bar, avatar and top-bar panels
- Use Apple TV's empty and error views on Person
- Keep snapshot artwork through a failed first read
- Keep a focus scroll going through a Details repaint
- Space the Filmography row like Apple TV
- Lay out the Subtitles tab in Apple TV's two columns
- Match Apple TV's For You menu and Recommendations
- Match Apple TV's Search screen
- Lay out card badges as Apple TV's CardOverlays does
- Match Apple TV's Recommended and Collections pages
- Match Apple TV's Browse grid states
- Match Apple TV's Sort, Filter and letter rail
- Show Apple's year range on Home and catalog series cards
- Draw profile menu Sign Out and Watch Party at Apple's size
- Match Apple TV's profile menu rows, order and focus
- Centre the movie box set row on focus like Apple TV
- Draw Apple TV's watch status corner on posters
- Use the remembered title-art answer on Details
- Draw Apple TV's badge marks and combined badges
- Activate buttons and cards on Select release like Apple TV
- Report caption load state and clock on the caption layer
- Draw Apple TV's symbols on generic poster badges
- Format air times in the app language
- Keep focus off Watchlist while episodes load
- Match Apple TV's row focus and pressed motion
- Draw Apple TV's week chevrons
- Match account and profile pressed looks
- Align card captions to the leading edge
- Draw Apple TV's Plate and Edge band presets and style overrides
- Return to the originating page when Add Profile closes
- Match Apple TV's rail icons, chevrons and Sign Out placement
- Draw the administrator's uploaded badge images
- Require a higher selection revision for a lost repeat selection
- Keep a second audio track on direct play
- Keep Play focused when a Calendar episode's series loads
- Wait for long embedded subtitle extracts
- Use Apple TV's error reds instead of one pink
- Group the Subtitles options and order tracks as Apple TV does
- Keep results above the Samsung keyboard
- Size Details art as Apple TV and reveal art once decoded
- Fall back as Apple TV does when Auto's subtitle language is missing
- Draw the disabled Loop Theme Music row at full brightness
- Show the suggested episode in the header for a Calendar episode the season does not list
- Keep the focused Details track row centred while scrolling
- Draw disabled Settings rows at full brightness
- Keep the hero's artwork size on Details re-reads
- Keep the request result focus when Back rereads Search
- Request episode-rail stills at Apple TV's still width
- Focus Play after Back to a series whatever answers first
- Size the season page's artwork reads as Apple TV does
- Keep the refreshed series watched state over a late read
- Skip disabled rows when moving focus, as Apple TV does
- Keep the refreshed season watched state over a late read
- Keep Up inside the pane at the first Settings row
- Cap the library menu at Apple TV's six rows
- Keep Down on Sign Out at the end of the rail
- Wait for the Select release before repainting for a loaded language
- Order the library menu as Apple TV does
- Repaint the Home marquee after a language change from Settings
- Show years in the shown language's digits, as Apple TV does
- Read the audiobook library type as Apple TV does
- Name chapterless parts by their file, as Apple TV does
- Present the hub full screen with Apple's join field
- Keep the Restoring overlay until the restore finishes
- Match Apple TV's regrouped Video, Info and Stats tabs
- Refetch a subtitle download that ends early
- Offer Sign In Again when the Calendar read fails with a 401
- Draw the sign-out icon as Apple TV's closed box
- Title the video skip pickers as Apple TV does
- Drop the reset row from the skip-interval pickers
- Refuse HLS playlists AVPlay cannot read and bound a hung prepare
- Hide Explore all on a complete Continue Watching row
- Close the AI subtitle and Sync to Audio edge cases
- Use the shown language's digits and collation in Subtitles
- Word the end-of-playback card as Apple TV does
- Stop drawing a hidden Show Up Next as an empty ring
- Keep the shown week quiet when a refresh fails
- Start the next episode when the stop request is slow
- Press the player's panel rows and Details Play as Apple TV does
- Disable Versions when a title has only one version
- Add a skip pressed during a seek to that seek's target
- Offer Show Up Next for a film with On Deck items
- Show Details dates in the chosen language
- Ask for every embedded text subtitle as an artifact on direct play
- Hide Show Up Next on a film once On Deck fails twice
- Treat an empty Up Next still as none, and test the backdrop fallback
- Show AVPlay's subtitles when a switch hands it the track
- Treat a film's failed On Deck read as nothing next, as Apple does
- Label the Version and Audio pills as Apple does, from the catalog
- Title an added account's code screen as Apple TV does
- Treat an episode's failed On Deck read as nothing next, as Apple does
- Resolve an unresolved subtitle switch before recovering
- Size the filter pills as Apple's segmented control does
- Size the profile menu's name as Apple does
- Size Calendar's text as Apple does
- Size Settings' text as Apple does
- Keep the queued out-of-window seek right during a subtitle switch
- Show the scrub preview while a subtitle switch is out
- Handle three lost-answer subtitle switch edge cases
- Show the server's reason when playback cannot start
- Keep the Auger name when translations are synced
- Draw captions at Apple TV's tvOS sizes
- Back while playing hides the controls first
- Match Apple's Server rows, Metadata footer, picker header and version line
