# PortCast

**An open protocol for portable podcast subscriptions and listening history.**

Created by [Trimplayer](https://trimplayer.com) · Spec at [portcast.org](https://portcast.org). Free for anyone to implement.

---

A listener's relationship with their podcasts — which shows they follow,
where they stopped in the unfinished episode, the clip they bookmarked at
23:04 — currently lives inside whichever app they happen to use. Switch
apps and you start over. OPML rescues your subscriptions, but everything
else is gone.

PortCast is a small JSON protocol that fixes this. One document carries:

- **Subscriptions** — feeds, with tags, identifiers, and follow dates.
- **Episode state** — `unplayed`/`in_progress`/`completed`/`archived`, plus
  `positionSeconds`, play count, ratings, stars, hidden flags.
- **Playback events** — optional event log (play, pause, seek,
  speed_change, complete) so apps can faithfully reconstruct how a
  listener actually consumed an episode.
- **Queue** — ordered "up next."
- **Bookmarks / clips** — time-stamped notes inside episodes.
- **Preferences** — global and per-feed (playback rate, skip intro/outro,
  trim silence, auto-download policy).
- **Extensions** — vendor-namespaced data preserved on round-trip.

## Repository layout

```
PortCast/
├── SPECIFICATION.md                       # The protocol itself
├── schema/portcast.schema.json            # JSON Schema (draft 2020-12)
├── examples/sample-export.portcast.json   # Realistic sample document
├── reference/                             # Python reference impl
│   ├── portcast/                          # Models, validator, OPML bridge, CLI
│   └── tests/                             # 19 tests, all passing
└── server/                                # FastAPI export service (import.portcast.org)
    └── portcast_server/                   # Spotify OAuth → PortCast download
```

## Quickstart

```bash
cd reference
pip install -e ".[dev]"
pytest                                     # run the test suite
portcast inspect ../examples/sample-export.portcast.json
portcast validate ../examples/sample-export.portcast.json
```

Convert an existing OPML to a (minimal, subscription-only) PortCast
document:

```bash
portcast opml-to-portcast my-subscriptions.opml -o my.portcast.json
```

## Why a new protocol?

OPML solves only subscriptions. Apple's, Spotify's, and Pocket Casts' data
exports each ship in a different (and often app-private) shape. The few
attempts at richer interop have been tied to a single host or service.

PortCast aims to be:

- **Vendor-neutral.** No central server, no required account. The user
  owns the file.
- **Identity-correct.** Matches podcasts by `<podcast:guid>` (the podcast
  namespace standard) and falls back to `feedUrl`; matches episodes by
  `<item><guid>` and falls back to `enclosureUrl`. Apps that already index
  by these IDs can implement import in an afternoon.
- **Lossless within scope, extensible outside it.** Anything outside the
  spec lives under a reverse-DNS-keyed `extensions` block that all
  conforming consumers must preserve on round-trip.
- **Tiny.** One JSON file. One schema. Implementable without dependencies
  on any of the existing podcast directories.

## Status

Version **0.1.0**, draft. We expect to iterate on the data model with
input from other podcast app developers before locking 1.0. Open
questions (signed manifests, delta sync, OPML auto-bridging) are listed
in [SPECIFICATION.md §15](SPECIFICATION.md#15-open-questions-for-v03).

### RFC Independent Submission

PortCast is being prepared for publication as an Informational RFC via
the [Independent Submission stream](https://www.rfc-editor.org/authors/rfc-independent-submissions/).
The Internet-Draft source (kramdown-rfc) lives in
[`drafts/draft-trimplayer-portcast-00.md`](drafts/draft-trimplayer-portcast-00.md);
build and submission steps are in
[`drafts/SUBMISSION.md`](drafts/SUBMISSION.md). The GitHub Action in
[`.github/workflows/draft.yml`](.github/workflows/draft.yml) renders
the `.txt` / `.html` / `.xml` on every push.

## Contributing

Issues and PRs welcome. We are particularly interested in:

- Importer/exporter code for other podcast apps (Pocket Casts, Overcast,
  Apple Podcasts, Spotify, AntennaPod, gpodder/Nextcloud).
- Cases where the data model fails to capture something a real listener
  cares about.
- Implementations in languages other than Python.

## License

- **Specification & schemas:** CC BY 4.0.
- **Reference code (`reference/`):** MIT.

See [LICENSE](LICENSE).
