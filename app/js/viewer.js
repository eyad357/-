/* ════════════════════════════════════════════════════════════
   PROFESSIONAL DOCUMENT VIEWER — Phase 1.5
   ────────────────────────────────────────────────────────────
   Additive module. Exposes a single global `Viewer` object with
   `Viewer.open(code, file)` / `Viewer.close()`.
   Does not read or write anything the rest of the app depends on;
   it only fetches the same file bytes the old modal already used
   (`/api/file/:code/:name`) and renders them locally in-page using
   bundled libraries (pdf.js, mammoth.js, SheetJS, JSZip) — no
   backend changes, no CDN calls, everything served same-origin.
   ════════════════════════════════════════════════════════════ */

const Viewer = (function () {
  'use strict';

  const VAPI = ''; // same-origin, mirrors API in index.html

  // File-type classification (category, icon, label, preview capability)
  // all comes from FileSupportPolicy (app/js/file-support-policy.js) — the
  // single source of truth shared with the backend, the uploader, and
  // every other screen that shows a file icon/label. Do not reintroduce a
  // local extension map here.
  function extOf(name) { return FileSupportPolicy.getExtension(name); }
  function categoryOf(name) { return FileSupportPolicy.getCategory(name); }

  // Resolves an OOXML relationship Target (e.g. "../media/image1.png") against
  // the directory of the file that referenced it (e.g. "ppt/slides"), the way
  // a real zip/relative-path resolver would — simple string concatenation
  // breaks on the leading "../" that PowerPoint always uses for media refs.
  function resolveOoxmlPath(baseDir, target) {
    const baseParts = baseDir.split('/').filter(Boolean);
    const targetParts = target.split('/').filter(Boolean);
    for (const part of targetParts) {
      if (part === '..') baseParts.pop();
      else if (part === '.') continue;
      else baseParts.push(part);
    }
    return baseParts.join('/');
  }

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
  }
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch { return String(d); }
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── module state ──
  let dom = null;
  let state = null;

  function freshState() {
    return {
      code: null, file: null, url: null, category: null,
      zoom: 1, rotation: 0, pdfRotation: 0,
      pdfDoc: null, pdfScaleBase: 1, pdfPages: [], pdfCurrentPage: 1,
      searchOpen: false, searchHits: [], searchIndex: -1, searchSource: null,
      objectUrls: [], pan: { x: 0, y: 0, dragging: false },
      abort: null,
      galleryFiles: null, galleryIndex: -1,
    };
  }
  // Remembers the last-viewed PDF page per file for this app session only
  // (same ephemeral-by-design tradeoff as recent-views: a browsing nicety,
  // not data worth persisting to disk or round-tripping to the server).
  const lastPdfPage = new Map();

  // ══════════════════════════════════════════════════════════
  // DOM SCAFFOLD (built once, reused)
  // ══════════════════════════════════════════════════════════
  function ensureDOM() {
    if (dom) return dom;
    const overlay = document.createElement('div');
    overlay.className = 'dv-overlay';
    overlay.id = 'dv-overlay';
    overlay.innerHTML = `
      <div class="dv-topbar">
        <div class="dv-title-wrap">
          <span class="dv-icon" id="dv-icon">📄</span>
          <div>
            <div class="dv-filename" id="dv-filename"></div>
            <div class="dv-subtitle" id="dv-subtitle"></div>
          </div>
        </div>
        <div class="dv-toolbar" id="dv-toolbar"></div>
        <div class="dv-actions">
          <button class="dv-btn dv-btn-icon-only" id="dv-info-btn" title="معلومات الملف">ℹ️ معلومات</button>
          <button class="dv-btn dv-btn-icon-only" id="dv-fullscreen-btn" title="ملء الشاشة (F)">⛶</button>
          <a class="dv-btn dv-btn-icon-only" id="dv-download-btn" download title="تحميل">⬇</a>
          <button class="dv-btn dv-btn-close" id="dv-close-btn" title="إغلاق (Esc)">✕ إغلاق</button>
        </div>
      </div>
      <div class="dv-search-bar" id="dv-search-bar" hidden>
        <input id="dv-search-input" placeholder="بحث في المستند…" autocomplete="off">
        <span id="dv-search-count"></span>
        <button class="dv-btn dv-btn-icon-only" id="dv-search-prev" title="السابق">▲</button>
        <button class="dv-btn dv-btn-icon-only" id="dv-search-next" title="التالي">▼</button>
        <button class="dv-btn dv-btn-icon-only" id="dv-search-close" title="إغلاق البحث">✕</button>
      </div>
      <div class="dv-body-wrap">
        <div class="dv-sidebar" id="dv-sidebar" hidden></div>
        <div class="dv-content" id="dv-content"></div>
        <div class="dv-info-panel" id="dv-info-panel" hidden></div>
      </div>
      <div class="dv-statusbar" id="dv-statusbar"><span id="dv-status-left"></span><span id="dv-status-right"></span></div>
    `;
    document.body.appendChild(overlay);

    dom = {
      overlay,
      icon: overlay.querySelector('#dv-icon'),
      filename: overlay.querySelector('#dv-filename'),
      subtitle: overlay.querySelector('#dv-subtitle'),
      toolbar: overlay.querySelector('#dv-toolbar'),
      infoBtn: overlay.querySelector('#dv-info-btn'),
      fsBtn: overlay.querySelector('#dv-fullscreen-btn'),
      dlBtn: overlay.querySelector('#dv-download-btn'),
      closeBtn: overlay.querySelector('#dv-close-btn'),
      searchBar: overlay.querySelector('#dv-search-bar'),
      searchInput: overlay.querySelector('#dv-search-input'),
      searchCount: overlay.querySelector('#dv-search-count'),
      searchPrev: overlay.querySelector('#dv-search-prev'),
      searchNext: overlay.querySelector('#dv-search-next'),
      searchClose: overlay.querySelector('#dv-search-close'),
      sidebar: overlay.querySelector('#dv-sidebar'),
      content: overlay.querySelector('#dv-content'),
      infoPanel: overlay.querySelector('#dv-info-panel'),
      statusLeft: overlay.querySelector('#dv-status-left'),
      statusRight: overlay.querySelector('#dv-status-right'),
    };

    dom.closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    dom.fsBtn.addEventListener('click', toggleFullscreen);
    dom.infoBtn.addEventListener('click', toggleInfoPanel);
    dom.searchClose.addEventListener('click', closeSearch);
    dom.searchPrev.addEventListener('click', () => stepSearch(-1));
    dom.searchNext.addEventListener('click', () => stepSearch(1));
    dom.searchInput.addEventListener('input', () => runSearch(dom.searchInput.value));
    dom.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') stepSearch(e.shiftKey ? -1 : 1);
      if (e.key === 'Escape') closeSearch();
    });
    document.addEventListener('keydown', onKeydown);

    return dom;
  }

  function onKeydown(e) {
    if (!dom || !dom.overlay.classList.contains('open')) return;
    if (e.key === 'Escape') {
      if (state.searchOpen) closeSearch(); else close();
    } else if (e.key === 'f' || e.key === 'F') {
      if (document.activeElement !== dom.searchInput) toggleFullscreen();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault(); openSearch();
    } else if (e.key === '+' || e.key === '=') {
      if (document.activeElement !== dom.searchInput) { zoomBy(0.15); e.preventDefault(); }
    } else if (e.key === '-') {
      if (document.activeElement !== dom.searchInput) { zoomBy(-0.15); e.preventDefault(); }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (state.category === 'image' && document.activeElement !== dom.searchInput) {
        navigateGallery(e.key === 'ArrowLeft' ? -1 : 1);
        e.preventDefault();
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // OPEN / CLOSE
  // ══════════════════════════════════════════════════════════
  function open(code, file) {
    ensureDOM();
    cleanupPrevious();
    state = freshState();
    state.code = code;
    state.file = file;
    state.category = categoryOf(file.name);
    state.url = `${VAPI}/api/file/${code}/${encodeURIComponent(file.name)}`;

    if (state.category === 'image') {
      const siblings = (window.__lastFilesByCode && window.__lastFilesByCode[code]) || [];
      state.galleryFiles = siblings.filter(f => categoryOf(f.name) === 'image');
      state.galleryIndex = state.galleryFiles.findIndex(f => f.name === file.name);
      if (state.galleryIndex === -1) { state.galleryFiles = [file]; state.galleryIndex = 0; }
    }

    dom.filename.textContent = file.name;
    dom.subtitle.textContent = `${FileSupportPolicy.labelFor(file.name)} · ${fmtBytes(file.size ?? file.bytes)}`;
    dom.icon.textContent = FileSupportPolicy.iconFor(file.name);
    dom.dlBtn.href = state.url;
    dom.dlBtn.download = file.name;
    dom.toolbar.innerHTML = '';
    dom.sidebar.hidden = true;
    dom.sidebar.innerHTML = '';
    dom.infoPanel.hidden = true;
    dom.content.className = 'dv-content';
    dom.content.innerHTML = '';
    dom.statusLeft.textContent = '';
    dom.statusRight.textContent = '';
    closeSearch(true);
    buildInfoPanel();

    dom.overlay.classList.add('open');

    // Which render function handles a file is driven by its policy entry's
    // preview.engine (FileSupportPolicy), not a hand-maintained per-category
    // table — adding/changing a format's preview capability only requires
    // editing app/js/file-support-policy.js.
    const renderersByEngine = {
      'pdfjs': renderPdf,
      'native-image': renderImage,
      'native-media-video': renderVideo,
      'native-media-audio': renderAudio,
      'mammoth': renderWordDocx,
      'sheetjs': renderExcel,
      'pptx-text-extract': renderPptx,
      'plaintext': renderText,
    };
    const policy = FileSupportPolicy.getPolicy(state.file.name);
    if (policy && policy.preview.supported && renderersByEngine[policy.preview.engine]) {
      renderersByEngine[policy.preview.engine]();
    } else if (policy && policy.fallback === 'external-open') {
      renderUnsupportedOffice();
    } else {
      renderFallback();
    }
  }

  function close() {
    if (!dom) return;
    dom.overlay.classList.remove('open');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    cleanupPrevious();
  }

  function cleanupPrevious() {
    if (!state) return;
    state.objectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
    if (state.pdfDoc && typeof PDFEngine !== 'undefined') PDFEngine.destroyDocument(state.pdfDoc);
    else if (state.pdfDoc) { try { state.pdfDoc.destroy(); } catch {} }
    state.pdfDoc = null;
    if (state.mediaCleanup) { try { state.mediaCleanup(); } catch {} }
    const v = dom && dom.content.querySelector('video, audio');
    if (v) { try { v.pause(); v.src = ''; v.load(); } catch {} }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) dom.overlay.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }

  function toggleInfoPanel() {
    dom.infoPanel.hidden = !dom.infoPanel.hidden;
  }

  function buildInfoPanel() {
    const f = state.file;
    dom.infoPanel.innerHTML = `
      <h4>معلومات الملف</h4>
      <div class="dv-info-row"><span class="k">الاسم</span><span class="v">${esc(f.name)}</span></div>
      <div class="dv-info-row"><span class="k">النوع</span><span class="v">${esc(FileSupportPolicy.labelFor(f.name))}</span></div>
      <div class="dv-info-row"><span class="k">الحجم</span><span class="v">${fmtBytes(f.size ?? f.bytes)}</span></div>
      <div class="dv-info-row"><span class="k">آخر تعديل</span><span class="v">${fmtDate(f.modified || f.mtime)}</span></div>
      <div class="dv-info-row"><span class="k">رمز المؤشر</span><span class="v">${esc(state.code)}</span></div>
      <div id="dv-info-extra"></div>
    `;
  }
  function setInfoExtra(html) {
    const el = dom.infoPanel.querySelector('#dv-info-extra');
    if (el) el.innerHTML = html;
  }

  // ── generic loading/error states ──
  function showLoading(msg) {
    dom.content.className = 'dv-content dv-content-center';
    dom.content.innerHTML = `<div class="dv-state"><div class="dv-spinner"></div><div class="dv-state-title">${esc(msg || 'جارٍ التحميل…')}</div></div>`;
  }
  function showError(title, sub) {
    dom.content.className = 'dv-content dv-content-center';
    dom.content.innerHTML = `<div class="dv-state"><div class="dv-state-icon">⚠️</div><div class="dv-state-title">${esc(title)}</div><div class="dv-state-sub">${esc(sub || '')}</div></div>`;
  }

  async function fetchBytes() {
    const res = await fetch(state.url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.arrayBuffer();
  }

  // ══════════════════════════════════════════════════════════
  // TOOLBAR HELPERS
  // ══════════════════════════════════════════════════════════
  function addToolBtn(label, title, onClick, opts) {
    opts = opts || {};
    const b = document.createElement('button');
    b.className = 'dv-btn' + (opts.iconOnly ? ' dv-btn-icon-only' : '');
    b.title = title || label;
    b.textContent = label;
    b.addEventListener('click', onClick);
    dom.toolbar.appendChild(b);
    return b;
  }
  function addSep() {
    const s = document.createElement('div'); s.className = 'dv-sep'; dom.toolbar.appendChild(s);
  }
  function addZoomControls(onZoom, initialPct) {
    addToolBtn('－', 'تصغير', () => onZoom(-0.15), { iconOnly: true });
    const pct = document.createElement('span'); pct.className = 'dv-zoom-pct'; pct.id = 'dv-zoom-pct';
    pct.textContent = Math.round((initialPct || 1) * 100) + '%';
    dom.toolbar.appendChild(pct);
    addToolBtn('＋', 'تكبير', () => onZoom(0.15), { iconOnly: true });
    addToolBtn('⟲', 'إعادة الضبط', () => onZoom(0), { iconOnly: true });
  }
  function updateZoomPct() {
    const el = dom.toolbar.querySelector('#dv-zoom-pct');
    if (el) el.textContent = Math.round(state.zoom * 100) + '%';
  }

  // ══════════════════════════════════════════════════════════
  // SEARCH (generic text-highlight engine used by word/excel/text;
  // PDF has its own page-aware implementation below)
  // ══════════════════════════════════════════════════════════
  async function openSearch() {
    if (!dom.toolbar.querySelector('.dv-search-toggle')) return; // type doesn't support search
    dom.searchBar.hidden = false;
    state.searchOpen = true;
    dom.searchInput.value = '';
    dom.searchInput.focus();
    dom.searchCount.textContent = '';
    if (state.category === 'pdf' && state.pdfEnsureAllText) {
      dom.searchCount.textContent = 'جارٍ تجهيز الفهرس…';
      await state.pdfEnsureAllText();
      dom.searchCount.textContent = '';
    }
  }
  function closeSearch(silent) {
    if (dom) { dom.searchBar.hidden = true; }
    if (state) { state.searchOpen = false; state.searchHits = []; state.searchIndex = -1; }
    if (!silent) clearHighlights();
  }
  function clearHighlights() {
    if (!dom) return;
    dom.content.querySelectorAll('mark.dv-hit').forEach(m => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
  }
  function runSearch(term) {
    clearHighlights();
    state.searchHits = []; state.searchIndex = -1;
    if (!term) { dom.searchCount.textContent = ''; return; }
    const root = state.searchTarget || dom.content;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && ['SCRIPT', 'STYLE'].includes(n.parentElement.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const lower = term.toLowerCase();
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(node => {
      const text = node.nodeValue;
      const lowerText = text.toLowerCase();
      let idx = 0, found = false;
      const frag = document.createDocumentFragment();
      let lastEnd = 0;
      while (true) {
        const pos = lowerText.indexOf(lower, idx);
        if (pos === -1) break;
        found = true;
        frag.appendChild(document.createTextNode(text.slice(lastEnd, pos)));
        const mark = document.createElement('mark');
        mark.className = 'dv-hit';
        mark.textContent = text.slice(pos, pos + term.length);
        frag.appendChild(mark);
        state.searchHits.push(mark);
        lastEnd = pos + term.length;
        idx = lastEnd;
      }
      if (found) {
        frag.appendChild(document.createTextNode(text.slice(lastEnd)));
        node.parentNode.replaceChild(frag, node);
      }
    });
    if (state.searchHits.length) {
      state.searchIndex = 0;
      focusHit();
    }
    dom.searchCount.textContent = state.searchHits.length ? `${state.searchIndex + 1}/${state.searchHits.length}` : 'لا نتائج';
  }
  function stepSearch(dir) {
    if (!state.searchHits.length) return;
    state.searchIndex = (state.searchIndex + dir + state.searchHits.length) % state.searchHits.length;
    focusHit();
    dom.searchCount.textContent = `${state.searchIndex + 1}/${state.searchHits.length}`;
  }
  function focusHit() {
    state.searchHits.forEach(h => h.classList.remove('dv-hit-current'));
    const cur = state.searchHits[state.searchIndex];
    if (cur) { cur.classList.add('dv-hit-current'); cur.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function addSearchToggle() {
    const b = addToolBtn('🔎 بحث', 'بحث في المستند (Ctrl+F)', openSearch, {});
    b.classList.add('dv-search-toggle');
  }

  // ══════════════════════════════════════════════════════════
  // ZOOM (image + generic scalable content)
  // ══════════════════════════════════════════════════════════
  function zoomBy(delta) {
    if (state.category === 'pdf') return zoomPdf(delta);
    if (delta === 0) { state.zoom = 1; state.pan = { x: 0, y: 0, dragging: false }; }
    else state.zoom = Math.min(6, Math.max(0.2, state.zoom + delta));
    updateZoomPct();
    applyImageTransform();
  }

  // ══════════════════════════════════════════════════════════
  // IMAGE RENDERER (+ gallery mode across the indicator's images)
  // ══════════════════════════════════════════════════════════
  let imgPanMove = null, imgPanEnd = null;
  function navigateGallery(delta) {
    if (!state.galleryFiles || state.galleryFiles.length < 2) return;
    const n = state.galleryFiles.length;
    const next = (state.galleryIndex + delta + n) % n;
    open(state.code, state.galleryFiles[next]);
  }
  function renderImage() {
    addZoomControls(zoomBy, 1);
    addSep();
    addToolBtn('⟳ تدوير', 'تدوير 90°', () => {
      state.rotation = (state.rotation + 90) % 360;
      applyImageTransform();
    });
    if (state.galleryFiles && state.galleryFiles.length > 1) {
      addSep();
      addToolBtn('◀', 'الصورة السابقة (←)', () => navigateGallery(-1), { iconOnly: true });
      const counter = document.createElement('span');
      counter.className = 'dv-gallery-counter';
      counter.textContent = `${state.galleryIndex + 1} / ${state.galleryFiles.length}`;
      dom.toolbar.appendChild(counter);
      addToolBtn('▶', 'الصورة التالية (→)', () => navigateGallery(1), { iconOnly: true });
    }
    dom.content.className = 'dv-content dv-content-center';
    dom.content.innerHTML = `<div class="dv-image-stage" id="dv-image-stage"><img id="dv-image-el" src="${state.url}" alt=""></div>`;
    const stage = dom.content.querySelector('#dv-image-stage');
    const img = dom.content.querySelector('#dv-image-el');
    img.addEventListener('error', () => showError('تعذّر عرض الصورة', 'قد يكون الملف تالفًا أو بصيغة غير مدعومة للمعاينة.'));
    img.addEventListener('load', () => {
      dom.statusLeft.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
    });
    // mouse-wheel zoom + drag-to-pan
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.12 : -0.12);
    }, { passive: false });
    stage.addEventListener('mousedown', (e) => {
      state.pan.dragging = true; state.pan.sx = e.clientX; state.pan.sy = e.clientY;
      state.pan.ox = state.pan.x; state.pan.oy = state.pan.y;
      stage.classList.add('dv-grabbing');
    });
    // Each call to renderImage() previously added a fresh pair of window
    // listeners that were never removed (harmless with one image, but
    // gallery mode can call this dozens of times per minute) — remove any
    // prior pair first so listeners never accumulate.
    if (imgPanMove) window.removeEventListener('mousemove', imgPanMove);
    if (imgPanEnd) window.removeEventListener('mouseup', imgPanEnd);
    imgPanMove = (e) => {
      if (!state.pan.dragging) return;
      state.pan.x = state.pan.ox + (e.clientX - state.pan.sx);
      state.pan.y = state.pan.oy + (e.clientY - state.pan.sy);
      applyImageTransform();
    };
    imgPanEnd = () => { state.pan.dragging = false; stage.classList.remove('dv-grabbing'); };
    window.addEventListener('mousemove', imgPanMove);
    window.addEventListener('mouseup', imgPanEnd);
  }
  function applyImageTransform() {
    const img = dom.content.querySelector('#dv-image-el');
    if (!img) return;
    img.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom}) rotate(${state.rotation}deg)`;
  }

  // ══════════════════════════════════════════════════════════
  // PDF RENDERER (pdf.js)
  // ══════════════════════════════════════════════════════════
  function zoomPdf(delta) {
    if (delta === 0) state.zoom = 1;
    else state.zoom = Math.min(4, Math.max(0.3, state.zoom + delta));
    updateZoomPct();
    renderAllPdfPages();
  }
  function rotatePdf() {
    state.pdfRotation = (state.pdfRotation + 90) % 360;
    renderAllPdfPages();
  }
  async function fitPdf(mode) {
    const doc = state.pdfDoc;
    if (!doc) return;
    const page = await doc.getPage(1);
    const natural = page.getViewport({ scale: 1.35, rotation: state.pdfRotation });
    const availW = dom.content.clientWidth - 44; // account for .dv-content padding
    const availH = dom.content.clientHeight - 44;
    const widthRatio = availW / natural.width;
    const heightRatio = availH / natural.height;
    state.zoom = mode === 'width' ? widthRatio : Math.min(widthRatio, heightRatio);
    state.zoom = Math.max(0.2, Math.min(4, state.zoom));
    updateZoomPct();
    await renderAllPdfPages();
  }
  function goToPdfPage(n) {
    const wraps = dom.content.querySelectorAll('.dv-pdf-page-wrap');
    const target = wraps[Math.max(0, Math.min(wraps.length - 1, n - 1))];
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function updatePageCounter() {
    const el = dom.toolbar.querySelector('#dv-page-input');
    if (el) el.value = state.pdfCurrentPage;
  }

  async function printPdf() {
    if (!state.pdfDoc || !state.pdfEnsureAllCanvases) return;
    dom.statusRight.textContent = 'جارٍ تجهيز الطباعة…';
    await state.pdfEnsureAllCanvases();
    const canvases = Array.from(dom.content.querySelectorAll('.dv-pdf-page-wrap canvas'));
    const printRoot = document.createElement('div');
    printRoot.id = 'dv-print-root';
    canvases.forEach(c => {
      const img = document.createElement('img');
      img.src = c.toDataURL('image/png');
      printRoot.appendChild(img);
    });
    document.body.appendChild(printRoot);
    document.body.classList.add('dv-printing');
    dom.statusRight.textContent = '';
    window.print();
    setTimeout(() => {
      document.body.classList.remove('dv-printing');
      printRoot.remove();
    }, 500);
  }

  async function renderPdf() {
    showLoading('جارٍ تحميل ملف PDF…');
    addZoomControls(zoomPdf, 1);
    addSep();
    addToolBtn('⟳', 'تدوير الصفحات', rotatePdf, { iconOnly: true });
    addToolBtn('↔ ملء العرض', 'ملاءمة العرض', () => fitPdf('width'));
    addToolBtn('▢ ملء الصفحة', 'ملاءمة الصفحة', () => fitPdf('page'));
    addSep();
    addSearchToggle();
    addToolBtn('🖨️ طباعة', 'طباعة المستند', printPdf);
    addSep();
    addToolBtn('🧾 الصور المصغّرة', 'إظهار/إخفاء الصفحات', () => {
      dom.sidebar.hidden = !dom.sidebar.hidden;
    });
    addSep();
    addToolBtn('◀', 'الصفحة السابقة', () => goToPdfPage(state.pdfCurrentPage - 1), { iconOnly: true });
    const pageNav = document.createElement('span');
    pageNav.className = 'dv-page-nav';
    pageNav.innerHTML = `<input type="number" min="1" id="dv-page-input" class="dv-page-input"> / <span id="dv-page-total"></span>`;
    dom.toolbar.appendChild(pageNav);
    addToolBtn('▶', 'الصفحة التالية', () => goToPdfPage(state.pdfCurrentPage + 1), { iconOnly: true });
    dom.toolbar.querySelector('#dv-page-input').addEventListener('change', (e) => {
      goToPdfPage(parseInt(e.target.value, 10) || 1);
    });

    state.searchTarget = null; // set once text layers exist

    if (typeof PDFEngine === 'undefined') { showError('تعذّر تحميل عارض PDF', 'مكوّن العرض غير متاح.'); return; }

    try {
      const buf = await fetchBytes();
      // All worker bootstrap, cmap/font paths, and version pinning live in
      // PDFEngine (app/js/pdf-engine.js) — the single source of truth
      // shared with thumbnails.js and dialogs.js. See that file's header
      // comment for the Arabic-rendering disableFontFace note.
      const doc = await PDFEngine.openDocument({ data: buf });
      state.pdfDoc = doc;
      dom.content.className = 'dv-content';
      dom.content.innerHTML = `<div class="dv-pdf-pages" id="dv-pdf-pages"></div>`;
      state.searchTarget = dom.content.querySelector('#dv-pdf-pages');
      const totalEl = dom.toolbar.querySelector('#dv-page-total');
      if (totalEl) totalEl.textContent = doc.numPages;
      dom.statusLeft.textContent = `${doc.numPages} صفحة`;
      setInfoExtra(`<div class="dv-info-row"><span class="k">عدد الصفحات</span><span class="v">${doc.numPages}</span></div>`);
      buildPdfThumbnails(doc);
      await renderAllPdfPages();

      // Jump back to the last page viewed this session for this exact file,
      // if any (in-memory only — see the note by lastPdfPage above).
      const key = `${state.code}/${state.file.name}`;
      const remembered = lastPdfPage.get(key);
      if (remembered && remembered > 1) setTimeout(() => goToPdfPage(remembered), 150);
    } catch (err) {
      // PDFEngine already logged technical detail via console.error and
      // classified the error — the user only ever sees the friendly
      // Arabic message, never a raw pdf.js/worker exception.
      const friendlyTitle = err && err.friendlyTitle;
      const friendlyDetail = err && err.friendlyDetail;
      showError(friendlyTitle || 'تعذّر فتح ملف PDF', friendlyDetail || 'الملف قد يكون تالفًا أو محميًا بكلمة مرور.');
    }
  }
  // Lazy, viewport-driven page rendering: builds correctly-sized empty page
  // placeholders instantly (so scroll height/thumbnails are right away), then
  // only actually rasterizes a page (canvas + text layer) once it scrolls
  // near the visible area. This keeps large PDFs (hundreds of pages) fast
  // and light on memory instead of rendering the whole document up front.
  let pdfObserver = null;
  let pdfPageTracker = null;
  async function renderAllPdfPages() {
    const doc = state.pdfDoc;
    if (!doc) return;
    const container = dom.content.querySelector('#dv-pdf-pages');
    if (!container) return;
    container.innerHTML = '';
    if (pdfObserver) { pdfObserver.disconnect(); pdfObserver = null; }
    if (pdfPageTracker) { pdfPageTracker.disconnect(); pdfPageTracker = null; }

    const wraps = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1.35 * state.zoom, rotation: state.pdfRotation });
      const wrap = document.createElement('div');
      wrap.className = 'dv-pdf-page-wrap dv-pdf-page-skeleton';
      wrap.dataset.pageNum = String(i);
      wrap.dataset.rendered = '0';
      wrap.style.width = viewport.width + 'px';
      wrap.style.height = viewport.height + 'px';
      wrap.innerHTML = `<span class="dv-pdf-page-label">صفحة ${i}</span>`;
      container.appendChild(wrap);
      wraps.push({ wrap, page, viewport });
    }

    async function ensureTextLayer(entry) {
      const { wrap, page, viewport } = entry;
      if (wrap.dataset.textReady === '1') return;
      wrap.dataset.textReady = '1';
      const textLayer = document.createElement('div');
      textLayer.className = 'dv-pdf-textlayer';
      textLayer.style.width = viewport.width + 'px';
      textLayer.style.height = viewport.height + 'px';
      try {
        const textContent = await page.getTextContent();
        const frag = document.createDocumentFragment();
        textContent.items.forEach(item => {
          const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
          const span = document.createElement('span');
          span.textContent = item.str;
          const fontHeight = Math.hypot(tx[2], tx[3]);
          span.style.left = tx[4] + 'px';
          span.style.top = (tx[5] - fontHeight) + 'px';
          span.style.fontSize = fontHeight + 'px';
          frag.appendChild(span);
        });
        textLayer.appendChild(frag);
      } catch {}
      wrap.appendChild(textLayer);
    }
    async function renderOne(entry) {
      const { wrap, page, viewport } = entry;
      if (wrap.dataset.rendered === '1') return;
      wrap.dataset.rendered = '1';
      // Render into a detached canvas and only attach it once painted —
      // rendering directly into a canvas that's already part of the live
      // document can corrupt glyph positioning for some embedded fonts.
      // Never reorder this to insert-then-render. See the contract note
      // on PDFEngine.renderPageToCanvas in app/js/pdf-engine.js.
      const canvas = document.createElement('canvas');
      await PDFEngine.renderPageToCanvas(page, canvas, viewport).promise;
      wrap.classList.remove('dv-pdf-page-skeleton');
      wrap.insertBefore(canvas, wrap.firstChild.nextSibling); // after the page-label span
      await ensureTextLayer(entry);
    }

    // Render the first couple of pages immediately (so the viewer never
    // opens to a blank screen), then lazily render the rest as they
    // approach the visible viewport.
    for (const entry of wraps.slice(0, 2)) await renderOne(entry);

    pdfObserver = new IntersectionObserver((observed) => {
      observed.forEach(o => {
        if (!o.isIntersecting) return;
        const entry = wraps.find(w => w.wrap === o.target);
        if (entry) renderOne(entry);
      });
    }, { root: dom.content, rootMargin: '600px 0px 600px 0px' });
    wraps.forEach(({ wrap }) => pdfObserver.observe(wrap));

    // Tracks whichever page is most visible to drive the page counter and
    // to remember the last-viewed page for this file (session-only).
    pdfPageTracker = new IntersectionObserver((observed) => {
      let best = null;
      observed.forEach(o => {
        if (o.isIntersecting && (!best || o.intersectionRatio > best.intersectionRatio)) best = o;
      });
      if (best) {
        const n = parseInt(best.target.dataset.pageNum, 10);
        state.pdfCurrentPage = n;
        updatePageCounter();
        lastPdfPage.set(`${state.code}/${state.file.name}`, n);
      }
    }, { root: dom.content, threshold: [0.5] });
    wraps.forEach(({ wrap }) => pdfPageTracker.observe(wrap));

    // Full-document search must work regardless of which pages have been
    // scrolled into view yet, so keep a way to backfill every text layer
    // on demand (cheap — no canvas rasterization) right before a search runs.
    state.pdfEnsureAllText = async () => { for (const entry of wraps) await ensureTextLayer(entry); };
    // Printing needs actual pixels, so this backfill does the (heavier)
    // canvas rasterization for any pages the user hasn't scrolled to yet.
    state.pdfEnsureAllCanvases = async () => { for (const entry of wraps) await renderOne(entry); };
  }
  function buildPdfThumbnails(doc) {
    dom.sidebar.innerHTML = '';
    for (let i = 1; i <= doc.numPages; i++) {
      const t = document.createElement('div');
      t.className = 'dv-thumb';
      t.innerHTML = `<span class="dv-thumb-num">${i}</span>`;
      t.addEventListener('click', () => goToPdfPage(i));
      dom.sidebar.appendChild(t);
      // Render into a detached canvas and only attach it once painted —
      // same contract as renderOne() above and PDFEngine.renderPageToCanvas
      // (see its header comment in app/js/pdf-engine.js). Building the
      // <canvas> inside t.innerHTML above and rendering into it in place
      // would attach it to the live DOM before the render starts.
      doc.getPage(i).then(async (page) => {
        const vp = page.getViewport({ scale: 0.2 });
        const c = document.createElement('canvas');
        await PDFEngine.renderPageToCanvas(page, c, vp).promise;
        t.appendChild(c);
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  // VIDEO / AUDIO RENDERER (custom themed controls over native element)
  // ══════════════════════════════════════════════════════════
  function renderVideo() { renderMedia('video'); }
  function renderAudio() { renderMedia('audio'); }
  function renderMedia(kind) {
    dom.content.className = 'dv-content dv-content-center';
    const mediaTag = kind === 'video'
      ? `<video class="dv-video-frame" id="dv-media-el" preload="metadata"></video>`
      : `<div class="dv-audio-art">🎧</div>`;
    dom.content.innerHTML = `
      <div class="dv-media-wrap">
        ${mediaTag}
        ${kind === 'audio' ? `<audio id="dv-media-el" preload="metadata" style="display:none"></audio>` : ''}
        <div class="dv-media-controls">
          <div class="dv-media-row">
            <button class="dv-play-btn" id="dv-play-btn">▶</button>
            <button class="dv-skip-btn" id="dv-skip-back" title="رجوع 10 ثوانٍ">⏪ 10</button>
            <span class="dv-media-time" id="dv-time-cur">00:00</span>
            <div class="dv-seek-wrap" id="dv-seek-wrap">
              <div class="dv-media-buffered" id="dv-buffered"></div>
              <input type="range" class="dv-media-seek" id="dv-seek" min="0" max="100" value="0" step="0.1">
              <div class="dv-seek-preview" id="dv-seek-preview" hidden><canvas width="120" height="68"></canvas><span id="dv-seek-preview-time"></span></div>
            </div>
            <span class="dv-media-time" id="dv-time-dur" title="اضغط للتبديل بين الوقت المتبقي/الكلي">00:00</span>
            <button class="dv-skip-btn" id="dv-skip-fwd" title="تقديم 10 ثوانٍ">10 ⏩</button>
          </div>
          <div class="dv-media-sub-row">
            <span class="dv-vol-icon" id="dv-mute-btn">🔊</span>
            <input type="range" id="dv-vol" min="0" max="1" step="0.01" value="1" style="width:90px">
            <span>السرعة:</span>
            <select id="dv-speed">
              <option value="0.5">0.5x</option><option value="0.75">0.75x</option>
              <option value="1" selected>1x</option><option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option><option value="2">2x</option>
            </select>
          </div>
        </div>
      </div>`;
    const media = dom.content.querySelector('#dv-media-el');
    media.src = state.url;
    const playBtn = dom.content.querySelector('#dv-play-btn');
    const seek = dom.content.querySelector('#dv-seek');
    const seekWrap = dom.content.querySelector('#dv-seek-wrap');
    const buffered = dom.content.querySelector('#dv-buffered');
    const curEl = dom.content.querySelector('#dv-time-cur');
    const durEl = dom.content.querySelector('#dv-time-dur');
    const vol = dom.content.querySelector('#dv-vol');
    const muteBtn = dom.content.querySelector('#dv-mute-btn');
    const speed = dom.content.querySelector('#dv-speed');
    const skipBack = dom.content.querySelector('#dv-skip-back');
    const skipFwd = dom.content.querySelector('#dv-skip-fwd');
    const previewBox = dom.content.querySelector('#dv-seek-preview');
    const previewCanvas = previewBox.querySelector('canvas');
    const previewTime = dom.content.querySelector('#dv-seek-preview-time');
    let showRemaining = false;

    function fmtT(s) {
      if (!isFinite(s)) return '00:00';
      const m = Math.floor(s / 60), sec = Math.floor(s % 60);
      return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    }
    function updateDurLabel() {
      if (!isFinite(media.duration)) return;
      durEl.textContent = showRemaining ? '-' + fmtT(media.duration - media.currentTime) : fmtT(media.duration);
    }
    playBtn.addEventListener('click', () => { media.paused ? media.play() : media.pause(); });
    media.addEventListener('play', () => playBtn.textContent = '⏸');
    media.addEventListener('pause', () => playBtn.textContent = '▶');
    media.addEventListener('loadedmetadata', () => {
      updateDurLabel();
      dom.statusLeft.textContent = kind === 'video' && media.videoWidth ? `${media.videoWidth}×${media.videoHeight}` : '';
      setInfoExtra(`<div class="dv-info-row"><span class="k">المدة</span><span class="v">${fmtT(media.duration)}</span></div>`);
    });
    media.addEventListener('timeupdate', () => {
      if (!seek.dragging) seek.value = (media.duration ? media.currentTime / media.duration * 100 : 0);
      curEl.textContent = fmtT(media.currentTime);
      updateDurLabel();
    });
    media.addEventListener('progress', () => {
      if (media.duration && media.buffered.length) {
        const end = media.buffered.end(media.buffered.length - 1);
        buffered.style.width = Math.min(100, (end / media.duration) * 100) + '%';
      }
    });
    media.addEventListener('error', () => showError('تعذّر تشغيل الملف', 'قد تكون الصيغة غير مدعومة من المشغّل المدمج. يمكنك تحميل الملف لفتحه في مشغّل خارجي.'));
    seek.addEventListener('mousedown', () => seek.dragging = true);
    seek.addEventListener('mouseup', () => seek.dragging = false);
    seek.addEventListener('input', () => {
      if (media.duration) media.currentTime = seek.value / 100 * media.duration;
    });
    durEl.addEventListener('click', () => { showRemaining = !showRemaining; updateDurLabel(); });
    skipBack.addEventListener('click', () => { media.currentTime = Math.max(0, media.currentTime - 10); });
    skipFwd.addEventListener('click', () => { media.currentTime = Math.min(media.duration || Infinity, media.currentTime + 10); });
    vol.addEventListener('input', () => { media.volume = vol.value; muteBtn.textContent = vol.value == 0 ? '🔇' : '🔊'; });
    muteBtn.addEventListener('click', () => {
      media.muted = !media.muted;
      muteBtn.textContent = media.muted ? '🔇' : '🔊';
    });
    speed.addEventListener('change', () => media.playbackRate = parseFloat(speed.value));

    if (kind === 'video') {
      media.addEventListener('dblclick', toggleFullscreen);
      setupScrubPreview();
    }

    // Hover-scrub thumbnail preview: seeks a hidden, muted clone of the video
    // to the hovered timestamp and grabs a frame — throttled and cached per
    // ~2s bucket so rapid hovering doesn't re-seek constantly.
    function setupScrubPreview() {
      let shadow = null;
      let pending = false;
      const frameCache = new Map();
      function ensureShadow() {
        if (shadow) return shadow;
        shadow = document.createElement('video');
        shadow.src = state.url; shadow.muted = true; shadow.preload = 'auto';
        shadow.style.display = 'none';
        document.body.appendChild(shadow);
        return shadow;
      }
      seekWrap.addEventListener('mousemove', (e) => {
        if (!media.duration || seek.dragging) { previewBox.hidden = true; return; }
        const rect = seekWrap.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        const t = ratio * media.duration;
        previewBox.hidden = false;
        previewBox.style.left = Math.min(rect.width - 66, Math.max(0, ratio * rect.width - 60)) + 'px';
        previewTime.textContent = fmtT(t);
        const bucket = Math.floor(t / 2);
        if (frameCache.has(bucket)) {
          drawPreview(frameCache.get(bucket));
          return;
        }
        if (pending) return;
        pending = true;
        const sv = ensureShadow();
        const onSeeked = () => {
          try {
            const ctx = previewCanvas.getContext('2d');
            ctx.drawImage(sv, 0, 0, previewCanvas.width, previewCanvas.height);
            const data = previewCanvas.toDataURL('image/jpeg', 0.6);
            frameCache.set(bucket, data);
          } catch {}
          pending = false;
          sv.removeEventListener('seeked', onSeeked);
        };
        sv.addEventListener('seeked', onSeeked);
        try { sv.currentTime = bucket * 2; } catch { pending = false; }
      });
      seekWrap.addEventListener('mouseleave', () => { previewBox.hidden = true; });
      function drawPreview(dataUrl) {
        const ctx = previewCanvas.getContext('2d');
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, previewCanvas.width, previewCanvas.height);
        img.src = dataUrl;
      }
      // Clean up the shadow video whenever this viewer instance closes.
      const prevCleanup = state.mediaCleanup;
      state.mediaCleanup = () => { prevCleanup && prevCleanup(); if (shadow) { shadow.src = ''; shadow.remove(); } };
    }
  }

  // ══════════════════════════════════════════════════════════
  // WORD (.docx) via mammoth.js
  // ══════════════════════════════════════════════════════════
  async function renderWordDocx() {
    showLoading('جارٍ تحميل مستند Word…');
    addSearchToggle();
    addSep();
    addZoomControls(zoomBy, 1);
    if (typeof mammoth === 'undefined') { showError('تعذّر تحميل عارض Word', 'مكوّن العرض غير متاح.'); return; }
    try {
      const buf = await fetchBytes();
      const result = await mammoth.convertToHtml({ arrayBuffer: buf });
      dom.content.className = 'dv-content';
      dom.content.innerHTML = `<div class="dv-office-doc" id="dv-office-doc">${result.value}</div>`;
      state.searchTarget = dom.content.querySelector('#dv-office-doc');
      applyDocZoom();
      const wc = (dom.content.textContent || '').trim().split(/\s+/).filter(Boolean).length;
      setInfoExtra(`<div class="dv-info-row"><span class="k">عدد الكلمات (تقريبي)</span><span class="v">${wc}</span></div>`);
      if (result.messages && result.messages.length) {
        dom.statusRight.textContent = 'تم العرض مع بعض التبسيط في التنسيق';
      }
    } catch (err) {
      console.error(err);
      showError('تعذّر عرض المستند', 'قد يكون الملف تالفًا أو محميًا بكلمة مرور.');
    }
  }
  function applyDocZoom() {
    const el = dom.content.querySelector('#dv-office-doc');
    if (el) el.style.fontSize = (0.95 * state.zoom) + 'rem';
  }
  // override generic zoomBy for doc/text zoom repaint
  const _zoomByBase = zoomBy;

  // ══════════════════════════════════════════════════════════
  // EXCEL / CSV via SheetJS
  // ══════════════════════════════════════════════════════════
  async function renderExcel() {
    showLoading('جارٍ تحميل جدول البيانات…');
    addSearchToggle();
    if (typeof XLSX === 'undefined') { showError('تعذّر تحميل عارض الجداول', 'مكوّن العرض غير متاح.'); return; }
    try {
      const buf = await fetchBytes();
      const wb = XLSX.read(buf, { type: 'array' });
      dom.content.className = 'dv-content dv-content-flush';
      dom.content.innerHTML = `<div style="display:flex;flex-direction:column;width:100%;height:100%">
        <div class="dv-sheet-tabs" id="dv-sheet-tabs"></div>
        <div class="dv-table-wrap" id="dv-table-wrap"></div>
      </div>`;
      const tabsEl = dom.content.querySelector('#dv-sheet-tabs');
      const wrapEl = dom.content.querySelector('#dv-table-wrap');
      setInfoExtra(`<div class="dv-info-row"><span class="k">عدد الأوراق</span><span class="v">${wb.SheetNames.length}</span></div>`);
      function drawSheet(name) {
        const sheet = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
        let html = '<table class="dv-table"><tbody>';
        rows.forEach((row, ri) => {
          html += '<tr>' + `<td class="dv-row-idx">${ri + 1}</td>` + row.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>';
        });
        html += '</tbody></table>';
        wrapEl.innerHTML = html;
        state.searchTarget = wrapEl;
        dom.statusLeft.textContent = `${rows.length} صف`;
      }
      wb.SheetNames.forEach((name, i) => {
        const tab = document.createElement('div');
        tab.className = 'dv-sheet-tab' + (i === 0 ? ' active' : '');
        tab.textContent = name;
        tab.addEventListener('click', () => {
          tabsEl.querySelectorAll('.dv-sheet-tab').forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          drawSheet(name);
        });
        tabsEl.appendChild(tab);
      });
      drawSheet(wb.SheetNames[0]);
    } catch (err) {
      console.error(err);
      showError('تعذّر عرض الجدول', 'قد يكون الملف تالفًا أو بصيغة غير مدعومة.');
    }
  }

  // ══════════════════════════════════════════════════════════
  // TEXT (.txt/.md/.log/.json/.xml)
  // ══════════════════════════════════════════════════════════
  async function renderText() {
    showLoading('جارٍ تحميل الملف النصي…');
    addSearchToggle();
    addSep();
    addZoomControls(zoomBy, 1);
    try {
      const res = await fetch(state.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      dom.content.className = 'dv-content dv-content-flush';
      const pre = document.createElement('pre');
      pre.className = 'dv-text-pre';
      pre.id = 'dv-text-pre';
      pre.textContent = text;
      pre.style.fontSize = '.82rem';
      dom.content.appendChild(pre);
      state.searchTarget = pre;
      const lines = text.split('\n').length;
      dom.statusLeft.textContent = `${lines} سطر · ${text.length} حرف`;
    } catch (err) {
      console.error(err);
      showError('تعذّر عرض الملف', 'حدث خطأ أثناء تحميل محتوى الملف.');
    }
  }

  // ══════════════════════════════════════════════════════════
  // PPTX — best-effort client-side slide renderer via JSZip
  // (extracts titles / bullet text / images per slide; this is a
  // content preview, not a pixel-accurate layout renderer, since no
  // real PowerPoint rendering engine is available client-side.)
  // ══════════════════════════════════════════════════════════
  async function renderPptx() {
    showLoading('جارٍ تحليل عرض PowerPoint…');
    if (typeof JSZip === 'undefined') { showError('تعذّر تحميل عارض العروض', 'مكوّن العرض غير متاح.'); return; }
    try {
      const buf = await fetchBytes();
      const zip = await JSZip.loadAsync(buf);
      const slideFiles = Object.keys(zip.files)
        .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .sort((a, b) => {
          const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
          const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
          return na - nb;
        });
      if (!slideFiles.length) throw new Error('no slides found');

      const parser = new DOMParser();
      const slides = [];
      for (const path of slideFiles) {
        const xmlText = await zip.file(path).async('text');
        const xdoc = parser.parseFromString(xmlText, 'application/xml');
        const shapes = Array.from(xdoc.getElementsByTagName('p:sp'));
        let title = '', bullets = [];
        shapes.forEach(sp => {
          const ph = sp.getElementsByTagName('p:ph')[0];
          const isTitle = ph && /title/i.test(ph.getAttribute('type') || '');
          const paras = Array.from(sp.getElementsByTagName('a:p'));
          paras.forEach(p => {
            const runs = Array.from(p.getElementsByTagName('a:t')).map(t => t.textContent).join('');
            if (!runs.trim()) return;
            if (isTitle && !title) title = runs;
            else bullets.push(runs);
          });
        });
        // images: map r:embed -> media file via slide rels
        const images = [];
        const relsPath = path.replace('slides/slide', 'slides/_rels/slide') + '.rels';
        const relsFile = zip.file(relsPath);
        let relMap = {};
        if (relsFile) {
          const relsXml = parser.parseFromString(await relsFile.async('text'), 'application/xml');
          Array.from(relsXml.getElementsByTagName('Relationship')).forEach(r => {
            relMap[r.getAttribute('Id')] = r.getAttribute('Target');
          });
        }
        const blips = Array.from(xdoc.getElementsByTagName('a:blip'));
        for (const b of blips) {
          const rId = b.getAttribute('r:embed');
          const target = rId && relMap[rId];
          if (!target) continue;
          const mediaPath = resolveOoxmlPath('ppt/slides', target);
          const mf = zip.file(mediaPath);
          if (mf) {
            const base64 = await mf.async('base64');
            const ext = mediaPath.split('.').pop().toLowerCase();
            const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' }[ext] || 'image/png';
            images.push(`data:${mime};base64,${base64}`);
          }
        }
        slides.push({ title, bullets, images });
      }

      dom.content.className = 'dv-content dv-content-flush';
      dom.content.innerHTML = `<div class="dv-slides-wrap">
        <div class="dv-slides-rail" id="dv-slides-rail"></div>
        <div class="dv-slide-stage" id="dv-slide-stage"></div>
      </div>`;
      const rail = dom.content.querySelector('#dv-slides-rail');
      const stage = dom.content.querySelector('#dv-slide-stage');
      setInfoExtra(`<div class="dv-info-row"><span class="k">عدد الشرائح</span><span class="v">${slides.length}</span></div>
        <div class="dv-info-row"><span class="k">ملاحظة</span><span class="v" style="font-size:.68rem;font-weight:500">معاينة للمحتوى النصي والصور — وليست عرضًا مطابقًا للتصميم الأصلي</span></div>`);
      dom.statusLeft.textContent = `${slides.length} شريحة`;

      function draw(i) {
        rail.querySelectorAll('.dv-slide-thumb').forEach((t, ti) => t.classList.toggle('active', ti === i));
        const s = slides[i];
        let html = '';
        if (s.title) html += `<h3>${esc(s.title)}</h3>`;
        if (s.bullets.length) html += `<ul>${s.bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>`;
        if (!s.title && !s.bullets.length && !s.images.length) html += `<div class="dv-slide-empty-text">لا يوجد نص قابل للاستخراج في هذه الشريحة</div>`;
        s.images.forEach(src => html += `<img src="${src}">`);
        stage.innerHTML = `<div class="dv-slide-canvas">${html}</div>`;
        state.searchTarget = stage;
      }
      slides.forEach((s, i) => {
        const t = document.createElement('div');
        t.className = 'dv-slide-thumb';
        t.innerHTML = `<span class="dv-slide-thumb-num">${i + 1}</span>${esc(s.title || '(بدون عنوان)')}`;
        t.addEventListener('click', () => draw(i));
        rail.appendChild(t);
      });
      draw(0);
      addSearchToggle();
    } catch (err) {
      console.error(err);
      showError('تعذّر عرض الشرائح داخل التطبيق', 'يمكن تحميل الملف وفتحه في برنامج العروض التقديمية.');
    }
  }

  // ══════════════════════════════════════════════════════════
  // Legacy office formats (.doc/.ppt/.odt/.odp/.ods) — no reliable
  // client-side parser exists for these binary/ODF formats; be
  // honest about it and offer the download instead of a fake preview.
  // ══════════════════════════════════════════════════════════
  function renderUnsupportedOffice() {
    showError(
      'هذا التنسيق لا يمكن معاينته داخل التطبيق حاليًا',
      'صيغة الملف قديمة أو غير قابلة للتحليل من المتصفح مباشرة. يمكنك تحميل الملف وفتحه في برنامجه الأصلي.'
    );
  }
  function renderFallback() {
    showError('لا تتوفر معاينة لهذا النوع من الملفات', 'يمكنك تحميل الملف لفتحه خارج التطبيق.');
  }

  return { open, close };
})();
