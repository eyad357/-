/* ════════════════════════════════════════════════════════════
   FILE GRID CONTROLS — Search / Sort / Filter — Part 2 remainder
   ────────────────────────────────────────────────────────────
   Additive module. Re-renders the already-fetched file list
   (window.__lastFilesByCode[code], populated by loadFiles() in
   index.html) client-side — no extra network calls for search/
   sort/filter, so it stays instant even with thousands of files.
   Reuses the existing buildFileCard(code, file) card renderer.
   ════════════════════════════════════════════════════════════ */

const FileGridControls = (function () {
  'use strict';

  // Filter-chip buckets — same categories FileSupportPolicy assigns
  // everywhere else in the app (the server's file.category field, the
  // viewer, thumbnails, dialogs). No local extension→bucket table here.
  const FILTER_ORDER = ['pdf', 'word', 'excel', 'csv', 'powerpoint', 'image', 'video', 'audio', 'text', 'archive', 'other'];
  const FILTER_LABELS = FILTER_ORDER.reduce((acc, cat) => {
    const meta = FileSupportPolicy.getCategoryMeta(cat);
    acc[cat] = `${meta.icon} ${meta.labelAr}`;
    return acc;
  }, {});

  function filterBucket(name) {
    return FileSupportPolicy.getCategory(name);
  }

  // code -> { search, sortField, sortDir, filters:Set }
  const state = new Map();
  function getState(code) {
    if (!state.has(code)) state.set(code, { search: '', sortField: 'name', sortDir: 'asc', filters: new Set() });
    return state.get(code);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function mountToolbar(code) {
    const el = document.getElementById(`ev-toolbar-${code}`);
    if (!el || el.dataset.mounted === '1') return;
    el.dataset.mounted = '1';
    const chips = FILTER_ORDER.map(k => `<button class="fgc-chip" data-filter="${k}" data-code="${code}">${FILTER_LABELS[k]}</button>`).join('');
    el.innerHTML = `
      <div class="fgc-row">
        <input class="fgc-search" id="fgc-search-${code}" placeholder="🔎 بحث بالاسم، الامتداد، النوع، التاريخ أو الحجم…" autocomplete="off">
        <select class="fgc-select" id="fgc-sort-field-${code}">
          <option value="name">الاسم</option>
          <option value="date">التاريخ</option>
          <option value="size">الحجم</option>
          <option value="type">النوع</option>
        </select>
        <button class="fgc-dir-btn" id="fgc-sort-dir-${code}" title="اتجاه الفرز">⬆ تصاعدي</button>
        <span class="fgc-result-count" id="fgc-count-${code}"></span>
      </div>
      <div class="fgc-chips" id="fgc-chips-${code}">${chips}</div>
    `;
    const s = getState(code);
    el.querySelector(`#fgc-search-${code}`).addEventListener('input', (e) => {
      s.search = e.target.value.trim().toLowerCase();
      render(code);
    });
    el.querySelector(`#fgc-sort-field-${code}`).value = s.sortField;
    el.querySelector(`#fgc-sort-field-${code}`).addEventListener('change', (e) => {
      s.sortField = e.target.value;
      render(code);
    });
    const dirBtn = el.querySelector(`#fgc-sort-dir-${code}`);
    dirBtn.addEventListener('click', () => {
      s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
      dirBtn.textContent = s.sortDir === 'asc' ? '⬆ تصاعدي' : '⬇ تنازلي';
      render(code);
    });
    el.querySelectorAll('.fgc-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const f = chip.dataset.filter;
        if (s.filters.has(f)) { s.filters.delete(f); chip.classList.remove('active'); }
        else { s.filters.add(f); chip.classList.add('active'); }
        render(code);
      });
    });
  }

  function fmtCombined(file) {
    // one composite string search matches against: filename, extension,
    // type label, formatted date, and formatted size.
    const bucket = filterBucket(file.name);
    return [
      file.name,
      file.ext,
      FILTER_LABELS[bucket] || bucket,
      new Date(file.modified).toLocaleDateString('ar-SA'),
      new Date(file.modified).toLocaleDateString('en-CA'), // ISO-ish, so typing "2026-07" style also works
      file.size,
    ].join(' ').toLowerCase();
  }

  function applySearchSortFilter(code, files) {
    const s = getState(code);
    let out = files;
    if (s.filters.size) out = out.filter(f => s.filters.has(filterBucket(f.name)));
    if (s.search) out = out.filter(f => fmtCombined(f).includes(s.search));

    const dir = s.sortDir === 'asc' ? 1 : -1;
    out = [...out].sort((a, b) => {
      switch (s.sortField) {
        case 'date': return dir * (new Date(a.modified) - new Date(b.modified));
        case 'size': return dir * ((a.bytes || 0) - (b.bytes || 0));
        case 'type': return dir * filterBucket(a.name).localeCompare(filterBucket(b.name));
        case 'name':
        default: return dir * a.name.localeCompare(b.name, 'ar');
      }
    });
    return out;
  }

  // Renders the grid for `code` from the cached, already-fetched file list.
  // This is the single re-render path used by search/sort/filter changes,
  // and is also called once right after loadFiles() populates the cache.
  function render(code) {
    const body = document.getElementById(`ev-body-${code}`);
    if (!body) return;
    const allFiles = (window.__lastFilesByCode && window.__lastFilesByCode[code]) || [];
    const countEl = document.getElementById(`fgc-count-${code}`);

    if (!allFiles.length) return; // loadFiles() already renders the "no files" empty state

    const visible = applySearchSortFilter(code, allFiles);
    if (countEl) {
      const s = getState(code);
      countEl.textContent = (s.search || s.filters.size)
        ? `${visible.length} من ${allFiles.length}`
        : `${allFiles.length} ملف`;
    }

    if (!visible.length) {
      body.innerHTML = `<div class="evidence-empty">
        <div class="evidence-empty-icon">🔍</div>
        <div class="evidence-empty-text">لا توجد ملفات مطابقة للبحث/الفلاتر الحالية</div>
      </div>`;
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'file-grid';
    visible.forEach(f => grid.appendChild(buildFileCard(code, f)));
    body.innerHTML = '';
    body.appendChild(grid);
  }

  return { mountToolbar, render, getState };
})();
