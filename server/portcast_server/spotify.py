"""Thin async wrapper around the Spotify Web API.

Exposes only what the PortCast exporter needs: OAuth token exchange,
the current user's profile, paginated followed shows, paginated saved
episodes. Returns raw response dicts so the exporter (and its tests)
can work against captured Spotify fixtures without touching the
network.
"""
from __future__ import annotations

import base64
from typing import Any, AsyncIterator

import httpx

ACCOUNTS_BASE = "https://accounts.spotify.com"
API_BASE = "https://api.spotify.com/v1"

# Scopes needed for the PortCast export:
#   user-library-read              → /me/shows, /me/episodes
#   user-read-playback-position    → resume_point on episodes
#   user-read-email + user-read-private → /me, for owner.displayName/email
SCOPES = (
    "user-library-read",
    "user-read-playback-position",
    "user-read-email",
    "user-read-private",
)


class SpotifyAuthError(RuntimeError):
    """Raised when token exchange fails."""


class SpotifyAPIError(RuntimeError):
    """Raised when a Spotify API call returns a non-2xx response."""


def _basic_auth_header(client_id: str, client_secret: str) -> str:
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


async def exchange_code_for_token(
    *,
    code: str,
    client_id: str,
    client_secret: str,
    redirect_uri: str,
    http: httpx.AsyncClient | None = None,
) -> dict[str, Any]:
    """Trade an OAuth authorization code for an access token.

    Returns the raw token response — caller pulls ``access_token`` and the
    optional ``refresh_token`` out of it.
    """
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }
    headers = {
        "Authorization": _basic_auth_header(client_id, client_secret),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    owns_client = http is None
    client = http or httpx.AsyncClient(timeout=15.0)
    try:
        resp = await client.post(
            f"{ACCOUNTS_BASE}/api/token", data=payload, headers=headers
        )
    finally:
        if owns_client:
            await client.aclose()
    if resp.status_code != 200:
        raise SpotifyAuthError(
            f"Spotify token exchange failed: {resp.status_code} {resp.text}"
        )
    return resp.json()


class SpotifyClient:
    """Authenticated Spotify Web API client.

    Constructed with an access token; does not refresh on its own — the
    PortCast export is a one-shot read, well under the token lifetime,
    so a refresh dance would be dead code.
    """

    def __init__(
        self, access_token: str, http: httpx.AsyncClient | None = None
    ) -> None:
        self._token = access_token
        self._http = http or httpx.AsyncClient(timeout=15.0)
        self._owns_http = http is None

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()

    async def __aenter__(self) -> "SpotifyClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        url = path if path.startswith("http") else f"{API_BASE}{path}"
        resp = await self._http.get(
            url,
            params=params,
            headers={"Authorization": f"Bearer {self._token}"},
        )
        if resp.status_code != 200:
            raise SpotifyAPIError(
                f"GET {url} failed: {resp.status_code} {resp.text}"
            )
        return resp.json()

    async def me(self) -> dict[str, Any]:
        """Current user profile (display_name, email, id, ...)."""
        return await self._get("/me")

    async def _paginate(
        self, path: str, params: dict[str, Any] | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield every item from a paginated Spotify endpoint.

        Spotify's paging objects carry a ``next`` URL (or null) and an
        ``items`` array. The first request goes to ``path``; subsequent
        requests follow ``next`` verbatim.
        """
        params = dict(params or {})
        params.setdefault("limit", 50)
        next_url: str | None = path
        first = True
        while next_url:
            page = await self._get(next_url, params=params if first else None)
            for item in page.get("items", []):
                yield item
            next_url = page.get("next")
            first = False

    async def followed_shows(self) -> list[dict[str, Any]]:
        """All shows in the user's library (paginated)."""
        return [item async for item in self._paginate("/me/shows")]

    async def saved_episodes(self) -> list[dict[str, Any]]:
        """All episodes in the user's library (paginated)."""
        return [item async for item in self._paginate("/me/episodes")]
