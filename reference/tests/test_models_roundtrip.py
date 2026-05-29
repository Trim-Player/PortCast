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


def test_subscription_ref_accepts_platform_refs():
    ref = SubscriptionRef(platformRefs=["spotify:show:5CnDmMUG0S5bSSw612fs8C"])
    assert ref.to_dict() == {"platformRefs": ["spotify:show:5CnDmMUG0S5bSSw612fs8C"]}


def test_episode_ref_accepts_platform_refs():
    ref = EpisodeRef(platformRefs=["spotify:episode:7makk4oTQel546B0PZlDM5"])
    assert ref.to_dict() == {"platformRefs": ["spotify:episode:7makk4oTQel546B0PZlDM5"]}


def test_sample_roundtrip_preserves_completeness():
    import json as _json
    data = _json.loads(SAMPLE.read_text(encoding="utf-8"))
    doc = PortCastDocument.from_dict(data)
    out = doc.to_dict()
    assert out["completeness"] == data["completeness"]


def test_sample_roundtrip_preserves_platform_refs():
    import json as _json
    data = _json.loads(SAMPLE.read_text(encoding="utf-8"))
    doc = PortCastDocument.from_dict(data)
    out = doc.to_dict()
    exclusive = next(s for s in data["subscriptions"] if "platformRefs" in s and "feedUrl" not in s)
    out_exclusive = next(s for s in out["subscriptions"] if "platformRefs" in s and "feedUrl" not in s)
    assert out_exclusive["platformRefs"] == exclusive["platformRefs"]


def test_sample_roundtrip_preserves_event_source():
    import json as _json
    data = _json.loads(SAMPLE.read_text(encoding="utf-8"))
    doc = PortCastDocument.from_dict(data)
    out = doc.to_dict()
    src_events = next(e for e in data["episodes"] if e.get("events"))["events"]
    out_events = next(e for e in out["episodes"] if e.get("events"))["events"]
    assert out_events == src_events
    assert any(ev.get("source") for ev in out_events)
