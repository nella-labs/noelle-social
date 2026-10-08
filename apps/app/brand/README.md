# Noelle identity

`geometry.json` holds the selected open-flow symbol as two smooth cubic shapes.
The lowercase wordmark uses reusable geometric glyphs: outlined `n` and `e`
shapes, a circular `o`, and rounded rectangular `l` stems. The source is
editable geometry, with no embedded image or traced contour data.

Run `pnpm -F @noelle/app brand:generate` from the repository root.
This exports standalone symbol, wordmark, and full lockup SVGs in ink and white,
the favicon, Apple touch icon, PWA icons, and the social card.
The white lockup PNG supports email clients without SVG support.
The retained `apps/www/public/og.png` also receives the selected social card.
Edit the geometry source and regenerate the assets together.

The app icon has an opaque cream background. Its symbol fits inside the central
80 percent circle so Android can mask it without clipping the mark.
The navigation component uses the SVGs as masks so existing theme colors apply.
