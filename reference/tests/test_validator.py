"""Schema validation tests for the bundled sample document and edge cases."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from portcast import validate
from portcast.validator import ValidationError

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE = REPO_ROOT / "examples" / "sample-export.portcast.json"


def _minimal_doc() -> dict:
    return {
        "portcast": "0.2.0",
        "generatedAt": "2026-05-26T14:00:00Z",
        "generator": {"name": "test"},
        "subscriptions": [
            {
                "subscriptionId": "s1",
                "feedUrl": "https://example.com/feed.xml",
                "title": "Example",
                "updatedAt": "2026-05-26T14:00:00Z",
            }
        ],
        "episodes": [],
    }


def test_bundled_sample_validates():
    data = json.loads(SAMPLE.read_text(encoding="utf-8"))
    validate(data)  # must not raise


def test_minimal_doc_validates():
    validate(_minimal_doc())


def test_subscription_requires_some_identifier():
    doc = _minimal_doc()
    doc["subscriptions"][0].pop("feedUrl")
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    # jsonschema reports anyOf failures as "not valid under any of the given schemas";
    # what we really want to know is that validation pointed at the broken subscription.
    assert "subscriptions/0" in str(exc.value)


def test_subscription_accepts_platform_refs_as_only_identifier():
    doc = _minimal_doc()
    doc["subscriptions"][0].pop("feedUrl")
    doc["subscriptions"][0]["platformRefs"] = ["spotify:show:5CnDmMUG0S5bSSw612fs8C"]
    validate(doc)


def test_episode_accepts_platform_refs_as_only_identifier():
    doc = _minimal_doc()
    doc["subscriptions"][0]["platformRefs"] = ["spotify:show:5CnDmMUG0S5bSSw612fs8C"]
    doc["episodes"].append({
        "episodeStateId": "e1",
        "subscriptionRef": {"platformRefs": ["spotify:show:5CnDmMUG0S5bSSw612fs8C"]},
        "platformRefs": ["spotify:episode:7makk4oTQel546B0PZlDM5"],
        "status": "unplayed",
        "updatedAt": "2026-05-26T14:00:00Z",
    })
    validate(doc)


def test_platform_ref_must_match_uri_pattern():
    doc = _minimal_doc()
    doc["subscriptions"][0].pop("feedUrl")
    doc["subscriptions"][0]["platformRefs"] = ["not a valid ref"]
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    assert "platformRefs" in str(exc.value)


def test_playback_event_accepts_source_and_captured_at():
    doc = _minimal_doc()
    doc["episodes"].append({
        "episodeStateId": "e1",
        "subscriptionRef": {"feedUrl": "https://example.com/feed.xml"},
        "guid": "ep1",
        "status": "in_progress",
        "positionSeconds": 100,
        "source": "spotify-web-api",
        "capturedAt": "2026-05-29T14:00:00Z",
        "events": [
            {
                "type": "play",
                "at": "2026-05-29T13:55:00Z",
                "positionSeconds": 0,
                "source": "spotify-web-api",
                "capturedAt": "2026-05-29T14:00:00Z",
            }
        ],
        "updatedAt": "2026-05-29T14:00:00Z",
    })
    validate(doc)


def test_completeness_assertions_validate():
    doc = _minimal_doc()
    doc["completeness"] = [
        {
            "section": "subscriptions",
            "source": "spotify-web-api",
            "level": "full",
            "capturedAt": "2026-05-29T14:00:00Z",
        },
        {
            "section": "events",
            "source": "spotify-web-api",
            "level": "partial",
            "since": "2026-05-29T13:30:00Z",
            "note": "Recently-played caps at 50 entries.",
        },
    ]
    validate(doc)


def test_completeness_rejects_unknown_section():
    doc = _minimal_doc()
    doc["completeness"] = [
        {"section": "favourites", "source": "x", "level": "full"}
    ]
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    assert "favourites" in str(exc.value)


def test_completeness_rejects_unknown_level():
    doc = _minimal_doc()
    doc["completeness"] = [
        {"section": "episodes", "source": "x", "level": "mostly"}
    ]
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    assert "mostly" in str(exc.value)


def test_in_progress_requires_position():
    doc = _minimal_doc()
    doc["episodes"].append({
        "episodeStateId": "e1",
        "subscriptionRef": {"feedUrl": "https://example.com/feed.xml"},
        "guid": "ep1",
        "status": "in_progress",
        "updatedAt": "2026-05-26T14:00:00Z",
    })
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    assert "positionSeconds" in str(exc.value)


def test_episode_requires_guid_or_enclosure():
    doc = _minimal_doc()
    doc["episodes"].append({
        "episodeStateId": "e1",
        "subscriptionRef": {"feedUrl": "https://example.com/feed.xml"},
        "status": "unplayed",
        "updatedAt": "2026-05-26T14:00:00Z",
    })
    with pytest.raises(ValidationError):
        validate(doc)


def test_unknown_status_rejected():
    doc = _minimal_doc()
    doc["episodes"].append({
        "episodeStateId": "e1",
        "subscriptionRef": {"feedUrl": "https://example.com/feed.xml"},
        "guid": "ep1",
        "status": "halfway",
        "updatedAt": "2026-05-26T14:00:00Z",
    })
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    assert "halfway" in str(exc.value)


def test_seek_event_requires_from_position():
    doc = _minimal_doc()
    doc["episodes"].append({
        "episodeStateId": "e1",
        "subscriptionRef": {"feedUrl": "https://example.com/feed.xml"},
        "guid": "ep1",
        "status": "in_progress",
        "positionSeconds": 100,
        "events": [
            {"type": "seek", "at": "2026-05-26T14:00:00Z", "positionSeconds": 50}
        ],
        "updatedAt": "2026-05-26T14:00:00Z",
    })
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    assert "fromPositionSeconds" in str(exc.value)


def test_extensions_namespace_must_be_dotted():
    doc = _minimal_doc()
    doc["extensions"] = {"badkey": {"foo": 1}}
    with pytest.raises(ValidationError):
        validate(doc)

    doc["extensions"] = {"com.example.thing": {"foo": 1}}
    validate(doc)  # passes


def test_extensions_arbitrary_payload_preserved():
    doc = _minimal_doc()
    doc["extensions"] = {
        "com.trimplayer.skips": [
            {"episodeGuid": "ep1", "skippedRanges": [[1.0, 2.0]]}
        ]
    }
    validate(doc)
