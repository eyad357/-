'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { formatSize } = require('./evidenceService');

function timestampName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;
}

function createBackup({ evidenceRoot, storeFile, backupsDir, type = 'manual' }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(backupsDir, { recursive: true });
    const filename = timestampName();
    const outPath = path.join(backupsDir, filename);
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      resolve({
        filename,
        size: formatSize(archive.pointer()),
        bytes: archive.pointer(),
        type,
        created_at: new Date().toISOString(),
      });
    });
    archive.on('error', reject);
    archive.on('warning', () => {}); // ignore stat warnings (e.g. missing folder mid-scan)

    archive.pipe(output);
    if (fs.existsSync(evidenceRoot)) archive.directory(evidenceRoot, 'evidence');
    if (fs.existsSync(storeFile)) archive.file(storeFile, { name: 'store.json' });
    archive.finalize();
  });
}

function listBackups(backupsDir, records) {
  return records.map((r) => ({
    ...r,
    exists: fs.existsSync(path.join(backupsDir, r.filename)),
    sizeFormatted: r.bytes ? formatSize(r.bytes) : (r.size || '—'),
  }));
}

module.exports = { createBackup, listBackups };
