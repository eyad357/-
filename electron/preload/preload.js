'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Everything exposed here is reachable from the renderer's `window.electronAPI`.
 * Keep this surface tiny and specific — never expose ipcRenderer itself,
 * fs, or any other raw Node API to the renderer.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openDirectory', options),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),
});
