// Regression tests for the YouTube watch-history walker.
//
// YouTube's FEhistory schema changed in 2026: watch state now lives
// in watchEndpoint nodes (videoId + optional startTimeSeconds), NOT
// in thumbnailOverlayResumePlaybackRenderer.percentDurationWatched
// like older docs claim. These tests pin the new shape so the walker
// can't silently regress to looking in the wrong place.
//
// Verified live 2026-06-02 against a real signed-in account's
// FEhistory response: matchedVideoIdPaths showed every matched
// videoId at .innertubeCommand.watchEndpoint with optional
// startTimeSeconds sibling.

import { test } from "node:test";
import assert from "node:assert/strict";

// Mirror of background.js fetchWatchHistoryResume() walker. Keep in
// lock-step with the inline copy or this test asserts a fiction.
function walkHistoryForResume(j, neededVideoIds) {
  const resume = new Map();
  const watchedVideoIds = new Set();
  (function walk(node, depth) {
    if (depth > 22 || !node) return;
    if (typeof node === "object" && !Array.isArray(node)) {
      if (typeof node.videoId === "string") {
        const isWanted = neededVideoIds.has(node.videoId);
        const sts = node.startTimeSeconds;
        if (typeof sts === "number" && Number.isFinite(sts) && sts > 0) {
          if (isWanted && !resume.has(node.videoId)) {
            resume.set(node.videoId, { seconds: sts, fullyPlayed: false });
          }
        }
        if (isWanted) watchedVideoIds.add(node.videoId);
      }
      for (const k of Object.keys(node)) walk(node[k], depth + 1);
    } else if (Array.isArray(node)) {
      for (const it of node) walk(it, depth + 1);
    }
  })(j, 0);
  // Watched-but-no-in-progress entries -> completed.
  for (const id of watchedVideoIds) {
    if (!resume.has(id)) resume.set(id, { seconds: 0, fullyPlayed: true });
  }
  return resume;
}

function watchEndpoint(videoId, opts = {}) {
  const ep = {
    innertubeCommand: {
      watchEndpoint: {
        videoId,
        watchEndpointSupportedOnesieConfig: { foo: "bar" },
      },
    },
  };
  if (opts.startTimeSeconds != null) {
    ep.innertubeCommand.watchEndpoint.startTimeSeconds = opts.startTimeSeconds;
    ep.innertubeCommand.watchEndpoint.params = "CAYQAA";
  }
  return ep;
}

test("watchEndpoint with startTimeSeconds → in_progress at that position", () => {
  const j = { contents: [watchEndpoint("A", { startTimeSeconds: 1234 })] };
  const r = walkHistoryForResume(j, new Set(["A"]));
  assert.deepEqual(r.get("A"), { seconds: 1234, fullyPlayed: false });
});

test("watchEndpoint with no startTimeSeconds → completed", () => {
  const j = { contents: [watchEndpoint("B")] };
  const r = walkHistoryForResume(j, new Set(["B"]));
  assert.deepEqual(r.get("B"), { seconds: 0, fullyPlayed: true });
});

test("in_progress wins when both signals exist for the same videoId", () => {
  // First a completed-style link, then a resume-style link.
  const j = {
    contents: [
      watchEndpoint("C"),
      watchEndpoint("C", { startTimeSeconds: 600 }),
    ],
  };
  const r = walkHistoryForResume(j, new Set(["C"]));
  // The first occurrence (no startTime) added to completed pool,
  // but the second occurrence's in-progress should override.
  // Actually the walker only adds completed if no resume entry
  // already exists. So order matters: if completed runs first,
  // the second in-progress walk would skip ("already has"). Test
  // documents the actual behavior: first occurrence wins.
  //
  // Real responses tend to put the canonical entry first (with
  // startTime if applicable), so this ordering rarely matters.
  // If you change the walker to prefer in_progress regardless,
  // update this assertion.
  // Behavior: first sets completed=true, second tries to add
  // in-progress but resume.has("C") is true (from completed pool
  // population after walk). Wait — completed pool runs AFTER the
  // full walk. So during walk: first node → no resume entry.
  // Second node → sees startTimeSeconds, adds to resume.
  // After walk: watchedVideoIds has C, but resume already has C
  // (in_progress), so skip the completed add.
  // Net: in_progress wins.
  assert.deepEqual(r.get("C"), { seconds: 600, fullyPlayed: false });
});

test("non-wanted videoIds are ignored", () => {
  const j = {
    contents: [
      watchEndpoint("D", { startTimeSeconds: 500 }),
      watchEndpoint("E"),
    ],
  };
  const r = walkHistoryForResume(j, new Set(["X", "Y"]));
  assert.equal(r.size, 0);
});

test("watchEndpoint with startTimeSeconds=0 is treated as completed", () => {
  // Some YouTube clients clear the resume position to 0 on completion;
  // we treat that the same as "no resume" → completed.
  const j = {
    contents: [{ innertubeCommand: { watchEndpoint: { videoId: "F", startTimeSeconds: 0 } } }],
  };
  const r = walkHistoryForResume(j, new Set(["F"]));
  assert.deepEqual(r.get("F"), { seconds: 0, fullyPlayed: true });
});

test("deeply nested watchEndpoints are still found", () => {
  // History responses nest watchEndpoints inside section/list/item
  // renderer layers — proving the walker reaches them.
  let payload = watchEndpoint("G", { startTimeSeconds: 333 });
  for (let i = 0; i < 10; i++) payload = { layer: payload };
  const r = walkHistoryForResume(
    { onResponseReceivedActions: [payload] },
    new Set(["G"]),
  );
  assert.deepEqual(r.get("G"), { seconds: 333, fullyPlayed: false });
});

test("real-shape: 4 wanted videoIds, 2 with startTime, 2 without", () => {
  // Mirror of the actual diagnostic from the user's 2026-06-02 export:
  //   DN1c728V8Hs: has startTimeSeconds → in_progress
  //   fC8jIfzr1LA: no startTimeSeconds → completed
  //   RifqzcOtcbI: has startTimeSeconds → in_progress
  //   h55Ro__2GLg: no startTimeSeconds → completed
  const wanted = new Set(["DN1c728V8Hs", "fC8jIfzr1LA", "RifqzcOtcbI", "h55Ro__2GLg"]);
  const j = {
    contents: [
      watchEndpoint("DN1c728V8Hs", { startTimeSeconds: 1567 }),
      watchEndpoint("fC8jIfzr1LA"),
      watchEndpoint("RifqzcOtcbI", { startTimeSeconds: 2304 }),
      watchEndpoint("h55Ro__2GLg"),
      // Throw in some non-wanted distractors (sidebar recommendations).
      watchEndpoint("unrelated1", { startTimeSeconds: 5000 }),
      watchEndpoint("unrelated2"),
    ],
  };
  const r = walkHistoryForResume(j, wanted);
  assert.equal(r.size, 4);
  assert.deepEqual(r.get("DN1c728V8Hs"), {
    seconds: 1567,
    fullyPlayed: false,
  });
  assert.deepEqual(r.get("fC8jIfzr1LA"), { seconds: 0, fullyPlayed: true });
  assert.deepEqual(r.get("RifqzcOtcbI"), {
    seconds: 2304,
    fullyPlayed: false,
  });
  assert.deepEqual(r.get("h55Ro__2GLg"), { seconds: 0, fullyPlayed: true });
});

test("walker respects depth limit (no infinite-recursion crash)", () => {
  let payload = watchEndpoint("H", { startTimeSeconds: 10 });
  for (let i = 0; i < 30; i++) payload = { wrap: payload };
  const r = walkHistoryForResume(payload, new Set(["H"]));
  assert.equal(r.size, 0); // too deep to find — proves bound
});
