# DISPATCH agenda-slot request

> **To:** dispatch-chairs@ietf.org
> **Cc:** dispatch@ietf.org
> **Subject:** Request for a DISPATCH slot: PortCast (portable podcast listener data)

Dear DISPATCH chairs,

I would like to request a short slot at the next DISPATCH session to
introduce **PortCast**, a JSON-based interchange format for moving a
podcast listener's data — subscriptions, playback positions,
listening history, queue, bookmarks, and per-feed preferences —
between independent podcast applications.

**Why DISPATCH:** PortCast was originally submitted to the
Independent Submission stream as
`draft-trimplayer-portcast-00` on 2026-05-28. The ISE has indicated
that the Independent stream is not currently accepting new
applications, so I am bringing the work to DISPATCH to find an
appropriate home in the IETF stream.

**Scope of the pitch (deliberately narrow):**

- The proposal is the **file format only** — a JSON document and a
  small identity model built on existing RSS and Podcast Namespace
  identifiers, with an "identifier of last resort" for
  platform-exclusive shows (Spotify, etc.) that have no RSS feed.
- I am **not** asking DISPATCH to consider PortCast's optional
  HTTPS sync API in this pitch; that material remains on GitHub for
  later, separate discussion.
- The IANA asks are correspondingly small: a media-type
  registration (`application/vnd.portcast+json`) and a per-document
  format spec. The other IANA items from the original I-D
  (`.well-known/portcast`, OAuth scopes, error-code registry) are
  deferred with the API mode.

**What I am asking from DISPATCH:**

Guidance on disposition: routing to an existing WG (MEDIAMAN comes
to mind for the media type, but I am open to chair judgment), a
re-charter of an existing WG, or a recommendation that this should
not pursue IETF publication and is better as an Independent /
non-IETF document when that path reopens.

**Materials:**

- Internet-Draft (Independent stream, -00):
  <https://datatracker.ietf.org/doc/draft-trimplayer-portcast/>
- Current spec (v0.2, ahead of the I-D): <https://portcast.org/>
- Reference implementation, schema, test suite:
  <https://github.com/Trim-Player/PortCast>

**Implementation status:** Trimplayer (the editor's own podcast
application) has a reference Python implementation and is wiring
native import/export against this spec; we are working with a
second implementer at the time of writing. I would appreciate
guidance on what interop evidence DISPATCH wants to see before a
slot is granted.

I can present in person at an IETF meeting or virtually, whichever
is more useful. A 5-minute pitch should be enough to surface the
disposition question.

Thank you,

Trimplayer Editors
<trimplayerapp@gmail.com>
<https://trimplayer.com/>
<https://portcast.org/>
