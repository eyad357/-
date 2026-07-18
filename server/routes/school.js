'use strict';

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(req.app.locals.store.school);
});

router.post('/', async (req, res) => {
  const { store } = req.app.locals;
  const patch = {};
  const allowed = ['name', 'stage', 'admin_name', 'ministry_num', 'school_type', 'setup_done', 'evidence_root'];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(req.body, key)) patch[key] = req.body[key];
  }

  const rootChanged = Object.prototype.hasOwnProperty.call(patch, 'evidence_root');
  const updated = store.updateSchool(patch);

  if (rootChanged) {
    await req.app.locals.setEvidenceRoot(patch.evidence_root);
    store.addAudit({ action: 'settings_changed', details: `تغيير مجلد الشواهد إلى: ${req.app.locals.evidenceRoot}` });
  } else {
    store.addAudit({ action: 'settings_changed', details: 'تحديث بيانات المدرسة' });
  }

  res.json({ success: true, school: updated });
});

module.exports = router;
