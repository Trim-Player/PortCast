"""Round-trip the sample document through the dataclass models.

Loading -> models -> dict should produce a document that still validates,
and should preserve extensions and event data.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from portcast import PortCastDocument, validate
from portcast.models import (
    EpisodeRef,
    EpisodeState,
    SubscriptionRef,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SAMPLE = REPO_ROOT / "examples" / "sample-export.portcast.json"


def test_sample_roundtrip_validates():
    data = json.loads(SAMPLE.read_text(encoding="utf-8"))
    doc = PortCastDocument.from_dict(data)
    out = doc.to_dict()
    validate(out)


def test_sample_roundtrip_preserves_extensions():
    data = json.loads(SAMPLE.read_text(encoding="utf-8"))
    doc = PortCastDocument.from_dict(data)
    out = doc.to_dict()
    assert out["extensions"] == data["extensions"]


def test_sample_roundtrip_preserves_events():
    data = json.loads(SAMPLE.read_text(encoding="utf-8"))
    doc = PortCastDocument.from_dict(data)
    out = doc.to_dict()
    src_events = next(e for e in data["episodes"] if e.get("events"))["events"]
    out_events = next(e for e in out["episodes"] if e.get("events"))["events"]
    assert out_events == src_events


def test_subscription_ref_requires_identifier():
    with pytest.raises(ValueError):
        SubscriptionRef()


def test_episode_ref_requires_identifier():
    with pytest.raises(ValueError):
        EpisodeRef()


def test_episode_in_progress_requires_position():
    with pytest.raises(ValueError):
        EpisodeState(
            subscriptionRef=SubscriptionRef(feedUrl="https://example.com/f.xml"),
            guid="ep1",
            status="in_progress",
        )
