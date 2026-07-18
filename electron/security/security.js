'use strict';

const path = require('path');
const log = require('../utils/logger');

/** Secure BrowserWindow webPreferences, shared by every window the app creates. */
function secureWebPreferences(preloadPath) {
  return {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    spellcheck: false,
    devTools: !isProd(),
  };
}

function isProd() {
  return require('electron').app.isPackaged;
}

/**
 * Blocks the common ways a curious user could pop DevTools open on a
 * production build: F12, Ctrl/Cmd+Shift+I, Ctrl/Cmd+Shift+J, Ctrl/Cmd+Shift+C,
 * and the right-click "Inspect Element" context menu entry.
 */
function hardenWindow(win) {
  if (!isProd()) return; // leave devtools fully available in development

  win.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const blockedCombo =
      key === 'f12' ||
      ((input.control || input.meta) && input.shift && ['i', 'j', 'c'].includes(key)) ||
      ((input.control || input.meta) && key === 'r' && input.shift); // hard reload
    if (blockedCombo) event.preventDefault();
  });

  win.webContents.on('devtools-opened', () => {
    win.webContents.closeDevTools();
  });

  win.webContents.on('context-menu', (event) => {
    event.preventDefault(); // disables right-click "Inspect" in production
  });

  // Never allow the renderer to navigate to, or open, an external/remote URL.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1')) {
      event.preventDefault();
      log.warn('Blocked renderer navigation to', url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    log.warn('Blocked window.open to', url);
    return { action: 'deny' };
  });
}

module.exports = { secureWebPreferences, hardenWindow, isProd };
