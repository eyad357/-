'use strict';

const path = require('path');
const http = require('http');
const { app, BrowserWindow, dialog } = require('electron');

const log = require('../utils/logger');
const paths = require('../utils/paths');
const { createSplashWindow, createMainWindow } = require('./window');
const { buildMenu } = require('./menu');
const { registerDialogHandlers } = require('../ipc/dialogHandlers');
const { registerAppHandlers } = require('../ipc/appHandlers');
const autoBackup = require('../utils/autoBackup');

const PREFERRED_PORTS = [3000, 3210, 4820, 5175, 0]; // 0 = ask the OS for any free port
const PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'preload.js');

let mainWindow = null;
let splashWindow = null;
let httpServer = null;
let expressApp = null;
let activePort = null;

// ── Single instance lock: focus the existing window instead of opening a second one. ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap).catch((err) => {
    log.error('Fatal startup error:', err);
    dialog.showErrorBox('خطأ في بدء التشغيل', String(err && err.message ? err.message : err));
    app.quit();
  });
}

async function bootstrap() {
  registerDialogHandlers();
  registerAppHandlers();

  splashWindow = createSplashWindow();

  try {
    await startServer();
  } catch (err) {
    log.error('Failed to start embedded server:', err);
    dialog.showErrorBox(
      'تعذر تشغيل الخادم الداخلي',
      `تعذر إيجاد منفذ متاح لتشغيل التطبيق. أغلق أي برامج أخرى قد تستخدم المنفذ 3000 ثم أعد المحاولة.\n\n${err.message}`
    );
    app.quit();
    return;
  }

  mainWindow = createMainWindow(PRELOAD_PATH);
  setupMenu(mainWindow);
  mainWindow.loadURL(`http://127.0.0.1:${activePort}`);

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    log.error('Renderer failed to load:', code, desc);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('Renderer process gone:', details.reason);
    dialog.showErrorBox('توقف واجهة البرنامج', 'حدث خطأ غير متوقع، سيتم إعادة تحميل البرنامج.');
    mainWindow.loadURL(`http://127.0.0.1:${activePort}`);
  });

  autoBackup.schedule(expressApp);
}

function setupMenu(win) {
  const { Menu } = require('electron');
  Menu.setApplicationMenu(buildMenu(win));
}

async function startServer() {
  const { createApp } = require('../../server/app');
  expressApp = await createApp();

  for (const port of PREFERRED_PORTS) {
    try {
      await listenOn(port);
      activePort = httpServer.address().port;
      log.info(`Embedded server listening on http://127.0.0.1:${activePort}`);
      return;
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        log.warn(`Port ${port || '(auto)'} is in use, trying the next one...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('تعذر إيجاد أي منفذ متاح لتشغيل الخادم.');
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(expressApp);
    server.once('error', (err) => {
      server.removeAllListeners();
      reject(err);
    });
    server.listen(port, '127.0.0.1', () => {
      httpServer = server;
      resolve();
    });
  });
}

app.on('window-all-closed', () => {
  if (httpServer) httpServer.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) bootstrap();
});

// Run the "backup on exit" setting exactly once, before the app actually quits.
let exitBackupDone = false;
app.on('before-quit', async (event) => {
  const shouldBackup = expressApp && expressApp.locals.store.settings.backup_on_exit === 'true';
  if (shouldBackup && !exitBackupDone) {
    event.preventDefault();
    exitBackupDone = true;
    await autoBackup.backupOnExit(expressApp);
    app.quit();
  }
});
