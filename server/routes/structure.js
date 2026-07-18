'use strict';

const express = require('express');
const evidenceService = require('../services/evidenceService');
const router = express.Router();

router.get('/', (req, res) => {
  const { evidenceRoot } = req.app.locals;
  const { map, total } = evidenceService.indicatorMap(evidenceRoot);
  res.json({ indicatorMap: map, total, evidenceRoot });
});

module.exports = router;
