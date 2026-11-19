const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULT_DB = {
  students: [],
  attendance: [],
  sessions: [],
  settings: { schoolName: 'حضور الطلبة', lateMinutes: 10 }
};

const dbFile = () => path.join(app.getPath('userData'), 'attendance-data.json');

function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(dbFile(), 'utf8'));
    return {
      students: d.students || [],
      attendance: d.attendance || [],
      sessions: d.sessions || [],
      settings: { ...DEFAULT_DB.settings, ...(d.settings || {}) }
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

function saveDb(data) {
  const tmp = dbFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, dbFile());
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'حضور الطلبة',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
}

ipcMain.handle('db:load', () => loadDb());
ipcMain.handle('db:save', (_e, data) => { saveDb(data); return true; });
ipcMain.handle('db:path', () => dbFile());

ipcMain.handle('file:save', async (_e, name, content) => {
  const r = await dialog.showSaveDialog({ defaultPath: name });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return true;
});

ipcMain.handle('backup:export', async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const r = await dialog.showSaveDialog({
    defaultPath: `attendance-backup-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled) return false;
  fs.copyFileSync(dbFile(), r.filePath);
  return true;
});

ipcMain.handle('backup:import', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  if (r.canceled) return null;
  try {
    const d = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!Array.isArray(d.students) || !Array.isArray(d.attendance)) return null;
    d.sessions = d.sessions || [];
    saveDb(d);
    return loadDb();
  } catch {
    return null;
  }
});
