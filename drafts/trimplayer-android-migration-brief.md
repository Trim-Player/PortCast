# Trimplayer Android — Spotify → Trimplayer migration brief

Hand this document to the Android coding agent. It is self-contained:
the agent does not need to read the rest of the PortCast repo to act on
it.

## 0. Context (read this first)

PortCast is an open file format (`application/vnd.portcast+json`, file
extension `.portcast.json`) for moving a listener's podcast data
between apps. Spec: https://portcast.org · Repo:
https://github.com/Trim-Player/PortCast.

The migration we're shipping has one user-visible goal: **a listener
on Spotify ends up on Trimplayer with their library intact, in one
session, with as little manual work as possible.**

There are two delivery surfaces. v1 ships first because it is small
and unblocks acquisition immediately; v2 is the better long-term UX
and reuses ~80% of v1's importer code.

| Surface                     | Who produces the file       | Where the user touches it           | Status          |
| --------------------------- | --------------------------- | ----------------------------------- | --------------- |
| **v1 — File transfer**      | Chrome extension on desktop | Email/Drive/AirDrop to phone, open in Trimplayer | Ship now |
| **v2 — In-app WebView**     | Trimplayer Android itself   | Inside the app, no file leaves device            | Ship next |

The Android-side **importer** (parsing `.portcast.json` and applying
it to the library) is the same code for both surfaces. v2 just replaces
the file source with an in-app fetch.

---

## 1. v1 — File-transfer import path

### 1.1 User flow

1. User installs **PortCast Export** from the Chrome Web Store.
2. On `open.spotify.com`, they click the extension and press Export.
3. The extension saves `spotify-<userid>-<date>.portcast.json` to
   their Downloads folder.
4. They transfer the file to their phone (email to themselves, Drive,
   AirDrop-equivalent, USB — out of our scope).
5. On Android, they tap the file. Trimplayer is offered as one of the
   "Open with" options. They pick Trimplayer.
6. Trimplayer shows a one-screen confirmation:
   _"Import N shows from Spotify? Resume positions for M episodes will
   be applied."_ → Import button.
7. Library is populated. A toast or summary screen reports successes
   and any unresolvable items.

### 1.2 Android changes required

#### 1.2.1 Manifest — register as a `.portcast.json` opener

Add an `<intent-filter>` to the Activity that should handle the import
(probably a new `ImportActivity` rather than `MainActivity` — keeps the
flow scoped and the back stack clean):

```xml
<activity
    android:name=".import.PortCastImportActivity"
    android:exported="true"
    android:label="@string/import_portcast_label">
  <intent-filter android:label="@string/import_portcast_label">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:mimeType="application/vnd.portcast+json" />
    <data android:mimeType="application/json"
          android:pathPattern=".*\\.portcast\\.json" />
    <data android:scheme="content" />
    <data android:scheme="file" />
  </intent-filter>
</activity>
```

Notes:
- The double MIME entry is intentional. Most file managers/email apps
  attach `application/json` for any `.json` file regardless of the
  `+json` structured suffix. The `pathPattern` narrows it back to our
  files. Without this, the "Open with" sheet won't show Trimplayer
  for files arriving from Gmail or Drive.
- Use a separate `ImportActivity`. Do NOT add this filter to a
  Launcher activity — Android will then offer Trimplayer as a handler
  for plain `.json` files in unrelated apps.

#### 1.2.2 Read the file from the Intent

The Intent's data URI is almost always a `content://` URI on modern
Android (Gmail and Drive proxy the file through a `FileProvider`). Use
`ContentResolver.openInputStream(uri)`. Do **not** assume a `file://`
path is readable — scoped storage will refuse it.

Size cap: a typical export is <1 MB (the user's whole show list and
resume positions). Reject anything over, say, 50 MB with a clear
"This file is too large to be a podcast library export" message
before parsing, to avoid a hostile-file DoS.

#### 1.2.3 Parse the document

Use kotlinx.serialization or Moshi. The shape that matters for v1
import is in §3 below. Tolerate unknown top-level fields (forward
compatibility) — the spec requires consumers preserve them.

#### 1.2.4 Apply the document to Trimplayer's library

For each subscription:

1. **Resolve to a feed.** Subscriptions exported from Spotify carry
   ONLY `platformRefs: ["spotify:show:<id>"]` — no `feedUrl`, no
   `podcastGuid`. So the importer must resolve `spotify:show:<id>` →
   RSS feed URL. The two viable resolvers (in order):
   - **Podcast Index API** (recommended) — look up by Spotify ID.
     This is the same approach Pocket Casts and Overcast use. Free,
     no auth needed for the search endpoints.
   - **Internal Trimplayer catalog**, if there's already a show-ID
     mapping table on the backend.
2. If resolution succeeds: subscribe the user to that feed using the
   existing subscribe-by-feed-URL code path. Set
   `Subscription.subscribedAt` from the document if Trimplayer tracks
   it.
3. If resolution fails: do **not** silently drop. Per spec §4.3, add
   the subscription to an "Unmigratable from Spotify" list shown at
   the end of import. Offer the user a manual "Search by title" box
   (the document carries `title`, `author`, `imageUrl` — use them to
   render the row).

For each episode state (when present — v0 of the extension exports
none, but v1 may add them):

1. Match the episode's `subscriptionRef` to the subscription created
   above (by `platformRefs`).
2. Resolve `platformRefs: ["spotify:episode:<id>"]` → episode within
   the resolved feed by `(publishedAt, title, durationSeconds)`
   fuzzy match. Exact-GUID matching isn't possible because Spotify
   episode IDs don't correspond to RSS GUIDs.
3. Apply `status`, `positionSeconds`. Treat `current-state-only`
   completeness (declared in `completeness[]` for the `episodes`
   section — see §3.3) as "do not delete any existing episode
   history Trimplayer already has."

#### 1.2.5 Dedupe against existing library

The user may import the same file twice, or run a later export after
following a few more shows. The importer must be idempotent:

- For each subscription, match against existing subscriptions in
  Trimplayer's DB by `feedUrl` (after resolution). If matched, do not
  add a duplicate; merge fields per spec §11.2 (newer `updatedAt`
  wins on scalar fields).
- For each episode state, match by `(feedUrl, episode GUID once
  resolved)`. If matched, apply spec §11.2 field resolution.

A "completeness assertion at level full covers subscriptions" is
present in every Spotify export (it always exports the full library).
Per spec §11.2, this means the consumer MAY treat subscriptions
present in Trimplayer but absent in the import as **unsubscribes**.
**Do not.** For v1, treat all imports as additive — never auto-remove
a Trimplayer subscription based on a Spotify import.

#### 1.2.6 Result screen

Show three counts: imported, already-following, unresolvable. For
unresolvable rows, offer the manual-search affordance. For everything
else, dump the user into the Trimplayer "Your Podcasts" screen.

### 1.3 Onboarding hook

Add a top-level entry in Trimplayer's onboarding (or in Settings →
Import) titled **"Coming from Spotify?"**. Tapping it:
- shows a 3-step illustration of the Chrome extension flow,
- links to the Chrome Web Store listing (URL TBD pending review
  approval — leave a constant for now),
- explains how to get the file to their phone (Gmail, Drive,
  AirDrop-equivalent),
- has a "What gets imported?" expander that lists: followed shows,
  resume positions for saved episodes. Be explicit that play history
  is NOT exported (Spotify doesn't expose it).

---

## 2. v2 — In-app WebView export path

### 2.1 Why this is the better UX

Skip the desktop, the file transfer, and the "Open with" picker
entirely. Inside Trimplayer:

1. User taps "Coming from Spotify?"
2. A WebView opens to `https://accounts.spotify.com/...` for sign-in.
3. After sign-in, the WebView lands on `open.spotify.com/collection/podcasts`.
4. Trimplayer's host code, watching the WebView, captures the same
   tokens the Chrome extension captures and runs the same library
   fetch.
5. The library is imported and the WebView dismissed. Total user
   actions: tap + Spotify sign-in.

### 2.2 What to reuse

`chrome-extension/lib/portcast.js` is explicitly platform-agnostic
(see file-header comment: "Reused unchanged inside the Trimplayer
mobile app's WebView"). Pull it in via:

- Option A: bundle the JS file as an asset; load it into the WebView
  alongside the page; call `buildDocument({me, savedShows,
  savedEpisodes})` over the JS bridge.
- Option B: port `portcast.js` to Kotlin. ~150 lines of
  straightforward mapping. Saves the WebView round-trip but doubles
  maintenance.

Recommend Option A unless there is a strong reason to keep the
WebView free of injected scripts. Option A means a v0.2 spec bump in
`portcast.js` propagates without an Android release.

The fetch logic in `chrome-extension/background.js` (the
`fetchSpotifyLibraryInTab` function and its pathfinder GraphQL call)
is also reusable verbatim if Android injects it into the WebView via
`evaluateJavascript`. Same approach as the extension uses for
`chrome.scripting.executeScript`.

### 2.3 WebView config gotchas

- `WebSettings.setJavaScriptEnabled(true)` — required.
- `WebSettings.setDomStorageEnabled(true)` — Spotify uses
  `sessionStorage`/`localStorage` heavily; sign-in breaks without
  this.
- Cookies must persist across the OAuth redirect. Use
  `CookieManager.setAcceptThirdPartyCookies(webView, true)`. Without
  this, Spotify's sign-in loops.
- User agent: do NOT set a custom UA. The default WebView UA passes
  Spotify's bot checks; bespoke UAs often don't.
- Don't intercept `https://accounts.spotify.com/*` URLs; let the
  WebView navigate freely until it lands back on `open.spotify.com`.

### 2.4 Note about `lib/platforms/spotify.js`

That file was an earlier seed for the mobile-WebView path that
predated the December 2025 Spotify API change. It targets the old
REST endpoints (`/v1/me/shows`), which now 401 against
api-partner tokens. **Do not use it as-is.** The current, working
fetch logic lives in `chrome-extension/background.js`
(`fetchSpotifyLibraryInTab`) — port from there.

---

## 3. The `.portcast.json` shape the importer actually needs to parse

The full spec is in `SPECIFICATION.md` in this repo. For the v1
Spotify importer, only these fields appear or matter:

### 3.1 Top-level

```json
{
  "portcast": "0.2.0",
  "generatedAt": "2026-05-29T21:16:27Z",
  "generator": { "name": "...", "version": "...", "url": "..." },
  "owner": { "displayName": "...", "email": "..." },
  "subscriptions": [ ... ],
  "episodes": [ ... ],
  "completeness": [ ... ]
}
```

- `portcast` SemVer. Accept any `0.x` for now; warn on `1.x`+.
- `owner` may be absent. When present, use only to label the import
  ("Imported from Yonatan's Spotify"). Do not persist as a Trimplayer
  user identity.
- `episodes` may be empty (today's extension exports `[]` because the
  Spotify pathfinder query for individually-saved episodes hasn't
  been verified yet — see TODO in `background.js`).

### 3.2 Subscription (as produced by the Spotify extension)

```json
{
  "subscriptionId": "ff888d1e340f4d1193f652f072d21519",
  "title": "Acquired",
  "author": "Ben Gilbert and David Rosenthal",
  "imageUrl": "https://i.scdn.co/image/...",
  "subscribedAt": "2026-05-23T17:13:51Z",
  "platformRefs": ["spotify:show:7Fj0XEuUQLUqoMZQdsLXqp"],
  "updatedAt": "2026-05-29T21:16:27Z"
}
```

Critical: `platformRefs` is the ONLY identifier. No `feedUrl`, no
`podcastGuid`. Resolution is the importer's job (§1.2.4).

### 3.3 Completeness assertions

```json
"completeness": [
  { "section": "subscriptions", "source": "spotify", "level": "full",
    "capturedAt": "2026-05-29T21:16:27Z" },
  { "section": "episodes", "source": "spotify",
    "level": "current-state-only",
    "capturedAt": "2026-05-29T21:16:27Z",
    "note": "Spotify exposes resume_point only for saved episodes." }
]
```

Apply these per spec §11.2:
- `subscriptions` `full` → consumer MAY treat absences as
  unsubscribes. We choose not to (see §1.2.5). Code it that way
  with a comment so future-you doesn't "fix" it.
- `episodes` `current-state-only` → consumer MUST NOT delete any
  existing episode history. Resume positions can be applied; play
  events cannot be inferred.

### 3.4 Episode state (when present)

The Spotify extension does not currently emit any. When it does, the
shape is documented at `chrome-extension/lib/portcast.js:63`
(`episodeFromSavedEpisode`). Highlights:
- `subscriptionRef` carries `platformRefs` — match it back to the
  subscription you imported.
- `status` is `unplayed | in_progress | completed | archived`.
- `positionSeconds` present only when `status === "in_progress"`.

---

## 4. Open questions / things to come back to

- **Episode-history backfill.** If/when we ship a "Spotify Data
  Export → PortCast" tool (the slow, full-history out-of-band export),
  the importer must handle two PortCast documents for the same user
  arriving days apart — spec §11 covers the merge rules; we'll
  exercise them then.
- **Manual matching UX.** Whatever pattern we land on for
  unresolvable subscriptions (search box, paste-RSS-URL, skip) should
  be designed *once* and reused for v1 file imports, v2 in-app
  imports, and any future platform adapter (Pocket Casts, Apple).
- **Telemetry.** None in v1. Once the flow is stable, instrument
  outcomes: resolution success rate by show, time-to-import, drop-off
  at each step. Trimplayer's existing analytics — not anything in the
  PortCast document — owns this.
