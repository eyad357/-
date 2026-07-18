'use strict';

const express = require('express');
const evidenceService = require('../services/evidenceService');
const router = express.Router();

router.get('/', async (req, res) => {
  const { evidenceRoot, store } = req.app.locals;
  const data = await evidenceService.integrityCheck(evidenceRoot, store.school.school_type);
  res.json(data);
});

module.exports = router;
