# PortCast Protocol Specification

**Version:** 0.1.0 (Draft)
**Status:** Working Draft
**Editors:** Trimplayer
**License:** This specification is published under CC BY 4.0. Reference code is MIT.

PortCast is an open, JSON-based protocol for exporting and importing a podcast
listener's **subscriptions**, **listening history**, **playback state**,
**queue**, **bookmarks**, and **per-feed preferences** between podcast
applications.

The goal is simple: a listener should be able to leave any podcast app and
arrive at any other app with the relationship to their podcasts intact —
which shows they follow, what they've already heard, where they stopped in
the half-finished episode, and the clip they marked at 23:04 last Tuesday.

---

## 1. Design goals

1. **Listener-owned.** The document is produced by the user, for the user.
   No vendor lock-in, no proprietary IDs required.
2. **Interoperable identity.** Use open identifiers already present in RSS
   (item `<guid>`, feed URL) rather than inventing a new namespace. Apps MAY
   add their own IDs in a namespaced extension block.
3. **Lossless within the model.** A conforming export captures everything the
   protocol defines. Anything outside the model goes in `extensions` so it
   round-trips through apps that don't understand it.
4. **Partial + incremental.** Every entity carries an `updatedAt` timestamp,
   so a future sync profile can ship deltas. The v0.1 file format is a full
   snapshot, but the data model is sync-friendly.
5. **Human-readable.** A user should be able to open the file in a text
   editor and recognize what it says about them.
6. **Versioned.** The document declares its protocol version; consumers can
   negotiate behaviour.

## 2. Conformance

The key words MUST, SHOULD, MAY are to be interpreted as in RFC 2119.

A **producer** is software that writes a PortCast document.
A **consumer** is software that reads one.

A **conforming producer** MUST write a document that validates against the
JSON Schemas in `schema/`. A **conforming consumer** MUST accept any
document that validates against those schemas, and MUST NOT reject a
document because of unrecognized keys inside an `extensions` object.

## 3. Document container

A PortCast document is a single JSON object (UTF-8, no BOM) with the
following top-level shape:

```json
{
  "portcast": "0.1.0",
  "generatedAt": "2026-05-26T14:00:00Z",
  "generator": { "name": "Trimplayer", "version": "3.4.1" },
  "owner": { "displayName": "Jonathan", "email": "user@example.com" },
  "subscriptions": [ ... ],
  "episodes":      [ ... ],
  "queue":         [ ... ],
  "bookmarks":     [ ... ],
  "preferences":   { ... },
  "extensions":    { ... }
}
```

| Field          | Required | Notes                                                |
| -------------- | -------- | ---------------------------------------------------- |
| `portcast`     | yes      | SemVer string. The version of this spec.             |
| `generatedAt`  | yes      | RFC 3339 timestamp in UTC.                           |
| `generator`    | yes      | Producing app identifier.                            |
| `owner`        | no       | Optional listener identity. Apps SHOULD let users opt out of including this. |
| `subscriptions`| yes      | Array of `Subscription`. MAY be empty.               |
| `episodes`     | yes      | Array of `EpisodeState`. MAY be empty.               |
| `queue`        | no       | Ordered array of `QueueItem`.                        |
| `bookmarks`    | no       | Array of `Bookmark`.                                 |
| `preferences`  | no       | A `Preferences` object — global + per-feed defaults. |
| `extensions`   | no       | Namespaced extension data (see §10).                 |

The file extension SHOULD be `.portcast.json` and the IANA media type
**SHOULD** be `application/vnd.portcast+json` (registration pending).

## 4. Identity model

Identity is the heart of an interop protocol. PortCast identifies things at
two levels:

### 4.1 Podcast identity

A `Subscription` MUST carry **at least one** of the following:

- `feedUrl` — the canonical RSS/Atom URL.
- `podcastGuid` — the [Podcast Namespace `<podcast:guid>`][pgu] value when
  the feed publishes one. This is the strongest identifier and SHOULD be
  preferred when matching across apps.

A subscription SHOULD include both when both are available.

Apps MAY also carry directory-specific IDs (Apple Podcasts ID, Podcast
Index ID, etc.) under `Subscription.identifiers.*` — these are advisory,
not required for matching.

[pgu]: https://podcastindex.org/namespace/1.0#guid

### 4.2 Episode identity

An `EpisodeState` MUST carry **at least one** of:

- `guid` — the RSS `<item><guid>` value (preferred).
- `enclosureUrl` — the media URL from `<enclosure url="...">`.

It MUST also carry a `subscriptionRef`: either `podcastGuid` or `feedUrl`,
matching one of the document's `subscriptions[]` entries. This is how a
consumer attaches the episode state back to its show.

If neither a `guid` nor an `enclosureUrl` is known (e.g., a show that
recycles GUIDs, or local recordings), an episode state MAY use a stable
`(subscriptionRef, publishedAt, title)` tuple — but consumers are not
required to match by it. Producers SHOULD include `enclosureUrl` whenever
possible.

## 5. Subscriptions

```json
{
  "subscriptionId": "01HXYZ...",        // ULID/UUID, producer-assigned
  "feedUrl": "https://example.com/feed.xml",
  "podcastGuid": "917393e3-1b1e-5cef-ace4-edaa54e1f810",
  "title": "Example Podcast",
  "author": "Jane Doe",
  "imageUrl": "https://example.com/cover.jpg",
  "subscribedAt": "2024-06-01T09:14:00Z",
  "unsubscribedAt": null,
  "tags": ["tech", "weekly-listen"],
  "notificationsEnabled": true,
  "identifiers": {
    "applePodcastsId": "1500000000",
    "podcastIndexId": "920666"
  },
  "updatedAt": "2026-05-26T14:00:00Z"
}
```

- `unsubscribedAt` is set when the listener has stopped following the show
  but the producer still wants to convey "I used to listen to this" history.
  Consumers MAY discard unsubscribed entries on import.
- `tags` are free-form, user-applied labels (folders/playlists in some
  apps).

## 6. Episode state

```json
{
  "episodeStateId": "01HXYZ...",
  "subscriptionRef": { "podcastGuid": "917393e3-..." },
  "guid": "https://example.com/ep/42",
  "enclosureUrl": "https://example.com/audio/ep42.mp3",
  "title": "Episode 42: On Portable Listening",
  "publishedAt": "2026-05-20T07:00:00Z",
  "durationSeconds": 3287,

  "status": "in_progress",
  "positionSeconds": 1245.2,
  "playCount": 1,
  "completedAt": null,
  "firstPlayedAt": "2026-05-22T18:30:00Z",
  "lastPlayedAt": "2026-05-25T08:11:00Z",
  "rating": null,
  "starred": false,
  "hidden": false,

  "events": [
    { "type": "play",  "at": "2026-05-22T18:30:00Z", "positionSeconds": 0 },
    { "type": "pause", "at": "2026-05-22T19:05:12Z", "positionSeconds": 2112 },
    { "type": "play",  "at": "2026-05-25T08:00:00Z", "positionSeconds": 2112 },
    { "type": "seek",  "at": "2026-05-25T08:02:00Z", "positionSeconds": 1200,
      "fromPositionSeconds": 2232 }
  ],

  "updatedAt": "2026-05-25T08:11:00Z"
}
```

### 6.1 `status` values

| Value          | Meaning                                                  |
| -------------- | -------------------------------------------------------- |
| `unplayed`     | User has never started this episode.                     |
| `in_progress`  | User started but did not finish.                         |
| `completed`    | User reached the end (or marked complete).               |
| `archived`     | User explicitly dismissed without listening (e.g. "mark as played" without playing). |

`positionSeconds` is REQUIRED when `status` is `in_progress` and SHOULD be
zero or omitted otherwise. Producers SHOULD record a small tolerance —
e.g., the listener is "completed" if they got within 30s of the end.

### 6.2 Playback events

The `events` array is OPTIONAL but powerful: it lets a consumer reconstruct
*how* the listener consumed the episode (skip patterns, re-listens,
playback-speed changes). Each event has a `type` from
{`play`, `pause`, `seek`, `complete`, `speed_change`, `bookmark`} and
attaches its own typed fields. Producers MAY include a subset; consumers
MAY ignore events they don't understand.

Apps that don't track event-level history can omit `events` entirely; the
top-level fields (`positionSeconds`, `playCount`, `lastPlayedAt`) are still
enough for everyday "where did I leave off" portability.

## 7. Queue

```json
{
  "queue": [
    { "position": 1, "episodeRef": { "guid": "https://example.com/ep/42" },
      "addedAt": "2026-05-25T09:00:00Z", "source": "manual" },
    { "position": 2, "episodeRef": { "enclosureUrl": "https://.../ep43.mp3" },
      "addedAt": "2026-05-25T09:01:00Z", "source": "auto" }
  ]
}
```

`position` is 1-based and MUST be unique within the queue. `source` is
free-form ("manual", "auto", "smart-playlist:Morning Commute").

## 8. Bookmarks

```json
{
  "bookmarkId": "01HXYZ...",
  "episodeRef": { "guid": "https://example.com/ep/42" },
  "atSeconds": 1384.0,
  "endSeconds": 1421.5,
  "label": "Great quote about feed ownership",
  "note": "Quote starts at 'and if you can't take it with you...'",
  "createdAt": "2026-05-25T08:23:00Z",
  "updatedAt": "2026-05-25T08:23:00Z"
}
```

`endSeconds` is OPTIONAL — its presence promotes a bookmark to a **clip**.

## 9. Preferences

```json
{
  "preferences": {
    "global": {
      "playbackRate": 1.2,
      "skipForwardSeconds": 30,
      "skipBackwardSeconds": 15,
      "trimSilence": true,
      "boostVoice": false
    },
    "perFeed": {
      "917393e3-1b1e-5cef-ace4-edaa54e1f810": {
        "playbackRate": 1.0,
        "skipIntroSeconds": 90,
        "skipOutroSeconds": 60,
        "autoDownload": "latest-3"
      }
    }
  }
}
```

`perFeed` keys are `podcastGuid` if available, otherwise `feedUrl`.
Per-feed values override `global`.

## 10. Extensions

Anything outside this spec lives under an `extensions` object, keyed by
**reverse-DNS namespace**:

```json
"extensions": {
  "com.trimplayer.skips": [
    { "episodeGuid": "...", "skippedRanges": [[12.0, 47.5]] }
  ],
  "fm.overcast.smart-speed": { "secondsSaved": 18421 }
}
```

Consumers MUST preserve `extensions` on round-trip even if they don't
understand a namespace. This is what keeps a multi-app journey lossless.

## 11. Privacy

PortCast documents can be sensitive: they reveal what someone listens to
and when. Producers:

- SHOULD let the user choose whether to include `owner`.
- SHOULD let the user choose whether to include event-level history.
- SHOULD NOT include device identifiers, IP addresses, or third-party
  analytics IDs.
- MUST NOT embed the listener's account credentials.

Consumers SHOULD treat an imported document as personal data, not as
shareable telemetry.

## 12. Versioning

`portcast` is a SemVer string. Consumers:

- MUST accept any document whose `portcast` major version they support.
- MAY warn the user when a minor version is newer than they understand.
- MUST NOT silently drop fields they don't recognize; preserve them under
  `extensions._unknown` if necessary.

## 13. Open questions for v0.2

- A signed manifest (detached signature) so listeners can verify a file
  came from app X.
- A delta/patch format for incremental sync.
- A binary attachment sidecar for downloaded audio (probably out of scope —
  audio belongs to the publisher).
- Whether to import OPML directly or require the OPML→PortCast bridge in
  reference code.

Feedback welcome via GitHub issues on this repository.
