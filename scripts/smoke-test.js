'use strict';

// Mock the 'electron' module BEFORE anything requires it.
const path = require('path');
const os = require('os');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'smoke-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'smoke-test-docs-' + Date.now());
require('fs').mkdirSync(fakeUserData, { recursive: true });
require('fs').mkdirSync(fakeDocs, { recursive: true });

// Evidence root now lives next to the "install directory" instead of
// Documents — point that at a throwaway tmp folder for this test run.
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? fakeUserData : name === 'documents' ? fakeDocs : os.tmpdir()),
    getVersion: () => '1.0.0-test',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
  },
  shell: { openPath: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => {} },
  BrowserWindow: class { constructor() {} loadURL() {} loadFile() {} once() {} on() {} show() {} focus() {} },
  ipcMain: { handle: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} },
  screen: {},
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-mock-virtual';
  return origResolve.call(this, request, ...rest);
};
require.cache['electron-mock-virtual'] = { id: 'electron-mock-virtual', filename: 'electron-mock-virtual', loaded: true, exports: fakeElectron };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};

// ── Now actually exercise the app ──
(async () => {
  const http = require('http');
  const { createApp } = require('../server/app');
  const app = await createApp();
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const results = [];
  async function check(name, fn) {
    try {
      await fn();
      results.push([name, 'OK']);
    } catch (err) {
      results.push([name, 'FAIL: ' + err.message]);
    }
  }

  await check('GET /api/school', async () => {
    const r = await fetch(`${base}/api/school`);
    const d = await r.json();
    if (typeof d.setup_done === 'undefined') throw new Error('missing setup_done');
  });

  await check('POST /api/school (setup)', async () => {
    const r = await fetch(`${base}/api/school`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'مدرسة الاختبار', stage: 'ثانوي', admin_name: 'مدير', ministry_num: '123', school_type: 'private', setup_done: 1 }),
    });
    const d = await r.json();
    if (!d.success) throw new Error('setup failed');
  });

  await check('GET /api/structure', async () => {
    const r = await fetch(`${base}/api/structure`);
    const d = await r.json();
    if (d.total !== 52) throw new Error('expected 52 indicator folders, got ' + d.total);
  });

  await check('GET /api/integrity (should be clean after bootstrap)', async () => {
    const r = await fetch(`${base}/api/integrity`);
    const d = await r.json();
    if (d.missingFolders.length !== 0) throw new Error('missing folders: ' + d.missingFolders.join(','));
  });

  await check('GET /api/stats (empty)', async () => {
    const r = await fetch(`${base}/api/stats`);
    const d = await r.json();
    if (d.totalFiles !== 0) throw new Error('expected 0 files initially');
  });

  await check('POST /api/upload/:code + GET /api/files/:code', async () => {
    const code = '1-1-1-1';
    const bytes = Buffer.from('hello evidence file');
    const r = await fetch(`${base}/api/upload/${code}`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('test-evidence.txt'), 'Content-Type': 'text/plain' },
      body: bytes,
    });
    const ud = await r.json();
    if (!ud.success) throw new Error('upload failed: ' + JSON.stringify(ud));

    const lr = await fetch(`${base}/api/files/${code}`);
    const ld = await lr.json();
    if (!ld.folderExists || ld.files.length !== 1) throw new Error('file not listed: ' + JSON.stringify(ld));
    if (ld.files[0].category !== 'text') throw new Error('wrong category: ' + ld.files[0].category);
  });

  await check('GET /api/stats (after upload, should be 1 file)', async () => {
    const r = await fetch(`${base}/api/stats`);
    const d = await r.json();
    if (d.totalFiles !== 1) throw new Error('expected 1 file, got ' + d.totalFiles);
    if (d.completionPct !== Math.round(100 / 52)) throw new Error('unexpected completion pct ' + d.completionPct);
  });

  await check('DELETE /api/file/:code/:name', async () => {
    const r = await fetch(`${base}/api/file/1-1-1-1/${encodeURIComponent('test-evidence.txt')}`, { method: 'DELETE' });
    const d = await r.json();
    if (!d.success) throw new Error('delete failed');
  });

  await check('GET /api/license/status (not activated)', async () => {
    const r = await fetch(`${base}/api/license/status`);
    const d = await r.json();
    if (d.valid) throw new Error('should not be valid yet');
    if (!d.machineId) throw new Error('missing machineId');
  });

  await check('POST /api/license/activate (valid key roundtrip)', async () => {
    const licenseService = require('../server/services/licenseService');
    const statusR = await fetch(`${base}/api/license/status`);
    const { machineId } = await statusR.json();
    const licenseKey = 'ACC-2026-TEST-0001';
    const checksum = licenseService.computeChecksum(licenseKey, machineId, '');
    const r = await fetch(`${base}/api/license/activate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, machineId, expiresAt: '', checksum }),
    });
    const d = await r.json();
    if (!d.success) throw new Error('activation failed: ' + JSON.stringify(d));

    const statusR2 = await fetch(`${base}/api/license/status`);
    const d2 = await statusR2.json();
    if (!d2.valid) throw new Error('license should now be valid');
  });

  await check('POST /api/settings + GET /api/settings', async () => {
    await fetch(`${base}/api/settings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_backup_interval: 'daily', backup_on_exit: 'true' }),
    });
    const r = await fetch(`${base}/api/settings`);
    const d = await r.json();
    if (d.auto_backup_interval !== 'daily') throw new Error('settings not saved');
  });

  await check('GET /api/audit (has entries)', async () => {
    const r = await fetch(`${base}/api/audit?page=1&limit=30`);
    const d = await r.json();
    if (d.total < 1) throw new Error('expected audit entries');
  });

  await check('POST /api/backup + GET /api/backups', async () => {
    const r = await fetch(`${base}/api/backup`, { method: 'POST' });
    const d = await r.json();
    if (!d.success) throw new Error('backup failed: ' + JSON.stringify(d));
    const lr = await fetch(`${base}/api/backups`);
    const ld = await lr.json();
    if (ld.backups.length !== 1) throw new Error('expected 1 backup record');
    if (!ld.backups[0].exists) throw new Error('backup file missing on disk');
  });

  await check('GET / serves the SPA', async () => {
    const r = await fetch(`${base}/`);
    const text = await r.text();
    if (!text.includes('التقويم والاعتماد المدرسي')) throw new Error('index.html not served correctly');
  });

  await check('Real-time watcher: manually dropped file is detected without any upload API call', async () => {
    const fs = require('fs');
    const evidenceService = require('../server/services/evidenceService');
    const dir = evidenceService.folderForCode(app.locals.evidenceRoot, '2-1-1-1');
    fs.writeFileSync(path.join(dir, 'manually-added.pdf'), 'fake pdf bytes');
    await new Promise((r) => setTimeout(r, 900)); // chokidar awaitWriteFinish + debounce
    const lr = await fetch(`${base}/api/files/2-1-1-1`);
    const ld = await lr.json();
    if (!ld.files.find((f) => f.name === 'manually-added.pdf')) {
      throw new Error('watcher did not pick up manually created file: ' + JSON.stringify(ld));
    }
  });

  console.log('\n=== SMOKE TEST RESULTS ===');
  let failed = 0;
  for (const [name, status] of results) {
    console.log(`${status.startsWith('OK') ? '✅' : '❌'} ${name} — ${status}`);
    if (!status.startsWith('OK')) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.close();
  process.exit(failed ? 1 : 0);
})();
