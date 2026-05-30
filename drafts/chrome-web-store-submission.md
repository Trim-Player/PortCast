# Chrome Web Store submission — PortCast Export

Working copy of the listing copy and per-permission justifications for
the PortCast Export extension. Paste each section into the corresponding
field in the CWS developer dashboard at submission time.

**Privacy policy URL** (paste into the dashboard's "Privacy policy"
field): https://portcast.org/privacy.html

The hosted policy already includes §3 covering the extension.

---

## Store listing

**Name**
PortCast Export

**Short description (≤132 chars)**
Export your Spotify podcast library — followed shows, saved episodes, resume positions — to a portable PortCast file.

**Category**
Productivity

**Detailed description**

PortCast Export saves the podcast library from your signed-in Spotify
account to a portable `.portcast.json` file on your computer.

What gets exported:
- The podcast shows you follow
- Episodes you've saved to "Your Episodes"
- Your in-progress listening positions where Spotify exposes them

How it works:
1. Sign in to open.spotify.com in this browser as you normally would.
2. Click the PortCast Export toolbar icon and press Export.
3. The extension reads your library from the Spotify page you're
   already authenticated on, builds an open-format PortCast file, and
   saves it through your normal browser download dialog.

What PortCast Export does NOT do:
- It does not send your data to PortCast, Trimplayer, or any other
  server. The export runs entirely in your browser and the file is
  saved locally.
- It does not store, log, or remember your Spotify credentials.
- It does not modify your Spotify account or library in any way.
- It does not run on any site other than open.spotify.com.

The PortCast format is an open spec (https://portcast.org) intended
for moving your subscriptions and listening history between podcast
apps. PortCast Export is the first-party Spotify exporter for that
format.

---

## Single-purpose statement

Export the signed-in user's own podcast library data from Spotify
(open.spotify.com) to a portable `.portcast.json` file saved to the
user's device.

---

## Permission justifications

### `downloads`
The sole purpose of the extension is to produce a `.portcast.json`
file on the user's disk. After the export payload is built in memory,
the extension calls `chrome.downloads.download` with `saveAs: true` so
the browser shows its standard Save-As dialog. No other use of the
downloads API.

### `scripting`
Used once per export to inject a small library-fetcher function into
the user's existing `open.spotify.com` tab via
`chrome.scripting.executeScript`. The injected function runs in the
ISOLATED world, reads the library the user is already authenticated to
see, returns the result to the service worker, and exits. No code is
injected on any other site, and no code is fetched from a remote
source — the injected function is shipped inside the extension bundle.

### Host permission: `https://open.spotify.com/*`
The export reads the user's library from the Spotify web player they
are signed in to. The extension needs to (a) navigate or open a tab at
open.spotify.com so the page is in a known authenticated state, and
(b) inject the library-fetcher into that tab. No other use of this
host permission.

### Content script in MAIN world on `https://open.spotify.com/*`
The Spotify web player's library API (`api-partner.spotify.com/pathfinder`)
requires a paired Bearer token + Client-Token that are minted by the
player's own JavaScript and never exposed to the page DOM. The content
script wraps `fetch` and `XHR` inside the page so that when the
player itself makes an authenticated library request, the extension can
read the two tokens it generated for *that user's own session* and
reuse them on the user's behalf to page through the rest of the
library.

The hook:
- Only runs on open.spotify.com.
- Only reads request headers from requests the page itself initiated.
- Writes the captured tokens into `sessionStorage` on
  open.spotify.com so the injected fetcher can read them. They are
  cleared at the end of each export.
- Does not transmit anything off-device.

This is the standard mechanism for user-initiated data portability
against modern SPA web players that no longer expose stable public
REST APIs.

---

## Privacy policy

Already hosted at https://portcast.org/privacy.html — §3 of that page
covers the PortCast Export extension. Paste that URL into the
dashboard's "Privacy policy" field.
