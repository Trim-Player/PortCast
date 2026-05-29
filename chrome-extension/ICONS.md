# PortCast Export — icon mark proposals

Pick one before publishing to the Chrome Web Store. Each mark below
is a 64×64 SVG with all the visual weight inside the central 48×48
area so it still reads at the 16×16 toolbar size.

For each option, the same SVG renders to `icons/16.png`, `icons/48.png`,
and `icons/128.png` at build time.

---

## Option A — "the export door"

A rounded square with a door-like aperture and an arrow stepping
out. Reads as "your stuff, leaving the room." Distinct from the
existing portcast.org microphone favicon (which would feel weird on
a toolbar — too detail-heavy at 16px).

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="PortCast Export">
  <rect width="64" height="64" rx="14" fill="#ff7a45"/>
  <!-- doorway -->
  <rect x="14" y="14" width="22" height="36" rx="3" fill="none" stroke="#1a0e08" stroke-width="4"/>
  <!-- door handle dot -->
  <circle cx="30" cy="32" r="2" fill="#1a0e08"/>
  <!-- arrow leaving -->
  <path d="M28 32h22" stroke="#1a0e08" stroke-width="5" stroke-linecap="round"/>
  <path d="M44 24l8 8-8 8" stroke="#1a0e08" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>
```

**Pros:** instantly legible at 16×16, communicates "export" without
words, brand-consistent palette (`#ff7a45` from portcast.org).
**Cons:** door metaphor is a little generic.

---

## Option B — "the boxed P with portability arrow"

Wordmark-ish: a stylized "P" wrapped by a circular arrow loop
suggesting movement / portability.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="PortCast Export">
  <rect width="64" height="64" rx="14" fill="#1a0e08"/>
  <!-- circular arrow loop -->
  <path d="M50 32a18 18 0 1 1 -5.27 -12.73" stroke="#ff7a45" stroke-width="4" fill="none" stroke-linecap="round"/>
  <path d="M44.7 19.3l-5 -2 -2 5" stroke="#ff7a45" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- P -->
  <path d="M22 18v28M22 18h10a7 7 0 0 1 0 14h-10" stroke="#ffffff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

**Pros:** brand-forward, reads as "PortCast" at any size, the loop
quietly says "this thing moves your data."
**Cons:** more elements to keep crisp at 16px — needs careful
testing in the toolbar at small size.

---

## Option C — "the cassette of subscriptions"

A retro tape-cassette silhouette, nodding to "portable audio
library" without invoking a specific player.

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="PortCast Export">
  <rect width="64" height="64" rx="14" fill="#ff7a45"/>
  <!-- cassette body -->
  <rect x="10" y="20" width="44" height="28" rx="3" fill="#1a0e08"/>
  <!-- tape windows -->
  <circle cx="22" cy="34" r="5" fill="#ff7a45"/>
  <circle cx="22" cy="34" r="2" fill="#1a0e08"/>
  <circle cx="42" cy="34" r="5" fill="#ff7a45"/>
  <circle cx="42" cy="34" r="2" fill="#1a0e08"/>
  <!-- export arrow underneath -->
  <path d="M20 54h24" stroke="#1a0e08" stroke-width="4" stroke-linecap="round"/>
  <path d="M38 50l6 4-6 4" stroke="#1a0e08" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
```

**Pros:** memorable, warm, the cassette evokes "your library you
can carry" which is the whole pitch.
**Cons:** cassettes are nostalgia-coded; could feel "indie podcast"
rather than "infrastructure tool." Depends on the audience you want.

---

## Recommendation

**Option A** — "the export door". Simplest read, the cleanest
behaviour at 16×16, and the action ("export") is the icon's job to
communicate in a 16-pixel toolbar slot. Option B is the better long-
term brand if you want a single mark for PortCast across surfaces
(spec site, extension, future tools); we can adopt it at the
favicon level and use A in the extension specifically. Option C is
the spicy pick if you want the Web Store thumbnail to stand out
from a sea of green/blue gear-icons.

Drop your pick in chat ("A", "B", "C") or paste a new SVG and I'll
render the PNGs and wire them in.
