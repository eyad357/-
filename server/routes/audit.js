'use strict';

const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 30;
  res.json(req.app.locals.store.getAuditPage(page, limit));
});

router.delete('/', (req, res) => {
  req.app.locals.store.clearAudit();
  res.json({ success: true });
});

module.exports = router;
