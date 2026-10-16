const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pastoral', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  dataPath: () => ipcRenderer.invoke('data:path'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  confirmQuit: () => ipcRenderer.invoke('app:confirm-quit'),
  onClosing: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:closing', handler);
    return () => ipcRenderer.removeListener('app:closing', handler);
  },
  notify: (payload) => ipcRenderer.invoke('notify', payload),
  revealData: () => ipcRenderer.invoke('data:reveal'),
  exportBackup: (data) => ipcRenderer.invoke('data:export', data),

  backupList: () => ipcRenderer.invoke('backup:list'),
  backupCreate: () => ipcRenderer.invoke('backup:create'),
  backupRestore: (name) => ipcRenderer.invoke('backup:restore', name),
  backupDelete: (name) => ipcRenderer.invoke('backup:delete', name),
  backupReveal: () => ipcRenderer.invoke('backup:reveal'),

  aiStatus: (url) => ipcRenderer.invoke('ai:status', url),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  aiCancel: (requestId) => ipcRenderer.send('ai:cancel', requestId),
  onAiStream: (cb) => {
    const handler = (_evt, data) => cb(data);
    ipcRenderer.on('ai:stream', handler);
    return () => ipcRenderer.removeListener('ai:stream', handler);
  },

  aiManagerStatus: () => ipcRenderer.invoke('ai:manager-status'),
  aiInstall: (force) => ipcRenderer.invoke('ai:install', force),
  aiStart: () => ipcRenderer.invoke('ai:start'),
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  aiPull: (model) => ipcRenderer.invoke('ai:pull', model),
  aiDelete: (model) => ipcRenderer.invoke('ai:delete', model),
  aiUninstall: () => ipcRenderer.invoke('ai:uninstall'),
  onAiProgress: (cb) => {
    const handler = (_evt, data) => cb(data);
    ipcRenderer.on('ai:progress', handler);
    return () => ipcRenderer.removeListener('ai:progress', handler);
  }
});
