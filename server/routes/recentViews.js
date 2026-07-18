'use strict';

const express = require('express');
const recentViewsService = require('../services/recentViewsService');
const router = express.Router();

// GET /api/recent-views/:code — most recently viewed files for this indicator
router.get('/:code', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 5;
  res.json({ files: recentViewsService.getRecent(req.params.code, limit) });
});

// POST /api/recent-views/:code — record that a file was just opened/previewed
router.post('/:code', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  recentViewsService.recordView(req.params.code, name);
  res.json({ success: true });
});

module.exports = router;
