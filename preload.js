const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('db:load'),
  save: (d) => ipcRenderer.invoke('db:save', d),
  dataPath: () => ipcRenderer.invoke('db:path'),
  saveFile: (name, content) => ipcRenderer.invoke('file:save', name, content),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import')
});
