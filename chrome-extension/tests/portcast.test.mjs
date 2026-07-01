// Mirror of server/tests/test_exporter.py. Asserts the JS exporter
// produces the same status mapping, release-date widening, and
// completeness assertions as the Python exporter for the same input.

import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeReleaseDate } from "../lib/portcast.js";
import {
  buildSpotifyDocument,
  subscriptionFromSavedShow,
  episodeFromSavedEpisode,
} from "../lib/platforms/spotify.js";

import {
  CAPTURED_AT,
  me,
  savedShows,
  savedEpisodes,
} from "./fixtures.mjs";

function documentFromFixtures() {
  return buildSpotifyDocument({
    me: me(),
    savedShows: savedShows(),
    savedEpisodes: savedEpisodes(),
    capturedAt: CAPTURED_AT,
    generatorVersion: "0.1.0",
  });
}

test("subscriptions carry Spotify platformRefs", () => {
  const doc = documentFromFixtures();
  const refs = doc.subscriptions.map((s) => s.platformRefs);
  assert.deepEqual(refs, [
    ["spotify:show:5CnDmMUG0S5bSSw612fs8C"],
    ["spotify:show:7makk4oTQel546B0PZlDM5"],
  ]);
  for (const s of doc.subscriptions) {
    assert.equal(s.feedUrl, undefined);
    assert.equal(s.podcastGuid, undefined);
  }
});

test("subscription subscribedAt propagates from added_at", () => {
  const doc = documentFromFixtures();
  assert.equal(doc.subscriptions[0].subscribedAt, "2024-06-01T09:14:00Z");
});

test("in-progress episode carries position", () => {
  const doc = documentFromFixtures();
  const ep = doc.episodes.find((e) =>
    e.platformRefs.includes("spotify:episode:ep-in-progress"),
  );
  assert.equal(ep.status, "in_progress");
  assert.ok(Math.abs(ep.positionSeconds - 1245.2) < 1e-6);
  assert.deepEqual(ep.subscriptionRef.platformRefs, [
    "spotify:show:5CnDmMUG0S5bSSw612fs8C",
  ]);
});

test("completed episode drops position", () => {
  const doc = documentFromFixtures();
  const ep = doc.episodes.find((e) =>
    e.platformRefs.includes("spotify:episode:ep-completed"),
  );
  assert.equal(ep.status, "completed");
  assert.equal(ep.positionSeconds, undefined);
});

test("unplayed episode is unplayed", () => {
  const doc = documentFromFixtures();
  const ep = doc.episodes.find((e) =>
    e.platformRefs.includes("spotify:episode:ep-unplayed"),
  );
  assert.equal(ep.status, "unplayed");
  assert.equal(ep.positionSeconds, undefined);
});

test("release_date month precision widens to first of month", () => {
  const doc = documentFromFixtures();
  const ep = doc.episodes.find((e) =>
    e.platformRefs.includes("spotify:episode:ep-unplayed"),
  );
  assert.equal(ep.publishedAt, "2026-05-01T00:00:00Z");
});

test("owner is populated from /me", () => {
  const doc = documentFromFixtures();
  assert.ok(doc.owner);
  assert.equal(doc.owner.displayName, "Jonathan");
  assert.equal(doc.owner.email, "trimplayerapp@gmail.com");
});

test("completeness now reports both sections as full", () => {
  // Switched 2026-06-01 — episodes is now sourced from
  // queryPodcastEpisodes (per-show), so we have every episode of
  // every followed show, not just individually-saved ones.
  const doc = documentFromFixtures();
  const levels = Object.fromEntries(
    doc.completeness.map((c) => [c.section, c.level]),
  );
  assert.deepEqual(levels, {
    subscriptions: "full",
    episodes: "full",
  });
});

test("empty library still produces a valid document", () => {
  const doc = buildSpotifyDocument({
    me: null,
    savedShows: [],
    savedEpisodes: [],
    capturedAt: CAPTURED_AT,
  });
  assert.deepEqual(doc.subscriptions, []);
  assert.deepEqual(doc.episodes, []);
  assert.equal(doc.owner, undefined);
  assert.equal(doc.portcast, "0.2.0");
  assert.equal(doc.completeness.length, 2);
});

test("normalizeReleaseDate handles all three Spotify precisions", () => {
  assert.equal(normalizeReleaseDate("2024", "year"), "2024-01-01T00:00:00Z");
  assert.equal(normalizeReleaseDate("2024-07", "month"), "2024-07-01T00:00:00Z");
  assert.equal(
    normalizeReleaseDate("2024-07-15", "day"),
    "2024-07-15T00:00:00Z",
  );
  assert.equal(normalizeReleaseDate(null, "day"), null);
  assert.equal(normalizeReleaseDate("garbage", "day"), null);
});

test("episode with no Spotify id is skipped", () => {
  // Defensive: an item with a null id is unaddressable on import.
  const result = episodeFromSavedEpisode(
    {
      added_at: "2026-05-20T10:00:00Z",
      episode: {
        id: null,
        name: "ghost",
        show: { id: "abc" },
      },
    },
    CAPTURED_AT,
  );
  assert.equal(result, null);
});

test("subscription with no images falls back to no imageUrl", () => {
  const sub = subscriptionFromSavedShow(savedShows()[1], CAPTURED_AT);
  assert.equal(sub.imageUrl, undefined);
});
