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

import { buildDocument } from "./lib/portcast.js";

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

let currentPort = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "export") return;
  currentPort = port;

  port.onDisconnect.addListener(() => {
    if (currentPort === port) currentPort = null;
  });

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "start") return;
    if (msg.platform && msg.platform !== "spotify") {
      port.postMessage({
        type: "error",
        message: `Unknown platform: ${msg.platform}`,
      });
      return;
    }
    try {
      await runSpotifyExport(port);
    } catch (err) {
      port.postMessage({ type: "error", message: humanizeError(err) });
    }
  });
});

// Progress events come from the injected fetcher via
// chrome.runtime.sendMessage and get forwarded to the popup port.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "spotify-progress" && currentPort) {
    currentPort.postMessage({ type: "progress", progress: msg.progress });
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

  const doc = buildDocument({
    me: payload.me,
    savedShows: payload.savedShows,
    savedEpisodes: payload.savedEpisodes,
    generatorVersion: EXTENSION_VERSION,
  });

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

  function progress(phase, count, done) {
    try {
      chrome.runtime.sendMessage({
        type: "spotify-progress",
        progress: { phase, count, done },
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

    // --- saved episodes ("Your Episodes") ---
    // The modern player serves individually-saved episodes from a
    // separate pathfinder operation that we could NOT verify here
    // because this account has zero saved episodes (the empty "Your
    // Episodes" page fires no content query). Rather than ship a
    // guessed/unverified hash that could 400 the whole export, we
    // return an empty list. Saved shows — the primary payload — are
    // unaffected. episodeFromSavedEpisode() simply produces nothing
    // for an empty list, which is valid.
    //
    // TODO(episodes): capture operationName + sha256Hash + the item
    // shape from an account WITH saved episodes, add a map function
    // that emits the REST shape episodeFromSavedEpisode() expects
    //   { episode: { id, name, duration_ms, release_date,
    //       release_date_precision, resume_point:{fully_played,
    //       resume_position_ms}, show:{id} } }
    // and paginate it the same way as savedShows above.
    progress("episodes", 0);
    const savedEpisodes = [];
    progress("episodes", savedEpisodes.length, true);

    clearCapturedState();
    return { me, savedShows, savedEpisodes, tokenSource: tk.source };
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