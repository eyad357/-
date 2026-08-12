/* ════════════════════════════════════════════════════════════
   RENAME + PROPERTIES DIALOGS — Part 2 remainder
   ────────────────────────────────────────────────────────────
   Additive module. Two small centered modals, built the same way
   as the Viewer/Uploader overlays (injected via JS, no static HTML
   changes). Properties looks up domain/standard/indicator text from
   the existing global `DOMAINS` structure already defined in
   index.html — read-only, nothing there is modified.
   ════════════════════════════════════════════════════════════ */

const Dialogs = (function () {
  'use strict';

  const DAPI = ''; // same-origin

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  function fmtDuration(sec) {
    if (!isFinite(sec)) return '—';
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function findIndicatorContext(code) {
    if (typeof DOMAINS === 'undefined') return null;
    for (const d of DOMAINS) {
      for (const s of d.standards) {
        for (const i of s.indicators) {
          if (i.code === code) return { domain: d.shortTitle || d.title, standard: s.name, indicatorText: i.txt };
        }
      }
    }
    return null;
  }

  // ── shared overlay scaffold ──
  function openOverlay(className) {
    const overlay = document.createElement('div');
    overlay.className = 'dlg-overlay ' + className;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
    function close() {
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 150);
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const escHandler = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escHandler); } };
    document.addEventListener('keydown', escHandler);
    return { overlay, close };
  }

  // ══════════════════════════════════════════════════════════
  // RENAME
  // ══════════════════════════════════════════════════════════
  function showRename(code, file) {
    const { overlay, close } = openOverlay('dlg-rename');
    const dotIdx = file.name.lastIndexOf('.');
    const baseName = dotIdx > 0 ? file.name.slice(0, dotIdx) : file.name;
    const ext = dotIdx > 0 ? file.name.slice(dotIdx) : '';

    overlay.innerHTML = `
      <div class="dlg-box">
        <div class="dlg-header"><span>✏️ إعادة تسمية الملف</span><button class="dlg-close">✕</button></div>
        <div class="dlg-body">
          <label class="dlg-label">الاسم الجديد</label>
          <div class="dlg-rename-row">
            <input type="text" class="dlg-input" id="dlg-rename-input" value="${esc(baseName)}">
            <span class="dlg-rename-ext">${esc(ext)}</span>
          </div>
          <div class="dlg-error" id="dlg-rename-error" hidden></div>
        </div>
        <div class="dlg-footer">
          <button class="dlg-btn dlg-btn-secondary" id="dlg-rename-cancel">إلغاء</button>
          <button class="dlg-btn dlg-btn-primary" id="dlg-rename-save">حفظ</button>
        </div>
      </div>`;

    overlay.querySelector('.dlg-close').addEventListener('click', close);
    overlay.querySelector('#dlg-rename-cancel').addEventListener('click', close);
    const input = overlay.querySelector('#dlg-rename-input');
    const errorEl = overlay.querySelector('#dlg-rename-error');
    input.focus();
    input.setSelectionRange(0, baseName.length);

    async function doRename() {
      const newBase = input.value.trim();
      errorEl.hidden = true;
      if (!newBase) { errorEl.textContent = 'الاسم لا يمكن أن يكون فارغًا'; errorEl.hidden = false; return; }
      const newName = newBase + ext;
      if (newName === file.name) { close(); return; }
      try {
        const r = await fetch(`${DAPI}/api/file/${code}/rename`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ oldName: file.name, newName }),
        });
        const d = await r.json();
        if (!r.ok) { errorEl.textContent = d.error || 'فشلت إعادة التسمية'; errorEl.hidden = false; return; }
        showToast('✅ تمت إعادة التسمية');
        close();
        loadFiles(code); // SSE from the watcher will also refresh, this just feels instant
      } catch (err) {
        errorEl.textContent = 'تعذّر الاتصال بالخادم'; errorEl.hidden = false;
      }
    }
    overlay.querySelector('#dlg-rename-save').addEventListener('click', doRename);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doRename(); });
  }

  // ══════════════════════════════════════════════════════════
  // PROPERTIES
  // ══════════════════════════════════════════════════════════
  // File-type label for the properties panel — from FileSupportPolicy
  // (single source of truth), not a local copy.

  function row(label, value) {
    return `<div class="dlg-prop-row"><span class="dlg-prop-k">${esc(label)}</span><span class="dlg-prop-v" id="dlg-prop-${label}">${value}</span></div>`;
  }

  function showProperties(code, file) {
    const { overlay, close } = openOverlay('dlg-props');
    const ctx = findIndicatorContext(code);

    overlay.innerHTML = `
      <div class="dlg-box dlg-box-wide">
        <div class="dlg-header"><span>ℹ️ خصائص الملف</span><button class="dlg-close">✕</button></div>
        <div class="dlg-body">
          <div class="dlg-prop-grid">
            ${row('الاسم', esc(file.name))}
            ${row('الامتداد', esc(file.ext || '—'))}
            ${row('النوع', esc(FileSupportPolicy.labelFor(file.name)))}
            ${row('الحجم', fmtBytes(file.bytes))}
            ${row('تاريخ الإنشاء', fmtDate(file.created))}
            ${row('آخر تعديل', fmtDate(file.modified))}
            ${row('المسار', `<span class="dlg-path" title="${esc(file.path || '')}">${esc(file.path || '—')}</span>`)}
            ${row('المجال', esc(ctx ? ctx.domain : '—'))}
            ${row('المعيار', esc(ctx ? ctx.standard : '—'))}
            ${row('المؤشر', esc(ctx ? (code + ' — ' + ctx.indicatorText) : code))}
          </div>
          <div class="dlg-prop-extra" id="dlg-prop-extra">
            <div class="dlg-prop-loading">⏳ جارٍ استخراج معلومات إضافية…</div>
          </div>
        </div>
        <div class="dlg-footer">
          <button class="dlg-btn dlg-btn-secondary" id="dlg-props-copy">📋 نسخ المسار</button>
          <button class="dlg-btn dlg-btn-primary" id="dlg-props-close">إغلاق</button>
        </div>
      </div>`;

    overlay.querySelector('.dlg-close').addEventListener('click', close);
    overlay.querySelector('#dlg-props-close').addEventListener('click', close);
    overlay.querySelector('#dlg-props-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(file.path || file.name); showToast('📋 تم نسخ المسار'); }
      catch { showToast('❌ تعذّر النسخ', 'error'); }
    });

    loadExtraProps(code, file, overlay.querySelector('#dlg-prop-extra'));
  }

  async function loadExtraProps(code, file, container) {
    const url = `${DAPI}/api/file/${code}/${encodeURIComponent(file.name)}`;
    try {
      if (file.category === 'image') {
        const dims = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => reject(new Error('fail'));
          img.src = url;
        });
        container.innerHTML = `<div class="dlg-prop-row"><span class="dlg-prop-k">الأبعاد</span><span class="dlg-prop-v">${dims.w} × ${dims.h} px</span></div>`;
      } else if (file.category === 'video' || file.category === 'audio') {
        const el = document.createElement(file.category === 'video' ? 'video' : 'audio');
        el.preload = 'metadata'; el.src = url;
        const duration = await new Promise((resolve, reject) => {
          el.addEventListener('loadedmetadata', () => resolve(el.duration));
          el.addEventListener('error', () => reject(new Error('fail')));
          setTimeout(() => reject(new Error('timeout')), 8000);
        });
        container.innerHTML = `<div class="dlg-prop-row"><span class="dlg-prop-k">المدة</span><span class="dlg-prop-v">${fmtDuration(duration)}</span></div>`;
      } else if (file.category === 'pdf' && typeof PDFEngine !== 'undefined') {
        // Routed through PDFEngine (app/js/pdf-engine.js) — the single
        // source of truth for pdf.js worker bootstrap and version, shared
        // with viewer.js and thumbnails.js. Only page count is needed
        // here, so openDocumentLite() skips cmap/font loading for speed.
        const doc = await PDFEngine.openDocumentLite({ url });
        const pages = doc.numPages;
        PDFEngine.destroyDocument(doc);
        container.innerHTML = `<div class="dlg-prop-row"><span class="dlg-prop-k">عدد الصفحات</span><span class="dlg-prop-v">${pages}</span></div>`;
      } else {
        container.innerHTML = '';
      }
    } catch {
      container.innerHTML = '<div class="dlg-prop-loading">تعذّر استخراج معلومات إضافية لهذا الملف</div>';
    }
  }

  return { showRename, showProperties };
})();
