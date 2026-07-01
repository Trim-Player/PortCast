// YouTube platform module.
//
// Same shape as platforms/spotify.js: detectSession() reports whether
// the user is signed in to www.youtube.com in this browser, and
// buildYouTubeDocument({...}) maps already-fetched payloads into the
// PortCast document shape. The actual fetching is driven from
// background.js (in the youtube.com tab's ISOLATED world), because
// that's where the captured InnerTube headers are reachable.
//
// Data model (verified live, May 2026):
//   - A YouTube "podcast" is a *playlist* hung off a channel. The
//     channel's Podcasts tab (browse params "Eghwb2RjYXN0c_IGBQoDugEA"
//     — protobuf-encoded literal "podcasts", channel-agnostic) returns
//     lockupViewModel items with contentType=LOCKUP_CONTENT_TYPE_PODCAST
//     and contentId=<playlistId>.
//   - The user follows podcasts by subscribing to the parent channel.
//     There's no "saved podcast" or "saved episode" surface anywhere
//     on youtube.com — confirmed by /podcasts (FEpodcasts_destination)
//     and /library (FElibrary) being pure discovery / non-podcast.
//   - Episodes are the videos inside each podcast playlist.
//   - Resume positions surface via FEhistory's
//     thumbnailOverlayResumePlaybackRenderer per video.
//
// PlatformRef scheme:
//   subscription -> "youtube:playlist:<playlistId>"
//   episode      -> "youtube:video:<videoId>"

import {
  buildDocument,
  cryptoRandomId,
  stripNull,
} from "../portcast.js";

export const PLATFORM_ID = "youtube";
export const PLATFORM_NAME = "YouTube";
const SOURCE = "youtube";

// Protobuf-encoded literal "podcasts". Identical for every channel —
// it selects the Podcasts tab in browse(channelId, params).
export const PODCASTS_TAB_PARAMS = "Eghwb2RjYXN0c_IGBQoDugEA";

// Public InnerTube browseIds used by the adapter.
export const FE_CHANNELS = "FEchannels";
export const FE_HISTORY = "FEhistory";

// ---------- shape mappers ----------

export function subscriptionFromPodcastPlaylist(podcast, capturedAt) {
  // `podcast` is an already-shaped object the fetcher emits:
  //   { playlistId, title, channelTitle, imageUrl, subscribedAt }
  if (!podcast || !podcast.playlistId) return null;
  return stripNull({
    subscriptionId: cryptoRandomId(),
    title: podcast.title || "(untitled podcast)",
    author: podcast.channelTitle || null,
    imageUrl: podcast.imageUrl || null,
    subscribedAt: podcast.subscribedAt || null,
    platformRefs: [`youtube:playlist:${podcast.playlistId}`],
    updatedAt: capturedAt,
  });
}

export function episodeFromVideo(video, capturedAt) {
  // `video` is an already-shaped object the fetcher emits:
  //   { videoId, playlistId, title, durationSeconds, publishedAt,
  //     resumePositionSeconds, fullyPlayed }
  // playlistId ties the episode to its subscription. An episode with
  // no playlistId is unaddressable on import.
  if (!video || !video.videoId || !video.playlistId) return null;

  const fullyPlayed = Boolean(video.fullyPlayed);
  const resumeS = Number(video.resumePositionSeconds) || 0;
  let status;
  let positionSeconds = null;
  if (fullyPlayed) {
    status = "completed";
  } else if (resumeS > 0) {
    status = "in_progress";
    positionSeconds = resumeS;
  } else {
    status = "unplayed";
  }

  return stripNull({
    episodeStateId: cryptoRandomId(),
    subscriptionRef: {
      platformRefs: [`youtube:playlist:${video.playlistId}`],
    },
    platformRefs: [`youtube:video:${video.videoId}`],
    title: video.title || null,
    publishedAt: video.publishedAt || null,
    durationSeconds:
      typeof video.durationSeconds === "number" ? video.durationSeconds : null,
    status,
    positionSeconds,
    source: SOURCE,
    capturedAt,
    updatedAt: capturedAt,
  });
}

function ownerFromYouTubeIdentity(identity) {
  if (!identity) return null;
  const displayName = identity.displayName || null;
  const email = identity.email || null;
  if (!displayName && !email) return null;
  return stripNull({ displayName, email });
}

function youtubeCompleteness(ts) {
  return [
    {
      section: "subscriptions",
      source: SOURCE,
      level: "full",
      capturedAt: ts,
      note:
        "Every podcast playlist published by a channel the user is " +
        "subscribed to (YouTube has no separate 'followed podcasts' list).",
    },
    {
      section: "episodes",
      source: SOURCE,
      level: "current-state-only",
      capturedAt: ts,
      note:
        "Episodes are the videos in each podcast playlist; resume " +
        "positions are derived from YouTube's watch-history overlay.",
    },
  ];
}

export function buildYouTubeDocument({
  identity,
  podcasts,
  videos,
  capturedAt,
  generatorVersion,
}) {
  const ts = capturedAt;
  const subscriptions = [];
  for (const p of podcasts || []) {
    const sub = subscriptionFromPodcastPlaylist(p, ts);
    if (sub) subscriptions.push(sub);
  }
  const episodes = [];
  for (const v of videos || []) {
    const ep = episodeFromVideo(v, ts);
    if (ep) episodes.push(ep);
  }
  return buildDocument({
    owner: ownerFromYouTubeIdentity(identity),
    subscriptions,
    episodes,
    completeness: youtubeCompleteness(ts),
    generatorVersion,
    capturedAt: ts,
  });
}
