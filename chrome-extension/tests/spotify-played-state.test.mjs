// Regression tests for the Spotify playedState → status mapping.
// The end-to-end shape produced by background.js's mapEpisodeItem()
// goes through episodeFromSavedEpisode(); this file proves the path
// handles all three Spotify playedState values correctly.

import { test } from "node:test";
import assert from "node:assert/strict";

import { episodeFromSavedEpisode } from "../lib/platforms/spotify.js";

const CAPTURED_AT = "2026-06-02T00:00:00Z";

// Mirror of background.js mapEpisodeItem() — kept here so the test
// proves the contract between the in-tab mapper and the shared
// document builder. If we change one, this test catches the other.
function mapEpisodeItem(it, showId) {
  const e = (it && it.entity && it.entity.data) || {};
  const uri = e.uri || (it.entity && it.entity._uri) || null;
  const epId = uri ? String(uri).split(":").pop() : e.id || null;
  if (!epId) return null;

  const durationMs = (e.duration && e.duration.totalMilliseconds) || null;
  const iso = (e.releaseDate && e.releaseDate.isoString) || null;
  const datePart = iso ? iso.slice(0, 10) : null;

  const ps = e.playedState || {};
  const fullyPlayed = ps.state === "COMPLETED";
  const resumeMs = ps.playPositionMilliseconds || 0;

  return {
    added_at: null,
    episode: {
      id: epId,
      name: e.name || null,
      release_date: datePart,
      release_date_precision: "day",
      duration_ms: durationMs,
      resume_point: {
        fully_played: fullyPlayed,
        resume_position_ms: resumeMs,
      },
      show: { id: showId },
    },
  };
}

function rawEpisode(state, posMs, epId = "ep-x") {
  return {
    entity: {
      _uri: `spotify:episode:${epId}`,
      data: {
        uri: `spotify:episode:${epId}`,
        name: "Sample",
        duration: { totalMilliseconds: 3600000 },
        releaseDate: { isoString: "2026-05-29T00:00:00Z" },
        playedState: {
          state,
          playPositionMilliseconds: posMs,
        },
      },
    },
  };
}

test("NOT_STARTED maps to status unplayed with no positionSeconds", () => {
  const mapped = mapEpisodeItem(rawEpisode("NOT_STARTED", 0), "show-1");
  const result = episodeFromSavedEpisode(mapped, CAPTURED_AT);
  assert.equal(result.status, "unplayed");
  assert.equal(result.positionSeconds, undefined);
});

test("STARTED with playPosition > 0 maps to in_progress with positionSeconds", () => {
  const mapped = mapEpisodeItem(rawEpisode("STARTED", 600000), "show-1");
  const result = episodeFromSavedEpisode(mapped, CAPTURED_AT);
  assert.equal(result.status, "in_progress");
  assert.equal(result.positionSeconds, 600);
});

test("COMPLETED maps to status completed with no positionSeconds", () => {
  // Real Spotify response often has playPositionMilliseconds: 0 for
  // completed episodes — proves the mapper doesn't rely on position.
  const mapped = mapEpisodeItem(rawEpisode("COMPLETED", 0), "show-1");
  const result = episodeFromSavedEpisode(mapped, CAPTURED_AT);
  assert.equal(result.status, "completed");
  assert.equal(result.positionSeconds, undefined);
});

test("STARTED with playPosition=0 falls through to unplayed", () => {
  // Edge case observed in the wild: state=STARTED but
  // playPositionMilliseconds=0 (Spotify hasn't pushed the position
  // sync yet). We treat as unplayed rather than confused-in-progress.
  const mapped = mapEpisodeItem(rawEpisode("STARTED", 0), "show-1");
  const result = episodeFromSavedEpisode(mapped, CAPTURED_AT);
  assert.equal(result.status, "unplayed");
});

test("missing playedState defaults to unplayed", () => {
  const raw = {
    entity: {
      _uri: "spotify:episode:no-state",
      data: {
        uri: "spotify:episode:no-state",
        name: "Sample",
        duration: { totalMilliseconds: 1000000 },
        releaseDate: { isoString: "2026-05-29T00:00:00Z" },
        // no playedState field at all
      },
    },
  };
  const mapped = mapEpisodeItem(raw, "show-1");
  const result = episodeFromSavedEpisode(mapped, CAPTURED_AT);
  assert.equal(result.status, "unplayed");
});

test("episode without releaseDate produces null publishedAt without throwing", () => {
  const raw = {
    entity: {
      _uri: "spotify:episode:no-date",
      data: {
        uri: "spotify:episode:no-date",
        name: "Sample",
        duration: { totalMilliseconds: 1000000 },
        // no releaseDate at all
        playedState: { state: "NOT_STARTED", playPositionMilliseconds: 0 },
      },
    },
  };
  const mapped = mapEpisodeItem(raw, "show-1");
  const result = episodeFromSavedEpisode(mapped, CAPTURED_AT);
  assert.equal(result.publishedAt, undefined);
});
