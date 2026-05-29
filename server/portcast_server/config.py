"""Environment-driven settings.

Read once at startup. Missing required values raise a clear error so
misconfigured deploys fail before serving traffic instead of 500'ing
later when the missing var is finally used.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    spotify_client_id: str
    spotify_client_secret: str
    spotify_redirect_uri: str
    session_secret: str
    public_base_url: str | None = None


def _require(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise ConfigError(
            f"{name} is not set. Copy server/.env.example to .env, fill in real "
            "values, and load it before starting the server."
        )
    return val


def load_settings() -> Settings:
    return Settings(
        spotify_client_id=_require("SPOTIFY_CLIENT_ID"),
        spotify_client_secret=_require("SPOTIFY_CLIENT_SECRET"),
        spotify_redirect_uri=_require("SPOTIFY_REDIRECT_URI"),
        session_secret=_require("SESSION_SECRET"),
        public_base_url=(os.environ.get("PUBLIC_BASE_URL") or "").strip() or None,
    )
