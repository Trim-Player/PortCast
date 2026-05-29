// Tests for lib/platforms/spotify.js — session detection, pagination,
// and the exportToPortCast() orchestrator. Stubs global `fetch` so
// nothing leaves the test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectSession,
  fetchLibrary,
  exportToPortCast,
} from "../lib/platforms/spotify.js";

import {
  me,
  savedShows,
  savedEpisodes,
  CAPTURED_AT,
} from "./fixtures.mjs";

/**
 * Build a fetch stub that responds to URL patterns with prepared
 * payloads, paginating through `items[]` arrays in chunks of `limit`.
 */
function makeFetchStub(handlers) {
  return async function fetchStub(url, init = {}) {
    for (const h of handlers) {
      if (typeof h.match === "string" ? url === h.match : h.match.test(url)) {
        return makeResp(h.respond(url, init));
      }
    }
    throw new Error(`Unhandled fetch URL in test: ${url}`);
  };
}

function makeResp({ status = 200, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
    async json() {
      return typeof body === "string" ? JSON.parse(body) : body;
    },
  };
}

function pagedResponder(items, basePath) {
  return (url) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset") || "0");
    const limit = Number(u.searchParams.get("limit") || "50");
    const slice = items.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const next =
      nextOffset < items.length
        ? `https://api.spotify.com/v1${basePath}?offset=${nextOffset}&limit=${limit}`
        : null;
    return { body: { items: slice, next } };
  };
}

test("detectSession returns token when not anonymous", async () => {
  globalThis.fetch = makeFetchStub([
    {
      match: /get_access_token/,
      respond: () => ({
        body: {
          accessToken: "test-token-abc",
          accessTokenExpirationTimestampMs: 9999999999999,
          isAnonymous: false,
        },
      }),
    },
  ]);
  const session = await detectSession();
  assert.equal(session.token, "test-token-abc");
  assert.equal(session.isAnonymous, false);
});

test("detectSession returns null token when anonymous", async () => {
  globalThis.fetch = makeFetchStub([
    {
      match: /get_access_token/,
      respond: () => ({
        body: { accessToken: "", isAnonymous: true },
      }),
    },
  ]);
  const session = await detectSession();
  assert.equal(session.token, null);
  assert.equal(session.isAnonymous, true);
});

test("detectSession throws typed error on 5xx", async () => {
  globalThis.fetch = makeFetchStub([
    {
      match: /get_access_token/,
      respond: () => ({ status: 503, body: "service unavailable" }),
    },
  ]);
  await assert.rejects(
    () => detectSession(),
    (err) => err.status === 503,
  );
});

test("fetchLibrary paginates shows and episodes and calls /me once", async () => {
  // 60 shows → two pages of 50 + 10, 75 episodes → two pages of 50 + 25.
  const showItems = Array.from({ length: 60 }, (_, i) => ({
    added_at: "2024-01-01T00:00:00Z",
    show: { id: `show-${i}`, name: `Show ${i}`, images: [] },
  }));
  const episodeItems = Array.from({ length: 75 }, (_, i) => ({
    added_at: "2024-01-01T00:00:00Z",
    episode: {
      id: `ep-${i}`,
      name: `Episode ${i}`,
      release_date: "2024-01-01",
      release_date_precision: "day",
      duration_ms: 60000,
      resume_point: { fully_played: false, resume_position_ms: 0 },
      show: { id: `show-${i % 60}` },
    },
  }));

  let meCalls = 0;
  globalThis.fetch = makeFetchStub([
    {
      match: "https://api.spotify.com/v1/me",
      respond: () => {
        meCalls += 1;
        return { body: { id: "user-x", display_name: "User X" } };
      },
    },
    {
      match: /\/me\/shows/,
      respond: pagedResponder(showItems, "/me/shows"),
    },
    {
      match: /\/me\/episodes/,
      respond: pagedResponder(episodeItems, "/me/episodes"),
    },
  ]);

  const events = [];
  const lib = await fetchLibrary("fake-token", (e) => events.push(e));

  assert.equal(meCalls, 1);
  assert.equal(lib.savedShows.length, 60);
  assert.equal(lib.savedEpisodes.length, 75);
  // Final progress event for each phase should carry done:true.
  const finalShows = events.filter(
    (e) => e.phase === "shows" && e.done,
  ).pop();
  assert.equal(finalShows.count, 60);
  const finalEps = events.filter(
    (e) => e.phase === "episodes" && e.done,
  ).pop();
  assert.equal(finalEps.count, 75);
});

test("exportToPortCast returns a complete document and summary", async () => {
  globalThis.fetch = makeFetchStub([
    {
      match: "https://api.spotify.com/v1/me",
      respond: () => ({ body: me() }),
    },
    {
      match: /\/me\/shows/,
      respond: pagedResponder(savedShows(), "/me/shows"),
    },
    {
      match: /\/me\/episodes/,
      respond: pagedResponder(savedEpisodes(), "/me/episodes"),
    },
  ]);

  const { document, summary } = await exportToPortCast({
    token: "fake-token",
    capturedAt: CAPTURED_AT,
    generatorVersion: "0.1.0",
  });

  assert.equal(document.portcast, "0.2.0");
  assert.equal(document.subscriptions.length, 2);
  assert.equal(document.episodes.length, 3);
  assert.equal(summary.userId, "jonathan");
  assert.equal(summary.displayName, "Jonathan");
  assert.equal(summary.subscriptions, 2);
  assert.equal(summary.episodes, 3);
});

test("Bearer header is attached on every API call", async () => {
  const seenAuth = new Set();
  globalThis.fetch = async (url, init = {}) => {
    seenAuth.add(init.headers ? init.headers.Authorization : undefined);
    if (url.endsWith("/me")) {
      return makeResp({ body: { id: "u" } });
    }
    return makeResp({ body: { items: [], next: null } });
  };
  await fetchLibrary("token-xyz");
  assert.deepEqual([...seenAuth], ["Bearer token-xyz"]);
});
