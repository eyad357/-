'use strict';

const log = require('electron-log');
const path = require('path');
const paths = require('./paths');

log.transports.file.resolvePathFn = () => path.join(paths.getLogsDir(), 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024; // 5MB, electron-log rotates automatically
log.transports.file.level = 'info';
log.transports.console.level = paths.isPackaged ? false : 'debug';

// Never let a logging call throw and take the app down with it.
process.on('uncaughtException', (err) => {
  try { log.error('Uncaught exception:', err); } catch (_) {}
});
process.on('unhandledRejection', (reason) => {
  try { log.error('Unhandled rejection:', reason); } catch (_) {}
});

module.exports = log;
