const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pastoral', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  dataPath: () => ipcRenderer.invoke('data:path'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  revealData: () => ipcRenderer.invoke('data:reveal'),
  exportBackup: (data) => ipcRenderer.invoke('data:export', data),

  backupList: () => ipcRenderer.invoke('backup:list'),
  backupCreate: () => ipcRenderer.invoke('backup:create'),
  backupRestore: (name) => ipcRenderer.invoke('backup:restore', name),
  backupDelete: (name) => ipcRenderer.invoke('backup:delete', name),
  backupReveal: () => ipcRenderer.invoke('backup:reveal'),

  aiStatus: (url) => ipcRenderer.invoke('ai:status', url),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),

  aiManagerStatus: () => ipcRenderer.invoke('ai:manager-status'),
  aiInstall: (force) => ipcRenderer.invoke('ai:install', force),
  aiStart: () => ipcRenderer.invoke('ai:start'),
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  aiPull: (model) => ipcRenderer.invoke('ai:pull', model),
  aiUninstall: () => ipcRenderer.invoke('ai:uninstall'),
  onAiProgress: (cb) => {
    const handler = (_evt, data) => cb(data);
    ipcRenderer.on('ai:progress', handler);
    return () => ipcRenderer.removeListener('ai:progress', handler);
  }
});
