# lib/ — pure ES modules

Every file in this directory must work unchanged inside:

- the Chrome extension service worker (`background.js` imports them)
- a Node `--test` runner (the test files here import them directly)
- a WebView inside the Trimplayer mobile app, via injected JavaScript

That means **no `chrome.*` calls, no DOM access, no Node built-ins.**
The only platform-provided globals these modules use are `fetch`,
`URL`, `URLSearchParams`, and (optionally) `crypto.randomUUID` —
all of which exist in every target environment.

## Files

- `portcast.js` — builds a PortCast document from already-fetched
  platform payloads. Mirror of `server/portcast_server/exporter.py`;
  tests in `../tests/portcast.test.mjs` reuse the same fixture
  shapes as the Python exporter tests.
- `platforms.js` — registry listing which sources the extension
  supports.
- `platforms/spotify.js` — Spotify session detection, library fetch,
  and end-to-end `exportToPortCast()`.

## Adding a platform

1. Create `platforms/<id>.js` exporting `PLATFORM_ID`,
   `PLATFORM_NAME`, `detectSession()`, `exportToPortCast()`.
2. Add the import + entry in `platforms.js`.
3. Add the platform's host(s) to `host_permissions` in
   `../manifest.json`. Without this, fetches will fail in the
   service worker.
4. Add fixture-based tests in `../tests/<id>.test.mjs`.
