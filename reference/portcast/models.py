"""Dataclass models for the PortCast protocol.

Each model knows how to serialize to / deserialize from the plain JSON
shape defined in SPECIFICATION.md. We deliberately avoid coupling to a
heavier library (pydantic, attrs) so the reference impl stays small and
portable.
"""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal, Optional

SPEC_VERSION = "0.2.0"

EpisodeStatus = Literal["unplayed", "in_progress", "completed", "archived"]
PlaybackEventType = Literal[
    "play", "pause", "seek", "complete", "speed_change", "bookmark"
]
CompletenessLevel = Literal["full", "partial", "current-state-only"]
CompletenessSection = Literal[
    "subscriptions", "episodes", "events", "queue", "bookmarks", "preferences"
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex}"


def _strip_none(d: dict[str, Any]) -> dict[str, Any]:
    """Drop keys whose value is None — keeps exports clean."""
    return {k: v for k, v in d.items() if v is not None}


@dataclass
class Generator:
    name: str
    version: Optional[str] = None
    url: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))


@dataclass
class Owner:
    displayName: Optional[str] = None
    email: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))


@dataclass
class SubscriptionRef:
    feedUrl: Optional[str] = None
    podcastGuid: Optional[str] = None
    platformRefs: Optional[list[str]] = None

    def __post_init__(self) -> None:
        if not self.feedUrl and not self.podcastGuid and not self.platformRefs:
            raise ValueError(
                "SubscriptionRef requires at least one of feedUrl, podcastGuid, or platformRefs"
            )

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))


@dataclass
class EpisodeRef:
    guid: Optional[str] = None
    enclosureUrl: Optional[str] = None
    platformRefs: Optional[list[str]] = None

    def __post_init__(self) -> None:
        if not self.guid and not self.enclosureUrl and not self.platformRefs:
            raise ValueError(
                "EpisodeRef requires at least one of guid, enclosureUrl, or platformRefs"
            )

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))


@dataclass
class Subscription:
    title: str
    subscriptionId: str = field(default_factory=lambda: _new_id())
    feedUrl: Optional[str] = None
    podcastGuid: Optional[str] = None
    platformRefs: Optional[list[str]] = None
    author: Optional[str] = None
    imageUrl: Optional[str] = None
    subscribedAt: Optional[str] = None
    unsubscribedAt: Optional[str] = None
    tags: Optional[list[str]] = None
    notificationsEnabled: Optional[bool] = None
    identifiers: Optional[dict[str, Any]] = None
    updatedAt: str = field(default_factory=_now_iso)
    extensions: Optional[dict[str, Any]] = None

    def __post_init__(self) -> None:
        if not self.feedUrl and not self.podcastGuid and not self.platformRefs:
            raise ValueError(
                "Subscription requires at least one of feedUrl, podcastGuid, or platformRefs"
            )

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))


@dataclass
class PlaybackEvent:
    type: PlaybackEventType
    at: str
    positionSeconds: Optional[float] = None
    fromPositionSeconds: Optional[float] = None
    speed: Optional[float] = None
    bookmarkRef: Optional[str] = None
    source: Optional[str] = None
    capturedAt: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))


@dataclass
class EpisodeState:
    subscriptionRef: SubscriptionRef
    status: EpisodeStatus = "unplayed"
    episodeStateId: str = field(default_factory=lambda: _new_id())
    guid: Optional[str] = None
    enclosureUrl: Optional[str] = None
    platformRefs: Optional[list[str]] = None
    title: Optional[str] = None
    publishedAt: Optional[str] = None
    durationSeconds: Optional[float] = None
    positionSeconds: Optional[float] = None
    playCount: Optional[int] = None
    completedAt: Optional[str] = None
    firstPlayedAt: Optional[str] = None
    lastPlayedAt: Optional[str] = None
    rating: Optional[float] = None
    starred: Optional[bool] = None
    hidden: Optional[bool] = None
    source: Optional[str] = None
    capturedAt: Optional[str] = None
    events: Optional[list[PlaybackEvent]] = None
    updatedAt: str = field(default_factory=_now_iso)
    extensions: Optional[dict[str, Any]] = None

    def __post_init__(self) -> None:
        if not self.guid and not self.enclosureUrl and not self.platformRefs:
            raise ValueError(
                "EpisodeState requires at least one of guid, enclosureUrl, or platformRefs"
            )
        if self.status == "in_progress" and self.positionSeconds is None:
            raise ValueError(
                "EpisodeState with status='in_progress' requires positionSeconds"
            )

    def to_dict(self) -> dict[str, Any]:
        d = _strip_none(asdict(self))
        d["subscriptionRef"] = self.subscriptionRef.to_dict()
        if self.events is not None:
            d["events"] = [e.to_dict() for e in self.events]
        return d


@dataclass
class QueueItem:
    position: int
    episodeRef: EpisodeRef
    addedAt: Optional[str] = None
    source: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d = _strip_none(asdict(self))
        d["episodeRef"] = self.episodeRef.to_dict()
        return d


@dataclass
class Bookmark:
    episodeRef: EpisodeRef
    atSeconds: float
    bookmarkId: str = field(default_factory=lambda: _new_id())
    endSeconds: Optional[float] = None
    label: Optional[str] = None
    note: Optional[str] = None
    createdAt: str = field(default_factory=_now_iso)
    updatedAt: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d = _strip_none(asdict(self))
        d["episodeRef"] = self.episodeRef.to_dict()
        return d


@dataclass
class Preferences:
    global_: Optional[dict[str, Any]] = None
    perFeed: Optional[dict[str, dict[str, Any]]] = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.global_ is not None:
            out["global"] = self.global_
        if self.perFeed is not None:
            out["perFeed"] = self.perFeed
        return out


@dataclass
class CompletenessAssertion:
    section: CompletenessSection
    source: str
    level: CompletenessLevel
    since: Optional[str] = None
    until: Optional[str] = None
    capturedAt: Optional[str] = None
    note: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))


@dataclass
class PortCastDocument:
    generator: Generator
    subscriptions: list[Subscription] = field(default_factory=list)
    episodes: list[EpisodeState] = field(default_factory=list)
    portcast: str = SPEC_VERSION
    generatedAt: str = field(default_factory=_now_iso)
    owner: Optional[Owner] = None
    queue: Optional[list[QueueItem]] = None
    bookmarks: Optional[list[Bookmark]] = None
    preferences: Optional[Preferences] = None
    completeness: Optional[list[CompletenessAssertion]] = None
    extensions: Optional[dict[str, Any]] = None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "portcast": self.portcast,
            "generatedAt": self.generatedAt,
            "generator": self.generator.to_dict(),
            "subscriptions": [s.to_dict() for s in self.subscriptions],
            "episodes": [e.to_dict() for e in self.episodes],
        }
        if self.owner is not None:
            d["owner"] = self.owner.to_dict()
        if self.queue is not None:
            d["queue"] = [q.to_dict() for q in self.queue]
        if self.bookmarks is not None:
            d["bookmarks"] = [b.to_dict() for b in self.bookmarks]
        if self.preferences is not None:
            d["preferences"] = self.preferences.to_dict()
        if self.completeness is not None:
            d["completeness"] = [c.to_dict() for c in self.completeness]
        if self.extensions is not None:
            d["extensions"] = self.extensions
        return d

    # ---- deserialization -------------------------------------------------

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "PortCastDocument":
        gen = data["generator"]
        generator = Generator(
            name=gen["name"], version=gen.get("version"), url=gen.get("url")
        )
        owner = None
        if isinstance(data.get("owner"), dict):
            owner = Owner(
                displayName=data["owner"].get("displayName"),
                email=data["owner"].get("email"),
            )

        subscriptions = [_subscription_from_dict(s) for s in data.get("subscriptions", [])]
        episodes = [_episode_from_dict(e) for e in data.get("episodes", [])]
        queue = (
            [_queue_item_from_dict(q) for q in data["queue"]]
            if "queue" in data
            else None
        )
        bookmarks = (
            [_bookmark_from_dict(b) for b in data["bookmarks"]]
            if "bookmarks" in data
            else None
        )
        preferences = None
        if "preferences" in data:
            pref = data["preferences"]
            preferences = Preferences(
                global_=pref.get("global"),
                perFeed=pref.get("perFeed"),
            )
        completeness = None
        if isinstance(data.get("completeness"), list):
            completeness = [_completeness_from_dict(c) for c in data["completeness"]]

        return cls(
            portcast=data.get("portcast", SPEC_VERSION),
            generatedAt=data.get("generatedAt", _now_iso()),
            generator=generator,
            owner=owner,
            subscriptions=subscriptions,
            episodes=episodes,
            queue=queue,
            bookmarks=bookmarks,
            preferences=preferences,
            completeness=completeness,
            extensions=data.get("extensions"),
        )


def _subscription_from_dict(d: dict[str, Any]) -> Subscription:
    return Subscription(
        subscriptionId=d.get("subscriptionId") or _new_id(),
        title=d["title"],
        feedUrl=d.get("feedUrl"),
        podcastGuid=d.get("podcastGuid"),
        platformRefs=d.get("platformRefs"),
        author=d.get("author"),
        imageUrl=d.get("imageUrl"),
        subscribedAt=d.get("subscribedAt"),
        unsubscribedAt=d.get("unsubscribedAt"),
        tags=d.get("tags"),
        notificationsEnabled=d.get("notificationsEnabled"),
        identifiers=d.get("identifiers"),
        updatedAt=d.get("updatedAt") or _now_iso(),
        extensions=d.get("extensions"),
    )


def _episode_from_dict(d: dict[str, Any]) -> EpisodeState:
    ref = d["subscriptionRef"]
    sub_ref = SubscriptionRef(
        feedUrl=ref.get("feedUrl"),
        podcastGuid=ref.get("podcastGuid"),
        platformRefs=ref.get("platformRefs"),
    )
    events = None
    if isinstance(d.get("events"), list):
        events = [
            PlaybackEvent(
                type=ev["type"],
                at=ev["at"],
                positionSeconds=ev.get("positionSeconds"),
                fromPositionSeconds=ev.get("fromPositionSeconds"),
                speed=ev.get("speed"),
                bookmarkRef=ev.get("bookmarkRef"),
                source=ev.get("source"),
                capturedAt=ev.get("capturedAt"),
            )
            for ev in d["events"]
        ]
    return EpisodeState(
        episodeStateId=d.get("episodeStateId") or _new_id(),
        subscriptionRef=sub_ref,
        guid=d.get("guid"),
        enclosureUrl=d.get("enclosureUrl"),
        platformRefs=d.get("platformRefs"),
        title=d.get("title"),
        publishedAt=d.get("publishedAt"),
        durationSeconds=d.get("durationSeconds"),
        status=d.get("status", "unplayed"),
        positionSeconds=d.get("positionSeconds"),
        playCount=d.get("playCount"),
        completedAt=d.get("completedAt"),
        firstPlayedAt=d.get("firstPlayedAt"),
        lastPlayedAt=d.get("lastPlayedAt"),
        rating=d.get("rating"),
        starred=d.get("starred"),
        hidden=d.get("hidden"),
        source=d.get("source"),
        capturedAt=d.get("capturedAt"),
        events=events,
        updatedAt=d.get("updatedAt") or _now_iso(),
        extensions=d.get("extensions"),
    )


def _queue_item_from_dict(d: dict[str, Any]) -> QueueItem:
    ref = d["episodeRef"]
    return QueueItem(
        position=d["position"],
        episodeRef=EpisodeRef(
            guid=ref.get("guid"),
            enclosureUrl=ref.get("enclosureUrl"),
            platformRefs=ref.get("platformRefs"),
        ),
        addedAt=d.get("addedAt"),
        source=d.get("source"),
    )


def _bookmark_from_dict(d: dict[str, Any]) -> Bookmark:
    ref = d["episodeRef"]
    return Bookmark(
        bookmarkId=d.get("bookmarkId") or _new_id(),
        episodeRef=EpisodeRef(
            guid=ref.get("guid"),
            enclosureUrl=ref.get("enclosureUrl"),
            platformRefs=ref.get("platformRefs"),
        ),
        atSeconds=d["atSeconds"],
        endSeconds=d.get("endSeconds"),
        label=d.get("label"),
        note=d.get("note"),
        createdAt=d.get("createdAt") or _now_iso(),
        updatedAt=d.get("updatedAt"),
    )


def _completeness_from_dict(d: dict[str, Any]) -> CompletenessAssertion:
    return CompletenessAssertion(
        section=d["section"],
        source=d["source"],
        level=d["level"],
        since=d.get("since"),
        until=d.get("until"),
        capturedAt=d.get("capturedAt"),
        note=d.get("note"),
    )
