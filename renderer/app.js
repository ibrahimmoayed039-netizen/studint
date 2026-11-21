const $ = (s) => document.querySelector(s);
let db = { students: [], attendance: [], sessions: [], users: [], schedule: [], settings: {} };
let currentUser = null;
const isAdmin = () => currentUser && currentUser.role === 'admin';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const normUid = (s) => String(s || '').trim().toUpperCase();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const persist = () => api.save(db);
const activeSession = () => db.sessions.find((s) => s.active && (isAdmin() || s.createdBy === currentUser.id));
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
  const allowed = isAdmin() ? ['scan', 'schedule', 'students', 'log', 'reports', 'users', 'settings'] : ['scan', 'schedule', 'log', 'reports'];
  if (!allowed.includes(name)) name = 'scan';
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === name));
  if (name === 'scan') { renderScan(); focusScan(); }
  if (name === 'schedule') renderSchedule();
  if (name === 'students') renderStudents();
  if (name === 'log') renderLog();
  if (name === 'reports') renderReports();
  if (name === 'users') renderUsers();
  if (name === 'settings') renderSettings();
}
function applyRoleNav() {
  document.querySelectorAll('.tab').forEach((btn) => {
    const roles = (btn.dataset.roles || '').split(',');
    btn.hidden = !roles.includes(currentUser.role);
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

function record(ses, student, status) {
  const rec = {
    id: uid(), sessionId: ses.id, subject: ses.subject, studentId: student.id,
    studentName: student.name, grade: student.grade,
    date: ses.date, time: nowTime(), status
  };
  db.attendance.push(rec);
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
  persist(); $('#sesSubject').value = ''; renderScan(); focusScan();
});

$('#sesEnd').addEventListener('click', () => {
  const ses = activeSession(); if (!ses) return;
  const { absent } = sessionStats(ses);
  if (!confirm(`إنهاء المحاضرة؟ عدد من لم يحضر: ${absent.length}`)) return;
  ses.active = false; ses.endTime = nowTime();
  persist(); renderScan();
});

function focusScan() { setTimeout(() => { if (activeSession()) $('#scanInput').focus(); }, 50); }
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
    fillGroups(); $('#sesLate').value = db.settings.lateMinutes ?? 10;
    renderTodaySchedule();
    return;
  }
  $('#todaySchedule').hidden = true;
  $('#sesTitle').textContent = ses.subject;
  $('#sesMeta').textContent = `بدأت ${ses.time.slice(0, 5)} — ${ses.group || 'كل الطلاب'} — التأخير بعد ${ses.lateMin} دقيقة`;
  const { recs, present, late, absent } = sessionStats(ses);
  $('#stPresent').textContent = present; $('#stLate').textContent = late; $('#stAbsent').textContent = absent.length;
  const recent = recs.slice(-10).reverse();
  $('#recentBody').innerHTML = recent.length
    ? recent.map((a) => `<tr><td>${a.time.slice(0, 5)}</td><td>${esc(a.studentName)}</td><td>${esc(a.grade)}</td><td>${statusBadge(a.status)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">لم يسجل أحد بعد</td></tr>';
}

/* ---------- الجدول الأسبوعي ---------- */
const DAY_NAMES = ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const myScheduleOf = () => db.schedule.filter((s) => s.ownerId === currentUser.id);

function resetScheduleForm() { $('#scheduleForm').reset(); $('#scId').value = ''; $('#scLate').value = 10; }
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
    lateMin: Number($('#scLate').value) || 0
  };
  if (id) {
    Object.assign(db.schedule.find((s) => s.id === id), entry);
  } else {
    db.schedule.push({ id: uid(), ownerId: currentUser.id, ownerName: currentUser.name, ...entry });
  }
  persist(); resetScheduleForm(); renderSchedule(); toast('تم الحفظ');
});

function renderSchedule() {
  fillScheduleGroups();
  const list = myScheduleOf().slice().sort((a, b) => a.day - b.day || a.time.localeCompare(b.time));
  $('#scheduleBody').innerHTML = list.length
    ? list.map((s, i) => `<tr>
        <td>${i + 1}</td><td>${DAY_NAMES[s.day]}</td><td>${esc(s.subject)}</td>
        <td>${esc(s.group) || 'الكل'}</td><td>${s.time}</td><td>${s.lateMin} د</td>
        <td>
          <button class="btn sm" data-act="edit" data-id="${s.id}">تعديل</button>
          <button class="btn sm danger" data-act="del" data-id="${s.id}">حذف</button>
        </td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">لا توجد حصص بعد</td></tr>';
}
$('#scheduleBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const s = db.schedule.find((x) => x.id === b.dataset.id); if (!s) return;
  if (b.dataset.act === 'edit') {
    $('#scId').value = s.id; $('#scDay').value = s.day; $('#scSubject').value = s.subject;
    $('#scGroup').value = s.group || ''; $('#scTime').value = s.time; $('#scLate').value = s.lateMin;
    window.scrollTo(0, 0);
  } else if (b.dataset.act === 'del') {
    if (confirm(`حذف حصة "${s.subject}"؟`)) { db.schedule = db.schedule.filter((x) => x.id !== s.id); persist(); renderSchedule(); }
  }
});

function renderTodaySchedule() {
  const todayDay = new Date().getDay();
  $('#todayDayName').textContent = DAY_NAMES[todayDay];
  const list = myScheduleOf().filter((s) => s.day === todayDay).sort((a, b) => a.time.localeCompare(b.time));
  const box = $('#todaySchedule');
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  $('#todayScheduleList').innerHTML = list.map((s) => {
    const already = db.sessions.some((ses) => ses.scheduleId === s.id && ses.date === todayStr());
    return `<div class="schedule-item">
      <div><b>${esc(s.subject)}</b><span>${s.time} — ${esc(s.group) || 'كل الطلاب'} — تأخير بعد ${s.lateMin} د</span></div>
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
    createdBy: currentUser.id, createdByName: currentUser.name, scheduleId: s.id
  });
  persist(); renderScan(); focusScan();
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
  r.rows.forEach((row) => {
    let cardUid = normUid(row.cardUid);
    if (cardUid && db.students.some((s) => s.cardUid === cardUid)) { cardUid = ''; uidConflicts++; }
    db.students.push({ id: uid(), name: row.name, grade: row.grade || '', cardUid, photo: '', createdAt: Date.now() });
    added++;
  });
  persist(); renderStudents();
  toast(`تمت إضافة ${added} طالب${uidConflicts ? ` (تم تجاهل رقم البطاقة لـ ${uidConflicts} بسبب التكرار)` : ''}`);
});

$('#studentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#stId').value;
  const name = $('#stName').value.trim();
  const grade = $('#stGrade').value.trim();
  const cardUid = normUid($('#stUid').value);
  const photo = $('#stPhoto').value || '';
  if (cardUid && db.students.some((s) => s.cardUid === cardUid && s.id !== id)) return toast('رقم البطاقة مستخدم لطالب آخر');
  if (id) {
    const s = db.students.find((x) => x.id === id);
    Object.assign(s, { name, grade, cardUid, photo });
    db.attendance.forEach((a) => { if (a.studentId === id) { a.studentName = name; a.grade = grade; } });
  } else {
    db.students.push({ id: uid(), name, grade, cardUid, photo, createdAt: Date.now() });
  }
  persist(); resetStudentForm(); renderStudents(); toast('تم الحفظ');
});

function renderStudents() {
  const q = $('#stSearch').value.trim().toLowerCase();
  const list = db.students.filter((s) => !q || [s.name, s.grade, s.cardUid].some((v) => String(v || '').toLowerCase().includes(q)));
  $('#studentsBody').innerHTML = list.length
    ? list.map((s, i) => `<tr>
        <td>${i + 1}</td>
        <td>${s.photo ? `<img class="thumb" src="${s.photo}" alt="">` : ''}</td>
        <td>${esc(s.name)}</td><td>${esc(s.grade)}</td>
        <td class="ltr">${esc(s.cardUid) || '— بدون بطاقة —'}</td>
        <td>
          <button class="btn sm" data-act="manual" data-id="${s.id}">حضور يدوي</button>
          <button class="btn sm" data-act="edit" data-id="${s.id}">تعديل</button>
          <button class="btn sm danger" data-act="del" data-id="${s.id}">حذف</button>
        </td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">لا يوجد طلاب</td></tr>';
}

$('#studentsBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const s = db.students.find((x) => x.id === b.dataset.id); if (!s) return;
  if (b.dataset.act === 'edit') {
    resetStudentForm();
    $('#stId').value = s.id; $('#stName').value = s.name; $('#stGrade').value = s.grade; $('#stUid').value = s.cardUid || '';
    setPhotoPreview(s.photo || '');
    window.scrollTo(0, 0);
  } else if (b.dataset.act === 'del') {
    if (confirm(`حذف الطالب "${s.name}"؟ (يبقى سجل حضوره السابق)`)) {
      db.students = db.students.filter((x) => x.id !== s.id); persist(); renderStudents();
    }
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
    ? rows.map((a, i) => `<tr><td>${i + 1}</td><td>${esc(a.studentName)}</td><td>${esc(a.grade)}</td><td>${esc(a.subject || '—')}</td><td>${a.time.slice(0, 5)}</td><td>${statusBadge(a.status)}</td>
        <td><button class="btn sm danger" data-id="${a.id}">حذف</button></td></tr>`).join('')
    : '<tr><td colspan="7" class="empty">لا توجد سجلات</td></tr>';
}
$('#logBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (confirm('حذف هذا السجل؟')) { db.attendance = db.attendance.filter((a) => a.id !== b.dataset.id); persist(); renderLog(); }
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

/* ---------- الإعدادات ---------- */
async function renderSettings() {
  $('#setSchool').value = db.settings.schoolName || '';
  $('#setLate').value = db.settings.lateMinutes ?? 10;
  $('#setBackupDays').value = db.settings.backupKeepDays ?? 30;
  $('#dataPath').textContent = await api.dataPath();
  $('#backupsPath').textContent = await api.backupsDir();
}
$('#setSave').addEventListener('click', () => {
  db.settings.schoolName = $('#setSchool').value.trim() || 'حضور الطلبة';
  db.settings.lateMinutes = Number($('#setLate').value) || 0;
  db.settings.backupKeepDays = Math.max(1, Number($('#setBackupDays').value) || 30);
  persist(); applyTitle(); toast('تم حفظ الإعدادات');
});
$('#bkOpenFolder').addEventListener('click', () => api.openBackupsFolder());
$('#bkExport').addEventListener('click', async () => { if (await api.exportBackup()) toast('تم تصدير النسخة'); });
$('#bkImport').addEventListener('click', async () => {
  if (!confirm('سيتم استبدال كل البيانات الحالية بالنسخة المستوردة. متابعة؟')) return;
  const d = await api.importBackup();
  if (d) { db = d; applyTitle(); renderScan(); toast('تم الاستيراد'); } else toast('تعذّر الاستيراد');
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
  currentUser = r.user;
  $('#loginScreen').hidden = true;
  $('#mainNav').hidden = false;
  $('#mainArea').hidden = false;
  applyRoleNav();
  switchTab('scan');
});
$('#logoutBtn').addEventListener('click', () => {
  currentUser = null;
  $('#loginUser').value = ''; $('#loginPass').value = ''; $('#loginError').hidden = true;
  $('#loginScreen').hidden = false;
  $('#mainNav').hidden = true;
  $('#mainArea').hidden = true;
});

/* ---------- المستخدمون ---------- */
function resetUserForm() {
  $('#userForm').reset(); $('#usId').value = '';
  $('#usUsername').disabled = false;
  $('#usPass').required = true;
  $('#usPassWrap').querySelector('input').placeholder = '';
}
$('#usCancel').addEventListener('click', resetUserForm);

$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('#usId').value;
  const username = $('#usUsername').value.trim();
  const name = $('#usName').value.trim();
  const role = $('#usRole').value;
  const pass = $('#usPass').value;
  if (id) {
    const r = await api.userUpdate({ id, name, role });
    if (!r.ok) return toast('تعذّر التحديث');
    if (pass) {
      const r2 = await api.userResetPassword({ id, password: pass });
      if (!r2.ok) return toast('تعذّر تغيير كلمة المرور');
    }
    toast('تم التحديث');
  } else {
    if (!pass) return toast('كلمة المرور مطلوبة');
    const r = await api.userCreate({ username, password: pass, name, role });
    if (!r.ok) return toast(r.error === 'exists' ? 'اسم المستخدم مستخدم بالفعل' : 'تعذّر الإنشاء');
    toast('تم إنشاء المستخدم');
  }
  resetUserForm(); renderUsers();
});

async function renderUsers() {
  const list = await api.usersList();
  $('#usersBody').innerHTML = list.length
    ? list.map((u, i) => `<tr>
        <td>${i + 1}</td><td class="ltr">${esc(u.username)}</td><td>${esc(u.name)}</td>
        <td>${u.role === 'admin' ? 'مدير' : 'مدرّس'}</td>
        <td>
          <button class="btn sm" data-act="edit" data-id="${u.id}">تعديل</button>
          ${u.id === 'admin' ? '' : `<button class="btn sm danger" data-act="del" data-id="${u.id}">حذف</button>`}
        </td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">لا يوجد مستخدمون</td></tr>';
  $('#usersBody').dataset.cache = JSON.stringify(list);
}
$('#usersBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const list = JSON.parse($('#usersBody').dataset.cache || '[]');
  const u = list.find((x) => x.id === b.dataset.id); if (!u) return;
  if (b.dataset.act === 'edit') {
    $('#usId').value = u.id; $('#usUsername').value = u.username; $('#usName').value = u.name; $('#usRole').value = u.role;
    $('#usUsername').disabled = true;
    $('#usPass').required = false;
    $('#usPassWrap').querySelector('input').placeholder = 'اتركه فارغاً لعدم التغيير';
    window.scrollTo(0, 0);
  } else if (b.dataset.act === 'del') {
    if (confirm(`حذف المستخدم "${u.name}"؟`)) {
      const r = await api.userDelete(u.id);
      if (r.ok) renderUsers(); else toast('تعذّر الحذف');
    }
  }
});

(async function init() {
  db = await api.load();
  // إغلاق أي محاضرة نسيها المستخدم مفتوحة من يوم سابق
  db.sessions.forEach((s) => { if (s.active && s.date !== todayStr()) { s.active = false; s.endTime = '—'; } });
  persist();
  applyTitle();
  $('#loginUser').focus();
})();
