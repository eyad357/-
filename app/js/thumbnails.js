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
    // Worker bootstrap, cmap/font paths, and version pinning all live in
    // PDFEngine (app/js/pdf-engine.js) — the single source of truth
    // shared with viewer.js and dialogs.js.
    if (typeof PDFEngine === 'undefined') throw new Error('pdf.js unavailable');
    return PDFEngine.renderThumbnailDataUrl({ url }, 160, 0.78);
  }

  function attach(card, code, file) {
    const policy = FileSupportPolicy.getPolicy(file.name);
    const engine = policy && policy.thumbnail.supported ? policy.thumbnail.engine : null;
    // 'self' (images) already renders as its own thumbnail via a plain
    // <img> tag elsewhere — nothing to generate here. Anything else with
    // no thumbnail engine keeps its category icon.
    if (engine !== 'pdfjs' && engine !== 'video-frame') return;
    const category = engine === 'video-frame' ? 'video' : 'pdf';

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
