// PortCast document builder — pure ES module, source-agnostic.
//
// JS mirror of server/portcast_server/exporter.py. No DOM, no chrome.*,
// no fetch — this file takes already-shaped `subscriptions[]`,
// `episodes[]`, and `owner` from a platform adapter and assembles them
// into a document matching the PortCast schema.
//
// Reused unchanged inside the Trimplayer mobile app's WebView, so it
// must stay platform-agnostic. All platform-specific knowledge (the
// `spotify:show:…` / `youtube:channel:…` ref schemes, which fields
// come from where) lives in the adapter modules under lib/platforms/.

export const SPEC_VERSION = "0.2.0";
export const GENERATOR_NAME = "PortCast Export";
export const GENERATOR_URL = "https://portcast.org";

export function nowIso() {
  // ISO 8601 with "Z" suffix, second precision — matches the Python
  // exporter's _now_iso(), so the JS and Python paths produce
  // byte-identical timestamps for identical inputs.
  return new Date().toISOString().split(".")[0] + "Z";
}

export function normalizeReleaseDate(raw, precision) {
  // Coarser precisions widen to start-of-day UTC. Returns null if the
  // input isn't parseable so the caller can drop the field. Currently
  // shaped around Spotify's YYYY / YYYY-MM / YYYY-MM-DD; YouTube's
  // ISO timestamps pass through unchanged via a different path.
  if (!raw) return null;
  const p = (precision || "day").toLowerCase();
  if (p === "year" && raw.length === 4) return `${raw}-01-01T00:00:00Z`;
  if (p === "month" && raw.length === 7) return `${raw}-01T00:00:00Z`;
  if (p === "day" && raw.length === 10) return `${raw}T00:00:00Z`;
  return null;
}

export function stripNull(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// crypto.randomUUID() is available in MV3 service workers, modern
// WebViews, and Node 19+; we use a hex-only form to match the
// Python exporter's _new_id().
export function cryptoRandomId() {
  const uuid =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : pseudoUuid();
  return uuid.replace(/-/g, "");
}

function pseudoUuid() {
  // Fallback for environments without crypto.randomUUID (older test
  // runners). Not cryptographically strong; only used for opaque IDs
  // inside the document.
  const r = () =>
    Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

export function buildDocument({
  owner,
  subscriptions,
  episodes,
  completeness,
  generatorVersion,
  capturedAt,
}) {
  const ts = capturedAt || nowIso();

  const doc = {
    portcast: SPEC_VERSION,
    generatedAt: ts,
    generator: stripNull({
      name: GENERATOR_NAME,
      version: generatorVersion || null,
      url: GENERATOR_URL,
    }),
    subscriptions: subscriptions || [],
    episodes: episodes || [],
    completeness: completeness || [],
  };
  if (owner) doc.owner = owner;
  return doc;
}
