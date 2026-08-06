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
   1. Replace BOTH app/js/vendor/pdfjs/pdf.min.js and pdf.worker.min.js
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
  const PDFJS_VERSION = '4.10.38';

  const ASSET_BASE = 'js/vendor/pdfjs/';

  // Every option pdf.js's getDocument() needs, in one object. Nothing
  // else in the app is allowed to build this object itself.
  const CONFIG = Object.freeze({
    workerSrc: ASSET_BASE + 'pdf.worker.min.js',
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
    if (typeof pdfjsLib !== 'undefined') {
      if (err instanceof pdfjsLib.PasswordException) code = 'PASSWORD_REQUIRED';
      else if (err instanceof pdfjsLib.InvalidPDFException) code = 'INVALID_PDF';
      else if (err instanceof pdfjsLib.MissingPDFException) code = 'NETWORK';
      else if (err instanceof pdfjsLib.UnexpectedResponseException) code = 'NETWORK';
      else if (err instanceof pdfjsLib.RenderingCancelledException) code = 'CANCELLED';
      else if (err instanceof pdfjsLib.AbortException) code = 'CANCELLED';
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
  // (doc.destroy() releases the worker-side document and its caches;
  // skipping it is exactly how "schools open hundreds of PDFs" turns
  // into a worker/memory leak over a long session).
  function destroyDocument(doc) {
    if (!doc) return;
    try { doc.destroy(); } catch (err) { console.warn('[PDFEngine] destroyDocument failed', err); }
  }

  // ── 6. SHARED RENDER HELPERS ─────────────────────────────────────────
  // Renders one page onto a caller-supplied canvas at a given CSS size,
  // scaling the backing store to devicePixelRatio so dense scripts
  // (Arabic in particular) stay sharp instead of being upscaled from a
  // low-res canvas. Returns the RenderTask so callers can .cancel() it
  // (e.g. when a page scrolls out of view before rendering finishes, or
  // the viewer is closed mid-render).
  function renderPageToCanvas(page, canvas, viewport, opts) {
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
