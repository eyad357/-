'use strict';

const log = require('./logger');
const paths = require('./paths');
const backupService = require('../../server/services/backupService');

const INTERVAL_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

let timer = null;

function schedule(app) {
  if (timer) clearInterval(timer);
  const interval = app.locals.store.settings.auto_backup_interval;
  const ms = INTERVAL_MS[interval];
  if (!ms) return;

  timer = setInterval(async () => {
    try {
      const record = await backupService.createBackup({
        evidenceRoot: app.locals.evidenceRoot,
        storeFile: paths.getStoreFile(),
        backupsDir: paths.getBackupsDir(),
        type: 'auto',
      });
      app.locals.store.addBackupRecord(record);
      app.locals.store.addAudit({ action: 'backup_created', target: record.filename, details: `تلقائي · ${record.size}` });
      log.info('Automatic backup created:', record.filename);
    } catch (err) {
      log.error('Automatic backup failed:', err.message);
    }
  }, ms);
}

async function backupOnExit(app) {
  if (app.locals.store.settings.backup_on_exit !== 'true') return;
  try {
    const record = await backupService.createBackup({
      evidenceRoot: app.locals.evidenceRoot,
      storeFile: paths.getStoreFile(),
      backupsDir: paths.getBackupsDir(),
      type: 'exit',
    });
    app.locals.store.addBackupRecord(record);
    log.info('Exit backup created:', record.filename);
  } catch (err) {
    log.error('Exit backup failed:', err.message);
  }
}

module.exports = { schedule, backupOnExit };
