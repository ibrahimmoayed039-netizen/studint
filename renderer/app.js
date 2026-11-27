const $ = (s) => document.querySelector(s);
/* بعد إغلاق alert/confirm الأصلية يفقد Electron تركيز النافذة فتتوقف الحقول عن استقبال الإدخال؛ نعيد التركيز يدوياً. */
(() => {
  const nativeAlert = window.alert.bind(window), nativeConfirm = window.confirm.bind(window);
  const fix = () => { try { api.refocus(); } catch {} setTimeout(() => { try { api.refocus(); } catch {} }, 60); };
  window.alert = (m) => { nativeAlert(m); fix(); };
  window.confirm = (m) => { const r = nativeConfirm(m); fix(); return r; };
})();
let db = { students: [], attendance: [], sessions: [], users: [], schedule: [], settings: {} };
let currentUser = null;
const isAdmin = () => currentUser && currentUser.role === 'admin';
const canStudents = () => !!currentUser && (currentUser.role === 'admin' || !!currentUser.canStudents);
const myStudents = () => isAdmin() ? db.students : db.students.filter((s) => s.createdBy === currentUser.id);
const canEditStudent = (s) => isAdmin() || (canStudents() && s.createdBy === currentUser.id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const normUid = (s) => String(s || '').trim().toUpperCase();
/** بطاقات المستخدم: عدة أرقام مفصولة بفاصلة */
const cardsOf = (s) => [...new Set(String(s || '').split(/[,;،\s]+/).map((x) => x.trim().toUpperCase()).filter(Boolean))];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const persist = () => api.save(db);
/* ---------- سجل التدقيق ---------- */
const AUDIT_KEEP_DAYS = 3;   // يُحذف سجل التدقيق تلقائياً بعد 3 أيام
function purgeOldAudit() {
  const cutoff = Date.now() - AUDIT_KEEP_DAYS * 86400000;
  const n = (db.audit || []).length;
  db.audit = (db.audit || []).filter((e) => e.ts >= cutoff);
  return n - db.audit.length;
}
function audit(action, detail) {
  db.audit = db.audit || [];
  purgeOldAudit();
  db.audit.push({ id: uid(), ts: Date.now(), userId: currentUser ? currentUser.id : '', userName: currentUser ? currentUser.name : 'النظام', action, detail: detail || '' });
  if (db.audit.length > 5000) db.audit.splice(0, db.audit.length - 5000);
  persist();
}
const activeSession = () => currentUser ? db.sessions.find((s) => s.active && (isAdmin() || s.createdBy === currentUser.id)) : undefined;
const visibleSessions = (list) => isAdmin() ? list : list.filter((s) => s.createdBy === currentUser.id);
const sessionLabel = (s) => `${s.subject} — ${s.time.slice(0, 5)}${s.group ? ' (' + s.group + ')' : ''}`;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}
function beep(freq, ms) {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(); o.frequency.value = freq; o.connect(c.destination);
    o.start(); setTimeout(() => { o.stop(); c.close(); }, ms);
  } catch {}
}
function csvDownload(name, rows) {
  const csv = '\ufeff' + rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  api.saveFile(name, csv).then((ok) => ok && toast('تم حفظ الملف'));
}
const statusBadge = (s) => s === 'late'
  ? '<span class="badge late">متأخر</span>'
  : '<span class="badge present">حاضر</span>';

/* ---------- التبويبات ---------- */
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(name) {
  const allowed = isAdmin() ? ['scan', 'schedule', 'students', 'log', 'reports', 'users', 'live', 'pull', 'devices', 'audit', 'settings'] : ['scan', 'schedule', ...(canStudents() ? ['students'] : []), 'log', 'reports'];
  if (!allowed.includes(name)) name = 'scan';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === name));
  if (name === 'scan') { renderScan(); focusScan(); }
  if (name === 'schedule') renderSchedule();
  if (name === 'students') renderStudents();
  if (name === 'log') renderLog();
  if (name === 'reports') renderReports();
  if (name === 'users') renderUsers();
  if (name === 'live' && typeof renderLive === 'function') renderLive();
  if (name === 'pull' && typeof renderPull === 'function') renderPull();
  if (name === 'devices' && typeof renderDevices === 'function') renderDevices();
  if (name === 'audit') renderAudit();
  if (name === 'settings') renderSettings();
}
function applyRoleNav() {
  document.querySelectorAll('.tab').forEach((btn) => {
    const roles = (btn.dataset.roles || '').split(',');
    btn.hidden = !roles.includes(currentUser.role) || (btn.dataset.tab === 'students' && !canStudents());
  });
  $('#whoAmI').textContent = `${currentUser.name} (${currentUser.role === 'admin' ? 'مدير' : 'مدرّس'})`;
}
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('ar-EG'); }, 1000);

/* ---------- إحصاءات المحاضرة ---------- */
function sessionStats(ses) {
  const studs = db.students.filter((s) => !ses.group || s.grade === ses.group);
  const recs = db.attendance.filter((a) => a.sessionId === ses.id);
  const attended = new Set(recs.map((a) => a.studentId));
  return {
    recs,
    present: recs.filter((a) => a.status === 'present').length,
    late: recs.filter((a) => a.status === 'late').length,
    absent: studs.filter((s) => !attended.has(s.id))
  };
}

function statusFor(ses) {
  const mins = (Date.now() - ses.startTs) / 60000;
  return mins > ses.lateMin ? 'late' : 'present';
}

function record(ses, student, status, manual) {
  const rec = {
    id: uid(), sessionId: ses.id, subject: ses.subject, studentId: student.id,
    studentName: student.name, grade: student.grade,
    date: ses.date, time: nowTime(), status, manual: !!manual
  };
  db.attendance.push(rec);
  if (manual) audit('حضور يدوي', `${student.name} — ${ses.subject} ${ses.date}`);
  persist();
  return rec;
}

/* ---------- المحاضرة والمسح ---------- */
function fillGroups() {
  const sel = $('#sesGroup'); const cur = sel.value;
  const grades = [...new Set(db.students.map((s) => s.grade))].sort();
  sel.innerHTML = '<option value="">كل الطلاب</option>' + grades.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
}

$('#noSession').addEventListener('submit', (e) => {
  e.preventDefault();
  const d = new Date();
  db.sessions.push({
    id: uid(), subject: $('#sesSubject').value.trim(), group: $('#sesGroup').value,
    lateMin: Number($('#sesLate').value) || 0, date: todayStr(), time: nowTime(),
    startTs: d.getTime(), active: true,
    createdBy: currentUser.id, createdByName: currentUser.name
  });
  audit('بدء محاضرة', $('#sesSubject').value.trim() + ($('#sesGroup').value ? ` (${$('#sesGroup').value})` : ''));
  persist(); $('#sesSubject').value = ''; renderScan(); focusScan(); autoOpenReceive();
});

$('#sesEnd').addEventListener('click', () => {
  const ses = activeSession(); if (!ses) return;
  const { absent } = sessionStats(ses);
  if (!confirm(`إنهاء المحاضرة؟ عدد من لم يحضر: ${absent.length}`)) return;
  ses.active = false; ses.endTime = nowTime();
  audit('إنهاء محاضرة', ses.subject);
  persist(); renderScan();
  // نهاية الحصة: تسجيل خروج حتى لا يتمكن أحد من العبث بالبيانات
  if (db.settings.autoLogout !== false) doLogout(true);
});


/* ---------- وضع ملء الشاشة للمسح ---------- */
let kioskTimer = null;
const KIOSK_ICONS = { idle: '📇', ok: '✓', late: '⏰', dup: '↺', bad: '✕' };
function kioskOn() { return !$('#kiosk').hidden; }
function updateKiosk() {
  const ses = activeSession(); if (!ses || !kioskOn()) return;
  $('#kSchool').textContent = db.settings.schoolName || 'حضور الطلبة';
  $('#kSubject').textContent = ses.subject;
  $('#kMeta').textContent = `${ses.group || 'كل الطلاب'} — بدأت ${ses.time.slice(0, 5)}`;
  const st = sessionStats(ses);
  $('#kPresent').textContent = st.present; $('#kLate').textContent = st.late; $('#kAbsent').textContent = st.absent.length;
  updateKioskLive();
}
function kioskIdle() {
  const k = $('#kiosk'); k.dataset.state = 'idle';
  $('#kPhoto').hidden = true; $('#kPhoto').removeAttribute('src');
  $('#kIcon').hidden = false; $('#kIcon').textContent = KIOSK_ICONS.idle;
  $('#kName').textContent = 'مرّر بطاقتك على القارئ'; $('#kSub').textContent = '';
}
function kioskShow(cls, title, sub, photo) {
  if (!kioskOn()) return;
  const k = $('#kiosk'); k.dataset.state = cls;
  $('#kName').textContent = title; $('#kSub').textContent = sub || '';
  if (photo) { $('#kPhoto').src = photo; $('#kPhoto').hidden = false; $('#kIcon').hidden = true; }
  else { $('#kPhoto').hidden = true; $('#kPhoto').removeAttribute('src'); $('#kIcon').hidden = false; $('#kIcon').textContent = KIOSK_ICONS[cls] || '📇'; }
  k.classList.remove('flash'); void k.offsetWidth; k.classList.add('flash');
  clearTimeout(kioskTimer); kioskTimer = setTimeout(kioskIdle, 4000);
}
function enterKiosk() {
  if (!activeSession()) return;
  $('#kiosk').hidden = false; document.body.classList.add('kiosk-on');
  kioskIdle(); updateKiosk();
  try { const p = document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch {}
  focusScan();
}
function exitKiosk() {
  if (!kioskOn()) return;
  clearTimeout(kioskTimer);
  $('#kiosk').hidden = true; document.body.classList.remove('kiosk-on');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  focusScan();
}
/** لحظة بدء أي حصة (يدوي أو تلقائي من الجدول) تُفتح شاشة استقبال البطاقات تلقائياً. */
function autoOpenReceive() {
  if (db.settings.autoReceive === false || !activeSession() || kioskOn()) return;
  enterKiosk();
}
/** المهلة المتبقية قبل احتساب التأخير + آخر الطلاب المسجّلين (تُحدَّث كل ثانية). */
function updateKioskLive() {
  const ses = activeSession(); if (!ses || !kioskOn()) return;
  const left = (ses.lateMin || 0) - Math.floor((Date.now() - ses.startTs) / 60000);
  $('#kLateLeft').textContent = left > 0 ? `⏳ باقي ${left} د قبل احتساب التأخير` : '⏰ انتهت مهلة الحضور — التسجيل الآن «متأخر»';
  $('#kLateLeft').classList.toggle('warn', left <= 0);
  const recent = sessionStats(ses).recs.slice(-4).reverse().map((a) => a.studentName).join(' • ');
  $('#kRecent').textContent = recent ? `آخر المسجّلين: ${recent}` : '';
}
$('#kioskBtn').addEventListener('click', enterKiosk);
$('#kExit').addEventListener('click', exitKiosk);
document.addEventListener('keydown', (e) => { if (e.key !== 'Escape') return; if (!$('#authModal').hidden) { closeAuth(false); return; } if (!$('#picker').hidden) { closePicker(); return; } exitKiosk(); });
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) exitKiosk(); });
setInterval(() => { if (kioskOn()) { $('#kClock').textContent = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }); updateKioskLive(); } }, 1000);


/* ---------- حضور يدوي لمن نسي بطاقته ---------- */
function renderManual() {
  const ses = activeSession(); if (!ses) return;
  const q = $('#manSearch').value.trim().toLowerCase();
  const attended = new Set(db.attendance.filter((a) => a.sessionId === ses.id).map((a) => a.studentId));
  const pool = db.students.filter((st) => (!ses.group || st.grade === ses.group) && !attended.has(st.id)
    && (!q || st.name.toLowerCase().includes(q) || String(st.grade).toLowerCase().includes(q)));
  const shown = pool.slice(0, 6);
  $('#manList').innerHTML = shown.length
    ? shown.map((st) => `<div class="man-item">
        ${st.photo ? `<img class="thumb" src="${esc(st.photo)}" alt="">` : '<span class="thumb ph">👤</span>'}
        <div><b>${esc(st.name)}</b><span>${esc(st.grade)}</span></div>
        <button class="btn sm primary" data-id="${st.id}">✓ تسجيل حاضر</button></div>`).join('')
      + (pool.length > shown.length ? `<p class="hint">يُعرض ${shown.length} من ${pool.length} — اكتب للبحث</p>` : '')
    : `<p class="empty">${q ? 'لا توجد نتائج' : 'كل الطلاب مسجّلون ✅'}</p>`;
}
$('#manSearch').addEventListener('input', renderManual);
$('#manSearch').addEventListener('blur', () => setTimeout(focusScan, 150));
$('#manList').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const ses = activeSession(); if (!ses) return;
  const st = db.students.find((x) => x.id === b.dataset.id); if (!st) return;
  if (db.attendance.some((a) => a.sessionId === ses.id && a.studentId === st.id)) return renderManual();
  const status = statusFor(ses);
  record(ses, st, status, true);
  beep(status === 'late' ? 600 : 900, 180);
  showResult(status === 'late' ? 'late' : 'ok', st.name, `${st.grade} — ${status === 'late' ? 'متأخر' : 'حضور يدوي'}`, st.photo);
  toast(`تم تسجيل ${st.name} يدوياً`);
  renderScan();
});

/* ---------- اختيار طالب عشوائي من الحاضرين ---------- */
const pickedBy = {};
let pickTimer = null;
function presentPool(ses) {
  return db.attendance.filter((a) => a.sessionId === ses.id).map((a) => {
    const st = db.students.find((x) => x.id === a.studentId);
    return { id: a.studentId, name: st ? st.name : a.studentName, grade: st ? st.grade : a.grade, photo: st ? st.photo : '' };
  });
}
function closePicker() { clearTimeout(pickTimer); $('#picker').hidden = true; focusScan(); }
function runPicker() {
  const ses = activeSession(); if (!ses) return;
  const all = presentPool(ses);
  if (!all.length) return toast('لا يوجد طلاب حاضرون بعد');
  const done = pickedBy[ses.id] || (pickedBy[ses.id] = []);
  let pool = all.filter((s) => !done.includes(s.id));
  if (!pool.length) { done.length = 0; pool = all; }
  const winner = pool[Math.floor(Math.random() * pool.length)];
  done.push(winner.id);
  const box = $('#picker'); box.hidden = false; clearTimeout(pickTimer);
  const card = box.querySelector('.p-card'); card.classList.remove('final'); card.classList.add('spin');
  $('#pPhoto').hidden = true; $('#pIcon').hidden = false; $('#pIcon').textContent = '🎲'; $('#pSub').textContent = '';
  $('#pAgain').disabled = true;
  let step = 0; const steps = 22;
  (function tick() {
    if (step >= steps) {
      card.classList.remove('spin'); card.classList.add('final');
      $('#pName').textContent = winner.name; $('#pSub').textContent = winner.grade + (all.length > 1 ? ` — متبقٍ ${pool.length - 1} لم يُختاروا` : '');
      if (winner.photo) { $('#pPhoto').src = winner.photo; $('#pPhoto').hidden = false; $('#pIcon').hidden = true; }
      else { $('#pIcon').textContent = '🎉'; }
      beep(880, 220); $('#pAgain').disabled = false; return;
    }
    $('#pName').textContent = all[Math.floor(Math.random() * all.length)].name;
    $('#pName').classList.remove('tick'); void $('#pName').offsetWidth; $('#pName').classList.add('tick');
    beep(300 + step * 20, 40);
    step++; pickTimer = setTimeout(tick, 60 + step * step * 0.55);
  })();
}
$('#pickBtn').addEventListener('click', runPicker);
$('#kPick').addEventListener('click', runPicker);
$('#pAgain').addEventListener('click', runPicker);
$('#pClose').addEventListener('click', closePicker);

function focusScan() { setTimeout(() => { if (activeSession() && !$('#manSearch').matches(':focus') && $('#picker').hidden && $('#authModal').hidden) $('#scanInput').focus(); }, 50); }
$('#scanInput').addEventListener('blur', () => {
  if ($('#scan').classList.contains('active')) focusScan();
});
$('#scanInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = normUid(e.target.value);
  e.target.value = '';
  if (v) handleScan(v);
});

function showResult(cls, title, sub, photo) {
  kioskShow(cls, title, sub, photo);
  const r = $('#scanResult');
  r.className = 'result ' + cls;
  const img = $('#scanPhoto');
  if (photo) { img.src = photo; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  $('#scanText').innerHTML = `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
}

function handleScan(cardUid) {
  const ses = activeSession(); if (!ses) return;
  const st = db.students.find((s) => s.cardUid === cardUid);
  if (!st) { beep(220, 400); return showResult('bad', 'بطاقة غير مسجلة', 'رقم البطاقة: ' + cardUid); }
  if (ses.group && st.grade !== ses.group) {
    beep(220, 400);
    return showResult('bad', st.name, `ليس من مجموعة هذه المحاضرة (${ses.group})`, st.photo);
  }
  const already = db.attendance.find((a) => a.sessionId === ses.id && a.studentId === st.id);
  if (already) { beep(500, 200); return showResult('dup', st.name, `سُجّل مسبقاً في هذه المحاضرة الساعة ${already.time.slice(0, 5)}`, st.photo); }
  const status = statusFor(ses);
  record(ses, st, status);
  beep(status === 'late' ? 600 : 900, 180);
  showResult(status === 'late' ? 'late' : 'ok', st.name, `${st.grade} — ${status === 'late' ? 'متأخر' : 'تم تسجيل الحضور'}`, st.photo);
  renderScan();
}

function renderScan() {
  const ses = activeSession();
  $('#noSession').hidden = !!ses;
  $('#activeSession').hidden = !ses;
  if (!ses) {
    exitKiosk();
    fillGroups(); $('#sesLate').value = db.settings.lateMinutes ?? 10;
    renderTodaySchedule(); renderBreak();
    return;
  }
  $('#todaySchedule').hidden = true; $('#breakBanner').hidden = true;
  updateKiosk(); renderManual();
  $('#sesTitle').textContent = ses.subject;
  $('#sesMeta').textContent = `بدأت ${ses.time.slice(0, 5)} — ${ses.group || 'كل الطلاب'} — التأخير بعد ${ses.lateMin} دقيقة`;
  const { recs, present, late, absent } = sessionStats(ses);
  $('#stPresent').textContent = present; $('#stLate').textContent = late; $('#stAbsent').textContent = absent.length;
  const recent = recs.slice(-10).reverse();
  $('#recentBody').innerHTML = recent.length
    ? recent.map((a) => `<tr><td>${a.time.slice(0, 5)}</td><td>${esc(a.studentName)}</td><td>${esc(a.grade)}</td><td>${statusBadge(a.status)}${a.manual ? ' <span class="badge manual">يدوي</span>' : ''}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">لم يسجل أحد بعد</td></tr>';
}

/* ---------- الجدول الأسبوعي ---------- */
const DAY_NAMES = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const myScheduleOf = () => db.schedule.filter((s) => s.ownerId === currentUser.id);

/* ---------- أدوات الوقت والتشغيل التلقائي ---------- */
const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
const fromMin = (n) => { n = ((n % 1440) + 1440) % 1440; return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`; };
const lectureLen = () => Number(db.settings.lectureMinutes) || 45;
const breakLen = () => Number(db.settings.breakMinutes) >= 0 ? Number(db.settings.breakMinutes) : 10;
const entryEnd = (s) => s.endTime || fromMin(toMin(s.time) + lectureLen());
const todayList = () => myScheduleOf().filter((s) => s.day === new Date().getDay()).sort((a, b) => a.time.localeCompare(b.time));
const myActive = () => currentUser ? db.sessions.find((s) => s.active && s.createdBy === currentUser.id) : undefined;

function suggestTime() {
  if ($('#scId').value || $('#scTime').value) return;
  const day = Number($('#scDay').value);
  const same = myScheduleOf().filter((s) => s.day === day).sort((a, b) => a.time.localeCompare(b.time));
  if (!same.length) return;
  const last = same[same.length - 1];
  $('#scTime').value = fromMin(toMin(entryEnd(last)) + breakLen());
}
function resetScheduleForm() {
  $('#scheduleForm').reset(); $('#scId').value = ''; $('#scLate').value = 10; $('#scAuto').checked = true;
  suggestTime();
}
$('#scDay').addEventListener('change', () => { if (!$('#scId').value) { $('#scTime').value = ''; suggestTime(); } });

function renderBreak() {
  const box = $('#breakBanner');
  if (!currentUser || !db.settings.autoSchedule || activeSession()) { box.hidden = true; return; }
  const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
  const list = todayList().filter((s) => s.auto !== false);
  const prev = list.filter((s) => toMin(entryEnd(s)) <= nm).pop();
  const next = list.find((s) => toMin(s.time) > nm);
  if (!next) { box.hidden = true; return; }
  const wait = toMin(next.time) - nm;
  box.hidden = false;
  box.innerHTML = prev
    ? `<span class="ic">☕</span><div><b>استراحة</b><span>تنتهي بعد ${wait} دقيقة — المحاضرة القادمة «${esc(next.subject)}» الساعة ${next.time}</span></div>`
    : `<span class="ic">⏳</span><div><b>المحاضرة القادمة: ${esc(next.subject)}</b><span>تبدأ تلقائياً الساعة ${next.time} (بعد ${wait} دقيقة)</span></div>`;
}

function autoTick() {
  if (!currentUser || !db.settings.autoSchedule) { renderBreak(); return; }
  const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
  let changed = false, started = false, ended = false;
  // إنهاء تلقائي
  db.sessions.forEach((ses) => {
    if (!(ses.active && ses.createdBy === currentUser.id && ses.autoEnd && ses.scheduleId)) return;
    const e = db.schedule.find((x) => x.id === ses.scheduleId); if (!e) return;
    if (ses.date !== todayStr() || nm >= toMin(entryEnd(e))) {
      ses.active = false; ses.endTime = entryEnd(e) + ':00'; changed = true; ended = true;
      audit('إنهاء محاضرة تلقائياً', ses.subject);
      toast(`انتهت محاضرة «${ses.subject}» تلقائياً`);
    }
  });
  if (ended && db.settings.autoLogout !== false) { persist(); doLogout(true); return; }
  // بدء تلقائي
  if (!myActive()) {
    const cand = todayList().find((s) => s.auto !== false && nm >= toMin(s.time) && nm < toMin(entryEnd(s))
      && !db.sessions.some((x) => x.scheduleId === s.id && x.date === todayStr()));
    if (cand) {
      const startTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(toMin(cand.time) / 60), toMin(cand.time) % 60).getTime();
      db.sessions.push({
        id: uid(), subject: cand.subject, group: cand.group, lateMin: cand.lateMin,
        date: todayStr(), time: cand.time + ':00', startTs, active: true, autoEnd: true,
        createdBy: currentUser.id, createdByName: currentUser.name, scheduleId: cand.id
      });
      changed = true; started = true; toast(`بدأت محاضرة «${cand.subject}» تلقائياً`);
    }
  }
  if (changed) { persist(); renderScan(); if ($('#scan').classList.contains('active')) focusScan(); if (started) autoOpenReceive(); }
  else renderBreak();
}
setInterval(autoTick, 15000);
$('#scCancel').addEventListener('click', resetScheduleForm);

function fillScheduleGroups() {
  const sel = $('#scGroup'); const cur = sel.value;
  const grades = [...new Set(db.students.map((s) => s.grade))].sort();
  sel.innerHTML = '<option value="">كل الطلاب</option>' + grades.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
}

$('#scheduleForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#scId').value;
  const entry = {
    day: Number($('#scDay').value), subject: $('#scSubject').value.trim(),
    group: $('#scGroup').value, time: $('#scTime').value,
    lateMin: Number($('#scLate').value) || 0,
    endTime: $('#scEnd').value || '', auto: $('#scAuto').checked
  };
  if (entry.endTime && toMin(entry.endTime) <= toMin(entry.time)) return toast('وقت الانتهاء يجب أن يكون بعد وقت البدء');
  const dayN = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
  const what = (e) => `${dayN[Number(e.day)] || ''} ${e.time} — ${e.subject}`;
  if (id) {
    const cur = db.schedule.find((s) => s.id === id);
    const before = what(cur);
    Object.assign(cur, entry);
    audit('تعديل حصة', before === what(cur) ? before : `${before} ← ${what(cur)}`);
  } else {
    db.schedule.push({ id: uid(), ownerId: currentUser.id, ownerName: currentUser.name, ...entry });
    audit('إضافة حصة', what(entry));
  }
  persist(); resetScheduleForm(); renderSchedule(); toast('تم الحفظ');
});

function renderSchedule() {
  fillScheduleGroups(); suggestTime();
  const list = myScheduleOf().slice().sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
  $('#scheduleBody').innerHTML = list.length
    ? list.map((s, i) => `<tr>
        <td>${i + 1}</td><td>${DAY_NAMES[s.day]}</td><td>${esc(s.subject)}</td>
        <td>${esc(s.group) || 'الكل'}</td><td>${s.time} – ${entryEnd(s)}</td><td>${s.lateMin} د</td><td>${s.auto === false ? '—' : '⚡'}</td>
        <td>
          <button class="btn sm" data-act="edit" data-id="${s.id}">تعديل</button>
          <button class="btn sm danger" data-act="del" data-id="${s.id}">حذف</button>
        </td></tr>`).join('')
    : '<tr><td colspan="8" class="empty">لا توجد حصص بعد</td></tr>';
}
$('#scheduleBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const s = db.schedule.find((x) => x.id === b.dataset.id); if (!s) return;
  if (b.dataset.act === 'edit') {
    $('#scId').value = s.id; $('#scDay').value = s.day; $('#scSubject').value = s.subject;
    $('#scGroup').value = s.group || ''; $('#scTime').value = s.time; $('#scLate').value = s.lateMin;
    $('#scEnd').value = s.endTime || ''; $('#scAuto').checked = s.auto !== false;
    window.scrollTo(0, 0);
  } else if (b.dataset.act === 'del') {
    if (confirm(`حذف حصة "${s.subject}"؟`)) { db.schedule = db.schedule.filter((x) => x.id !== s.id); audit('حذف حصة', `${s.subject} — ${s.time}`); persist(); renderSchedule(); }
  }
});

function renderTodaySchedule() {
  const todayDay = new Date().getDay();
  $('#todayDayName').textContent = DAY_NAMES[todayDay];
  const list = myScheduleOf().filter((s) => s.day === todayDay).sort((a, b) => a.time.localeCompare(b.time));
  const box = $('#todaySchedule');
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  $('#todayScheduleList').innerHTML = list.map((s, i) => {
    const already = db.sessions.some((ses) => ses.scheduleId === s.id && ses.date === todayStr());
    const prev = list[i - 1];
    const gap = prev ? toMin(s.time) - toMin(entryEnd(prev)) : 0;
    const brk = gap > 0 ? `<div class="break-chip">☕ استراحة ${gap} د (${entryEnd(prev)} ← ${s.time})</div>` : '';
    return `${brk}<div class="schedule-item">
      <div><b>${esc(s.subject)}</b><span>${s.time} – ${entryEnd(s)} — ${esc(s.group) || 'كل الطلاب'} — تأخير بعد ${s.lateMin} د${db.settings.autoSchedule && s.auto !== false ? ' — ⚡ تلقائي' : ''}</span></div>
      <button class="btn sm primary" data-act="quickstart" data-id="${s.id}" ${already ? 'disabled' : ''}>${already ? '✅ بدأت اليوم' : '▶ بدء الحصة'}</button>
    </div>`;
  }).join('');
}
$('#todayScheduleList').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  const s = db.schedule.find((x) => x.id === b.dataset.id); if (!s) return;
  const d = new Date();
  db.sessions.push({
    id: uid(), subject: s.subject, group: s.group, lateMin: s.lateMin,
    date: todayStr(), time: nowTime(), startTs: d.getTime(), active: true,
    createdBy: currentUser.id, createdByName: currentUser.name, scheduleId: s.id, autoEnd: s.auto !== false
  });
  audit('بدء محاضرة', s.subject + ' — من الجدول');
  persist(); renderScan(); focusScan(); autoOpenReceive();
});

/* ---------- الطلاب ---------- */
function setPhotoPreview(dataUrl) {
  const img = $('#stPhotoPreview');
  if (dataUrl) { img.src = dataUrl; } else { img.removeAttribute('src'); }
  $('#stPhoto').value = dataUrl || '';
}
function resetStudentForm() {
  $('#studentForm').reset(); $('#stId').value = '';
  readingCard = false;
  $('#stUid').readOnly = true; $('#stUid').classList.remove('waiting');
  $('#stUid').placeholder = 'اضغط زر القراءة ثم مرّر البطاقة';
  $('#stReadBtn').textContent = '📇 قراءة البطاقة';
  setPhotoPreview('');
}
$('#stPhotoPick').addEventListener('click', async () => {
  const r = await api.pickImage();
  if (!r) return;
  if (r.error === 'large') return toast('الصورة كبيرة جداً، اختر صورة أصغر من 2 ميغابايت');
  setPhotoPreview(r.dataUrl);
});
$('#stPhotoClear').addEventListener('click', () => setPhotoPreview(''));
$('#stCancel').addEventListener('click', resetStudentForm);
let readingCard = false;
$('#stReadBtn').addEventListener('click', () => {
  readingCard = true;
  const inp = $('#stUid');
  inp.readOnly = false;
  inp.value = '';
  inp.classList.add('waiting');
  inp.placeholder = 'مرّر البطاقة الآن...';
  inp.focus();
  $('#stReadBtn').textContent = '⏳ بانتظار البطاقة...';
});
$('#stUid').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = normUid(e.target.value);
  e.target.value = v;
  if (readingCard) {
    readingCard = false;
    e.target.readOnly = true;
    e.target.classList.remove('waiting');
    e.target.placeholder = 'اضغط زر القراءة ثم مرّر البطاقة';
    $('#stReadBtn').textContent = v ? '✅ تمت القراءة — قراءة أخرى' : '📇 قراءة البطاقة';
    if (v) toast('تم قراءة رقم البطاقة');
  }
});
$('#stSearch').addEventListener('input', renderStudents);

$('#stImportBtn').addEventListener('click', async () => {
  const r = await api.importStudentsExcel();
  if (!r) return;
  if (!r.ok) return toast('تعذّر قراءة الملف: ' + (r.error || ''));
  if (!r.rows.length) return toast('لم يُعثر على أي صف باسم طالب في الملف');
  let added = 0, uidConflicts = 0;
  const teacherCards = new Set((await api.usersList()).flatMap((u) => cardsOf(u.cardUid)));
  r.rows.forEach((row) => {
    let cardUid = normUid(row.cardUid);
    if (cardUid && (teacherCards.has(cardUid) || db.students.some((s) => s.cardUid === cardUid))) { cardUid = ''; uidConflicts++; }
    db.students.push({ id: uid(), name: row.name, grade: row.grade || '', cardUid, photo: '', createdAt: Date.now(), createdBy: currentUser.id });
    added++;
  });
  audit('استيراد طلاب', `${added} طالب من ملف`);
  persist(); renderStudents();
  toast(`تمت إضافة ${added} طالب${uidConflicts ? ` (تم تجاهل رقم البطاقة لـ ${uidConflicts} بسبب التكرار)` : ''}`);
});

/* تصدير الطلاب مع أرقام البطاقات (نفس أعمدة الاستيراد ليمكن إعادة استيراده) */
function studentsRows() {
  const list = [...myStudents()].sort((x, y) => String(x.grade || '').localeCompare(String(y.grade || ''), 'ar') || String(x.name).localeCompare(String(y.name), 'ar'));
  return [['#', 'اسم الطالب', 'الصف', 'رقم البطاقة'], ...list.map((s, i) => [i + 1, s.name, s.grade || '', s.cardUid || ''])];
}
$('#stExportXlsx').addEventListener('click', async () => {
  if (!myStudents().length) return toast('لا يوجد طلاب للتصدير');
  const d = new Date().toISOString().slice(0, 10);
  if (await api.saveXlsx(`students-${d}.xlsx`, 'الطلاب', studentsRows(), [6, 32, 18, 22], [0])) { audit('تصدير طلاب', `${db.students.length} طالب (Excel)`); persist(); toast('تم حفظ ملف الطلاب'); }
});
$('#stExportCsv').addEventListener('click', () => {
  if (!myStudents().length) return toast('لا يوجد طلاب للتصدير');
  csvDownload(`students-${new Date().toISOString().slice(0, 10)}.csv`, studentsRows());
  audit('تصدير طلاب', `${db.students.length} طالب (CSV)`); persist();
});

$('#studentForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#stId').value;
  const name = $('#stName').value.trim();
  const grade = $('#stGrade').value.trim();
  const cardUid = normUid($('#stUid').value);
  const photo = $('#stPhoto').value || '';
  if (cardUid && db.students.some((s) => s.cardUid === cardUid && s.id !== id)) return toast('رقم البطاقة مستخدم لطالب آخر');
  if (cardUid && (await api.usersList()).some((u) => cardsOf(u.cardUid).includes(cardUid))) return toast('هذه البطاقة مخصّصة لمدرّس');
  if (id) {
    const s = db.students.find((x) => x.id === id);
    if (!s || !canEditStudent(s)) return toast('لا تملك صلاحية تعديل هذا الطالب');
    const ch = [];
    if (s.name !== name) ch.push(`الاسم: ${s.name} ← ${name}`);
    if (s.grade !== grade) ch.push(`الصف: ${s.grade} ← ${grade}`);
    if ((s.cardUid || '') !== cardUid) ch.push(`البطاقة: ${s.cardUid || '—'} ← ${cardUid || '—'}`);
    if ((s.photo || '') !== photo) ch.push('الصورة');
    if (ch.length) audit('تعديل طالب', `${s.name}: ${ch.join(' • ')}`);
    Object.assign(s, { name, grade, cardUid, photo });
    db.attendance.forEach((a) => { if (a.studentId === id) { a.studentName = name; a.grade = grade; } });
  } else {
    db.students.push({ id: uid(), name, grade, cardUid, photo, createdAt: Date.now(), createdBy: currentUser.id });
    audit('إضافة طالب', `${name} — ${grade || 'بدون صف'}${cardUid ? ' — بطاقة ' + cardUid : ''}`);
  }
  persist(); resetStudentForm(); renderStudents(); toast('تم الحفظ');
});

/* ---------- إرسال الطلاب وبطاقاتهم إلى مرحلة في هواتف الأندرويد (للمدير) ---------- */
async function fillStSend() {
  $('#stSendBox').hidden = !isAdmin();
  if (!isAdmin()) return;
  const grades = [...new Set(db.students.map((s) => s.grade || ''))].sort((x, y) => x.localeCompare(y, 'ar'));
  const cur = $('#stSendGrade').value;
  $('#stSendGrade').innerHTML = `<option value="__all">كل الطلاب (${db.students.length})</option>` +
    grades.map((g) => `<option value="${esc(g)}">${esc(g || 'بدون صف')} (${db.students.filter((s) => (s.grade || '') === g).length})</option>`).join('');
  if (cur && [...$('#stSendGrade').options].some((o) => o.value === cur)) $('#stSendGrade').value = cur;
  $('#stSendAsList').innerHTML = grades.filter(Boolean).map((g) => `<option value="${esc(g)}">`).join('');
  const devs = await api.lanList();
  const had = new Set([...document.querySelectorAll('.stSendDev:checked')].map((c) => c.value));
  $('#stSendDevices').innerHTML = devs.length
    ? devs.map((d) => `<label class="check"><input type="checkbox" class="stSendDev" value="${esc(d.id)}" ${had.has(d.id) ? 'checked' : ''}> ${esc(d.name)} <span dir="ltr">(${esc(d.host)})</span></label>`).join('')
    : '<span class="hint">لا توجد هواتف مضافة — أضفها من تبويب «الأجهزة».</span>';
  updateStSendCount();
}
function stSendList() {
  const g = $('#stSendGrade').value;
  return db.students.filter((s) => g === '__all' || (s.grade || '') === g);
}
function updateStSendCount() {
  const n = stSendList().length, w = stSendList().filter((s) => s.cardUid).length;
  $('#stSendCount').textContent = `${n} طالب (${w} منهم ببطاقة)`;
}
$('#stSendGrade').addEventListener('change', () => { updateStSendCount(); if (!$('#stSendAs').value && $('#stSendGrade').value !== '__all') $('#stSendAs').placeholder = $('#stSendGrade').value || 'مثال: الصف الأول'; });
$('#stSendGo').addEventListener('click', async () => {
  if (!isAdmin()) return;
  const list = stSendList();
  const devIds = [...document.querySelectorAll('.stSendDev:checked')].map((c) => c.value);
  if (!list.length) return toast('لا يوجد طلاب في هذا الاختيار');
  if (!devIds.length) return toast('حدّد هاتفاً واحداً على الأقل');
  const grade = $('#stSendAs').value.trim();
  const out = $('#stSendOut'); out.textContent = '⏳ جارٍ الإرسال...';
  const devs = await api.lanList();
  const rows = [];
  for (const id of devIds) {
    const dev = devs.find((d) => d.id === id); const dn = dev ? dev.name : id;
    let added = 0, updated = 0, same = 0, skipped = [], err = '';
    for (let i = 0; i < list.length && !err; i += 300) {
      const chunk = list.slice(i, i + 300).map((s) => ({ name: s.name, grade: s.grade || '', cardUid: s.cardUid || '' }));
      const r = await api.lanCall({ id, method: 'POST', path: '/api/students/import', body: { students: chunk, grade } });
      if (r.status === 200 && r.data && r.data.ok) { added += r.data.added; updated += r.data.updated; same += r.data.same; skipped = skipped.concat(r.data.skipped || []); }
      else if (r.status === 404) err = 'نسخة الأندرويد قديمة — ثبّت النسخة الأحدث';
      else if (r.status === 401) err = 'رمز الاتصال غير صحيح';
      else err = (r.data && r.data.error) || r.error || ('خطأ ' + r.status);
    }
    rows.push({ dn, added, updated, same, skipped, err });
    if (!err) audit('إرسال طلاب إلى هاتف', `${dn} — ${added} جديد، ${updated} محدَّث${grade ? ' — المرحلة: ' + grade : ''}`);
  }
  persist();
  const ok = rows.filter((x) => !x.err).length;
  out.innerHTML = `<b>تم ${ok} من ${rows.length}</b><br>` + rows.map((x) => x.err
    ? `❌ ${esc(x.dn)} — ${esc(x.err)}`
    : `✅ ${esc(x.dn)} — ${x.added} جديد، ${x.updated} محدَّث، ${x.same} دون تغيير` + (x.skipped.length ? `<br>&nbsp;&nbsp;⚠️ تُخطّي ${x.skipped.length}: ` + x.skipped.slice(0, 5).map((k) => esc(k.name) + ' (' + esc(k.reason) + ')').join('، ') + (x.skipped.length > 5 ? '…' : '') : '')).join('<br>');
  toast(ok === rows.length ? 'تم إرسال الطلاب إلى الهواتف' : 'اكتمل الإرسال مع أخطاء — انظر التفاصيل');
});

function renderStudents() {
  fillStSend();
  const q = $('#stSearch').value.trim().toLowerCase();
  const list = myStudents().filter((s) => !q || [s.name, s.grade, s.cardUid].some((v) => String(v || '').toLowerCase().includes(q)));
  $('#studentsBody').innerHTML = list.length
    ? list.map((s, i) => `<tr>
        <td>${i + 1}</td>
        <td>${s.photo ? `<img class="thumb" src="${s.photo}" alt="">` : ''}</td>
        <td>${esc(s.name)}</td><td>${esc(s.grade)}</td>
        <td class="ltr">${esc(s.cardUid) || '— بدون بطاقة —'}</td>
        <td>
          <button class="btn sm" data-act="manual" data-id="${s.id}">حضور يدوي</button>
          ${canEditStudent(s) ? `<button class="btn sm" data-act="edit" data-id="${s.id}">تعديل</button>
          <button class="btn sm danger" data-act="del" data-id="${s.id}">حذف</button>` : ''}
        </td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">لا يوجد طلاب</td></tr>';
}

$('#studentsBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const s = db.students.find((x) => x.id === b.dataset.id); if (!s) return;
  if ((b.dataset.act === 'edit' || b.dataset.act === 'del') && !canEditStudent(s)) return toast('لا تملك صلاحية تعديل هذا الطالب');
  if (b.dataset.act === 'edit') {
    resetStudentForm();
    $('#stId').value = s.id; $('#stName').value = s.name; $('#stGrade').value = s.grade; $('#stUid').value = s.cardUid || '';
    setPhotoPreview(s.photo || '');
    window.scrollTo(0, 0);
  } else if (b.dataset.act === 'del') {
    askAuth(`حذف الطالب «${s.name}» — يتطلب تأكيد المدرّس`).then((ok) => {
      if (!ok) return;
      db.students = db.students.filter((x) => x.id !== s.id); audit('حذف طالب', `${s.name} — ${s.grade}`); persist(); renderStudents();
    });
  } else if (b.dataset.act === 'manual') {
    const ses = activeSession();
    if (!ses) return toast('ابدأ محاضرة أولاً');
    if (db.attendance.some((a) => a.sessionId === ses.id && a.studentId === s.id)) return toast('مسجّل مسبقاً في هذه المحاضرة');
    record(ses, s, statusFor(ses)); toast('تم تسجيل الحضور');
  }
});

/* ---------- السجل ---------- */
$('#logDate').addEventListener('change', () => { fillLogSessions(); renderLog(); });
$('#logSession').addEventListener('change', renderLog);
$('#logSearch').addEventListener('input', renderLog);

function fillLogSessions() {
  const d = $('#logDate').value || todayStr();
  const sel = $('#logSession'); const cur = sel.value;
  const list = visibleSessions(db.sessions.filter((s) => s.date === d));
  sel.innerHTML = '<option value="">كل المحاضرات</option>' + list.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(sessionLabel(s))}${isAdmin() && s.createdByName ? ' — ' + s.createdByName : ''}</option>`).join('');
}
function logRows() {
  const d = $('#logDate').value || todayStr();
  const sid = $('#logSession').value;
  const q = $('#logSearch').value.trim().toLowerCase();
  const visIds = new Set(visibleSessions(db.sessions).map((s) => s.id));
  return db.attendance.filter((a) => a.date === d && visIds.has(a.sessionId) && (!sid || a.sessionId === sid) && (!q || a.studentName.toLowerCase().includes(q)));
}
function renderLog() {
  if (!$('#logDate').value) $('#logDate').value = todayStr();
  fillLogSessions();
  const rows = logRows();
  $('#logBody').innerHTML = rows.length
    ? rows.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.studentName)}</td><td>${esc(a.grade)}</td><td>${esc(a.subject || '—')}</td><td>${a.time.slice(0, 5)}</td><td>${statusBadge(a.status)}${a.manual ? ' <span class="badge manual">يدوي</span>' : ''}</td>
        <td><button class="btn sm danger" data-id="${a.id}">حذف</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">لا توجد سجلات</td></tr>';
}
$('#logBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const rec = db.attendance.find((a) => a.id === b.dataset.id);
  if (!rec) return;
  askAuth(`حذف سجل «${rec.studentName}» — يتطلب تأكيد المدرّس`).then((ok) => {
    if (!ok) return;
    db.attendance = db.attendance.filter((a) => a.id !== b.dataset.id);
    audit('حذف سجل حضور', `${rec.studentName} — ${rec.subject || ''} ${rec.date} ${rec.time}`);
    persist(); renderLog();
  });
});
$('#logExport').addEventListener('click', () => {
  const d = $('#logDate').value || todayStr();
  csvDownload(`attendance-${d}.csv`, [['الاسم', 'الصف', 'المحاضرة', 'التاريخ', 'الوقت', 'الحالة'],
    ...logRows().map((a) => [a.studentName, a.grade, a.subject || '', a.date, a.time, a.status === 'late' ? 'متأخر' : 'حاضر'])]);
});

/* ---------- التقارير ---------- */
$('#repDate').addEventListener('change', () => { renderReports(); });
$('#repSession').addEventListener('change', renderReports);

function renderReports() {
  renderMonthly();
  if (!$('#repDate').value) $('#repDate').value = todayStr();
  const d = $('#repDate').value;
  const sel = $('#repSession'); const cur = sel.value;
  const list = visibleSessions(db.sessions.filter((s) => s.date === d));
  sel.innerHTML = list.length
    ? list.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(sessionLabel(s))}${isAdmin() && s.createdByName ? ' — ' + s.createdByName : ''}</option>`).join('')
    : '<option value="">لا توجد محاضرات</option>';
  const ses = db.sessions.find((s) => s.id === sel.value);
  if (!ses) {
    ['rpPresent', 'rpLate', 'rpAbsent'].forEach((i) => ($('#' + i).textContent = 0));
    $('#absentBody').innerHTML = '<tr><td colspan="4" class="empty">اختر يوماً فيه محاضرة</td></tr>';
    return;
  }
  const { present, late, absent } = sessionStats(ses);
  $('#rpPresent').textContent = present; $('#rpLate').textContent = late; $('#rpAbsent').textContent = absent.length;
  $('#absentBody').innerHTML = absent.length
    ? absent.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.name)}</td><td>${esc(s.grade)}</td>
        <td><button class="btn sm" data-id="${s.id}">تسجيل حضور</button></td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">لا يوجد غائبون 🎉</td></tr>';
}
$('#absentBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const s = db.students.find((x) => x.id === b.dataset.id);
  const ses = db.sessions.find((x) => x.id === $('#repSession').value);
  if (!s || !ses) return;
  record(ses, s, 'present'); renderReports();
});
$('#repExport').addEventListener('click', () => {
  const ses = db.sessions.find((x) => x.id === $('#repSession').value);
  if (!ses) return toast('لا توجد محاضرة للتصدير');
  const studs = db.students.filter((s) => !ses.group || s.grade === ses.group);
  const rows = studs.map((s) => {
    const a = db.attendance.find((x) => x.sessionId === ses.id && x.studentId === s.id);
    return [s.name, s.grade, a ? (a.status === 'late' ? 'متأخر' : 'حاضر') : 'غائب', a ? a.time : ''];
  });
  csvDownload(`report-${ses.date}-${ses.subject}.csv`, [['الاسم', 'الصف', 'الحالة', 'الوقت'], ...rows]);
});

/* ---------- التقرير الشهري ---------- */
function currentMonth() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
$('#monthInput').addEventListener('change', renderMonthly);
$('#monthGroup').addEventListener('change', renderMonthly);

function monthlyStats() {
  if (!$('#monthInput').value) $('#monthInput').value = currentMonth();
  const month = $('#monthInput').value;
  const sel = $('#monthGroup'); const cur = sel.value;
  const grades = [...new Set(db.students.map((s) => s.grade))].sort();
  sel.innerHTML = '<option value="">الكل</option>' + grades.map((g) => `<option ${g === cur ? 'selected' : ''}>${esc(g)}</option>`).join('');
  const group = sel.value;

  const monthSessions = visibleSessions(db.sessions).filter((s) => s.date.slice(0, 7) === month);
  const students = db.students.filter((s) => !group || s.grade === group);

  return students.map((s) => {
    const applicable = monthSessions.filter((ses) => !ses.group || ses.group === s.grade);
    const recs = applicable.map((ses) => db.attendance.find((a) => a.sessionId === ses.id && a.studentId === s.id));
    const present = recs.filter((r) => r && r.status === 'present').length;
    const late = recs.filter((r) => r && r.status === 'late').length;
    const total = applicable.length;
    const absent = total - present - late;
    const pct = total ? Math.round(((present + late) / total) * 100) : 0;
    return { name: s.name, grade: s.grade, total, present, late, absent, pct };
  });
}

function renderMonthly() {
  const rows = monthlyStats();
  $('#monthBody').innerHTML = rows.length
    ? rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.grade)}</td>
        <td>${r.total}</td><td>${r.present}</td><td>${r.late}</td><td>${r.absent}</td><td>${r.total ? r.pct + '%' : '—'}</td></tr>`).join('')
    : '<tr><td colspan="8" class="empty">لا توجد بيانات لهذا الشهر</td></tr>';
}
$('#monthExport').addEventListener('click', () => {
  const month = $('#monthInput').value || currentMonth();
  const rows = monthlyStats();
  csvDownload(`monthly-report-${month}.csv`, [
    ['الاسم', 'الصف', 'عدد الحصص', 'حاضر', 'متأخر', 'غائب', 'نسبة الحضور'],
    ...rows.map((r) => [r.name, r.grade, r.total, r.present, r.late, r.absent, r.total ? r.pct + '%' : ''])
  ]);
});

/* ---------- عرض سجل التدقيق ---------- */
const fmtTs = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const auditColor = (a) => /حذف/.test(a) ? 'bad' : /إنشاء|إضافة|استيراد/.test(a) ? 'present' : /كلمة|استرجاع/.test(a) ? 'late' : 'manual';
function auditRows() {
  const user = $('#auUser').value, from = $('#auDate').value, q = $('#auSearch').value.trim().toLowerCase();
  const fromTs = from ? new Date(from + 'T00:00:00').getTime() : 0;
  return (db.audit || []).filter((e) =>
    (!user || e.userName === user) && e.ts >= fromTs &&
    (!q || [e.action, e.detail, e.userName].some((v) => String(v || '').toLowerCase().includes(q)))
  ).slice().reverse();
}
function renderAudit() {
  const sel = $('#auUser'); const cur = sel.value;
  const users = [...new Set((db.audit || []).map((e) => e.userName))].sort();
  sel.innerHTML = '<option value="">الكل</option>' + users.map((u) => `<option ${u === cur ? 'selected' : ''}>${esc(u)}</option>`).join('');
  const rows = auditRows();
  $('#auditBody').innerHTML = rows.length
    ? rows.slice(0, 500).map((e, i) => `<tr><td>${i + 1}</td><td class="ltr">${fmtTs(e.ts)}</td><td>${esc(e.userName)}</td>
        <td><span class="badge ${auditColor(e.action)}">${esc(e.action)}</span></td><td>${esc(e.detail)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">لا توجد سجلات</td></tr>';
}
$('#auUser').addEventListener('change', renderAudit);
$('#auDate').addEventListener('change', renderAudit);
$('#auSearch').addEventListener('input', renderAudit);
$('#auExport').addEventListener('click', () => {
  csvDownload('audit-log.csv', [['الوقت', 'المستخدم', 'الإجراء', 'التفاصيل'], ...auditRows().map((e) => [fmtTs(e.ts), e.userName, e.action, e.detail])]);
});
$('#auPurge').addEventListener('click', () => {
  const n = (db.audit || []).length;
  if (!n || !confirm(`حذف كل سجلات التدقيق (${n} سجل)؟ لا يمكن التراجع.`)) return;
  db.audit = [];
  audit('حذف كل سجلات التدقيق', `${n} سجل`);
  renderAudit(); toast('تم حذف السجل');
});

/* ---------- تقارير PDF / Excel ---------- */
function monthlyReportMeta() {
  const month = $('#monthInput').value || currentMonth();
  const group = $('#monthGroup').value;
  const rows = monthlyStats();
  return { month, group, rows };
}
$('#monthXlsx').addEventListener('click', async () => {
  const { month, group, rows } = monthlyReportMeta();
  if (!rows.length) return toast('لا توجد بيانات');
  const data = [
    [db.settings.schoolName || 'حضور الطلبة'],
    ['التقرير الشهري للحضور — ' + month + (group ? ' — ' + group : '')],
    [],
    ['#', 'اسم الطالب', 'الصف', 'عدد الحصص', 'حاضر', 'متأخر', 'غائب', 'نسبة الحضور'],
    ...rows.map((r, i) => [i + 1, r.name, r.grade, r.total, r.present, r.late, r.absent, r.total ? r.pct + '%' : '-'])
  ];
  if (await api.saveXlsx(`monthly-report-${month}.xlsx`, 'التقرير الشهري', data, [6, 30, 18, 12, 10, 10, 10, 14], [0, 1, 3])) toast('تم حفظ ملف Excel');
});
$('#monthPdf').addEventListener('click', async () => {
  const { month, group, rows } = monthlyReportMeta();
  if (!rows.length) return toast('لا توجد بيانات');
  const withData = rows.filter((r) => r.total);
  const avg = withData.length ? Math.round(withData.reduce((a, r) => a + r.pct, 0) / withData.length) : 0;
  const low = withData.filter((r) => r.pct < 75).length;
  const colr = (r) => !r.total ? '#888' : r.pct >= 90 ? '#0e8f5a' : r.pct >= 75 ? '#c77f0a' : '#d32f57';
  const logo = db.settings.logo ? `<img class="logo" src="${db.settings.logo}">` : '';
  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
    @page { size: A4; margin: 14mm; }
    body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; color: #111; font-size: 12px; }
    .head { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid #6d7cff; padding-bottom: 10px; }
    .logo { height: 72px; max-width: 120px; object-fit: contain; }
    h1 { margin: 0; font-size: 24px; color: #2a3170; } h2 { margin: 2px 0; font-size: 15px; font-weight: 500; color: #444; }
    .sub { color: #666; } .sum { margin: 12px 0; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; }
    th { background: #3d4a9e; color: #fff; padding: 7px 6px; font-size: 12px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    td { padding: 5px 6px; border-bottom: 1px solid #d5d9ee; } tr:nth-child(even) td { background: #f1f3fb; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    td.c, th.c { text-align: center; } td.n { text-align: right; } tr { page-break-inside: avoid; }
    .foot { margin-top: 14px; color: #888; font-size: 10px; text-align: center; }
  </style></head><body>
    <div class="head">${logo}<div><h1>${esc(db.settings.schoolName || 'حضور الطلبة')}</h1><h2>التقرير الشهري للحضور</h2>
    <div class="sub">الشهر: ${esc(month)} &nbsp;•&nbsp; ${group ? 'المجموعة: ' + esc(group) : 'كل الطلاب'}</div></div></div>
    <div class="sum">عدد الطلاب: ${rows.length} &nbsp;•&nbsp; متوسط الحضور: ${avg}% &nbsp;•&nbsp; دون 75%: ${low} طالب</div>
    <table><thead><tr><th class="c">#</th><th>اسم الطالب</th><th>الصف</th><th class="c">الحصص</th><th class="c">حاضر</th><th class="c">متأخر</th><th class="c">غائب</th><th class="c">النسبة</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td class="c">${i + 1}</td><td class="n">${esc(r.name)}</td><td class="n">${esc(r.grade) || '—'}</td><td class="c">${r.total}</td><td class="c">${r.present}</td><td class="c">${r.late}</td><td class="c">${r.absent}</td><td class="c" style="font-weight:700;color:${colr(r)}">${r.total ? r.pct + '%' : '—'}</td></tr>`).join('')}
    </tbody></table>
    <div class="foot">طُبع بتاريخ ${todayStr()}</div></body></html>`;
  if (await api.savePdf(html, `monthly-report-${month}.pdf`)) toast('تم حفظ ملف PDF');
});

/* ---------- الإعدادات ---------- */
function setLogoPreview(dataUrl) {
  const img = $('#setLogoPreview');
  if (dataUrl) img.src = dataUrl; else img.removeAttribute('src');
}
$('#setLogoPick').addEventListener('click', async () => {
  const r = await api.pickImage();
  if (!r) return;
  if (r.error === 'large') return toast('الصورة كبيرة جداً، اختر صورة أصغر من 2 ميغابايت');
  db.settings.logo = r.dataUrl; audit('تغيير شعار المدرسة'); persist(); setLogoPreview(r.dataUrl); toast('تم حفظ الشعار');
});
$('#setLogoClear').addEventListener('click', () => { db.settings.logo = ''; audit('حذف شعار المدرسة'); persist(); setLogoPreview(''); });
async function renderSettings() {
  setLogoPreview(db.settings.logo || '');
  $('#setSchool').value = db.settings.schoolName || '';
  $('#setLate').value = db.settings.lateMinutes ?? 10;
  $('#setBackupDays').value = db.settings.backupKeepDays ?? 30;
  $('#setAuto').checked = !!db.settings.autoSchedule;
  $('#setAutoReceive').checked = db.settings.autoReceive !== false;
  $('#setAutoLogout').checked = db.settings.autoLogout !== false;
  $('#setLectureMin').value = db.settings.lectureMinutes ?? 45;
  $('#setBreakMin').value = db.settings.breakMinutes ?? 10;
  $('#dataPath').textContent = await api.dataPath();
  $('#backupsPath').textContent = await api.backupsDir();
}
$('#setSave').addEventListener('click', () => {
  db.settings.schoolName = $('#setSchool').value.trim() || 'حضور الطلبة';
  db.settings.lateMinutes = Number($('#setLate').value) || 0;
  db.settings.backupKeepDays = Math.max(1, Number($('#setBackupDays').value) || 30);
  db.settings.autoReceive = $('#setAutoReceive').checked;
  db.settings.autoLogout = $('#setAutoLogout').checked;
  audit('تعديل الإعدادات', `الاسم: ${db.settings.schoolName} • التأخير: ${db.settings.lateMinutes} • أيام النسخ: ${db.settings.backupKeepDays} • شاشة الاستقبال التلقائية: ${db.settings.autoReceive ? 'مفعّلة' : 'معطّلة'} • الخروج التلقائي: ${db.settings.autoLogout ? 'مفعّل' : 'معطّل'}`);
  persist(); applyTitle(); toast('تم حفظ الإعدادات');
});
$('#setSaveAuto').addEventListener('click', () => {
  db.settings.autoSchedule = $('#setAuto').checked;
  db.settings.lectureMinutes = Math.max(5, Number($('#setLectureMin').value) || 45);
  db.settings.breakMinutes = Math.max(0, Number($('#setBreakMin').value) || 0);
  audit('تعديل التشغيل التلقائي', `${db.settings.autoSchedule ? 'مفعّل' : 'معطّل'} • الحصة ${db.settings.lectureMinutes} د • الاستراحة ${db.settings.breakMinutes} د`);
  persist(); autoTick(); renderScan(); toast(db.settings.autoSchedule ? 'تم تفعيل التشغيل التلقائي' : 'تم إيقاف التشغيل التلقائي');
});
$('#bkOpenFolder').addEventListener('click', () => api.openBackupsFolder());
$('#bkExport').addEventListener('click', async () => { if (await api.exportBackup()) { audit('تصدير نسخة احتياطية'); toast('تم تصدير النسخة'); } });
$('#bkImport').addEventListener('click', async () => {
  if (!confirm('سيتم استبدال كل البيانات الحالية بالنسخة المستوردة. متابعة؟')) return;
  const d = await api.importBackup();
  if (d) { db = d; audit('استيراد نسخة احتياطية', 'استبدال كل البيانات'); applyTitle(); renderScan(); toast('تم الاستيراد'); } else toast('تعذّر الاستيراد');
});

function applyTitle() { $('#appTitle').textContent = db.settings.schoolName || 'حضور الطلبة'; }

/* ---------- تسجيل الدخول ---------- */
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#loginUser').value.trim();
  const password = $('#loginPass').value;
  const r = await api.login(username, password);
  if (!r.ok) {
    $('#loginError').hidden = false;
    $('#loginError').textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة';
    return;
  }
  finishLogin(r.user, 'تسجيل دخول');
});
function finishLogin(user, auditText) {
  currentUser = user;
  $('#loginNotice').hidden = true;
  audit(auditText);
  $('#loginScreen').hidden = true;
  $('#mainNav').hidden = false;
  $('#mainArea').hidden = false;
  applyRoleNav();
  switchTab('scan');
  autoTick();
}

/* الدخول ببطاقة المدرّس: القارئ يكتب الرقم بسرعة ثم Enter (الفاصل بين الأحرف أقل من 60ms، والإنسان أبطأ)،
   فنلتقطه في أي مكان من شاشة الدخول ونمسح ما دخل في خانتي الاسم وكلمة المرور. */
let lgBuf = '', lgLast = 0;
document.addEventListener('keydown', async (e) => {
  if ($('#loginScreen').hidden) return;
  const t = performance.now();
  if (e.key === 'Enter') {
    const fast = t - lgLast < 60;
    const uid = lgBuf; lgBuf = '';
    if (uid.length >= 4 && fast) {
      e.preventDefault(); e.stopPropagation();
      $('#loginUser').value = ''; $('#loginPass').value = '';
      const r = await api.loginCard(uid);
      if (r.ok) return finishLogin(r.user, 'تسجيل دخول ببطاقة المدرّس');
      $('#loginError').hidden = false;
      $('#loginError').textContent = r.reason === 'admin' ? 'بطاقة المدير لا تُستخدم للدخول — ادخل بكلمة المرور' : 'هذه البطاقة غير مسجّلة لأي مستخدم';
    }
    return;
  }
  if (e.key.length !== 1 || e.ctrlKey || e.altKey || e.metaKey) return;
  if (t - lgLast > 60) lgBuf = '';
  lgBuf += e.key; lgLast = t;
}, true);
function doLogout(auto) {
  audit(auto ? 'تسجيل خروج تلقائي (انتهاء الحصة)' : 'تسجيل خروج');
  closeAuth(false);
  exitKiosk();           // قبل تصفير المستخدم لأنها تعتمد عليه
  currentUser = null;
  $('#loginUser').value = ''; $('#loginPass').value = ''; $('#loginError').hidden = true;
  const n = $('#loginNotice');
  if (auto) { n.textContent = '🔒 انتهت الحصة وتم تسجيل الخروج تلقائياً'; n.hidden = false; } else n.hidden = true;
  $('#loginScreen').hidden = false;
  $('#mainNav').hidden = true;
  $('#mainArea').hidden = true;
  $('#loginUser').focus();
}
$('#logoutBtn').addEventListener('click', () => doLogout(false));

/* ---------- تأكيد المدرّس (كلمة مرور أو بطاقة) قبل الحذف ---------- */
let authResolve = null;
function askAuth(title) {
  return new Promise((resolve) => {
    if (authResolve) authResolve(false);
    authResolve = resolve;
    $('#authTitle').textContent = '🔐 ' + title;
    $('#authCard').value = ''; $('#authPass').value = ''; $('#authError').hidden = true;
    $('#authModal').hidden = false;
    setTimeout(() => $('#authCard').focus(), 50);
  });
}
function closeAuth(ok) {
  $('#authModal').hidden = true;
  const r = authResolve; authResolve = null;
  if (r) r(ok);
  if (currentUser) focusScan();
}
function authFail(msg, why) {
  const e = $('#authError'); e.textContent = msg; e.hidden = false;
  beep(220, 300); audit('محاولة فاشلة لتأكيد حذف', why);
}
$('#authCard').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const v = normUid(e.target.value); e.target.value = '';
  if (!v) return;
  const r = await api.authConfirm({ uid: v });
  if (r.ok) { audit('تأكيد عملية حذف ببطاقة المدرّس', r.name); closeAuth(true); }
  else { authFail('هذه ليست بطاقة مدرّس', 'بطاقة غير مصرّح بها'); $('#authCard').focus(); }
});
async function authSubmitPass() {
  const p = $('#authPass').value; if (!p) return;
  const r = await api.authConfirm({ userId: currentUser && currentUser.id, password: p });
  if (r.ok) { audit('تأكيد عملية حذف بكلمة المرور'); closeAuth(true); }
  else { authFail('كلمة المرور غير صحيحة', 'كلمة مرور خاطئة'); $('#authPass').value = ''; $('#authPass').focus(); }
}
$('#authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); authSubmitPass(); } });
$('#authOk').addEventListener('click', authSubmitPass);
$('#authCancel').addEventListener('click', () => closeAuth(false));

/* ---------- المستخدمون ---------- */
function syncCanSt() { $('#usCanStWrap').hidden = $('#usRole').value === 'admin'; }
$('#usRole').addEventListener('change', syncCanSt);
function resetUserForm() {
  setTimeout(() => { $('#usCanSt').checked = false; syncCanSt(); });
  $('#userForm').reset(); $('#usId').value = '';
  $('#usUsername').disabled = false;
  $('#usPass').required = true;
  $('#usPassWrap').querySelector('input').placeholder = '';
  $('#usCard').placeholder = 'اضغط «قراءة البطاقة» ثم مرّر بطاقة كل أستاذ';
}
/* حقل البطاقات يقبل عدة بطاقات مفصولة بفاصلة؛ كل Enter من القارئ يضيف فاصلة فتُمسح البطاقات واحدة تلو الأخرى */
$('#usReadBtn').addEventListener('click', () => {
  const i = $('#usCard');
  if (i.value && !i.value.endsWith(',')) i.value += ',';
  i.placeholder = 'مرّر البطاقة الآن...'; i.focus();
});
$('#usCardClear').addEventListener('click', () => { $('#usCard').value = ''; });
$('#usCard').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9,]/g, '').replace(/,{2,}/g, ','); });
$('#usCard').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return; e.preventDefault();
  const i = e.target;
  if (i.value && !i.value.endsWith(',')) { i.value += ','; toast('تمت قراءة البطاقة (' + cardsOf(i.value).length + ') — مرّر بطاقة أخرى لإضافتها'); }
});
$('#usCancel').addEventListener('click', resetUserForm);

$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#usId').value;
  const username = $('#usUsername').value.trim();
  const name = $('#usName').value.trim();
  const role = $('#usRole').value;
  const pass = $('#usPass').value;
  const cardUid = cardsOf($('#usCard').value).join(',');
  const canSt = role === 'teacher' && $('#usCanSt').checked;
  const cardErr = (r) => r.error === 'card_student' ? 'هذه البطاقة مسجّلة لطالب' : r.error === 'card_user' ? 'هذه البطاقة مسجّلة لمستخدم آخر' : null;
  if (id) {
    const before = (JSON.parse($('#usersBody').dataset.cache || '[]').find((x) => x.id === id) || {}).cardUid || '';
    const r = await api.userUpdate({ id, name, role, cardUid, canStudents: canSt });
    if (!r.ok) return toast(cardErr(r) || 'تعذّر التحديث');
    if (pass) {
      const r2 = await api.userResetPassword({ id, password: pass });
      if (!r2.ok) return toast('تعذّر تغيير كلمة المرور');
    }
    audit('تعديل مستخدم', `@${$('#usUsername').value} — ${name} (${role === 'admin' ? 'مدير' : 'مدرّس'})` + (before !== cardUid ? ` • بطاقات المدرّسين: ${cardUid ? cardsOf(before).length + ' ← ' + cardsOf(cardUid).length : 'أُزيلت'}` : ''));
    if (pass) audit('تغيير كلمة مرور', `المستخدم @${$('#usUsername').value}`);
    toast('تم التحديث');
  } else {
    if (!pass) return toast('كلمة المرور مطلوبة');
    const r = await api.userCreate({ username, password: pass, name, role, cardUid, canStudents: canSt });
    if (!r.ok) return toast(r.error === 'exists' ? 'اسم المستخدم مستخدم بالفعل' : (cardErr(r) || 'تعذّر الإنشاء'));
    audit('إنشاء مستخدم', `@${username} (${role === 'admin' ? 'مدير' : 'مدرّس'})${cardUid ? ' — مع ' + cardsOf(cardUid).length + ' بطاقة' : ''}`);
    toast('تم إنشاء المستخدم');
  }
  const pushAfter = $('#usPushAfter').checked;
  resetUserForm(); await renderUsers();
  if (pushAfter) {
    const saved = (await api.usersList()).find((x) => x.username.toLowerCase() === username.toLowerCase());
    if (saved) pushUsersToPhones([saved.id], usSelected('.usDev'));
  }
});

async function renderUsers() {
  const list = await api.usersList();
  $('#usersBody').innerHTML = list.length
    ? list.map((u, i) => `<tr>
        <td><input type="checkbox" class="usSel" value="${esc(u.id)}" title="تحديد للإرسال إلى الهواتف"></td><td class="ltr">${esc(u.username)}</td><td>${esc(u.name)}${u.cardUid ? ' 💳' + (cardsOf(u.cardUid).length > 1 ? '×' + cardsOf(u.cardUid).length : '') : ''}</td>
        <td>${u.role === 'admin' ? 'مدير' : 'مدرّس' + (u.canStudents ? ' 👨‍🎓' : '')}</td>
        <td>
          <button class="btn sm" data-act="edit" data-id="${u.id}">تعديل</button>
          ${u.id === 'admin' ? '' : `<button class="btn sm danger" data-act="del" data-id="${u.id}">حذف</button>`}
        </td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">لا يوجد مستخدمون</td></tr>';
  $('#usersBody').dataset.cache = JSON.stringify(list);
  $('#usAll').checked = false;
  fillUsDevices();
}

/* ---------- إرسال المستخدمين إلى الهواتف ---------- */
async function fillUsDevices() {
  const devs = await api.lanList();
  $('#usDevices').innerHTML = devs.length
    ? devs.map((d) => `<label class="check"><input type="checkbox" class="usDev" value="${esc(d.id)}" checked> ${esc(d.name)} <span dir="ltr">(${esc(d.host)})</span></label>`).join('')
    : '<span class="hint">لا توجد هواتف مضافة — أضفها من تبويب «الأجهزة».</span>';
}
$('#usAll').addEventListener('change', (e) => document.querySelectorAll('.usSel').forEach((c) => { c.checked = e.target.checked; }));

async function pushUsersToPhones(userIds, deviceIds) {
  if (!userIds.length) return toast('حدّد مستخدماً واحداً على الأقل');
  if (!deviceIds.length) return toast('حدّد هاتفاً واحداً على الأقل');
  const out = $('#usPushOut'); out.textContent = '⏳ جارٍ الإرسال...';
  const r = await api.lanPushUsers({ userIds, deviceIds });
  if (!r.ok) { out.textContent = r.error || 'فشل الإرسال'; return toast(r.error || 'فشل الإرسال'); }
  const okN = r.results.filter((x) => x.ok).length;
  out.innerHTML = `<b>تم ${okN} من ${r.results.length}</b><br>` + r.results.map((x) =>
    `${x.ok ? '✅' : '❌'} ${esc(x.device)} — <span dir="ltr">@${esc(x.username)}</span> ${x.ok ? (x.created ? '(أُنشئ)' : '(حُدِّث)') : '— ' + esc(x.error)}`).join('<br>');
  r.results.filter((x) => x.ok).forEach((x) => audit(x.created ? 'إنشاء مستخدم في هاتف' : 'تحديث مستخدم في هاتف', `${x.device} — @${x.username}`));
  toast(okN === r.results.length ? 'تم الإرسال إلى الهواتف' : 'اكتمل الإرسال مع أخطاء — انظر التفاصيل');
}
/* ---------- إنشاء مستخدمي مراحل دفعة واحدة ---------- */
$('#stGo').addEventListener('click', async () => {
  const out = $('#stOut');
  const lines = $('#stList').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return toast('اكتب مرحلة واحدة على الأقل');
  const common = $('#stPass').value;
  const existing = (await api.usersList()).map((u) => u.username.toLowerCase());
  const msgs = []; const createdNames = [];
  for (const line of lines) {
    const [stage, un, pw] = line.split(/\s*[:：]\s*/);
    const name = (stage || '').trim();
    const username = (un || '').trim() || name.replace(/\s+/g, '_');
    const password = (pw || '').trim() || common;
    if (!name) continue;
    if (!password) { msgs.push(`❌ ${esc(name)} — لا توجد كلمة مرور (اكتب كلمة المرور الموحّدة)`); continue; }
    if (existing.includes(username.toLowerCase())) { msgs.push(`⚠️ ${esc(name)} — اسم المستخدم «${esc(username)}» موجود مسبقاً (تخطّي)`); continue; }
    const r = await api.userCreate({ username, password, name, role: 'teacher', cardUid: '' });
    if (!r.ok) { msgs.push(`❌ ${esc(name)} — ${r.error === 'exists' ? 'اسم المستخدم موجود' : 'تعذّر الإنشاء'}`); continue; }
    existing.push(username.toLowerCase()); createdNames.push(username);
    audit('إنشاء مستخدم', `@${username} (مدرّس) — مرحلة: ${name}`);
    msgs.push(`✅ ${esc(name)} — <span dir="ltr">@${esc(username)}</span>`);
  }
  out.innerHTML = msgs.join('<br>');
  await renderUsers();
  if (createdNames.length && $('#stPush').checked) {
    const ids = (await api.usersList()).filter((u) => createdNames.includes(u.username)).map((u) => u.id);
    const devs = usSelected('.usDev');
    if (!devs.length) toast('تم الإنشاء. لم تُحدَّد هواتف للإرسال — حدّدها ثم اضغط «إرسال المحدّدين»');
    else { await pushUsersToPhones(ids, devs); out.innerHTML = msgs.join('<br>') + '<hr>' + $('#usPushOut').innerHTML; }
  } else if (createdNames.length) toast(`تم إنشاء ${createdNames.length} مستخدم`);
});

const usSelected = (cls) => [...document.querySelectorAll(cls + ':checked')].map((c) => c.value);
$('#usPush').addEventListener('click', () => pushUsersToPhones(usSelected('.usSel'), usSelected('.usDev')));
$('#usersBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const list = JSON.parse($('#usersBody').dataset.cache || '[]');
  const u = list.find((x) => x.id === b.dataset.id); if (!u) return;
  if (b.dataset.act === 'edit') {
    $('#usId').value = u.id; $('#usUsername').value = u.username; $('#usName').value = u.name; $('#usRole').value = u.role; $('#usCard').value = cardsOf(u.cardUid).join(','); $('#usCanSt').checked = !!u.canStudents; syncCanSt();
    $('#usUsername').disabled = true;
    $('#usPass').required = false;
    $('#usPassWrap').querySelector('input').placeholder = 'اتركه فارغاً لعدم التغيير';
    window.scrollTo(0, 0);
  } else if (b.dataset.act === 'del') {
    if (confirm(`حذف المستخدم "${u.name}"؟`)) {
      const r = await api.userDelete(u.id);
      if (r.ok) { audit('حذف مستخدم', `@${u.username} (${u.name})`); renderUsers(); } else toast('تعذّر الحذف');
    }
  }
});

(async function init() {
  db = await api.load();
  if (purgeOldAudit()) persist();
  // إغلاق أي محاضرة نسيها المستخدم مفتوحة من يوم سابق
  db.sessions.forEach((s) => { if (s.active && s.date !== todayStr()) { s.active = false; s.endTime = '—'; } });
  persist();
  applyTitle();
  $('#loginUser').focus();
})();
