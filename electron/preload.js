'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pickFolder: function pickFolder() {
    return ipcRenderer.invoke('dialog:pickFolder');
  },
  scan: function scan(payload) {
    return ipcRenderer.invoke('fs:scan', payload);
  },
  execute: function execute(items) {
    return ipcRenderer.invoke('rename:execute', items);
  },
  history: function history() {
    return ipcRenderer.invoke('history:list');
  },
  undo: function undo(id) {
    return ipcRenderer.invoke('history:undo', { id: id });
  },
  reveal: function reveal(targetPath) {
    return ipcRenderer.invoke('shell:reveal', { path: targetPath });
  },
  resolveDrop: function resolveDrop(targetPath) {
    return ipcRenderer.invoke('fs:resolveDrop', { path: targetPath });
  },
  pathForFile: function pathForFile(file) {
    return webUtils.getPathForFile(file);
  },
  startup: function startup() {
    return ipcRenderer.invoke('app:startup');
  },
  onProgress: function onProgress(callback) {
    const listener = function listener(event, data) {
      callback(data);
    };
    ipcRenderer.on('rename:progress', listener);
    return function off() {
      ipcRenderer.removeListener('rename:progress', listener);
    };
  }
});
