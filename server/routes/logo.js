'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.app.locals.logosDir),
  filename: (req, file, cb) => {
    const side = req.params.side === 'left' ? 'left' : 'right';
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `logo-${side}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(png|jpe?g|webp|svg|gif)$/i.test(file.originalname);
    cb(ok ? null : new Error('نوع الملف غير مدعوم كشعار'), ok);
  },
});

router.post('/:side', upload.single('logo'), (req, res) => {
  const side = req.params.side === 'left' ? 'left' : 'right';
  const { store } = req.app.locals;
  if (!req.file) return res.status(400).json({ success: false, error: 'لم يتم إرسال ملف.' });

  const url = `/uploads/logos/${req.file.filename}?t=${Date.now()}`;
  store.updateSchool({ [`logo_${side}`]: url });
  store.addAudit({ action: 'logo_uploaded', target: side === 'right' ? 'الشعار الأيمن' : 'الشعار الأيسر' });
  res.json({ success: true, url });
});

router.delete('/:side', (req, res) => {
  const side = req.params.side === 'left' ? 'left' : 'right';
  const { store } = req.app.locals;
  const current = store.school[`logo_${side}`];
  if (current) {
    const filename = current.split('?')[0].split('/').pop();
    const filePath = path.join(req.app.locals.logosDir, filename);
    if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch (_) {} }
  }
  store.updateSchool({ [`logo_${side}`]: '' });
  res.json({ success: true });
});

module.exports = router;
