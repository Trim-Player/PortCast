// Fixture shapes matching server/tests/test_exporter.py. Keeping the
// two sets in sync is what guarantees the JS exporter produces
// equivalent documents to the Python one for identical inputs.

export const CAPTURED_AT = "2026-05-29T14:00:00Z";

export function me() {
  return {
    id: "jonathan",
    display_name: "Jonathan",
    email: "trimplayerapp@gmail.com",
  };
}

export function savedShows() {
  return [
    {
      added_at: "2024-06-01T09:14:00Z",
      show: {
        id: "5CnDmMUG0S5bSSw612fs8C",
        name: "Portable Listening Weekly",
        publisher: "Jane Doe",
        images: [{ url: "https://i.scdn.co/image/portable.jpg" }],
        uri: "spotify:show:5CnDmMUG0S5bSSw612fs8C",
      },
    },
    {
      added_at: "2025-11-04T08:00:00Z",
      show: {
        id: "7makk4oTQel546B0PZlDM5",
        name: "A Spotify Exclusive",
        publisher: "Some Studio",
        images: [],
        uri: "spotify:show:7makk4oTQel546B0PZlDM5",
      },
    },
  ];
}

export function savedEpisodes() {
  return [
    // In-progress: resume_point non-zero, fully_played false.
    {
      added_at: "2026-05-25T08:11:00Z",
      episode: {
        id: "ep-in-progress",
        name: "Episode 42: On Portable Listening",
        release_date: "2026-05-20",
        release_date_precision: "day",
        duration_ms: 3287000,
        resume_point: {
          fully_played: false,
          resume_position_ms: 1245200,
        },
        uri: "spotify:episode:ep-in-progress",
        show: {
          id: "5CnDmMUG0S5bSSw612fs8C",
          name: "Portable Listening Weekly",
        },
      },
    },
    // Fully played: status should be completed and positionSeconds dropped.
    {
      added_at: "2026-05-13T07:00:00Z",
      episode: {
        id: "ep-completed",
        name: "Episode 41: Why GUIDs Matter",
        release_date: "2026-05-13",
        release_date_precision: "day",
        duration_ms: 2940000,
        resume_point: {
          fully_played: true,
          resume_position_ms: 2940000,
        },
        uri: "spotify:episode:ep-completed",
        show: {
          id: "5CnDmMUG0S5bSSw612fs8C",
          name: "Portable Listening Weekly",
        },
      },
    },
    // Saved but never played: resume_point zero.
    {
      added_at: "2026-05-20T10:00:00Z",
      episode: {
        id: "ep-unplayed",
        name: "Bonus: Spotify Exclusive Pilot",
        release_date: "2026-05",
        release_date_precision: "month",
        duration_ms: 1800000,
        resume_point: {
          fully_played: false,
          resume_position_ms: 0,
        },
        uri: "spotify:episode:ep-unplayed",
        show: {
          id: "7makk4oTQel546B0PZlDM5",
          name: "A Spotify Exclusive",
        },
      },
    },
  ];
}
