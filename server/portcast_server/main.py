"""FastAPI app wiring the Spotify OAuth flow to the PortCast exporter.

Flow (stateless — no DB):
  1. GET /spotify/login   → set signed `pc_state` cookie, redirect to Spotify.
  2. GET /spotify/callback → verify state cookie, exchange code for token,
     set short-lived signed `pc_tok` cookie, redirect to /spotify/export.
  3. GET /spotify/export   → read token cookie, pull library, return the
     `.portcast.json` as an `application/vnd.portcast+json` download and
     clear the cookie.

Both cookies are HttpOnly, SameSite=Lax, and signed with SESSION_SECRET
via itsdangerous so a tampered cookie is rejected outright.
"""
from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from itsdangerous import BadSignature, URLSafeTimedSerializer

from . import __version__
from .config import Settings, load_settings
from .exporter import build_document
from .spotify import (
    ACCOUNTS_BASE,
    SCOPES,
    SpotifyAPIError,
    SpotifyAuthError,
    SpotifyClient,
    exchange_code_for_token,
)

STATE_COOKIE = "pc_state"
TOKEN_COOKIE = "pc_tok"
STATE_TTL_SECONDS = 600        # OAuth round-trip
TOKEN_COOKIE_TTL_SECONDS = 300  # callback → /spotify/export hop


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    serializer = URLSafeTimedSerializer(settings.session_secret, salt="portcast-server")

    app = FastAPI(
        title="PortCast export server",
        version=__version__,
        description="Exports a Spotify user's library as a PortCast document.",
    )
    app.state.settings = settings
    app.state.serializer = serializer

    # ------------------------------------------------------------------ routes

    @app.get("/", response_class=HTMLResponse)
    async def root() -> HTMLResponse:
        return HTMLResponse(_LANDING_HTML)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    @app.get("/spotify/login")
    async def spotify_login() -> RedirectResponse:
        state = secrets.token_urlsafe(24)
        signed_state = serializer.dumps({"state": state})
        params = {
            "response_type": "code",
            "client_id": settings.spotify_client_id,
            "scope": " ".join(SCOPES),
            "redirect_uri": settings.spotify_redirect_uri,
            "state": state,
            # show_dialog=true ensures the user can pick an account even
            # if they're already signed in to Spotify in this browser.
            "show_dialog": "true",
        }
        redirect = RedirectResponse(
            url=f"{ACCOUNTS_BASE}/authorize?{urlencode(params)}",
            status_code=302,
        )
        redirect.set_cookie(
            STATE_COOKIE,
            signed_state,
            max_age=STATE_TTL_SECONDS,
            httponly=True,
            samesite="lax",
            secure=_is_https(settings.spotify_redirect_uri),
        )
        return redirect

    @app.get("/spotify/callback")
    async def spotify_callback(request: Request) -> RedirectResponse:
        error = request.query_params.get("error")
        if error:
            raise HTTPException(400, f"Spotify authorization failed: {error}")
        code = request.query_params.get("code")
        state = request.query_params.get("state")
        if not code or not state:
            raise HTTPException(400, "Missing code or state from Spotify callback.")

        signed_state = request.cookies.get(STATE_COOKIE)
        if not signed_state:
            raise HTTPException(400, "Missing OAuth state cookie — did the login flow start here?")
        try:
            payload = serializer.loads(signed_state, max_age=STATE_TTL_SECONDS)
        except BadSignature as exc:
            raise HTTPException(400, "OAuth state cookie is invalid or expired.") from exc
        if payload.get("state") != state:
            raise HTTPException(400, "OAuth state mismatch.")

        try:
            token = await exchange_code_for_token(
                code=code,
                client_id=settings.spotify_client_id,
                client_secret=settings.spotify_client_secret,
                redirect_uri=settings.spotify_redirect_uri,
            )
        except SpotifyAuthError as exc:
            raise HTTPException(502, str(exc)) from exc

        access_token = token.get("access_token")
        if not access_token:
            raise HTTPException(502, "Spotify returned no access token.")

        signed_tok = serializer.dumps({"access_token": access_token})
        response = RedirectResponse(url="/spotify/export", status_code=302)
        response.delete_cookie(STATE_COOKIE)
        response.set_cookie(
            TOKEN_COOKIE,
            signed_tok,
            max_age=TOKEN_COOKIE_TTL_SECONDS,
            httponly=True,
            samesite="lax",
            secure=_is_https(settings.spotify_redirect_uri),
        )
        return response

    @app.get("/spotify/export")
    async def spotify_export(request: Request) -> Response:
        signed_tok = request.cookies.get(TOKEN_COOKIE)
        if not signed_tok:
            # Lead users back through the front door instead of 401-ing
            # them — bookmarking /spotify/export is a likely mistake.
            return RedirectResponse(url="/spotify/login", status_code=302)
        try:
            payload = serializer.loads(signed_tok, max_age=TOKEN_COOKIE_TTL_SECONDS)
        except BadSignature:
            return RedirectResponse(url="/spotify/login", status_code=302)

        access_token = payload.get("access_token")
        if not access_token:
            return RedirectResponse(url="/spotify/login", status_code=302)

        try:
            async with httpx.AsyncClient(timeout=20.0) as http:
                client = SpotifyClient(access_token, http=http)
                me = await client.me()
                saved_shows = await client.followed_shows()
                saved_episodes = await client.saved_episodes()
        except SpotifyAPIError as exc:
            raise HTTPException(502, str(exc)) from exc

        document = build_document(
            me=me,
            saved_shows=saved_shows,
            saved_episodes=saved_episodes,
            generator_version=__version__,
        )

        body = json.dumps(document.to_dict(), indent=2).encode("utf-8")
        filename = _filename_for(me)
        response = Response(
            content=body,
            media_type="application/vnd.portcast+json",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Cache-Control": "no-store",
            },
        )
        response.delete_cookie(TOKEN_COOKIE)
        return response

    return app


def _is_https(redirect_uri: str) -> bool:
    return redirect_uri.lower().startswith("https://")


def _filename_for(me: dict[str, Any] | None) -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    handle = ""
    if isinstance(me, dict):
        handle = (me.get("id") or "").strip()
    safe_handle = "".join(c for c in handle if c.isalnum() or c in ("-", "_"))[:40]
    stem = f"spotify-{safe_handle}" if safe_handle else "spotify"
    return f"{stem}-{today}.portcast.json"


_LANDING_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Export your Spotify podcasts &mdash; PortCast</title>
  <style>
    body { font: 16px/1.55 system-ui, sans-serif; max-width: 38rem;
           margin: 4rem auto; padding: 0 1rem; color: #1b1b1b; }
    h1 { font-size: 1.6rem; }
    a.btn { display: inline-block; padding: 0.7rem 1.1rem;
            background: #1db954; color: white; text-decoration: none;
            border-radius: 6px; font-weight: 600; }
    .fine { color: #555; font-size: 0.9rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>Export your Spotify podcasts as PortCast</h1>
  <p>
    Sign in with Spotify and we&rsquo;ll hand you a
    <code>.portcast.json</code> file containing your followed shows,
    your saved episodes, and the resume position Spotify has on file
    for each one.
  </p>
  <p><a class="btn" href="/spotify/login">Connect Spotify</a></p>
  <p class="fine">
    The access token lives only in a short-lived signed cookie. We do
    not store your Spotify data &mdash; we read it once and return it
    to you. See the
    <a href="https://portcast.org">PortCast spec</a> for what&rsquo;s
    in the file, and the
    <a href="https://portcast.org/privacy.html">privacy policy</a> for
    exactly what we touch.
  </p>
</body>
</html>
"""


# Run with: `uvicorn --factory portcast_server.main:create_app`
# A factory keeps `create_app()` from firing on import — tests can
# import this module without needing the env vars set.
