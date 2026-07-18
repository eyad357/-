'use strict';

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json(req.app.locals.store.settings);
});

router.post('/', (req, res) => {
  const { store } = req.app.locals;
  const patch = {};
  ['auto_backup_interval', 'backup_on_exit'].forEach((k) => {
    if (Object.prototype.hasOwnProperty.call(req.body, k)) patch[k] = req.body[k];
  });
  const updated = store.updateSettings(patch);
  store.addAudit({ action: 'settings_changed', details: 'تحديث إعدادات النظام' });
  res.json({ success: true, settings: updated });
});

module.exports = router;
