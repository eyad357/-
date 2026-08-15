# PPTX Real Visual Fidelity + Presentation Mode — Report

## 0. Run this after extracting

```bash
bash POST-EXTRACT-CLEANUP.sh
```

---

## 1. Inspection performed before changing anything

Read `app/index.html`, `app/js/viewer.js` (the full `renderPptx()` extraction implementation),
`app/js/uploader.js`, `app/js/thumbnails.js`, `app/js/dialogs.js`, `app/js/file-support-policy.js`,
`server/routes/files.js`, `server/services/evidenceService.js`, `server/services/evidenceWatcher.js`,
`electron/utils/paths.js`, `package.json`. Confirmed:

- The old PPTX renderer used JSZip to unzip the `.pptx` (which is itself a zip container) and
  DOMParser to read each slide's raw OOXML, pulling out `<a:t>` text runs and relationship-linked
  images — genuinely just text/image **extraction**, with no layout engine at all. This is why
  backgrounds, exact positions, shapes, tables, and fonts were all lost: that information exists in
  the OOXML (transforms, fill definitions, table grids, theme references) but the old code never
  read or applied any of it.
- `app/js/file-support-policy.js` (built in the previous pass) is the single source of truth for
  file classification, and `viewer.js`'s renderer dispatch already keys off
  `policy.preview.engine` — so adding a new PPTX engine meant changing one policy entry and one
  dispatch-table key, not inventing a second classification system.
- The evidence-serving path (`evidenceService.getFilePath`, already validated/sanitized) was
  reusable as-is for locating the source PPTX safely.

## 2. Why the previous approach was insufficient

Extracting text nodes and images from OOXML cannot reproduce layout, because PPTX layout is not
implied by extraction order — it's defined by absolute/relative transforms (`<a:xfrm>`), theme
color references, table/grid definitions, and shape geometry that a text-extraction pass never
touches. No amount of "improving" the extraction (better text grouping, smarter image placement
heuristics) can close that gap — it would still be reconstructing a guess at the slide, not
rendering it. This was confirmed by you and matches what a text-only DOM/XML walk can fundamentally
produce.

## 3. Architecture selected, and why

**PPTX → PDF (via headless LibreOffice) → existing PDFEngine pipeline → dedicated presentation-mode
viewer.** From your list, this is option E ("preferred architecture").

Why this over the alternatives:
- **(A) Native/embedded Office rendering** — Microsoft doesn't ship a redistributable rendering
  component for third-party embedding; effectively unavailable for an Electron app.
- **(C) OnlyOffice** — a much larger, heavier dependency (a full document-server stack) for the
  same net result LibreOffice gives in one process invocation; unjustified complexity for this use
  case.
- **(D) A PPTX-rendering JS library** — no library exists that does real OOXML layout rendering to
  the fidelity LibreOffice already provides; would mean building a layout engine from scratch.
- **(F) PPTX → slide images** — strictly worse than PDF: loses vector sharpness at zoom, loses the
  PDF text layer (search), and needs a second rendering pipeline instead of reusing PDFEngine.
- **(E), chosen**: reuses the **already-hardened, Arabic-safe, corruption-tested** PDF rendering
  pipeline from the prior two passes instead of writing a second renderer — directly addresses your
  explicit instruction not to reintroduce the PDF.js font-corruption problem, because there is no
  new renderer for PPTX content at all. LibreOffice does real layout rendering (it's the same
  engine that opens the file when a person double-clicks it), so backgrounds, shapes, tables,
  fonts, and Arabic RTL text all come from genuine layout computation, not approximation.

## 4. What was verified, with real files, not assumed

I generated a real PPTX test matrix with `python-pptx` (backgrounds, a red rounded-rectangle shape
with border, a real 3×3 styled table, a green oval + connector line, Arabic RTL text mixed with
English/digits, a 4:3 dark-theme deck, a 20-slide deck, and a transparent-PNG-over-background
slide), then drove the **actual Electron app** over Chrome DevTools Protocol — not a synthetic
harness — through the real `Viewer.open()` code path, screenshotting the results.

**Confirmed working, by direct visual inspection of the rendered output:**
- Background color, exact shape position/fill/border/rounding — pixel-faithful (screenshots in
  this conversation show the coral rounded-rectangle "Important!" box in the exact position/size
  as authored).
- A real 3×3 table with header shading, borders, and cell text — rendered as an actual table, not
  reconstructed text.
- Shapes (oval, connector line) with correct fill/stroke/position.
- **Arabic RTL**: correct right-to-left paragraph direction, correctly joined Arabic glyphs, and
  mixed Arabic+English+digit text flowing correctly within one RTL line — no corruption.
- 4:3 aspect ratio preserved exactly (not stretched to 16:9) with a dark background intact.
- A 20-slide deck: correct page count, thumbnail rail lazily populated (verified via
  IntersectionObserver — not all 20 rendered at once).
- Transparent PNG alpha-composited correctly over its background slide color.
- **Fullscreen presentation mode**: black background, centered slide, no distortion, navbar/thumb
  rail hidden — confirmed via live `document.fullscreenElement` state and CSS computed styles, not
  just assumed from the CSS source.
- **Keyboard navigation**: ArrowLeft/ArrowRight, Home, End all verified via live keypress + counter
  state checks (not just wired up — actually pressed and the slide index checked after each).
- **ESC** exits fullscreen/presentation mode and returns to the normal viewer **without closing the
  file** — verified live (`document.fullscreenElement` false, `.dv-overlay.open` still true after
  ESC).
- **The extraction fallback** (for machines without LibreOffice, or if conversion fails for a
  specific file) still works and shows a clear, honest banner explaining the reduced fidelity —
  verified live by forcing the capability check to report unavailable.

**Two real bugs found and fixed during this live testing** (not found by reasoning about the code —
found by actually looking at the screenshots):
1. The slide counter read **backwards** ("3 / 1" instead of "1 / 3") because the counter span
   inherited the app's RTL text direction, and the Unicode bidi algorithm reordered the "N / M"
   numeric expression. Fixed with an explicit `direction:ltr` on `.dv-pptx-counter` — the same
   pattern the existing PDF page-number input already used, which I found by checking how that
   problem was already solved elsewhere in this codebase.
2. The prev/next **button order was visually reversed** relative to their arrow glyphs — RTL flex
   reordering flipped the button *order* but not the ◀/▶ *characters*, so ▶ ended up positioned
   where "previous" was. Fixed with `direction:ltr` on `.dv-pptx-navbar`, matching the universal
   media-player convention (prev-left, next-right) regardless of app language — exactly like
   PowerPoint's own controls, YouTube, etc.

## 5. Engine bundling, offline operation, licensing

- **Not bundled in this pass.** `server/services/officeConversionService.js` detects an
  **already-installed** LibreOffice at common OS paths (Windows: `Program Files\LibreOffice\...`
  and the `(x86)` variant; macOS: `/Applications/LibreOffice.app/...`; Linux: `/usr/bin/soffice`,
  `/usr/bin/libreoffice`), an admin-settable `SCHOOL_APP_SOFFICE_PATH` environment variable
  override, and finally a `where`/`which` PATH lookup. If none is found, `GET
  /api/office-conversion/capability` reports `available:false` and the viewer cleanly falls back to
  the text/image extraction with a clear "install LibreOffice for full preview" message — never a
  dead end.
- **Recommended follow-up (designed, not implemented)**: bundling a portable LibreOffice build via
  `electron-builder`'s `extraResources`, pointed to by
  `officeConversionService.candidatePaths()` as a first-priority path (checked before the OS-install
  paths). This is a legitimate, common pattern, but a portable Windows LibreOffice build is
  several hundred MB, isn't fetchable in this sandboxed environment (no general internet access),
  and — critically — **couldn't be meaningfully tested here** (this is a Linux sandbox; a bundled
  Windows binary can't be exercised). I'm not going to claim I tested something I structurally
  cannot test. What I verified instead is the *detection and invocation* logic end-to-end against
  a real LibreOffice install, which is the part that doesn't change whether the binary comes from
  a system install or a bundled copy — only the path differs.
- **Offline**: confirmed by construction — `execFile` invokes a local binary with local file paths
  only; no network code exists anywhere in `officeConversionService.js`. All four sample
  conversions in the test run happened with no network access from the container beyond the
  already-existing local Express server.
- **Licensing**: LibreOffice is licensed under the Mozilla Public License 2.0 (with some LGPL v3
  components). Both permit redistribution, including bundling inside a commercial product, without
  requiring your own application's source to be disclosed (MPL is file-level copyleft, not
  viral to the whole app; using LibreOffice as an external headless process — never linking its
  code into your binary — is an even more conservative, lower-risk integration than embedding it as
  a library). If you do proceed with bundling, keep LibreOffice's own license files alongside the
  bundled binary and include a "third-party notices" mention — standard practice, not a blocker.

## 6. Macro/script safety

`--headless` LibreOffice does not execute document macros by default, and no flag that would change
that is ever passed. The conversion runs with an isolated, per-conversion `-env:UserInstallation=`
profile directory (a fresh temp dir per conversion), so a malicious document can't leave anything
behind in a shared profile, and concurrent conversions can never lock/contend for the same profile
— a real, common LibreOffice headless failure mode this specifically avoids. A hard 90-second
timeout kills a hung/pathological conversion rather than leaving a process running indefinitely.
The temp working directory (profile + LibreOffice's own output copy) is deleted in a `finally`
block after every conversion attempt, success or failure.

## 7. Genuine limitations that remain

- **Animations and transitions are not reproduced** — PDF export is inherently static per slide.
  The *final* visual appearance of each slide is preserved (per your explicit priority), but
  build-in/build-out animation sequences are not. Basic slide-to-slide transitions in the viewer
  itself were not added in this pass (no explicit fade/slide effect between rendered slides) —
  flagged as a "nice to have," not implemented, to keep this pass focused on fidelity + navigation.
- **Legacy `.ppt` is deliberately untouched** — it still uses the existing "open externally"
  fallback. The same LibreOffice mechanism would work for it (LibreOffice reads `.ppt` natively),
  and extending `office-conversion` to `.ppt` is a small, low-risk follow-up, but your brief
  explicitly scoped this pass to PPTX and told me not to touch legacy-format handling unless
  required — so I left it as-is.
- **Charts/SmartArt**: rendered exactly as well as LibreOffice's own PDF export renders them (which
  is generally good — it's real chart rendering, not a stub), but any Office-specific SmartArt
  layout algorithm quirks that differ from LibreOffice's interpretation aren't something this
  architecture can control — that's an inherent property of using a non-Microsoft renderer, not a
  bug in this implementation.
- **First-open latency**: the first time a specific PPTX is opened, conversion takes a few seconds
  (2.1s for the test deck in this sandbox; larger/more complex decks will take longer). This is
  cached by content fingerprint (path+size+mtime) — every subsequent open of the same unchanged
  file is near-instant (3ms in testing). No progress percentage is shown during conversion, only a
  generic loading spinner — a reasonable addition for a future pass if very large decks make this
  feel slow.
- **Windows bundling is designed but not shipped** — see §5.

## 8. Files changed

| File | Change |
|---|---|
| `server/services/officeConversionService.js` | **New** — LibreOffice detection + secure PPTX→PDF conversion with caching |
| `electron/utils/paths.js` | Added `getOfficeConversionCacheDir()`, following the existing `getUploadsTmpDir()` pattern |
| `server/routes/files.js` | Added `GET /api/office-conversion/capability`, `POST /api/office-conversion/:code/:name`, `GET /api/office-conversion/pdf/:cacheKey` |
| `app/js/viewer.js` | `renderPptx()` is now a dispatcher (real rendering first, extraction fallback second); new `renderPptxPresentation()` (the single-slide presentation-mode viewer); old extraction code preserved, renamed `renderPptxExtraction()`, now shows a fidelity-warning banner; `onKeydown` gained presentation-mode navigation (arrows/PageUp/PageDown/Home/End/Space) and ESC-exits-fullscreen-not-viewer handling; `cleanupPrevious()` cleans up the presentation document/observers/listeners |
| `app/css/viewer.css` | New `.dv-pptx-*` rules for the presentation-mode layout, fullscreen state, and fallback banner |
| `app/js/file-support-policy.js` | `.pptx` entry updated: `preview.engine: 'office-conversion'`, `preview.fidelity: 'full-if-available'` (honest about the runtime-conditional nature of the fidelity) |
| `scripts/pptx-conversion-test.js` | **New** — 14 tests against real generated PPTX files and the real conversion pipeline |
| `scripts/file-support-policy-test.js` | One assertion updated for the new `pptx` fidelity value |
| `package.json` | Added `verify:pptx-conversion` script |

Nothing in `app/js/uploader.js`, `app/js/thumbnails.js`, `app/js/dialogs.js`,
`server/services/evidenceService.js`, or `server/services/evidenceWatcher.js` needed to change —
all continue to work exactly as before (verified — see §9).

## 9. Test matrix and results

| Test | Result |
|---|---|
| A. Simple PowerPoint | ✅ (rich-english-test, slide 1) |
| B. PowerPoint with background | ✅ (solid color background, dark theme) |
| C. PowerPoint with images | ✅ (transparent PNG test) |
| D. PowerPoint with shapes | ✅ (rounded rectangle, oval, connector line) |
| E. PowerPoint with tables | ✅ (3×3 styled table) |
| F. PowerPoint with charts | Not covered by a generated test file this pass — LibreOffice's PDF export renders charts natively (same code path as tables/shapes), but no chart-specific sample was built/verified. Flagged, not claimed. |
| G. Arabic PowerPoint | ✅ (RTL, correct shaping, verified live) |
| H. English PowerPoint | ✅ |
| I. Arabic + English mixed | ✅ (single line mixing both plus digits) |
| J. Dark theme | ✅ |
| K. Light theme | ✅ |
| L/M/N. Aspect ratios (16:9, 4:3) | ✅ both verified, no stretching |
| O/P. Many-slide / large presentation | ✅ (20 slides; page-count sanity-checked independently of pdf.js via raw PDF object scan) |
| Q/R. Custom/embedded fonts | Not specifically isolated as a test case this pass (the Arabic test uses a non-default font family via LibreOffice's own font substitution) — no dedicated embedded-font-subset test file was built. |
| S. Transparent images | ✅ |
| T. Complex layouts | Covered by the combined rich-English deck (background+shape+text together); no maximally-complex stress file was built. |

**145 → 159 total automated tests passing** (84 pre-existing + 61 file-support-policy + 14 new
PPTX-conversion tests), plus the live-UI checks in §4.

## 10. PDF regression — confirmed passed

Re-opened the exact `Compilers-01-Finals_2025.pdf` that previously showed the "C ou rse D e ta ils"
corruption, through the real UI, after all changes in this pass. Screenshot confirms it still
renders correctly — the fix from the prior pass is untouched and intact. `verify:pdf-render-order`
(4/4) and the full pdf.js/Electron test suites also re-ran clean.

## 11. DOCX/XLSX/image regression — confirmed passed

`sample.docx`, `sample.xlsx`, and `sample.jpg` all re-opened through the real UI after this pass's
changes and render identically to before (screenshots captured) — zero console errors.

## 12. Exact commands to run the project

```bash
bash POST-EXTRACT-CLEANUP.sh
rm -rf node_modules
npm ci
npm run verify:server
npm run verify:viewer
npm run verify:part2
npm run verify:pdf-render-order
npm run verify:file-support-policy
npm run verify:pptx-conversion
node scripts/part2-remaining-test.js
node scripts/completion-engine-test.js
npm run dev
```

**Note**: `verify:pptx-conversion` requires LibreOffice to be installed on the machine running the
tests (it exercises real conversion) — if absent, that one suite will fail at its first check with
a clear message; every other suite is unaffected.

## 13. Exact commands to package the application

Unchanged from the existing project convention — no packaging config changed in this pass beyond
what `electron-builder`'s existing `files: ["server/**/*", ...]` glob already picks up
automatically (the new service/route files are under `server/`, already included):
```bash
npx electron-builder --win nsis   # or your existing packaging script/target
```
If you decide to bundle a portable LibreOffice per §5's recommended follow-up, that would add an
`extraResources` entry pointing at the bundled binary — not done in this pass.
