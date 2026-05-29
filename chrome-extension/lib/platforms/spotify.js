// Spotify platform module.
//
// Three responsibilities, in order:
//   1. detectSession()  — is the user signed in to open.spotify.com
//      in this browser? Returns a token (good) or null (sign-in
//      needed) so the popup can route accordingly.
//   2. fetchLibrary(token, onProgress) — pull /me, /me/shows, and
//      /me/episodes. Pages through "next" links until done.
//   3. exportToPortCast({ token, onProgress, capturedAt }) — the
//      one-call orchestrator the popup actually invokes; calls
//      fetchLibrary then buildDocument and returns the doc + a
//      summary { subscriptions, episodes, userId } for the UI.
//
// No `chrome.*`, no DOM. Reused in the Trimplayer mobile WebView.

import { buildDocument } from "../portcast.js";

export const PLATFORM_ID = "spotify";
export const PLATFORM_NAME = "Spotify";

const TOKEN_URL =
  "https://open.spotify.com/get_access_token" +
  "?reason=transport&productType=web-player";

const API_BASE = "https://api.spotify.com/v1";

class HttpError extends Error {
  constructor(status, body, url) {
    super(`Spotify ${status} on ${url}: ${truncate(body, 300)}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + "…";
}

/**
 * Fetch the web-player access token Spotify hands its own UI.
 *
 * Relies on the user being signed in at open.spotify.com — the
 * browser attaches their session cookies because the extension's
 * manifest declares open.spotify.com as a host permission.
 *
 * Returns:
 *   { token: string, isAnonymous: false, expiresAt: number }
 * or:
 *   { token: null, isAnonymous: true }
 *
 * Throws on network / 5xx / shape errors so the popup can show a
 * concrete "Spotify changed something, try again later" message
 * rather than a silent failure.
 */
export async function detectSession() {
  const resp = await fetch(TOKEN_URL, {
    credentials: "include",
    cache: "no-store",
  });
  if (!resp.ok) {
    const body = await safeReadBody(resp);
    throw new HttpError(resp.status, body, TOKEN_URL);
  }
  const data = await resp.json();
  // Defensive: Spotify's exact key names have been stable for years
  // but we'd rather throw a typed error than crash deep in the
  // export call site.
  if (typeof data !== "object" || data === null) {
    throw new Error("Spotify token endpoint returned non-object body.");
  }
  if (data.isAnonymous === true || !data.accessToken) {
    return { token: null, isAnonymous: true };
  }
  return {
    token: data.accessToken,
    isAnonymous: false,
    expiresAt: data.accessTokenExpirationTimestampMs || null,
  };
}

async function safeReadBody(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

async function apiGet(token, urlOrPath) {
  const url = urlOrPath.startsWith("http")
    ? urlOrPath
    : `${API_BASE}${urlOrPath}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!resp.ok) {
    const body = await safeReadBody(resp);
    throw new HttpError(resp.status, body, url);
  }
  return resp.json();
}

/**
 * Yield every `items[]` entry from a paginated Spotify endpoint.
 * The async-iterator shape lets the caller surface progress as
 * pages arrive without buffering the whole library.
 */
async function* paginate(token, path, params = {}) {
  const sp = new URLSearchParams({ limit: "50", ...params });
  let next = `${path}?${sp.toString()}`;
  while (next) {
    const page = await apiGet(token, next);
    const items = Array.isArray(page.items) ? page.items : [];
    for (const item of items) yield item;
    next = page.next || null;
  }
}

async function collect(iter, onChunk) {
  const out = [];
  for await (const item of iter) {
    out.push(item);
    if (onChunk && out.length % 50 === 0) onChunk(out.length);
  }
  return out;
}

export async function fetchLibrary(token, onProgress = () => {}) {
  onProgress({ phase: "me" });
  const me = await apiGet(token, "/me");

  onProgress({ phase: "shows", count: 0 });
  const savedShows = await collect(
    paginate(token, "/me/shows"),
    (n) => onProgress({ phase: "shows", count: n }),
  );
  onProgress({ phase: "shows", count: savedShows.length, done: true });

  onProgress({ phase: "episodes", count: 0 });
  const savedEpisodes = await collect(
    paginate(token, "/me/episodes"),
    (n) => onProgress({ phase: "episodes", count: n }),
  );
  onProgress({
    phase: "episodes",
    count: savedEpisodes.length,
    done: true,
  });

  return { me, savedShows, savedEpisodes };
}

export async function exportToPortCast({
  token,
  onProgress,
  capturedAt,
  generatorVersion,
}) {
  const { me, savedShows, savedEpisodes } = await fetchLibrary(
    token,
    onProgress,
  );

  const document = buildDocument({
    me,
    savedShows,
    savedEpisodes,
    capturedAt,
    generatorVersion,
  });

  return {
    document,
    summary: {
      userId: (me && me.id) || null,
      displayName: (me && me.display_name) || null,
      subscriptions: document.subscriptions.length,
      episodes: document.episodes.length,
    },
  };
}
