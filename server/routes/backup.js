'use strict';

const express = require('express');
const path = require('path');
const router = express.Router();
const backupService = require('../services/backupService');
const paths = require('../../electron/utils/paths');

// POST /api/backup — create a backup now
router.post('/backup', async (req, res) => {
  const { evidenceRoot, store } = req.app.locals;
  try {
    const record = await backupService.createBackup({
      evidenceRoot,
      storeFile: paths.getStoreFile(),
      backupsDir: paths.getBackupsDir(),
      type: 'manual',
    });
    store.addBackupRecord(record);
    store.addAudit({ action: 'backup_created', target: record.filename, details: record.size });
    res.json({ success: true, filename: record.filename, size: record.size });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/backups — list all known backups
router.get('/backups', (req, res) => {
  const { store } = req.app.locals;
  res.json({ backups: backupService.listBackups(paths.getBackupsDir(), store.backups) });
});

// GET /api/backup/download/:filename
router.get('/backup/download/:filename', (req, res) => {
  const filePath = path.join(paths.getBackupsDir(), path.basename(req.params.filename));
  res.download(filePath);
});

module.exports = router;
