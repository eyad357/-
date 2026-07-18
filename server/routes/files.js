'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const evidenceService = require('../services/evidenceService');

const rawBody = express.raw({ type: '*/*', limit: '200mb' });

function decodeFilename(headerVal, fallback) {
  if (!headerVal) return fallback;
  try { return decodeURIComponent(headerVal); } catch { return fallback; }
}

// GET /api/files/:code
router.get('/files/:code', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const data = await evidenceService.listFiles(evidenceRoot, req.params.code);
  res.json(data);
});

// GET /api/file/:code/:name  — view/download a single file
router.get('/file/:code/:name', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const filePath = await evidenceService.getFilePath(evidenceRoot, req.params.code, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'الملف غير موجود' });
  res.sendFile(filePath);
});

// DELETE /api/file/:code/:name
router.delete('/file/:code/:name', async (req, res) => {
  const { evidenceRoot, store } = req.app.locals;
  const filePath = await evidenceService.getFilePath(evidenceRoot, req.params.code, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'الملف غير موجود' });
  fs.unlinkSync(filePath);
  store.addAudit({ action: 'file_deleted', target: req.params.name, indicator: req.params.code, details: 'حُذف من داخل التطبيق' });
  res.json({ success: true });
});

// POST /api/upload/:code and /api/upload-raw/:code — both behave the same:
// raw request body = file bytes, x-filename header = original name.
async function handleUpload(req, res) {
  const { evidenceRoot, store } = req.app.locals;
  const code = req.params.code;
  const dir = evidenceService.folderForCode(evidenceRoot, code);
  if (!dir) return res.status(400).json({ error: 'مؤشر غير معروف' });

  fs.mkdirSync(dir, { recursive: true });
  const filename = path.basename(decodeFilename(req.headers['x-filename'], `file-${Date.now()}`));
  const destPath = path.join(dir, filename);

  try {
    fs.writeFileSync(destPath, req.body);
    store.addAudit({ action: 'file_uploaded', target: filename, indicator: code });
    res.json({ success: true, filename });
  } catch (err) {
    res.status(500).json({ error: 'فشل حفظ الملف: ' + err.message });
  }
}

router.post('/upload/:code', rawBody, handleUpload);
router.post('/upload-raw/:code', rawBody, handleUpload);

// POST /api/open-folder/:code — reveals the indicator folder in the OS file explorer
router.post('/open-folder/:code', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const dir = evidenceService.folderForCode(evidenceRoot, req.params.code);
  if (!dir) return res.status(400).json({ error: 'مؤشر غير معروف' });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const { shell } = require('electron');
    await shell.openPath(dir);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/file/:code/rename — { oldName, newName } in the JSON body.
// Renames the physical file on disk. The existing folder-watcher picks up
// the resulting unlink+add pair automatically, so the SSE refresh and the
// audit log's "file_detected"/"file_deleted" entries keep working exactly
// as they already do for any other filesystem change — no watcher changes
// needed. We additionally log a clearer "file_renamed" entry here so the
// audit trail reads naturally instead of just delete+add.
router.patch('/file/:code/rename', async (req, res) => {
  const { evidenceRoot, store } = req.app.locals;
  const { oldName, newName } = req.body || {};
  if (!oldName || !newName) return res.status(400).json({ error: 'اسم الملف الحالي والاسم الجديد مطلوبان' });

  const dir = evidenceService.folderForCode(evidenceRoot, req.params.code);
  if (!dir) return res.status(400).json({ error: 'مؤشر غير معروف' });

  const safeOld = path.basename(oldName);
  const safeNew = path.basename(newName).trim();
  if (!safeNew || safeNew === '.' || safeNew === '..') {
    return res.status(400).json({ error: 'اسم الملف الجديد غير صالح' });
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\/:*?"<>|\x00-\x1f]/.test(safeNew)) {
    return res.status(400).json({ error: 'اسم الملف يحتوي على رموز غير مسموح بها' });
  }

  const oldPath = path.join(dir, safeOld);
  const newPath = path.join(dir, safeNew);
  if (!oldPath.startsWith(path.resolve(dir)) || !newPath.startsWith(path.resolve(dir))) {
    return res.status(400).json({ error: 'مسار غير صالح' });
  }
  if (!fs.existsSync(oldPath)) return res.status(404).json({ error: 'الملف الأصلي غير موجود' });
  if (safeOld.toLowerCase() === safeNew.toLowerCase()) {
    return res.json({ success: true, filename: safeNew }); // no-op rename (e.g. case-only on case-insensitive FS)
  }
  if (fs.existsSync(newPath)) {
    return res.status(409).json({ error: `يوجد ملف آخر بهذا الاسم بالفعل: ${safeNew}` });
  }

  try {
    fs.renameSync(oldPath, newPath);
    store.addAudit({ action: 'file_renamed', target: `${safeOld} ← ${safeNew}`, indicator: req.params.code, details: 'أُعيدت تسميته من داخل التطبيق' });
    res.json({ success: true, filename: safeNew });
  } catch (err) {
    res.status(500).json({ error: 'فشلت إعادة التسمية: ' + err.message });
  }
});

// POST /api/open-file/:code/:name — opens the file with the OS default
// application (mirrors /api/open-folder/:code but targets the file itself).
router.post('/open-file/:code/:name', async (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const filePath = await evidenceService.getFilePath(evidenceRoot, req.params.code, req.params.name);
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).json({ error: 'الملف غير موجود' });
  try {
    const { shell } = require('electron');
    const errMsg = await shell.openPath(filePath);
    if (errMsg) return res.status(500).json({ error: errMsg });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
