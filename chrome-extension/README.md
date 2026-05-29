# PortCast Export — Chrome extension

A small Chrome extension that exports a Spotify listener's library
to a PortCast file. Runs entirely in the user's browser, using their
own `open.spotify.com` session — no developer-app quota involved, no
server in the loop, nothing stored.

This is the second of the two delivery surfaces PortCast ships
(alongside [`server/`](../server/), which uses the registered
developer-app path and is therefore quota-capped at 25 users by
Spotify Development Mode).

## Why this exists

See [`DESIGN.md`](DESIGN.md) for the full rationale, manifest
permission breakdown, and architecture for adding the next
platform. The short version: as of 2025-05-15, Spotify only grants
Extended Quota Mode to registered partners with ~250k MAU, so any
broad-distribution Spotify-side export path has to use the user's
own web-player session rather than a developer credential.

## Install (unpacked, for development)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Pick this directory (`chrome-extension/`).
5. Pin the PortCast icon to the toolbar via the puzzle-piece menu.

To use:

1. Sign in to <https://open.spotify.com>.
2. Click the PortCast toolbar icon.
3. Click **Export from Spotify**.
4. Pick where to save the `.portcast.json` file.

## Tests

```bash
cd chrome-extension
npm test
```

The library modules (`lib/portcast.js`, `lib/platforms/spotify.js`)
have no DOM and no `chrome.*` dependencies, so the entire test
suite runs under plain `node --test`. Fixture shapes mirror the
Python exporter's tests in
[`server/tests/test_exporter.py`](../server/tests/test_exporter.py),
so the JS and Python paths produce equivalent documents for the
same input.

## What's in here

```
chrome-extension/
├── manifest.json         # MV3, downloads + Spotify host perms
├── popup.html / .css     # 320px popup UI
├── popup.js              # thin shell, talks to background.js
├── background.js         # MV3 service worker — orchestrator
├── lib/
│   ├── portcast.js       # spec types + buildDocument
│   ├── platforms.js      # registry
│   └── platforms/
│       └── spotify.js    # token fetch + library fetch + mapping
├── icons/                # 16/48/128 PNGs
├── tests/                # node --test
├── DESIGN.md             # full design doc
├── ICONS.md              # icon mark proposals (pick one)
└── README.md             # this file
```

## License

MIT — same as the rest of the reference code.
