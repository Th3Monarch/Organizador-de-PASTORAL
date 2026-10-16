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

  aiCloudChat: (payload) => ipcRenderer.invoke('ai:cloud:chat', payload),
  aiCloudTest: (payload) => ipcRenderer.invoke('ai:cloud:test', payload),
  aiCloudModels: (payload) => ipcRenderer.invoke('ai:cloud:models', payload),
  aiCancel: (requestId) => ipcRenderer.send('ai:cancel', requestId),
  onAiStream: (cb) => {
    const handler = (_evt, data) => cb(data);
    ipcRenderer.on('ai:stream', handler);
    return () => ipcRenderer.removeListener('ai:stream', handler);
  }
});
