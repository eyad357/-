'use strict';
// Ad-hoc integration test for Phase 1.5 Document Viewer wiring.
// Mocks 'electron' the same way scripts/smoke-test.js does, boots the real
// server, drops real sample evidence files into an indicator folder, and
// verifies: (1) all new static viewer assets are served correctly, and
// (2) files fetched through /api/file/:code/:name round-trip byte-for-byte.
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'viewer-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'viewer-test-docs-' + Date.now());
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

  // 1) school setup so evidence tree exists
  await check('setup school', async () => {
    const r = await fetch(`${base}/api/school`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'مدرسة الاختبار', stage: 'ثانوي', admin_name: 'مدير', ministry_num: '123', school_type: 'private', setup_done: 1 }),
    });
    const d = await r.json();
    if (!d.success) throw new Error('setup failed');
  });

  // 2) static viewer assets
  const assets = [
    ['/css/viewer.css', 'text/css'],
    ['/js/viewer.js', 'javascript'],
    ['/js/pdf-engine.js', 'javascript'],
    ['/js/vendor/pdfjs/pdf.min.mjs', 'javascript'],
    ['/js/vendor/pdfjs/pdf.worker.min.mjs', 'javascript'],
    ['/js/vendor/mammoth/mammoth.browser.min.js', 'javascript'],
    ['/js/vendor/xlsx/xlsx.full.min.js', 'javascript'],
    ['/js/vendor/jszip/jszip.min.js', 'javascript'],
  ];
  for (const [p, expectType] of assets) {
    await check(`GET ${p}`, async () => {
      const r = await fetch(base + p);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes(expectType)) throw new Error('unexpected content-type: ' + ct);
      const csp = r.headers.get('content-security-policy');
      if (!csp || !csp.includes("script-src 'self'")) throw new Error('CSP header missing/changed');
    });
  }

  // 3) get structure to find a real indicator code, then resolve its actual
  //    on-disk folder the same way the server does (indicatorMap is just
  //    { code: true } for existing folders, so use evidenceService directly)
  const evidenceService = require('../server/services/evidenceService');
  let code, indicatorDir;
  await check('GET /api/structure', async () => {
    const r = await fetch(`${base}/api/structure`);
    const d = await r.json();
    code = d?.indicatorMap && Object.keys(d.indicatorMap)[0];
    if (!code) throw new Error('no indicator code found in structure response');
    indicatorDir = evidenceService.folderForCode(d.evidenceRoot, code);
    if (!fs.existsSync(indicatorDir)) throw new Error('resolved folder does not exist: ' + indicatorDir);
  });

  // 5) copy real sample files in and verify byte-identical round trip via the file API
  const samples = ['sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.csv', 'sample.pptx', 'sample_with_image.pptx', 'sample.txt', 'sample.jpg'];
  for (const name of samples) {
    await check(`round-trip ${name}`, async () => {
      const src = path.join('/home/claude/testfiles', name);
      const dst = path.join(indicatorDir, name);
      fs.copyFileSync(src, dst);
      await new Promise(r => setTimeout(r, 300)); // let chokidar settle
      const r = await fetch(`${base}/api/file/${encodeURIComponent(code)}/${encodeURIComponent(name)}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const orig = fs.readFileSync(src);
      if (!buf.equals(orig)) throw new Error(`byte mismatch: got ${buf.length}B, expected ${orig.length}B`);
    });
  }

  // 6) confirm the file list API reports them (proves watcher + listing still intact)
  await check('GET /api/files/:code lists new files', async () => {
    const r = await fetch(`${base}/api/files/${code}`);
    const d = await r.json();
    const names = (d.files || []).map(f => f.name);
    for (const name of samples) if (!names.includes(name)) throw new Error('missing ' + name + ' in listing');
  });

  console.log('\n=== VIEWER INTEGRATION TEST RESULTS ===');
  let failed = 0;
  for (const [name, status] of results) {
    console.log((status === 'OK' ? '✅' : '❌') + '  ' + name + '  ' + (status === 'OK' ? '' : '- ' + status));
    if (status !== 'OK') failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
