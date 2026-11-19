const $ = (s) => document.querySelector(s);
let db = { students: [], attendance: [], sessions: [], settings: {} };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const normUid = (s) => String(s || '').trim().toUpperCase();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const persist = () => api.save(db);
const activeSession = () => db.sessions.find((s) => s.active);
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
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((x) => x.classList.toggle('active', x.id === name));
  if (name === 'scan') { renderScan(); focusScan(); }
  if (name === 'students') renderStudents();
  if (name === 'log') renderLog();
  if (name === 'reports') renderReports();
  if (name === 'settings') renderSettings();
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
    startTs: d.getTime(), active: true
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

function showResult(cls, title, sub) {
  const r = $('#scanResult');
  r.className = 'result ' + cls;
  r.innerHTML = `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
}

function handleScan(cardUid) {
  const ses = activeSession(); if (!ses) return;
  const st = db.students.find((s) => s.cardUid === cardUid);
  if (!st) { beep(220, 400); return showResult('bad', 'بطاقة غير مسجلة', 'رقم البطاقة: ' + cardUid); }
  if (ses.group && st.grade !== ses.group) {
    beep(220, 400);
    return showResult('bad', st.name, `ليس من مجموعة هذه المحاضرة (${ses.group})`);
  }
  const already = db.attendance.find((a) => a.sessionId === ses.id && a.studentId === st.id);
  if (already) { beep(500, 200); return showResult('dup', st.name, `سُجّل مسبقاً في هذه المحاضرة الساعة ${already.time.slice(0, 5)}`); }
  const status = statusFor(ses);
  record(ses, st, status);
  beep(status === 'late' ? 600 : 900, 180);
  showResult(status === 'late' ? 'late' : 'ok', st.name, `${st.grade} — ${status === 'late' ? 'متأخر' : 'تم تسجيل الحضور'}`);
  renderScan();
}

function renderScan() {
  const ses = activeSession();
  $('#noSession').hidden = !!ses;
  $('#activeSession').hidden = !ses;
  if (!ses) { fillGroups(); $('#sesLate').value = db.settings.lateMinutes ?? 10; return; }
  $('#sesTitle').textContent = ses.subject;
  $('#sesMeta').textContent = `بدأت ${ses.time.slice(0, 5)} — ${ses.group || 'كل الطلاب'} — التأخير بعد ${ses.lateMin} دقيقة`;
  const { recs, present, late, absent } = sessionStats(ses);
  $('#stPresent').textContent = present; $('#stLate').textContent = late; $('#stAbsent').textContent = absent.length;
  const recent = recs.slice(-10).reverse();
  $('#recentBody').innerHTML = recent.length
    ? recent.map((a) => `<tr><td>${a.time.slice(0, 5)}</td><td>${esc(a.studentName)}</td><td>${esc(a.grade)}</td><td>${statusBadge(a.status)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="empty">لم يسجل أحد بعد</td></tr>';
}

/* ---------- الطلاب ---------- */
function resetStudentForm() { $('#studentForm').reset(); $('#stId').value = ''; }
$('#stCancel').addEventListener('click', resetStudentForm);
$('#stUid').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.value = normUid(e.target.value); } });
$('#stSearch').addEventListener('input', renderStudents);

$('#studentForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('#stId').value;
  const name = $('#stName').value.trim();
  const grade = $('#stGrade').value.trim();
  const cardUid = normUid($('#stUid').value);
  if (cardUid && db.students.some((s) => s.cardUid === cardUid && s.id !== id)) return toast('رقم البطاقة مستخدم لطالب آخر');
  if (id) {
    const s = db.students.find((x) => x.id === id);
    Object.assign(s, { name, grade, cardUid });
    db.attendance.forEach((a) => { if (a.studentId === id) { a.studentName = name; a.grade = grade; } });
  } else {
    db.students.push({ id: uid(), name, grade, cardUid, createdAt: Date.now() });
  }
  persist(); resetStudentForm(); renderStudents(); toast('تم الحفظ');
});

function renderStudents() {
  const q = $('#stSearch').value.trim().toLowerCase();
  const list = db.students.filter((s) => !q || [s.name, s.grade, s.cardUid].some((v) => String(v || '').toLowerCase().includes(q)));
  $('#studentsBody').innerHTML = list.length
    ? list.map((s, i) => `<tr>
        <td>${i + 1}</td><td>${esc(s.name)}</td><td>${esc(s.grade)}</td>
        <td class="ltr">${esc(s.cardUid) || '— بدون بطاقة —'}</td>
        <td>
          <button class="btn sm" data-act="manual" data-id="${s.id}">حضور يدوي</button>
          <button class="btn sm" data-act="edit" data-id="${s.id}">تعديل</button>
          <button class="btn sm danger" data-act="del" data-id="${s.id}">حذف</button>
        </td></tr>`).join('')
    : '<tr><td colspan="5" class="empty">لا يوجد طلاب</td></tr>';
}

$('#studentsBody').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const s = db.students.find((x) => x.id === b.dataset.id); if (!s) return;
  if (b.dataset.act === 'edit') {
    $('#stId').value = s.id; $('#stName').value = s.name; $('#stGrade').value = s.grade; $('#stUid').value = s.cardUid || '';
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
  const list = db.sessions.filter((s) => s.date === d);
  sel.innerHTML = '<option value="">كل المحاضرات</option>' + list.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(sessionLabel(s))}</option>`).join('');
}
function logRows() {
  const d = $('#logDate').value || todayStr();
  const sid = $('#logSession').value;
  const q = $('#logSearch').value.trim().toLowerCase();
  return db.attendance.filter((a) => a.date === d && (!sid || a.sessionId === sid) && (!q || a.studentName.toLowerCase().includes(q)));
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
  if (!$('#repDate').value) $('#repDate').value = todayStr();
  const d = $('#repDate').value;
  const sel = $('#repSession'); const cur = sel.value;
  const list = db.sessions.filter((s) => s.date === d);
  sel.innerHTML = list.length
    ? list.map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(sessionLabel(s))}</option>`).join('')
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

/* ---------- الإعدادات ---------- */
async function renderSettings() {
  $('#setSchool').value = db.settings.schoolName || '';
  $('#setLate').value = db.settings.lateMinutes ?? 10;
  $('#dataPath').textContent = await api.dataPath();
}
$('#setSave').addEventListener('click', () => {
  db.settings.schoolName = $('#setSchool').value.trim() || 'حضور الطلبة';
  db.settings.lateMinutes = Number($('#setLate').value) || 0;
  persist(); applyTitle(); toast('تم حفظ الإعدادات');
});
$('#bkExport').addEventListener('click', async () => { if (await api.exportBackup()) toast('تم تصدير النسخة'); });
$('#bkImport').addEventListener('click', async () => {
  if (!confirm('سيتم استبدال كل البيانات الحالية بالنسخة المستوردة. متابعة؟')) return;
  const d = await api.importBackup();
  if (d) { db = d; applyTitle(); renderScan(); toast('تم الاستيراد'); } else toast('تعذّر الاستيراد');
});

function applyTitle() { $('#appTitle').textContent = db.settings.schoolName || 'حضور الطلبة'; }

(async function init() {
  db = await api.load();
  // إغلاق أي محاضرة نسيها المستخدم مفتوحة من يوم سابق
  db.sessions.forEach((s) => { if (s.active && s.date !== todayStr()) { s.active = false; s.endTime = '—'; } });
  persist();
  applyTitle(); renderScan(); focusScan();
})();
