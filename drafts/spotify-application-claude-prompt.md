# Prompt for Claude for Chrome — Spotify Extended Quota Mode application

Paste the block below into a new Claude for Chrome conversation **while
you have the Spotify Developer Dashboard open and signed in to the
Premium account that owns the PortCast app** (the one with client ID
`b8bc61bec733482b8f46bd1d67dc23fc`).

The prompt is self-contained — Claude in Chrome cannot see this file
or our other conversations, so every value it needs is inlined below.

---

## The prompt

> You are acting on my behalf to fill out a Spotify Developer
> "Extended Quota Mode" application (also called Production Mode) for
> my app called **PortCast**. The goal is to remove the
> Development-mode 25-user cap so any Spotify listener can use our
> public exporter at https://import.portcast.org.
>
> ### Stop rules — read first, do not skip
>
> 1. **Do not click the final "Submit" button.** Stop on the review
>    page after every field is filled in and show me the full review
>    so I can read it before submitting myself.
> 2. **Do not change anything outside this application.** Do not edit
>    the app's redirect URIs, scopes, name, or any other setting on
>    the dashboard. Only fill in the Extended Quota application form.
> 3. **Do not create a new app.** Use the existing one whose client
>    ID is `b8bc61bec733482b8f46bd1d67dc23fc`. If you cannot find it,
>    stop and tell me what you see.
> 4. If a form field is **unfamiliar** (not covered by the values
>    below) or **requires a binary commitment I haven't authorized**
>    (e.g. "I agree to Spotify branding requirements", legal
>    consents), stop and ask me.
> 5. **Never enter or expose the client secret** anywhere in the
>    form. The application does not ask for it; the form is public to
>    Spotify reviewers.
>
> ### How to get to the form
>
> 1. Go to https://developer.spotify.com/dashboard.
> 2. From the app list, click into the app whose client ID is
>    `b8bc61bec733482b8f46bd1d67dc23fc` (the name is **PortCast** or
>    similar). If multiple apps have similar names, use the one whose
>    redirect URIs list contains
>    `https://import.portcast.org/spotify/callback`.
> 3. Find the entry point for "Extended Quota Mode" / "Request
>    Production" / "Apply for extended access". As of 2026 it is
>    usually a button labelled **"Request extension"** on the app's
>    overview page, or a link inside **Settings → Quota**.
> 4. Start the application.
>
> ### Values to enter
>
> Map these to whatever field labels the form uses. If a field is
> obviously the same thing under a different name, use the value
> below. If a field doesn't appear, skip it — don't invent one.
>
> **App / company info**
>
> - App name: `PortCast`
> - Company / organization name: `Trimplayer`
> - Contact email: `trimplayerapp@gmail.com`
> - Website: `https://portcast.org`
> - Privacy policy URL: `https://portcast.org/privacy.html`
> - Country: (leave whatever is preselected; do not change)
>
> **Commercial questions**
>
> - Is the app commercial? **No**
> - Will the app display third-party ads? **No**
> - Will the app be monetized? **No**
> - Will the app charge users? **No**
>
> **Short app description (one or two sentences):**
>
> > Exports a Spotify listener's followed shows, saved episodes, and
> > resume positions as a PortCast file — a portable, open JSON format
> > for podcast listener data.
>
> **Long app description / "What does your app do?":**
>
> > PortCast is an open protocol for portable podcast listener data —
> > subscriptions, episode state, queue, bookmarks, and preferences —
> > published under CC BY 4.0 at https://portcast.org. The protocol
> > and its reference implementation are MIT-licensed at
> > https://github.com/Trim-Player/PortCast.
> >
> > The Spotify app registered here powers a single web page,
> > https://import.portcast.org, that lets a Spotify listener download
> > their own library as a .portcast.json file. The page exists as a
> > worked, hostable reference exporter so the protocol has a concrete
> > implementation Spotify users can actually try.
> >
> > The flow is user-initiated, one-shot, and stateless: the listener
> > visits the page, clicks "Connect Spotify", completes OAuth, and
> > the server makes a small number of read-only Spotify Web API
> > calls, assembles a PortCast document in memory, and returns it as
> > a file download. The server has no database and stores nothing.
> > The OAuth access token is held only in a short-lived signed cookie
> > that the server destroys as soon as the export response is
> > generated.
>
> **Which Spotify endpoints does the app use?** (paste the full
> answer; if the form has only a free-text "describe API usage" box,
> paste the prose version):
>
> Endpoint usage:
>
> - `GET /v1/me` — read the listener's display name and email to
>   populate the `owner` field of the exported PortCast document so
>   the file is self-identifying on re-import.
> - `GET /v1/me/shows` (paginated) — enumerate followed shows and
>   convert each into a `subscription` entry in the PortCast document,
>   tagged with `platformRefs: ["spotify:show:..."]`.
> - `GET /v1/me/episodes` (paginated) — enumerate saved episodes and
>   convert each into an `episode` entry, tagged with
>   `platformRefs: ["spotify:episode:..."]`.
> - The `resume_point` field returned alongside saved episodes (gated
>   by the `user-read-playback-position` scope) — maps to the
>   `positionSeconds` and `status` fields in the PortCast document so
>   the listener keeps their place.
>
> The app does **not** call any playback-control endpoint, does not
> modify the user's Spotify library, and does not write to the Spotify
> Web API at all.
>
> **Requested scopes (paste if the form asks):**
>
> > user-library-read, user-read-playback-position, user-read-email,
> > user-read-private. No modify or playback scopes.
>
> **How is user data stored, shared, or retained?**
>
> > Stored: nothing. The export server has no database and writes no
> > files. The Spotify response is held in process memory only long
> > enough to assemble the PortCast document, and the resulting JSON
> > is streamed back to the listener as a file download. The OAuth
> > access token is held only in a short-lived (5-minute), HttpOnly,
> > Secure, signed cookie that the server clears the moment the
> > export response is generated.
> >
> > Shared: not shared with any third party. The data is returned
> > directly to the listener who initiated the export. There are no
> > analytics scripts, no third-party tags, and no telemetry on
> > import.portcast.org.
> >
> > Retained: nothing beyond the lifetime of a single HTTP request.
> > Full data-handling description: https://portcast.org/privacy.html.
>
> **Will users see Spotify content visually (album art, etc.) in your
> app?**
>
> > The exported .portcast.json file carries show titles, episode
> > titles, publisher names, and spotify:show: / spotify:episode: URIs
> > in plain text fields, because those are the fields the PortCast
> > protocol defines. The import.portcast.org web page itself does not
> > render any Spotify catalog content — it shows only an "Export from
> > Spotify" button and the resulting download. There is no Spotify
> > Connect playback, no album-art display, no in-page episode list.
>
> **Will the app be used in countries other than the registered one?**
>
> > Yes — the export is publicly available at https://import.portcast.org,
> > subject to Spotify's own geographic availability. The service is
> > hosted on AWS in the United States.
>
> **Expected user base / why are you requesting extended quota?**
>
> > Initial use is expected to be in the low hundreds of users per
> > month as the PortCast protocol gains visibility through its IETF
> > Internet-Draft and through links from podcast app developer
> > communities. We are requesting Extended Quota Mode primarily to
> > remove the 25-user development cap; the workload is bursty (one
> > click, one file, one user) and well under any default rate limit.
>
> **Additional links if the form asks:**
>
> - App URL: https://import.portcast.org
> - Source code: https://github.com/Trim-Player/PortCast
> - Internet-Draft: https://datatracker.ietf.org/doc/draft-trimplayer-portcast/
>
> ### If the form asks for screenshots
>
> If the form has a screenshot or attachment upload widget:
>
> 1. Open https://import.portcast.org in a new tab and screenshot the
>    full landing page (the "Connect Spotify" button must be visible).
> 2. Open https://portcast.org/privacy.html in a new tab and
>    screenshot the page (the section listing the OAuth scopes
>    requested should be visible).
> 3. Upload both screenshots to the form.
>
> Do not trigger the actual OAuth flow to capture the consent screen
> — that would require a real Spotify login and a download, neither
> of which is needed for the application.
>
> ### When you're done
>
> Stop at the **final review page** (the screen showing all answers
> before the Submit button). Take a full-page screenshot of the
> review and describe what's on it in plain text. **Do not click
> Submit.** I will read your review, make any edits, and submit
> myself.

---

## Things this prompt deliberately does *not* ask Claude to do

- **Click Submit.** You review and submit yourself.
- **Trigger a real OAuth flow** to capture the consent screen — that
  would create a real grant and download for no reason.
- **Edit anything outside the application form** (redirect URIs,
  scopes, name, etc. — all already correct from earlier setup).
- **Use the client secret.** The form does not ask for it; ever-rule
  for safety.
- **Make legal commitments** ("I agree to design guidelines",
  "I will use the Spotify mark per X") without checking with you.

## If something doesn't match

If a field label in the dashboard form has been renamed since this
prompt was written, just paste the closest-fitting block and tell
Claude to look for "the field that maps to X". The dashboard
restructures the Extended Quota form periodically.
