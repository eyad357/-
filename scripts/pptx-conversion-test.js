'use strict';
/*
 * Tests for the PPTX real-rendering pipeline (server/services/
 * officeConversionService.js + the /api/office-conversion/* routes).
 * See PPTX-PRESENTATION-MODE-REPORT.md for architecture rationale.
 *
 * These exercise the actual conversion against real, generated PPTX
 * files (English with background/shapes/table, Arabic RTL, 4:3 dark
 * theme, many-slide deck) — not mocks — since the whole point is
 * validating real LibreOffice output.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'pptx-conv-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'pptx-conv-test-docs-' + Date.now());
fs.mkdirSync(fakeUserData, { recursive: true });
fs.mkdirSync(fakeDocs, { recursive: true });
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? fakeUserData : name === 'documents' ? fakeDocs : os.tmpdir()),
    getVersion: () => '1.0.0-test',
    requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on: () => {}, quit: () => {},
  },
  shell: { openPath: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => {} },
  BrowserWindow: class { constructor() {} loadURL() {} loadFile() {} once() {} on() {} show() {} focus() {} },
  ipcMain: { handle: () => {} }, ipcRenderer: {}, contextBridge: { exposeInMainWorld: () => {} }, screen: {},
};
require.cache['electron-mock-virtual'] = { id: 'electron-mock-virtual', filename: 'electron-mock-virtual', loaded: true, exports: fakeElectron };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) { if (request === 'electron') return fakeElectron; return origLoad.call(this, request, parent, isMain); };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) { if (request === 'electron') return 'electron-mock-virtual'; return origResolve.call(this, request, ...rest); };

const officeConversionService = require('../server/services/officeConversionService');
const pathsModule = require('../electron/utils/paths');

const TEST_FILES_DIR = '/home/claude/pptx_test_files';

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
      body: JSON.stringify({ name: 'مدرسة اختبار PPTX', stage: 'ثانوي', admin_name: 'مدير', ministry_num: '1', school_type: 'gov', setup_done: 1 }),
    });
    if (!(await r.json()).success) throw new Error('setup failed');
  });

  let code;
  await check('resolve an indicator code', async () => {
    const structure = await (await fetch(`${base}/api/structure`)).json();
    code = Object.keys(structure.indicatorMap)[0];
    if (!code) throw new Error('no indicator code found');
  });

  await check('officeConversionService finds a soffice binary', async () => {
    const found = await officeConversionService.findSofficeBinary();
    if (!found) throw new Error('no soffice found in this environment — cannot validate real conversion');
  });

  await check('GET /api/office-conversion/capability reports available=true', async () => {
    const body = await (await fetch(`${base}/api/office-conversion/capability`)).json();
    if (body.available !== true) throw new Error('expected available=true given soffice is present');
  });

  async function uploadAndConvert(localFile, remoteName) {
    const bytes = fs.readFileSync(path.join(TEST_FILES_DIR, localFile));
    const up = await fetch(`${base}/api/upload/${code}`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(remoteName), 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!up.ok) throw new Error('upload failed: HTTP ' + up.status);
    const conv = await fetch(`${base}/api/office-conversion/${code}/${encodeURIComponent(remoteName)}`, { method: 'POST' });
    const body = await conv.json();
    if (!body.ok) throw new Error('conversion failed: ' + JSON.stringify(body));
    return body.cacheKey;
  }

  let englishCacheKey;
  await check('convert rich English PPTX (background/shapes/table) to PDF', async () => {
    englishCacheKey = await uploadAndConvert('rich-english-test.pptx', 'rich-english-test.pptx');
  });

  await check('converted PDF is fetchable and starts with %PDF-', async () => {
    const r = await fetch(`${base}/api/office-conversion/pdf/${englishCacheKey}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('not a valid PDF header');
    if (buf.length < 1000) throw new Error('suspiciously small PDF (' + buf.length + ' bytes) — conversion likely produced near-empty output');
  });

  await check('re-converting the same unchanged file hits the cache (fast, same key)', async () => {
    const t0 = Date.now();
    const conv = await fetch(`${base}/api/office-conversion/${code}/rich-english-test.pptx`, { method: 'POST' });
    const body = await conv.json();
    const elapsed = Date.now() - t0;
    if (body.cacheKey !== englishCacheKey) throw new Error('cache key changed for an unchanged file');
    if (elapsed > 1000) throw new Error(`cache hit took ${elapsed}ms — expected near-instant, this looks like it re-converted`);
  });

  await check('convert Arabic RTL PPTX to PDF', async () => {
    const key = await uploadAndConvert('arabic-rtl-test.pptx', 'arabic-rtl-test.pptx');
    const r = await fetch(`${base}/api/office-conversion/pdf/${key}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.slice(0, 5).toString() !== '%PDF-') throw new Error('not a valid PDF');
  });

  await check('convert 4:3 dark-theme PPTX to PDF', async () => {
    const key = await uploadAndConvert('aspect-4x3-dark.pptx', 'aspect-4x3-dark.pptx');
    const r = await fetch(`${base}/api/office-conversion/pdf/${key}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
  });

  await check('convert many-slide (20 slide) PPTX and verify page count via pdf.js-independent check', async () => {
    const key = await uploadAndConvert('many-slides-test.pptx', 'many-slides-test.pptx');
    const r = await fetch(`${base}/api/office-conversion/pdf/${key}`);
    const buf = Buffer.from(await r.arrayBuffer());
    // Count "/Type /Page" object occurrences as a crude but independent
    // sanity check that all 20 slides made it into the PDF (not a
    // rigorous parse, just a smoke check distinct from pdf.js itself).
    const text = buf.toString('latin1');
    const pageCount = (text.match(/\/Type\s*\/Page[^s]/g) || []).length;
    if (pageCount < 15) throw new Error(`expected ~20 page objects, found ${pageCount} — conversion may have truncated slides`);
  });

  await check('convert transparent-image PPTX to PDF', async () => {
    const key = await uploadAndConvert('transparent-image-test.pptx', 'transparent-image-test.pptx');
    const r = await fetch(`${base}/api/office-conversion/pdf/${key}`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
  });

  await check('GET pdf with an invalid cache key format is rejected (400), not path-traversed', async () => {
    const r = await fetch(`${base}/api/office-conversion/pdf/../../../etc/passwd`);
    if (r.status !== 400 && r.status !== 404) throw new Error('expected 400/404 for malformed cache key, got ' + r.status);
  });

  await check('converting a nonexistent evidence file returns 404, not a crash', async () => {
    const r = await fetch(`${base}/api/office-conversion/${code}/does-not-exist.pptx`, { method: 'POST' });
    if (r.status !== 404) throw new Error('expected 404, got ' + r.status);
  });

  await check('pruneCache runs without throwing on a populated cache dir', async () => {
    await officeConversionService.pruneCache(pathsModule.getOfficeConversionCacheDir(), 0); // maxAge=0 prunes everything
  });

  console.log('\n=== PPTX OFFICE CONVERSION TEST RESULTS ===');
  let failed = 0;
  for (const [name, status] of results) {
    console.log((status === 'OK' ? '✅' : '❌') + '  ' + name + (status === 'OK' ? '' : '  - ' + status));
    if (status !== 'OK') failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
