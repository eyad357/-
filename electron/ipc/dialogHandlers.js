'use strict';

const { ipcMain, dialog, BrowserWindow } = require('electron');

function registerDialogHandlers() {
  ipcMain.handle('dialog:openDirectory', async (event, options = {}) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, {
      properties: options.properties || ['openDirectory'],
      title: options.title || 'اختر مجلدًا',
    });
    return result;
  });
}

module.exports = { registerDialogHandlers };
