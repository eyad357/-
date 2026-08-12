/* ════════════════════════════════════════════════════════════
   PER-INDICATOR FILE STATISTICS + RECENT FILES — Phase 1.5 / Part 2
   ────────────────────────────────────────────────────────────
   Additive module. Statistics are computed entirely client-side from
   the file list the page already fetches from GET /api/files/:code
   (no extra backend call). "Recently viewed" is the one piece that
   needs a server round trip, via the new /api/recent-views/:code
   endpoint, since it tracks activity over time rather than current
   file-system state.
   ════════════════════════════════════════════════════════════ */

const IndicatorExtras = (function () {
  'use strict';

  const IAPI = ''; // same-origin

  // Category label/icon for the per-indicator stats chips — from
  // FileSupportPolicy (single source of truth), not a local copy.

  function fmtBytes(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
  }
  function fmtDate(d) {
    if (!d) return '—';
    try { return new Date(d).toLocaleDateString('ar-SA', { day: 'numeric', month: 'short' }); }
    catch { return String(d); }
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function iconFor(name) {
    const ext = '.' + String(name).split('.').pop().toLowerCase();
    return (typeof fileIcon === 'function') ? fileIcon(ext) : '📄';
  }

  // ── STATISTICS ──
  function renderStats(code, files) {
    const el = document.getElementById(`ev-stats-${code}`);
    if (!el) return;
    if (!files || !files.length) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;

    const totalBytes = files.reduce((s, f) => s + (f.bytes || 0), 0);
    const largest = files.reduce((a, b) => (b.bytes || 0) > (a.bytes || 0) ? b : a, files[0]);
    const newest = files.reduce((a, b) => new Date(b.modified) > new Date(a.modified) ? b : a, files[0]);
    const oldest = files.reduce((a, b) => new Date(b.created || b.modified) < new Date(a.created || a.modified) ? b : a, files[0]);

    const byCategory = {};
    files.forEach(f => { byCategory[f.category] = (byCategory[f.category] || 0) + 1; });
    const distribution = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, count]) => `<span class="ie-chip" title="${FileSupportPolicy.getCategoryMeta(cat).labelAr}">${FileSupportPolicy.getCategoryMeta(cat).icon} ${count}</span>`)
      .join('');

    el.innerHTML = `
      <div class="ie-stat"><span class="ie-stat-num">${files.length}</span><span class="ie-stat-label">إجمالي الملفات</span></div>
      <div class="ie-stat"><span class="ie-stat-num">${fmtBytes(totalBytes)}</span><span class="ie-stat-label">الحجم الإجمالي</span></div>
      <div class="ie-stat" title="${esc(largest.name)}"><span class="ie-stat-num">${fmtBytes(largest.bytes)}</span><span class="ie-stat-label">أكبر ملف</span></div>
      <div class="ie-stat" title="${esc(newest.name)}"><span class="ie-stat-num">${fmtDate(newest.modified)}</span><span class="ie-stat-label">أحدث تعديل</span></div>
      <div class="ie-stat" title="${esc(oldest.name)}"><span class="ie-stat-num">${fmtDate(oldest.created || oldest.modified)}</span><span class="ie-stat-label">أقدم ملف</span></div>
      <div class="ie-dist">${distribution}</div>
    `;
  }

  // ── RECENT FILES ──
  function buildRecentColumn(title, items, emptyText) {
    const rows = items.length
      ? items.map(it => `<div class="ie-recent-row"><span class="ie-recent-icon">${iconFor(it.name)}</span><span class="ie-recent-name" title="${esc(it.name)}">${esc(it.name)}</span><span class="ie-recent-when">${it.when}</span></div>`).join('')
      : `<div class="ie-recent-empty">${emptyText}</div>`;
    return `<div class="ie-recent-col"><div class="ie-recent-col-title">${title}</div>${rows}</div>`;
  }

  async function renderRecent(code, files) {
    const el = document.getElementById(`ev-recent-${code}`);
    if (!el) return;
    if (!files || !files.length) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;

    const N = 4;
    const added = [...files].sort((a, b) => new Date(b.created || b.modified) - new Date(a.created || a.modified))
      .slice(0, N).map(f => ({ name: f.name, when: fmtDate(f.created || f.modified) }));
    const modified = [...files].sort((a, b) => new Date(b.modified) - new Date(a.modified))
      .slice(0, N).map(f => ({ name: f.name, when: fmtDate(f.modified) }));

    let viewed = [];
    try {
      const data = await fetch(`${IAPI}/api/recent-views/${code}?limit=${N}`).then(r => r.json());
      viewed = (data.files || []).map(v => ({ name: v.name, when: fmtDate(v.viewedAt) }));
    } catch { /* non-critical */ }

    el.innerHTML = `
      ${buildRecentColumn('🆕 أُضيفت مؤخرًا', added, 'لا توجد ملفات')}
      ${buildRecentColumn('✏️ عُدّلت مؤخرًا', modified, 'لا توجد ملفات')}
      ${buildRecentColumn('👁️ عُرضت مؤخرًا', viewed, 'لم تُعرض أي ملفات بعد')}
    `;
  }

  function recordView(code, name) {
    fetch(`${IAPI}/api/recent-views/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(() => {
      // Live-refresh the "recently viewed" column if this indicator's panel is on screen.
      const filesEl = document.getElementById(`ev-body-${code}`);
      if (filesEl && document.getElementById(`ev-recent-${code}`)) {
        // Re-derive from what's already rendered rather than re-fetching the file list.
        const cached = window.__lastFilesByCode && window.__lastFilesByCode[code];
        if (cached) renderRecent(code, cached);
      }
    }).catch(() => {});
  }

  return { renderStats, renderRecent, recordView };
})();
