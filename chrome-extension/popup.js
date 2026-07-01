// Popup controller — a thin shell over the background service worker.
//
// The popup itself does no platform work. It posts an "export" message
// (with the chosen platform) to background.js, which owns the network
// calls and the download trigger. Progress updates flow back over a
// `chrome.runtime.Port` so the user sees real per-phase status rather
// than a frozen spinner.

const states = {
  idle: document.getElementById("state-idle"),
  notSignedIn: document.getElementById("state-not-signed-in"),
  running: document.getElementById("state-running"),
  done: document.getElementById("state-done"),
  error: document.getElementById("state-error"),
};

function show(name) {
  for (const [k, el] of Object.entries(states)) {
    el.classList.toggle("visible", k === name);
  }
}

let lastPlatform = "spotify";

function describeProgress(p) {
  if (!p || !p.phase) return "Working…";
  if (p.phase === "tab") {
    return lastPlatform === "youtube"
      ? "Opening YouTube…"
      : "Opening Spotify…";
  }
  if (p.phase === "token") {
    return lastPlatform === "youtube"
      ? "Reading YouTube auth…"
      : "Authorizing with Spotify…";
  }
  if (p.phase === "token-waiting") {
    return lastPlatform === "youtube"
      ? "Waiting for YouTube to make an API call…"
      : "Waiting for Spotify to make an API call…";
  }
  if (p.phase === "rate-limited") {
    const sec = Number(p.count) || 5;
    const who = lastPlatform === "youtube" ? "YouTube" : "Spotify";
    return `${who} rate-limited us — retrying in ${sec}s…`;
  }
  // Spotify phases
  if (p.phase === "me") return "Reading your Spotify profile…";
  if (p.phase === "shows") {
    return p.done
      ? `Found ${p.count} followed shows. Fetching episodes…`
      : `Fetching followed shows… ${p.count || 0}`;
  }
  if (p.phase === "episodes" && lastPlatform === "spotify") {
    if (p.done) return `Building your PortCast file…`;
    const ctx =
      p.showIdx && p.showCount
        ? ` (show ${p.showIdx} of ${p.showCount})`
        : "";
    return `Fetching episodes… ${p.count || 0}${ctx}`;
  }
  // YouTube phases
  if (p.phase === "channels") {
    return p.done
      ? `Found ${p.count} subscribed channels. Looking for podcasts…`
      : `Fetching subscribed channels… ${p.count || 0}`;
  }
  if (p.phase === "podcasts") {
    if (p.done) return `Found ${p.count} podcasts. Fetching episodes…`;
    const ctx =
      p.channelIdx && p.channels
        ? ` (channel ${p.channelIdx} of ${p.channels})`
        : "";
    return `Looking for podcast tabs… ${p.count || 0} so far${ctx}`;
  }
  if (p.phase === "episodes" && lastPlatform === "youtube") {
    if (p.done) return `Found ${p.count} episodes. Reading watch history…`;
    const ctx =
      p.playlistIdx && p.playlists
        ? ` (playlist ${p.playlistIdx} of ${p.playlists})`
        : "";
    return `Fetching episodes… ${p.count || 0}${ctx}`;
  }
  if (p.phase === "history") {
    return p.done
      ? `Building your PortCast file…`
      : `Reading watch history… ${p.count || 0} matches`;
  }
  if (p.phase === "download") return "Saving file…";
  return "Working…";
}

let port = null;

function startExport(platform) {
  lastPlatform = platform;
  show("running");
  document.getElementById("progress-line").textContent =
    platform === "youtube" ? "Connecting to YouTube…" : "Connecting to Spotify…";

  // A long-lived Port lets the service worker stream progress without
  // each message paying the sendMessage round-trip cost. The port also
  // signals to MV3 that the service worker shouldn't be torn down
  // mid-fetch.
  port = chrome.runtime.connect({ name: "export" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "progress") {
      document.getElementById("progress-line").textContent =
        describeProgress(msg.progress);
    } else if (msg.type === "not-signed-in") {
      document.getElementById("not-signed-in-body").textContent =
        platform === "youtube"
          ? "You’re not signed in to YouTube in this browser."
          : "You’re not signed in to Spotify in this browser.";
      // Show only the relevant sign-in button
      document
        .getElementById("btn-open-spotify")
        .classList.toggle("hidden", platform === "youtube");
      document
        .getElementById("btn-open-youtube")
        .classList.toggle("hidden", platform === "spotify");
      show("notSignedIn");
    } else if (msg.type === "done") {
      document.getElementById("done-filename").textContent = msg.filename;
      document.getElementById("done-subscriptions").textContent =
        msg.summary.subscriptions;
      document.getElementById("done-episodes").textContent =
        msg.summary.episodes;
      show("done");
    } else if (msg.type === "error") {
      document.getElementById("error-line").textContent =
        "Couldn't finish the export.";
      document.getElementById("error-detail").textContent =
        msg.message || "";
      show("error");
    }
  });
  port.postMessage({ type: "start", platform });
}

document
  .getElementById("btn-export-spotify")
  .addEventListener("click", () => startExport("spotify"));
document
  .getElementById("btn-export-youtube")
  .addEventListener("click", () => startExport("youtube"));
document
  .getElementById("btn-again")
  .addEventListener("click", () => startExport(lastPlatform));
document
  .getElementById("btn-retry")
  .addEventListener("click", () => startExport(lastPlatform));

document.getElementById("btn-open-spotify").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://open.spotify.com" });
  window.close();
});
document.getElementById("btn-open-youtube").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://www.youtube.com" });
  window.close();
});
