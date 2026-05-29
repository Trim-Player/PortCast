# PortCast export server

A small FastAPI service that lets a Spotify listener download their library
as a PortCast document. Deployed at `import.portcast.org`; the static spec
site at `portcast.org` links here for the "export from Spotify" flow.

## Scope

This first cut is Spotify-only. The Spotify Web API exposes:

- The user's followed shows (`/v1/me/shows`)
- The user's saved episodes (`/v1/me/episodes`)
- Per-episode `resume_point` when the `user-read-playback-position` scope
  is granted

It does **not** expose a full episode-by-episode play history. The
generated document therefore marks the `episodes` section as
`current-state-only` via a `CompletenessAssertion`. Queue, bookmarks and
preferences are not surfaced by Spotify and are omitted.

Spotify-exclusive shows have no RSS feed, so subscriptions are written with
`platformRefs: ["spotify:show:..."]` and no `feedUrl` / `podcastGuid`.
Importers that key off RSS GUIDs will need to honor `platformRefs` to
re-attach those shows.

## Run locally

```bash
cd server
cp .env.example .env             # fill in real values
pip install -e ".[dev]"
uvicorn --factory portcast_server.main:create_app --reload --port 8000
```

Register `http://127.0.0.1:8000/spotify/callback` as a redirect URI on
your Spotify developer app. Then open <http://127.0.0.1:8000/spotify/login>
and complete the OAuth flow — you'll be redirected to `/spotify/export`
which returns the `.portcast.json` as a file download.

## Tests

```bash
pytest
```

## Deploy

Behind a reverse proxy (nginx / Caddy) terminating TLS for
`import.portcast.org`, with `SPOTIFY_REDIRECT_URI` set to the public
callback URL. The service is stateless — no DB, no persistent sessions;
the only state in flight is a signed cookie carrying the OAuth state
during the redirect dance and a short-lived signed cookie carrying the
access token from callback to export.
