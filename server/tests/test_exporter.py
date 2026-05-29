"""Exporter tests against fixture-shaped Spotify responses.

The fixtures here mirror the actual shapes Spotify returns (verified
against the public Web API reference docs) but are hand-built so they
can stay in-repo. If real-world responses drift, capture a fresh one
and add it as a new fixture rather than mutating these in place.
"""
from __future__ import annotations

from typing import Any

import pytest

from portcast import validate
from portcast_server.exporter import build_document


CAPTURED_AT = "2026-05-29T14:00:00Z"


def _me() -> dict[str, Any]:
    return {
        "id": "jonathan",
        "display_name": "Jonathan",
        "email": "trimplayerapp@gmail.com",
    }


def _saved_shows() -> list[dict[str, Any]]:
    return [
        {
            "added_at": "2024-06-01T09:14:00Z",
            "show": {
                "id": "5CnDmMUG0S5bSSw612fs8C",
                "name": "Portable Listening Weekly",
                "publisher": "Jane Doe",
                "images": [{"url": "https://i.scdn.co/image/portable.jpg"}],
                "uri": "spotify:show:5CnDmMUG0S5bSSw612fs8C",
            },
        },
        {
            "added_at": "2025-11-04T08:00:00Z",
            "show": {
                "id": "7makk4oTQel546B0PZlDM5",
                "name": "A Spotify Exclusive",
                "publisher": "Some Studio",
                "images": [],
                "uri": "spotify:show:7makk4oTQel546B0PZlDM5",
            },
        },
    ]


def _saved_episodes() -> list[dict[str, Any]]:
    return [
        # In-progress: resume_point is non-zero, fully_played is False.
        {
            "added_at": "2026-05-25T08:11:00Z",
            "episode": {
                "id": "ep-in-progress",
                "name": "Episode 42: On Portable Listening",
                "release_date": "2026-05-20",
                "release_date_precision": "day",
                "duration_ms": 3287000,
                "resume_point": {
                    "fully_played": False,
                    "resume_position_ms": 1245200,
                },
                "uri": "spotify:episode:ep-in-progress",
                "show": {
                    "id": "5CnDmMUG0S5bSSw612fs8C",
                    "name": "Portable Listening Weekly",
                },
            },
        },
        # Fully played: status should be completed and positionSeconds dropped.
        {
            "added_at": "2026-05-13T07:00:00Z",
            "episode": {
                "id": "ep-completed",
                "name": "Episode 41: Why GUIDs Matter",
                "release_date": "2026-05-13",
                "release_date_precision": "day",
                "duration_ms": 2940000,
                "resume_point": {
                    "fully_played": True,
                    "resume_position_ms": 2940000,
                },
                "uri": "spotify:episode:ep-completed",
                "show": {
                    "id": "5CnDmMUG0S5bSSw612fs8C",
                    "name": "Portable Listening Weekly",
                },
            },
        },
        # Saved but never played: resume_point absent or zero.
        {
            "added_at": "2026-05-20T10:00:00Z",
            "episode": {
                "id": "ep-unplayed",
                "name": "Bonus: Spotify Exclusive Pilot",
                "release_date": "2026-05",
                "release_date_precision": "month",
                "duration_ms": 1800000,
                "resume_point": {
                    "fully_played": False,
                    "resume_position_ms": 0,
                },
                "uri": "spotify:episode:ep-unplayed",
                "show": {
                    "id": "7makk4oTQel546B0PZlDM5",
                    "name": "A Spotify Exclusive",
                },
            },
        },
    ]


@pytest.fixture
def document():
    return build_document(
        me=_me(),
        saved_shows=_saved_shows(),
        saved_episodes=_saved_episodes(),
        generator_version="0.1.0",
        captured_at=CAPTURED_AT,
    )


def test_subscriptions_carry_spotify_platform_refs(document):
    refs = [s.platformRefs for s in document.subscriptions]
    assert refs == [
        ["spotify:show:5CnDmMUG0S5bSSw612fs8C"],
        ["spotify:show:7makk4oTQel546B0PZlDM5"],
    ]
    # Spotify-exclusive subscriptions never get a feedUrl or podcastGuid.
    assert all(s.feedUrl is None and s.podcastGuid is None for s in document.subscriptions)


def test_subscription_subscribed_at_propagates_from_added_at(document):
    assert document.subscriptions[0].subscribedAt == "2024-06-01T09:14:00Z"


def test_in_progress_episode_carries_position(document):
    ep = next(e for e in document.episodes if e.platformRefs == ["spotify:episode:ep-in-progress"])
    assert ep.status == "in_progress"
    assert ep.positionSeconds == pytest.approx(1245.2)
    assert ep.subscriptionRef.platformRefs == ["spotify:show:5CnDmMUG0S5bSSw612fs8C"]


def test_completed_episode_drops_position(document):
    ep = next(e for e in document.episodes if e.platformRefs == ["spotify:episode:ep-completed"])
    assert ep.status == "completed"
    # Once Spotify reports fully_played, the resume position is
    # meaningless — we don't want it round-tripping into an importer.
    assert ep.positionSeconds is None


def test_unplayed_episode_is_unplayed(document):
    ep = next(e for e in document.episodes if e.platformRefs == ["spotify:episode:ep-unplayed"])
    assert ep.status == "unplayed"
    assert ep.positionSeconds is None


def test_release_date_month_precision_widens_to_first_of_month(document):
    ep = next(e for e in document.episodes if e.platformRefs == ["spotify:episode:ep-unplayed"])
    assert ep.publishedAt == "2026-05-01T00:00:00Z"


def test_owner_is_populated_from_me(document):
    assert document.owner is not None
    assert document.owner.displayName == "Jonathan"
    assert document.owner.email == "trimplayerapp@gmail.com"


def test_completeness_pins_episode_section_as_current_state_only(document):
    levels = {c.section: c.level for c in (document.completeness or [])}
    assert levels == {
        "subscriptions": "full",
        "episodes": "current-state-only",
    }


def test_document_validates_against_spec_schema(document):
    # Round-trip through schema validation — catches any field we wrote
    # in a shape the spec rejects.
    validate(document.to_dict())


def test_empty_library_still_produces_valid_document():
    doc = build_document(
        me=None,
        saved_shows=[],
        saved_episodes=[],
        captured_at=CAPTURED_AT,
    )
    assert doc.subscriptions == []
    assert doc.episodes == []
    assert doc.owner is None
    validate(doc.to_dict())
