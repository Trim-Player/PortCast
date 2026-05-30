// Service worker — owns the tab injection and the download trigger.
//
// Why this is more complicated than "just fetch from the worker":
// Spotify's Varnish CDN blocks any fetch to /get_access_token whose
// Origin header is chrome-extension://… (returns 403 "URL Blocked",
// error 54113). The browser sets that Origin automatically for
// fetches from the service worker, and there's no way to override
// it from JavaScript. The only reliable workaround is to run the
// fetch from inside an open.spotify.com tab, where the Origin is
// "https://open.spotify.com" — exactly what Spotify's own web
// player code uses.
//
// So the orchestration is:
//   1. Find an existing open.spotify.com tab (or create one in the
//      background and close it when we're done).
//   2. chrome.scripting.executeScript into it with a self-contained
//      fetcher that pulls the token + library and returns the raw
//      payloads.
//   3. Build the PortCast document here in the worker using the
//      shared lib/portcast.js, trigger the download, done.
//
// lib/platforms/spotify.js stays around for parity with the
// Trimplayer mobile WebView path, where the host context IS
// open.spotify.com and the simple fetch model works.

import { buildDocument } from "./lib/portcast.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
const SPOTIFY_TAB_URL = "https://open.spotify.com/";

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

// Progress events come from the injected content script via
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
        // tab may have been closed by the user mid-run; nothing to clean up.
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
    // The user cancelled the Save-As dialog. Treat as a clean
    // not-done, not an error.
    port.postMessage({
      type: "error",
      message: "Download was cancelled.",
    });
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
  const tabs = await chrome.tabs.query({
    url: "https://open.spotify.com/*",
  });
  const existing = tabs.find((t) => t && t.id !== undefined);
  if (existing) {
    if (existing.status !== "complete") {
      await waitForTabComplete(existing.id);
    }
    return { tabId: existing.id, createdByUs: false };
  }
  const tab = await chrome.tabs.create({
    url: SPOTIFY_TAB_URL,
    active: false,
  });
  await waitForTabComplete(tab.id);
  return { tabId: tab.id, createdByUs: true };
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
// chrome.scripting.executeScript serializes this function and runs
// it in the target tab's ISOLATED world. It must be self-contained:
// no imports, no references to outer-scope variables. The return
// value (a structured-cloneable object) ends up in results[0].result.
//
// The fetches succeed where the service worker's would 403 because
// the Origin header is now "https://open.spotify.com" — the page's
// own origin — which Spotify's Varnish allows.
async function fetchSpotifyLibraryInTab() {
  function progress(phase, count, done) {
    try {
      chrome.runtime.sendMessage({
        type: "spotify-progress",
        progress: { phase, count, done },
      });
    } catch {
      // service worker may have been suspended; ignore.
    }
  }

  try {
    progress("token");
    const tokenResp = await fetch(
      "https://open.spotify.com/get_access_token?reason=transport&productType=web-player",
      { credentials: "include", cache: "no-store" },
    );
    if (!tokenResp.ok) {
      const body = await tokenResp.text().catch(() => "");
      return {
        error: `Token endpoint ${tokenResp.status}: ${body.slice(0, 200)}`,
      };
    }
    const tokenData = await tokenResp.json();
    if (
      !tokenData ||
      tokenData.isAnonymous === true ||
      !tokenData.accessToken
    ) {
      return { notSignedIn: true };
    }
    const token = tokenData.accessToken;
    const headers = { Authorization: "Bearer " + token };

    progress("me");
    const meResp = await fetch("https://api.spotify.com/v1/me", { headers });
    if (!meResp.ok) {
      return { error: `Profile fetch failed: ${meResp.status}` };
    }
    const me = await meResp.json();

    async function paginate(path, phase) {
      const items = [];
      let next = "https://api.spotify.com/v1" + path + "?limit=50";
      while (next) {
        const r = await fetch(next, { headers });
        if (!r.ok) {
          throw new Error(path + " failed: " + r.status);
        }
        const page = await r.json();
        const got = Array.isArray(page.items) ? page.items : [];
        items.push(...got);
        progress(phase, items.length);
        next = page.next || null;
      }
      return items;
    }

    const savedShows = await paginate("/me/shows", "shows");
    progress("shows", savedShows.length, true);

    const savedEpisodes = await paginate("/me/episodes", "episodes");
    progress("episodes", savedEpisodes.length, true);

    return { me, savedShows, savedEpisodes };
  } catch (err) {
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
  // Service workers can't use URL.createObjectURL, so we inline the
  // JSON as a data: URL. PortCast files are tens of KB to low MB,
  // well under Chrome's data-URL size limit.
  const json = JSON.stringify(obj, null, 2);
  return (
    "data:application/vnd.portcast+json;charset=utf-8," +
    encodeURIComponent(json)
  );
}

function humanizeError(err) {
  if (!err) return "Unknown error.";
  const msg = String(err.message || err);
  if (/URL Blocked|Error 54113|403/i.test(msg)) {
    return (
      "Spotify's CDN blocked the request. Open https://open.spotify.com " +
      "in a tab, confirm you're signed in, and click Export again."
    );
  }
  if (/timed out/i.test(msg)) {
    return (
      "Spotify took too long to load. Try opening open.spotify.com " +
      "manually first, then click Export."
    );
  }
  return msg;
}
