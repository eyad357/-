/* ════════════════════════════════════════════════════════════
   RIGHT-CLICK CONTEXT MENU — Part 2 remainder
   ────────────────────────────────────────────────────────────
   Additive module. A single reusable floating menu (like the
   Viewer/Uploader overlays) shown at the cursor position on
   right-click, wired in via one line inside buildFileCard().
   Reuses existing global functions (openFolder, deleteFile,
   openFileModal, showToast) rather than duplicating their logic.
   ════════════════════════════════════════════════════════════ */

const ContextMenu = (function () {
  'use strict';

  const CAPI = ''; // same-origin
  let menuEl = null;

  function ensureMenu() {
    if (menuEl) return menuEl;
    menuEl = document.createElement('div');
    menuEl.className = 'cm-menu';
    document.body.appendChild(menuEl);
    document.addEventListener('click', () => hide());
    document.addEventListener('contextmenu', (e) => {
      if (!menuEl.contains(e.target)) hide();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
    window.addEventListener('scroll', () => hide(), true);
    window.addEventListener('resize', () => hide());
    return menuEl;
  }

  function hide() {
    if (menuEl) menuEl.classList.remove('open');
  }

  function item(label, icon, onClick, opts) {
    opts = opts || {};
    const div = document.createElement('div');
    div.className = 'cm-item' + (opts.danger ? ' cm-item-danger' : '');
    div.innerHTML = `<span class="cm-icon">${icon}</span><span class="cm-label">${label}</span>`;
    div.addEventListener('click', (e) => { e.stopPropagation(); hide(); onClick(); });
    return div;
  }
  function sep() {
    const d = document.createElement('div');
    d.className = 'cm-sep';
    return d;
  }

  async function copyPath(file) {
    try {
      await navigator.clipboard.writeText(file.path || file.name);
      showToast('📋 تم نسخ مسار الملف');
    } catch {
      showToast('❌ تعذّر نسخ المسار', 'error');
    }
  }

  function downloadFile(code, file) {
    const url = `${CAPI}/api/file/${code}/${encodeURIComponent(file.name)}`;
    const a = document.createElement('a');
    a.href = url; a.download = file.name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  async function openWithDefaultApp(code, file) {
    try {
      const r = await fetch(`${CAPI}/api/open-file/${code}/${encodeURIComponent(file.name)}`, { method: 'POST' });
      const d = await r.json();
      if (!d.success) showToast('❌ تعذّر فتح الملف: ' + (d.error || ''), 'error');
    } catch {
      showToast('❌ تعذّر فتح الملف', 'error');
    }
  }

  function show(event, code, file) {
    event.preventDefault();
    event.stopPropagation();
    const menu = ensureMenu();
    menu.innerHTML = '';
    // "فتح" now opens the in-app viewer (same as double-click / "معاينة") —
    // consistent, correct rendering on every machine regardless of whatever
    // PDF/Office app happens to be installed/default on that Windows PC.
    // The old behavior (hand the file to the OS default app via
    // shell.openPath) is kept as an explicit, clearly-labeled escape hatch
    // for people who really want to open it in Acrobat/Word/etc.
    menu.appendChild(item('فتح', '📂', () => openFileModal(code, file)));
    menu.appendChild(item('فتح في برنامج خارجي', '🗔', () => openWithDefaultApp(code, file)));
    menu.appendChild(item('فتح المجلد', '📁', () => openFolder(code)));
    menu.appendChild(item('نسخ المسار', '🔗', () => copyPath(file)));
    menu.appendChild(sep());
    menu.appendChild(item('إعادة تسمية', '✏️', () => Dialogs.showRename(code, file)));
    menu.appendChild(item('تنزيل', '⬇️', () => downloadFile(code, file)));
    menu.appendChild(item('خصائص', 'ℹ️', () => Dialogs.showProperties(code, file)));
    menu.appendChild(sep());
    menu.appendChild(item('حذف', '🗑️', () => deleteFile({ stopPropagation(){} }, code, file.name), { danger: true }));

    menu.classList.add('open');
    // Position, then clamp to viewport after layout so it never renders off-screen.
    menu.style.left = event.clientX + 'px';
    menu.style.top = event.clientY + 'px';
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      let left = event.clientX, top = event.clientY;
      if (rect.right > window.innerWidth) left -= (rect.right - window.innerWidth + 8);
      if (rect.bottom > window.innerHeight) top -= (rect.bottom - window.innerHeight + 8);
      menu.style.left = Math.max(4, left) + 'px';
      menu.style.top = Math.max(4, top) + 'px';
    });
  }

  return { show, hide };
})();
