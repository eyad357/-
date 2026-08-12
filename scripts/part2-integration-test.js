'use strict';
// Integration test for Phase 1.5 Part 2 (Upload Progress/Cancel + Per-Indicator
// Stats + Recent Files). Mocks 'electron' like the other test scripts, boots
// the real server, and exercises the new backend pieces plus the new static
// assets over real HTTP.
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'part2-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'part2-test-docs-' + Date.now());
fs.mkdirSync(fakeUserData, { recursive: true });
fs.mkdirSync(fakeDocs, { recursive: true });
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? fakeUserData : name === 'documents' ? fakeDocs : os.tmpdir()),
    getVersion: () => '1.0.0-test', requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(), on: () => {}, quit: () => {},
  },
  shell: { openPath: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => {} },
  BrowserWindow: class { constructor() {} loadURL() {} loadFile() {} once() {} on() {} show() {} focus() {} },
  ipcMain: { handle: () => {} }, ipcRenderer: {}, contextBridge: { exposeInMainWorld: () => {} }, screen: {},
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { if (request === 'electron') return 'electron-mock-virtual'; return origResolve.call(this, request, ...rest); };
require.cache['electron-mock-virtual'] = { id: 'electron-mock-virtual', filename: 'electron-mock-virtual', loaded: true, exports: fakeElectron };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) { if (request === 'electron') return fakeElectron; return origLoad.call(this, request, parent, isMain); };

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
    try { await fn(); results.push([name, 'OK']); }
    catch (err) { results.push([name, 'FAIL: ' + err.message]); }
  }

  await check('setup school', async () => {
    const r = await fetch(`${base}/api/school`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'مدرسة الاختبار', stage: 'ثانوي', admin_name: 'مدير', ministry_num: '123', school_type: 'private', setup_done: 1 }),
    });
    if (!(await r.json()).success) throw new Error('setup failed');
  });

  await check('new static assets served (uploader.css, indicator-extras.css/js)', async () => {
    for (const p of ['/css/uploader.css', '/css/indicator-extras.css', '/js/uploader.js', '/js/indicator-extras.js']) {
      const r = await fetch(base + p);
      if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
    }
  });

  const evidenceService = require('../server/services/evidenceService');
  let code, indicatorDir;
  await check('resolve an indicator folder', async () => {
    const r = await fetch(`${base}/api/structure`);
    const d = await r.json();
    code = Object.keys(d.indicatorMap)[0];
    indicatorDir = evidenceService.folderForCode(d.evidenceRoot, code);
    if (!fs.existsSync(indicatorDir)) throw new Error('missing folder ' + indicatorDir);
  });

  await check('listFiles now includes a created field distinct from modified', async () => {
    const filePath = path.join(indicatorDir, 'created-field-test.txt');
    fs.writeFileSync(filePath, 'hello');
    await new Promise(r => setTimeout(r, 300));
    const r = await fetch(`${base}/api/files/${code}`);
    const d = await r.json();
    const f = (d.files || []).find(x => x.name === 'created-field-test.txt');
    if (!f) throw new Error('file not listed');
    if (!f.created) throw new Error('created field missing');
    if (Number.isNaN(new Date(f.created).getTime())) throw new Error('created field not a valid date: ' + f.created);
  });

  await check('GET /api/recent-views/:code starts empty', async () => {
    const r = await fetch(`${base}/api/recent-views/${code}`);
    const d = await r.json();
    if (!Array.isArray(d.files) || d.files.length !== 0) throw new Error('expected empty list, got ' + JSON.stringify(d));
  });

  await check('POST /api/recent-views/:code records a view', async () => {
    const r = await fetch(`${base}/api/recent-views/${code}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'created-field-test.txt' }),
    });
    if (!(await r.json()).success) throw new Error('record failed');
  });

  await check('GET /api/recent-views/:code reflects the recorded view, most-recent-first', async () => {
    // record a second file so we can check ordering
    await fetch(`${base}/api/recent-views/${code}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'second-file.txt' }),
    });
    const r = await fetch(`${base}/api/recent-views/${code}`);
    const d = await r.json();
    if (d.files.length !== 2) throw new Error('expected 2 entries, got ' + d.files.length);
    if (d.files[0].name !== 'second-file.txt') throw new Error('most recent view should be first, got ' + JSON.stringify(d.files));
  });

  await check('re-viewing a file moves it to the front without duplicating', async () => {
    await fetch(`${base}/api/recent-views/${code}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'created-field-test.txt' }),
    });
    const r = await fetch(`${base}/api/recent-views/${code}`);
    const d = await r.json();
    if (d.files.length !== 2) throw new Error('expected still 2 unique entries, got ' + d.files.length);
    if (d.files[0].name !== 'created-field-test.txt') throw new Error('re-viewed file should move to front');
  });

  await check('recent-views is scoped per indicator code (does not leak across indicators)', async () => {
    const r = await fetch(`${base}/api/structure`);
    const d = await r.json();
    const otherCode = Object.keys(d.indicatorMap).find(c => c !== code);
    if (!otherCode) return; // only one indicator, nothing to check
    const r2 = await fetch(`${base}/api/recent-views/${otherCode}`);
    const d2 = await r2.json();
    if (d2.files.length !== 0) throw new Error('unrelated indicator should have no recorded views');
  });

  await check('POST /api/recent-views/:code without a name is rejected', async () => {
    const r = await fetch(`${base}/api/recent-views/${code}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (r.status !== 400) throw new Error('expected 400, got ' + r.status);
  });

  // Simulate an XHR-style raw upload exactly like Uploader.enqueue sends, to
  // make sure the existing /api/upload endpoint still behaves identically.
  // Uses .txt (an allowed type) since this test is about the *transport*
  // shape (headers/body/listing), not file-type validation — that has its
  // own dedicated test in scripts/file-support-policy-test.js.
  await check('upload via the same request shape the new Uploader module sends', async () => {
    const bytes = Buffer.from('progress-upload-test-content');
    const r = await fetch(`${base}/api/upload/${code}`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('uploader-shape-test.txt'), 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    await new Promise(res => setTimeout(res, 300));
    const list = await fetch(`${base}/api/files/${code}`).then(x => x.json());
    if (!list.files.some(f => f.name === 'uploader-shape-test.txt')) throw new Error('uploaded file not listed');
  });

  console.log('\n=== PART 2 INTEGRATION TEST RESULTS ===');
  let failed = 0;
  for (const [name, status] of results) {
    console.log((status === 'OK' ? '✅' : '❌') + '  ' + name + '  ' + (status === 'OK' ? '' : '- ' + status));
    if (status !== 'OK') failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
