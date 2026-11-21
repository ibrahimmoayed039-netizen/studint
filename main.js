const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const DEFAULT_DB = {
  students: [],
  attendance: [],
  sessions: [],
  users: [],
  schedule: [],
  settings: { schoolName: 'حضور الطلبة', lateMinutes: 10, backupKeepDays: 30, autoSchedule: false, lectureMinutes: 45, breakMinutes: 10 }
};

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const { hash: h2 } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(h2, 'hex'), Buffer.from(hash, 'hex'));
}

const dbFile = () => path.join(app.getPath('userData'), 'attendance-data.json');
const backupsDir = () => path.join(app.getPath('userData'), 'backups');
const pad2 = (n) => String(n).padStart(2, '0');

function ensureBackupsDir() { fs.mkdirSync(backupsDir(), { recursive: true }); }

function pruneBackups(keepDays) {
  try {
    const files = fs.readdirSync(backupsDir())
      .filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort(); // lexicographic = chronological for this format
    const excess = files.length - Math.max(1, keepDays);
    for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(backupsDir(), files[i]));
  } catch {}
}

function autoBackupIfNeeded() {
  try {
    if (!fs.existsSync(dbFile())) return;
    ensureBackupsDir();
    const d = new Date();
    const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const dest = path.join(backupsDir(), `backup-${stamp}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(dbFile(), dest);
    const keepDays = (loadDb().settings || {}).backupKeepDays || 30;
    pruneBackups(keepDays);
  } catch {}
}

function loadDb() {
  let d;
  try {
    d = JSON.parse(fs.readFileSync(dbFile(), 'utf8'));
  } catch {
    d = JSON.parse(JSON.stringify(DEFAULT_DB));
  }
  d.students = d.students || [];
  d.attendance = d.attendance || [];
  d.sessions = d.sessions || [];
  d.users = d.users || [];
  d.schedule = d.schedule || [];
  d.settings = { ...DEFAULT_DB.settings, ...(d.settings || {}) };
  if (d.users.length === 0) {
    const { salt, hash } = hashPassword('1234');
    d.users.push({ id: 'admin', username: 'admin', name: 'المدير', role: 'admin', salt, hash, createdAt: Date.now() });
    saveDb(d);
  }
  return d;
}

function saveDb(data) {
  const tmp = dbFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, dbFile());
}

ipcMain.handle('students:importExcel', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Excel / CSV', extensions: ['xlsx', 'xls', 'csv'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const wb = XLSX.readFile(r.filePaths[0]);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    const pick = (row, candidates) => {
      const keys = Object.keys(row);
      for (const c of candidates) {
        const k = keys.find((x) => x.toString().trim().toLowerCase() === c);
        if (k !== undefined && String(row[k]).trim() !== '') return String(row[k]).trim();
      }
      return '';
    };
    const nameKeys = ['اسم الطالب', 'الاسم', 'اسم', 'name', 'student name', 'student'];
    const gradeKeys = ['الصف', 'الصف / الشعبة', 'الشعبة', 'grade', 'class', 'section'];
    const uidKeys = ['رقم البطاقة', 'البطاقة', 'uid', 'card', 'card uid', 'cardid', 'card id'];
    const out = rows.map((row) => ({
      name: pick(row, nameKeys),
      grade: pick(row, gradeKeys),
      cardUid: pick(row, uidKeys).toUpperCase()
    })).filter((r2) => r2.name);
    return { ok: true, rows: out };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('auth:login', (_e, username, password) => {
  const d = loadDb();
  const u = d.users.find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!u || !verifyPassword(password, u.salt, u.hash)) return { ok: false };
  return { ok: true, user: { id: u.id, username: u.username, name: u.name, role: u.role } };
});

ipcMain.handle('users:list', () => {
  const d = loadDb();
  return d.users.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.createdAt }));
});

ipcMain.handle('users:create', (_e, { username, password, name, role }) => {
  const d = loadDb();
  username = String(username || '').trim();
  if (!username || !password) return { ok: false, error: 'missing' };
  if (d.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return { ok: false, error: 'exists' };
  const { salt, hash } = hashPassword(password);
  d.users.push({ id: crypto.randomUUID(), username, name: name || username, role: role === 'admin' ? 'admin' : 'teacher', salt, hash, createdAt: Date.now() });
  saveDb(d);
  return { ok: true };
});

ipcMain.handle('users:update', (_e, { id, name, role }) => {
  const d = loadDb();
  const u = d.users.find((x) => x.id === id);
  if (!u) return { ok: false };
  if (name !== undefined) u.name = name;
  if (role !== undefined) u.role = role === 'admin' ? 'admin' : 'teacher';
  saveDb(d);
  return { ok: true };
});

ipcMain.handle('users:resetPassword', (_e, { id, password }) => {
  const d = loadDb();
  const u = d.users.find((x) => x.id === id);
  if (!u || !password) return { ok: false };
  const { salt, hash } = hashPassword(password);
  u.salt = salt; u.hash = hash;
  saveDb(d);
  return { ok: true };
});

ipcMain.handle('users:delete', (_e, id) => {
  const d = loadDb();
  if (id === 'admin') return { ok: false, error: 'cannot_delete_admin' };
  const before = d.users.length;
  d.users = d.users.filter((x) => x.id !== id);
  if (d.users.length === before) return { ok: false };
  saveDb(d);
  return { ok: true };
});

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
    autoBackupIfNeeded();
    setInterval(autoBackupIfNeeded, 60 * 60 * 1000);
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
}

ipcMain.handle('img:pick', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }]
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const filePath = r.filePaths[0];
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const MAX = 2 * 1024 * 1024; // 2MB raw cap before base64
  if (buf.length > MAX) return { error: 'large' };
  return { dataUrl: `data:image/${mime};base64,${buf.toString('base64')}` };
});

ipcMain.handle('db:load', () => loadDb());
ipcMain.handle('db:save', (_e, data) => { saveDb(data); return true; });
ipcMain.handle('db:path', () => dbFile());

ipcMain.handle('file:save', async (_e, name, content) => {
  const r = await dialog.showSaveDialog({ defaultPath: name });
  if (r.canceled) return false;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return true;
});

ipcMain.handle('backup:dir', () => backupsDir());
ipcMain.handle('backup:openFolder', () => { ensureBackupsDir(); shell.openPath(backupsDir()); return true; });

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
