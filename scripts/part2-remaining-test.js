'use strict';
const path = require('path'); const os = require('os'); const fs = require('fs'); const Module = require('module');
const fakeUserData = path.join(os.tmpdir(), 'rn-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'rn-test-docs-' + Date.now());
fs.mkdirSync(fakeUserData, { recursive: true }); fs.mkdirSync(fakeDocs, { recursive: true });
process.env.SCHOOL_APP_TEST_INSTALL_DIR = fakeDocs;
const fakeElectron = {
  app: { isPackaged: false, getPath: (n) => (n === 'userData' ? fakeUserData : n === 'documents' ? fakeDocs : os.tmpdir()), getVersion: () => '1.0.0-test', requestSingleInstanceLock: () => true, whenReady: () => Promise.resolve(), on: () => {}, quit: () => {} },
  shell: { openPath: async () => '' }, dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showErrorBox: () => {} },
  BrowserWindow: class { constructor() {} loadURL() {} loadFile() {} once() {} on() {} show() {} focus() {} },
  ipcMain: { handle: () => {} }, ipcRenderer: {}, contextBridge: { exposeInMainWorld: () => {} }, screen: {},
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (r, ...rest) { if (r === 'electron') return 'electron-mock-virtual'; return origResolve.call(this, r, ...rest); };
require.cache['electron-mock-virtual'] = { id: 'electron-mock-virtual', filename: 'electron-mock-virtual', loaded: true, exports: fakeElectron };
const origLoad = Module._load;
Module._load = function (r, p, m) { if (r === 'electron') return fakeElectron; return origLoad.call(this, r, p, m); };

(async () => {
  const http = require('http');
  const { createApp } = require('../server/app');
  const app = await createApp();
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const results = [];
  async function check(name, fn) { try { await fn(); results.push([name, 'OK']); } catch (e) { results.push([name, 'FAIL: ' + e.message]); } }

  await check('setup school', async () => {
    const r = await fetch(`${base}/api/school`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'مدرسة', stage: 'ثانوي', admin_name: 'مدير', ministry_num: '1', school_type: 'private', setup_done: 1 }) });
    if (!(await r.json()).success) throw new Error('setup failed');
  });

  const evidenceService = require('../server/services/evidenceService');
  let code, dir;
  await check('new static assets served (search/sort/filter, thumbnails, context menu, dialogs)', async () => {
    const assets = ['/js/file-grid-controls.js', '/css/file-grid-controls.css', '/js/thumbnails.js', '/css/thumbnails.css',
      '/js/context-menu.js', '/css/context-menu.css', '/js/dialogs.js', '/css/dialogs.css'];
    for (const p of assets) {
      const r = await fetch(base + p);
      if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status);
    }
  });

  await check('resolve indicator folder', async () => {
    const d = await fetch(`${base}/api/structure`).then(r => r.json());
    code = Object.keys(d.indicatorMap)[0];
    dir = evidenceService.folderForCode(d.evidenceRoot, code);
  });

  await check('listFiles includes absolute path field', async () => {
    fs.writeFileSync(path.join(dir, 'path-field-test.txt'), 'x');
    await new Promise(r => setTimeout(r, 300));
    const d = await fetch(`${base}/api/files/${code}`).then(r => r.json());
    const f = d.files.find(x => x.name === 'path-field-test.txt');
    if (!f || !f.path) throw new Error('no path field');
    if (!f.path.endsWith('path-field-test.txt')) throw new Error('unexpected path: ' + f.path);
  });

  await check('rename succeeds', async () => {
    const r = await fetch(`${base}/api/file/${code}/rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: 'path-field-test.txt', newName: 'renamed-ok.txt' }) });
    const d = await r.json();
    if (!d.success) throw new Error('rename failed: ' + JSON.stringify(d));
    if (!fs.existsSync(path.join(dir, 'renamed-ok.txt'))) throw new Error('new file missing on disk');
    if (fs.existsSync(path.join(dir, 'path-field-test.txt'))) throw new Error('old file still exists');
  });

  await check('rename to a duplicate name is rejected with 409', async () => {
    fs.writeFileSync(path.join(dir, 'already-exists.txt'), 'x');
    const r = await fetch(`${base}/api/file/${code}/rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: 'renamed-ok.txt', newName: 'already-exists.txt' }) });
    if (r.status !== 409) throw new Error('expected 409, got ' + r.status);
    if (!fs.existsSync(path.join(dir, 'renamed-ok.txt'))) throw new Error('original file should be untouched after rejected rename');
  });

  await check('rename with path traversal in newName is rejected', async () => {
    const r = await fetch(`${base}/api/file/${code}/rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: 'renamed-ok.txt', newName: '../../evil.txt' }) });
    const d = await r.json();
    // path.basename() strips the traversal, so this should succeed as a plain rename to "evil.txt" inside the same dir, not escape it
    if (r.status >= 400) return; // also acceptable if rejected outright
    if (!fs.existsSync(path.join(dir, 'evil.txt'))) throw new Error('expected basename-sanitized rename inside the indicator folder');
    if (fs.existsSync(path.join(path.dirname(dir), 'evil.txt'))) throw new Error('SECURITY: file escaped the indicator folder!');
  });

  await check('rename of a nonexistent file returns 404', async () => {
    const r = await fetch(`${base}/api/file/${code}/rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: 'does-not-exist.txt', newName: 'x.txt' }) });
    if (r.status !== 404) throw new Error('expected 404, got ' + r.status);
  });

  await check('rename with invalid characters is rejected', async () => {
    fs.writeFileSync(path.join(dir, 'valid-name.txt'), 'x');
    const r = await fetch(`${base}/api/file/${code}/rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: 'valid-name.txt', newName: 'bad:name?.txt' }) });
    if (r.status !== 400) throw new Error('expected 400, got ' + r.status);
  });

  await check('rename triggers watcher SSE add/remove (existing infra reused)', async () => {
    const events = [];
    const es = await new Promise((resolve, reject) => {
      const http2 = require('http');
      const req = http2.get(`${base}/api/events`, (res) => {
        res.on('data', (chunk) => {
          const s = chunk.toString();
          const m = s.match(/data: (.+)/g);
          if (m) m.forEach(line => { try { events.push(JSON.parse(line.replace('data: ', ''))); } catch {} });
        });
        resolve(req);
      });
      req.on('error', reject);
    });
    await new Promise(r => setTimeout(r, 200));
    await fetch(`${base}/api/file/${code}/rename`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldName: 'valid-name.txt', newName: 'sse-rename-test.txt' }) });
    await new Promise(r => setTimeout(r, 600));
    es.destroy();
    const hasAdd = events.some(e => e.event === 'add' && e.file === 'sse-rename-test.txt');
    if (!hasAdd) throw new Error('expected an SSE "add" event for the renamed file, got: ' + JSON.stringify(events));
  });

  await check('open-file endpoint calls shell.openPath and returns success', async () => {
    fs.writeFileSync(path.join(dir, 'to-open.txt'), 'x');
    const r = await fetch(`${base}/api/open-file/${code}/${encodeURIComponent('to-open.txt')}`, { method: 'POST' });
    const d = await r.json();
    if (!d.success) throw new Error('expected success: ' + JSON.stringify(d));
  });

  await check('open-file on a missing file returns 404', async () => {
    const r = await fetch(`${base}/api/open-file/${code}/${encodeURIComponent('nope.txt')}`, { method: 'POST' });
    if (r.status !== 404) throw new Error('expected 404, got ' + r.status);
  });

  console.log('\n=== RENAME/OPEN-FILE TEST RESULTS ===');
  let failed = 0;
  for (const [name, status] of results) { console.log((status === 'OK' ? '✅' : '❌') + '  ' + name + (status === 'OK' ? '' : '  - ' + status)); if (status !== 'OK') failed++; }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
