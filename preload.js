const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  login: (username, password) => ipcRenderer.invoke('auth:login', username, password),
  usersList: () => ipcRenderer.invoke('users:list'),
  userCreate: (payload) => ipcRenderer.invoke('users:create', payload),
  userUpdate: (payload) => ipcRenderer.invoke('users:update', payload),
  userResetPassword: (payload) => ipcRenderer.invoke('users:resetPassword', payload),
  userDelete: (id) => ipcRenderer.invoke('users:delete', id),
  pickImage: () => ipcRenderer.invoke('img:pick'),
  importStudentsExcel: () => ipcRenderer.invoke('students:importExcel'),
  load: () => ipcRenderer.invoke('db:load'),
  save: (d) => ipcRenderer.invoke('db:save', d),
  dataPath: () => ipcRenderer.invoke('db:path'),
  saveFile: (name, content) => ipcRenderer.invoke('file:save', name, content),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  backupsDir: () => ipcRenderer.invoke('backup:dir'),
  openBackupsFolder: () => ipcRenderer.invoke('backup:openFolder'),
  importBackup: () => ipcRenderer.invoke('backup:import')
});
