"""Smoke tests for the FastAPI surface.

These exercise the OAuth wiring shape without hitting Spotify:
- The login redirect must point at accounts.spotify.com with our scopes,
  redirect_uri, and a state value that round-trips through the cookie.
- The callback must reject a request whose `state` doesn't match what
  the signed cookie carries.
- /spotify/export with no token cookie must funnel the user back to
  /spotify/login, not 401.
"""
from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from portcast_server.config import Settings
from portcast_server.main import STATE_COOKIE, TOKEN_COOKIE, create_app


def _settings() -> Settings:
    return Settings(
        spotify_client_id="test-client-id",
        spotify_client_secret="test-client-secret",
        spotify_redirect_uri="http://127.0.0.1:8000/spotify/callback",
        session_secret="test-secret-test-secret-test-secret-test-secret",
        public_base_url=None,
    )


@pytest.fixture
def client() -> TestClient:
    return TestClient(create_app(_settings()))


def test_healthz_ok(client: TestClient) -> None:
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_landing_page_renders(client: TestClient) -> None:
    resp = client.get("/")
    assert resp.status_code == 200
    assert "Connect Spotify" in resp.text
    assert "/spotify/login" in resp.text


def test_login_redirects_to_spotify_with_state_cookie(client: TestClient) -> None:
    resp = client.get("/spotify/login", follow_redirects=False)
    assert resp.status_code == 302

    target = urlparse(resp.headers["location"])
    assert target.netloc == "accounts.spotify.com"
    assert target.path == "/authorize"

    qs = parse_qs(target.query)
    assert qs["client_id"] == ["test-client-id"]
    assert qs["redirect_uri"] == ["http://127.0.0.1:8000/spotify/callback"]
    assert qs["response_type"] == ["code"]
    assert "user-library-read" in qs["scope"][0]
    assert "user-read-playback-position" in qs["scope"][0]
    assert qs["state"]  # non-empty

    # And we set a signed state cookie carrying the same state value.
    assert STATE_COOKIE in resp.cookies


def test_callback_rejects_state_mismatch(client: TestClient) -> None:
    # Prime the state cookie by going through /spotify/login first.
    client.get("/spotify/login", follow_redirects=False)
    resp = client.get(
        "/spotify/callback",
        params={"code": "irrelevant", "state": "not-the-real-state"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert "state" in resp.text.lower()


def test_callback_rejects_missing_state_cookie() -> None:
    # Fresh client → no prior /spotify/login → no state cookie.
    fresh = TestClient(create_app(_settings()))
    resp = fresh.get(
        "/spotify/callback",
        params={"code": "irrelevant", "state": "anything"},
        follow_redirects=False,
    )
    assert resp.status_code == 400


def test_callback_propagates_spotify_error_param() -> None:
    fresh = TestClient(create_app(_settings()))
    resp = fresh.get(
        "/spotify/callback",
        params={"error": "access_denied"},
        follow_redirects=False,
    )
    assert resp.status_code == 400
    assert "access_denied" in resp.text


def test_export_without_token_cookie_redirects_to_login(client: TestClient) -> None:
    resp = client.get("/spotify/export", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/spotify/login"


def test_export_with_invalid_token_cookie_redirects_to_login(client: TestClient) -> None:
    client.cookies.set(TOKEN_COOKIE, "not-a-real-signed-value")
    resp = client.get("/spotify/export", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/spotify/login"
