// Popup controller — a thin shell over the background service worker.
//
// The popup itself does no Spotify work. It posts an "export" message
// to background.js, which owns the network calls and the download
// trigger. Progress updates flow back over a `chrome.runtime.Port` so
// the user sees "Fetching shows… 87/142" rather than a frozen spinner.

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

function describeProgress(p) {
  if (!p || !p.phase) return "Working…";
  if (p.phase === "tab") return "Opening Spotify…";
  if (p.phase === "token") return "Authorizing with Spotify…";
  if (p.phase === "token-waiting")
    return "Waiting for Spotify to make an API call…";
  if (p.phase === "rate-limited") {
    const sec = Number(p.count) || 5;
    return `Spotify rate-limited us — retrying in ${sec}s…`;
  }
  if (p.phase === "me") return "Reading your Spotify profile…";
  if (p.phase === "shows") {
    return p.done
      ? `Found ${p.count} followed shows. Fetching episodes…`
      : `Fetching followed shows… ${p.count || 0}`;
  }
  if (p.phase === "episodes") {
    return p.done
      ? `Building your PortCast file…`
      : `Fetching saved episodes… ${p.count || 0}`;
  }
  if (p.phase === "download") return "Saving file…";
  return "Working…";
}

let port = null;

function startExport() {
  show("running");
  document.getElementById("progress-line").textContent =
    "Connecting to Spotify…";

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
  port.postMessage({ type: "start", platform: "spotify" });
}

document.getElementById("btn-export").addEventListener("click", startExport);
document.getElementById("btn-again").addEventListener("click", startExport);
document.getElementById("btn-retry").addEventListener("click", startExport);

document
  .getElementById("btn-open-spotify")
  .addEventListener("click", () => {
    chrome.tabs.create({ url: "https://open.spotify.com" });
    window.close();
  });
