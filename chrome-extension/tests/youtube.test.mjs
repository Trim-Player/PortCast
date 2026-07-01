// Tests for lib/platforms/youtube.js mappers and buildYouTubeDocument.
// Fixtures mirror the shapes the in-tab fetcher (background.js)
// produces from real InnerTube responses.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildYouTubeDocument,
  subscriptionFromPodcastPlaylist,
  episodeFromVideo,
  PODCASTS_TAB_PARAMS,
  FE_CHANNELS,
  FE_HISTORY,
} from "../lib/platforms/youtube.js";

const CAPTURED_AT = "2026-06-01T08:00:00Z";

function podcasts() {
  return [
    {
      playlistId: "PL_demo_one",
      title: "Demo Pod",
      channelTitle: "Demo Net",
      channelId: "UC_demo_chan",
      imageUrl: "https://yt3.ggpht.com/demo.jpg",
      subscribedAt: null,
    },
    {
      playlistId: "PL_demo_two",
      title: null, // exercise fallback
      channelTitle: null,
      channelId: "UC_other_chan",
      imageUrl: null,
      subscribedAt: null,
    },
  ];
}

function videos() {
  return [
    {
      videoId: "vid_unplayed",
      playlistId: "PL_demo_one",
      title: "Episode 1",
      durationSeconds: 1800,
      publishedAt: "2026-05-20T00:00:00Z",
      resumePositionSeconds: 0,
      fullyPlayed: false,
    },
    {
      videoId: "vid_in_progress",
      playlistId: "PL_demo_one",
      title: "Episode 2",
      durationSeconds: 3000,
      publishedAt: "2026-05-27T00:00:00Z",
      resumePositionSeconds: 1234.5,
      fullyPlayed: false,
    },
    {
      videoId: "vid_completed",
      playlistId: "PL_demo_two",
      title: "Episode A",
      durationSeconds: 600,
      publishedAt: "2026-05-30T00:00:00Z",
      resumePositionSeconds: 600,
      fullyPlayed: true,
    },
    {
      // Detached from its playlist — must be dropped.
      videoId: "vid_orphan",
      playlistId: null,
      title: "Orphan",
      durationSeconds: 60,
    },
  ];
}

function doc() {
  return buildYouTubeDocument({
    identity: { displayName: "Jonathan", email: null, channelId: "UC_me" },
    podcasts: podcasts(),
    videos: videos(),
    capturedAt: CAPTURED_AT,
    generatorVersion: "0.1.0",
  });
}

test("PODCASTS_TAB_PARAMS is the verified-live podcasts-tab token", () => {
  // Channel-agnostic protobuf-encoded literal "podcasts".
  assert.equal(PODCASTS_TAB_PARAMS, "Eghwb2RjYXN0c_IGBQoDugEA");
});

test("public browseIds are exported as expected", () => {
  assert.equal(FE_CHANNELS, "FEchannels");
  assert.equal(FE_HISTORY, "FEhistory");
});

test("subscriptions carry youtube:playlist platformRefs", () => {
  const d = doc();
  const refs = d.subscriptions.map((s) => s.platformRefs);
  assert.deepEqual(refs, [
    ["youtube:playlist:PL_demo_one"],
    ["youtube:playlist:PL_demo_two"],
  ]);
});

test("subscription with null title falls back to placeholder", () => {
  const d = doc();
  assert.equal(d.subscriptions[1].title, "(untitled podcast)");
});

test("in-progress episode keeps positionSeconds", () => {
  const d = doc();
  const ep = d.episodes.find((e) =>
    e.platformRefs.includes("youtube:video:vid_in_progress"),
  );
  assert.equal(ep.status, "in_progress");
  assert.equal(ep.positionSeconds, 1234.5);
  assert.deepEqual(ep.subscriptionRef.platformRefs, [
    "youtube:playlist:PL_demo_one",
  ]);
});

test("completed episode drops positionSeconds", () => {
  const d = doc();
  const ep = d.episodes.find((e) =>
    e.platformRefs.includes("youtube:video:vid_completed"),
  );
  assert.equal(ep.status, "completed");
  assert.equal(ep.positionSeconds, undefined);
});

test("unplayed episode is unplayed and has no positionSeconds", () => {
  const d = doc();
  const ep = d.episodes.find((e) =>
    e.platformRefs.includes("youtube:video:vid_unplayed"),
  );
  assert.equal(ep.status, "unplayed");
  assert.equal(ep.positionSeconds, undefined);
});

test("episode detached from a playlist is skipped", () => {
  const d = doc();
  const refs = d.episodes.flatMap((e) => e.platformRefs);
  assert.ok(!refs.includes("youtube:video:vid_orphan"));
  assert.equal(d.episodes.length, 3);
});

test("episode source is tagged youtube", () => {
  const d = doc();
  for (const e of d.episodes) assert.equal(e.source, "youtube");
});

test("owner is populated from identity", () => {
  const d = doc();
  assert.ok(d.owner);
  assert.equal(d.owner.displayName, "Jonathan");
});

test("empty library still produces a valid document", () => {
  const d = buildYouTubeDocument({
    identity: null,
    podcasts: [],
    videos: [],
    capturedAt: CAPTURED_AT,
  });
  assert.deepEqual(d.subscriptions, []);
  assert.deepEqual(d.episodes, []);
  assert.equal(d.owner, undefined);
  assert.equal(d.portcast, "0.2.0");
  assert.equal(d.completeness.length, 2);
});

test("completeness sections are subscriptions+episodes from youtube", () => {
  const d = doc();
  for (const c of d.completeness) {
    assert.equal(c.source, "youtube");
  }
  const sections = d.completeness.map((c) => c.section).sort();
  assert.deepEqual(sections, ["episodes", "subscriptions"]);
});

test("video with no playlistId produces null episode", () => {
  const result = episodeFromVideo(
    { videoId: "abc", playlistId: null, title: "x" },
    CAPTURED_AT,
  );
  assert.equal(result, null);
});

test("podcast with no playlistId produces null subscription", () => {
  const result = subscriptionFromPodcastPlaylist(
    { playlistId: null, title: "x" },
    CAPTURED_AT,
  );
  assert.equal(result, null);
});
