/* ════════════════════════════════════════════════════════════
   AUTOMATIC THUMBNAILS — Part 2 remainder
   ────────────────────────────────────────────────────────────
   Additive module. Images already render as their own thumbnail
   (existing behavior, untouched). This adds real thumbnails for
   video (first frame) and PDF (first page), generated lazily via
   IntersectionObserver so opening an indicator with thousands of
   files never generates more than what's actually on screen, and
   with a small concurrency cap so it never competes hard with the
   rest of the UI. Unsupported types keep using the existing icon.
   ════════════════════════════════════════════════════════════ */

const Thumbnails = (function () {
  'use strict';

  const TAPI = ''; // same-origin
  const cache = new Map(); // cacheKey -> dataURL
  const CONCURRENCY = 2;
  let active = 0;
  const queue = [];

  function cacheKey(code, file) {
    return `${code}/${file.name}/${file.bytes || 0}/${file.modified || ''}`;
  }

  function runQueue() {
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      job().finally(() => { active--; runQueue(); });
    }
  }
  function enqueue(job) {
    queue.push(job);
    runQueue();
  }

  function applyThumb(card, dataUrl) {
    const iconEl = card.querySelector('.file-card-icon');
    if (!iconEl) return;
    iconEl.classList.add('thumb-loaded');
    iconEl.innerHTML = '';
    iconEl.style.backgroundImage = `url("${dataUrl}")`;
  }
  function markFailed(card) {
    const iconEl = card.querySelector('.file-card-icon');
    if (iconEl) iconEl.classList.remove('thumb-pulse');
  }

  async function generateVideoThumb(url) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.src = url;
      const cleanup = () => { video.src = ''; video.load(); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, 8000);
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = Math.min(1, (video.duration || 2) * 0.1);
      });
      video.addEventListener('seeked', () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 160; canvas.height = 90;
          const ctx = canvas.getContext('2d');
          const vw = video.videoWidth || 160, vh = video.videoHeight || 90;
          const scale = Math.max(canvas.width / vw, canvas.height / vh);
          const dw = vw * scale, dh = vh * scale;
          ctx.drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
          clearTimeout(timeout);
          cleanup();
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        } catch (err) { clearTimeout(timeout); cleanup(); reject(err); }
      });
      video.addEventListener('error', () => { clearTimeout(timeout); cleanup(); reject(new Error('video load error')); });
    });
  }

  async function generatePdfThumb(url) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js unavailable');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdfjs/pdf.worker.min.js';
    const doc = await pdfjsLib.getDocument({
      url,
      cMapUrl: 'js/vendor/pdfjs/cmaps/', cMapPacked: true,
      standardFontDataUrl: 'js/vendor/pdfjs/standard_fonts/',
      // See app/js/viewer.js renderPdf() for the full explanation — paints
      // exact glyph IDs from the content stream instead of letting the
      // browser re-shape Unicode text, which is what garbles Arabic glyphs
      // from fonts with incomplete/non-standard cmap or GSUB tables.
      disableFontFace: true,
      useSystemFonts: true,
      fontExtraProperties: true,
      isEvalSupported: true,
    }).promise;
    try {
      const page = await doc.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      const scale = 160 / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      return canvas.toDataURL('image/jpeg', 0.78);
    } finally {
      doc.destroy();
    }
  }

  function attach(card, code, file) {
    const category = file.category; // server category: 'video' | 'pdf' | ...
    if (category !== 'video' && category !== 'pdf') return; // images already self-thumbnail; others keep their icon

    const iconEl = card.querySelector('.file-card-icon');
    if (!iconEl) return;
    iconEl.classList.add('thumb-pulse');

    const key = cacheKey(code, file);
    if (cache.has(key)) { applyThumb(card, cache.get(key)); return; }

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const url = `${TAPI}/api/file/${code}/${encodeURIComponent(file.name)}`;
        enqueue(async () => {
          try {
            const dataUrl = category === 'video' ? await generateVideoThumb(url) : await generatePdfThumb(url);
            cache.set(key, dataUrl);
            if (document.body.contains(card)) applyThumb(card, dataUrl);
          } catch (err) {
            markFailed(card);
          }
        });
      });
    }, { rootMargin: '300px 0px 300px 0px' });
    observer.observe(card);
  }

  return { attach };
})();
