# File Support Architecture — Report

## 0. Run this after extracting

```bash
bash POST-EXTRACT-CLEANUP.sh
```
See that script's output for the prerequisite note about the prior two delivery passes.

---

## A. Architecture summary

**Before:** file-type knowledge (which extensions are supported, what category/icon/label
they get, whether they can be previewed) was independently hand-maintained in **seven
places**: `server/services/evidenceService.js` (`CATEGORY_BY_EXT`), `app/js/viewer.js`
(`EXT_MAP` + `TYPE_ICON` + `TYPE_LABEL`), `app/js/file-grid-controls.js`
(`FILTER_EXT_MAP` + `FILTER_LABELS`), `app/index.html` (`FILE_ICONS` + `isImage()` +
`BG_CLASS`), `app/js/dialogs.js` (a `TYPE_LABEL` map), and `app/js/indicator-extras.js`
(`CATEGORY_LABEL` + `CATEGORY_ICON`). This is more than the original audit found — a
full repo-wide grep (per your explicit checklist) turned up the last four during this
pass. They had drifted: different emoji for the same file type in different screens,
`.svg` missing from one image-check but present in another, and a real latent bug in
`indicator-extras.js` where its keys (`'ppt'`, `'other'`) never matched what the server
actually sends (`'powerpoint'`, `'file'`) — so PowerPoint/archive/unclassified files'
stat chips silently fell back to a generic icon. There was also **no upload validation
of any kind** — the backend accepted any `Content-Type`, any extension, up to 200MB,
with zero allow-list.

**After:** one module, `app/js/file-support-policy.js`, is now the only place any of
that is defined. It's a small UMD wrapper (`if (module.exports) ... else
root.FileSupportPolicy = ...`) — no bundler, no build step, loaded as a classic
`<script>` in the browser and `require()`d in Node, matching how `pdf-engine.js`
already works in this codebase. All seven old tables are deleted; every consumer now
calls into this module instead.

For each extension, the policy records: `category`, `mimeTypes`, `upload.allowed`,
`maxSizeBytes`, `preview.{supported, engine, fidelity}`, `contentExtraction.supported`,
`thumbnail.{supported, engine}`, `search.supported`, `ocr.supported`, `displayNameAr`,
`fallback`, and (where practical) a magic-byte `signature`.

---

## B. Supported-format matrix

*(fidelity: F = full, P = partial, — = no preview)*

| Ext | Category | Upload | Preview | Fidelity | Extraction | Thumbnail | Search | Max size | Fallback |
|---|---|---|---|---|---|---|---|---|---|
| .pdf | pdf | ✅ | ✅ pdfjs | F | ✅ | ✅ | ✅ | 100 MB | preview |
| .docx | word | ✅ | ✅ mammoth | F | ✅ | — | ✅ | 25 MB | preview |
| .doc | word | ✅ | ❌ | — | ❌ | — | ❌ | 25 MB | **external-open** |
| .rtf | word | ✅ | ❌ | — | ❌ | — | ❌ | 25 MB | external-open |
| .odt | word | ✅ | ❌ | — | ❌ | — | ❌ | 25 MB | external-open |
| .xlsx | excel | ✅ | ✅ SheetJS | F | ✅ | — | ✅ | 25 MB | preview |
| .xls | excel | ✅ | ✅ SheetJS | F | ✅ | — | ✅ | 25 MB | preview |
| .xlsm | excel | ✅ | ✅ SheetJS | F | ✅ | — | ✅ | 25 MB | preview |
| .ods | excel | ✅ | ❌ | — | ❌ | — | ❌ | 25 MB | external-open |
| .csv | csv | ✅ | ✅ SheetJS | F | ✅ | — | ✅ | 25 MB | preview |
| .pptx | powerpoint | ✅ | ✅ text/image extract | **P** | ✅ (partial) | — | ✅ | 100 MB | preview |
| .ppt | powerpoint | ✅ | ❌ | — | ❌ | — | ❌ | 100 MB | external-open |
| .odp | powerpoint | ✅ | ❌ | — | ❌ | — | ❌ | 100 MB | external-open |
| .jpg/.jpeg | image | ✅ | ✅ native | F | — | ✅ self | — | 25 MB | preview |
| .png | image | ✅ | ✅ native | F | — | ✅ self | — | 25 MB | preview |
| .webp | image | ✅ | ✅ native | F | — | ✅ self | — | 25 MB | preview |
| .gif | image | ✅ | ✅ native | F | — | ✅ self | — | 25 MB | preview |
| .bmp | image | ✅ | ✅ native | F | — | ✅ self | — | 25 MB | preview |
| .svg | image | ✅ | ✅ native (`<img>` only) | F | — | ✅ self | — | 5 MB | preview |
| .txt/.md/.log/.json/.xml | text | ✅ | ✅ plaintext | F | ✅ | — | ✅ | 10 MB | preview |
| .mp4/.webm/.mov/.mkv/.avi/.m4v | video | ✅ | ✅ native player | F | — | ✅ frame | — | 200 MB | preview (unchanged) |
| .mp3/.wav/.m4a/.ogg/.aac/.flac | audio | ✅ | ✅ native player | F | — | — | — | 200 MB | preview (unchanged) |
| .zip/.rar/.7z/.tar/.gz | archive | ❌ **blocked** | — | — | — | — | — | 0 | external-open |
| anything else | — | ❌ **blocked** | — | — | — | — | — | 0 | — |

OCR: **not supported for any format** — scanned/image-only PDFs render visually but have
no extracted text layer. Documented as a known limitation (§G), not silently implied.

---

## C. Files changed

| File | New/Modified |
|---|---|
| `app/js/file-support-policy.js` | **New** — the single source of truth |
| `scripts/file-support-policy-test.js` | **New** — 61 dedicated tests |
| `app/index.html` | Modified |
| `app/js/viewer.js` | Modified |
| `app/js/thumbnails.js` | Modified |
| `app/js/dialogs.js` | Modified |
| `app/js/uploader.js` | Modified |
| `app/js/file-grid-controls.js` | Modified |
| `app/js/indicator-extras.js` | Modified |
| `server/routes/files.js` | Modified |
| `server/services/evidenceService.js` | Modified |
| `scripts/part2-integration-test.js` | Modified (see §E) |
| `app/js/pdf-engine.js`, `server/app.js`, `scripts/viewer-integration-test.js`, `scripts/pdf-render-order-test.js`, `app/js/vendor/pdfjs/*`, `package.json`, `package-lock.json` | Carried over unchanged from the prior two passes — included so this archive is self-consistent regardless of which state your repo is in (see `POST-EXTRACT-CLEANUP.sh`) |

## D. Why each file changed

- **`app/js/file-support-policy.js`** — the new policy module (§A).
- **`app/index.html`** — loads the new script; `FILE_ICONS`/`isImage()`/`BG_CLASS`
  now derive from the policy instead of their own tables; `uploadFiles()`/`handleDrop()`
  gained a `splitByPolicy()` pre-check that rejects disallowed files client-side with a
  toast before even attempting the upload (server remains authoritative).
- **`app/js/viewer.js`** — `EXT_MAP`/`TYPE_ICON`/`TYPE_LABEL` deleted; `extOf`/
  `categoryOf` now thin wrappers over the policy; the renderer-dispatch table changed
  from keying on hand-maintained pseudo-categories (`'word-legacy'`, `'excel-legacy'`,
  `'ppt-legacy'`) to keying on the policy's `preview.engine` per extension — simpler and
  self-updating when the policy changes. Header/info-panel labels now use
  `FileSupportPolicy.labelFor(filename)` (per-extension, so "Word (legacy format)" is
  preserved as a distinct string from "Word", not collapsed into one category label).
- **`app/js/thumbnails.js`** — the `category !== 'video' && category !== 'pdf'`
  eligibility check replaced with a check against `policy.thumbnail.supported`/`engine`,
  so adding thumbnail support for a new type later doesn't require touching this file.
- **`app/js/dialogs.js`**, **`app/js/indicator-extras.js`**, **`app/js/file-grid-controls.js`**
  — local icon/label maps deleted, now call `FileSupportPolicy.getCategoryMeta()` /
  `labelFor()`. (`indicator-extras.js`'s fix also resolves the silent `'ppt'`/`'other'`
  key-mismatch bug described in §A.)
- **`app/js/uploader.js`** — surfaces the server's actual rejection reason
  (`{error: "..."}`) in the failed-row UI instead of just an HTTP status code.
- **`server/routes/files.js`** — `handleUpload()` now runs every upload through
  `FileSupportPolicy.classifyUpload()` (extension allow-list, per-type size limit,
  magic-byte signature check) before writing to disk, returning HTTP 415 with a
  structured, Arabic, non-stack-trace error body on rejection. Added
  `GET /api/file-policy` so the frontend never has to hardcode its own copy of what's
  allowed.
- **`server/services/evidenceService.js`** — `CATEGORY_BY_EXT`/`categoryForExt()`
  replaced with a one-line delegation to `FileSupportPolicy.getCategory()`.
- **`scripts/part2-integration-test.js`** — a pre-existing test used a `.bin` filename
  purely to exercise the upload *transport* mechanism (not type validation); the new
  allow-list correctly rejects `.bin`, so the test now uses `.txt` (an allowed type),
  preserving its original intent. This is the one existing test that needed a change,
  and it's a one-line filename swap, not a logic change.

---

## E. Tests performed

1. **Policy module unit tests** (in `scripts/file-support-policy-test.js`): every
   extension you listed checked for correct `upload.allowed`/`preview.supported`/
   fidelity; magic-byte matching on both a real PDF header and a deliberately
   mismatched one; oversized-file rejection.
2. **Real HTTP upload endpoint tests** (same file, against an actual running server):
   real PDF/PNG accepted; all allowed text formats accepted; `.exe` rejected (415);
   `.zip` rejected (415); unknown extension rejected (415); **a file named `.pdf`
   containing plain text is rejected** (`SIGNATURE_MISMATCH`) — this is the exact
   "`document.pdf` containing something else" scenario you asked me to verify; path
   traversal in a filename does not leak into the listing.
3. **Cross-check**: every file's `category` as reported by the live server matches what
   `FileSupportPolicy.getCategory()` computes independently, and `/api/file-policy`'s
   allow-list matches the module's — proving there's no drift between the two runtimes.
4. **All pre-existing suites**, unmodified logic: `verify:server` 15/15,
   `verify:viewer` 19/19, `verify:part2` 11/11 (after the one filename fix above),
   `verify:pdf-render-order` 4/4, `part2-remaining-test.js` 12/12,
   `completion-engine-test.js` 23/23.
5. **Live Electron UI verification** (via Chrome DevTools Protocol, not simulated):
   - `FileSupportPolicy` loads in the real renderer; spot-checked several derived
     values match expectations.
   - `GET /api/file-policy` reachable from the live app and matches the module.
   - **Real drag-and-drop**: dropped one disallowed file (`malware.exe`) and one valid
     file (`evidence.pdf`) together — confirmed the bad one was rejected with a toast
     naming it, the good one uploaded successfully, and the listing reflects exactly
     that (bad file absent, good file present).
   - **PDF regression check**: re-opened the real `Compilers-01-Finals_2025.pdf` from
     the previous fix pass through the actual viewer — still renders correctly
     (screenshot captured), confirming this pass didn't disturb that fix.
   - **DOCX preview**: opened a real `.docx` — renders correctly, subtitle correctly
     reads "Word" via the new label path.
   - **Legacy `.doc`**: opened a file with a real OLE-compound-file signature but a
     `.doc` name — correctly shows "هذا التنسيق لا يمكن معاينته... (تنسيق قديم)"
     with the "legacy format" qualifier intact in the subtitle, confirming the
     per-extension label (not the collapsed category label) is what's shown.

## F. Test results

**145/145 automated tests passing** across all suites (84 pre-existing + 61 new), plus
the live UI checks in §E.5 all confirmed by direct observation (API responses,
screenshots), not assumed.

---

## G. Remaining limitations

- **DOC/PPT/RTF/ODT/ODS/ODP have no in-app preview.** I did not build a client-side
  parser for these — no safe, accurate one exists for the legacy binary formats, and
  building one would be exactly the "fake parser" you told me not to invent.
  **Recommended future design** (not implemented, out of this pass's scope): a
  server-side conversion step using headless LibreOffice
  (`soffice --headless --convert-to pdf`, confirmed available and already used in this
  project's own test tooling) to convert these formats to PDF on upload or on first
  open, then preview through the **already-hardened PDF engine** — this reuses
  the existing, well-tested rendering path instead of adding a second one. This needs
  its own scoping (conversion queue, temp-file lifecycle, failure handling, disk
  space) and deliberately isn't bundled into this pass.
- **PPTX preview is partial by design** — text and embedded images only, no layout,
  fonts, positioning, or animations. Correctly labeled as such (`fidelity: 'partial'`)
  everywhere it's surfaced; not marketed as full PowerPoint support.
- **No OCR** for scanned/image-only PDFs or images — text extraction only works where
  the source document already has a text layer.
- **Archives are now rejected at upload** — a real, deliberate policy change (previously
  they were silently accepted with no preview capability at all). Reversible by flipping
  `upload.allowed` to `true` for the relevant entries in `file-support-policy.js` if you
  disagree with this call.
- **SVG safety** relies on the app only ever rendering SVGs via `<img src="...">`
  (browsers don't execute embedded `<script>`/event-handler content loaded that way).
  This is documented as a hard constraint in the policy file's `notes` field for `.svg`
  — do not change SVG rendering to inline/`<object>` embedding without re-reviewing this.
- **Magic-byte checking is best-effort**, not a full content-security scan. It reliably
  catches "wrong file type" (a `.txt` renamed to `.pdf`) for formats with an
  unambiguous binary signature. It does not detect a well-formed-but-malicious file of
  the *correct* type (e.g., a booby-trapped, syntactically valid DOCX/XLSX macro
  document) — no client/server-side check in this pass attempts that; SheetJS reads
  cell data only and does not execute macros, which limits (but doesn't eliminate as a
  concern for other tools) risk from `.xlsm`.
- Per-type size limits are new defaults chosen to be generous for legitimate school
  documents while being far below the existing 200MB absolute server ceiling (which is
  unchanged) — they haven't been validated against your schools' actual largest
  real-world files beyond the samples tested in this conversation.

## H. Production-readiness assessment

- **Ready now**: PDF, DOCX, XLSX/XLS/XLSM, CSV, all listed image formats, all listed
  text formats — real upload validation, real preview, consistent classification
  end-to-end, tested.
- **Ready with the documented caveat**: PPTX (partial-fidelity preview — fine to ship
  if described accurately to schools, e.g., "preview shows slide text and images", not
  "full PowerPoint viewer").
- **Not ready for preview, but safely handled**: DOC/PPT/RTF/ODT/ODS/ODP — uploadable,
  stored, correctly labeled, clear "open externally" messaging; no false claims made to
  the user.
- **Intentionally blocked**: archives and any unrecognized extension.
- The upload boundary (HTTP + drag-drop) now has real, tested, defense-in-depth
  validation (extension allow-list, size, magic bytes) where none existed before. This
  is the single biggest security/correctness improvement in this pass.

## I. Exact commands to run

```bash
bash POST-EXTRACT-CLEANUP.sh
rm -rf node_modules
npm ci
npm run verify:server
npm run verify:viewer
npm run verify:part2
npm run verify:pdf-render-order
npm run verify:file-support-policy
node scripts/part2-remaining-test.js
node scripts/completion-engine-test.js
npm run dev
```

## J. Git-ready change set

After running the cleanup script and verifying tests pass locally:
```bash
git add .
git commit -m "Centralize file-type support policy; add upload validation (extension allow-list, size limits, magic-byte checks)"
git push
```
