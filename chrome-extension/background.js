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

  // Install the MAIN-world fetch hook BEFORE running the ISOLATED
  // fetcher. The hook is idempotent (a window flag short-circuits
  // re-install) so this is safe on every run. We deliberately
  // ignore install failures — extensions running into a page
  // navigation race may transiently fail to inject, and the
  // fetcher will fall through to clearer error messages.
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: installFetchHookInMainWorld,
    });
  } catch (err) {
    console.warn("PortCast: fetch-hook install failed:", err);
  }

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

// ----- MAIN-world fetch hook -----
//
// Runs in the page's own JS world via chrome.scripting.executeScript
// with world: "MAIN". Wraps window.fetch and XMLHttpRequest so that
// every request the Spotify web player makes to *.spotify.com has
// its Authorization and Client-Token headers copied to sessionStorage.
//
// The hook is dormant until the ISOLATED-world fetcher "arms" it by
// writing a flag to sessionStorage. That avoids us hoarding the
// user's access tokens between exports.
//
// MAIN world bypasses Spotify's page CSP for the execution itself,
// which is why we use it here instead of injecting a <script> tag.
function installFetchHookInMainWorld() {
  if (window.__portcastHookInstalled) return;
  window.__portcastHookInstalled = true;

  const ARMED_KEY = "portcast_capture_armed";
  const TOKEN_KEY = "portcast_captured_token";
  const CLIENT_KEY = "portcast_captured_client_token";
  const AT_KEY = "portcast_captured_at";

  function armed() {
    try {
      return sessionStorage.getItem(ARMED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function capture(auth, clientToken) {
    if (!armed()) return;
    try {
      if (auth && typeof auth === "string" && auth.startsWith("Bearer ")) {
        sessionStorage.setItem(TOKEN_KEY, auth.slice(7));
        sessionStorage.setItem(AT_KEY, String(Date.now()));
      }
      if (clientToken && typeof clientToken === "string") {
        sessionStorage.setItem(CLIENT_KEY, clientToken);
      }
    } catch {}
  }

  function isSpotifyUrl(url) {
    return typeof url === "string" && /\bspotify\.com\b/.test(url);
  }

  // Wrap fetch.
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url =
        typeof input === "string" ? input : input && input.url ? input.url : "";
      if (isSpotifyUrl(url)) {
        let h = null;
        if (init && init.headers) {
          h =
            init.headers instanceof Headers
              ? init.headers
              : new Headers(init.headers);
        } else if (
          input &&
          input.headers &&
          typeof input.headers.get === "function"
        ) {
          h = input.headers;
        }
        if (h) capture(h.get("Authorization"), h.get("Client-Token"));
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };

  // Wrap XMLHttpRequest. Spotify currently uses fetch for everything
  // we care about, but their bundle has changed before and may again.
  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSetHeader = XHR.prototype.setRequestHeader;
  XHR.prototype.open = function (method, url) {
    this.__portcastUrl = url;
    return origOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    try {
      if (isSpotifyUrl(this.__portcastUrl) && typeof name === "string") {
        const lower = name.toLowerCase();
        if (
          lower === "authorization" &&
          typeof value === "string" &&
          value.startsWith("Bearer ")
        ) {
          capture(value, null);
        } else if (lower === "client-token" && typeof value === "string") {
          capture(null, value);
        }
      }
    } catch {}
    return origSetHeader.apply(this, arguments);
  };
}

// ----- the function that runs inside open.spotify.com -----
//
// chrome.scripting.executeScript serializes this function and runs
// it in the target tab's ISOLATED world. It must be self-contained:
// no imports, no references to outer-scope variables. The return
// value (a structured-cloneable object) ends up in results[0].result.
//
// Token acquisition tries two sources in order:
//   (a) the SSR-embedded session script in the page HTML — the same
//       JSON blob Spotify's own web player reads on bootstrap; no
//       network call, so Spotify's Varnish CDN has nothing to refuse.
//   (b) /get_access_token with App-Platform and Accept-Language
//       headers matching what the web player sends.
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

  function extractTokenFromPageHtml() {
    // The Spotify web player embeds its initial session in one of a
    // small set of inline JSON script tags. Shape has drifted over
    // web-player versions, so we check the known locations and known
    // nesting paths.
    const candidates = [
      document.getElementById("session"),
      document.getElementById("__NEXT_DATA__"),
      ...document.querySelectorAll(
        'script[type="application/json"]',
      ),
    ];
    const paths = [
      (d) => d && d.accessToken,
      (d) => d && d.session && d.session.accessToken,
      (d) => d && d.props && d.props.pageProps && d.props.pageProps.accessToken,
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

  async function fetchTokenFromEndpoint() {
    // Even from the page origin, the bare endpoint is sometimes
    // refused by Varnish. App-Platform and Accept-Language match
    // what the web player sends and seem to be what the CDN
    // signature check looks for. We deliberately do NOT set
    // cache: 'no-store' because that forces a Cache-Control header
    // the CDN treats as bot-like.
    const r = await fetch(
      "https://open.spotify.com/get_access_token?reason=transport&productType=web-player",
      {
        credentials: "include",
        headers: {
          "App-Platform": "WebPlayer",
          "Accept-Language": "en",
        },
      },
    );
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return {
        error: `Token endpoint ${r.status}: ${body.slice(0, 200)}`,
      };
    }
    const d = await r.json();
    if (d && d.isAnonymous === true) return { notSignedIn: true };
    if (d && typeof d.accessToken === "string") return { token: d.accessToken };
    return { error: "Token endpoint returned no accessToken." };
  }

  async function captureFromHook(timeoutMs) {
    // Arm the MAIN-world hook (it's installed and dormant until now).
    try {
      sessionStorage.setItem("portcast_capture_armed", "1");
      sessionStorage.removeItem("portcast_captured_token");
      sessionStorage.removeItem("portcast_captured_client_token");
      sessionStorage.removeItem("portcast_captured_at");
    } catch {}

    const start = Date.now();
    try {
      while (Date.now() - start < timeoutMs) {
        const token = sessionStorage.getItem("portcast_captured_token");
        const at = parseInt(
          sessionStorage.getItem("portcast_captured_at") || "0",
          10,
        );
        const clientToken = sessionStorage.getItem(
          "portcast_captured_client_token",
        );
        if (token && at >= start) {
          return { token, clientToken: clientToken || null };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return null;
    } finally {
      try {
        sessionStorage.removeItem("portcast_capture_armed");
        sessionStorage.removeItem("portcast_captured_token");
        sessionStorage.removeItem("portcast_captured_client_token");
        sessionStorage.removeItem("portcast_captured_at");
      } catch {}
    }
  }

  async function obtainToken() {
    progress("token");

    // (a) Try the page HTML — instant, zero network.
    const fromHtml = extractTokenFromPageHtml();
    if (fromHtml) return { token: fromHtml, source: "page-html" };

    // (b) Try /get_access_token with web-player headers. Gives us
    // the isAnonymous signal if Spotify cooperates; otherwise 403.
    const fromEndpoint = await fetchTokenFromEndpoint().catch((e) => ({
      error: String((e && e.message) || e),
    }));
    if (fromEndpoint.notSignedIn) return fromEndpoint;
    if (fromEndpoint.token) {
      return { token: fromEndpoint.token, source: "endpoint" };
    }

    // (c) Wait for the page's own JS to fire a *.spotify.com request
    // and capture the Authorization (+ Client-Token) headers from it.
    // The MAIN-world hook does the actual capture; we just poll
    // sessionStorage. Default 10s — long enough for the player to
    // poll its own state, short enough that a busted page doesn't
    // hang the UI.
    progress("token-waiting");
    const captured = await captureFromHook(10000);
    if (captured && captured.token) {
      return {
        token: captured.token,
        clientToken: captured.clientToken,
        source: "fetch-hook",
      };
    }

    return {
      error:
        "Could not obtain a Spotify access token. Tried: " +
        "page-HTML extraction (no session block found); " +
        "/get_access_token endpoint (" +
        (fromEndpoint.error || "no token") +
        "); waiting for Spotify's own JS to make an API call (nothing " +
        "in 10 seconds). Reload open.spotify.com, make sure you're " +
        "signed in, and click Export again. If it keeps failing, try " +
        "navigating to Your Library in Spotify just before clicking " +
        "Export — that forces the player to make API calls we can hook.",
    };
  }

  try {
    const tk = await obtainToken();
    if (tk.notSignedIn) return { notSignedIn: true };
    if (tk.error) return { error: tk.error };
    const token = tk.token;
    const headers = {
      Authorization: "Bearer " + token,
      "App-Platform": "WebPlayer",
      "Accept-Language": "en",
    };
    // Client-Token is required by some api.spotify.com endpoints as
    // of mid-2024; we attach it when the hook caught one. Bearer
    // alone works for /me/* in most cases, so this is belt+braces.
    if (tk.clientToken) {
      headers["Client-Token"] = tk.clientToken;
    }

    // Spotify rate-limits in rolling windows and returns the wait
    // time in the Retry-After header. Strategy:
    //   - If the limit clears in ≤30s, wait it out and try once more.
    //     One sleep, one retry; if that still 429s, the limit is real
    //     and we should stop tying up the popup.
    //   - If the first response says >30s, don't bother retrying —
    //     surface the precise wait time so the user knows when to
    //     come back. Spotify's limit extends with every failed
    //     attempt during debugging, and looping on retries makes
    //     things worse.
    function formatDuration(sec) {
      if (sec < 60) return `${sec} seconds`;
      if (sec < 3600) {
        const m = Math.ceil(sec / 60);
        return `about ${m} minute${m === 1 ? "" : "s"}`;
      }
      const h = Math.ceil(sec / 3600);
      return `about ${h} hour${h === 1 ? "" : "s"}`;
    }

    async function spotifyFetch(url) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch(url, { headers });
        if (r.status !== 429) return r;
        let waitSec = parseInt(r.headers.get("Retry-After") || "30", 10);
        if (!Number.isFinite(waitSec) || waitSec < 1) waitSec = 30;
        if (attempt === 0 && waitSec <= 30) {
          progress("rate-limited", waitSec);
          await new Promise((res) => setTimeout(res, waitSec * 1000));
          continue;
        }
        throw new Error(
          `Spotify rate-limited this token (429). Wait ${formatDuration(
            waitSec,
          )} and click Export again. (Each click during debugging extends ` +
            `the limit window; that's why this is sticky right now.)`,
        );
      }
    }

    progress("me");
    const meResp = await spotifyFetch("https://api.spotify.com/v1/me");
    if (!meResp.ok) {
      const body = await meResp.text().catch(() => "");
      return {
        error: `Profile fetch failed: ${meResp.status} ${body.slice(0, 200)}`,
      };
    }
    const me = await meResp.json();

    async function paginate(path, phase) {
      const items = [];
      let next = "https://api.spotify.com/v1" + path + "?limit=50";
      while (next) {
        const r = await spotifyFetch(next);
        if (!r.ok) {
          throw new Error(path + " failed: " + r.status);
        }
        const page = await r.json();
        const got = Array.isArray(page.items) ? page.items : [];
        items.push(...got);
        progress(phase, items.length);
        next = page.next || null;
        // Small courtesy delay between pages. Cheap insurance
        // against re-tripping the rate limit on the next page.
        if (next) await new Promise((res) => setTimeout(res, 250));
      }
      return items;
    }

    const savedShows = await paginate("/me/shows", "shows");
    progress("shows", savedShows.length, true);

    const savedEpisodes = await paginate("/me/episodes", "episodes");
    progress("episodes", savedEpisodes.length, true);

    return { me, savedShows, savedEpisodes, tokenSource: tk.source };
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
  // Diagnostics we've already authored carry specific debugging info
  // — pass them through verbatim instead of replacing with a canned
  // line that hides which fallback failed.
  if (msg.indexOf("Could not obtain a Spotify access token") !== -1) {
    return msg;
  }
  // Bare Varnish block page surfaces from a raw API error, never
  // from our own diagnostic — match the actual HTML signature
  // rather than the bare "403" substring.
  if (/URL Blocked|Error\s+54113/i.test(msg)) {
    return (
      "Spotify's CDN blocked the request. Open https://open.spotify.com " +
      "in a tab, confirm you're signed in, and click Export again."
    );
  }
  if (/timed out waiting for Spotify to load/i.test(msg)) {
    return (
      "Spotify took too long to load. Try opening open.spotify.com " +
      "manually first, then click Export."
    );
  }
  // Messages from spotifyFetch's rate-limit path already carry a
  // precise wait time and user instruction — surface them verbatim.
  if (/Spotify rate-limited this token/i.test(msg)) {
    return msg;
  }
  // Bare 429 from a path that bypassed our retry helper (shouldn't
  // happen, but cover it): give the user actionable language.
  if (/\b429\b/.test(msg) || /rate limit/i.test(msg)) {
    return (
      "Spotify rate-limited the export. Wait a minute or two and " +
      "click Export again — their limit window is short. " +
      msg
    );
  }
  return msg;
}
