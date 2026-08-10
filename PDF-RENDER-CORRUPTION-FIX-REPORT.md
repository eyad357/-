# PDF Rendering Corruption — Root Cause, Fix, and Verification

This is the third and final report in this migration (single-source-of-truth refactor →
Electron 43/pdf.js 6.2.108 migration → this: the glyph-spacing corruption fix). It
supersedes nothing in the previous two — the architecture and version pins from those
passes are unchanged and still verified intact (§6).

## 0. Run this after extracting

```bash
bash POST-EXTRACT-CLEANUP.sh
```

## 1. Root cause

**Rendering a PDF page into a `<canvas>` that is already attached to the live document
makes Chromium take a different native-font rasterization path than rendering into an
off-DOM canvas.** For PDFs containing certain embedded TrueType fonts with broken/unusual
hinting programs, that path corrupts glyph advance widths — letters render with scattered
extra gaps mid-word ("C ou rse D e ta ils !"). The identical render call into a detached
canvas, attached to the page only after rendering finishes, is always correct.

This was confirmed by direct A/B testing, not inferred:

- The uploaded `Compilers-01-Finals_2025.pdf` triggers a pdf.js console warning,
  `TT: undefined function: 21` — the font's embedded hinting bytecode calls an
  instruction pdf.js's (and, evidently, Chromium's) hinting interpreter doesn't handle
  cleanly.
- Poppler (a completely independent, non-pdf.js renderer) renders the same file
  perfectly — proving the PDF itself isn't corrupt.
- Calling `PDFEngine` directly against a detached canvas rendered the same file
  perfectly, at every scale tested (0.5×–3.0×) — proving pdf.js 6.2.108 itself isn't
  broken, and ruling out scale/zoom/devicePixelRatio as the cause.
- Concurrent rendering (the same page twice; all 31 pages of the deck at once) was
  tested and ruled out.
- Waiting for `document.fonts.ready` before rendering was tested and ruled out (not a
  font-loading race).
- The **only** variable that reproduced the corruption in an otherwise-identical,
  minimal test was whether the canvas was already inserted into the document when
  `page.render()` was called.

### Why `disableFontFace` is not the fix

`disableFontFace: true` forces pdf.js's own internal glyph-path renderer, bypassing the
browser's native `@font-face` rasterizer entirely — and it does fix the English file.
But tested against the real uploaded Arabic file
(`موقع__اقرار_المتدرب_رواد_مصر_الرقمية_R5__4_.pdf`), it breaks Arabic letter joining:
glyphs render disconnected instead of properly shaped/connected. A LibreOffice-generated
Arabic test file was fine either way, but the real uploaded file was not. This is the
same tension your prior developer already hit and documented in `PDF-RENDERING-NOTES.md`,
approached from the opposite direction — confirming that **no single global
`disableFontFace` value is correct for all real-world PDFs**, and this needed an
architectural fix, not a config tweak. `disableFontFace` is left at its default (`false`)
throughout.

## 2. The fix

Render off-DOM, then attach the finished canvas. No tradeoff, no per-file/per-font logic.

**`app/js/pdf-engine.js`** — `PDFEngine.renderPageToCanvas()` now documents this as a hard
contract in its header comment, and adds a runtime guard:
```js
if (canvas.isConnected) {
  console.warn('[PDFEngine] renderPageToCanvas called on a canvas already attached ...');
}
```
This doesn't block rendering (some future legitimate use might still work), but it makes
a future regression loud and immediate in the console instead of silently corrupting
some subset of uploaded PDFs.

**`app/js/viewer.js`** — two call sites had this bug and are both fixed:

1. `renderOne()` (main page rendering): previously created the canvas, inserted it into
   `wrap`, *then* rendered into it. Now renders into a detached canvas first, and only
   inserts it once `task.promise` resolves.
2. `buildPdfThumbnails()` (the in-viewer sidebar page thumbnails — distinct from the
   file-manager's `thumbnails.js`): previously built the canvas via `innerHTML` (which
   attaches it immediately) and rendered into it in place with a raw `page.render()`
   call, duplicating logic outside `PDFEngine`. Now renders into a detached canvas via
   `PDFEngine.renderPageToCanvas` (single source of truth, and picks up
   devicePixelRatio scaling for sharper sidebar thumbnails as a side benefit) and
   appends it only after rendering completes.

`thumbnails.js` (file-manager thumbnails) and `dialogs.js` (page-count only) were
**not** touched — both already only ever create fully detached canvases via
`PDFEngine.renderThumbnailDataUrl()` / never render at all, so neither was ever exposed
to this bug. Verified by re-reading both files and by a new automated check (§4).

## 3. Two smaller bugs fixed along the way

While building the live A/B tests above, two real bugs surfaced that hadn't been
exercised by prior testing:

1. **`PDFEngine.classifyError()` threw instead of classifying.** It checked
   `err instanceof pdfjsLib.MissingPDFException` / `UnexpectedResponseException` —
   both existed in pdf.js 4.x and were removed in 6.x, so the check was
   `instanceof undefined`, which throws. Any actual PDF-open failure (not just the
   rendering bug above) would have hit this and shown a raw JS error instead of the
   intended friendly message. Fixed with a `typeof Ctor === 'function'` guard before
   each `instanceof` check, so a future pdf.js exception-class rename degrades
   gracefully instead of throwing.
2. Confirmed (from the previous pass, still intact): `PDFDocumentProxy.destroy()` was
   removed in pdf.js 6.x in favor of `doc.loadingTask.destroy()` — `destroyDocument()`
   already handles both shapes.

## 4. New regression test

`scripts/pdf-render-order-test.js` (wired up as `npm run verify:pdf-render-order`)
statically checks the source for this exact bug class: it verifies `renderOne()` and
`buildPdfThumbnails()` always call `PDFEngine.renderPageToCanvas` before any DOM-attach
call, and that `PDFEngine.renderPageToCanvas` still has the `canvas.isConnected` guard.
It doesn't need a browser (no new dependency), so it runs anywhere the existing test
suite does.

**Verified the test actually catches the regression**, not just that it passes: I
temporarily reverted `renderOne()` to the old (attach-before-render) order, ran the
test, confirmed it failed with a clear message pointing at the exact problem, then
restored the fix and confirmed it passed again.

## 5. Verification performed (real execution)

1. **Root-cause isolation**, all via live Electron 43.3.0 + pdf.js 6.2.108, driven over
   Chrome DevTools Protocol (not simulated):
   - Poppler cross-check on both real uploaded files (independent renderer).
   - Direct `PDFEngine` calls on detached canvases, multiple scales (0.5×–3.0×).
   - Concurrent-render tests (same page ×2; all 31 pages at once).
   - `document.fonts.ready` test.
   - DOM-attached vs. detached canvas — the isolating test.
   - `disableFontFace` A/B test across both real files plus two LibreOffice-generated
     control files (English and Arabic).
2. **Fix verification** against the **real uploaded files**, through the actual
   `Viewer.open()` code path (uploaded via the real evidence-folder file-watcher flow,
   not a synthetic API call) — not just the isolated engine calls:
   - `Compilers-01-Finals_2025.pdf`, page 2 ("Course Details!") and page 3
     ("Table of contents") — clean at 100% zoom (matching your original screenshot's
     zoom level exactly) and swept 0.5×–3.0×.
   - `موقع__اقرار_المتدرب_رواد_مصر_الرقمية_R5__4_.pdf` — clean at 100% zoom, correct
     Arabic joining preserved.
   - Zero console errors, zero "fake worker" warnings, in both cases.
3. **Full existing test suite**, unmodified logic, run against the fixed code:
   `verify:server` 15/15, `verify:viewer` 19/19, `verify:part2` 11/11 — 45/45 passing.
4. **New regression test**: `verify:pdf-render-order`, 4/4 passing, and confirmed to
   actually fail on the old code (§4).
5. **Packaged production build**, not just `npm run dev`: ran a real
   `electron-builder` build, inspected the resulting `.asar` with `asar list` —
   confirmed `pdf-engine.js`, `pdf.min.mjs`, `pdf.worker.min.mjs`, all 169 cmap files,
   all 16 standard-font files, and `splash/splash.html` are present, and confirmed via
   `diff` against the pristine pre-migration repo that **no stale pdf.js 4.10.38 files
   remain** anywhere in the source tree (only in the cleanup script's removal list, for
   your existing working copy). Then launched the **packaged binary itself**
   (`school-accreditation-system`, not the dev source tree), reconnected over CDP, and
   re-ran the real `Compilers-01-Finals_2025.pdf` end to end — identical clean result.
6. **Confirmed the Electron 43 / pdf.js 6.2.108 migration remains intact**: version
   strings checked live (`Electron/43.3.0`, `pdf.js 6.2.108`), no version was
   downgraded, no architecture was reverted.

## 6. Single source of truth — current state

Confirmed by re-reading every PDF-touching file in the app:

- `pdfjsLib.GlobalWorkerOptions` and `pdfjsLib.getDocument(...)` are called **only**
  inside `app/js/pdf-engine.js`.
- `viewer.js`, `thumbnails.js`, and `dialogs.js` all consume `PDFEngine`'s public API
  (`openDocument`, `openDocumentLite`, `renderPageToCanvas`, `renderThumbnailDataUrl`,
  `destroyDocument`, `classifyError`) — none build their own `getDocument` options
  object or duplicate worker/version/font configuration.
- Version pin (`PDFJS_VERSION = '6.2.108'`), asset paths, and the render-off-DOM
  contract all live in exactly one place.

## 7. Known limitations

- **This is a real Chromium behavior difference, not a documented pdf.js API
  contract** — I have direct, reproducible evidence of it (§1) but no upstream
  Chromium/pdf.js issue number to cite, since I can't search their issue trackers from
  this environment. If you want to report it upstream, the repro is: render a PDF page
  containing an embedded TrueType font with a `TT: undefined function` warning into an
  attached vs. detached canvas at the same scale and compare.
- Tested against exactly the two real files you provided, plus generated Arabic/English
  Word and LibreOffice controls. I have not tested scanned/OCR-only PDFs, LaTeX/Beamer
  output, or CFF/OpenType-CFF embedded fonts specifically — the fix is architectural
  (applies to every render call, not keyed to any file property), so I'd expect it to
  generalize, but "verified against your full range of real school uploads" is a claim
  only continued production use can close out.
- This sandbox has no display; verification used Xvfb + CDP, including pixel-level
  screenshot inspection of both real files, but not manual interactive use of the app.
- Windows/macOS packaged builds were not produced or tested here (Linux-only sandbox).
  The packaging config verified (`electron-builder`'s `files`/`asar` settings) is
  platform-independent, but a real Windows build+run before shipping to schools is
  still worth doing, since I can't do that here.
