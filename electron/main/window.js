'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const windowStateKeeper = require('electron-window-state');
const { secureWebPreferences, hardenWindow } = require('../security/security');
const log = require('../utils/logger');

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 480,
    height: 320,
    frame: false,
    resizable: false,
    movable: true,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  splash.loadFile(path.join(__dirname, '..', '..', 'splash', 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
  return splash;
}

function createMainWindow(preloadPath) {
  const savedState = windowStateKeeper({
    defaultWidth: 1280,
    defaultHeight: 800,
  });

  const win = new BrowserWindow({
    x: savedState.x,
    y: savedState.y,
    width: savedState.width,
    height: savedState.height,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0a3d6b',
    autoHideMenuBar: false,
    icon: process.platform === 'linux' ? path.join(__dirname, '..', '..', 'build', 'icon.png') : undefined,
    webPreferences: secureWebPreferences(preloadPath),
  });

  savedState.manage(win);
  hardenWindow(win);

  win.on('close', () => {
    try { savedState.saveState(win); } catch (err) { log.warn('Failed to save window state:', err.message); }
  });

  return win;
}

module.exports = { createSplashWindow, createMainWindow };
