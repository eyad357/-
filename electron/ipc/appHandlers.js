'use strict';

const { ipcMain, app } = require('electron');

function registerAppHandlers() {
  ipcMain.handle('app:getVersion', () => app.getVersion());
}

module.exports = { registerAppHandlers };
