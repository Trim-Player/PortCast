# Cover letter to the Independent Submissions Editor

> **To:** rfc-ise@rfc-editor.org
> **Subject:** Independent Submission request: draft-trimplayer-portcast-00 (PortCast)

Dear Independent Submissions Editor,

I would like to request publication of `draft-trimplayer-portcast-00`
as an Informational RFC via the Independent Submission stream.

**Document:** PortCast: A JSON-Based Interchange Format and Sync API
for Portable Podcast Listener Data
**Internet-Draft:** https://datatracker.ietf.org/doc/draft-trimplayer-portcast/
**Posted:** 2026-05-28 (24 pages)
**Plain text:** https://www.ietf.org/archive/id/draft-trimplayer-portcast-00.txt
**HTML:** https://datatracker.ietf.org/doc/html/draft-trimplayer-portcast
**Project home:** https://portcast.org/
**Source repository:** https://github.com/Trim-Player/PortCast
**Authors:** Trimplayer Editors <trimplayerapp@gmail.com>
**Intended stream:** Independent Submission
**Intended status:** Informational

## What the document specifies

PortCast defines an open JSON-based interchange format, and an optional
HTTPS synchronisation API, for moving a podcast listener's data
(subscriptions, listening history, playback position, queue, bookmarks,
and per-feed preferences) between independent podcast applications
without a central service. It builds on identifiers already present in
RSS (item GUID, feed URL) and the Podcast Namespace (`<podcast:guid>`).

## Why it should be an RFC

OPML solved subscription portability for podcasts twenty years ago, but
the rest of a listener's relationship to a podcast (where they stopped,
what they bookmarked, their per-feed preferences) is locked inside
whichever application they currently use. There is no
vendor-independent, archivally citable specification for this. The
podcast-application community has been working around it with per-app
proprietary exports.

Publishing PortCast as an Informational RFC gives the ecosystem a
stable, citable reference that:

- can be implemented by any podcast application without a license
  agreement;
- does not depend on a central registry, hub, or directory;
- can be referenced from other specifications and registries (notably
  the IANA media-type and well-known URI registries this document
  requests).

## IANA considerations

The document requests four IANA actions (see Section 13 of the I-D):

1. Registration of the media type `application/vnd.portcast+json`.
2. Registration of the `.well-known/portcast` URI.
3. Registration of three OAuth 2.0 scopes
   (`portcast.read`, `portcast.write`, `portcast.history`).
4. Creation of a new "PortCast Error Codes" registry under
   Specification Required policy.

We do not believe any of these conflict with existing registrations.

## IPR statement

The authors confirm that, to the best of their knowledge, the IPR rules
of RFC 4846 and RFC 5744 apply to this submission. Unless the authors
state otherwise, permission is granted to produce derivative works for
the purpose of implementing PortCast.

We are not aware of any IPR claims against the technology described in
this document.

## Implementations

- A reference Python implementation (models, validator, OPML bridge,
  CLI) lives in `reference/` of the source repository.
- Trimplayer (the editor's own application) is implementing native
  import and export against this specification.

We welcome ISE review and look forward to your feedback.

Sincerely,

Trimplayer Editors
trimplayerapp@gmail.com
https://trimplayer.com/
https://portcast.org/
