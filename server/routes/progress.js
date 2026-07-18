'use strict';

const express = require('express');
const completionService = require('../services/completionService');
const router = express.Router();

// GET /api/progress — full completion rollup: per indicator, per standard,
// per domain, and school-wide. This is the backend foundation for the
// upcoming Executive Dashboard; nothing in the existing Home screen or
// indicator pages depends on this endpoint.
router.get('/', async (req, res) => {
  const { evidenceRoot, store } = req.app.locals;
  try {
    const data = await completionService.computeProgress(evidenceRoot, store.school.school_type);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
