'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const log = require('../electron/utils/logger');
const Store = require('./store/store');
const evidenceService = require('./services/evidenceService');
const evidenceWatcher = require('./services/evidenceWatcher');
const paths = require('../electron/utils/paths');

function resolveEvidenceRoot(store) {
  const custom = store.school.evidence_root;
  return custom && custom.trim() ? custom.trim() : paths.getDefaultEvidenceRoot();
}

async function createApp() {
  const app = express();
  const store = new Store(paths.getStoreFile());

  app.locals.store = store;
  app.locals.sseClients = new Set();
  app.locals.evidenceRoot = resolveEvidenceRoot(store);

  // ── First-run bootstrap: create the evidence folder tree and seed any
  //    bundled template files, without ever touching existing content. ──
  await evidenceService.seedFromTemplate(paths.getEvidenceTemplatePath(), app.locals.evidenceRoot);
  await evidenceService.ensureAllFolders(app.locals.evidenceRoot);

  // ── Self-healing: if the evidence root (or any indicator folder inside it)
  //    is ever deleted while the app is running — accidentally or otherwise —
  //    recreate the missing structure automatically. ensureAllFolders() only
  //    ever creates missing directories; it never touches or overwrites any
  //    existing file, so any user data that survives is always preserved. ──
  const SELF_HEAL_INTERVAL_MS = 60 * 1000;
  setInterval(async () => {
    try {
      const rootExisted = fs.existsSync(app.locals.evidenceRoot);
      await evidenceService.ensureAllFolders(app.locals.evidenceRoot);
      if (!rootExisted) {
        log.warn('Evidence root was missing and has been recreated:', app.locals.evidenceRoot);
        evidenceWatcher.restart(app.locals.evidenceRoot, evidenceWatcher.onEvent);
        app.locals.broadcastSSE({ event: 'root_restored' });
      }
    } catch (err) {
      log.error('Self-heal check failed:', err.message);
    }
  }, SELF_HEAL_INTERVAL_MS).unref();

  app.locals.broadcastSSE = (payload) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of app.locals.sseClients) {
      try { res.write(data); } catch (_) { /* client likely gone */ }
    }
  };

  app.locals.setEvidenceRoot = async (newRoot) => {
    const resolved = newRoot && newRoot.trim() ? newRoot.trim() : paths.getDefaultEvidenceRoot();
    app.locals.evidenceRoot = resolved;
    await evidenceService.ensureAllFolders(resolved);
    evidenceWatcher.restart(resolved, (evt) => {
      app.locals.broadcastSSE(evt);
      if (evt.event === 'add') {
        store.addAudit({ action: 'file_detected', target: evt.file, indicator: evt.code, details: 'تم اكتشافه تلقائيًا من مجلد الشواهد' });
      } else if (evt.event === 'remove') {
        store.addAudit({ action: 'file_deleted', target: evt.file, indicator: evt.code, details: 'أُزيل يدويًا من مجلد الشواهد' });
      }
    });
  };

  // Start watching immediately.
  evidenceWatcher.start(app.locals.evidenceRoot, (evt) => {
    app.locals.broadcastSSE(evt);
    if (evt.event === 'add') {
      store.addAudit({ action: 'file_detected', target: evt.file, indicator: evt.code, details: 'تم اكتشافه تلقائيًا من مجلد الشواهد' });
    } else if (evt.event === 'remove') {
      store.addAudit({ action: 'file_deleted', target: evt.file, indicator: evt.code, details: 'أُزيل يدويًا من مجلد الشواهد' });
    }
  });

  // ── Security headers (local desktop app: content is 100% first-party). ──
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' http://localhost:* http://127.0.0.1:*; " +
      // 'wasm-unsafe-eval' is scoped to WebAssembly compilation only (not
      // general eval/Function) — needed because the PDF viewer's engine
      // decodes JPEG2000/JPX images (used by some scanners) via a WASM
      // module.
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "img-src 'self' data: blob: http://localhost:* http://127.0.0.1:*; " +
      "connect-src 'self' http://localhost:* http://127.0.0.1:*"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(express.json({ limit: '5mb' }));

  // ── Static renderer files ──
  // No-cache: this is served from an embedded, same-machine localhost server,
  // not a real network CDN, so there is no latency benefit to HTTP caching —
  // and Chromium's disk cache persists across app restarts (it survives even
  // fully quitting/reopening the app), which was causing stale app/js/*.js
  // (including the vendor pdf.js files) to keep being served after they were
  // fixed on disk. Force every request to always re-read the current file.
  app.use(express.static(paths.getAppDir(), {
    etag: false,
    lastModified: false,
    cacheControl: false,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }));

  // ── Static logo files (served from userData, writable) ──
  const logosDir = path.join(paths.getUserDataDir(), 'logos');
  fs.mkdirSync(logosDir, { recursive: true });
  app.use('/uploads/logos', express.static(logosDir));
  app.locals.logosDir = logosDir;

  // ── API routes ──
  app.use('/api/school', require('./routes/school'));
  app.use('/api/logo', require('./routes/logo'));
  app.use('/api/structure', require('./routes/structure'));
  app.use('/api/stats', require('./routes/stats'));
  app.use('/api/integrity', require('./routes/integrity'));
  app.use('/api/events', require('./routes/events'));
  app.use('/api', require('./routes/files')); // /api/files/:code, /api/file/:code/:name, /api/upload(-raw)/:code, /api/open-folder/:code
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/license', require('./routes/license'));
  app.use('/api/audit', require('./routes/audit'));
  app.use('/api/recent-views', require('./routes/recentViews'));
  app.use('/api/progress', require('./routes/progress'));
  app.use('/api', require('./routes/backup')); // POST /api/backup, GET /api/backups, GET /api/backup/download/:filename

  // ── Fallback error handler ──
  app.use((err, req, res, _next) => {
    log.error('Unhandled route error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'حدث خطأ غير متوقع في الخادم.' });
  });

  store.addAudit({ action: 'app_started', details: 'تشغيل التطبيق' });

  return app;
}

module.exports = { createApp, resolveEvidenceRoot };
