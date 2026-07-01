// PortCast — MAIN-world YouTube InnerTube capture hook.
//
// Loaded as a content_scripts entry at document_start in the MAIN world
// on every www.youtube.com page. Wraps window.fetch and XMLHttpRequest
// so that every authenticated POST to /youtubei/v1/* leaves its full
// auth-relevant header set in sessionStorage, where the ISOLATED-world
// fetcher in background.js can read it.
//
// Why every header set: YouTube's auth is SAPISIDHASH (timestamp + sha1
// of SAPISID cookie + origin), which is generated client-side and
// embedded in the Authorization header. We don't try to re-compute it;
// we snipe one and replay it within its ~30min validity window.
//
// Why document_start: bootstrap /browse calls fire during page boot;
// we need the hook in place before any page JS runs, otherwise an idle
// tab may not fire a usable call for tens of seconds (same lesson as
// the Spotify hook).
//
// Privacy: the captured token + cookies sit in sessionStorage of
// www.youtube.com, scoped to that origin. The page's own JS already
// has the same auth. The extension reads it only when the user clicks
// Export, and clears it from sessionStorage when the export finishes.

(function () {
  if (window.__portcastYtHookInstalled) return;
  window.__portcastYtHookInstalled = true;

  const AUTH_KEY = "portcast_yt_authorization";
  const VISITOR_KEY = "portcast_yt_visitor_id";
  const CLIENT_NAME_KEY = "portcast_yt_client_name";
  const CLIENT_VERSION_KEY = "portcast_yt_client_version";
  const AUTHUSER_KEY = "portcast_yt_authuser";
  const AT_KEY = "portcast_yt_captured_at";
  const BODY_CONTEXT_KEY = "portcast_yt_request_context";

  function isInnerTube(url) {
    return typeof url === "string" && /\/youtubei\/v1\//.test(url);
  }

  function capture(headers) {
    try {
      const auth = headers.get("authorization") || headers.get("Authorization");
      const visitor =
        headers.get("x-goog-visitor-id") || headers.get("X-Goog-Visitor-Id");
      const clientName =
        headers.get("x-youtube-client-name") ||
        headers.get("X-Youtube-Client-Name");
      const clientVersion =
        headers.get("x-youtube-client-version") ||
        headers.get("X-Youtube-Client-Version");
      const authUser =
        headers.get("x-goog-authuser") || headers.get("X-Goog-AuthUser");

      let touched = false;
      if (auth && /SAPISIDHASH|Bearer/.test(auth)) {
        sessionStorage.setItem(AUTH_KEY, auth);
        touched = true;
      }
      if (visitor) sessionStorage.setItem(VISITOR_KEY, visitor);
      if (clientName) sessionStorage.setItem(CLIENT_NAME_KEY, clientName);
      if (clientVersion)
        sessionStorage.setItem(CLIENT_VERSION_KEY, clientVersion);
      if (authUser) sessionStorage.setItem(AUTHUSER_KEY, authUser);
      if (touched) sessionStorage.setItem(AT_KEY, String(Date.now()));
    } catch {}
  }

  // Capture the request body's `context` object once so the fetcher can
  // reuse the exact client/user/request structure the page uses. Avoids
  // having to guess clientFormFactor, screenWidth/Height, etc.
  function captureBodyContext(rawBody) {
    try {
      if (!rawBody) return;
      const parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
      if (parsed && parsed.context && parsed.context.client) {
        sessionStorage.setItem(BODY_CONTEXT_KEY, JSON.stringify(parsed.context));
      }
    } catch {}
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "";
    try {
      url =
        typeof input === "string"
          ? input
          : input && input.url
            ? input.url
            : "";
      if (isInnerTube(url)) {
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
        if (h) capture(h);
        if (init && init.body) captureBodyContext(init.body);
      }
    } catch {}
    return origFetch.apply(this, arguments);
  };

  const XHR = window.XMLHttpRequest;
  const origOpen = XHR.prototype.open;
  const origSetHeader = XHR.prototype.setRequestHeader;
  const origSend = XHR.prototype.send;

  XHR.prototype.open = function (method, url) {
    this.__portcastUrl = url;
    this.__portcastHeaders = new Headers();
    return origOpen.apply(this, arguments);
  };
  XHR.prototype.setRequestHeader = function (name, value) {
    try {
      if (isInnerTube(this.__portcastUrl) && typeof name === "string") {
        this.__portcastHeaders.set(name, value);
      }
    } catch {}
    return origSetHeader.apply(this, arguments);
  };
  XHR.prototype.send = function (body) {
    try {
      if (isInnerTube(this.__portcastUrl) && this.__portcastHeaders) {
        capture(this.__portcastHeaders);
        if (body) captureBodyContext(body);
      }
    } catch {}
    return origSend.apply(this, arguments);
  };
})();
