const { app, BrowserWindow, ipcMain, dialog, Menu, shell, safeStorage } = require('electron');
const http = require('http');
const os = require('os');
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
  audit: [],
  settings: { schoolName: 'حضور الطلبة', lateMinutes: 10, backupKeepDays: 30, autoSchedule: false, lectureMinutes: 45, breakMinutes: 10, autoLogout: true }
};

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return { salt, hash };
}
/** تجزئة متوافقة مع الأندرويد: الملح يُفكّ من hex إلى بايتات (الحاسوب يستعمل نص الملح نفسه، فتختلف النتيجة). */
function hashPasswordPhone(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return { salt: salt.toString('hex'), hash };
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
  d.audit = d.audit || [];
  d.settings = { ...DEFAULT_DB.settings, ...(d.settings || {}) };
  if (d.users.length === 0) {
    const { salt, hash } = hashPassword('1234');
    d.users.push({ id: 'admin', username: 'admin', name: 'المدير', role: 'admin', salt, hash, createdAt: Date.now() });
    saveDb(d);
  }
  return d;
}

/** نسخة آمنة للواجهة: بدون كلمات المرور المجزّأة (salt/hash). */
function publicDb(d) {
  d.users = d.users.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.createdAt, cardUid: u.cardUid || '', canStudents: !!u.canStudents }));
  return d;
}

/** يمنع تكرار البطاقة بين الطلاب والمستخدمين. يُرجع 'student' أو 'user' أو null. */
function cardConflict(d, cards, exceptUserId) {
  for (const uid of cardsOf(cards)) {
    if (d.students.some((s) => (s.cardUid || '') === uid)) return 'student';
    if (d.users.some((u) => cardsOf(u.cardUid).includes(uid) && u.id !== exceptUserId)) return 'user';
  }
  return null;
}
const normCard = (s) => String(s || '').trim().toUpperCase();
/** بطاقات المستخدم مخزّنة نصاً مفصولة بفاصلة: يمكن لمستخدم واحد أن يملك عدة بطاقات (أكثر من أستاذ). */
const cardsOf = (s) => [...new Set(String(s || '').split(/[,;،\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
const normCards = (s) => cardsOf(s).join(',');

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
  return { ok: true, user: { id: u.id, username: u.username, name: u.name, role: u.role, canStudents: !!u.canStudents } };
});

/** الدخول ببطاقة المدرّس (للمدرّسين فقط؛ المدير يدخل بكلمة المرور). */
ipcMain.handle('auth:cardLogin', (_e, uid) => {
  const d = loadDb();
  const c = normCard(uid);
  const u = c && d.users.find((x) => cardsOf(x.cardUid).includes(c));
  if (!u) return { ok: false, reason: 'unknown' };
  if (u.role === 'admin') return { ok: false, reason: 'admin' };
  return { ok: true, user: { id: u.id, username: u.username, name: u.name, role: u.role, canStudents: !!u.canStudents } };
});

/** تأكيد عملية حذف: كلمة مرور المستخدم الحالي (أو أي مدير) أو بطاقة مدرّس. */
ipcMain.handle('auth:confirm', (_e, { userId, password, uid } = {}) => {
  const d = loadDb();
  if (uid) {
    const c = normCard(uid);
    const u = c && d.users.find((x) => cardsOf(x.cardUid).includes(c));
    return u ? { ok: true, via: 'card', name: u.name } : { ok: false };
  }
  if (!password) return { ok: false };
  const ok = d.users.some((x) => (x.id === userId || x.role === 'admin') && verifyPassword(String(password), x.salt, x.hash));
  return { ok, via: 'password' };
});

ipcMain.handle('users:list', () => {
  const d = loadDb();
  return d.users.map((u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.createdAt, cardUid: u.cardUid || '', canStudents: !!u.canStudents }));
});

ipcMain.handle('users:create', (_e, { username, password, name, role, cardUid, canStudents }) => {
  const d = loadDb();
  username = String(username || '').trim();
  if (!username || !password) return { ok: false, error: 'missing' };
  if (d.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return { ok: false, error: 'exists' };
  cardUid = normCards(cardUid);
  const cc = cardConflict(d, cardUid, '');
  if (cc) return { ok: false, error: 'card_' + cc };
  const { salt, hash } = hashPassword(password);
  d.users.push({ id: crypto.randomUUID(), username, name: name || username, role: role === 'admin' ? 'admin' : 'teacher', salt, hash, createdAt: Date.now(), cardUid, canStudents: role !== 'admin' && !!canStudents });
  saveDb(d);
  return { ok: true };
});

ipcMain.handle('users:update', (_e, { id, name, role, cardUid, canStudents }) => {
  const d = loadDb();
  const u = d.users.find((x) => x.id === id);
  if (!u) return { ok: false };
  if (name !== undefined) u.name = name;
  if (role !== undefined) u.role = role === 'admin' ? 'admin' : 'teacher';
  if (canStudents !== undefined) u.canStudents = u.role !== 'admin' && !!canStudents;
  if (cardUid !== undefined) {
    const c = normCards(cardUid);
    const cc = cardConflict(d, c, id);
    if (cc) return { ok: false, error: 'card_' + cc };
    u.cardUid = c;
  }
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

/* إصلاح توقف الإدخال بعد نوافذ alert/confirm الأصلية (خلل معروف في Electron على ويندوز) */
ipcMain.on('win:refocus', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  w.blur(); w.focus(); e.sender.focus();
});

let liveWin = null;

/* نافذة «المراحل الشاغلة» المستقلة (تُعرض على شاشة ثانية مثلاً) */
ipcMain.handle('live:open', () => {
  if (liveWin && !liveWin.isDestroyed()) { liveWin.show(); liveWin.focus(); return true; }
  liveWin = new BrowserWindow({
    width: 1100, height: 720, minWidth: 640, minHeight: 420,
    title: 'المراحل الشاغلة', backgroundColor: '#0b1026',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  liveWin.loadFile(path.join(__dirname, 'renderer', 'live-window.html'));
  liveWin.on('closed', () => { liveWin = null; });
  return true;
});
ipcMain.handle('live:pin', (e, on) => { const w = BrowserWindow.fromWebContents(e.sender); if (w) w.setAlwaysOnTop(!!on); return !!on; });
ipcMain.handle('live:full', (e) => { const w = BrowserWindow.fromWebContents(e.sender); if (!w) return false; w.setFullScreen(!w.isFullScreen()); return w.isFullScreen(); });

/* المحاضرات الجارية على هذا الحاسوب بنفس شكل /api/live في الهاتف */
ipcMain.handle('live:local', () => {
  const d = loadDb();
  const now = new Date();
  const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const fromMin = (n) => `${pad2(Math.floor(n / 60) % 24)}:${pad2(n % 60)}`;
  const len = Number(d.settings.lectureMinutes) || 45;
  const sessions = d.sessions.filter((s) => s.active).map((s) => {
    const recs = d.attendance.filter((a) => a.sessionId === s.id);
    const sched = d.schedule.find((x) => x.id === s.scheduleId);
    return {
      id: s.id, subject: s.subject, group: s.group || '', start: s.time, startTs: s.startTs,
      end: sched && sched.endTime ? sched.endTime : fromMin(toMin(s.time) + len), teacher: s.createdByName || '',
      present: recs.filter((a) => a.status === 'present').length, late: recs.filter((a) => a.status === 'late').length,
      expected: d.students.filter((st) => !s.group || st.grade === s.group).length
    };
  });
  const counts = {};
  d.students.forEach((st) => { if (st.grade) counts[st.grade] = (counts[st.grade] || 0) + 1; });
  return {
    school: d.settings.schoolName, nowTs: now.getTime(), now: fromMin(now.getHours() * 60 + now.getMinutes()),
    sessions, grades: Object.entries(counts).map(([name, count]) => ({ name, count }))
  };
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
  win.on('closed', () => { if (liveWin && !liveWin.isDestroyed()) liveWin.close(); });
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

ipcMain.handle('report:savePdf', async (_e, html, name) => {
  const r = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (r.canceled || !r.filePath) return false;
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    fs.writeFileSync(r.filePath, pdf);
    return true;
  } catch { return false; } finally { win.destroy(); }
});

ipcMain.handle('report:saveXlsx', async (_e, name, sheetName, rows, widths, boldRows) => {
  const r = await dialog.showSaveDialog({ defaultPath: name, filters: [{ name: 'Excel', extensions: ['xlsx'] }] });
  if (r.canceled || !r.filePath) return false;
  try {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = widths.map((w) => ({ wch: w }));
    ws['!views'] = [{ RTL: true }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(sheetName).slice(0, 31).replace(/[\\/?*\[\]:]/g, '-'));
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.writeFile(wb, r.filePath);
    return true;
  } catch { return false; }
});


/* ---------- التحكم بهواتف الأندرويد عبر الشبكة المحلية ---------- */
const LAN_PORT = 8765;
const lanFile = () => path.join(app.getPath('userData'), 'lan-devices.json');
function lanLoad() { try { return JSON.parse(fs.readFileSync(lanFile(), 'utf8')); } catch { return []; } }
function lanSave(list) { fs.writeFileSync(lanFile(), JSON.stringify(list, null, 2)); }
function encTok(t) {
  try { if (safeStorage.isEncryptionAvailable()) return { enc: true, v: safeStorage.encryptString(t).toString('base64') }; } catch {}
  return { enc: false, v: t };
}
function decTok(o) {
  try { return o && o.enc ? safeStorage.decryptString(Buffer.from(o.v, 'base64')) : (o ? o.v : ''); } catch { return ''; }
}
const validHost = (h) => /^[0-9A-Za-z.\-]{1,100}$/.test(String(h || ''));

function lanHttp(host, port, token, method, p, body, timeout = 6000) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = { 'X-Token': token || '' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const req = http.request({ host, port, path: p, method, timeout, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode, data: j });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'انتهت مهلة الاتصال بالجهاز' }); });
    req.on('error', () => resolve({ status: 0, error: 'تعذّر الاتصال بالجهاز (تأكد من العنوان والشبكة وتفعيل الخيار في الهاتف)' }));
    if (data) req.write(data);
    req.end();
  });
}

const isPrivateIp = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
async function lanScan() {
  const prefixes = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateIp(a.address)) prefixes.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  const found = [];
  for (const prefix of prefixes) {
    const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    let idx = 0;
    const worker = async () => {
      while (idx < hosts.length) {
        const h = hosts[idx++];
        const r = await lanHttp(h, LAN_PORT, '', 'GET', '/api/ping', null, 900);
        if (r.status === 200 && r.data && r.data.app === 'attendance-android') found.push({ host: h, port: LAN_PORT, school: r.data.school || '' });
      }
    };
    await Promise.all(Array.from({ length: 80 }, worker));
  }
  return found;
}

const lanPublic = (d) => ({ id: d.id, name: d.name, host: d.host, port: d.port });
ipcMain.handle('lan:list', () => lanLoad().map(lanPublic));
ipcMain.handle('lan:add', (_e, { name, host, port, token }) => {
  name = String(name || '').trim(); host = String(host || '').trim(); port = Number(port) || LAN_PORT; token = String(token || '').trim();
  if (!name) return { ok: false, error: 'اسم الجهاز مطلوب' };
  if (!validHost(host)) return { ok: false, error: 'عنوان IP غير صالح' };
  if (!(port > 0 && port < 65536)) return { ok: false, error: 'المنفذ غير صالح' };
  if (!/^\d{6}$/.test(token)) return { ok: false, error: 'رمز الاتصال 6 أرقام' };
  const list = lanLoad();
  if (list.some((d) => d.host === host && d.port === port)) return { ok: false, error: 'هذا الجهاز مضاف مسبقاً' };
  list.push({ id: crypto.randomBytes(6).toString('hex'), name, host, port, tok: encTok(token) });
  lanSave(list);
  return { ok: true };
});
ipcMain.handle('lan:setToken', (_e, { id, token }) => {
  if (!/^\d{6}$/.test(String(token || ''))) return { ok: false, error: 'رمز الاتصال 6 أرقام' };
  const list = lanLoad(); const d = list.find((x) => x.id === id);
  if (!d) return { ok: false, error: 'الجهاز غير موجود' };
  d.tok = encTok(String(token)); lanSave(list); return { ok: true };
});
ipcMain.handle('lan:remove', (_e, id) => { lanSave(lanLoad().filter((d) => d.id !== id)); return true; });
ipcMain.handle('lan:ping', async (_e, id) => {
  const d = lanLoad().find((x) => x.id === id);
  if (!d) return { online: false };
  const r = await lanHttp(d.host, d.port, '', 'GET', '/api/ping', null, 2500);
  return { online: r.status === 200 && !!r.data && r.data.app === 'attendance-android', school: r.data && r.data.school };
});
ipcMain.handle('lan:call', async (_e, { id, method, path: p, body }) => {
  const d = lanLoad().find((x) => x.id === id);
  if (!d) return { status: 0, error: 'الجهاز غير موجود' };
  if (!/^\/api\/(schedule(\/(save|delete|replace))?|users(\/(save|delete))?|students(\/import)?|live|report)$/.test(String(p))) return { status: 0, error: 'مسار غير مسموح' };
  return lanHttp(d.host, d.port, decTok(d.tok), method === 'POST' ? 'POST' : 'GET', p, body || null, p === '/api/report' ? 60000 : p === '/api/students/import' ? 30000 : 8000);
});
ipcMain.handle('lan:scan', () => lanScan());

/* إرسال مستخدمي الحاسوب إلى الهواتف: تُرسل التجزئة (salt/hash) الجاهزة فلا تنتقل كلمة المرور نفسها. المفتاح على الهاتف هو اسم المستخدم. */
ipcMain.handle('lan:pushUsers', async (_e, { deviceIds, userIds }) => {
  const d = loadDb();
  const users = d.users.filter((u) => (userIds || []).includes(u.id));
  const devs = lanLoad().filter((x) => (deviceIds || []).includes(x.id));
  if (!users.length || !devs.length) return { ok: false, error: 'اختر مستخدماً وهاتفاً على الأقل' };
  const results = [];
  for (const dev of devs) {
    for (const u of users) {
      const r = await lanHttp(dev.host, dev.port, decTok(dev.tok), 'POST', '/api/users/save',
        { user: { id: u.id, username: u.username, name: u.name, role: u.role, salt: u.salt, hash: u.hash, cardUid: u.cardUid || '' } }, 15000);
      const ok = r.status === 200 && r.data && r.data.ok;
      results.push({ device: dev.name, username: u.username, ok, created: ok && !!r.data.created,
        error: ok ? '' : (r.error || (r.data && r.data.error) || ('رمز ' + r.status)) });
      if (r.status === 0 || r.status === 401 || r.status === 429) {   // الجهاز غير متاح أو الرمز خاطئ: لا فائدة من تكرار المحاولة لبقية المستخدمين
        for (const rest of users.slice(users.indexOf(u) + 1)) results.push({ device: dev.name, username: rest.username, ok: false, created: false, error: results[results.length - 1].error });
        break;
      }
    }
  }
  return { ok: true, results };
});

/* إنشاء/تغيير كلمة مرور مستخدم مباشرة على الهاتف (يجزّئ الحاسوب كلمة المرور قبل الإرسال) */
ipcMain.handle('lan:phoneUser', async (_e, { id, username, name, role, password, cardUid, force }) => {
  const dev = lanLoad().find((x) => x.id === id);
  if (!dev) return { status: 0, error: 'الجهاز غير موجود' };
  const user = { username: String(username || '').trim(), name: String(name || '').trim(), role: role === 'admin' ? 'admin' : 'teacher' };
  if (password) { const h = hashPasswordPhone(String(password)); user.salt = h.salt; user.hash = h.hash; }
  if (cardUid !== undefined) user.cardUid = normCards(cardUid);
  if (force) user.force = true;
  return lanHttp(dev.host, dev.port, decTok(dev.tok), 'POST', '/api/users/save', { user }, 15000);
});

ipcMain.handle('db:load', () => publicDb(loadDb()));
// المستخدمون (وكلمات مرورهم وبطاقاتهم) تُدار فقط عبر users:* — لا نسمح للواجهة بالكتابة فوقها بنسخة قديمة
ipcMain.handle('db:save', (_e, data) => { data.users = loadDb().users; saveDb(data); return true; });
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
    return publicDb(loadDb());
  } catch {
    return null;
  }
});
