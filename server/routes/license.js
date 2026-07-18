'use strict';

const express = require('express');
const router = express.Router();
const licenseService = require('../services/licenseService');

router.get('/status', (req, res) => {
  res.json(licenseService.status(req.app.locals.store));
});

router.post('/activate', (req, res) => {
  const { store } = req.app.locals;
  const result = licenseService.activate(store, req.body || {});
  store.addAudit({
    action: result.success ? 'license_activated' : 'license_failed',
    details: result.success ? undefined : result.error,
  });
  res.json(result);
});

module.exports = router;
