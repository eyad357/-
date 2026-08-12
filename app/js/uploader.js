/* ════════════════════════════════════════════════════════════
   UPLOAD TRAY — Phase 1.5 / Part 2
   ────────────────────────────────────────────────────────────
   Additive module. Exposes `Uploader.enqueue(code, files, endpoint)`.
   Replaces the old fire-and-forget fetch() upload loop with XHR so
   real per-file progress and mid-upload cancellation are possible,
   while hitting the exact same existing endpoints
   (/api/upload/:code and /api/upload-raw/:code) with the same
   headers — no backend changes.
   ════════════════════════════════════════════════════════════ */

const Uploader = (function () {
  'use strict';

  const UAPI = ''; // same-origin, mirrors API in index.html
  let tray = null;
  let rows = new Map(); // rowId -> { xhr, li, code }
  let seq = 0;
  let onBatchDone = null; // set per-batch callback

  function ensureTray() {
    if (tray) return tray;
    const el = document.createElement('div');
    el.className = 'ul-tray';
    el.id = 'ul-tray';
    el.innerHTML = `
      <div class="ul-tray-header">
        <span class="ul-tray-title">⬆ رفع الملفات</span>
        <span class="ul-tray-summary" id="ul-tray-summary"></span>
        <button class="ul-tray-btn" id="ul-cancel-all" title="إلغاء الكل">إلغاء الكل</button>
        <button class="ul-tray-btn ul-tray-min" id="ul-tray-toggle" title="طي/توسيع">▁</button>
        <button class="ul-tray-btn" id="ul-tray-close" title="إغلاق">✕</button>
      </div>
      <div class="ul-tray-list" id="ul-tray-list"></div>
    `;
    document.body.appendChild(el);
    tray = {
      el,
      list: el.querySelector('#ul-tray-list'),
      summary: el.querySelector('#ul-tray-summary'),
    };
    el.querySelector('#ul-cancel-all').addEventListener('click', cancelAll);
    el.querySelector('#ul-tray-close').addEventListener('click', () => el.classList.remove('open'));
    el.querySelector('#ul-tray-toggle').addEventListener('click', () => el.classList.toggle('collapsed'));
    return tray;
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
  }

  function updateSummary() {
    const all = Array.from(rows.values());
    const active = all.filter(r => r.status === 'uploading').length;
    const done = all.filter(r => r.status === 'done').length;
    const failed = all.filter(r => r.status === 'failed' || r.status === 'cancelled').length;
    tray.summary.textContent = active
      ? `جارٍ رفع ${active} من ${all.length}…`
      : `اكتمل: ${done} ✓${failed ? ` · فشل/أُلغي: ${failed}` : ''}`;
    const cancelAllBtn = tray.el.querySelector('#ul-cancel-all');
    cancelAllBtn.style.display = active ? '' : 'none';
  }

  function cancelAll() {
    rows.forEach((row) => { if (row.status === 'uploading') row.xhr.abort(); });
  }

  function addRow(code, file) {
    const id = 'ul-row-' + (++seq);
    const li = document.createElement('div');
    li.className = 'ul-row';
    li.id = id;
    li.innerHTML = `
      <div class="ul-row-top">
        <span class="ul-row-name" title="${file.name}">${file.name}</span>
        <span class="ul-row-size">${fmtBytes(file.size)}</span>
        <button class="ul-row-cancel" title="إلغاء">✕</button>
      </div>
      <div class="ul-row-bar-track"><div class="ul-row-bar-fill"></div></div>
      <div class="ul-row-status">في الانتظار…</div>
    `;
    tray.list.prepend(li);
    const row = { id, li, code, status: 'queued' };
    rows.set(id, row);
    li.querySelector('.ul-row-cancel').addEventListener('click', () => {
      if (row.xhr && row.status === 'uploading') row.xhr.abort();
      else removeRow(id);
    });
    return row;
  }

  function removeRow(id) {
    const row = rows.get(id);
    if (!row) return;
    row.li.remove();
    rows.delete(id);
  }

  function setRowProgress(row, pct) {
    row.li.querySelector('.ul-row-bar-fill').style.width = pct + '%';
    row.li.querySelector('.ul-row-status').textContent = `${pct}%`;
  }
  function setRowState(row, status, text) {
    row.status = status;
    row.li.classList.remove('ul-row-done', 'ul-row-failed', 'ul-row-cancelled');
    if (status === 'done') row.li.classList.add('ul-row-done');
    if (status === 'failed') row.li.classList.add('ul-row-failed');
    if (status === 'cancelled') row.li.classList.add('ul-row-cancelled');
    row.li.querySelector('.ul-row-status').textContent = text;
    const cancelBtn = row.li.querySelector('.ul-row-cancel');
    cancelBtn.textContent = status === 'uploading' || status === 'queued' ? '✕' : '🗑';
    updateSummary();
  }

  function uploadOne(code, file, endpoint) {
    return new Promise((resolve) => {
      const row = addRow(code, file);
      const xhr = new XMLHttpRequest();
      row.xhr = xhr;
      row.status = 'uploading';
      xhr.open('POST', `${UAPI}/api/${endpoint}/${encodeURIComponent(code)}`);
      xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      setRowState(row, 'uploading', 'جارٍ الرفع…');
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) setRowProgress(row, Math.round((e.loaded / e.total) * 100));
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setRowProgress(row, 100);
          setRowState(row, 'done', '✅ تم الرفع');
          resolve(true);
        } else {
          let detail = `فشل (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText);
            if (body && body.error) detail = body.error;
          } catch { /* non-JSON error body, keep the generic status message */ }
          setRowState(row, 'failed', `❌ ${detail}`);
          resolve(false);
        }
        scheduleAutoRemove(row.id);
      });
      xhr.addEventListener('error', () => {
        setRowState(row, 'failed', '❌ خطأ في الشبكة');
        resolve(false);
        scheduleAutoRemove(row.id);
      });
      xhr.addEventListener('abort', () => {
        setRowState(row, 'cancelled', '⛔ أُلغي');
        resolve(false);
        scheduleAutoRemove(row.id);
      });
      xhr.send(file);
    });
  }

  function scheduleAutoRemove(id) {
    setTimeout(() => removeRow(id), 5000);
  }

  async function enqueue(code, fileList, endpoint) {
    const files = Array.from(fileList);
    if (!files.length) return { ok: 0, total: 0 };
    ensureTray();
    tray.el.classList.add('open');
    tray.el.classList.remove('collapsed');
    updateSummary();

    const CONCURRENCY = 3;
    let idx = 0, ok = 0;
    async function worker() {
      while (idx < files.length) {
        const f = files[idx++];
        const success = await uploadOne(code, f, endpoint);
        if (success) ok++;
        updateSummary();
      }
    }
    const workers = Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker);
    await Promise.all(workers);
    updateSummary();
    return { ok, total: files.length };
  }

  return { enqueue };
})();
