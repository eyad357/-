# PDF Subsystem — Architecture Review & Redesign

## 1. What I actually did before touching anything

I cloned `https://github.com/eyad357/-.git` and read, in order:

- `app/index.html` (script loading, ES-module bridge for `pdfjsLib`, CSP)
- `app/js/viewer.js`, `app/js/thumbnails.js`, `app/js/dialogs.js` — every place that touches `pdfjsLib`
- `app/js/vendor/pdfjs/pdf.min.js` and `pdf.worker.min.js` (version strings, exported symbols)
- `app/js/vendor/pdfjs/cmaps/` and `standard_fonts/` (asset completeness)
- `electron/**`, `server/app.js` (how the app is loaded, CSP, static file serving, packaging/`asar` behavior)
- `package.json` (Electron version, build config)
- `PDF-RENDERING-NOTES.md` and `git log` (history of prior PDF fixes)

This was necessary before proposing any redesign, and it changed the plan: the codebase is **not** a demo — it already has a
reasonably serious architecture (Express-served renderer over `http://127.0.0.1`, so packaging/asar path issues that plague a
lot of Electron+PDF.js setups don't apply here; lazy per-page rendering with `IntersectionObserver`; devicePixelRatio-aware
canvas rendering for crisp Arabic/Latin text). The real problem was narrower than "everything is broken" — it was a **single,
specific, recurring architectural violation**, described below.

## 2. Root cause analysis

### The error you pasted
```
TypeError: this[#Oa].getOrInsertComputed is not a function
  WorkerTransport.getOptionalContentConfig / PDFPageProxy.render
```
`getOrInsertComputed` is a very new `Map`/`WeakMap` method (TC39 "Upsert" proposal). I searched the entire repository —
including both `pdf.min.js` and `pdf.worker.min.js` — and **this string does not appear anywhere in the current code**.
Both vendor files are pinned to pdf.js **4.10.38**, a version whose shipped code does not call that method. The most likely
explanation: this error was produced by an *earlier* state of the project (a mismatched pair of pdf.js builds — e.g. main
thread on one version/nightly, worker on another), and it was already resolved by the point-in-time hotfix visible in
`index.html`'s "Hotfix: pdf.js upgraded to 4.10.38 ... loaded as ES module" comment and confirmed by `git log`
(`b5629fc`, `dc876d3`). I'm telling you this plainly rather than pretending to re-fix a bug I can't reproduce in your
current code — if you can still reproduce it, it means something in your build/packaging step is pulling in a different
pdf.js build than what's in `app/js/vendor/pdfjs/`, and the fix below removes the *structural* opening for that to
happen again.

### The real, currently-present problem
`pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdfjs/pdf.worker.min.js'` and the full `pdfjsLib.getDocument({...})`
options object (cmap path, standard-fonts path, `disableFontFace`, `useSystemFonts`, `fontExtraProperties`,
`isEvalSupported`) were **independently duplicated in three files**: `viewer.js`, `thumbnails.js`, and `dialogs.js`.

This is exactly the shape of bug that produces version-mismatch-class errors like the one you saw: pdf.js hard-requires
that the code running on the main thread and the code running in the worker are the *same build*, and it requires
`getDocument()`'s options to be consistent (cmap/font paths especially — get those wrong in only one call site and you get
correct rendering in the viewer but broken/garbled text in thumbnails, or vice versa). Nothing enforced that the three
copies stayed identical as the app evolved. Two commits in your `git log` already show this cost: a change to
`disableFontFace` made in one place caused a "fixed Arabic in file A, broke numbers in file B" regression, because the
option was being set independently per call site instead of in one governed location.

## 3. The fix: single source of truth

**New file: `app/js/pdf-engine.js`** — the only place in the app allowed to:
- set `pdfjsLib.GlobalWorkerOptions.workerSrc`
- call `pdfjsLib.getDocument(...)`
- know the cmap/standard-fonts paths
- decide what a pdf.js exception means for the user (centralized, Arabic, business-appropriate error messages —
  technical detail goes to `console.error` only, per your requirement #5)
- destroy/cleanup a `PDFDocumentProxy` (requirement #6 — every `openDocument()` caller now has one obvious
  `PDFEngine.destroyDocument()` counterpart)

It exposes: `openDocument()`, `openDocumentLite()` (skips cmap/font loading for the page-count-only case in
`dialogs.js`), `destroyDocument()`, `renderPageToCanvas()` (shared devicePixelRatio-scaling logic), and
`renderThumbnailDataUrl()`.

**Files to modify, and why:**

| File | Change | Why required |
|---|---|---|
| `app/index.html` | Load `js/pdf-engine.js` once, before `viewer.js` | Single load-order-guaranteed entry point |
| `app/js/viewer.js` | `renderPdf()` now calls `PDFEngine.openDocument()` instead of configuring pdf.js itself; per-page render now calls `PDFEngine.renderPageToCanvas()`; cleanup calls `PDFEngine.destroyDocument()`; error handling shows `err.friendlyTitle` / `err.friendlyDetail` | Removes duplicated config; centralizes errors/cleanup |
| `app/js/thumbnails.js` | `generatePdfThumb()` is now a 4-line wrapper around `PDFEngine.renderThumbnailDataUrl()` | Removes duplicated config; ~25 lines of duplicated logic deleted |
| `app/js/dialogs.js` | PDF properties panel now calls `PDFEngine.openDocumentLite()` / `PDFEngine.destroyDocument()` | Removes duplicated config |

**Not touched, deliberately:** `electron/**`, `server/app.js`, IPC, preload. I verified none of them reference PDF.js at
all — the entire PDF pipeline is renderer-side, fetched over the same-origin Express server, so there's no packaging/path
risk to fix there (this is already a sound design; changing it would add risk for no benefit).

## 4. Requirement-by-requirement status

1. **Single source of truth** — done: `pdf-engine.js` is now the only file with pdf.js configuration/loading/error/cleanup logic.
2. **Version consistency** — `PDFJS_VERSION` constant in `pdf-engine.js` is checked against the loaded `pdfjsLib.version` at
   runtime and logs loudly on mismatch; the "how to upgrade" steps are documented in the file header.
3. **Worker architecture** — unchanged mechanism (classic `Worker`, same-origin, CSP already permits it via `script-src 'self'`
   since `worker-src` isn't set and falls back to `script-src`), but now configured in exactly one place.
4. **Fonts (Arabic/English/RTL/LTR/CID/standard_fonts/CMaps)** — asset directories verified complete (169 cmap files, 16
   standard font files); `disableFontFace` left at pdf.js's default per the still-open investigation in
   `PDF-RENDERING-NOTES.md` — I did not touch that judgment call, since reversing it again without a reproducing sample
   file would just repeat the same regression pattern documented in your git history.
5. **Error handling** — centralized in `PDFEngine.classifyError()`; friendly Arabic messages only, technical detail to
   `console.error`.
6. **Memory management** — every `openDocument()` has a corresponding `destroyDocument()` call at all three sites now, and
   `renderThumbnailDataUrl()` guarantees cleanup via `finally`.
7. **Performance** — existing lazy per-page rendering (`IntersectionObserver`) and devicePixelRatio-aware canvas sizing were
   already solid; left in place, just moved the shared scaling logic into `PDFEngine.renderPageToCanvas()` so it can't drift
   between call sites.
8. **Maintainability** — upgrading pdf.js now means: replace both vendor files with a matching pair, bump `PDFJS_VERSION`,
   refresh `cmaps/`/`standard_fonts/` — nothing else changes.
9. **Enterprise packaging** — verified: assets are served over HTTP by Express from the app directory (asar-transparent via
   Electron's patched `fs`), so there's no relative-path breakage after packaging. No changes were needed here.

## 5. What's in this archive

```
app/index.html          (script tag added for pdf-engine.js)
app/js/pdf-engine.js     (new — single source of truth)
app/js/viewer.js         (refactored to use PDFEngine)
app/js/thumbnails.js     (refactored to use PDFEngine)
app/js/dialogs.js        (refactored to use PDFEngine)
PDF-ARCHITECTURE-REVIEW.md (this file)
```

Extract over your existing repository root, then:
```bash
git add .
git commit -m "Enterprise PDF subsystem redesign: single source of truth (pdf-engine.js)"
git push
```

All four JS files pass `node --check`. No new dependencies, no version changes to pdf.js itself (still 4.10.38 — I did not
find a reason in your actual codebase to change it, and swapping vendor libraries without a reproducing failure case would
be exactly the kind of unverified change your notes already flag as having caused a regression once).

## 6. Honest limitations of this pass

- I could not reproduce `getOrInsertComputed` in your current code, so I can't claim to have "fixed" that specific stack
  trace — I've removed the structural cause of *that class* of bug (config/version drift between call sites). If you can
  still reproduce it, please tell me the exact repro (a specific PDF file + build/packaging steps) — that would point to
  something outside the files I reviewed (e.g., a stale build cache, or a second pdf.js copy bundled elsewhere).
- The Arabic font-rendering investigation referenced in `PDF-RENDERING-NOTES.md` is still open; I didn't change
  `disableFontFace` without a reproducing sample, per the lesson already recorded in your own commit history.
