# PortCast Chrome extension — design

Status: design draft, no code yet.

## What it does

One job: when a Spotify listener is signed in to
`open.spotify.com`, the extension reads their followed shows, saved
episodes, and `resume_point`s, builds a PortCast document, and saves
it to disk as `spotify-<user>-<date>.portcast.json`. Nothing else.
No analytics, no server contact, no background polling.

## Why this exists alongside `import.portcast.org`

The server at `import.portcast.org` uses the Spotify Web API via a
registered developer app, which Spotify caps at 25 hand-listed users
in Development Mode. The Production-Mode path is now closed to
non-partners (see memory: `spotify_extended_quota_path`). The
extension sidesteps that entirely by using **the user's own
`open.spotify.com` web-player session token** — the same one
Spotify's own UI uses to render the listener's library — and never
touches the developer-app credential. No quota, no per-user
Development Mode cap, no Spotify approval step.

Both surfaces will exist for a while: the server already covers the
first 25 invited testers; the extension is the path for everyone
else once it ships.

## Multi-platform from the start

Spotify is the first source we ship, but the design is structured so
adding the next web-based source (Pocket Casts, Overcast) is a
single-file change plus a manifest update — not a rewrite.

The matrix of what the extension architecture can reach:

| Platform | Reachable via this extension? | Notes |
|---|---|---|
| Spotify (`open.spotify.com`) | Yes — v1 ships this | `/get_access_token` + Web API |
| Pocket Casts (`play.pocketcasts.com`) | Yes — planned v2 | REST API with session cookie |
| Overcast (basic web player) | Probably | Limited library surface |
| YouTube Music | Tentative | Mixed model, podcasts subset |
| Apple Podcasts | **No** — needs a different vehicle | Library is in iCloud / local SQLite, no web surface. Will need either a desktop helper that reads `~/Library/Group Containers/.../MTLibrary.sqlite` or an in-app PortCast exporter contributed to the macOS Podcasts app. |
| Native players (AntennaPod, etc.) | No | Need each app to ship native PortCast export — that's a spec-adoption play, not an extension play. |

Each web-based source gets its own module under `lib/platforms/`.
The popup queries `lib/platforms.js` to find which platforms have a
live session in this browser and offers one export button per
detected platform. v1 ships only Spotify, but the registry exists
from day one.

## Directory layout

```
chrome-extension/
├── manifest.json
├── popup.html
├── popup.js
├── popup.css
├── background.js                # MV3 service worker — orchestrator
├── lib/
│   ├── portcast.js              # spec types + buildDocument from any source
│   ├── platforms.js             # registry + per-platform detection
│   ├── platforms/
│   │   ├── spotify.js           # Spotify client + token fetch + spec mapping
│   │   └── (pocketcasts.js)     # placeholder for v2
│   └── README.md                # notes for the Trimplayer mobile reuse
├── icons/
│   ├── 16.png
│   ├── 48.png
│   └── 128.png
├── tests/
│   ├── portcast.test.mjs        # node --test, no DOM, no chrome.*
│   ├── spotify.test.mjs         # node --test, mocks fetch
│   └── fixtures.mjs             # mirrors server/tests/test_exporter.py
├── ICONS.md                     # icon mark proposals (see below)
└── README.md
```

Every file under `lib/` is a pure ES module: no `chrome.*` API
calls, no DOM, no imports from anything extension-specific. They're
written to run unchanged inside the Trimplayer mobile app's
WebView-injected JS — one source of truth for both desktop
extension and mobile in-app export.

## manifest.json shape

Manifest V3, ES-module service worker:

```json
{
  "manifest_version": 3,
  "name": "PortCast Export",
  "short_name": "PortCast",
  "version": "0.1.0",
  "description": "Export your podcast library (followed shows, saved episodes, resume positions) to a portable PortCast file. Spotify supported; more sources to follow.",
  "icons": { "16": "icons/16.png", "48": "icons/48.png", "128": "icons/128.png" },
  "action": { "default_popup": "popup.html", "default_title": "PortCast Export" },
  "background": { "service_worker": "background.js", "type": "module" },
  "permissions": ["downloads"],
  "host_permissions": [
    "https://open.spotify.com/*",
    "https://api.spotify.com/*"
  ]
}
```

Adding a platform later means appending its host(s) to
`host_permissions` and creating a new `lib/platforms/<id>.js`.
`host_permissions` updates trigger a Chrome Web Store re-review, so
batch them when possible.

Permission rationale (every one of these gets scrutinized in the
Chrome Web Store review):

- `downloads` — to save the `.portcast.json` file via
  `chrome.downloads.download`. Without it we'd have to invent a UI
  for "click this data URL," which is brittle and confusing.
- `host_permissions: open.spotify.com` — so the service worker's
  `fetch` to `/get_access_token` carries the user's existing
  Spotify cookies. Required for the whole approach.
- `host_permissions: api.spotify.com` — so subsequent `/v1/me/*`
  fetches actually reach Spotify's API host. (The token from
  open.spotify.com is used as a Bearer header on api.spotify.com.)
- `scripting` — required by `chrome.scripting.executeScript`, the
  API used to inject the fetcher into the open.spotify.com tab.
  See "Why the fetch can't run in the service worker" below.

Explicitly **not** requested:

- `tabs` — would expose URLs/titles of *every* tab. We don't need
  it: `chrome.tabs.query({ url: "https://open.spotify.com/*" })`
  and `chrome.tabs.create({ url })` both work without `tabs`
  because the URL matches our host_permissions, which is enough.
- `activeTab` — we never need ad-hoc access to "whatever the user
  is looking at right now."
- `cookies` — we never read cookies directly; the browser attaches
  them for us via host_permissions.
- `storage` — we have nothing worth persisting in v1. If we later
  cache the last-export timestamp, we'll add it then.
- `*://*/*` — never. Tight host_permissions is the difference
  between "approved" and "in review for six weeks."

## How the export runs

1. User clicks the toolbar icon → popup opens.
2. Popup sends `{type: "export"}` to the background service worker.
3. Service worker fetches
   `https://open.spotify.com/get_access_token?reason=transport&productType=web-player`
   with `credentials: "include"`. The browser attaches the user's
   `sp_dc` / `sp_key` cookies because of host_permissions.
4. Response is `{ accessToken, accessTokenExpirationTimestampMs, isAnonymous }`.
   - If `isAnonymous: true` → reply to popup with `not-signed-in`
     and the popup shows "Open Spotify and sign in" with a button
     that opens `https://open.spotify.com` in a new tab.
   - Otherwise continue.
5. Service worker uses `SpotifyClient(accessToken)` to call:
   - `GET /v1/me` (once)
   - `GET /v1/me/shows` (paginated, follow `next` until exhausted)
   - `GET /v1/me/episodes` (paginated)
6. Service worker passes those three payloads to
   `buildDocument({...})` in `lib/portcast.js` and gets back a
   plain object matching the PortCast schema.
7. Service worker stringifies the document, wraps it in a Blob,
   builds an object URL, and calls
   `chrome.downloads.download({ url, filename, saveAs: true })`.
   `saveAs: true` makes the dialog explicit so the user controls
   where the file lands.
8. Popup updates: "Done — 142 subscriptions, 88 episodes."

The whole flow lives in the service worker. The popup is a thin
shell that posts a message and renders progress updates.

## Token acquisition — what we're relying on

`https://open.spotify.com/get_access_token?reason=transport&productType=web-player`
is the endpoint Spotify's own web app calls when it bootstraps the
player. Long-lived, stable for years, used by every Spotify community
tool. Response shape (truncated):

```json
{
  "accessToken": "BQDhx...long...",
  "accessTokenExpirationTimestampMs": 1748528412345,
  "isAnonymous": false
}
```

`isAnonymous: true` means the request was made without a logged-in
session (no `sp_dc` cookie). That's the "tell user to sign in" path.

If Spotify renames this endpoint (which they've done once historically,
2021), we'll patch — that's the maintenance cost of the
session-token path. We deliberately do **not** scrape the page for a
token as a fallback in v1; we'd rather break loudly and ship a fix
than silently scrape something we don't fully understand.

## Why the fetch can't run in the service worker

Spotify's Varnish CDN refuses any request to `/get_access_token`
whose `Origin` request header isn't `https://open.spotify.com`,
returning the HTML page `<title>403 URL Blocked</title>` with
internal error `54113`. Browser fetches from a Manifest V3 service
worker automatically carry `Origin: chrome-extension://<id>`, and
JavaScript cannot override the `Origin` header (it's on the fetch
spec's forbidden-header list).

The reliable workaround — the one Spotify's CDN can't distinguish
from the web player itself — is to run the fetch **inside an
`open.spotify.com` tab**. That's what `background.js` does:

1. `chrome.tabs.query({ url: "https://open.spotify.com/*" })` —
   look for an existing tab.
2. If none, `chrome.tabs.create({ url, active: false })` opens one
   in the background, and `chrome.tabs.onUpdated` is awaited for
   `status === "complete"`.
3. `chrome.scripting.executeScript({ target: { tabId }, world:
   "ISOLATED", func: fetchSpotifyLibraryInTab })` runs a
   self-contained fetcher inside that tab. Its `Origin` is now
   `https://open.spotify.com`, Spotify is happy, and the session
   cookies attach automatically.
4. The injected function returns the raw `/me`, `/me/shows`, and
   `/me/episodes` payloads. The service worker builds the document
   from them via `lib/portcast.js` and triggers the download.
5. If we created the tab, we close it on the way out.

`api.spotify.com` calls happen from the same injected context, which
also keeps the request shape identical to the web player and avoids
similar CDN surprises there.

This is why the manifest needs `scripting` and `tabs` permissions in
addition to `downloads` — those two are non-negotiable for the tab
injection. They do not let the extension see or modify any non-
`open.spotify.com` content; the host-permission list still gates
which origins we can ever touch.

`lib/platforms/spotify.js` is kept as the **mobile-WebView** version
of this logic. In Trimplayer's mobile app the WebView itself is
already loaded at `open.spotify.com`, so the simple in-context fetch
works there without the tab-injection dance.

## `lib/portcast.js` — the exporter

Mirror of `server/portcast_server/exporter.py`. Pure functions; no
side effects.

```js
export const SPEC_VERSION = "0.2.0";
export const GENERATOR_NAME = "PortCast Spotify export";
export const GENERATOR_URL  = "https://portcast.org";

export function buildDocument({
  me,
  savedShows,
  savedEpisodes,
  generatorVersion,
  capturedAt = nowIso(),
}) { /* returns the plain document object */ }

// Same status-mapping rules as the Python version:
//   fully_played            → status: "completed", positionSeconds dropped
//   resume_position_ms > 0  → status: "in_progress", positionSeconds carried
//   otherwise               → status: "unplayed", positionSeconds dropped
export function episodeFromSavedEpisode(saved, capturedAt) { ... }
export function subscriptionFromSavedShow(saved, capturedAt) { ... }
export function normalizeReleaseDate(raw, precision) { ... }
```

Tests against the same fixture shapes used by
`server/tests/test_exporter.py`, ported to JS — guarantees the two
exporters produce equivalent documents.

## `lib/spotify.js` — the API client

```js
export async function getWebPlayerToken() { /* fetch + isAnonymous check */ }

export class SpotifyClient {
  constructor(accessToken) { /* ... */ }
  async me() { /* GET /v1/me */ }
  async followedShows() { /* paginate /v1/me/shows */ }
  async savedEpisodes() { /* paginate /v1/me/episodes */ }
}
```

`SpotifyClient` paginates by following the `next` URL on each page,
matching `_paginate` in `server/portcast_server/spotify.py`.

No `chrome.*` calls — the only platform dependency is global
`fetch`, which exists in MV3 service workers, in Trimplayer's
mobile WebView, in Node 18+ for tests, and on every browser page.

## Popup UI

Single screen, three states:

```
┌────────────────────────────────────┐
│ PortCast                           │
│                                    │
│  Export your Spotify library to a  │
│  .portcast.json file.              │
│                                    │
│        [  Export Spotify  ]        │
│                                    │
│  Runs entirely in your browser.    │
│  Nothing is sent to a server.      │
└────────────────────────────────────┘
```

→ click → progress:

```
│ Fetching followed shows… 87/142    │
```

→ done:

```
│ ✓ Saved spotify-jonathan-2026-05-  │
│   30.portcast.json                 │
│   142 subscriptions, 88 episodes   │
│                                    │
│ Open in Trimplayer — coming soon   │
│ [  Export again  ]                 │
```

The "Open in Trimplayer — coming soon" line surfaces the import path
PortCast is being built to feed. Acceptable on this surface because
the user just took a deliberate Spotify-to-elsewhere action and is
about to look for somewhere to land. When Trimplayer ships a
PortCast import handler, this becomes an active deep link.

→ not-signed-in alternate:

```
│ You're not signed in to Spotify    │
│ in this browser.                   │
│                                    │
│ [  Open Spotify and sign in  ]     │
│ (close this popup, sign in, then   │
│  click the icon again)             │
```

No new-tab page, no options page in v1. Add later if needed.

## Output

- Filename: `spotify-<spotify-user-id>-<YYYY-MM-DD>.portcast.json`
  (same pattern as the server) — matches across surfaces so users
  who try both don't get confused.
- Triggered via `chrome.downloads.download({ saveAs: true })` so
  the user picks the location. Avoids "where did the file go?".
- No "Send to Trimplayer" deep link in v1 — deferred until
  Trimplayer's mobile import handler is built. Will be a follow-up.

## Testing strategy

Two layers, both runnable from CI:

1. **Unit tests for `lib/portcast.js`.** `node --test
   tests/portcast.test.mjs`. Fixture data ported from
   `server/tests/test_exporter.py`. Same status-mapping assertions,
   same release-date precision cases, same empty-library edge case.
   Confirms parity with the Python exporter.
2. **Unit tests for `lib/spotify.js`.** `node --test
   tests/spotify.test.mjs`. Stub global `fetch` with a deterministic
   responder; assert correct paging behavior, header construction,
   anonymous-token detection.

Manual E2E (not in CI): load unpacked, sign in to Spotify, export,
run the downloaded file through `portcast validate` and
`portcast inspect` from the reference Python CLI.

No browser-DOM integration tests in v1. The popup is mechanical
glue.

## Distribution

Phase 1 — **unpacked**, shared as a zip. Anyone willing to enable
Chrome's developer mode can install. Lets us iterate without
review latency.

Phase 2 — **Chrome Web Store**. Requires:

- Public privacy policy URL → already at
  `https://portcast.org/privacy.html`, will add §6 for the
  extension's specific data flow.
- Screenshots (popup, in-progress, done) — produce by loading the
  unpacked version against a real account.
- A short "single purpose" description that matches the manifest.
- ~$5 one-time developer fee, paid from the dev account that
  publishes.

Phase 3 — **Firefox + Edge**. The manifest ports near-cleanly to
Firefox (manifest_version 3 is supported as of FF 109; some
`background.scripts` vs `service_worker` quirks). Edge accepts MV3
Chrome bundles as-is. Defer until Chrome is stable.

## What we deliberately don't do

- **Don't talk to `import.portcast.org`** from the extension. The
  whole point is to skip the server.
- **Don't cache Spotify responses to disk** (no `storage`
  permission). One run = one file. If the user wants snapshots over
  time, they save the files.
- **Don't add a "Sign in with Spotify" OAuth flow inside the
  extension.** That would land us back at the Developer API quota.
- **Don't poll, don't sync, don't run in the background.** The
  service worker only wakes on user click.
- **Don't request `<all_urls>` or `tabs`.** Tight host_permissions
  is load-bearing for Web Store review.

## Privacy story

Mirror of the existing privacy framing, sharpened for the
extension:

- The extension only acts when you click its icon.
- It reads your Spotify library data and writes a file. Nothing
  goes to any third party — including us. There is no
  `import.portcast.org` involvement.
- It does not store your Spotify data on disk after the export
  completes.
- It does not contain analytics, telemetry, or remote logging.
- It uses the same Spotify session your browser is already signed
  in to; we never see the session token.

This goes into `docs/privacy.html` §6 once the extension is
loadable.

## Risks worth restating

1. **Endpoint drift.** Spotify changes `/get_access_token` →
   extension breaks until we ship a patch. Mitigation: surface a
   clear error message, not a silent failure.
2. **Chrome Web Store review.** Possible to be flagged as
   "circumventing a third-party service's TOS." The framing is
   "user-initiated export of their own data, no third-party data
   stored." Plan B: unpacked + Firefox.
3. **Cross-browser maintenance.** MV3 surface differs slightly
   across vendors. Acceptable cost; the lib/ modules don't change.
4. **Trust signaling.** Until the Web Store has reviews, some users
   will be hesitant to install. Mitigation: source code on GitHub,
   privacy policy live, screencast of the flow.

## Resolved choices

- **Name:** `PortCast Export` (short, platform-agnostic since the
  architecture is multi-platform from day one).
- **Done screen:** filename + summary + "Open in Trimplayer —
  coming soon" placeholder + "Export again" button.
- **Version:** `0.1.0` (matches the spec version family).
- **Icons:** drafted in `ICONS.md` for you to pick from before the
  scaffold finalizes.
