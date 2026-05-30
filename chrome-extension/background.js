// Service worker — owns the tab orchestration and the download.
//
// Architecture (revised after the v0.1 token-acquisition pain):
//
//   1. lib/spotify-hook.js is registered in manifest.json as a
//      MAIN-world content script that runs at document_start on
//      every open.spotify.com page. It wraps window.fetch / XHR
//      and writes the Authorization (Bearer) + Client-Token from
//      any authenticated *.spotify.com request into sessionStorage.
//      It ALSO clones response bodies for /v1/me, /v1/me/shows,
//      /v1/me/episodes into sessionStorage so we can reuse them.
//
//   2. The service worker opens (or focuses) a tab at
//      open.spotify.com/collection/podcasts/shows — the library
//      URL — which guarantees the player authenticates and fires
//      a real /v1/me/shows request during bootstrap. By the time
//      the page is "complete", the hook has captured a fresh,
//      web-player-grade token AND the first page of the library.
//
//   3. chrome.scripting.executeScript runs a self-contained
//      ISOLATED-world fetcher in that tab. The fetcher prefers
//      the captured token + captured bodies. If no captured token
//      exists, it falls back to extracting one from the page HTML,
//      then to /get_access_token, then to polling sessionStorage
//      for the next captured one.
//
// Why this design beats the v0.1 dynamic-injection approach:
//   - The hook is in place BEFORE the page makes its first fetch,
//     so we never miss bootstrap calls.
//   - We never call /get_access_token unless every other path
//     fails — sidestepping the Varnish CDN's 403 entirely.
//   - We never re-fetch /v1/me/shows page 1 — sidestepping the
//     window where Spotify's rate-limiter is most easily tripped
//     during repeated debugging.

import { buildDocument } from "./lib/portcast.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;
// We open at the bare origin. We previously tried
// "/collection/podcasts/shows" hoping to force the player to
// fetch the library on bootstrap, but the current Spotify SPA
// (2026) renders that route as a "page not found" inside the
// player chrome — no auth bootstrap, nothing for the hook to
// catch. The home page is the safest URL: it always exists,
// always fires authenticated /v1/me and GraphQL calls during
// bootstrap (Made-For-You, recently-played, the library
// sidebar), and the always-installed MAIN-world hook catches
// those calls because it's in place at document_start.
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
    // If the library URL redirected (e.g. to accounts.spotify.com
    // because the user isn't signed in), we can't run the fetcher
    // there — accounts.spotify.com is outside our host_permissions.
    // Route to the not-signed-in state cleanly instead of letting
    // executeScript fail with a confusing permission error.
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
  // Any open.spotify.com tab works: the always-installed MAIN-world
  // hook is in place on all of them, and any signed-in page made
  // authenticated bootstrap calls during its load. Prefer reusing
  // an existing tab over opening a new one so we don't churn.
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

  // None open — create one in the background and close it on the
  // way out so the user's window state is unchanged.
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
// Token + data acquisition order (each falls through to the next on
// failure):
//   1. Token captured by the always-on MAIN-world hook from a
//      bootstrap fetch. Zero network. Should hit ~always when
//      opened at the library URL.
//   2. /v1/me/shows page 1 captured by the hook — used to skip the
//      first page-fetch of pagination (which is where Spotify's
//      rolling rate-limit window tends to bite).
//   3. Token from the page's SSR-embedded session JSON.
//   4. Token from /get_access_token with web-player headers (last
//      resort — this is what the Varnish CDN 403s).
//   5. Wait up to 10s for a fresh hook capture from any new page
//      fetch (covers the case where the page is loaded but no
//      bootstrap call has fired yet).
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

  function readCapturedBodies() {
    try {
      const raw = sessionStorage.getItem("portcast_captured_bodies");
      if (!raw) return {};
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
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
    // The Spotify web player embeds its initial session in one of a
    // small set of inline JSON script tags. Shape has drifted over
    // web-player versions, so we check the known locations and known
    // nesting paths.
    const candidates = [
      document.getElementById("session"),
      document.getElementById("__NEXT_DATA__"),
      ...document.querySelectorAll('script[type="application/json"]'),
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

  async function waitForFreshHookCapture(timeoutMs) {
    // Used only when nothing else worked. Records "now", then polls
    // for a captured token with a timestamp ≥ now — i.e. a fresh
    // capture from a new page fetch, not the stale bootstrap one
    // we'd have already returned at step 1.
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

  async function obtainToken() {
    progress("token");

    // (1) Token already captured by the always-on hook from the
    // page's bootstrap. This is the happy path when opened at
    // /collection/podcasts/shows.
    const cached = readCapturedToken();
    if (cached) return { ...cached, source: "hook-bootstrap" };

    // (2) Token embedded in the page HTML — works on older builds.
    const fromHtml = extractTokenFromPageHtml();
    if (fromHtml) return { token: fromHtml, source: "page-html" };

    // (3) /get_access_token with web-player headers. Gives us the
    // isAnonymous signal even if it returns a token we don't need.
    const fromEndpoint = await fetchTokenFromEndpoint().catch((e) => ({
      error: String((e && e.message) || e),
    }));
    if (fromEndpoint.notSignedIn) return fromEndpoint;
    if (fromEndpoint.token) {
      return { token: fromEndpoint.token, source: "endpoint" };
    }

    // (4) Wait for any new page fetch to surface a token.
    progress("token-waiting");
    const captured = await waitForFreshHookCapture(10000);
    if (captured) return { ...captured, source: "fetch-hook-poll" };

    return {
      error:
        "Could not obtain a Spotify access token. The page loaded but " +
        "never authenticated with the API (hook caught nothing during " +
        "bootstrap or in the 10s after); the page HTML had no embedded " +
        "session block; /get_access_token returned: " +
        (fromEndpoint.error || "no token") +
        ". Reload open.spotify.com, sign in, navigate to Your Library → " +
        "Podcasts, and click Export again.",
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
    const token = tk.token;
    const headers = {
      Authorization: "Bearer " + token,
      "App-Platform": "WebPlayer",
      "Accept-Language": "en",
    };
    // Client-Token is required by some api.spotify.com endpoints as
    // of mid-2024; attach it when the hook caught one. Bearer alone
    // works for /me/* in most cases, so this is belt+braces.
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

    // The hook stashes raw response bodies for /v1/me, /v1/me/shows,
    // /v1/me/episodes when the page fetched them during bootstrap.
    // We treat each captured body as "page already in hand" and only
    // hit the network for `next` links the captures don't cover.
    const cachedBodies = readCapturedBodies();

    function cachedJson(predicate) {
      for (const [url, body] of Object.entries(cachedBodies)) {
        if (!predicate(url)) continue;
        try {
          return { url, json: JSON.parse(body) };
        } catch {
          // captured body wasn't valid JSON — Spotify may have served
          // a CDN error page; skip and let the API path try.
        }
      }
      return null;
    }

    progress("me");
    let me;
    const cachedMe = cachedJson((u) => /\/v1\/me(?:\?|$)/.test(u));
    if (cachedMe && cachedMe.json && cachedMe.json.id) {
      me = cachedMe.json;
    } else {
      const meResp = await spotifyFetch("https://api.spotify.com/v1/me");
      if (!meResp.ok) {
        const body = await meResp.text().catch(() => "");
        clearCapturedState();
        return {
          error: `Profile fetch failed: ${meResp.status} ${body.slice(0, 200)}`,
        };
      }
      me = await meResp.json();
    }

    async function paginate(path, phase, urlPredicate) {
      const items = [];
      let next = null;

      // Seed pagination from a captured first page if we have one.
      const seed = cachedJson(urlPredicate);
      if (seed && Array.isArray(seed.json.items)) {
        items.push(...seed.json.items);
        next = seed.json.next || null;
        progress(phase, items.length);
        if (next) await new Promise((res) => setTimeout(res, 250));
      } else {
        next = "https://api.spotify.com/v1" + path + "?limit=50";
      }

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

    const savedShows = await paginate(
      "/me/shows",
      "shows",
      (u) => /\/v1\/me\/shows\b/.test(u),
    );
    progress("shows", savedShows.length, true);

    const savedEpisodes = await paginate(
      "/me/episodes",
      "episodes",
      (u) => /\/v1\/me\/episodes\b/.test(u),
    );
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
