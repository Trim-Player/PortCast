# Spotify Extended Quota Mode — application copy

Drafted for the Production Mode (Extended Quota Mode) application
submitted from the Spotify Developer Dashboard for the **PortCast**
app. Lifts the Development-mode 25-user cap so any Spotify listener
can use `import.portcast.org`.

Field names below match the dashboard form as of 2026. If Spotify has
renamed a field, the surrounding heading should still make the intent
obvious. Where the form has a hard length limit, the shorter variant
is given second.

---

## Commercial use

**Is your app commercial?**  No.

**Will you display third-party ads?**  No.

**Will you monetize the app?**  No.

---

## App description

**App name:**  PortCast

**App description (short, for app card):**

> Exports a Spotify listener's followed shows, saved episodes, and
> resume positions as a PortCast file — a portable, open JSON format
> for podcast listener data.

**App description (long):**

> PortCast is an open protocol for portable podcast listener data —
> subscriptions, episode state, queue, bookmarks, and preferences —
> published under CC BY 4.0 at <https://portcast.org>. The protocol
> and its reference implementation are MIT-licensed at
> <https://github.com/Trim-Player/PortCast>.
>
> The Spotify app registered here powers a single web page,
> <https://import.portcast.org>, that lets a Spotify listener download
> their own library as a `.portcast.json` file. The page exists as a
> worked, hostable reference exporter so the protocol has a concrete
> implementation Spotify users can actually try.
>
> The flow is user-initiated, one-shot, and stateless: the listener
> visits the page, clicks "Connect Spotify", completes OAuth, and the
> server makes a small number of read-only Spotify Web API calls,
> assembles a PortCast document in memory, and returns it as a file
> download. The server has no database and stores nothing. The OAuth
> access token is held only in a short-lived signed cookie that the
> server destroys as soon as the export response is generated.

---

## Which Spotify Web API endpoints do you use, and why?

We use exactly four read endpoints, all under the user's own scope:

| Endpoint | Why we call it |
|---|---|
| `GET /v1/me` | The listener's `display_name` and `email`, written to the PortCast document's `owner` field so the file is self-identifying when re-imported elsewhere. |
| `GET /v1/me/shows` (paginated) | The listener's followed shows. Each becomes a `subscription` entry in the PortCast document, tagged with `platformRefs: ["spotify:show:..."]` so a downstream app can re-attach them. |
| `GET /v1/me/episodes` (paginated) | The listener's saved episodes. Each becomes an `episode` entry, tagged with `platformRefs: ["spotify:episode:..."]`. |
| `resume_point` field on saved episodes (delivered alongside `/me/episodes`, gated by the `user-read-playback-position` scope) | Maps to the `positionSeconds` and `status` (`unplayed` / `in_progress` / `completed`) fields in the PortCast document, so the listener doesn't lose their place when moving libraries. |

We do **not** call any playback-control endpoints, do not modify the
listener's Spotify library, do not write to the Spotify Web API at
all.

---

## Requested scopes

- `user-library-read` — to enumerate followed shows and saved
  episodes.
- `user-read-playback-position` — so the export carries the
  listener's resume position on each episode (without this scope the
  export would still work but would lose play-state fidelity).
- `user-read-email`, `user-read-private` — to populate the `owner`
  field of the PortCast document with display name and email so the
  file is identifiable on re-import.

No `user-modify-playback-state`, no streaming, no playlist
modification.

---

## How is user data stored and shared?

**Stored:** Nothing. The export server has no database and writes no
files. The Spotify response is held in process memory only long
enough to assemble the PortCast document, and the resulting JSON is
streamed back to the listener as a file download. The OAuth access
token is held only in a short-lived (5-minute), HttpOnly, Secure,
signed cookie that the server clears the moment the export response
is generated.

**Shared:** Not shared with any third party. The data is returned
directly to the listener who initiated the export. There are no
analytics scripts, no third-party tags, and no telemetry on
`import.portcast.org`.

**Retained:** Nothing beyond the lifetime of a single HTTP request.

Full data-handling description is published at
<https://portcast.org/privacy.html>.

---

## Will users see Spotify content (album art, track names, etc.)?

The exported `.portcast.json` file carries show titles, episode
titles, publisher names, and `spotify:show:`/`spotify:episode:` URIs
in plain text fields, because those are the fields the PortCast
protocol defines. The `import.portcast.org` web page itself does not
render any Spotify catalog content — it shows only an "Export from
Spotify" call to action and the resulting download. There is no
Spotify Connect playback, no album-art display, no in-page episode
list.

If Spotify requires attribution on the page itself, we are happy to
add a "Powered by Spotify Web API" line and Spotify-branded button
per the
<https://developer.spotify.com/documentation/design> guidelines.

---

## Will the app be used outside the country listed?

Yes — the export is available to any Spotify listener via the public
URL <https://import.portcast.org>, subject to Spotify's own
geographic availability. The service itself is hosted on Amazon Web
Services in the United States.

---

## Expected user base / quota request

Initial use is expected to be in the low hundreds of users per month,
as the PortCast protocol gains visibility through its Internet-Draft
in the IETF Independent Submission process and through links from
podcast app developer communities. We are requesting Extended Quota
Mode primarily to remove the 25-user development cap, not for high
QPS — the workload is bursty (a listener clicks once, gets one file,
goes away), well under any default rate limit.

---

## Links

- App URL: <https://import.portcast.org>
- Website (protocol spec): <https://portcast.org>
- Privacy policy: <https://portcast.org/privacy.html>
- Source code: <https://github.com/Trim-Player/PortCast>
- Internet-Draft: <https://datatracker.ietf.org/doc/draft-trimplayer-portcast/>
- Contact: <trimplayerapp@gmail.com>

---

## Screenshots / video to attach

The form usually accepts screenshots. Capture at least:

1. The `import.portcast.org` landing page (the "Connect Spotify"
   button, the "we don't store your data" disclaimer, the privacy
   policy link).
2. The Spotify OAuth consent screen showing the requested scopes.
3. The post-callback file download — browser download bar showing the
   `.portcast.json` filename.
4. The privacy policy page at `portcast.org/privacy.html` (long
   scroll; one screenshot showing the OAuth scopes section is
   enough).

A 30-second screen recording of the whole flow (land → connect →
authorize → download) is even better and tends to short-circuit a lot
of reviewer back-and-forth.

---

## What to double-check before submitting

- The Spotify app you submit from is the one owned by your **Premium**
  Spotify account (the one currently set up at
  `import.portcast.org` — client ID
  `b8bc61bec733482b8f46bd1d67dc23fc`). Submitting from a free
  account's app will be rejected on the same grounds the original 403
  was returned.
- Redirect URI on that app must already include
  `https://import.portcast.org/spotify/callback` exactly (it does).
- The privacy policy URL must be reachable before you submit — Pages
  caches for ~10 min after a push, so verify
  `https://portcast.org/privacy.html` returns 200 in an incognito
  browser before clicking submit.
- "Company name" field: use whichever name you want printed on the
  consent screen. If you have a registered legal entity, this is the
  place to use it.
