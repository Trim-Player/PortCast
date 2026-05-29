// Service worker — owns the network calls and the download trigger.
//
// Service workers in MV3 are short-lived; Chrome can kill us between
// events. We do all the work inside a single Port lifetime so Chrome
// keeps us alive for the duration of one export run.

import { findPlatform } from "./lib/platforms.js";

const EXTENSION_VERSION = chrome.runtime.getManifest().version;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "export") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "start") return;

    const platform = findPlatform(msg.platform || "spotify");
    if (!platform) {
      port.postMessage({
        type: "error",
        message: `Unknown platform: ${msg.platform}`,
      });
      return;
    }

    try {
      await runExport(platform.module, port);
    } catch (err) {
      port.postMessage({
        type: "error",
        message: humanizeError(err),
      });
    }
  });
});

async function runExport(mod, port) {
  // 1) session check
  const session = await mod.detectSession();
  if (!session || session.isAnonymous || !session.token) {
    port.postMessage({ type: "not-signed-in" });
    return;
  }

  // 2) library fetch + document build
  const onProgress = (progress) =>
    port.postMessage({ type: "progress", progress });

  const { document, summary } = await mod.exportToPortCast({
    token: session.token,
    onProgress,
    generatorVersion: EXTENSION_VERSION,
  });

  // 3) save to disk via chrome.downloads — saveAs:true makes the
  // Save-As dialog explicit so the user always knows where the file
  // lands and so we don't surprise users who keep their Downloads
  // folder tidy.
  port.postMessage({ type: "progress", progress: { phase: "download" } });
  const filename = makeFilename(summary, mod);
  const dataUrl = jsonToDataUrl(document);
  const downloadId = await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: true,
  });

  if (typeof downloadId !== "number") {
    // chrome.downloads.download returns undefined when the user cancels
    // the Save-As dialog. Treat that as a clean "not done" rather than
    // an error.
    port.postMessage({
      type: "error",
      message: "Download was cancelled.",
    });
    return;
  }

  port.postMessage({ type: "done", filename, summary });
}

function makeFilename(summary, mod) {
  const date = new Date().toISOString().slice(0, 10);
  const handle = (summary && summary.userId) || "";
  const safe = handle.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
  const stem = safe ? `${mod.PLATFORM_ID}-${safe}` : mod.PLATFORM_ID;
  return `${stem}-${date}.portcast.json`;
}

function jsonToDataUrl(obj) {
  // Service workers don't have URL.createObjectURL for blobs, so we
  // embed the document inline as a data URL. PortCast files are JSON
  // and well under any practical data-URL size limit (tens of MB on
  // every modern Chrome).
  const json = JSON.stringify(obj, null, 2);
  const encoded = encodeURIComponent(json);
  return `data:application/vnd.portcast+json;charset=utf-8,${encoded}`;
}

function humanizeError(err) {
  if (!err) return "Unknown error.";
  if (err.status === 401 || err.status === 403) {
    return (
      "Spotify rejected the request (your session may have expired). " +
      "Open open.spotify.com, sign in again, and retry."
    );
  }
  if (err.status === 429) {
    return "Spotify is rate-limiting this account. Wait a minute and retry.";
  }
  if (err.status && err.status >= 500) {
    return `Spotify returned ${err.status}. Try again in a few minutes.`;
  }
  return String(err.message || err);
}
