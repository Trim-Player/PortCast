// Service worker — owns the tab orchestration and the download.
//
// v0.3 — GraphQL (pathfinder) rewrite.
//
// WHY THIS REWRITE:
// The 2026 Spotify web player no longer drives its library from the
// REST endpoints /v1/me/shows and /v1/me/episodes. The web-player
// token is an api-partner token: replaying it against api.spotify.com
// /v1/* yields 401/403 (which the old code mislabeled as a 429 "rate
// limit"). The library is now served by:
//   POST https://api-partner.spotify.com/pathfinder/v2/query
//   operationName: "libraryV3"
//   filter id:     "Podcasts & Shows"
//   pagination:    offset-based (pagingInfo.limit/offset + totalCount)
//   auth:          Authorization: Bearer <token>  AND  Client-Token
//
// Verified live: the persisted-query hash, the filter id, the offset
// pagination, and the item shape (PodcastResponseWrapper) were all
// captured from a real session before writing this.
//
// ARCHITECTURE (unchanged from v0.2):
//   1. lib/spotify-hook.js (MAIN world, document_start) wraps
//      fetch/XHR and writes the Bearer + Client-Token from any
//      authenticated *.spotify.com request into sessionStorage.
//   2. The service worker focuses/creates an open.spotify.com tab and
//      navigates it to the podcast library route, which forces the
//      player to fire a fresh libraryV3 (pathfinder) call — so the
//      hook captures a fresh, api-partner-grade token + client-token.
//   3. chrome.scripting.executeScript runs the ISOLATED-world fetcher,
//      which replays libraryV3 over pathfinder and maps the GraphQL
//      results into the REST-shaped payloads buildDocument() expects.

import { buildSpotifyDocument } from "./lib/platforms/spotify.js";
import {
  buildYouTubeDocument,
  PODCASTS_TAB_PARAMS,
  FE_CHANNELS,
  FE_HISTORY,
} from "./lib/platforms/youtube.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

// The library route that reliably forces a libraryV3 pathfinder call
// during bootstrap. The SPA redirects the *main view* to
// /collection/tracks, but the left "Your Library" sidebar still
// fetches libraryV3 — which is exactly the call we need the hook to
// see. (We previously tried /collection/podcasts/shows: that route
// renders "page not found" and never authenticates.)
const SPOTIFY_TAB_URL = "https://open.spotify.com/collection/podcasts";

// GraphQL constants captured & verified from a live session.
const PATHFINDER_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
const LIBRARY_OP = "libraryV3";
const LIBRARY_HASH =
  "973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3";
const PODCAST_FILTER_ID = "Podcasts & Shows";
const PAGE_LIMIT = 50;

// queryPodcastEpisodes — per-show episodes operation. Verified live
// 2026-06-01 against open.spotify.com/show/{id}. Returns each episode
// with name, duration.totalMilliseconds, releaseDate.isoString, and
// playedState ({playPositionMilliseconds, state in NOT_STARTED|STARTED|
// COMPLETED}). Replaces the prior /me/episodes (saved-only) approach
// which left the export's episodes[] empty.
const EPISODES_OP = "queryPodcastEpisodes";
const EPISODES_HASH =
  "06046f9b939d56c8eb7cdbb687da938de1164c006871aec91dc26e4dc7d8eb08";
// Hard cap per show. A long-running show can have hundreds of
// episodes; 500 is enough to cover Acquired-class shows entirely
// (~200 eps) and keeps export under ~30s for a 5-show library.
const EPISODES_PER_SHOW_CAP = 500;

let currentPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "export") return;
  currentPort = port;

  port.onDisconnect.addListener(() => {
    if (currentPort === port) currentPort = null;
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "start") return;
    const platform = msg.platform || "spotify";
    try {
      if (platform === "spotify") {
        await runSpotifyExport(port);
      } else if (platform === "youtube") {
        await runYouTubeExport(port);
      } else {
        port.postMessage({
          type: "error",
          message: `Unknown platform: ${platform}`,
        });
      }
    } catch (err) {
      port.postMessage({ type: "error", message: humanizeError(err) });
    }
  });
});

// Progress events come from the injected fetcher via
// chrome.runtime.sendMessage and get forwarded to the popup port.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && currentPort) {
    if (msg.type === "spotify-progress" || msg.type === "youtube-progress") {
      currentPort.postMessage({ type: "progress", progress: msg.progress });
    }
  }
});

async function runSpotifyExport(port) {
  port.postMessage({ type: "progress", progress: { phase: "tab" } });
  const { tabId, createdByUs } = await findOrCreateSpotifyTab();

  let payload;
  try {
    // If the tab redirected outside open.spotify.com (e.g. to
    // accounts.spotify.com because the user isn't signed in), we can't
    // run the fetcher there. Route to not-signed-in cleanly.
    const tabNow = await chrome.tabs.get(tabId).catch(() => null);
    const url = tabNow && tabNow.url;
    if (!url || !url.startsWith("https://open.spotify.com/")) {
      port.postMessage({ type: "not-signed-in" });
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: fetchSpotifyLibraryInTab,
    });
    payload = results && results[0] && results[0].result;
  } finally {
    if (createdByUs) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // tab may have been closed by the user mid-run; nothing to do.
      }
    }
  }

  if (!payload) {
    throw new Error("Spotify page returned no response.");
  }
  if (payload.error) {
    throw new Error(payload.error);
  }
  if (payload.notSignedIn) {
    port.postMessage({ type: "not-signed-in" });
    return;
  }

  const doc = buildSpotifyDocument({
    me: payload.me,
    savedShows: payload.savedShows,
    savedEpisodes: payload.savedEpisodes,
    generatorVersion: EXTENSION_VERSION,
  });

  // Attach a non-schema diagnostic block so we can diff what the
  // exporter saw against what the user expected. Stripped on import.
  doc._diagnostic = {
    playedStateCounts: payload.playedStateCounts || {},
    playedStateSamples: payload.playedStateSamples || [],
    perShow: (payload.episodeFetchDiagnostics || []).map((d) => ({
      showId: d.showId,
      pagesFetched: d.pagesFetched,
      episodes: d.episodes,
      lastErr: d.lastErr,
    })),
  };

  // If episodes came back empty despite having subscribed shows,
  // surface the per-show diagnostics so we can see WHY rather than
  // shipping a silently-empty file like we did pre-fix.
  if (
    (payload.savedShows || []).length > 0 &&
    (payload.savedEpisodes || []).length === 0
  ) {
    const diag = payload.episodeFetchDiagnostics || [];
    const summary = diag
      .map(
        (d) =>
          `show=${d.showId} pages=${d.pagesFetched} eps=${d.episodes}` +
          (d.lastErr ? ` ERR=${d.lastErr.slice(0, 240)}` : ""),
      )
      .join(" | ");
    throw new Error(
      "Spotify export produced 0 episodes for " +
        payload.savedShows.length +
        " shows. Per-show diagnostics: " +
        (summary || "(none)"),
    );
  }

  port.postMessage({ type: "progress", progress: { phase: "download" } });
  const filename = makeFilename(
    (payload.me && payload.me.id) || "",
    "spotify",
  );
  const dataUrl = jsonToDataUrl(doc);
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,
  });

  if (typeof downloadId !== "number") {
    // User cancelled the Save-As dialog. Clean not-done, not an error.
    port.postMessage({ type: "error", message: "Download was cancelled." });
    return;
  }

  port.postMessage({
    type: "done",
    filename,
    summary: {
      userId: (payload.me && payload.me.id) || null,
      displayName: (payload.me && payload.me.display_name) || null,
      subscriptions: doc.subscriptions.length,
      episodes: doc.episodes.length,
    },
  });
}

async function findOrCreateSpotifyTab() {
  // Reuse an existing open.spotify.com tab if there is one; otherwise
  // open one in the background. In BOTH cases we navigate the tab to
  // the library route and wait for load, so the hook is guaranteed to
  // see a fresh libraryV3 (pathfinder) call and capture a fresh
  // token + client-token. (v0.2 reused existing tabs without
  // navigating, so a stale tab sitting on, say, a track page would
  // never re-fire the library call.)
  const tabs = await chrome.tabs.query({ url: "https://open.spotify.com/*" });
  const existing = tabs.find((t) => t && t.id !== undefined);

  if (existing) {
    await chrome.tabs.update(existing.id, { url: SPOTIFY_TAB_URL });
    await waitForTabComplete(existing.id);
    // Give the SPA a beat to fire its bootstrap pathfinder calls after
    // "complete" — the document is ready before XHRs necessarily fire.
    await sleep(1500);
    return { tabId: existing.id, createdByUs: false };
  }

  const tab = await chrome.tabs.create({ url: SPOTIFY_TAB_URL, active: false });
  await waitForTabComplete(tab.id);
  await sleep(1500);
  return { tabId: tab.id, createdByUs: true };
}

// Landing route that reliably forces an authenticated InnerTube /browse
// call during bootstrap so the youtube-hook captures fresh headers
// (Authorization SAPISIDHASH, x-youtube-client-version, x-goog-visitor-id).
// /feed/channels is the user's subscribed-channels list and is the first
// API call the adapter makes anyway.
const YOUTUBE_TAB_URL = "https://www.youtube.com/feed/channels";

async function findOrCreateYouTubeTab() {
  const tabs = await chrome.tabs.query({ url: "https://www.youtube.com/*" });
  const existing = tabs.find((t) => t && t.id !== undefined);
  if (existing) {
    await chrome.tabs.update(existing.id, { url: YOUTUBE_TAB_URL });
    await waitForYouTubeTabComplete(existing.id);
    await sleep(2000);
    return { tabId: existing.id, createdByUs: false };
  }
  const tab = await chrome.tabs.create({
    url: YOUTUBE_TAB_URL,
    active: false,
  });
  await waitForYouTubeTabComplete(tab.id);
  await sleep(2000);
  return { tabId: tab.id, createdByUs: true };
}

function waitForYouTubeTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for YouTube to load."));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runYouTubeExport(port) {
  port.postMessage({ type: "progress", progress: { phase: "tab" } });
  const { tabId, createdByUs } = await findOrCreateYouTubeTab();

  let payload;
  try {
    const tabNow = await chrome.tabs.get(tabId).catch(() => null);
    const url = tabNow && tabNow.url;
    if (!url || !url.startsWith("https://www.youtube.com/")) {
      port.postMessage({ type: "not-signed-in" });
      return;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: fetchYouTubeLibraryInTab,
      args: [PODCASTS_TAB_PARAMS, FE_CHANNELS, FE_HISTORY],
    });
    payload = results && results[0] && results[0].result;
  } finally {
    if (createdByUs) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  }

  if (!payload) {
    throw new Error("YouTube page returned no response.");
  }
  if (payload.error) {
    throw new Error(payload.error);
  }
  if (payload.notSignedIn) {
    port.postMessage({ type: "not-signed-in" });
    return;
  }

  const doc = buildYouTubeDocument({
    identity: payload.identity,
    podcasts: payload.podcasts,
    videos: payload.videos,
    generatorVersion: EXTENSION_VERSION,
  });

  doc._diagnostic = {
    historyDiag: payload.historyDiag || null,
    podcastCount: (payload.podcasts || []).length,
    videoCount: (payload.videos || []).length,
  };

  port.postMessage({ type: "progress", progress: { phase: "download" } });
  const filename = makeFilename(
    (payload.identity && payload.identity.channelId) || "",
    "youtube",
  );
  const dataUrl = jsonToDataUrl(doc);
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,
  });

  if (typeof downloadId !== "number") {
    port.postMessage({ type: "error", message: "Download was cancelled." });
    return;
  }

  port.postMessage({
    type: "done",
    filename,
    summary: {
      userId: (payload.identity && payload.identity.channelId) || null,
      displayName: (payload.identity && payload.identity.displayName) || null,
      subscriptions: doc.subscriptions.length,
      episodes: doc.episodes.length,
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for Spotify to load."));
    }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ----- the function that runs inside open.spotify.com -----
//
// Serialized by chrome.scripting.executeScript and run in the target
// tab's ISOLATED world. Must be self-contained: no imports, no outer
// references. Returns a structure-cloneable object.
async function fetchSpotifyLibraryInTab() {
  // These mirror the module-scope constants; the function is
  // serialized, so it can't see them.
  const PATHFINDER_URL =
    "https://api-partner.spotify.com/pathfinder/v2/query";
  const LIBRARY_OP = "libraryV3";
  const LIBRARY_HASH =
    "973e511ca44261fda7eebac8b653155e7caee3675abb4fb110cc1b8c78b091c3";
  const PODCAST_FILTER_ID = "Podcasts & Shows";
  const PAGE_LIMIT = 50;
  const EPISODES_OP = "queryPodcastEpisodes";
  const EPISODES_HASH =
    "06046f9b939d56c8eb7cdbb687da938de1164c006871aec91dc26e4dc7d8eb08";
  const EPISODES_PER_SHOW_CAP = 500;

  function progress(phase, count, done, extra) {
    try {
      chrome.runtime.sendMessage({
        type: "spotify-progress",
        progress: { phase, count, done, ...(extra || {}) },
      });
    } catch {
      // service worker may be suspended; ignore.
    }
  }

  function readCapturedToken() {
    try {
      const token = sessionStorage.getItem("portcast_captured_token");
      const clientToken = sessionStorage.getItem(
        "portcast_captured_client_token",
      );
      if (token) return { token, clientToken: clientToken || null };
    } catch {}
    return null;
  }

  function clearCapturedState() {
    try {
      sessionStorage.removeItem("portcast_captured_token");
      sessionStorage.removeItem("portcast_captured_client_token");
      sessionStorage.removeItem("portcast_captured_at");
      sessionStorage.removeItem("portcast_captured_bodies");
    } catch {}
  }

  function extractTokenFromPageHtml() {
    const candidates = [
      document.getElementById("session"),
      document.getElementById("__NEXT_DATA__"),
      ...document.querySelectorAll('script[type="application/json"]'),
    ];
    const paths = [
      (d) => d && d.accessToken,
      (d) => d && d.session && d.session.accessToken,
      (d) =>
        d && d.props && d.props.pageProps && d.props.pageProps.accessToken,
      (d) =>
        d &&
        d.props &&
        d.props.pageProps &&
        d.props.pageProps.session &&
        d.props.pageProps.session.accessToken,
    ];
    for (const el of candidates) {
      if (!el || !el.textContent) continue;
      let data;
      try {
        data = JSON.parse(el.textContent);
      } catch {
        continue;
      }
      for (const get of paths) {
        const t = get(data);
        if (typeof t === "string" && t.length > 20) return t;
      }
    }
    return null;
  }

  async function waitForFreshHookCapture(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const at = parseInt(
          sessionStorage.getItem("portcast_captured_at") || "0",
          10,
        );
        if (at >= start) {
          const t = readCapturedToken();
          if (t) return t;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  // The pathfinder/api-partner endpoint requires BOTH the Bearer and
  // the Client-Token. The hook captures both; the page HTML fallback
  // only yields a Bearer (no client-token), which pathfinder rejects —
  // so we strongly prefer the hook capture and only fall back to HTML
  // when there's truly no captured token.
  async function obtainToken() {
    progress("token");

    // (1) Fresh capture from the library bootstrap we just forced by
    //     navigating the tab. Happy path — has client-token too.
    const cached = readCapturedToken();
    if (cached && cached.clientToken) {
      return { ...cached, source: "hook-bootstrap" };
    }

    // (2) Wait briefly for the bootstrap libraryV3 to surface a
    //     capture (covers a slow XHR after "complete").
    progress("token-waiting");
    const fresh = await waitForFreshHookCapture(10000);
    if (fresh && fresh.clientToken) {
      return { ...fresh, source: "fetch-hook-poll" };
    }

    // (3) Last resort: a token without client-token. pathfinder may
    //     reject this, but we surface a precise error if so rather
    //     than failing silently.
    if (cached && cached.token) {
      return { ...cached, source: "hook-no-client-token" };
    }
    const fromHtml = extractTokenFromPageHtml();
    if (fromHtml) {
      return { token: fromHtml, clientToken: null, source: "page-html" };
    }

    return {
      error:
        "Could not obtain a Spotify api-partner token. The library " +
        "page loaded but the hook never captured an authenticated " +
        "pathfinder request (no Bearer + Client-Token pair) during " +
        "bootstrap or in the 10s after. Reload open.spotify.com, " +
        "confirm you're signed in, open Your Library, and click " +
        "Export again.",
    };
  }

  // --- GraphQL helpers ---

  function uriToId(uri) {
    return uri ? String(uri).split(":").pop() : null;
  }

  // Map a libraryV3 PodcastResponseWrapper item into the REST shape
  // that portcast.js's subscriptionFromSavedShow() expects:
  //   { added_at, show: { id, name, publisher (string), images:[{url}] } }
  // NOTE: GraphQL returns publisher as an object {name}; the document
  // builder wants a plain string — so we flatten it here. (Verified
  // live: this flattening is required, not optional.)
  function mapShowItem(it) {
    const wrapper = (it && it.item) || {};
    const d = wrapper.data || {};
    const publisher =
      d.publisher && typeof d.publisher === "object"
        ? d.publisher.name || null
        : d.publisher || null;
    const images = ((d.coverArt && d.coverArt.sources) || []).map((s) => ({
      url: s.url,
      height: s.height,
      width: s.width,
    }));
    return {
      added_at: (it && it.addedAt && it.addedAt.isoString) || null,
      show: {
        id: uriToId(wrapper._uri || d.uri),
        name: d.name || null,
        publisher,
        images,
      },
    };
  }

  try {
    const tk = await obtainToken();
    if (tk.notSignedIn) {
      clearCapturedState();
      return { notSignedIn: true };
    }
    if (tk.error) {
      clearCapturedState();
      return { error: tk.error };
    }

    const baseHeaders = {
      authorization: "Bearer " + tk.token,
      "content-type": "application/json",
      accept: "application/json",
      "app-platform": "WebPlayer",
      "accept-language": "en",
    };
    if (tk.clientToken) baseHeaders["client-token"] = tk.clientToken;

    // pathfinder POST with one retry honoring a real 429 Retry-After.
    // ONLY a genuine HTTP 429 is treated as a rate limit (the old code
    // mislabeled 401/403 as 429 — fixed).
    function formatDuration(sec) {
      if (sec < 60) return `${sec} seconds`;
      if (sec < 3600) {
        const m = Math.ceil(sec / 60);
        return `about ${m} minute${m === 1 ? "" : "s"}`;
      }
      const h = Math.ceil(sec / 3600);
      return `about ${h} hour${h === 1 ? "" : "s"}`;
    }

    async function pathfinder(body) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch(PATHFINDER_URL, {
          method: "POST",
          headers: baseHeaders,
          body: JSON.stringify(body),
        });

        if (r.status === 429) {
          let waitSec = parseInt(r.headers.get("Retry-After") || "30", 10);
          if (!Number.isFinite(waitSec) || waitSec < 1) waitSec = 30;
          if (attempt === 0 && waitSec <= 30) {
            progress("rate-limited", waitSec);
            await new Promise((res) => setTimeout(res, waitSec * 1000));
            continue;
          }
          throw new Error(
            `Spotify rate-limited this request (HTTP 429). ` +
              `Try again in ${formatDuration(waitSec)}.`,
          );
        }

        if (r.status === 401 || r.status === 403) {
          const t = await r.text().catch(() => "");
          throw new Error(
            `Spotify rejected the token (HTTP ${r.status}). This is an ` +
              `authentication/CDN issue, not a rate limit. The captured ` +
              `web-player token may be missing its Client-Token or may ` +
              `have expired. Reload open.spotify.com (signed in) and ` +
              `Export again. ${t.slice(0, 120)}`,
          );
        }

        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(`pathfinder ${r.status}: ${t.slice(0, 160)}`);
        }

        const j = await r.json();
        if (j && j.errors && j.errors.length) {
          throw new Error(
            "pathfinder GraphQL error: " +
              (j.errors[0] && j.errors[0].message
                ? j.errors[0].message
                : JSON.stringify(j.errors[0])),
          );
        }
        return j;
      }
    }

    function libraryBody(offset) {
      return {
        variables: {
          filters: [PODCAST_FILTER_ID],
          order: null,
          textFilter: "",
          features: [
            "LIKED_SONGS",
            "YOUR_EPISODES_V2",
            "PRERELEASES",
            "PRERELEASES_V2",
            "CLIPS",
            "EVENTS",
          ],
          limit: PAGE_LIMIT,
          offset,
          flatten: false,
          expandedFolders: [],
          folderUri: null,
          includeFoldersWhenFlattening: true,
        },
        operationName: LIBRARY_OP,
        extensions: {
          persistedQuery: { version: 1, sha256Hash: LIBRARY_HASH },
        },
      };
    }

    // --- profile (me) ---
    // pathfinder doesn't expose the classic /v1/me profile fields the
    // document's optional owner block uses. owner is optional in
    // portcast.js (ownerFromMe returns null when absent), so we send a
    // minimal me. If you later capture a profile GraphQL op, slot it
    // here. We try the embedded session JSON for a display name first.
    progress("me");
    let me = { id: null, display_name: null, email: null };
    try {
      const sess = document.getElementById("session");
      if (sess && sess.textContent) {
        const s = JSON.parse(sess.textContent);
        const id =
          (s && s.userId) ||
          (s && s.user && s.user.id) ||
          (s && s.session && s.session.userId) ||
          null;
        if (id) me.id = id;
      }
    } catch {}

    // --- saved shows (offset pagination) ---
    progress("shows", 0);
    const savedShows = [];
    let offset = 0;
    let total = Infinity;
    let guard = 0; // hard cap so a misbehaving API can't infinite-loop
    while (offset < total && guard < 200) {
      guard += 1;
      const j = await pathfinder(libraryBody(offset));
      const lib = j && j.data && j.data.me && j.data.me.libraryV3;

      if (!lib || lib.__typename !== "LibraryPage") {
        // e.g. LibraryInvalidFilterIdError → Spotify changed the filter
        // id. Fail loudly with the message so it's diagnosable.
        const m = (lib && lib.message) || JSON.stringify(lib);
        throw new Error("Library query returned: " + m);
      }

      if (typeof lib.totalCount === "number") total = lib.totalCount;
      const items = Array.isArray(lib.items) ? lib.items : [];
      const shows = items.filter(
        (it) => it && it.item && it.item.__typename === "PodcastResponseWrapper",
      );
      for (const it of shows) savedShows.push(mapShowItem(it));

      progress("shows", savedShows.length);

      if (items.length === 0) break;
      offset += PAGE_LIMIT;
      await new Promise((res) => setTimeout(res, 200)); // courtesy delay
    }
    progress("shows", savedShows.length, true);

    // --- episodes per show (queryPodcastEpisodes) ---
    //
    // For each subscribed show, fetch its episodes — Spotify exposes
    // playedState per episode (NOT_STARTED / STARTED / COMPLETED +
    // playPositionMilliseconds) only through this operation, so this
    // is also our resume-position source. We rewrite the GraphQL
    // shape to the REST shape episodeFromSavedEpisode() expects:
    //   { added_at, episode: { id, name, duration_ms, release_date,
    //       release_date_precision, resume_point:{fully_played,
    //       resume_position_ms}, show:{id} } }
    // Verified live 2026-06-01 against /show/{id}.
    function episodesBody(showUri, offset) {
      return {
        variables: {
          uri: showUri,
          offset,
          limit: PAGE_LIMIT,
          includeEpisodeContentRatingsV2: false,
        },
        operationName: EPISODES_OP,
        extensions: {
          persistedQuery: { version: 1, sha256Hash: EPISODES_HASH },
        },
      };
    }

    function mapEpisodeItem(it, showId) {
      const e = (it && it.entity && it.entity.data) || {};
      const uri = e.uri || (it.entity && it.entity._uri) || null;
      const epId = uri ? String(uri).split(":").pop() : e.id || null;
      if (!epId) return null;

      const durationMs =
        (e.duration && e.duration.totalMilliseconds) || null;
      // releaseDate.isoString is full ISO; take the date portion so
      // normalizeReleaseDate's "day"-precision path handles it.
      // Precision values seen live: MINUTE / HOUR / DAY. All reduce
      // to "day" since the schema's coarsest meaningful unit here is
      // start-of-day UTC.
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

    progress("episodes", 0);
    const savedEpisodes = [];
    const episodeFetchDiagnostics = [];
    // Aggregate playedState counts across all episodes seen in the
    // raw response (BEFORE our mapper transforms it). This is the
    // data we need to debug "no in-progress episodes appear" — if
    // STARTED never shows up here, the API isn't returning it for
    // this user's account/token.
    const stateCounts = {};
    const playedSamples = []; // first 3 with state != NOT_STARTED
    for (let s = 0; s < savedShows.length; s++) {
      const show = savedShows[s];
      const showId = show.show && show.show.id;
      if (!showId) {
        episodeFetchDiagnostics.push({ showIdx: s, reason: "no showId" });
        continue;
      }
      const showUri = `spotify:show:${showId}`;
      let eOffset = 0;
      let eGuard = 0;
      let pagesFetched = 0;
      let episodesFromThisShow = 0;
      let lastErr = null;
      while (eOffset < EPISODES_PER_SHOW_CAP && eGuard < 20) {
        eGuard += 1;
        let j;
        try {
          j = await pathfinder(episodesBody(showUri, eOffset));
        } catch (err) {
          lastErr = String((err && err.message) || err);
          break;
        }
        const items =
          (j && j.data && j.data.podcastUnionV2 &&
            j.data.podcastUnionV2.episodesV2 &&
            j.data.podcastUnionV2.episodesV2.items) ||
          [];
        if (items.length === 0) {
          if (pagesFetched === 0) {
            lastErr =
              "empty items[] at offset 0; data keys = " +
              JSON.stringify(Object.keys((j && j.data) || {})) +
              "; raw = " + JSON.stringify(j).slice(0, 200);
          }
          break;
        }
        pagesFetched += 1;
        for (const it of items) {
          const ps = it && it.entity && it.entity.data &&
            it.entity.data.playedState;
          const stateKey = (ps && ps.state) || "MISSING";
          stateCounts[stateKey] = (stateCounts[stateKey] || 0) + 1;
          // Keep up to 3 samples that aren't NOT_STARTED so we can
          // see the shape of in-progress / completed data.
          if (stateKey !== "NOT_STARTED" && playedSamples.length < 3) {
            playedSamples.push({
              uri:
                (it.entity && (it.entity._uri || it.entity.data.uri)) || null,
              name:
                (it.entity && it.entity.data && it.entity.data.name) ||
                null,
              playedState: ps,
            });
          }
          // queryPodcastEpisodes returns the show's whole back catalogue.
          // Only episodes the user actually engaged with carry a resume
          // position or completion to migrate; NOT_STARTED/MISSING ones
          // would just bloat the document and the import's title-match pass.
          // (Counts above still cover every state for diagnostics.)
          if (stateKey !== "STARTED" && stateKey !== "COMPLETED") {
            continue;
          }
          const mapped = mapEpisodeItem(it, showId);
          if (mapped) {
            savedEpisodes.push(mapped);
            episodesFromThisShow += 1;
          }
        }
        progress("episodes", savedEpisodes.length, false, {
          showIdx: s + 1,
          showCount: savedShows.length,
        });
        if (items.length < PAGE_LIMIT) break;
        eOffset += PAGE_LIMIT;
        await new Promise((res) => setTimeout(res, 200));
      }
      episodeFetchDiagnostics.push({
        showId,
        pagesFetched,
        episodes: episodesFromThisShow,
        lastErr,
      });
    }
    progress("episodes", savedEpisodes.length, true);

    clearCapturedState();
    return {
      me,
      savedShows,
      savedEpisodes,
      tokenSource: tk.source,
      episodeFetchDiagnostics,
      playedStateCounts: stateCounts,
      playedStateSamples: playedSamples,
    };
  } catch (err) {
    clearCapturedState();
    return { error: String((err && err.message) || err) };
  }
}

// ----- the function that runs inside www.youtube.com -----
//
// Serialized by chrome.scripting.executeScript and run in the target
// tab's ISOLATED world. Self-contained: no imports, no outer refs.
// `podcastsTabParams`, `feChannelsId`, `feHistoryId` are passed as args
// since the function can't see module-scope constants.
//
// Strategy:
//   1. Read captured auth from sessionStorage (the youtube-hook content
//      script populates it during page bootstrap).
//   2. POST /youtubei/v1/browse with browseId=FEchannels to list every
//      channel the user is subscribed to. Paginate via continuation.
//   3. For each channel, POST browse with browseId=<channelId> and
//      params=<podcastsTabParams> ("podcasts" tab). Each lockupViewModel
//      with contentType=LOCKUP_CONTENT_TYPE_PODCAST is a podcast
//      playlist the user follows.
//   4. For each podcast playlist, POST browse with browseId=VL<plid>
//      to enumerate the episodes (videos).
//   5. POST browse FEhistory and harvest resume positions per videoId
//      from thumbnailOverlayResumePlaybackRenderer (and fully-played
//      hints). Pages capped at HISTORY_PAGE_CAP to avoid pulling the
//      user's entire YouTube history.
//   6. Return { identity, podcasts: [...shaped...], videos: [...shaped...] }.
async function fetchYouTubeLibraryInTab(
  podcastsTabParams,
  feChannelsId,
  feHistoryId,
) {
  const AUTH_KEY = "portcast_yt_authorization";
  const VISITOR_KEY = "portcast_yt_visitor_id";
  const CLIENT_NAME_KEY = "portcast_yt_client_name";
  const CLIENT_VERSION_KEY = "portcast_yt_client_version";
  const AUTHUSER_KEY = "portcast_yt_authuser";
  const AT_KEY = "portcast_yt_captured_at";
  const BODY_CONTEXT_KEY = "portcast_yt_request_context";

  const INTERTUBE_URL = "/youtubei/v1/browse?prettyPrint=false";
  const HISTORY_PAGE_CAP = 6; // ~6 * 30 ≈ 180 most recent history items
  const CHANNEL_CONCURRENCY = 1; // sequential — YouTube rate-limits hard
  const COURTESY_DELAY_MS = 250;

  function progress(phase, count, done, extra) {
    try {
      chrome.runtime.sendMessage({
        type: "youtube-progress",
        progress: { phase, count, done, ...(extra || {}) },
      });
    } catch {}
  }

  function readCapturedAuth() {
    try {
      const auth = sessionStorage.getItem(AUTH_KEY);
      if (!auth) return null;
      return {
        authorization: auth,
        visitorId: sessionStorage.getItem(VISITOR_KEY) || null,
        clientName: sessionStorage.getItem(CLIENT_NAME_KEY) || "1",
        clientVersion:
          sessionStorage.getItem(CLIENT_VERSION_KEY) || null,
        authUser: sessionStorage.getItem(AUTHUSER_KEY) || "0",
        contextStr: sessionStorage.getItem(BODY_CONTEXT_KEY) || null,
      };
    } catch {
      return null;
    }
  }

  function clearCapturedState() {
    try {
      sessionStorage.removeItem(AUTH_KEY);
      sessionStorage.removeItem(VISITOR_KEY);
      sessionStorage.removeItem(CLIENT_NAME_KEY);
      sessionStorage.removeItem(CLIENT_VERSION_KEY);
      sessionStorage.removeItem(AUTHUSER_KEY);
      sessionStorage.removeItem(AT_KEY);
      sessionStorage.removeItem(BODY_CONTEXT_KEY);
    } catch {}
  }

  async function waitForFreshAuthCapture(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const at = parseInt(
          sessionStorage.getItem(AT_KEY) || "0",
          10,
        );
        if (at >= start) {
          const t = readCapturedAuth();
          if (t) return t;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  async function obtainAuth() {
    progress("token");
    const cached = readCapturedAuth();
    if (cached && cached.clientVersion) return cached;

    progress("token-waiting");
    const fresh = await waitForFreshAuthCapture(10000);
    if (fresh) return fresh;

    if (cached) return cached; // last-resort, no clientVersion

    return null;
  }

  function buildContext(auth) {
    // Prefer the page's own context (captured from a real outgoing
    // body); the client/user/request subkeys carry validation values
    // (clientFormFactor, screenWidthPoints, etc.) we can't easily
    // guess. Fall back to a minimal context if we never saw one.
    if (auth.contextStr) {
      try {
        return JSON.parse(auth.contextStr);
      } catch {}
    }
    return {
      client: {
        clientName: "WEB",
        clientVersion: auth.clientVersion || "2.20260529.01.00",
        visitorData: auth.visitorId || undefined,
        platform: "DESKTOP",
        hl: "en",
        gl: "US",
      },
      user: { lockedSafetyMode: false },
      request: { useSsl: true },
    };
  }

  function formatDuration(sec) {
    if (sec < 60) return `${sec} seconds`;
    if (sec < 3600) {
      const m = Math.ceil(sec / 60);
      return `about ${m} minute${m === 1 ? "" : "s"}`;
    }
    const h = Math.ceil(sec / 3600);
    return `about ${h} hour${h === 1 ? "" : "s"}`;
  }

  async function innertubeBrowse(auth, body) {
    const headers = {
      "Content-Type": "application/json",
      Authorization: auth.authorization,
      "X-Goog-AuthUser": auth.authUser || "0",
      "X-Origin": "https://www.youtube.com",
      "X-Youtube-Client-Name": auth.clientName || "1",
      "X-Youtube-Client-Version":
        auth.clientVersion || "2.20260529.01.00",
    };
    if (auth.visitorId) headers["X-Goog-Visitor-Id"] = auth.visitorId;

    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(INTERTUBE_URL, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(body),
      });

      if (r.status === 429) {
        let waitSec = parseInt(r.headers.get("Retry-After") || "30", 10);
        if (!Number.isFinite(waitSec) || waitSec < 1) waitSec = 30;
        if (attempt === 0 && waitSec <= 30) {
          progress("rate-limited", waitSec);
          await new Promise((res) => setTimeout(res, waitSec * 1000));
          continue;
        }
        throw new Error(
          `YouTube rate-limited this request (HTTP 429). ` +
            `Try again in ${formatDuration(waitSec)}.`,
        );
      }

      if (r.status === 401 || r.status === 403) {
        const t = await r.text().catch(() => "");
        throw new Error(
          `YouTube rejected the request (HTTP ${r.status}). The ` +
            `captured Authorization header may have expired (SAPISIDHASH ` +
            `has a ~30 min window). Reload www.youtube.com (signed in) ` +
            `and Export again. ${t.slice(0, 120)}`,
        );
      }

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`InnerTube ${r.status}: ${t.slice(0, 200)}`);
      }

      return r.json();
    }
    throw new Error("InnerTube: retry budget exhausted.");
  }

  // ----- deep-walk helpers (response shapes are nested) -----
  function findAll(node, key, depth, results, max) {
    depth = depth || 0;
    results = results || [];
    max = max || 1000;
    if (depth > 18 || !node || results.length >= max) return results;
    if (typeof node === "object" && !Array.isArray(node)) {
      if (key in node) results.push(node[key]);
      for (const k of Object.keys(node))
        findAll(node[k], key, depth + 1, results, max);
    } else if (Array.isArray(node)) {
      for (const it of node) findAll(it, key, depth + 1, results, max);
    }
    return results;
  }

  // ----- step 1: subscribed channels (FEchannels) -----
  async function fetchSubscribedChannels(auth) {
    const channels = [];
    const seen = new Set();
    let continuation = null;
    let guard = 0;

    do {
      const body = continuation
        ? { context: buildContext(auth), continuation }
        : { context: buildContext(auth), browseId: feChannelsId };
      const j = await innertubeBrowse(auth, body);

      // channelRenderer is the canonical shape on this page.
      const renderers = findAll(j, "channelRenderer");
      for (const r of renderers) {
        const id = r.channelId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const title =
          (r.title && (r.title.simpleText ||
            (r.title.runs || [])
              .map((x) => x.text)
              .join(""))) ||
          null;
        const thumb =
          r.thumbnail &&
          r.thumbnail.thumbnails &&
          r.thumbnail.thumbnails[r.thumbnail.thumbnails.length - 1] &&
          r.thumbnail.thumbnails[r.thumbnail.thumbnails.length - 1].url;
        channels.push({ channelId: id, title, imageUrl: thumb || null });
      }

      // Continuation tokens for the SECOND+ page.
      const conts = findAll(j, "continuationCommand");
      continuation = (conts[0] && conts[0].token) || null;
      progress("channels", channels.length);
      guard += 1;
      if (guard > 80) break; // hard cap: 80 pages * 30 ≈ 2400 channels
      await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    } while (continuation);

    progress("channels", channels.length, true);
    return channels;
  }

  // ----- step 2: podcast playlists per channel -----
  async function fetchPodcastPlaylists(auth, channel) {
    const body = {
      context: buildContext(auth),
      browseId: channel.channelId,
      params: podcastsTabParams,
    };
    const j = await innertubeBrowse(auth, body);

    // If the channel has no Podcasts tab, the response either errors
    // out cleanly or returns an empty content section. Either way:
    // lockupViewModel items keyed by contentType=PODCAST is the marker.
    const lockups = findAll(j, "lockupViewModel");
    const out = [];
    for (const lv of lockups) {
      if (lv.contentType !== "LOCKUP_CONTENT_TYPE_PODCAST") continue;
      const playlistId = lv.contentId;
      if (!playlistId) continue;
      const title =
        (lv.metadata &&
          lv.metadata.lockupMetadataViewModel &&
          lv.metadata.lockupMetadataViewModel.title &&
          lv.metadata.lockupMetadataViewModel.title.content) ||
        null;
      const sources =
        (lv.contentImage &&
          lv.contentImage.collectionThumbnailViewModel &&
          lv.contentImage.collectionThumbnailViewModel.primaryThumbnail &&
          lv.contentImage.collectionThumbnailViewModel.primaryThumbnail
            .thumbnailViewModel &&
          lv.contentImage.collectionThumbnailViewModel.primaryThumbnail
            .thumbnailViewModel.image &&
          lv.contentImage.collectionThumbnailViewModel.primaryThumbnail
            .thumbnailViewModel.image.sources) ||
        [];
      const imageUrl = (sources[sources.length - 1] || {}).url || null;
      out.push({
        playlistId,
        title,
        channelTitle: channel.title,
        channelId: channel.channelId,
        imageUrl,
        // YouTube doesn't expose per-podcast subscribe date; inherit
        // from when the user follows the channel. Currently null —
        // FEchannels doesn't return a subscribed_at either.
        subscribedAt: null,
      });
    }
    return out;
  }

  // ----- step 3: episodes per podcast playlist -----
  async function fetchPlaylistVideos(auth, playlist) {
    const out = [];
    let continuation = null;
    let guard = 0;
    do {
      const body = continuation
        ? { context: buildContext(auth), continuation }
        : {
            context: buildContext(auth),
            browseId: "VL" + playlist.playlistId,
          };
      const j = await innertubeBrowse(auth, body);
      const videos = findAll(j, "playlistVideoRenderer");
      for (const v of videos) {
        if (!v.videoId) continue;
        const title =
          (v.title &&
            (v.title.simpleText ||
              (v.title.runs || []).map((x) => x.text).join(""))) ||
          null;
        const durationSeconds = v.lengthSeconds
          ? Number(v.lengthSeconds)
          : null;
        out.push({
          videoId: v.videoId,
          playlistId: playlist.playlistId,
          title,
          durationSeconds,
          publishedAt: null,
          resumePositionSeconds: 0,
          fullyPlayed: false,
        });
      }
      const conts = findAll(j, "continuationCommand");
      continuation = (conts[0] && conts[0].token) || null;
      guard += 1;
      if (guard > 40) break; // 40 pages * 100 = 4000 videos / playlist cap
      await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    } while (continuation);
    return out;
  }

  // ----- step 4: watch history → resume positions -----
  async function fetchWatchHistoryResume(auth, neededVideoIds, diag) {
    const resume = new Map();
    let continuation = null;
    let pages = 0;

    while (pages < HISTORY_PAGE_CAP) {
      const body = continuation
        ? { context: buildContext(auth), continuation }
        : { context: buildContext(auth), browseId: feHistoryId };
      let j;
      try {
        j = await innertubeBrowse(auth, body);
      } catch (e) {
        diag.fetchError = String(e.message || e);
        progress("history-error", 0, true, { message: diag.fetchError });
        break;
      }

      // YouTube's 2026 FEhistory schema stores watched-video state in
      // watchEndpoint nodes (verified live 2026-06-02 against this
      // user's account):
      //
      //   { videoId: "abc", startTimeSeconds: 1234, params: "..." }
      //     -> presence of startTimeSeconds > 0 means "resume from here"
      //
      //   { videoId: "abc" }   (no startTimeSeconds, no params)
      //     -> presence in history page means "watched (probably
      //        completed)"; YouTube clears the resume position once
      //        the video reaches the end.
      //
      // The old shape (thumbnailOverlayResumePlaybackRenderer with
      // percentDurationWatched) is now only used in the sidebar
      // "watched videos" recommendation rail, not the main history.
      //
      // Walker strategy: find every node with a string videoId.
      //   - If it has a numeric startTimeSeconds > 0: in_progress
      //     at that position.
      //   - If our wanted set contains it (it's a podcast episode
      //     we're tracking) and it appears anywhere in this history
      //     response: treat as watched (completed) unless an
      //     in-progress entry overrides it.
      // Dedup per videoId — prefer in_progress over completed if
      // both signals show up for the same id.
      const allVideoIds = new Set();
      const watchedVideoIds = new Set(); // wanted ids seen in history
      let watchEndpointsWithStart = 0;
      (function walk(node, depth) {
        if (depth > 22 || !node) return;
        if (typeof node === "object" && !Array.isArray(node)) {
          if (typeof node.videoId === "string") {
            allVideoIds.add(node.videoId);
            const isWanted = neededVideoIds.has(node.videoId);
            const sts = node.startTimeSeconds;
            if (typeof sts === "number" && Number.isFinite(sts) && sts > 0) {
              watchEndpointsWithStart += 1;
              if (isWanted) {
                // First in-progress hit wins; ignore later duplicates
                // since YouTube may echo the same watchEndpoint in
                // multiple places (e.g. action menu + main entry).
                if (!resume.has(node.videoId)) {
                  resume.set(node.videoId, {
                    seconds: sts,
                    fullyPlayed: false,
                  });
                }
              }
            }
            if (isWanted) watchedVideoIds.add(node.videoId);
          }
          for (const k of Object.keys(node)) walk(node[k], depth + 1);
        } else if (Array.isArray(node)) {
          for (const it of node) walk(it, depth + 1);
        }
      })(j, 0);

      // Mark watched-but-not-in-progress wanted ids as completed.
      // Only add if we didn't already capture an in_progress signal
      // for this id during this or an earlier page.
      for (const id of watchedVideoIds) {
        if (!resume.has(id)) {
          resume.set(id, { seconds: 0, fullyPlayed: true });
        }
      }

      diag.allUniqueVideoIds = (diag.allUniqueVideoIds || 0) + allVideoIds.size;
      diag.watchEndpointsWithStart =
        (diag.watchEndpointsWithStart || 0) + watchEndpointsWithStart;
      diag.matchedVideoIds += watchedVideoIds.size;
      // (legacy fields kept for backwards comparison)
      diag.totalVideoRenderers = diag.totalVideoRenderers || 0;
      diag.resumeOverlaysFound = diag.resumeOverlaysFound || 0;
      diag.containingRendererKeys = diag.containingRendererKeys || [];
      diag.distinctOverlayShapes = diag.distinctOverlayShapes || [];
      diag.matchedVideoIdsWithoutOverlayCheck =
        (diag.matchedVideoIdsWithoutOverlayCheck || 0) +
        watchedVideoIds.size;

      pages += 1;
      diag.pagesFetched = pages;
      const conts = findAll(j, "continuationCommand");
      continuation = (conts[0] && conts[0].token) || null;
      progress("history", resume.size, false, { page: pages });
      if (!continuation) break;
      await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    }
    progress("history", resume.size, true);
    return resume;
  }

  // ----- main orchestrator -----
  try {
    const auth = await obtainAuth();
    if (!auth) {
      clearCapturedState();
      return {
        error:
          "Could not obtain YouTube auth headers. Reload " +
          "www.youtube.com signed in, open /feed/channels, and " +
          "Export again.",
      };
    }

    // Identity. We don't have a dedicated /me — pull what we can from
    // the page header.
    let identity = { displayName: null, email: null, channelId: null };
    try {
      const av = document.querySelector("ytd-topbar-menu-button-renderer img");
      if (av && av.alt) identity.displayName = av.alt;
    } catch {}

    const channels = await fetchSubscribedChannels(auth);

    // Per channel: fetch its podcast playlists. Sequential to avoid
    // tripping YouTube's rate limit. Errors per-channel are non-fatal.
    progress("podcasts", 0);
    const podcasts = [];
    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i];
      try {
        const pls = await fetchPodcastPlaylists(auth, ch);
        for (const p of pls) podcasts.push(p);
      } catch (e) {
        // Non-fatal: channel may not have a Podcasts tab.
      }
      progress("podcasts", podcasts.length, false, {
        channelIdx: i + 1,
        channels: channels.length,
      });
      await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    }
    progress("podcasts", podcasts.length, true);

    // Episodes per podcast playlist.
    progress("episodes", 0);
    const videos = [];
    for (let i = 0; i < podcasts.length; i++) {
      const p = podcasts[i];
      try {
        const vs = await fetchPlaylistVideos(auth, p);
        for (const v of vs) videos.push(v);
      } catch (e) {
        // Non-fatal: playlist may be private / region-locked.
      }
      progress("episodes", videos.length, false, {
        playlistIdx: i + 1,
        playlists: podcasts.length,
      });
      await new Promise((r) => setTimeout(r, COURTESY_DELAY_MS));
    }
    progress("episodes", videos.length, true);

    // Resume positions from history.
    const wanted = new Set(videos.map((v) => v.videoId));
    const historyDiag = {
      wantedVideoIds: wanted.size,
      pagesFetched: 0,
      totalVideoRenderers: 0,
      allUniqueVideoIds: 0,
      matchedVideoIds: 0,
      matchedVideoIdsWithoutOverlayCheck: 0,
      resumeOverlaysFound: 0,
      distinctOverlayShapes: [],
      containingRendererKeys: [],
      matchedVideoIdPaths: [],
      fetchError: null,
      sampleRendererKeys: null,
      sampleOverlayKeys: null,
      sampleVideoId: null,
      sampleOverlay: null,
    };
    const resume = await fetchWatchHistoryResume(auth, wanted, historyDiag);
    for (const v of videos) {
      const r = resume.get(v.videoId);
      if (!r) continue;
      v.fullyPlayed = r.fullyPlayed;
      if (!r.fullyPlayed && r.seconds > 0) {
        v.resumePositionSeconds = r.seconds;
      }
    }
    historyDiag.resumeMatchesApplied = resume.size;

    clearCapturedState();
    return { identity, podcasts, videos, historyDiag };
  } catch (err) {
    clearCapturedState();
    return { error: String((err && err.message) || err) };
  }
}

// ----- pure helpers -----

function makeFilename(userId, platformId) {
  const date = new Date().toISOString().slice(0, 10);
  const safe = (userId || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  const stem = safe ? `${platformId}-${safe}` : platformId;
  return `${stem}-${date}.portcast.json`;
}

function jsonToDataUrl(obj) {
  const json = JSON.stringify(obj, null, 2);
  return (
    "data:application/vnd.portcast+json;charset=utf-8," +
    encodeURIComponent(json)
  );
}

function humanizeError(err) {
  if (!err) return "Unknown error.";
  const msg = String(err.message || err);

  if (msg.indexOf("Could not obtain YouTube auth headers") !== -1) {
    return msg;
  }
  if (msg.indexOf("YouTube rejected the request") !== -1) {
    return msg;
  }
  if (msg.indexOf("YouTube rate-limited this request") !== -1) {
    return msg;
  }
  if (/timed out waiting for YouTube to load/i.test(msg)) {
    return (
      "YouTube took too long to load. Open www.youtube.com manually " +
      "first (signed in), then click Export."
    );
  }
  if (msg.indexOf("Could not obtain a Spotify api-partner token") !== -1) {
    return msg;
  }
  if (/Spotify rejected the token/i.test(msg)) {
    return msg; // already precise + actionable
  }
  if (/Spotify rate-limited this request/i.test(msg)) {
    return msg; // genuine 429 with real wait time
  }
  if (/Library query returned/i.test(msg)) {
    return (
      "Spotify's library API changed shape (the GraphQL filter id or " +
      "query hash no longer matches). " +
      msg
    );
  }
  if (/URL Blocked|Error\s+54113/i.test(msg)) {
    return (
      "Spotify's CDN blocked the request. Open https://open.spotify.com " +
      "in a tab, confirm you're signed in, and click Export again."
    );
  }
  if (/timed out waiting for Spotify to load/i.test(msg)) {
    return (
      "Spotify took too long to load. Open open.spotify.com manually " +
      "first, then click Export."
    );
  }
  return msg;
}