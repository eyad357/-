# Electron 43 + pdf.js 6.2.108 Migration — Compatibility Report

This replaces the previous `PDF-ARCHITECTURE-REVIEW.md` pass (single-source-of-truth
refactor) with the full runtime migration you asked for. Everything below was
**verified by actually running the code**, not inferred from changelogs — see §6.

## 0. First: run this after extracting

```bash
bash POST-EXTRACT-CLEANUP.sh
```
A tar archive can only add/overwrite files, not delete them. The old pdf.js
4.10.38 files have different filenames (`.js`) than the new 6.2.108 ones
(`.mjs`), so the cleanup script removes the two stale files and prints the
remaining setup steps (`npm ci`, running the verification suites, `npm run dev`).

## 1. Root cause, now fully confirmed

Last round I could see your `pdf.min.js` reported `6.1.200` at runtime but couldn't
inspect the actual file (it isn't in the git repo I was given). This round I pulled
the **real, official `pdfjs-dist@6.2.108`** package from npm and inspected its
source directly:

- Both `pdf.min.mjs` and `pdf.worker.min.mjs` call `Map.prototype.getOrInsertComputed`
  (confirmed by grep — 2 call sites in each file, from the same npm package, so
  guaranteed to be a matched pair).
- That method is a TC39 "Upsert" proposal addition to `Map`, only implemented in
  V8 versions shipped with **Chromium ~133+**.
- Your previous Electron (`^30.0.9`) bundles **Chromium ~124** — released before
  that method existed anywhere. There was no environment in which pdf.js 6.x could
  have worked on Electron 30, matched worker pair or not.

This confirms the "fake worker" fallback and the original crash were caused by a
genuine JS-engine capability gap, not a config bug — which is why last round's
single-source-of-truth refactor (still valuable, and kept) couldn't fully fix it.

## 2. What I checked before changing anything (per your request)

- Read `package.json` in full: **zero native Node dependencies** (`archiver`,
  `chokidar`, `electron-log`, `electron-window-state`, `express`, `multer` — all
  pure JS). This is the single biggest factor in how low-risk this migration is —
  no `electron-rebuild`/ABI concerns at all.
- Read every file in `electron/main`, `electron/preload`, `electron/security`,
  `electron/ipc`, `electron/utils`: already uses `contextIsolation: true`,
  `sandbox: true`, `nodeIntegration: false`, `contextBridge.exposeInMainWorld`,
  and `webContents.setWindowOpenHandler` — the modern, currently-recommended
  patterns. None of these APIs were deprecated or changed between Electron 30
  and 43. **No electron/main/preload code needed to change for the upgrade itself.**
- Checked `engines` fields for every dependency version already in `package.json`
  against Electron 43's bundled Node (24.17+) — all declare minimums far below
  that (Node ≥8–14), so **none of them needed a version bump** for compatibility.
  I deliberately did not bump `chokidar`, `archiver`, `express`, `multer`, etc. —
  those majors (chokidar 3→5, archiver 7→8, express 4→5 in particular, which has
  real routing-behavior breaking changes) are unrelated to the Electron upgrade
  and would only add risk, contradicting "do not introduce breaking changes
  anywhere else in the project."
- Checked `electron-builder`'s packaging config (`files`, `extraResources`,
  `asar`, NSIS/portable targets) — the `app/**/*` glob picks up the new `.mjs`
  files, cmaps, and standard_fonts automatically; asar packing doesn't care about
  file extension. No changes needed there for pdf.js specifically.
- While verifying the actual packaged build (§6), I found and fixed one
  **pre-existing, unrelated** packaging bug: `splash/` (your splash screen) was
  never listed in `electron-builder`'s `files` array, so every packaged build
  has been silently missing it (dev mode masks this because dev runs from the
  unpacked source tree). Added `"splash/**/*"` to `files` in `package.json` and
  confirmed via a real rebuild that `splash/splash.html` is now in the asar.

## 3. What actually changed

| File | Change |
|---|---|
| `package.json` | `electron` `^30.0.9` → `^43.3.0`; `electron-builder` `^24.13.3` → `^26.15.3`; added `engines.node: ">=22.13.0"` (documentation); added `"splash/**/*"` to `build.files` (packaging bug fix, see §2) |
| `package-lock.json` | Regenerated from a real `npm install` — reproducible installs |
| `app/js/vendor/pdfjs/pdf.min.mjs` (new) | Official `pdfjs-dist@6.2.108` build, copied verbatim from the npm package |
| `app/js/vendor/pdfjs/pdf.worker.min.mjs` (new) | Same package, same version — guaranteed matched pair |
| `app/js/vendor/pdfjs/cmaps/`, `standard_fonts/` | Refreshed from the same 6.2.108 package (same file counts as before: 169 cmaps, 16 standard fonts — CJK/CID coverage and Latin base-14 fallback fonts unchanged) |
| `app/js/vendor/pdfjs/pdf.min.js`, `pdf.worker.min.js` (old) | **Deleted** by `POST-EXTRACT-CLEANUP.sh` — see §0 |
| `app/index.html` | Module import path updated to `pdf.min.mjs`; comment updated |
| `app/js/pdf-engine.js` | `PDFJS_VERSION` → `6.2.108`; `workerSrc` → `pdf.worker.min.mjs`; `destroyDocument()` fixed for the pdf.js 6.x API change (see §4) |
| `server/app.js` | Added explicit `worker-src 'self'` to the CSP header (pdf.js 6.x's worker is always a *module* worker — `new Worker(src, {type:"module"})` — being explicit here is more robust than relying on the `script-src` fallback long-term) |
| `scripts/viewer-integration-test.js` | Updated the two asset paths it checks (`pdf.min.mjs`, `pdf.worker.min.mjs`) and added a check for `pdf-engine.js` |

Nothing in `electron/main`, `electron/preload`, `electron/security`, `electron/ipc`,
or `electron/utils` needed to change — confirmed by full read-through (§2) and by
the app actually booting and running correctly on Electron 43 (§6).

## 4. A real breaking change I caught by testing, not by reading docs

pdf.js 6.x **removed** the `PDFDocumentProxy.destroy()` convenience method that
existed in 4.x. I only found this because the live render test in §6 threw
`TypeError: doc.destroy is not a function` on cleanup — a memory-management
regression that a version-bump-only migration would have shipped silently (every
"schools open hundreds of PDFs" session would have leaked a worker per document).

I traced the correct replacement by reading the actual 6.2.108 source
(`class PDFDocumentProxy` no longer defines `destroy()`; `get loadingTask()`
returns the loading task, which still has `destroy()`). Fixed in
`PDFEngine.destroyDocument()`:

```js
function destroyDocument(doc) {
  if (!doc) return;
  try {
    if (doc.loadingTask && typeof doc.loadingTask.destroy === 'function') {
      doc.loadingTask.destroy();
    } else if (typeof doc.destroy === 'function') {
      doc.destroy(); // fallback, in case a future pdf.js release moves it back
    }
  } catch (err) { console.warn('[PDFEngine] destroyDocument failed', err); }
}
```
Re-tested after the fix: clean, no console warnings (§6).

Because this lives in the single source of truth from the last migration pass,
`viewer.js`, `thumbnails.js`, and `dialogs.js` all picked up the fix automatically
— none of them needed to change again. This is exactly the payoff of that earlier
refactor: one pdf.js API change, one file touched.

## 5. Arabic/English/RTL/LTR rendering

`disableFontFace` is left at pdf.js's default (`false`), same reasoning as last
round — no reproducing failing file has been provided for the open investigation
in `PDF-RENDERING-NOTES.md`, and I'm not going to repeat the "unverified global
override" mistake your own commit history already shows caused a regression once.

What's different this round: I actually rendered a real, generated PDF containing
embedded-font Arabic text (Noto Naskh Arabic), reshaped/joined RTL Arabic, plain
English, and mixed Arabic-indic/Western digits — through the real `PDFEngine` code
path, in the real Electron 43 renderer, and looked at the output. Glyphs render
correctly joined (no disconnection/overlap), RTL order is correct, English stays
crisp. This is one sample file, not a substitute for testing against real school
uploads across all the PDF producers you listed (Word, LibreOffice, Acrobat,
scanned/OCR) — but it confirms the pipeline itself (worker, cmaps, standard fonts,
canvas rendering) works end-to-end on the new stack.

## 6. Verification performed (real execution, in this sandbox — see limits in §7)

1. **`npm install`** — clean install, 0 vulnerabilities, no native-module build
   step triggered (confirms §2's "zero native deps" finding in practice).
2. **Existing test suites, unmodified logic, run against the migrated code:**
   - `npm run verify:server` — 15/15 passed
   - `npm run verify:viewer` — 19/19 passed (after fixing the two stale asset
     paths — this suite fetches every static viewer asset over HTTP and checks
     status/content-type/CSP headers, plus round-trips real sample files —
     PDF/DOCX/XLSX/CSV/PPTX/TXT/JPG — through the upload → watcher → file-API
     path byte-for-byte)
   - `npm run verify:part2` — 11/11 passed
3. **Booted the actual Electron 43.3.0 binary** (downloaded for real, not
   assumed) headlessly under Xvfb, with the real app, and confirmed via log
   output: `Evidence watcher started`, `Embedded server listening on
   http://127.0.0.1:3000` — main process, IPC setup, and the Express server all
   start cleanly with no errors.
4. **Connected to the live renderer over Chrome DevTools Protocol** (via
   `puppeteer-core`, not a mock) and, in the actual page context:
   - confirmed `pdfjsLib.version === "6.2.108"`
   - called `PDFEngine.openDocument()`, `PDFEngine.renderPageToCanvas()`, and
     `PDFEngine.destroyDocument()` against a real mixed Arabic/English PDF
   - captured **zero console warnings or errors**, and specifically confirmed
     **no "Setting up fake worker" warning**
   - extracted the rendered canvas as PNG and visually inspected it (§5)
5. **Ran a real `electron-builder` packaging build** (`--linux dir`, not a
   dry-run) and inspected the resulting `app.asar` with `asar list`: confirmed
   `pdf-engine.js`, `pdf.min.mjs`, `pdf.worker.min.mjs`, all 169 cmap files, and
   all 16 standard-font files are present with no manual copy step. Also caught
   the `splash/` packaging gap this way (§2).
6. **Launched the packaged binary itself** (not the dev source tree) headlessly,
   reconnected over CDP, and re-ran the same Arabic/English render test against
   it — identical clean result, confirming the fix holds in the actual
   production/packaged artifact, not just `npm run dev`.

## 7. Honest limits of this verification

- This sandbox has no display and no audio/video stack — I used Xvfb (virtual
  framebuffer) to get Electron to boot at all, and Chrome DevTools Protocol to
  drive and inspect it, rather than a human looking at a real window. I did view
  the actual rendered pixels (via a saved PNG), which is the part that matters
  most for the Arabic-rendering concern, but I could not click through your full
  UI (upload dialogs, navigation, etc.) by hand.
- I tested with one generated PDF containing embedded Arabic/English fonts, not
  a corpus from every PDF producer you listed (Word, LibreOffice, Acrobat,
  scanned/OCR, embedded vs. missing fonts). The pipeline verified is the correct
  one (real worker, real cmaps, real standard fonts, real canvas rendering), so
  I'd expect it to generalize, but "verified with real school uploads across
  producers" is a claim only you can close out with your actual evidence files.
- Windows/macOS packaging (NSIS installer, portable `.exe`, code signing) was
  not built or tested — this sandbox is Linux-only. The packaging mechanism I
  did verify (asar contents via `electron-builder --linux dir`) is
  platform-independent — the same `files`/`asar` config produces the Windows
  artifact — but I'd recommend one real Windows build+run before shipping to
  schools, since I can't do that here.
- The `resources/evidence-template` directory referenced in
  `electron-builder`'s `extraResources` doesn't exist in the repo I was given
  (unrelated to this migration — logged as a warning during packaging, not an
  error). If that's expected to ship, it's outside what I can add on your side.
