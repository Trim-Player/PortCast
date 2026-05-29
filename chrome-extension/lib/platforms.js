// Platform registry — single source of truth for which sources the
// extension supports right now.
//
// To add a platform: write lib/platforms/<id>.js exporting at minimum
// detectSession() and exportToPortCast(), then list its module here.
// Don't forget to add its host(s) to manifest.json `host_permissions`
// — without that the fetches will fail silently in service workers
// (Chrome returns a network error, not a CORS error, for unlisted
// origins).

import * as spotify from "./platforms/spotify.js";

export const PLATFORMS = [
  {
    id: spotify.PLATFORM_ID,
    name: spotify.PLATFORM_NAME,
    module: spotify,
  },
];

export function findPlatform(id) {
  return PLATFORMS.find((p) => p.id === id) || null;
}
