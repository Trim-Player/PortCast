"""Build a PortCast document from a Spotify user's data.

Pure functions over already-fetched Spotify payloads — the network is
the SpotifyClient's job. This module is the part the tests pin against
fixture data captured from real Spotify responses.

What we extract:
  * Followed shows → ``subscriptions`` with ``platformRefs``.
  * Saved episodes → ``episodes`` with status/position derived from
    ``resume_point``.
  * ``/me`` → ``owner.displayName`` / ``owner.email`` (best-effort).
  * Two ``CompletenessAssertion`` entries pinning the truth of what
    Spotify lets us see:
      - subscriptions: ``full`` (Spotify returns every followed show)
      - episodes: ``current-state-only`` (no event log; only "saved"
        episodes carry resume_point, not the long tail of plays)
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from portcast import (
    CompletenessAssertion,
    EpisodeState,
    Generator,
    Owner,
    PortCastDocument,
    Subscription,
    SubscriptionRef,
)

GENERATOR_NAME = "PortCast Spotify export"
GENERATOR_URL = "https://portcast.org"
SPOTIFY_SOURCE = "spotify"


def _now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _normalize_release_date(raw: str | None, precision: str | None) -> str | None:
    """Spotify release_date is `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`.

    PortCast expects an ISO 8601 instant. We widen to start-of-day UTC
    when the precision is coarser than a day; if Spotify gives us
    nothing usable we return None so the field is dropped from the doc.
    """
    if not raw:
        return None
    p = (precision or "day").lower()
    if p == "year" and len(raw) == 4:
        return f"{raw}-01-01T00:00:00Z"
    if p == "month" and len(raw) == 7:
        return f"{raw}-01T00:00:00Z"
    if p == "day" and len(raw) == 10:
        return f"{raw}T00:00:00Z"
    return None


def _subscription_from_saved_show(saved: dict[str, Any], captured_at: str) -> Subscription:
    show = saved.get("show") or {}
    show_id = show.get("id")
    images = show.get("images") or []
    image_url = images[0].get("url") if images and isinstance(images[0], dict) else None
    return Subscription(
        title=show.get("name") or "(untitled show)",
        author=show.get("publisher"),
        imageUrl=image_url,
        subscribedAt=saved.get("added_at"),
        platformRefs=[f"spotify:show:{show_id}"] if show_id else None,
        updatedAt=captured_at,
    )


def _episode_from_saved_episode(
    saved: dict[str, Any], captured_at: str
) -> EpisodeState | None:
    ep = saved.get("episode") or {}
    ep_id = ep.get("id")
    show = ep.get("show") or {}
    show_id = show.get("id")
    if not ep_id or not show_id:
        # An episode with no Spotify ID, or detached from its show, is
        # unaddressable on the import side — skip it rather than emit a
        # broken reference.
        return None

    duration_ms = ep.get("duration_ms")
    duration_s = duration_ms / 1000.0 if isinstance(duration_ms, (int, float)) else None

    resume = ep.get("resume_point") or {}
    fully_played = bool(resume.get("fully_played"))
    resume_ms = resume.get("resume_position_ms") or 0
    position_s = resume_ms / 1000.0 if resume_ms else None

    if fully_played:
        status = "completed"
        # Spotify doesn't surface a completion timestamp; positionSeconds
        # is meaningless once an episode is fully played.
        position_s = None
    elif position_s and position_s > 0:
        status = "in_progress"
    else:
        status = "unplayed"
        position_s = None

    return EpisodeState(
        subscriptionRef=SubscriptionRef(platformRefs=[f"spotify:show:{show_id}"]),
        platformRefs=[f"spotify:episode:{ep_id}"],
        title=ep.get("name"),
        publishedAt=_normalize_release_date(
            ep.get("release_date"), ep.get("release_date_precision")
        ),
        durationSeconds=duration_s,
        status=status,
        positionSeconds=position_s,
        source=SPOTIFY_SOURCE,
        capturedAt=captured_at,
        updatedAt=captured_at,
    )


def _owner_from_me(me: dict[str, Any] | None) -> Owner | None:
    if not me:
        return None
    display = me.get("display_name") or None
    email = me.get("email") or None
    if not display and not email:
        return None
    return Owner(displayName=display, email=email)


def build_document(
    *,
    me: dict[str, Any] | None,
    saved_shows: list[dict[str, Any]],
    saved_episodes: list[dict[str, Any]],
    generator_version: str | None = None,
    captured_at: str | None = None,
) -> PortCastDocument:
    """Assemble a PortCast document from raw Spotify payloads."""
    captured_at = captured_at or _now_iso()

    subscriptions = [_subscription_from_saved_show(s, captured_at) for s in saved_shows]

    episodes: list[EpisodeState] = []
    for saved in saved_episodes:
        ep = _episode_from_saved_episode(saved, captured_at)
        if ep is not None:
            episodes.append(ep)

    completeness = [
        CompletenessAssertion(
            section="subscriptions",
            source=SPOTIFY_SOURCE,
            level="full",
            capturedAt=captured_at,
            note="All shows in the user's Spotify library at export time.",
        ),
        CompletenessAssertion(
            section="episodes",
            source=SPOTIFY_SOURCE,
            level="current-state-only",
            capturedAt=captured_at,
            note=(
                "Spotify exposes resume_point only for saved episodes; "
                "no per-episode event log is available."
            ),
        ),
    ]

    return PortCastDocument(
        generator=Generator(
            name=GENERATOR_NAME,
            version=generator_version,
            url=GENERATOR_URL,
        ),
        owner=_owner_from_me(me),
        subscriptions=subscriptions,
        episodes=episodes,
        completeness=completeness,
        generatedAt=captured_at,
    )
