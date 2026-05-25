"""OPML interop for PortCast.

Most podcast apps already export/import subscriptions via OPML 2.0. This
module bridges OPML <-> PortCast subscriptions so users with an OPML file
in hand can produce a (minimal) PortCast document, and vice versa.

OPML carries no listening history — only subscription metadata — so
`import_opml` produces a document with `episodes=[]`. Use a producer-app
specific exporter to populate listening history.
"""
from __future__ import annotations

from typing import Iterable, Optional
from xml.etree import ElementTree as ET

from .models import (
    Generator,
    PortCastDocument,
    Subscription,
    _now_iso,
)


def import_opml(opml_text: str, *, generator_name: str = "portcast-cli") -> PortCastDocument:
    """Parse an OPML 2.0 string and return a PortCast document.

    Subscriptions are extracted from every `<outline type="rss" xmlUrl="...">`
    element. Folder-style nesting becomes a `tags` entry on the subscription.
    """
    root = ET.fromstring(opml_text)
    body = root.find("body")
    if body is None:
        return PortCastDocument(generator=Generator(name=generator_name))

    subscriptions: list[Subscription] = []
    for outline, tags in _walk_outlines(body, tags=()):
        if outline.attrib.get("type") != "rss":
            continue
        feed_url = outline.attrib.get("xmlUrl")
        if not feed_url:
            continue
        title = (
            outline.attrib.get("title")
            or outline.attrib.get("text")
            or feed_url
        )
        subscriptions.append(
            Subscription(
                title=title,
                feedUrl=feed_url,
                author=outline.attrib.get("author"),
                imageUrl=outline.attrib.get("imageUrl"),
                tags=list(tags) if tags else None,
                subscribedAt=_now_iso(),
            )
        )
    return PortCastDocument(
        generator=Generator(name=generator_name),
        subscriptions=subscriptions,
    )


def _walk_outlines(
    parent: ET.Element, *, tags: tuple[str, ...]
) -> Iterable[tuple[ET.Element, tuple[str, ...]]]:
    for outline in parent.findall("outline"):
        if outline.attrib.get("type") == "rss":
            yield outline, tags
            continue
        # Folder-style outline. Use its text/title as a tag for children.
        folder_label = outline.attrib.get("text") or outline.attrib.get("title")
        child_tags = tags + (folder_label,) if folder_label else tags
        yield from _walk_outlines(outline, tags=child_tags)


def export_opml(document: PortCastDocument, *, head_title: Optional[str] = None) -> str:
    """Render a PortCast document's subscriptions as OPML 2.0 text.

    Listening state, queue, bookmarks etc. are NOT representable in OPML
    and are silently dropped — that's a property of OPML, not a bug here.
    """
    opml = ET.Element("opml", version="2.0")
    head = ET.SubElement(opml, "head")
    ET.SubElement(head, "title").text = head_title or "PortCast subscriptions export"
    ET.SubElement(head, "dateCreated").text = document.generatedAt
    body = ET.SubElement(opml, "body")

    # Group by primary tag so nesting reflects user folders where possible.
    grouped: dict[Optional[str], list[Subscription]] = {}
    for sub in document.subscriptions:
        if sub.unsubscribedAt is not None:
            continue
        primary = sub.tags[0] if sub.tags else None
        grouped.setdefault(primary, []).append(sub)

    for tag, subs in grouped.items():
        target = body
        if tag is not None:
            target = ET.SubElement(body, "outline", text=tag, title=tag)
        for sub in subs:
            attrs = {
                "type": "rss",
                "text": sub.title,
                "title": sub.title,
            }
            if sub.feedUrl:
                attrs["xmlUrl"] = sub.feedUrl
            if sub.author:
                attrs["author"] = sub.author
            if sub.imageUrl:
                attrs["imageUrl"] = sub.imageUrl
            ET.SubElement(target, "outline", **attrs)

    return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(
        opml, encoding="unicode"
    )
