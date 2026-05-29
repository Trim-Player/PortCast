# PortCast Protocol Specification

**Version:** 0.2.0 (file mode + API mode, Draft)
**Status:** Working Draft
**Editors:** Trimplayer
**License:** This specification is published under CC BY 4.0. Reference code is MIT.
**Intended status:** Informational (Independent Submission)

## Abstract

PortCast defines an open, JSON-based interchange format and an optional
HTTPS sync API for moving a podcast listener's data — subscriptions,
listening history, playback position, queue, bookmarks, and per-feed
preferences — between independent podcast applications without a central
service. It builds on identifiers already present in RSS (`<item><guid>`,
feed URL) and the Podcast Namespace (`<podcast:guid>`) so that
implementations can interoperate without inventing a new identity
namespace, and provides a platform-reference identifier of last resort
for shows that have no RSS feed (e.g. platform-exclusive content). This
document specifies the file format and a federated sync API that share
a single data model, together with completeness and merge semantics that
let a consumer combine documents produced by different upstream sources.

## Status of This Document

This is a Working Draft of the PortCast Protocol Specification, published
on GitHub for public review and prepared for submission to the RFC Editor
under the Independent Submission stream as an Informational document.
This draft is not an RFC and does not represent consensus of any
standards body. Distribution of this document is unlimited. Comments are
welcome via the project's issue tracker.

The IPR rules of RFC 4846 and RFC 5744 are intended to apply to any
future RFC publication derived from this document; unless the authors
state otherwise, permission is granted to produce derivative works for
the purpose of implementing this protocol.

---

## 1. Introduction

A listener's relationship with their podcasts — which shows they follow,
where they stopped in an unfinished episode, the clip they bookmarked at
23:04 — currently lives inside whichever application they happen to use.
Switching applications restarts that relationship from zero. OPML
[OPML2.0] solves the subscription case, but everything else (playback
position, completion state, queue, bookmarks, per-feed preferences) is
lost on every migration.

This document specifies PortCast, a protocol whose goal is simple: a
listener SHOULD be able to leave any podcast application and arrive at
any other application with the relationship to their podcasts intact.
PortCast defines a JSON document format (file mode, §3 through §11) and
an optional HTTPS API (API mode, §14) that exposes the same entities for
incremental synchronisation. The two modes share a single data model;
File mode is the interoperability floor that every conforming
implementation can fall back to.

PortCast is intentionally federated. There is no central directory,
registry, or authority. Each application exposes its own endpoint on
its own domain, or produces its own files. The editors of this
specification commit to not operating a central service.

### 1.1 Design goals

1. **Listener-owned.** The document is produced by the user, for the user.
   No vendor lock-in, no proprietary IDs required.
2. **Interoperable identity.** Use open identifiers already present in RSS
   (item `<guid>`, feed URL) rather than inventing a new namespace. Apps MAY
   add their own IDs in a namespaced extension block.
3. **Lossless within the model.** A conforming export captures everything the
   protocol defines. Anything outside the model goes in `extensions` so it
   round-trips through apps that don't understand it.
4. **Partial + incremental.** Every entity carries an `updatedAt` timestamp,
   so the same data model serves both a full file-mode snapshot and the
   delta-sync responses of API mode (§14).
5. **Human-readable.** A user should be able to open the file in a text
   editor and recognize what it says about them.
6. **Versioned.** The document declares its protocol version; consumers can
   negotiate behaviour.

## 2. Terminology and conformance

### 2.1 Requirements language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all
capitals, as shown here.

### 2.2 Defined roles

A **producer** is software that writes a PortCast document or serves
PortCast API responses.

A **consumer** is software that reads a PortCast document or calls a
PortCast API.

A **conforming producer** MUST write a document that validates against
the JSON Schemas in `schema/`. A **conforming consumer** MUST accept any
document that validates against those schemas, and MUST NOT reject a
document because of unrecognized keys inside an `extensions` object
(§10).

## 3. Document container

A PortCast document is a single JSON object (UTF-8, no BOM) with the
following top-level shape:

```json
{
  "portcast": "0.2.0",
  "generatedAt": "2026-05-26T14:00:00Z",
  "generator": { "name": "Trimplayer", "version": "3.4.1" },
  "owner": { "displayName": "Jonathan", "email": "user@example.com" },
  "subscriptions": [ ... ],
  "episodes":      [ ... ],
  "queue":         [ ... ],
  "bookmarks":     [ ... ],
  "preferences":   { ... },
  "completeness":  [ ... ],
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
| `completeness` | no       | Producer's per-section completeness assertions (§11). |
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
- `platformRefs` — one or more platform-reference URIs (§4.3) when, and
  only when, neither of the open identifiers above is available.

A subscription SHOULD include `feedUrl` and `podcastGuid` whenever they
are available, and SHOULD include `platformRefs` for every platform on
which the show is known to be addressable, regardless of whether the
open identifiers are also present.

Apps MAY also carry directory-specific IDs (Apple Podcasts ID, Podcast
Index ID, etc.) under `Subscription.identifiers.*` — these are advisory,
not required for matching.

[pgu]: https://podcastindex.org/namespace/1.0#guid

### 4.2 Episode identity

An `EpisodeState` MUST carry **at least one** of:

- `guid` — the RSS `<item><guid>` value (preferred).
- `enclosureUrl` — the media URL from `<enclosure url="...">`.
- `platformRefs` — one or more platform-reference URIs (§4.3) when, and
  only when, neither of the open identifiers above is available.

It MUST also carry a `subscriptionRef`: a `SubscriptionRef` whose
`podcastGuid`, `feedUrl`, or `platformRefs` matches one of the
document's `subscriptions[]` entries. This is how a consumer attaches
the episode state back to its show.

If neither a `guid` nor an `enclosureUrl` is known (e.g., a show that
recycles GUIDs, or local recordings), an episode state MAY use a stable
`(subscriptionRef, publishedAt, title)` tuple — but consumers are not
required to match by it. Producers SHOULD include `enclosureUrl` whenever
possible.

### 4.3 Platform references

Some shows and episodes are not addressable by an RSS feed at all —
notably platform-exclusive content (e.g. shows that exist only inside a
single closed application and have no public RSS endpoint or
`<podcast:guid>`). For these, a producer MAY identify a subscription or
episode using one or more `platformRefs`, formatted as URIs of the form:

```
<scheme>:<type>:<id>
```

- `scheme` is a short lowercase platform identifier (e.g. `spotify`,
  `apple`, `pocketcasts`).
- `type` is the entity type (`show`, `podcast`, `episode`).
- `id` is the platform's opaque identifier for the entity.

Examples:

```
spotify:show:5CnDmMUG0S5bSSw612fs8C
spotify:episode:7makk4oTQel546B0PZlDM5
apple:podcast:1500000001
```

Platform references are an **identifier of last resort**: producers MUST
prefer `podcastGuid` or `feedUrl` (resp. `guid` or `enclosureUrl`) when
either is known, and SHOULD include them alongside `platformRefs` rather
than instead of them. A consumer that does not implement a given
platform's resolver:

- MUST NOT silently drop subscriptions or episode states that carry only
  `platformRefs`. It SHOULD surface them to the listener as
  "unmigratable from <platform>" so the listener understands what was
  lost.
- MAY offer the listener a manual match (e.g., a search box) to bind
  the unresolved entity to a feed it does know about.

This document does not establish an IANA registry of platform schemes;
schemes in active use by adapters in the PortCast reference
implementation are listed informatively in Appendix B.

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

### 6.3 Source and capture time

An `EpisodeState` and each `PlaybackEvent` MAY carry:

- `source` — a short identifier for the upstream system the entity or
  event was captured from (e.g. `spotify-web-api`,
  `spotify-data-export`, `lastfm`, `trimplayer`, `user-import`). The
  value is free-form; reverse-DNS strings are also valid.
- `capturedAt` — the RFC 3339 timestamp when the producer's system
  observed or ingested the entity. Distinct from `at` (which is when
  the listener actually performed the action) and from `updatedAt`
  (which is when the producer last mutated its own record).

These fields exist so a consumer that merges PortCast documents
produced from different sources (§11) can attribute provenance and
detect duplicates. Producers SHOULD set `source` on every entity and
event when more than one upstream source is in play. Consumers MUST
NOT use `source` to silently discard data; it is metadata, not access
control.

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

## 11. Completeness and merging

A real migration is rarely served by a single source. A listener
moving off a closed platform may have:

- a fast, current-state-only export from the platform's API
  (subscriptions, "where I left off" positions, the most recent
  handful of plays);
- a slow, full historical export delivered later out-of-band (months
  or years of play history);
- additional partial data from a third party (e.g. a scrobbling
  service that has been mirroring plays for the same listener).

PortCast does not require a producer to assemble all of this before
emitting a document. Instead, producers MAY emit several documents
over time and a consumer is expected to merge them. This section
defines the metadata producers attach and the rules consumers follow
so that staged migration is well-defined.

### 11.1 The `completeness` field

A document MAY include a top-level `completeness` array. Each entry is
a producer's assertion about one section of the document:

```json
"completeness": [
  { "section": "subscriptions", "source": "spotify-web-api",
    "level": "full", "capturedAt": "2026-05-29T14:00:00Z" },
  { "section": "episodes",      "source": "spotify-web-api",
    "level": "current-state-only", "capturedAt": "2026-05-29T14:00:00Z",
    "note": "Resume points only; historical positions not exposed by the Web API." },
  { "section": "events",        "source": "spotify-web-api",
    "level": "partial", "since": "2026-05-29T13:30:00Z",
    "note": "Spotify Web API exposes only the most recent 50 plays via /me/player/recently-played." }
]
```

`level` is one of:

| Value                  | Meaning                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `full`                 | This source's complete view of the section, as of `capturedAt`. A consumer MAY treat absences as deletions when applying a `full` assertion.    |
| `partial`              | A known-incomplete subset. `since`/`until` bound the range covered. A consumer MUST NOT treat absences outside the range as deletions.          |
| `current-state-only`   | Present-tense values are captured (e.g. `positionSeconds`, `status`) but no historical `events`. A consumer MUST NOT delete existing events.    |

Omitting `completeness` is permitted. A document without a
`completeness` array SHOULD be treated by consumers as if every present
section were `full` from a single anonymous source. This preserves
backwards compatibility with v0.1 documents.

### 11.2 Merging two documents

When a consumer holds an existing PortCast dataset and receives a new
PortCast document for the same listener, it merges them entity by
entity using the rules below.

**Matching keys.** Entities are matched on identifier in this priority
order:

| Entity         | Match by, in order                                                       |
| -------------- | ------------------------------------------------------------------------ |
| `Subscription` | `podcastGuid` → `feedUrl` → any value in `platformRefs`                  |
| `EpisodeState` | (`subscriptionRef`, `guid`) → (`subscriptionRef`, `enclosureUrl`) → (`subscriptionRef`, any value in `platformRefs`) |
| `Bookmark`     | `bookmarkId`                                                              |
| `QueueItem`    | not merged element-wise (see below)                                       |

If a candidate match exists by `platformRefs` only, the consumer SHOULD
also confirm that the platform scheme matches (e.g. an
existing entity carrying `spotify:show:X` MUST NOT be merged with a new
one carrying `apple:podcast:Y`).

**Per-entity field resolution.** For scalar fields on a matched entity
(e.g. `positionSeconds`, `status`, `rating`, `notificationsEnabled`):

- The value from the entity with the larger `updatedAt` wins.
- On a tie, the value from the entity with the larger `capturedAt`
  wins (if present on both).
- On a further tie, the incoming document wins.

Producers SHOULD NOT set `updatedAt` to a value newer than they
themselves observed. This rule depends on producers being honest about
when they actually wrote a field.

**Event collections.** The `events` array on an `EpisodeState` is
unioned, not replaced. Two events are considered duplicates and
deduplicated if they share `(type, at, source)`. If `source` is
missing on one side, fall back to `(type, at, positionSeconds)`. A
consumer MUST NOT discard events whose `source` differs from any
event already present.

**Bookmarks.** Bookmarks are upserted by `bookmarkId`. Consumers SHOULD
preserve bookmarks they already hold whose `bookmarkId` does not
appear in the incoming document.

**Queue.** The queue is intentionally not merged. A document carrying
a `queue` field replaces the consumer's queue in full only when the
matching `completeness` assertion is `full`. If the incoming document
has no queue, or its queue completeness is `partial` or absent, the
consumer SHOULD preserve its existing queue.

**Deletions.** A consumer MAY treat entities present in an existing
dataset and absent from an incoming document as deletions only when a
matching `completeness` assertion at level `full` covers the section
that holds them, and the assertion's `capturedAt` is newer than the
existing entity's `updatedAt`. In all other cases, absent ≠ deleted.

### 11.3 Identifying multi-source state

Producers that assemble a document from more than one upstream source
SHOULD set `source` on each `EpisodeState` and `PlaybackEvent` (§6.3)
so that downstream consumers can attribute provenance and apply
source-aware policies (e.g. preferring real-time-API captures over
delayed exports). The `source` value is free-form and MAY repeat the
same identifier used in a `completeness` entry.

## 12. Security and privacy considerations

### 12.1 Sensitivity of the data

A PortCast document is a detailed record of personal listening behaviour:
which shows a listener follows, when they started or finished an episode,
which passages they bookmarked, and (when event-level history is
included) the moment-to-moment shape of their attention. Implementers
MUST treat PortCast documents and API responses as personal data of
comparable sensitivity to browser history or messaging metadata.

### 12.2 Producer requirements

Producers:

- SHOULD let the user choose whether to include `owner`.
- SHOULD let the user choose whether to include event-level history
  (§6.2).
- SHOULD NOT include device identifiers, IP addresses, geolocation, or
  third-party analytics identifiers in any PortCast field, including
  inside `extensions`.
- MUST NOT embed the listener's account credentials, API keys, OAuth
  tokens, or session cookies anywhere in a PortCast document.
- SHOULD warn the listener before transmitting a PortCast document to a
  third party.

### 12.3 Consumer requirements

Consumers SHOULD treat an imported document as personal data, not as
shareable telemetry. Consumers MUST NOT retransmit a received document
to third parties without explicit listener consent. Consumers SHOULD
make it possible for the listener to delete imported data on demand.

### 12.4 Transport and storage (API mode)

In API mode (§14):

- Servers MUST require TLS (HTTPS); plain HTTP MUST be refused.
- Credentials (bearer tokens, OAuth client secrets) MUST NOT appear in
  URL query strings or path components; they MUST be carried in HTTP
  request headers.
- Servers MUST scope OAuth tokens to a single listener account.
- Servers SHOULD support per-client token revocation (§14.13).
- The `portcast.history` scope SHOULD be requested separately from
  `portcast.read` so the listener can grant subscription synchronisation
  without exposing per-event playback data.

### 12.5 Threat model and out-of-scope risks

PortCast does not, in v0.2, define a signing or sealing mechanism: a
document cannot be cryptographically attributed to the producer that
wrote it. Consumers SHOULD treat the source of a document as
out-of-band-authenticated (e.g., the user manually selected the file or
authorised the OAuth client). Adding a signed manifest is listed as an
open question for v0.3 (§16).

PortCast does not protect against a malicious application that has been
granted access to a listener's data; access control is the
responsibility of the producing or hosting application, not the
protocol. Consumers SHOULD apply input validation to imported
documents (notably to URL fields and `extensions` content) consistent
with their language and platform's safe-handling guidance.

## 13. Versioning

`portcast` is a SemVer string. Consumers:

- MUST accept any document whose `portcast` major version they support.
- MAY warn the user when a minor version is newer than they understand.
- MUST NOT silently drop fields they don't recognize; preserve them under
  `extensions._unknown` if necessary.

## 14. Live sync API

The file format (§3–§10) is a single JSON document moved between apps
out-of-band. API mode is an optional addition: the same entities,
exposed over HTTPS so clients can synchronise incrementally without a
full re-export. The wire payloads in API mode reuse the file-mode
schemas — no new entity shapes are introduced.

A conforming implementation MAY implement file mode, API mode, or
both. Clients MUST assume nothing beyond what a server advertises in its
discovery document (§14.2).

### 14.1 Operating modes

| Mode      | Transport                              | Use case                                            |
| --------- | -------------------------------------- | --------------------------------------------------- |
| **File**  | User-supplied `.portcast.json`         | One-shot migration, archival, manual transfer       |
| **API**   | HTTPS endpoints on the app's own domain | Live sync between two installed apps               |

File mode is the **interop floor**: every API-mode server SHOULD implement
at least `GET /portcast/v1/export`, which returns the same document a file
export would produce. A client that does not speak the rest of the API can
still pull a full snapshot this way.

### 14.2 Discovery

A PortCast server SHOULD publish a discovery document at
`/.well-known/portcast`:

```json
{
  "portcast": "0.2.0",
  "base": "https://example.app/portcast/v1",
  "auth": {
    "type": "oauth2",
    "authorizationEndpoint": "https://example.app/oauth/authorize",
    "tokenEndpoint": "https://example.app/oauth/token",
    "scopes": ["portcast.read", "portcast.write", "portcast.history"]
  },
  "capabilities": [
    "export",
    "subscriptions.read", "subscriptions.write",
    "episodes.read", "episodes.write",
    "queue.read", "queue.write",
    "bookmarks.read", "bookmarks.write",
    "preferences.read", "preferences.write",
    "events", "deltas", "webhooks"
  ]
}
```

`capabilities` is a flat string set. A read-only server omits `*.write`
entries. A server that does not track per-event history omits `events`.
A server that does not implement delta sync omits `deltas` and clients
fall back to fetching full collections.

### 14.3 Versioning and content type

- Endpoints live under `/portcast/v1/...`. The `v1` is the API major
  version and is independent of the spec version declared inside payloads.
- Servers MUST set `Content-Type: application/vnd.portcast+json` on
  responses. Clients SHOULD send a matching `Accept` header.
- Backwards-compatible additions (new optional fields, new capability
  strings) MUST NOT bump the API major version.

### 14.4 Authentication

Implementations MUST use one of:

- **OAuth 2.0**, with scopes drawn from `portcast.read`, `portcast.write`,
  `portcast.history`. `portcast.history` covers event-level playback data
  (§6.2) and is treated as more sensitive than basic read.
- **Bearer token** (`Authorization: Bearer <token>`) — appropriate for
  self-hosted or single-user deployments.

Credentials MUST NOT appear in URL query strings. Servers MUST reject
requests over plain HTTP.

### 14.5 Endpoints

| Method | Path                                     | Body / Returns                                                                 |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/portcast/v1/export`                    | Full PortCast document (= file-mode export)                                    |
| POST   | `/portcast/v1/import`                    | Body: full or partial PortCast document; server upserts each entity            |
| GET    | `/portcast/v1/subscriptions`             | `{ subscriptions, deletions?, syncedAt, nextCursor? }`                         |
| GET    | `/portcast/v1/subscriptions/{ref}`       | A `Subscription`                                                               |
| PUT    | `/portcast/v1/subscriptions/{ref}`       | Body: `Subscription`                                                           |
| DELETE | `/portcast/v1/subscriptions/{ref}`       | Unsubscribe (server MAY set `unsubscribedAt` rather than hard-delete)          |
| GET    | `/portcast/v1/episodes`                  | `{ episodes, deletions?, syncedAt, nextCursor? }`                              |
| POST   | `/portcast/v1/episodes`                  | Body: `{ episodes: [...] }`; upsert by `(subscriptionRef, guid \| enclosureUrl)` |
| GET    | `/portcast/v1/queue`                     | `{ queue }`                                                                    |
| PUT    | `/portcast/v1/queue`                     | Body: `{ queue }`; replaces the queue in full                                  |
| GET    | `/portcast/v1/bookmarks`                 | `{ bookmarks, deletions?, syncedAt, nextCursor? }`                             |
| POST   | `/portcast/v1/bookmarks`                 | Body: `Bookmark`                                                               |
| DELETE | `/portcast/v1/bookmarks/{bookmarkId}`    | —                                                                              |
| GET    | `/portcast/v1/preferences`               | `Preferences`                                                                  |
| PUT    | `/portcast/v1/preferences`               | Body: `Preferences`                                                            |

`{ref}` in subscription paths is the URL-encoded `podcastGuid` if known,
otherwise the URL-encoded `feedUrl`. Servers MUST accept either form and
SHOULD canonicalise to `podcastGuid` internally.

Episodes are intentionally **not addressed by path** — RSS GUIDs include
URLs, raw text, and other characters that do not round-trip cleanly
through URL encoding. Episode operations use the collection endpoint with
the ref carried in the body.

### 14.6 Delta sync

Collection endpoints (`subscriptions`, `episodes`, `bookmarks`) MUST accept
`?since=<RFC 3339 timestamp>` when the server advertises the `deltas`
capability. The response then contains:

- only entities whose `updatedAt > since`,
- a `deletions` array of refs for entities removed since that timestamp,
- a `syncedAt` timestamp the client persists for the next round.

```json
{
  "episodes": [ ... ],
  "deletions": [
    { "guid": "https://example.com/ep/37" }
  ],
  "syncedAt": "2026-05-26T14:00:00Z"
}
```

Servers SHOULD retain deletion tombstones for at least 30 days. Clients
that have been offline longer SHOULD discard their cached `syncedAt` and
perform a full pull.

### 14.7 Pagination

Endpoints that may return large collections support cursor-based
pagination. The response carries `nextCursor` when more pages exist; the
client passes `?cursor=<value>` to fetch the next page. Cursors are
opaque strings. `since` and `cursor` MAY be combined.

### 14.8 Conditional updates

Writes SHOULD use `If-Match: <updatedAt>` for optimistic concurrency.
Servers MUST respond `412 Precondition Failed` if the resource's current
`updatedAt` is newer than the value supplied. This prevents two clients
clobbering each other's position updates on the same episode.

### 14.9 Errors

Errors are JSON, with HTTP status reflecting the class:

```json
{
  "error": {
    "code": "subscription_not_found",
    "message": "No subscription matched podcastGuid=917393e3-…",
    "ref": { "podcastGuid": "917393e3-…" }
  }
}
```

Defined `code` values: `unauthorized`, `forbidden`, `not_found`,
`conflict`, `precondition_failed`, `invalid_request`,
`unsupported_capability`, `rate_limited`, `internal_error`. Servers MAY
define additional codes under a reverse-DNS prefix
(`com.example.quota_exceeded`).

### 14.10 Webhooks (optional)

Servers advertising the `webhooks` capability accept registrations at:

`POST /portcast/v1/webhooks` with body:

```json
{
  "url": "https://client.example/portcast/hook",
  "events": ["episode.updated", "subscription.added", "subscription.removed", "queue.updated"],
  "secret": "<shared secret, ≥ 32 bytes>"
}
```

Webhook deliveries carry `X-PortCast-Signature: sha256=<hex>` computed
over the raw request body with the registration secret as the HMAC key.
Receivers MUST verify the signature and SHOULD respond 2xx within 5
seconds. Servers SHOULD retry failed deliveries with exponential backoff
for at least 24 hours.

Webhooks are an optimisation; the baseline pattern is client-driven
polling with `?since=`.

### 14.11 Capability fallback

A client that needs a capability the server does not advertise SHOULD
fall back to `GET /portcast/v1/export` and process the returned document
as a file-mode import. This guarantees a baseline interop floor even for
minimal server implementations.

### 14.12 Federation

PortCast is intentionally federated. Each app exposes its own endpoint on
its own domain; there is no central directory or hub. A client connecting
a new account typically:

1. Asks the user for the app's domain (e.g. `pocketcasts.com`).
2. Fetches `https://pocketcasts.com/.well-known/portcast`.
3. Runs the OAuth dance against the endpoints declared there.
4. Begins delta-syncing.

Servers MUST NOT require registration with any central authority to be
considered conforming, and the editors of this spec commit to not
operating one.

### 14.13 Security and privacy in API mode

Section 12 applies to API mode unchanged. In particular, §12.4 specifies
the transport and credential requirements for API-mode servers.
Implementers SHOULD support per-client token revocation so a listener
can disconnect a single client without affecting the others.

## 15. IANA considerations

This document requests four IANA actions. All registrations use the
provisional-registration procedure where applicable; the editors will
work with IANA to finalise registrations at the time of RFC publication.

### 15.1 Media type registration

IANA is requested to register the following media type per [RFC6838]:

| Field                    | Value                                              |
| ------------------------ | -------------------------------------------------- |
| Type name                | `application`                                       |
| Subtype name             | `vnd.portcast+json`                                |
| Required parameters      | none                                                |
| Optional parameters      | none                                                |
| Encoding considerations  | binary; PortCast documents are UTF-8 encoded JSON  |
| Security considerations  | See Section 12 of this document.                   |
| Interoperability cons.   | See Section 13 (Versioning).                       |
| Published specification  | This document.                                     |
| Applications that use it | Podcast applications, subscription importers/exporters, OPML migration tools, listener-data synchronisation services. |
| Fragment identifier      | The JSON Pointer fragment identifier syntax [RFC6901] applies. |
| Restrictions on use      | none                                                |
| Provisional registration | yes (until RFC publication)                        |
| Author / change controller | The editors of this specification.               |
| Intended usage           | COMMON                                              |

The file extension `.portcast.json` is the RECOMMENDED extension; the
`+json` structured-syntax suffix [RFC8259] indicates the underlying JSON
serialization.

### 15.2 Well-known URI registration

IANA is requested to register a new entry in the "Well-Known URIs"
registry per [RFC8615]:

| Field                  | Value                                              |
| ---------------------- | -------------------------------------------------- |
| URI suffix             | `portcast`                                         |
| Change controller      | The editors of this specification.                  |
| Specification document | This document (Section 14.2).                       |
| Related information    | The resource is a JSON object describing a PortCast API endpoint (its base URL, authentication scheme, and capability set). |
| Status                 | provisional                                        |

### 15.3 OAuth 2.0 scope registration

IANA is requested to register the following OAuth 2.0 scopes in the
"OAuth Access Token Scopes" registry per [RFC6749] and [RFC8809]:

| Scope name           | Description                                        |
| -------------------- | -------------------------------------------------- |
| `portcast.read`      | Read subscriptions, episode state (excluding event history), queue, bookmarks, and preferences. |
| `portcast.write`     | Create, update, and delete the same entities the `portcast.read` scope grants visibility into. |
| `portcast.history`   | Read or write event-level playback history (§6.2). MUST be requested separately from `portcast.read`. |

Change controller: the editors of this specification.

### 15.4 PortCast error code registry

This document establishes a new IANA registry titled "PortCast Error
Codes" with the following structure:

| Field             | Type / notes                                       |
| ----------------- | -------------------------------------------------- |
| `code`            | A short, lowercase, underscore-separated identifier returned in API error responses (§14.9). |
| `description`     | A one-sentence summary of when the error is returned. |
| `reference`       | The document defining the code.                    |

The registration policy is *Specification Required* [RFC8126]. Initial
contents:

| Code                       | Description                                         | Reference          |
| -------------------------- | --------------------------------------------------- | ------------------ |
| `unauthorized`             | The request lacks valid authentication credentials. | This document      |
| `forbidden`                | The credentials do not grant access to the resource.| This document      |
| `not_found`                | The referenced entity does not exist.               | This document      |
| `conflict`                 | The request conflicts with current server state.   | This document      |
| `precondition_failed`      | An `If-Match` precondition was not satisfied (§14.8). | This document    |
| `invalid_request`          | The request body or parameters are malformed.       | This document      |
| `unsupported_capability`   | The client asked for a capability the server does not advertise. | This document |
| `rate_limited`             | The client has exceeded a server-defined rate limit.| This document      |
| `internal_error`           | The server encountered an unexpected error.         | This document      |

Servers MAY return additional vendor-defined codes prefixed with a
reverse-DNS namespace (e.g., `com.example.quota_exceeded`); such
vendor-prefixed codes do not require IANA registration.

## 16. Open questions for v0.3

- A signed manifest (detached signature) so listeners can verify a
  document or API response came from app X.
- A binary attachment sidecar for downloaded audio (probably out of scope —
  audio belongs to the publisher).
- OPML round-trip: import directly, or keep the OPML↔PortCast bridge in
  reference code only.
- Multi-account documents (one listener, several podcast apps' state
  merged into a single export).
- WebFinger [RFC7033]-style discovery so a client can find a PortCast
  server given only the listener's email address.
- Conflict-resolution semantics when two clients diverge while offline,
  beyond the optimistic-concurrency floor in §14.8.
- IANA registry of platform-reference schemes (§4.3), so adapters
  written by different parties can agree on `spotify:`, `apple:`,
  `pocketcasts:`, etc. without coordinating out-of-band.

Feedback welcome via GitHub issues on this repository.

## 17. References

### 17.1 Normative references

**[RFC2119]** Bradner, S., "Key words for use in RFCs to Indicate
Requirement Levels", BCP 14, RFC 2119, March 1997,
<https://www.rfc-editor.org/info/rfc2119>.

**[RFC3339]** Klyne, G. and C. Newman, "Date and Time on the Internet:
Timestamps", RFC 3339, July 2002,
<https://www.rfc-editor.org/info/rfc3339>.

**[RFC6749]** Hardt, D., Ed., "The OAuth 2.0 Authorization Framework",
RFC 6749, October 2012, <https://www.rfc-editor.org/info/rfc6749>.

**[RFC6750]** Jones, M. and D. Hardt, "The OAuth 2.0 Authorization
Framework: Bearer Token Usage", RFC 6750, October 2012,
<https://www.rfc-editor.org/info/rfc6750>.

**[RFC6838]** Freed, N., Klensin, J., and T. Hansen, "Media Type
Specifications and Registration Procedures", BCP 13, RFC 6838,
January 2013, <https://www.rfc-editor.org/info/rfc6838>.

**[RFC6901]** Bryan, P., Zyp, K., and M. Nottingham, Ed., "JavaScript
Object Notation (JSON) Pointer", RFC 6901, April 2013,
<https://www.rfc-editor.org/info/rfc6901>.

**[RFC8126]** Cotton, M., Leiba, B., and T. Narten, "Guidelines for
Writing an IANA Considerations Section in RFCs", BCP 26, RFC 8126,
June 2017, <https://www.rfc-editor.org/info/rfc8126>.

**[RFC8174]** Leiba, B., "Ambiguity of Uppercase vs Lowercase in
RFC 2119 Key Words", BCP 14, RFC 8174, May 2017,
<https://www.rfc-editor.org/info/rfc8174>.

**[RFC8259]** Bray, T., Ed., "The JavaScript Object Notation (JSON)
Data Interchange Format", STD 90, RFC 8259, December 2017,
<https://www.rfc-editor.org/info/rfc8259>.

**[RFC8615]** Nottingham, M., "Well-Known Uniform Resource Identifiers
(URIs)", RFC 8615, May 2019,
<https://www.rfc-editor.org/info/rfc8615>.

**[RFC8809]** Bradley, J., Jones, M., Kumar, A., Lindemann, R., and J.
Hodges, "Registries for Web Authentication (WebAuthn)", RFC 8809,
August 2020, <https://www.rfc-editor.org/info/rfc8809>.

**[PodcastNamespace]** Podcasting 2.0, "The 'podcast' Namespace —
`<podcast:guid>` element", <https://podcastindex.org/namespace/1.0#guid>.

**[JSONSchema2020-12]** Wright, A., Andrews, H., Hutton, B., and G.
Dennis, "JSON Schema: A Media Type for Describing JSON Documents",
Draft 2020-12, <https://json-schema.org/draft/2020-12/schema>.

### 17.2 Informative references

**[OPML2.0]** Winer, D., "OPML 2.0 Specification", October 2007,
<http://opml.org/spec2.opml>.

**[RFC4846]** Klensin, J., Ed. and D. Thaler, Ed., "Independent
Submissions to the RFC Editor", RFC 4846, July 2007,
<https://www.rfc-editor.org/info/rfc4846>.

**[RFC5378]** Bradner, S., Ed. and J. Contreras, Ed., "Rights
Contributors Provide to the IETF Trust", BCP 78, RFC 5378,
November 2008, <https://www.rfc-editor.org/info/rfc5378>.

**[RFC5744]** Braden, R. and J. Halpern, "Procedures for Rights
Handling in the RFC Independent Submission Stream", RFC 5744,
December 2009, <https://www.rfc-editor.org/info/rfc5744>.

**[RFC7033]** Jones, P., Salgueiro, G., Jones, M., and J. Smarr,
"WebFinger", RFC 7033, September 2013,
<https://www.rfc-editor.org/info/rfc7033>.

## 18. Acknowledgments

PortCast builds on a long tradition of attempts to make a listener's
relationship with their podcasts portable. The editors thank Dave Winer
for OPML, which has carried podcast subscriptions across applications
for two decades and which inspired the goal of doing the same for the
rest of a listener's data. We thank the Podcast Namespace project for
`<podcast:guid>`, which makes cross-application show identity tractable.
We also thank the podcast-app development community on GitHub and the
fediverse for feedback on early drafts.

## 19. Authors' addresses

**Editor: Trimplayer**
Email: <trimplayerapp@gmail.com>
URI:   <https://trimplayer.com/>
Project: <https://portcast.org/>
Issue tracker: <https://github.com/Trim-Player/PortCast/issues>

---

## Appendix A. Submission notes (non-normative)

This document is authored in Markdown for ease of public iteration. For
submission to the RFC Editor under the Independent Submission stream, a
companion Internet-Draft is produced from this source using
`kramdown-rfc` (or an equivalent toolchain) and includes the
RFC Editor's standard "Status of This Memo" and "Copyright Notice"
boilerplate as required by [RFC4846] and [RFC5378]; that boilerplate is
inserted by the publication toolchain rather than maintained here.

## Appendix B. Known platform-reference schemes (non-normative)

The following platform-reference schemes (§4.3) are in use by adapters
shipped with the PortCast reference implementation. This list is
informative and not an IANA registry; new schemes MAY be introduced by
adapter authors without coordination with the editors of this spec.

| Scheme        | Entity types                       | Example URI                                            |
| ------------- | ---------------------------------- | ------------------------------------------------------ |
| `spotify`     | `show`, `episode`                  | `spotify:show:5CnDmMUG0S5bSSw612fs8C`                  |

A future revision of this document MAY promote this list to a normative
IANA registry (see §16).

## Appendix C. Changelog (non-normative)

### 0.2.0 — 2026-05-29

- Added `platformRefs` (§4.3) as an identifier of last resort on
  `Subscription`, `SubscriptionRef`, `EpisodeRef`, and `EpisodeState`,
  for shows and episodes with no RSS feed (e.g. Spotify-exclusive
  content).
- Added optional `source` and `capturedAt` (§6.3) on `EpisodeState`
  and `PlaybackEvent` to attribute provenance.
- Added the `completeness` document field and a new §11 specifying
  merge semantics for documents assembled from multiple upstream
  sources over time.
- Unified version numbering: the file format and the API mode now
  share a single SemVer (0.2.0).
- Added Appendix B (known platform-reference schemes) and
  Appendix C (this changelog).

### 0.1.0 — 2026-05-26

- Initial public draft of the file format: subscriptions, episode
  state, playback events, queue, bookmarks, preferences, namespaced
  extensions, security and privacy considerations, IANA
  considerations.
