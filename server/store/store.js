'use strict';

const fs = require('fs');
const path = require('path');
const log = require('../../electron/utils/logger');

const DEFAULTS = {
  school: {
    name: '', stage: '', admin_name: '', ministry_num: '',
    school_type: 'gov', setup_done: 0,
    logo_right: '', logo_left: '',
    evidence_root: '', // '' means "use default location"
  },
  settings: {
    auto_backup_interval: 'none', // none | daily | weekly
    backup_on_exit: 'false',
  },
  license: {
    key: '', checksum: '', expiresAt: '', activated: false,
  },
  audit: [], // { id, timestamp, action, target, indicator, details }
  backups: [], // { filename, created_at, type }
  _auditSeq: 0,
};

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...structuredClone(DEFAULTS), ...parsed };
      }
    } catch (err) {
      log.error('Failed to read store.json, starting fresh:', err.message);
    }
    return structuredClone(DEFAULTS);
  }

  /** Atomic write: write to a temp file then rename, so a crash mid-write never corrupts the store. */
  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      log.error('Failed to save store.json:', err.message);
    }
  }

  get school() { return this.data.school; }
  updateSchool(patch) {
    Object.assign(this.data.school, patch);
    this.save();
    return this.data.school;
  }

  get settings() { return this.data.settings; }
  updateSettings(patch) {
    Object.assign(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  get license() { return this.data.license; }
  updateLicense(patch) {
    Object.assign(this.data.license, patch);
    this.save();
    return this.data.license;
  }

  addAudit({ action, target = null, indicator = null, details = '' }) {
    this.data._auditSeq += 1;
    const entry = {
      id: this.data._auditSeq,
      timestamp: new Date().toISOString(),
      action, target, indicator, details,
    };
    this.data.audit.unshift(entry);
    // Cap history so the file never grows unbounded.
    if (this.data.audit.length > 5000) this.data.audit.length = 5000;
    this.save();
    return entry;
  }

  getAuditPage(page = 1, limit = 30) {
    const total = this.data.audit.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;
    return { logs: this.data.audit.slice(start, start + limit), total, pages };
  }

  clearAudit() {
    this.data.audit = [];
    this.save();
  }

  addBackupRecord(record) {
    this.data.backups.unshift(record);
    this.save();
  }

  get backups() { return this.data.backups; }
}

module.exports = Store;
