'use strict';
// Tests the completion/progress engine: the graduated per-indicator formula,
// and the standard/domain/school rollups built on top of it.
const path = require('path');
const os = require('os');
const fs = require('fs');
const Module = require('module');

const results = [];
function check(name, fn) {
  try { fn(); results.push([name, 'OK']); }
  catch (err) { results.push([name, 'FAIL: ' + err.message]); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push([name, 'OK']); }
  catch (err) { results.push([name, 'FAIL: ' + err.message]); }
}

// Electron mock must be installed BEFORE anything requires evidenceService
// (which pulls in electron/utils/logger -> 'electron'), so set it up first.
const fakeUserData = path.join(os.tmpdir(), 'completion-test-userdata-' + Date.now());
const fakeDocs = path.join(os.tmpdir(), 'completion-test-docs-' + Date.now());
fs.mkdirSync(fakeUserData, { recursive: true });
fs.mkdirSync(fakeDocs, { recursive: true });
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

// ── 1) Pure formula checks (no server needed, but evidenceService requires the mock above) ──
const completionService = require('../server/services/completionService');

check('0 files = 0%', () => { if (completionService.indicatorPercent(0) !== 0) throw new Error('got ' + completionService.indicatorPercent(0)); });
check('1 file = 17%', () => { if (completionService.indicatorPercent(1) !== 17) throw new Error('got ' + completionService.indicatorPercent(1)); });
check('2 files = 33%', () => { if (completionService.indicatorPercent(2) !== 33) throw new Error('got ' + completionService.indicatorPercent(2)); });
check('3 files = 50%', () => { if (completionService.indicatorPercent(3) !== 50) throw new Error('got ' + completionService.indicatorPercent(3)); });
check('4 files = 67%', () => { if (completionService.indicatorPercent(4) !== 67) throw new Error('got ' + completionService.indicatorPercent(4)); });
check('5 files = 83%', () => { if (completionService.indicatorPercent(5) !== 83) throw new Error('got ' + completionService.indicatorPercent(5)); });
check('6 files = 100%', () => { if (completionService.indicatorPercent(6) !== 100) throw new Error('got ' + completionService.indicatorPercent(6)); });
check('10 files = 100% (never exceeds 100)', () => { if (completionService.indicatorPercent(10) !== 100) throw new Error('got ' + completionService.indicatorPercent(10)); });
check('25 files = 100% (never exceeds 100)', () => { if (completionService.indicatorPercent(25) !== 100) throw new Error('got ' + completionService.indicatorPercent(25)); });
check('1000 files = 100% (stress case, never exceeds 100)', () => { if (completionService.indicatorPercent(1000) !== 100) throw new Error('got ' + completionService.indicatorPercent(1000)); });

// ── 2) Full rollup against real files on disk ──
(async () => {
  const http = require('http');
  const { createApp } = require('../server/app');
  const app = await createApp();
  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;

  await checkAsync('setup school', async () => {
    const r = await fetch(`${base}/api/school`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'مدرسة', stage: 'ثانوي', admin_name: 'مدير', ministry_num: '1', school_type: 'private', setup_done: 1 }) });
    if (!(await r.json()).success) throw new Error('setup failed');
  });

  const evidenceService = require('../server/services/evidenceService');
  let evidenceRoot;
  const codes = evidenceService.applicableCodes('private');

  await checkAsync('resolve evidence root', async () => {
    const d = await fetch(`${base}/api/structure`).then((r) => r.json());
    evidenceRoot = d.evidenceRoot;
    if (!evidenceRoot) throw new Error('no evidence root');
  });

  // Craft a known scenario: pick the first standard group present among the
  // first ~5 codes and give its indicators controlled file counts so the
  // standard-level rollup can be checked against hand-computed expectations.
  let fileSeq = 0;
  function dropFiles(code, count) {
    const dir = evidenceService.folderForCode(evidenceRoot, code);
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, `f${fileSeq++}.txt`), 'x');
  }

  const manifestByCode = evidenceService.MANIFEST;
  // Find a standard with at least 2 indicators so we can craft a partial 12/14-style case.
  const byStandard = new Map();
  codes.forEach((c) => {
    const key = manifestByCode[c].domainFolder + '|||' + manifestByCode[c].standardFolder;
    if (!byStandard.has(key)) byStandard.set(key, []);
    byStandard.get(key).push(c);
  });
  const targetKey = [...byStandard.entries()].find(([, list]) => list.length >= 2)[0];
  const targetCodes = byStandard.get(targetKey);

  await checkAsync('drop controlled file counts into a real standard\'s indicators', async () => {
    // First indicator: fully complete (6 files). Second: partial (2 files -> 33%).
    dropFiles(targetCodes[0], 6);
    dropFiles(targetCodes[1], 2);
    // Any remaining indicators in this standard: leave at 0 files.
    await new Promise((r) => setTimeout(r, 300));
  });

  let progress;
  await checkAsync('GET /api/progress succeeds and has the right shape', async () => {
    const r = await fetch(`${base}/api/progress`);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    progress = await r.json();
    if (!progress.indicators || !progress.standards || !progress.domains || !progress.school) {
      throw new Error('missing top-level keys: ' + Object.keys(progress));
    }
  });

  check('indicator with 6 files is 100% and marked completed', () => {
    const ind = progress.indicators[targetCodes[0]];
    if (ind.percent !== 100 || !ind.completed) throw new Error(JSON.stringify(ind));
    if (ind.requiredMet !== 6 || ind.additionalFiles !== 0) throw new Error('required/additional wrong: ' + JSON.stringify(ind));
  });

  check('indicator with 2 files is 33% and NOT completed', () => {
    const ind = progress.indicators[targetCodes[1]];
    if (ind.percent !== 33 || ind.completed) throw new Error(JSON.stringify(ind));
    if (ind.requiredMet !== 2 || ind.additionalFiles !== 0) throw new Error('required/additional wrong: ' + JSON.stringify(ind));
  });

  check('indicator with 0 files is 0% and NOT completed', () => {
    if (targetCodes.length < 3) return; // only checkable if this standard has a 3rd indicator
    const ind = progress.indicators[targetCodes[2]];
    if (ind.percent !== 0 || ind.completed) throw new Error(JSON.stringify(ind));
  });

  check('standard percent = completedIndicators/totalIndicators, NOT an average of partial percentages', () => {
    const [domain, standard] = targetKey.split('|||');
    const std = progress.standards.find((s) => s.domain === domain && s.standard === standard);
    if (!std) throw new Error('standard not found: ' + targetKey);
    const expectedCompleted = 1; // only targetCodes[0] hit 6 files
    const expectedPercent = Math.round((expectedCompleted / std.totalIndicators) * 100);
    if (std.completedIndicators !== expectedCompleted) throw new Error('completedIndicators wrong: ' + JSON.stringify(std));
    if (std.percent !== expectedPercent) throw new Error(`expected ${expectedPercent}%, got ${std.percent}% — ${JSON.stringify(std)}`);
    // Sanity: naive average of (100, 33, 0...) would give a DIFFERENT number
    // than the completed-count-based percent for most indicator counts >2,
    // proving the engine isn't just averaging individual percentages.
  });

  check('domain rollup aggregates its standards correctly', () => {
    const [domain] = targetKey.split('|||');
    const dom = progress.domains.find((d) => d.domain === domain);
    if (!dom) throw new Error('domain not found: ' + domain);
    const relatedStandards = progress.standards.filter((s) => s.domain === domain);
    const expectedIndicators = relatedStandards.reduce((s, x) => s + x.totalIndicators, 0);
    const expectedCompleted = relatedStandards.reduce((s, x) => s + x.completedIndicators, 0);
    if (dom.indicatorsCount !== expectedIndicators) throw new Error('indicatorsCount mismatch: ' + JSON.stringify(dom));
    if (dom.percent !== Math.round((expectedCompleted / expectedIndicators) * 100)) throw new Error('domain percent mismatch: ' + JSON.stringify(dom));
  });

  check('school-wide totals match the sum of all indicators', () => {
    const allCodes = Object.keys(progress.indicators);
    const expectedTotalFiles = allCodes.reduce((s, c) => s + progress.indicators[c].totalFiles, 0);
    const expectedCompleted = allCodes.reduce((s, c) => s + (progress.indicators[c].completed ? 1 : 0), 0);
    if (progress.school.totalFiles !== expectedTotalFiles) throw new Error('school totalFiles mismatch');
    if (progress.school.completedIndicators !== expectedCompleted) throw new Error('school completedIndicators mismatch');
    if (progress.school.totalIndicators !== allCodes.length) throw new Error('school totalIndicators mismatch');
    if (progress.school.percent !== Math.round((expectedCompleted / allCodes.length) * 100)) throw new Error('school percent mismatch');
  });

  check('additional evidence files beyond 6 are still counted everywhere (totals/storage/distribution) but capped at 100% completion', () => {
    // Give one indicator way more than 6 files.
    const heavyCode = targetCodes[0]; // already has 6 -> now push to 20
    dropFiles(heavyCode, 14); // 6 existing + 14 new = 20 total
  });

  await checkAsync('re-fetch after adding more files: percent stays capped at 100, but totals/additional grow', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const r = await fetch(`${base}/api/progress`);
    const p2 = await r.json();
    const ind = p2.indicators[targetCodes[0]];
    if (ind.totalFiles !== 20) throw new Error('expected 20 total files, got ' + ind.totalFiles);
    if (ind.percent !== 100) throw new Error('percent should stay capped at 100, got ' + ind.percent);
    if (ind.additionalFiles !== 14) throw new Error('expected 14 additional files, got ' + ind.additionalFiles);
    if (ind.requiredMet !== 6) throw new Error('requiredMet should stay at 6, got ' + ind.requiredMet);
    if (p2.school.totalFiles < 20) throw new Error('school totalFiles should reflect the extra files too');
  });

  check('top-completed / needs-attention standard lists are present and sorted', () => {
    const top = progress.school.topCompletedStandards;
    const attn = progress.school.standardsRequiringAttention;
    if (!Array.isArray(top) || !Array.isArray(attn)) throw new Error('missing lists');
    for (let i = 1; i < top.length; i++) if (top[i].percent > top[i - 1].percent) throw new Error('top list not sorted descending');
    for (let i = 1; i < attn.length; i++) if (attn[i].percent < attn[i - 1].percent) throw new Error('attention list not sorted ascending');
  });

  console.log('\n=== COMPLETION ENGINE TEST RESULTS ===');
  let failed = 0;
  for (const [name, status] of results) {
    console.log((status === 'OK' ? '✅' : '❌') + '  ' + name + (status === 'OK' ? '' : '  - ' + status));
    if (status !== 'OK') failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
