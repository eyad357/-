'use strict';

const chokidar = require('chokidar');
const path = require('path');
const log = require('../../electron/utils/logger');
const evidenceService = require('./evidenceService');

/**
 * Watches the evidence root recursively and calls onEvent({event, code, file})
 * whenever a file is added, removed, or changed inside a known indicator folder.
 * This is what makes manual Explorer edits (add/remove/rename files) show up
 * in the UI immediately via SSE, with zero configuration from the user.
 */
class EvidenceWatcher {
  constructor() {
    this.watcher = null;
    this.root = null;
  }

  start(evidenceRoot, onEvent) {
    this.stop();
    this.root = evidenceRoot;
    this.onEvent = onEvent;

    this.watcher = chokidar.watch(evidenceRoot, {
      ignoreInitial: true,
      persistent: true,
      depth: 6,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
      ignored: (p) => path.basename(p).startsWith('.') || path.basename(p) === 'Thumbs.db',
    });

    this.watcher
      .on('add', (filePath) => this._emit('add', filePath))
      .on('unlink', (filePath) => this._emit('remove', filePath))
      .on('change', (filePath) => this._emit('change', filePath))
      .on('error', (err) => log.error('Evidence watcher error:', err.message));

    log.info('Evidence watcher started at', evidenceRoot);
  }

  _emit(event, filePath) {
    const code = evidenceService.codeFromPath(this.root, filePath);
    if (!code) return; // change outside any known indicator folder — ignore
    try {
      this.onEvent({ event, code, file: path.basename(filePath) });
    } catch (err) {
      log.error('Evidence watcher onEvent handler failed:', err.message);
    }
  }

  async restart(newRoot, onEvent) {
    this.start(newRoot, onEvent || this.onEvent);
  }

  async stop() {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

module.exports = new EvidenceWatcher();
