'use strict';
/*
 * Focused test suite for the centralized file-support policy
 * (app/js/file-support-policy.js) — covers exactly what
 * FILE-SUPPORT-ARCHITECTURE-REPORT.md documents:
 *   - The policy module itself (pure logic, no server needed)
 *   - Real upload validation through the actual HTTP endpoint
 *     (extension allow-list, size limits, magic-byte signature check)
 *   - That the server's file-listing `category` field matches the policy
 * This does not re-test PDF/viewer rendering — that's covered by
 * verify:viewer and the dedicated pdf-render-order test.
 */

// Mock the 'electron' module BEFORE anything requires it (same pattern as
// the other integration tests in this directory).
const path = require('path');
const os = require('os');
const Module = require('module');

const fakeUserData = path.join(os.tmpdir(), 'filepolicy-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'filepolicy-test-docs-' + Date.now());
require('fs').mkdirSync(fakeUserData, { recursive: true });
require('fs').mkdirSync(fakeDocs, { recursive: true });
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;

const fakeElectron = {
  app: {
    isPackaged: false,
    getPath: (name) => (name === 'userData' ? fakeUserData : name === 'documents' ? fakeDocs : os.tmpdir()),
    getVersion: () => '1.0.0-test',
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: () => {}, quit: () => {},
  },
  shell: { openPath: async () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => {} },
  BrowserWindow: class { constructor() {} loadURL() {} loadFile() {} once() {} on() {} show() {} focus() {} },
  ipcMain: { handle: () => {} }, ipcRenderer: {}, contextBridge: { exposeInMainWorld: () => {} }, screen: {},
};
require.cache['electron-mock-virtual'] = { id: 'electron-mock-virtual', filename: 'electron-mock-virtual', loaded: true, exports: fakeElectron };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.call(this, request, parent, isMain);
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-mock-virtual';
  return origResolve.call(this, request, ...rest);
};

const FileSupportPolicy = require('../app/js/file-support-policy.js');

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
      body: JSON.stringify({ name: 'مدرسة سياسة الملفات', stage: 'ثانوي', admin_name: 'مدير', ministry_num: '1', school_type: 'gov', setup_done: 1 }),
    });
    if (!(await r.json()).success) throw new Error('setup failed');
  });

  let code;
  await check('resolve an indicator code', async () => {
    const structure = await (await fetch(`${base}/api/structure`)).json();
    code = Object.keys(structure.indicatorMap)[0];
    if (!code) throw new Error('no indicator code found');
  });

  // ══════════════════════════════════════════════════════════
  // 1. POLICY MODULE — pure logic, no server round trip
  // ══════════════════════════════════════════════════════════
  const expectedAllowed = [
    'pdf', 'docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'xlsm', 'csv',
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg',
    'txt', 'md', 'log', 'json', 'xml',
  ];
  for (const ext of expectedAllowed) {
    await check(`policy: .${ext} is upload-allowed`, async () => {
      if (!FileSupportPolicy.isUploadAllowed('file.' + ext)) throw new Error('expected allowed');
    });
  }
  const expectedBlocked = ['zip', 'rar', '7z', 'tar', 'gz'];
  for (const ext of expectedBlocked) {
    await check(`policy: .${ext} is upload-blocked (archives)`, async () => {
      if (FileSupportPolicy.isUploadAllowed('file.' + ext)) throw new Error('expected blocked');
    });
  }
  await check('policy: unknown extension is upload-blocked', async () => {
    if (FileSupportPolicy.isUploadAllowed('file.xyzabc')) throw new Error('expected blocked');
  });

  const previewMatrix = {
    pdf: true, docx: true, doc: false, pptx: true, ppt: false,
    xlsx: true, xls: true, xlsm: true, csv: true,
    jpg: true, png: true, webp: true, svg: true,
    txt: true, json: true, xml: true,
  };
  for (const [ext, expected] of Object.entries(previewMatrix)) {
    await check(`policy: .${ext} preview supported = ${expected}`, async () => {
      const actual = FileSupportPolicy.isPreviewSupported('file.' + ext);
      if (actual !== expected) throw new Error(`expected ${expected}, got ${actual}`);
    });
  }

  await check('policy: pptx preview fidelity is "partial" (not full)', async () => {
    const p = FileSupportPolicy.getPolicy('deck.pptx');
    if (p.preview.fidelity !== 'partial') throw new Error('expected partial, got ' + p.preview.fidelity);
  });
  await check('policy: docx preview fidelity is "full"', async () => {
    const p = FileSupportPolicy.getPolicy('doc.docx');
    if (p.preview.fidelity !== 'full') throw new Error('expected full, got ' + p.preview.fidelity);
  });
  await check('policy: doc (legacy) fallback is "external-open"', async () => {
    const p = FileSupportPolicy.getPolicy('old.doc');
    if (p.fallback !== 'external-open') throw new Error('expected external-open, got ' + p.fallback);
  });

  await check('policy: magic-byte check catches a mislabeled file (fake pdf)', async () => {
    const fakeBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const verdict = FileSupportPolicy.classifyUpload({ filename: 'fake.pdf', size: 100, headerBytes: fakeBytes });
    if (verdict.ok) throw new Error('expected rejection for signature mismatch');
    if (verdict.reason !== 'SIGNATURE_MISMATCH') throw new Error('expected SIGNATURE_MISMATCH, got ' + verdict.reason);
  });
  await check('policy: magic-byte check accepts a real pdf header', async () => {
    const realBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"
    const verdict = FileSupportPolicy.classifyUpload({ filename: 'real.pdf', size: 100, headerBytes: realBytes });
    if (!verdict.ok) throw new Error('expected acceptance for a real PDF header');
  });
  await check('policy: oversized file is rejected with TOO_LARGE', async () => {
    const verdict = FileSupportPolicy.classifyUpload({ filename: 'huge.docx', size: 999 * 1024 * 1024 });
    if (verdict.ok || verdict.reason !== 'TOO_LARGE') throw new Error('expected TOO_LARGE rejection');
  });

  // ══════════════════════════════════════════════════════════
  // 2. REAL HTTP UPLOAD ENDPOINT — server-side enforcement
  // ══════════════════════════════════════════════════════════
  async function uploadRaw(filename, bytes, contentType) {
    return fetch(`${base}/api/upload/${code}`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(filename), 'Content-Type': contentType || 'application/octet-stream' },
      body: bytes,
    });
  }

  const realPdfBytes = Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
  await check('upload: real PDF (correct magic bytes) is accepted', async () => {
    const r = await uploadRaw('real-test.pdf', realPdfBytes, 'application/pdf');
    if (!r.ok) throw new Error('HTTP ' + r.status);
  });

  await check('upload: allowed plain-text formats are accepted', async () => {
    for (const [name, body] of [
      ['note.txt', 'hello'], ['data.json', '{"a":1}'], ['doc.xml', '<a/>'],
      ['readme.md', '# hi'], ['app.log', 'log line'], ['table.csv', 'a,b\n1,2'],
    ]) {
      const r = await uploadRaw(name, Buffer.from(body), 'text/plain');
      if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    }
  });

  await check('upload: real PNG (correct magic bytes) is accepted', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r = await uploadRaw('real.png', pngHeader, 'image/png');
    if (!r.ok) throw new Error('HTTP ' + r.status);
  });

  await check('upload: a .exe is rejected (415, not in allow-list)', async () => {
    const r = await uploadRaw('virus.exe', Buffer.from('MZ...'), 'application/octet-stream');
    if (r.status !== 415) throw new Error('expected 415, got ' + r.status);
    const body = await r.json();
    if (!body.error || !body.allowedExtensions) throw new Error('expected a friendly error body with allowedExtensions');
  });

  await check('upload: a .zip is rejected (archives disabled)', async () => {
    const r = await uploadRaw('bundle.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'application/zip');
    if (r.status !== 415) throw new Error('expected 415, got ' + r.status);
  });

  await check('upload: an unknown extension is rejected', async () => {
    const r = await uploadRaw('mystery.xyzabc', Buffer.from('???'), 'application/octet-stream');
    if (r.status !== 415) throw new Error('expected 415, got ' + r.status);
  });

  await check('upload: a file named .pdf but containing plain text is rejected (spoofed extension)', async () => {
    const r = await uploadRaw('spoofed.pdf', Buffer.from('this is not a real pdf file at all'), 'application/pdf');
    if (r.status !== 415) throw new Error('expected 415 for spoofed content, got ' + r.status);
    const body = await r.json();
    if (body.reason !== 'SIGNATURE_MISMATCH') throw new Error('expected SIGNATURE_MISMATCH, got ' + body.reason);
  });

  await check('upload: path traversal in filename is neutralized, not rejected as a type issue', async () => {
    const r = await uploadRaw('../../evil.txt', Buffer.from('hi'), 'text/plain');
    // Should either succeed with a sanitized basename, or fail — but must
    // never write outside the indicator folder. We check it did NOT
    // silently accept a path-traversal write by confirming the listing
    // only ever shows a bare filename.
    const list = await (await fetch(`${base}/api/files/${code}`)).json();
    const leaked = list.files.some(f => f.name.includes('/') || f.name.includes('..'));
    if (leaked) throw new Error('a path-traversal filename leaked into the listing');
  });

  // ══════════════════════════════════════════════════════════
  // 3. SERVER CLASSIFICATION MATCHES THE POLICY (no drift)
  // ══════════════════════════════════════════════════════════
  await check('server file.category matches FileSupportPolicy for every uploaded type', async () => {
    const list = await (await fetch(`${base}/api/files/${code}`)).json();
    for (const f of list.files) {
      const expected = FileSupportPolicy.getCategory(f.name);
      if (f.category !== expected) {
        throw new Error(`${f.name}: server says category="${f.category}", policy says "${expected}"`);
      }
    }
  });

  await check('GET /api/file-policy exposes the same allow-list the server enforces', async () => {
    const policy = await (await fetch(`${base}/api/file-policy`)).json();
    const serverAllowed = new Set(policy.allowedExtensions);
    const moduleAllowed = new Set(FileSupportPolicy.allowedExtensionsList());
    if (serverAllowed.size !== moduleAllowed.size) throw new Error('allow-list size mismatch between endpoint and module');
    for (const ext of moduleAllowed) if (!serverAllowed.has(ext)) throw new Error(`${ext} missing from /api/file-policy`);
  });

  console.log('\n=== FILE SUPPORT POLICY TEST RESULTS ===');
  let failed = 0;
  for (const [name, status] of results) {
    console.log((status === 'OK' ? '✅' : '❌') + '  ' + name + (status === 'OK' ? '' : '  - ' + status));
    if (status !== 'OK') failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
