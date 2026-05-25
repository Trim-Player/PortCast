"""PortCast reference implementation.

Models, validator, and OPML interop for the PortCast protocol.
See SPECIFICATION.md at the repo root for the full protocol.
"""

from .models import (
    Bookmark,
    EpisodeRef,
    EpisodeState,
    Generator,
    Owner,
    PlaybackEvent,
    PortCastDocument,
    Preferences,
    QueueItem,
    Subscription,
    SubscriptionRef,
)
from .validator import ValidationError, validate
from .opml import import_opml, export_opml

__all__ = [
    "PortCastDocument",
    "Generator",
    "Owner",
    "Subscription",
    "SubscriptionRef",
    "EpisodeState",
    "EpisodeRef",
    "PlaybackEvent",
    "QueueItem",
    "Bookmark",
    "Preferences",
    "validate",
    "ValidationError",
    "import_opml",
    "export_opml",
]

SPEC_VERSION = "0.1.0"
