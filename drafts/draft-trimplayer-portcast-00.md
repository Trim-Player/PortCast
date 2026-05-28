---
title: >
  PortCast: A JSON-Based Interchange Format and Sync API for
  Portable Podcast Listener Data
abbrev: PortCast
docname: draft-trimplayer-portcast-00
category: info
ipr: trust200902
stream: independent
submissiontype: independent
area: Applications
keyword:
  - podcast
  - opml
  - subscription
  - synchronization
  - listener

venue:
  github: Trim-Player/PortCast
  latest: https://portcast.org/

stand_alone: yes
pi:
  toc: yes
  tocdepth: 3
  sortrefs: yes
  symrefs: yes

author:
  -
    ins: Trimplayer Editors
    name: Trimplayer Editors
    organization: Trimplayer
    email: trimplayerapp@gmail.com
    uri: https://trimplayer.com/

normative:
  RFC2119:
  RFC3339:
  RFC6749:
  RFC6750:
  RFC6838:
  RFC6901:
  RFC8126:
  RFC8174:
  RFC8259:
  RFC8615:
  RFC8809:
  PODCAST-NAMESPACE:
    title: "The 'podcast' Namespace - podcast:guid element"
    target: https://podcastindex.org/namespace/1.0#guid
    author:
      - org: Podcasting 2.0 Project
  JSON-SCHEMA-2020-12:
    title: "JSON Schema: A Media Type for Describing JSON Documents (Draft 2020-12)"
    target: https://json-schema.org/draft/2020-12/schema
    author:
      - ins: A. Wright
      - ins: H. Andrews
      - ins: B. Hutton
      - ins: G. Dennis

informative:
  RFC4846:
  RFC5378:
  RFC5744:
  RFC7033:
  OPML2.0:
    title: OPML 2.0 Specification
    target: http://opml.org/spec2.opml
    author:
      - ins: D. Winer
    date: 2007-10

--- abstract

PortCast defines an open JSON-based interchange format, and an optional
HTTPS synchronisation API, for moving a podcast listener's data --
subscriptions, listening history, playback position, queue, bookmarks,
and per-feed preferences -- between independent podcast applications
without a central service. It builds on identifiers already present in
RSS (item GUID, feed URL) and the Podcast Namespace
(podcast:guid) so that implementations can interoperate without
inventing a new identity namespace. This document specifies the file
format (v0.1) and a federated synchronisation API (v0.2) that reuses
the same data model.

--- middle

# Introduction

A listener's relationship with their podcasts -- which shows they
follow, where they stopped in an unfinished episode, the clip they
bookmarked at 23:04 -- currently lives inside whichever application they
happen to use. Switching applications restarts that relationship from
zero. OPML {{OPML2.0}} solves the subscription case, but everything else
(playback position, completion state, queue, bookmarks, per-feed
preferences) is lost on every migration.

This document specifies PortCast, a protocol whose goal is simple: a
listener SHOULD be able to leave any podcast application and arrive at
any other application with the relationship to their podcasts intact.
PortCast defines a JSON document format (file mode, {{document-container}}
through {{extensions}}) and an optional HTTPS API (API mode,
{{live-sync-api}}) that exposes the same entities for incremental
synchronisation. The two modes share a single data model; file mode is
the interoperability floor that every conforming implementation can
fall back to.

PortCast is intentionally federated. There is no central directory,
registry, or authority. Each application exposes its own endpoint on
its own domain, or produces its own files. The editors of this
specification commit to not operating a central service.

## Design goals

1. **Listener-owned.** The document is produced by the user, for the
   user. No vendor lock-in, no proprietary identifiers required.
2. **Interoperable identity.** Use open identifiers already present in
   RSS (item GUID, feed URL) rather than inventing a new namespace.
   Implementations MAY add their own identifiers in a namespaced
   extension block.
3. **Lossless within the model.** A conforming export captures
   everything the protocol defines. Anything outside the model goes in
   `extensions` so it round-trips through implementations that do not
   understand it.
4. **Partial and incremental.** Every entity carries an `updatedAt`
   timestamp, so a future synchronisation profile can ship deltas. The
   v0.1 file format is a full snapshot, but the data model is
   synchronisation-friendly.
5. **Human-readable.** A listener SHOULD be able to open the file in a
   text editor and recognise what it says about them.
6. **Versioned.** The document declares its protocol version;
   implementations can negotiate behaviour.

# Terminology and conformance

## Requirements language

{::boilerplate bcp14-tagged}

## Defined roles

A **producer** is software that writes a PortCast document or serves
PortCast API responses.

A **consumer** is software that reads a PortCast document or calls a
PortCast API.

A **conforming producer** MUST write a document that validates against
the JSON Schemas published with this specification. A **conforming
consumer** MUST accept any document that validates against those
schemas, and MUST NOT reject a document because of unrecognised keys
inside an `extensions` object ({{extensions}}).

# Document container {#document-container}

A PortCast document is a single JSON object {{RFC8259}}, encoded in
UTF-8 without a byte order mark, with the following top-level shape:

~~~ json
{
  "portcast": "0.1.0",
  "generatedAt": "2026-05-26T14:00:00Z",
  "generator": { "name": "Trimplayer", "version": "3.4.1" },
  "owner": { "displayName": "Jonathan", "email": "user@example.com" },
  "subscriptions": [ ],
  "episodes":      [ ],
  "queue":         [ ],
  "bookmarks":     [ ],
  "preferences":   { },
  "extensions":    { }
}
~~~

| Field           | Required | Notes                                                   |
| --------------- | -------- | ------------------------------------------------------- |
| `portcast`      | yes      | Semantic-versioned string. The version of this spec.    |
| `generatedAt`   | yes      | RFC 3339 {{RFC3339}} timestamp in UTC.                  |
| `generator`     | yes      | Producing application identifier.                       |
| `owner`         | no       | Optional listener identity. Producers SHOULD let users opt out. |
| `subscriptions` | yes      | Array of `Subscription`. MAY be empty.                  |
| `episodes`      | yes      | Array of `EpisodeState`. MAY be empty.                  |
| `queue`         | no       | Ordered array of `QueueItem`.                           |
| `bookmarks`     | no       | Array of `Bookmark`.                                    |
| `preferences`   | no       | `Preferences` object.                                   |
| `extensions`    | no       | Namespaced extension data ({{extensions}}).             |

The file extension SHOULD be `.portcast.json` and the IANA media type
SHOULD be `application/vnd.portcast+json` (see {{iana-considerations}}).

# Identity model

Identity is the heart of an interoperability protocol. PortCast
identifies entities at two levels.

## Podcast identity

A `Subscription` MUST carry at least one of:

- `feedUrl` -- the canonical RSS or Atom URL of the show.
- `podcastGuid` -- the Podcast Namespace `<podcast:guid>` value
  {{PODCAST-NAMESPACE}} when the feed publishes one. This is the
  strongest identifier and SHOULD be preferred when matching across
  applications.

A subscription SHOULD include both when both are available.
Producers MAY also carry directory-specific identifiers (e.g., Apple
Podcasts, Podcast Index) under `Subscription.identifiers.*`; these are
advisory and not required for matching.

## Episode identity

An `EpisodeState` MUST carry at least one of:

- `guid` -- the RSS `<item><guid>` value (preferred).
- `enclosureUrl` -- the media URL from `<enclosure url="...">`.

It MUST also carry a `subscriptionRef` (either `podcastGuid` or
`feedUrl`) that matches one of the document's `subscriptions[]`
entries. If neither a `guid` nor an `enclosureUrl` is known, an episode
state MAY use a stable `(subscriptionRef, publishedAt, title)` tuple,
but consumers are not required to match by it.

# Subscriptions

~~~ json
{
  "subscriptionId": "01HXYZ...",
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
~~~

`unsubscribedAt` is set when the listener has stopped following the
show but the producer still wishes to convey historical context.
Consumers MAY discard unsubscribed entries on import. `tags` are
free-form, listener-applied labels.

# Episode state

~~~ json
{
  "episodeStateId": "01HXYZ...",
  "subscriptionRef": { "podcastGuid": "917393e3-..." },
  "guid": "https://example.com/ep/42",
  "enclosureUrl": "https://example.com/audio/ep42.mp3",
  "title": "Episode 42",
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
    { "type": "pause", "at": "2026-05-22T19:05:12Z", "positionSeconds": 2112 }
  ],

  "updatedAt": "2026-05-25T08:11:00Z"
}
~~~

## status values

| Value         | Meaning                                                  |
| ------------- | -------------------------------------------------------- |
| `unplayed`    | Listener has never started this episode.                 |
| `in_progress` | Listener started but did not finish.                     |
| `completed`   | Listener reached the end or marked complete.             |
| `archived`    | Listener explicitly dismissed without listening.         |

`positionSeconds` is REQUIRED when `status` is `in_progress` and SHOULD
be zero or omitted otherwise. Producers SHOULD record a small tolerance
(for example, treating the episode as completed if the listener reached
within 30 seconds of the end).

## Playback events {#playback-events}

The `events` array is OPTIONAL. Each event has a `type` from the set
{`play`, `pause`, `seek`, `complete`, `speed_change`, `bookmark`} and
attaches its own typed fields. Producers MAY include a subset; consumers
MAY ignore events they do not understand. Producers that do not track
event-level history can omit `events` entirely; the top-level fields
(`positionSeconds`, `playCount`, `lastPlayedAt`) are still sufficient
for everyday "where did I leave off" portability.

# Queue

~~~ json
{
  "queue": [
    { "position": 1, "episodeRef": { "guid": "https://example.com/ep/42" },
      "addedAt": "2026-05-25T09:00:00Z", "source": "manual" },
    { "position": 2, "episodeRef": { "enclosureUrl": "https://.../ep43.mp3" },
      "addedAt": "2026-05-25T09:01:00Z", "source": "auto" }
  ]
}
~~~

`position` is 1-based and MUST be unique within the queue. `source` is
free-form (e.g., `manual`, `auto`, `smart-playlist:Morning Commute`).

# Bookmarks

~~~ json
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
~~~

`endSeconds` is OPTIONAL; its presence promotes a bookmark to a *clip*.

# Preferences

~~~ json
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
~~~

`perFeed` keys are `podcastGuid` when available, otherwise `feedUrl`.
Per-feed values override `global`.

# Extensions {#extensions}

Anything outside this specification lives under an `extensions` object,
keyed by reverse-DNS namespace:

~~~ json
"extensions": {
  "com.trimplayer.skips": [
    { "episodeGuid": "...", "skippedRanges": [[12.0, 47.5]] }
  ],
  "fm.overcast.smart-speed": { "secondsSaved": 18421 }
}
~~~

Consumers MUST preserve `extensions` on round-trip even if they do not
understand a namespace. This is what keeps a multi-application journey
lossless.

# Versioning {#versioning}

`portcast` is a semantic-versioned string. Consumers:

- MUST accept any document whose `portcast` major version they support.
- MAY warn the listener when a minor version is newer than they
  understand.
- MUST NOT silently drop fields they do not recognise; preserve them
  under `extensions._unknown` if necessary.

# Live sync API (v0.2 -- Draft) {#live-sync-api}

The file format defined above (v0.1) is the interoperability floor.
v0.2 introduces an optional API mode: the same entities, exposed over
HTTPS so clients can synchronise incrementally without a full
re-export. The wire payloads in API mode reuse the v0.1 schemas; no new
entity shapes are introduced.

A conforming v0.2 implementation MAY implement file mode, API mode, or
both. Clients MUST assume nothing beyond what a server advertises in
its discovery document ({{discovery}}).

## Operating modes

| Mode | Transport                                | Use case                                       |
| ---- | ---------------------------------------- | ---------------------------------------------- |
| File | User-supplied `.portcast.json`           | One-shot migration, archival, manual transfer  |
| API  | HTTPS endpoints on the application's domain | Live sync between two installed applications |

File mode is the interoperability floor: every API-mode server SHOULD
implement at least `GET /portcast/v1/export`, which returns the same
document a file export would produce.

## Discovery {#discovery}

A PortCast server SHOULD publish a discovery document at
`/.well-known/portcast` {{RFC8615}}:

~~~ json
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
~~~

`capabilities` is a flat string set. A read-only server omits `*.write`
entries. A server that does not track per-event history omits `events`.
A server that does not implement delta synchronisation omits `deltas`
and clients fall back to fetching full collections.

## Versioning and content type

Endpoints live under `/portcast/v1/...`. The `v1` is the API major
version and is independent of the specification version declared inside
payloads. Servers MUST set `Content-Type: application/vnd.portcast+json`
on responses; clients SHOULD send a matching `Accept` header.
Backwards-compatible additions (new optional fields, new capability
strings) MUST NOT bump the API major version.

## Authentication

Implementations MUST use one of:

- OAuth 2.0 {{RFC6749}}, with scopes drawn from `portcast.read`,
  `portcast.write`, `portcast.history`. The `portcast.history` scope
  covers event-level playback data ({{playback-events}}) and is
  treated as more sensitive than basic read.
- Bearer token {{RFC6750}}, appropriate for self-hosted or single-user
  deployments.

Credentials MUST NOT appear in URL query strings. Servers MUST reject
requests over plain HTTP.

## Endpoints

| Method | Path                                  | Body / Returns                                                                  |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| GET    | `/portcast/v1/export`                 | Full PortCast document (= v0.1 file)                                            |
| POST   | `/portcast/v1/import`                 | Body: full or partial PortCast document; server upserts each entity             |
| GET    | `/portcast/v1/subscriptions`          | `{ subscriptions, deletions?, syncedAt, nextCursor? }`                          |
| GET    | `/portcast/v1/subscriptions/{ref}`    | A `Subscription`                                                                |
| PUT    | `/portcast/v1/subscriptions/{ref}`    | Body: `Subscription`                                                            |
| DELETE | `/portcast/v1/subscriptions/{ref}`    | Unsubscribe                                                                     |
| GET    | `/portcast/v1/episodes`               | `{ episodes, deletions?, syncedAt, nextCursor? }`                               |
| POST   | `/portcast/v1/episodes`               | Body: `{ episodes: [...] }`; upsert                                              |
| GET    | `/portcast/v1/queue`                  | `{ queue }`                                                                     |
| PUT    | `/portcast/v1/queue`                  | Body: `{ queue }`; replaces in full                                              |
| GET    | `/portcast/v1/bookmarks`              | `{ bookmarks, deletions?, syncedAt, nextCursor? }`                              |
| POST   | `/portcast/v1/bookmarks`              | Body: `Bookmark`                                                                |
| DELETE | `/portcast/v1/bookmarks/{bookmarkId}` |                                                                                 |
| GET    | `/portcast/v1/preferences`            | `Preferences`                                                                   |
| PUT    | `/portcast/v1/preferences`            | Body: `Preferences`                                                             |

`{ref}` in subscription paths is the URL-encoded `podcastGuid` when
known, otherwise the URL-encoded `feedUrl`. Servers MUST accept either
form. Episodes are intentionally not addressed by path because RSS
GUIDs do not round-trip cleanly through URL encoding.

## Delta sync

Collection endpoints (`subscriptions`, `episodes`, `bookmarks`) MUST
accept `?since=<RFC 3339 timestamp>` when the server advertises the
`deltas` capability. The response then contains only entities whose
`updatedAt > since`, a `deletions` array of refs for entities removed
since that timestamp, and a `syncedAt` timestamp the client persists
for the next round.

Servers SHOULD retain deletion tombstones for at least 30 days. Clients
that have been offline longer SHOULD discard their cached `syncedAt`
and perform a full pull.

## Pagination

Endpoints that may return large collections support cursor-based
pagination. The response carries `nextCursor` when more pages exist;
the client passes `?cursor=<value>` to fetch the next page. Cursors are
opaque strings. `since` and `cursor` MAY be combined.

## Conditional updates {#conditional-updates}

Writes SHOULD use `If-Match: <updatedAt>` for optimistic concurrency.
Servers MUST respond `412 Precondition Failed` if the resource's
current `updatedAt` is newer than the supplied value. This prevents two
clients clobbering each other's position updates on the same episode.

## Errors {#api-errors}

Errors are JSON, with HTTP status reflecting the class:

~~~ json
{
  "error": {
    "code": "subscription_not_found",
    "message": "No subscription matched podcastGuid=917393e3-...",
    "ref": { "podcastGuid": "917393e3-..." }
  }
}
~~~

The initial set of `code` values is registered in
{{iana-error-codes}}. Servers MAY define additional codes under a
reverse-DNS prefix (e.g., `com.example.quota_exceeded`); such
vendor-prefixed codes do not require IANA registration.

## Webhooks (optional)

Servers advertising the `webhooks` capability accept registrations at
`POST /portcast/v1/webhooks` with body:

~~~ json
{
  "url": "https://client.example/portcast/hook",
  "events": ["episode.updated", "subscription.added",
             "subscription.removed", "queue.updated"],
  "secret": "<shared secret, >= 32 bytes>"
}
~~~

Webhook deliveries carry `X-PortCast-Signature: sha256=<hex>` computed
over the raw request body with the registration secret as the HMAC
key. Receivers MUST verify the signature and SHOULD respond 2xx within
5 seconds. Servers SHOULD retry failed deliveries with exponential
backoff for at least 24 hours.

Webhooks are an optimisation; the baseline pattern is client-driven
polling with `?since=`.

## Capability fallback

A client that needs a capability the server does not advertise SHOULD
fall back to `GET /portcast/v1/export` and process the returned
document as a file-mode import. This guarantees a baseline
interoperability floor even for minimal server implementations.

## Federation

PortCast is intentionally federated. Each application exposes its own
endpoint on its own domain; there is no central directory or hub. A
client connecting a new account typically:

1. Asks the listener for the application's domain.
2. Fetches `https://<domain>/.well-known/portcast`.
3. Runs the OAuth dance against the endpoints declared there.
4. Begins delta-synchronising.

Servers MUST NOT require registration with any central authority to be
considered conforming.

# Security considerations {#security-considerations}

## Sensitivity of the data

A PortCast document is a detailed record of personal listening
behaviour: which shows a listener follows, when they started or
finished an episode, which passages they bookmarked, and (when
event-level history is included) the moment-to-moment shape of their
attention. Implementers MUST treat PortCast documents and API
responses as personal data of comparable sensitivity to browser history
or messaging metadata.

## Producer requirements

Producers:

- SHOULD let the listener choose whether to include `owner`.
- SHOULD let the listener choose whether to include event-level history
  ({{playback-events}}).
- SHOULD NOT include device identifiers, IP addresses, geolocation, or
  third-party analytics identifiers in any PortCast field, including
  inside `extensions`.
- MUST NOT embed the listener's account credentials, API keys, OAuth
  tokens, or session cookies anywhere in a PortCast document.
- SHOULD warn the listener before transmitting a PortCast document to
  a third party.

## Consumer requirements

Consumers SHOULD treat an imported document as personal data, not as
shareable telemetry. Consumers MUST NOT retransmit a received document
to third parties without explicit listener consent. Consumers SHOULD
make it possible for the listener to delete imported data on demand.

## Transport and storage (API mode) {#api-transport-security}

In API mode ({{live-sync-api}}):

- Servers MUST require TLS; plain HTTP MUST be refused.
- Credentials MUST NOT appear in URL query strings or path components;
  they MUST be carried in HTTP request headers.
- Servers MUST scope OAuth tokens to a single listener account.
- Servers SHOULD support per-client token revocation.
- The `portcast.history` scope SHOULD be requested separately from
  `portcast.read`.

## Threat model and out-of-scope risks

PortCast does not, in v0.1, define a signing or sealing mechanism: a
document cannot be cryptographically attributed to the producer that
wrote it. Consumers SHOULD treat the source of a document as
out-of-band-authenticated (e.g., the listener manually selected the
file or authorised the OAuth client). Adding a signed manifest is
listed as a future work item.

PortCast does not protect against a malicious application that has
been granted access to a listener's data; access control is the
responsibility of the producing or hosting application, not the
protocol. Consumers SHOULD apply input validation to imported
documents (notably to URL fields and `extensions` content) consistent
with their platform's safe-handling guidance.

# IANA considerations {#iana-considerations}

This document requests four IANA actions.

## Media type registration

IANA is requested to register the following media type per {{RFC6838}}:

| Field                       | Value                                              |
| --------------------------- | -------------------------------------------------- |
| Type name                   | application                                        |
| Subtype name                | vnd.portcast+json                                  |
| Required parameters         | none                                               |
| Optional parameters         | none                                               |
| Encoding considerations     | binary; PortCast documents are UTF-8 encoded JSON  |
| Security considerations     | See {{security-considerations}} of this document   |
| Interoperability cons.      | See {{versioning}} of this document                |
| Published specification     | This document                                      |
| Applications that use it    | Podcast applications, subscription importers and exporters, listener-data synchronisation services |
| Fragment identifier         | JSON Pointer syntax {{RFC6901}}                    |
| Restrictions on use         | none                                               |
| Provisional registration    | yes (until RFC publication)                        |
| Author / change controller  | The editors of this specification                  |
| Intended usage              | COMMON                                             |

The file extension `.portcast.json` is the RECOMMENDED extension; the
`+json` structured-syntax suffix indicates the underlying JSON
serialization.

## Well-known URI registration

IANA is requested to register a new entry in the "Well-Known URIs"
registry per {{RFC8615}}:

| Field                  | Value                                                  |
| ---------------------- | ------------------------------------------------------ |
| URI suffix             | portcast                                               |
| Change controller      | The editors of this specification                       |
| Specification document | This document ({{discovery}})                           |
| Related information    | The resource is a JSON object describing a PortCast API endpoint (its base URL, authentication scheme, and capability set) |
| Status                 | provisional                                            |

## OAuth 2.0 scope registration

IANA is requested to register the following OAuth 2.0 scopes per
{{RFC6749}} and {{RFC8809}}:

| Scope name         | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| portcast.read      | Read subscriptions, episode state (excluding event history), queue, bookmarks, and preferences |
| portcast.write     | Create, update, and delete the same entities the `portcast.read` scope grants visibility into |
| portcast.history   | Read or write event-level playback history ({{playback-events}}). MUST be requested separately from `portcast.read` |

Change controller: the editors of this specification.

## PortCast error code registry {#iana-error-codes}

This document establishes a new IANA registry titled "PortCast Error
Codes" with the following structure:

| Field         | Type / notes                                                        |
| ------------- | ------------------------------------------------------------------- |
| `code`        | A short, lowercase, underscore-separated identifier returned in API error responses ({{api-errors}}) |
| `description` | A one-sentence summary of when the error is returned                |
| `reference`   | The document defining the code                                      |

The registration policy is Specification Required {{RFC8126}}. Initial
contents:

| Code                     | Description                                                            | Reference     |
| ------------------------ | ---------------------------------------------------------------------- | ------------- |
| unauthorized             | The request lacks valid authentication credentials                     | This document |
| forbidden                | The credentials do not grant access to the resource                    | This document |
| not_found                | The referenced entity does not exist                                   | This document |
| conflict                 | The request conflicts with current server state                        | This document |
| precondition_failed      | An `If-Match` precondition was not satisfied ({{conditional-updates}}) | This document |
| invalid_request          | The request body or parameters are malformed                           | This document |
| unsupported_capability   | The client asked for a capability the server does not advertise        | This document |
| rate_limited             | The client has exceeded a server-defined rate limit                    | This document |
| internal_error           | The server encountered an unexpected error                             | This document |

--- back

# Acknowledgments
{:numbered="false"}

PortCast builds on a long tradition of attempts to make a listener's
relationship with their podcasts portable. The editors thank
Dave Winer for OPML, which has carried podcast subscriptions across
applications for two decades and which inspired the goal of doing the
same for the rest of a listener's data. The editors also thank the
Podcast Namespace project for `<podcast:guid>`, which makes
cross-application show identity tractable, and the podcast-application
development community for feedback on early drafts.
