# Auger for Samsung TV

The Samsung TV client for a Silo media server.
These are the words the app, its docs and its contributors use for the things a viewer meets.

## People and access

**Server**:
One Silo media server the TV connects to.
_Avoid_: Host, backend, instance

**Account**:
One signed-in login on one Server.
The TV can save several.
_Avoid_: User, login, session

**Household**:
The set of Profiles one Account owns.
Two Accounts on the same Server never share a Household.
_Avoid_: Family, group

**Profile**:
One viewer identity inside a Household, with its own watch history, settings and optional PIN.
_Avoid_: User, member

**Primary Profile**:
The Profile that manages its Household by adding Profiles and setting their restrictions.
Being the Primary Profile does not make it a Server administrator.
_Avoid_: Owner, admin, household manager

**Viewer**:
The person watching under the active Profile.
_Avoid_: User

**Authority**:
The active Profile's right to make requests to the Server.
It ends when the Profile is switched, the Account signs out, the sign-in expires or the PIN proof is revoked.
_Avoid_: Permission, token, session

## Catalog

**Library**:
One Server-defined shelf of content, such as movies, series, mixed video or audiobooks.
_Avoid_: Section, folder, source

**Restricted Library**:
A Library barred by access policy, set by a Server administrator for an Account or by the Primary Profile for a Profile in its Household.
The restricted Profile cannot undo it.
_Avoid_: Hidden Library, locked library

**Hidden Library**:
A Library a Profile has chosen to hide from its own browsing and tabs.
That Profile can still restore it.
_Avoid_: Restricted Library, disabled library

**Box Set**:
A Server-wide group of movies from one franchise.
Each Library shows only its own movies from it.
_Avoid_: Collection, franchise, series (for movies)

**Collection**:
A curated Server group or personal Profile group of titles, which can span Libraries.
Personal Collections stay private to their creator or share read-only with the Household.
_Avoid_: Box Set, playlist

**Request**:
A Profile's request to the Server for a movie or series that is not yet in its Libraries, tracked through pending, approved, available, failed or cancelled states.
_Avoid_: Media request, ticket, order

## What plays next

**Next Up**:
The separate Home row of the next unwatched episode in each series the Profile is following, shown when split out from Continue Watching.
_Avoid_: Up Next, On Deck

**Up Next**:
The player panel that offers what to watch next as the current title nears its end or finishes.
_Avoid_: Next Up, autoplay screen

**On Deck**:
The row of other playable titles drawn from the Profile's Home rows, excluding the current title and its series.
Up Next shows it alongside a next episode, and uses it as the main pick after a movie or at the end of a series.
_Avoid_: Next Up, Up Next

**Continue Watching**:
The Home row of titles the Profile started and has not finished; in the default combined mode it also merges in next-up episodes.
_Avoid_: Resume row, in progress

## Playback

**Direct Play**:
Playing the original file as the Server stores it, without conversion.
_Avoid_: Native play, passthrough

**Remux**:
Repackaging the original video and audio streams into a container the TV can play, without re-encoding them.
_Avoid_: Transcode, Direct Play

**Transcode**:
Playing a stream the Server re-encodes on the fly to fit the TV's capabilities, quality limits or burned-in subtitles.
_Avoid_: Remux, fallback stream
