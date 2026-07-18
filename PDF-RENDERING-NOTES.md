# PDF Arabic Rendering — Status & What's Needed Next

## Current state

`disableFontFace` is back at its default (`false`) in both
`app/js/viewer.js` and `app/js/thumbnails.js`. This is the setting used
by pdf.js's own default configuration and by Firefox's built-in PDF
viewer, which renders Arabic/RTL PDFs correctly for the overwhelming
majority of real-world documents. It is the safer, more broadly
compatible baseline.

## Why the previous attempt (`disableFontFace: true`) was reverted

That change was a hypothesis based on the reported symptoms and two
screenshots — there was no actual PDF file to test it against. It
"fixed" the disconnected-Arabic-letters look for whatever files were
tried, but forcing pdf.js's internal glyph-path renderer for *every*
font (instead of letting pdf.js decide per font) caused a real
regression: missing numbers and symbols in other PDFs.

That outcome — one class of PDFs fixed, another broken — is the clear
sign that a single global rendering-strategy flag is the wrong lever.
pdf.js's own per-font fallback logic is more sophisticated (and far
more tested, across millions of real documents) than a blanket
override, so it's been restored.

## Why I'm not shipping another global-flag guess right now

For a commercial product going into production at real schools, "zero
regressions" isn't achievable by trial-and-error on a setting that
affects every PDF uniformly, without a file that actually reproduces
the bug. The first attempt is proof of that: it traded one visible bug
for a different one. A second blind guess carries the same risk of
trading bug #2 for bug #3.

The pdf.js rendering pipeline has ~10 different subsystems that can
each independently cause glyph problems (embedded font parsing, CMap
resolution, ToUnicode mapping, glyph ID resolution, native font-face
registration, canvas text painting, DPI/transform scaling, etc.).
Different broken PDFs can fail in *different* subsystems even though
the visible symptom looks similar. Fixing this properly means matching
the actual failure to its actual cause — not applying one setting to
every document.

## What's needed to close this out for real

Please send **1–3 actual PDF files** that show the problem (not just
screenshots) — ideally one from each generator category you've seen
fail (e.g. one from a Ministry/government system, one from an old
Arabic DTP tool, one Word/LibreOffice export). With a real file I can:

1. Inspect the embedded font program directly (subtype, whether it's
   CID/Type0 or simple TrueType, whether its cmap/GSUB tables are
   present and valid, whether it has a ToUnicode CMap).
2. Reproduce the exact rendering failure locally and watch pdf.js's
   own diagnostic warnings (open DevTools console with `npm run dev`
   while the PDF is open — pdf.js logs warnings like `Warning: ... font
   ...` for font-loading and glyph-mapping problems).
3. Apply a fix that's scoped to the actual failure mode for that font
   type, verified against that specific file, and then test it against
   the previously-working PDFs to confirm no regression before calling
   it done.

If you don't have the original PDFs handy, even a description of the
exact software/version that generated the failing PDFs helps narrow
this down.

## In the meantime

If you hit this in testing again, the fastest way to get useful
diagnostic info without sending files:
1. `npm run dev` (DevTools available)
2. Open the problem PDF in the viewer
3. Copy anything printed in the DevTools Console (`Ctrl+Shift+I`) —
   pdf.js prints font/glyph warnings there for the specific document
4. Send that console output along with which page/section looked wrong
