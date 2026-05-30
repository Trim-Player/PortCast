# PortCast Export — icon

The shipped icon is **T1: arrow on the crossbar**, derived from the
Trimplayer logo. Documenting the design here so future edits keep
the relation intact.

## Design

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#FFB74D"/>
      <stop offset="100%" style="stop-color:#E65100"/>
    </linearGradient>
  </defs>
  <circle cx="50" cy="50" r="47" fill="url(#bg)"/>
  <g transform="translate(8,0)" stroke="white" stroke-width="4"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
    <line x1="25" y1="20" x2="25" y2="80"/>           <!-- T stem -->
    <path d="M30 20 L65 45 L30 45 Z" fill="white"/>   <!-- upper play wedge -->
    <path d="M30 55 L65 55 L30 80 Z" fill="white"/>   <!-- lower play wedge -->
    <line x1="25" y1="50" x2="80" y2="50"/>           <!-- export shaft -->
    <polyline points="72,42 82,50 72,58"/>            <!-- export head -->
  </g>
</svg>
```

The source file is `icons/icon.svg`. The 16/48/128 PNGs that ship
in the extension are rendered from it.

## Relation to the Trimplayer logo

Same orange gradient (`#FFB74D` → `#E65100`), same circle silhouette,
same internal white "T" mark with two play wedges flanking the
crossbar. The PortCast modification is that the crossbar grows past
the play-wedge gap into an arrowhead — the inner line of the
Trimplayer mark now exits to the right, communicating "export."

Both play wedges are preserved so the Trimplayer DNA reads at a
glance, including at 16×16 in the toolbar.

## Re-rendering after an edit

```bash
cd chrome-extension/icons
for size in 16 48 128; do
  magick -background none -density 1200 icon.svg \
    -resize ${size}x${size} ${size}.png
done
```

`magick` is ImageMagick 7+. The high `-density` matters: rasterizing
an SVG circle at low density gives jagged edges at 16×16.

## What we considered but didn't ship

For the record so future revisions don't re-tread the ground:

- A door-glyph mark with an export arrow (no Trimplayer relation).
- A monogram-style P inside a portability loop.
- A cassette-tape mark.
- Trimplayer-derived variants where the arrow broke past the circle
  edge, replaced the lower wedge, or replaced both wedges.

T1 won because it (a) preserves both play wedges so the Trimplayer
read is unambiguous, (b) stays crisp at 16×16, and (c) introduces
the export semantic by extending a line that already exists in the
source mark rather than adding a new visual element.
