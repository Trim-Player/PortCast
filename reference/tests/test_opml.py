"""OPML <-> PortCast bridge tests."""
from __future__ import annotations

from xml.etree import ElementTree as ET

from portcast import (
    Generator,
    PortCastDocument,
    Subscription,
    export_opml,
    import_opml,
    validate,
)

OPML_SAMPLE = """<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Subscriptions</title></head>
  <body>
    <outline text="Tech">
      <outline type="rss" text="Example Tech Pod"
               title="Example Tech Pod"
               xmlUrl="https://feeds.example.com/tech.xml"
               author="Jane Doe" />
    </outline>
    <outline type="rss" text="Standalone Pod"
             title="Standalone Pod"
             xmlUrl="https://feeds.example.com/standalone.xml" />
  </body>
</opml>"""


def test_import_opml_extracts_subscriptions():
    doc = import_opml(OPML_SAMPLE)
    titles = {s.title for s in doc.subscriptions}
    assert titles == {"Example Tech Pod", "Standalone Pod"}
    tech = next(s for s in doc.subscriptions if s.title == "Example Tech Pod")
    assert tech.feedUrl == "https://feeds.example.com/tech.xml"
    assert tech.author == "Jane Doe"
    assert tech.tags == ["Tech"]


def test_import_opml_produces_valid_document():
    doc = import_opml(OPML_SAMPLE)
    data = doc.to_dict()
    validate(data)
    assert data["episodes"] == []


def test_export_opml_roundtrips_subscriptions():
    original = import_opml(OPML_SAMPLE)
    opml_out = export_opml(original)
    reimported = import_opml(opml_out)

    original_feeds = sorted(s.feedUrl for s in original.subscriptions)
    reimported_feeds = sorted(s.feedUrl for s in reimported.subscriptions)
    assert original_feeds == reimported_feeds


def test_export_opml_omits_unsubscribed():
    doc = PortCastDocument(
        generator=Generator(name="test"),
        subscriptions=[
            Subscription(
                title="Active", feedUrl="https://a.example/feed.xml"
            ),
            Subscription(
                title="Dropped",
                feedUrl="https://b.example/feed.xml",
                unsubscribedAt="2026-01-01T00:00:00Z",
            ),
        ],
    )
    opml_out = export_opml(doc)
    root = ET.fromstring(opml_out)
    rss_outlines = root.findall(".//outline[@type='rss']")
    titles = {o.attrib.get("title") for o in rss_outlines}
    assert titles == {"Active"}
