/* ════════════════════════════════════════════════════════════
   FILE SUPPORT POLICY — single source of truth
   ────────────────────────────────────────────────────────────
   Every other place in this app that needs to know "is this file
   type allowed", "how big can it be", "what icon/label does it get",
   "can we preview it, and with what", "should it get a thumbnail",
   or "is it searchable" must read that from HERE — nothing else in
   the codebase is allowed to hardcode its own extension→category,
   extension→icon, or extension→label table.

   Before this file existed, that information was independently
   hand-maintained in SEVEN places (server/services/evidenceService.js,
   app/js/viewer.js, app/js/file-grid-controls.js, app/index.html ×2,
   app/js/dialogs.js, app/js/indicator-extras.js) and had actually
   drifted — e.g. the PDF icon was a different emoji in different
   screens, and `isImage()` in index.html didn't know about .svg while
   viewer.js's image list did. See FILE-SUPPORT-ARCHITECTURE-REPORT.md
   for the full audit that found this.

   Runs unmodified in both environments:
     - Browser: loaded as a classic <script> (app/index.html), exposes
       `window.FileSupportPolicy`.
     - Node (server): `require('../../app/js/file-support-policy.js')`.
   This is a plain UMD wrapper — no bundler, no build step, matching
   how every other shared module in this app (pdf-engine.js etc.) is
   already loaded.

   Updating file-type support:
   -----------------------------
   To add/change a format, edit EXTENSIONS (and CATEGORIES if it's a
   genuinely new bucket) below — nothing else. Every consumer derives
   its behavior from this table at call time.
   ════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FileSupportPolicy = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Category-level presentation metadata (ONE emoji/label per bucket) ──
  // `category` on an extension entry below must be a key in here.
  const CATEGORIES = {
    pdf: { icon: '📕', labelAr: 'PDF', bgClass: 'pdf-bg' },
    word: { icon: '📘', labelAr: 'Word', bgClass: 'word-bg' },
    excel: { icon: '📗', labelAr: 'Excel', bgClass: 'excel-bg' },
    csv: { icon: '📊', labelAr: 'CSV', bgClass: 'excel-bg' },
    powerpoint: { icon: '📙', labelAr: 'PowerPoint', bgClass: 'ppt-bg' },
    image: { icon: '🖼️', labelAr: 'صور', bgClass: '' },
    video: { icon: '🎬', labelAr: 'فيديو', bgClass: 'file-bg' },
    audio: { icon: '🎧', labelAr: 'صوت', bgClass: 'file-bg' },
    text: { icon: '📄', labelAr: 'نصوص', bgClass: 'text-bg' },
    archive: { icon: '🗜️', labelAr: 'أرشيف مضغوط', bgClass: 'zip-bg' },
    other: { icon: '📎', labelAr: 'أخرى', bgClass: 'file-bg' },
  };

  // ── Reusable magic-byte signatures ──────────────────────────────────
  // Checked against the first bytes of the actual file content. Only
  // used where the signature is unambiguous enough to be a reliable
  // signal (near-zero false-positive rate for a legitimately-produced
  // file of that type, regardless of which application authored it).
  const SIG = {
    PDF: { bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
    PNG: { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    JPEG: { bytes: [0xff, 0xd8, 0xff] },
    GIF: { bytes: [0x47, 0x49, 0x46, 0x38] }, // "GIF8" (covers 87a and 89a)
    BMP: { bytes: [0x42, 0x4d] }, // "BM"
    ZIP: { bytes: [0x50, 0x4b, 0x03, 0x04] }, // "PK\x03\x04" — docx/xlsx/pptx/odt/ods/odp/zip are all zip containers
    OLE: { bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] }, // legacy .doc/.xls/.ppt compound file
    RAR: { bytes: [0x52, 0x61, 0x72, 0x21] }, // "Rar!"
    SEVENZ: { bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
    GZIP: { bytes: [0x1f, 0x8b] },
  };
  // WEBP needs a two-part check (RIFF container + "WEBP" at offset 8) —
  // handled as a small function rather than a flat byte sequence.
  function isWebp(bytes) {
    if (!bytes || bytes.length < 12) return false;
    const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
    const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    return riff && webp;
  }
  // SVG is XML text, not binary — no reliable short magic number. Best
  // effort only: decode the first bytes as text and look for a `<svg`
  // or `<?xml` opening tag. Treated as a SOFT signal (see classifyUpload).
  function looksLikeSvgText(bytes) {
    try {
      const head = String.fromCharCode.apply(null, Array.prototype.slice.call(bytes, 0, 512));
      return /<\?xml|<svg[\s>]/i.test(head);
    } catch (e) { return true; } // can't tell — don't block on a soft check
  }
  function matchesSignature(bytes, sig) {
    if (!bytes || bytes.length < sig.bytes.length) return false;
    for (let i = 0; i < sig.bytes.length; i++) if (bytes[i] !== sig.bytes[i]) return false;
    return true;
  }

  const MB = 1024 * 1024;

  // ── THE table. One row per supported extension. ─────────────────────
  // upload.allowed=false means: reject at the upload boundary (HTTP
  // upload + drag&drop). It does NOT affect the filesystem watcher —
  // files a staff member places directly into an evidence folder via
  // the OS are still picked up and listed (just correctly categorized),
  // since silently hiding evidence someone deliberately placed there
  // would be worse than showing it with a "no preview" message. See
  // FILE-SUPPORT-ARCHITECTURE-REPORT.md §"Archives & unknown types".
  const EXTENSIONS = {
    pdf: {
      category: 'pdf', mimeTypes: ['application/pdf'],
      upload: { allowed: true }, maxSizeBytes: 100 * MB,
      preview: { supported: true, engine: 'pdfjs', fidelity: 'full' },
      contentExtraction: { supported: true }, thumbnail: { supported: true, engine: 'pdfjs' },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr: 'مستند PDF', fallback: 'preview', signature: SIG.PDF,
    },

    // ── Word ──
    docx: {
      category: 'word', mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: true, engine: 'mammoth', fidelity: 'full' },
      contentExtraction: { supported: true }, thumbnail: { supported: false, engine: null },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr: 'مستند Word', fallback: 'preview', signature: SIG.ZIP,
      notes: 'Rendered as reflowable HTML via mammoth.js — real content/structure preview, not a pixel-exact page layout.',
    },
    doc: {
      category: 'word', mimeTypes: ['application/msword'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: false, engine: null, fidelity: 'none' },
      contentExtraction: { supported: false }, thumbnail: { supported: false, engine: null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'مستند Word (تنسيق قديم)', fallback: 'external-open', signature: SIG.OLE,
      notes: 'Legacy binary format. No safe, accurate client-side parser exists. See report for the recommended server-side-conversion design (not implemented).',
    },
    rtf: {
      category: 'word', mimeTypes: ['application/rtf', 'text/rtf'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: false, engine: null, fidelity: 'none' },
      contentExtraction: { supported: false }, thumbnail: { supported: false, engine: null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'مستند RTF', fallback: 'external-open', signature: null,
    },
    odt: {
      category: 'word', mimeTypes: ['application/vnd.oasis.opendocument.text'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: false, engine: null, fidelity: 'none' },
      contentExtraction: { supported: false }, thumbnail: { supported: false, engine: null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'مستند OpenDocument', fallback: 'external-open', signature: SIG.ZIP,
    },

    // ── Excel ──
    xlsx: {
      category: 'excel', mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: true, engine: 'sheetjs', fidelity: 'full' },
      contentExtraction: { supported: true }, thumbnail: { supported: false, engine: null },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr: 'جدول بيانات Excel', fallback: 'preview', signature: SIG.ZIP,
    },
    xls: {
      category: 'excel', mimeTypes: ['application/vnd.ms-excel'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: true, engine: 'sheetjs', fidelity: 'full' },
      contentExtraction: { supported: true }, thumbnail: { supported: false, engine: null },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr: 'جدول بيانات Excel (تنسيق قديم)', fallback: 'preview', signature: SIG.OLE,
      notes: 'Legacy binary format, but SheetJS parses it natively — genuinely full preview, unlike legacy Word/PowerPoint.',
    },
    xlsm: {
      category: 'excel', mimeTypes: ['application/vnd.ms-excel.sheet.macroEnabled.12'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: true, engine: 'sheetjs', fidelity: 'full' },
      contentExtraction: { supported: true }, thumbnail: { supported: false, engine: null },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr: 'جدول بيانات Excel (بها ماكرو)', fallback: 'preview', signature: SIG.ZIP,
      notes: 'Macros are not executed or inspected — SheetJS reads cell data only. This is a safety property, not a limitation.',
    },
    ods: {
      category: 'excel', mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: false, engine: null, fidelity: 'none' },
      contentExtraction: { supported: false }, thumbnail: { supported: false, engine: null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'جدول بيانات OpenDocument', fallback: 'external-open', signature: SIG.ZIP,
    },
    csv: {
      category: 'csv', mimeTypes: ['text/csv'],
      upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: true, engine: 'sheetjs', fidelity: 'full' },
      contentExtraction: { supported: true }, thumbnail: { supported: false, engine: null },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr: 'ملف CSV', fallback: 'preview', signature: null,
      notes: 'Plain text — no reliable binary signature; extension is authoritative for this type.',
    },

    // ── PowerPoint ──
    pptx: {
      category: 'powerpoint', mimeTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      upload: { allowed: true }, maxSizeBytes: 100 * MB,
      preview: { supported: true, engine: 'pptx-text-extract', fidelity: 'partial' },
      contentExtraction: { supported: true }, thumbnail: { supported: false, engine: null },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr: 'عرض PowerPoint', fallback: 'preview', signature: SIG.ZIP,
      notes: 'Extracts slide titles/bullet text/embedded images from the raw OOXML. Does NOT reproduce slide layout, fonts, positioning, or animations — partial fidelity by design, not a bug.',
    },
    ppt: {
      category: 'powerpoint', mimeTypes: ['application/vnd.ms-powerpoint'],
      upload: { allowed: true }, maxSizeBytes: 100 * MB,
      preview: { supported: false, engine: null, fidelity: 'none' },
      contentExtraction: { supported: false }, thumbnail: { supported: false, engine: null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'عرض PowerPoint (تنسيق قديم)', fallback: 'external-open', signature: SIG.OLE,
    },
    odp: {
      category: 'powerpoint', mimeTypes: ['application/vnd.oasis.opendocument.presentation'],
      upload: { allowed: true }, maxSizeBytes: 100 * MB,
      preview: { supported: false, engine: null, fidelity: 'none' },
      contentExtraction: { supported: false }, thumbnail: { supported: false, engine: null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'عرض OpenDocument', fallback: 'external-open', signature: SIG.ZIP,
    },

    // ── Images ──
    jpg: imageEntry(['image/jpeg'], SIG.JPEG, 'صورة JPEG'),
    jpeg: imageEntry(['image/jpeg'], SIG.JPEG, 'صورة JPEG'),
    png: imageEntry(['image/png'], SIG.PNG, 'صورة PNG'),
    webp: imageEntry(['image/webp'], { custom: isWebp }, 'صورة WebP'),
    gif: imageEntry(['image/gif'], SIG.GIF, 'صورة GIF'),
    bmp: imageEntry(['image/bmp'], SIG.BMP, 'صورة BMP'),
    svg: {
      category: 'image', mimeTypes: ['image/svg+xml'],
      upload: { allowed: true }, maxSizeBytes: 5 * MB,
      preview: { supported: true, engine: 'native-image', fidelity: 'full' },
      contentExtraction: { supported: false }, thumbnail: { supported: true, engine: 'self' },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'صورة SVG', fallback: 'preview', signature: { custom: looksLikeSvgText, soft: true },
      notes: 'Displayed via <img src="..."> only, never injected inline into the page or opened via <object>/<iframe> — browsers do not execute embedded <script>/event-handler content for SVGs loaded this way, so this remains safe without extra sanitization. Do not change how SVG evidence files are rendered without re-reviewing this.',
    },

    // ── Text ──
    txt: textEntry(['text/plain'], 'ملف نصي'),
    md: textEntry(['text/markdown', 'text/plain'], 'ملف Markdown'),
    log: textEntry(['text/plain'], 'ملف سجل'),
    json: textEntry(['application/json', 'text/plain'], 'ملف JSON'),
    xml: textEntry(['application/xml', 'text/xml'], 'ملف XML'),

    // ── Video (unchanged from prior behavior — not part of this pass's
    //    explicit scope, carried over as-is with the same capabilities) ──
    mp4: mediaEntry('video', ['video/mp4']),
    webm: mediaEntry('video', ['video/webm']),
    mov: mediaEntry('video', ['video/quicktime']),
    mkv: mediaEntry('video', ['video/x-matroska']),
    avi: mediaEntry('video', ['video/x-msvideo']),
    m4v: mediaEntry('video', ['video/x-m4v']),
    mp3: mediaEntry('audio', ['audio/mpeg']),
    wav: mediaEntry('audio', ['audio/wav']),
    m4a: mediaEntry('audio', ['audio/mp4']),
    ogg: mediaEntry('audio', ['audio/ogg']),
    aac: mediaEntry('audio', ['audio/aac']),
    flac: mediaEntry('audio', ['audio/flac']),

    // ── Archives — upload intentionally NOT allowed. See notes. ──
    zip: archiveEntry(['application/zip'], SIG.ZIP),
    rar: archiveEntry(['application/vnd.rar', 'application/x-rar-compressed'], SIG.RAR),
    '7z': archiveEntry(['application/x-7z-compressed'], SIG.SEVENZ),
    tar: archiveEntry(['application/x-tar'], null),
    gz: archiveEntry(['application/gzip'], SIG.GZIP),
  };

  function imageEntry(mimeTypes, signature, displayNameAr) {
    return {
      category: 'image', mimeTypes, upload: { allowed: true }, maxSizeBytes: 25 * MB,
      preview: { supported: true, engine: 'native-image', fidelity: 'full' },
      contentExtraction: { supported: false }, thumbnail: { supported: true, engine: 'self' },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr, fallback: 'preview', signature,
    };
  }
  function textEntry(mimeTypes, displayNameAr) {
    return {
      category: 'text', mimeTypes, upload: { allowed: true }, maxSizeBytes: 10 * MB,
      preview: { supported: true, engine: 'plaintext', fidelity: 'full' },
      contentExtraction: { supported: true }, thumbnail: { supported: false, engine: null },
      search: { supported: true }, ocr: { supported: false },
      displayNameAr, fallback: 'preview', signature: null,
    };
  }
  function mediaEntry(category, mimeTypes) {
    return {
      category, mimeTypes, upload: { allowed: true }, maxSizeBytes: 200 * MB,
      preview: { supported: true, engine: category === 'video' ? 'native-media-video' : 'native-media-audio', fidelity: 'full' },
      contentExtraction: { supported: false }, thumbnail: { supported: category === 'video', engine: category === 'video' ? 'video-frame' : null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: category === 'video' ? 'فيديو' : 'ملف صوتي', fallback: 'preview', signature: null,
    };
  }
  function archiveEntry(mimeTypes, signature) {
    return {
      category: 'archive', mimeTypes, upload: { allowed: false }, maxSizeBytes: 0,
      preview: { supported: false, engine: null, fidelity: 'none' },
      contentExtraction: { supported: false }, thumbnail: { supported: false, engine: null },
      search: { supported: false }, ocr: { supported: false },
      displayNameAr: 'أرشيف مضغوط', fallback: 'external-open', signature,
      notes: 'Upload intentionally disabled: the app has no preview/extraction capability for archives, and accepting opaque compressed blobs into an accreditation-evidence store adds no product value while adding real risk (decompression bombs if ever unpacked, unreviewable content). Flip upload.allowed to re-enable if a future feature needs it.',
    };
  }

  // ── Derivation helpers ────────────────────────────────────────────
  function getExtension(filename) {
    const s = String(filename || '');
    const i = s.lastIndexOf('.');
    if (i < 0 || i === s.length - 1) return '';
    return s.slice(i + 1).toLowerCase();
  }

  function getPolicy(filenameOrExt) {
    const raw = String(filenameOrExt || '');
    // If it looks like a bare extension (no dot, or a single leading dot
    // and nothing else — e.g. "pdf" or ".pdf"), use it directly. Otherwise
    // treat it as a filename and take the part after the last dot.
    const ext = raw.indexOf('.') === -1
      ? raw.toLowerCase()
      : (raw.lastIndexOf('.') === 0 ? raw.slice(1).toLowerCase() : getExtension(raw));
    return EXTENSIONS[ext] || null;
  }

  function getCategory(filenameOrExt) {
    const p = getPolicy(filenameOrExt);
    return p ? p.category : 'other';
  }

  function getCategoryMeta(category) {
    return CATEGORIES[category] || CATEGORIES.other;
  }

  function isUploadAllowed(filenameOrExt) {
    const p = getPolicy(filenameOrExt);
    return !!(p && p.upload.allowed);
  }

  function isPreviewSupported(filenameOrExt) {
    const p = getPolicy(filenameOrExt);
    return !!(p && p.preview.supported);
  }

  function isImageExt(filenameOrExt) {
    return getCategory(filenameOrExt) === 'image';
  }

  function iconFor(filenameOrExt) {
    return getCategoryMeta(getCategory(filenameOrExt)).icon;
  }

  function labelFor(filenameOrExt) {
    const p = getPolicy(filenameOrExt);
    return p ? p.displayNameAr : 'ملف';
  }

  function allowedExtensionsList() {
    return Object.keys(EXTENSIONS).filter((ext) => EXTENSIONS[ext].upload.allowed);
  }

  // Checks the file's actual header bytes against its extension's known
  // signature. Returns { checked, matched, soft }:
  //   checked=false  → no signature defined for this extension (nothing to check)
  //   matched=true   → signature matches (or check is a soft/best-effort one)
  //   soft=true      → a mismatch here is a weak signal, don't hard-reject on it
  function checkMagicBytes(filenameOrExt, headerBytes) {
    const p = getPolicy(filenameOrExt);
    if (!p || !p.signature) return { checked: false, matched: true, soft: false };
    const sig = p.signature;
    if (sig.custom) {
      return { checked: true, matched: !!sig.custom(headerBytes), soft: !!sig.soft };
    }
    return { checked: true, matched: matchesSignature(headerBytes, sig), soft: false };
  }

  // Single authoritative validation entry point for the upload boundary
  // (HTTP upload + drag&drop). `headerBytes` is optional (a Uint8Array of
  // at least the first ~16 bytes of the file) — if omitted, validation
  // still runs on extension + size, just skips the magic-byte check.
  // Returns { ok, ext, category, policy, reason, friendlyTitle, friendlyDetail }.
  function classifyUpload({ filename, size, headerBytes }) {
    const ext = getExtension(filename);
    const policy = EXTENSIONS[ext];

    if (!policy) {
      return {
        ok: false, ext, category: 'other', policy: null, reason: 'UNSUPPORTED_TYPE',
        friendlyTitle: 'نوع الملف غير مدعوم',
        friendlyDetail: `الامتداد "${ext || '(بدون امتداد)'}" غير مدعوم حاليًا. الصيغ المدعومة: ${allowedExtensionsList().map((e) => '.' + e).join('، ')}.`,
      };
    }
    if (!policy.upload.allowed) {
      return {
        ok: false, ext, category: policy.category, policy, reason: 'TYPE_BLOCKED',
        friendlyTitle: 'هذا النوع من الملفات غير مسموح برفعه',
        friendlyDetail: policy.notes || 'هذا التنسيق غير مسموح به ضمن سياسة الملفات الحالية.',
      };
    }
    if (typeof size === 'number' && size > policy.maxSizeBytes) {
      return {
        ok: false, ext, category: policy.category, policy, reason: 'TOO_LARGE',
        friendlyTitle: 'حجم الملف أكبر من المسموح',
        friendlyDetail: `الحد الأقصى لملفات ${policy.displayNameAr} هو ${Math.round(policy.maxSizeBytes / MB)} ميجابايت.`,
      };
    }
    if (headerBytes) {
      const sigCheck = checkMagicBytes(ext, headerBytes);
      if (sigCheck.checked && !sigCheck.matched && !sigCheck.soft) {
        return {
          ok: false, ext, category: policy.category, policy, reason: 'SIGNATURE_MISMATCH',
          friendlyTitle: 'محتوى الملف لا يطابق امتداده',
          friendlyDetail: `الملف يحمل امتداد .${ext} لكن محتواه الفعلي لا يبدو ملفًا من هذا النوع. تأكد من أن الملف سليم وغير تالف.`,
        };
      }
    }
    return { ok: true, ext, category: policy.category, policy };
  }

  return {
    EXTENSIONS,
    CATEGORIES,
    getExtension,
    getPolicy,
    getCategory,
    getCategoryMeta,
    isUploadAllowed,
    isPreviewSupported,
    isImageExt,
    iconFor,
    labelFor,
    allowedExtensionsList,
    checkMagicBytes,
    classifyUpload,
  };
});
