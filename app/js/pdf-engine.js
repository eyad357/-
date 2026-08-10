/* ════════════════════════════════════════════════════════════
   PDF ENGINE — single source of truth for pdf.js in this app
   ────────────────────────────────────────────────────────────
   Every module that touches pdf.js (viewer.js, thumbnails.js,
   dialogs.js, and anything added later) MUST go through this file.
   Nothing outside pdf-engine.js is allowed to:
     - read/write pdfjsLib.GlobalWorkerOptions
     - call pdfjsLib.getDocument directly
     - hardcode 'js/vendor/pdfjs/...' paths
     - decide what a pdf.js error means for the user

   Why this file exists
   ---------------------
   Before this refactor, three different files (viewer.js,
   thumbnails.js, dialogs.js) each independently set
   `pdfjsLib.GlobalWorkerOptions.workerSrc` and called
   `pdfjsLib.getDocument({...})` with their own hand-copied option
   objects. That is exactly the shape of bug that produces
   "Setting up fake worker" warnings and worker/main version-mismatch
   TypeErrors (e.g. a method missing on the transport/proxy object):
   nothing guaranteed the three copies stayed byte-for-byte identical
   as the app evolved, and pdf.js hard-requires the code that runs on
   the main thread (pdf.min.js) and the code that runs in the worker
   (pdf.worker.min.js) to be the exact same build. A single call site
   for "which pdf.js build, which worker, which cmaps, which fonts"
   makes that class of bug structurally impossible: there is only one
   place left that could ever get it wrong.

   Upgrading pdf.js in the future
   -------------------------------
   1. Replace BOTH app/js/vendor/pdfjs/pdf.min.mjs and pdf.worker.min.mjs
      with the matching pair from the same pdf.js release (never mix
      versions between the two files).
   2. Update PDFJS_VERSION below to match (used only for diagnostics/
      logging, so a stale value fails loud in logs instead of silently).
   3. Refresh app/js/vendor/pdfjs/cmaps/ and standard_fonts/ from the
      same release's build output — CMap/font data formats can change
      between major versions.
   That's it. No other file needs to change.
   ════════════════════════════════════════════════════════════ */

const PDFEngine = (function () {
  'use strict';

  // ── 1. SINGLE SOURCE OF TRUTH: version + asset locations ──────────
  // Must match the version actually shipped in app/js/vendor/pdfjs/.
  // Upgraded 2026 as part of the Electron 43 migration — see
  // PDF-ARCHITECTURE-REVIEW.md for why (pdf.js 6.x's worker relies on
  // Map.prototype.getOrInsertComputed, a JS engine feature only present
  // in the Chromium version Electron 43 bundles).
  const PDFJS_VERSION = '6.2.108';

  const ASSET_BASE = 'js/vendor/pdfjs/';

  // Every option pdf.js's getDocument() needs, in one object. Nothing
  // else in the app is allowed to build this object itself.
  const CONFIG = Object.freeze({
    workerSrc: ASSET_BASE + 'pdf.worker.min.mjs',
    cMapUrl: ASSET_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: ASSET_BASE + 'standard_fonts/',
    // NOTE ON disableFontFace (false = pdf.js default):
    // A prior hotfix forced this to `true` as an unverified hypothesis
    // for garbled Arabic text; it fixed one class of PDF while breaking
    // another (missing numbers/symbols), because it disables pdf.js's
    // own per-font fallback heuristics for every document, globally.
    // Left at the default — same behavior Firefox's built-in viewer
    // uses across the vast majority of real-world Arabic/RTL PDFs.
    // See PDF-RENDERING-NOTES.md for the open investigation and what
    // evidence (an actual failing file) is needed before touching this
    // again. This is the ONLY place in the app that may set it.
    disableFontFace: false,
    useSystemFonts: true,
    fontExtraProperties: true,
    isEvalSupported: true,
  });

  // ── 2. WORKER BOOTSTRAP (exactly once, exactly here) ───────────────
  let configured = false;
  function ensureConfigured() {
    if (configured) return;
    if (typeof pdfjsLib === 'undefined') {
      throw new PDFEngineError(
        'ENGINE_UNAVAILABLE',
        'pdfjsLib global is not defined — vendor script failed to load or index.html script order is broken'
      );
    }
    if (pdfjsLib.version && pdfjsLib.version !== PDFJS_VERSION) {
      // Not fatal (pdf.js still works), but this means someone swapped
      // pdf.min.js without updating PDFJS_VERSION above, or without
      // swapping pdf.worker.min.js to match — exactly the situation
      // that causes main/worker mismatch errors. Log loudly.
      console.error(
        `[PDFEngine] Version mismatch: pdf-engine.js expects ${PDFJS_VERSION} ` +
        `but loaded pdf.min.js reports ${pdfjsLib.version}. ` +
        `Update PDFJS_VERSION in pdf-engine.js and confirm pdf.worker.min.js is the SAME release.`
      );
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = CONFIG.workerSrc;
    configured = true;
  }

  // ── 3. CENTRALIZED ERROR HANDLING ───────────────────────────────────
  // Users only ever see .friendlyMessage (Arabic, business-appropriate).
  // Technical detail (err.code, original error, stack) goes to
  // console.error only — never surfaced in the UI.
  function PDFEngineError(code, technicalMessage, cause) {
    const err = new Error(technicalMessage);
    err.name = 'PDFEngineError';
    err.code = code;
    err.cause = cause;
    err.friendlyTitle = FRIENDLY_TITLES[code] || FRIENDLY_TITLES.UNKNOWN;
    err.friendlyDetail = FRIENDLY_DETAILS[code] || FRIENDLY_DETAILS.UNKNOWN;
    return err;
  }

  const FRIENDLY_TITLES = {
    ENGINE_UNAVAILABLE: 'تعذّر تحميل عارض PDF',
    PASSWORD_REQUIRED: 'الملف محمي بكلمة مرور',
    INVALID_PDF: 'تعذّر فتح ملف PDF',
    NETWORK: 'تعذّر تحميل الملف',
    CANCELLED: 'تم إلغاء العملية',
    UNKNOWN: 'تعذّر فتح ملف PDF',
  };
  const FRIENDLY_DETAILS = {
    ENGINE_UNAVAILABLE: 'مكوّن عرض PDF غير متاح حاليًا. أعد تشغيل التطبيق، وإن استمرت المشكلة تواصل مع الدعم الفني.',
    PASSWORD_REQUIRED: 'لا يمكن عرض هذا الملف داخل النظام لأنه محمي بكلمة مرور.',
    INVALID_PDF: 'الملف قد يكون تالفًا أو غير مكتمل أو ليس بصيغة PDF صحيحة.',
    NETWORK: 'تعذّر تحميل بيانات الملف من الخادم المحلي. حاول مرة أخرى.',
    CANCELLED: '',
    UNKNOWN: 'حدث خطأ غير متوقع أثناء فتح الملف. حاول مرة أخرى، وإن استمرت المشكلة تواصل مع الدعم الفني.',
  };

  function classifyError(err) {
    if (err && err.name === 'PDFEngineError') return err; // already classified
    let code = 'UNKNOWN';
    // Guard every check: pdf.js has renamed/removed exception classes between
    // major versions before (e.g. MissingPDFException and
    // UnexpectedResponseException both existed in 4.x and are gone in 6.x).
    // `instanceof undefined` throws, so an unguarded check here would mask
    // the real error behind a *different* crash in this classifier. Checking
    // typeof first makes this resilient to future pdf.js exception renames
    // without needing to touch every call site again.
    const isInstance = (Ctor) => typeof Ctor === 'function' && err instanceof Ctor;
    if (typeof pdfjsLib !== 'undefined') {
      if (isInstance(pdfjsLib.PasswordException)) code = 'PASSWORD_REQUIRED';
      else if (isInstance(pdfjsLib.InvalidPDFException)) code = 'INVALID_PDF';
      else if (isInstance(pdfjsLib.MissingPDFException)) code = 'NETWORK';
      else if (isInstance(pdfjsLib.UnexpectedResponseException)) code = 'NETWORK';
      else if (isInstance(pdfjsLib.RenderingCancelledException)) code = 'CANCELLED';
      else if (isInstance(pdfjsLib.AbortException)) code = 'CANCELLED';
    }
    // console.error, not console.log: technical detail is for developers/
    // support logs only, business message above is what the user sees.
    console.error('[PDFEngine]', code, err);
    return PDFEngineError(code, (err && err.message) || String(err), err);
  }

  // ── 4. DOCUMENT LOADING (the one place that calls getDocument) ─────
  // `source` is either { data: ArrayBuffer } or { url: string }.
  // `extra` may override CONFIG for special cases (e.g. dialogs.js only
  // wants page count and skips cmap/font loading for speed) but always
  // goes through this function so worker/version bootstrap and error
  // classification stay centralized.
  async function openDocument(source, extra) {
    ensureConfigured();
    const params = Object.assign({}, CONFIG, source, extra || {});
    try {
      const loadingTask = pdfjsLib.getDocument(params);
      return await loadingTask.promise;
    } catch (err) {
      throw classifyError(err);
    }
  }

  // Lightweight variant for cases (dialogs.js "properties" panel) that
  // only need page count / metadata, not fonts or CMaps — still routed
  // through the same worker bootstrap and error handling.
  async function openDocumentLite(source) {
    return openDocument(source, {
      cMapUrl: undefined,
      cMapPacked: undefined,
      standardFontDataUrl: undefined,
      fontExtraProperties: false,
    });
  }

  // ── 5. MEMORY MANAGEMENT ────────────────────────────────────────────
  // Every caller that opens a document MUST release it through this
  // (releases the worker-side document and its caches; skipping it is
  // exactly how "schools open hundreds of PDFs" turns into a
  // worker/memory leak over a long session).
  //
  // pdf.js 6.x removed the PDFDocumentProxy.destroy() convenience method
  // that existed in 4.x — destroy() now lives on the loading task, one
  // level up (doc.loadingTask.destroy()). Verified against the actual
  // 6.2.108 build (not assumed from changelogs) via a live render test —
  // see PDF-ARCHITECTURE-REVIEW.md. Falls back to the old shape too, so
  // this keeps working if a future pdf.js release moves it back.
  function destroyDocument(doc) {
    if (!doc) return;
    try {
      if (doc.loadingTask && typeof doc.loadingTask.destroy === 'function') {
        doc.loadingTask.destroy();
      } else if (typeof doc.destroy === 'function') {
        doc.destroy();
      } else {
        console.warn('[PDFEngine] destroyDocument: no destroy() reachable on this pdf.js build\'s document object');
      }
    } catch (err) {
      console.warn('[PDFEngine] destroyDocument failed', err);
    }
  }

  // ── 6. SHARED RENDER HELPERS ─────────────────────────────────────────
  // Renders one page onto a caller-supplied canvas at a given CSS size,
  // scaling the backing store to devicePixelRatio so dense scripts
  // (Arabic in particular) stay sharp instead of being upscaled from a
  // low-res canvas. Returns the RenderTask so callers can .cancel() it
  // (e.g. when a page scrolls out of view before rendering finishes, or
  // the viewer is closed mid-render).
  //
  // CONTRACT — the canvas must NOT be attached to the document when this
  // is called. Rendering into a canvas that is already part of the live,
  // composited page (vs. an off-DOM canvas) makes Chromium take a
  // different native-font rasterization path — confirmed by direct A/B
  // testing (identical render call, only DOM-attachment differed). For
  // PDFs with certain broken/unusual embedded TrueType hinting tables
  // (seen from real PowerPoint-to-PDF exports), that path corrupts glyph
  // advance widths, producing scattered extra gaps mid-word — while the
  // exact same render into a detached canvas is always correct. This is
  // NOT a pdf.js version issue and NOT fixed by disableFontFace (that
  // trades this bug for a worse one: forcing pdf.js's own glyph-path
  // renderer skips the browser's text shaping entirely, which breaks
  // Arabic ligature joining on PDFs that rely on the renderer to shape
  // text rather than shipping pre-shaped glyph runs — verified against a
  // real school Arabic PDF that regressed exactly that way). Rendering
  // off-DOM and attaching only the finished bitmap avoids the bug
  // entirely, for every font, with no per-file/per-font special-casing.
  // See PDF-ARCHITECTURE-REVIEW.md for the full A/B evidence.
  //
  // Callers: create the canvas, call this, await task.promise, THEN
  // insert the canvas into the document. Never insert first.
  function renderPageToCanvas(page, canvas, viewport, opts) {
    if (canvas.isConnected) {
      console.warn(
        '[PDFEngine] renderPageToCanvas called on a canvas already attached to the document. ' +
        'This can corrupt glyph positioning for some embedded fonts — render off-DOM and attach ' +
        'the canvas only after task.promise resolves. See the contract note above this function.'
      );
    }
    opts = opts || {};
    const outputScale = opts.outputScale || window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
    return page.render({ canvasContext: canvas.getContext('2d'), viewport, transform });
  }

  // Renders page 1 downscaled to `maxWidth` CSS px and returns a JPEG
  // data URL — used for thumbnails. Opens and destroys its own document
  // so callers don't have to manage lifecycle for a one-shot render.
  async function renderThumbnailDataUrl(source, maxWidth, quality) {
    const doc = await openDocument(source);
    try {
      const page = await doc.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = maxWidth / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return canvas.toDataURL('image/jpeg', quality || 0.78);
    } finally {
      destroyDocument(doc);
    }
  }

  return {
    CONFIG,
    PDFJS_VERSION,
    openDocument,
    openDocumentLite,
    destroyDocument,
    renderPageToCanvas,
    renderThumbnailDataUrl,
    classifyError,
  };
})();
