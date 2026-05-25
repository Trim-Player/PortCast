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
        "portcast": "0.1.0",
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


def test_subscription_requires_feed_or_guid():
    doc = _minimal_doc()
    doc["subscriptions"][0].pop("feedUrl")
    with pytest.raises(ValidationError) as exc:
        validate(doc)
    # jsonschema reports anyOf failures as "not valid under any of the given schemas";
    # what we really want to know is that validation pointed at the broken subscription.
    assert "subscriptions/0" in str(exc.value)


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
