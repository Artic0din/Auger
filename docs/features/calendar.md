# Calendar

Weekly release agenda for Following, Trending, and All (`src/ui/calendarState.ts`, `src/ui/calendar.ts`, `src/api/calendarOperations.ts`).
For the `GET /calendar` query validation and air-time clock rules, see [docs/native-api-v2.md](../native-api-v2.md#calendar) and [docs/translation.md](../translation.md).

## Layout and week strip

- Following, Trending, and All sit above one week strip: previous arrow, seven stacked weekday/day cells, next arrow, conditional Today button, and month/year anchored on Thursday.
- Dots indicate that the loaded response contains events for that date; pending days carry no confirmed event state.
- Apple TV source reference (`silo-apple` `9723df007baa8e933f5615cc14b13e99a6ee1ea1`, `Screens/Calendar/CalendarView.swift`, `CalendarFilterBar.swift`, `CalendarWeekStrip.swift`, `CalendarDayShelf.swift`, `CalendarEventCard.swift`): 84×96 day cells, 26 pt bold day number, 8 px dot, 64×64 chevrons (original SVG drawings of 24 pt semibold `chevron.backward`/`chevron.forward` matching `8655b06`/`08ff656f`), 18 px strip gap with `-8 px` day compensation for the 10 px day gap, strip at y=281, `siloCardTitle` (28 pt semibold), and single-line 22 px metadata with ellipsis.
- Artwork uses the shared URL validator and fallback, with release badges top-left, watched check top-right, and time pill bottom-right (date-only releases omit the time pill).

## Focus and states

- Calendar enters on the active filter; the week strip is one focus zone entering on the selected day without changing selection when shelf cards gain focus.
- Today updates the week and selected date without requesting filter focus; when Today disappears, Tizen keeps valid focus on the selected strip day.
- Day shelves use the shared spatial focus owner and retained horizontal axis; strip entry restores scroll top, and shelf entry keeps its heading and cards visible.
- Loading shows a blank focusable 320 px placeholder; empty weeks show filter-specific Apple copy with a calendar icon and links to the other two filters (no extra Back button).
- A quiet refresh retains cached events on failure (matching `CalendarViewModel.load`); an empty-week failure shows the shared error view with Try Again (Sign In Again first after a 401).
- Desktop UI tests cover remote navigation and both motion modes; see [docs/evidence/simulator-evidence.md](../evidence/simulator-evidence.md) for signed `.wgt` and Apple TV comparison gates.
