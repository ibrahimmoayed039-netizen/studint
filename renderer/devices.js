/* تبويب «الأجهزة»: التحكم بجداول هواتف الأندرويد عبر الشبكة المحلية.
   كل الاتصالات تمر عبر main.js (IPC) والرمز لا يصل للواجهة بعد حفظه. */
/* ---------- حفظ المجموعات والمواد المُدخلة سابقاً لإعادة استعمالها ---------- */
const dvMemGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
function dvMemAdd(k, v) {
  v = String(v || '').trim(); if (!v) return;
  const list = dvMemGet(k).filter((x) => x !== v); list.unshift(v);
  try { localStorage.setItem(k, JSON.stringify(list.slice(0, 100))); } catch {}
}
function fillDvSuggestions() {
  const items = dvData ? dvData.items : [];
  const uniq = (a) => [...new Set(a.map((x) => String(x || '').trim()).filter(Boolean))];
  const groups = uniq([...dvMemGet('dvGroups'), ...items.map((x) => x.group), ...(typeof db !== 'undefined' ? db.students.map((s) => s.grade) : [])]);
  const subjects = uniq([...dvMemGet('dvSubjects'), ...items.map((x) => x.subject)]);
  const opt = (a) => a.map((x) => `<option value="${esc(x)}"></option>`).join('');
  $('#dvGroupList').innerHTML = opt(groups);
  $('#dvSubjectList').innerHTML = opt(subjects);
}

let dvDevices = [];
let dvCur = null;      // الجهاز المفتوح
let dvData = null;     // آخر رد من GET /api/schedule

/* رسالة خطأ داخل الصفحة بدل alert (لا تُفقد التركيز) */
function dvAlert(msg) {
  const el = $('#dvMsg'); el.textContent = msg; el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast(msg.length > 40 ? 'تعذّر الحفظ — انظر الرسالة الحمراء' : msg);
}
const dvClearMsg = () => { $('#dvMsg').hidden = true; };
const dvErr = (r) => (r && (r.error || (r.data && r.data.error))) || 'فشل الطلب';
const dvCall = (id, method, path, body) => api.lanCall({ id, method, path, body });

async function renderDevices() {
  dvDevices = await api.lanList();
  drawDevices();
  dvDevices.forEach((d) => api.lanPing(d.id).then((r) => {
    const el = document.getElementById('dvst-' + d.id);
    if (el) el.textContent = r.online ? '🟢 متصل' : '🔴 غير متاح';
  }));
}

function drawDevices() {
  $('#dvBody').innerHTML = dvDevices.length
    ? dvDevices.map((d, i) => `<tr>
        <td>${i + 1}</td><td>${esc(d.name)}</td><td dir="ltr">${esc(d.host)}:${d.port}</td>
        <td id="dvst-${d.id}">…</td>
        <td>
          <button class="btn sm primary" data-act="open" data-id="${d.id}">🗓️ فتح الجدول</button>
          <button class="btn sm" data-act="tok" data-id="${d.id}">🔑 تغيير الرمز</button>
          <button class="btn sm danger" data-act="rm" data-id="${d.id}">حذف</button>
        </td></tr>`).join('')
    : '<tr><td colspan="5">لا توجد أجهزة. أضف هاتفاً أو استخدم البحث التلقائي.</td></tr>';
}

$('#dvBody').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const d = dvDevices.find((x) => x.id === b.dataset.id); if (!d) return;
  if (b.dataset.act === 'open') return openDevice(d.id);
  if (b.dataset.act === 'rm') {
    if (!confirm(`إزالة الجهاز «${d.name}» من القائمة؟ (لا يؤثر على الهاتف)`)) return;
    await api.lanRemove(d.id);
    if (dvCur === d.id) closeDevice();
    audit('إزالة جهاز', d.name);
    return renderDevices();
  }
  if (b.dataset.act === 'tok') {
    $('#tokTitle').textContent = `🔑 رمز الاتصال لـ «${d.name}»`;
    $('#tokInput').value = ''; $('#tokModal').hidden = false; $('#tokInput').focus();
    tokDevice = d.id;
  }
});

$('#dvAdd').addEventListener('click', async () => {
  const r = await api.lanAdd({ name: $('#dvName').value, host: $('#dvHost').value, port: $('#dvPort').value, token: $('#dvToken').value });
  if (!r.ok) return toast(r.error);
  audit('إضافة جهاز', $('#dvName').value.trim() + ' — ' + $('#dvHost').value.trim());
  $('#dvName').value = ''; $('#dvHost').value = ''; $('#dvToken').value = '';
  toast('تمت إضافة الجهاز'); renderDevices();
});

$('#dvScan').addEventListener('click', async () => {
  const btn = $('#dvScan'); btn.disabled = true; btn.textContent = '⏳ جارٍ البحث...';
  const found = await api.lanScan();
  btn.disabled = false; btn.textContent = '🔍 بحث تلقائي في الشبكة';
  const fresh = found.filter((f) => !dvDevices.some((d) => d.host === f.host && d.port === f.port));
  $('#dvFound').innerHTML = fresh.length
    ? '<p class="hint">أجهزة وُجدت (أدخل رمز الاتصال الظاهر في كل هاتف):</p>' + fresh.map((f, i) => `
        <div class="row" data-i="${i}" style="align-items:center;margin:6px 0">
          <span dir="ltr">${esc(f.host)}:${f.port}</span>
          <input class="dvf-name" value="${esc(f.school)}" placeholder="الاسم">
          <input class="dvf-tok" dir="ltr" maxlength="6" inputmode="numeric" placeholder="الرمز" style="width:90px">
          <button class="btn sm primary" data-host="${esc(f.host)}" data-port="${f.port}">إضافة</button>
        </div>`).join('')
    : '<p class="hint">لم يُعثر على هواتف جديدة. تأكد أن الخيار مفعّل في الهاتف وأنه على نفس الشبكة (أو أضفه يدوياً بعنوانه).</p>';
});

$('#dvFound').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-host]'); if (!b) return;
  const row = b.closest('.row');
  const name = row.querySelector('.dvf-name').value.trim() || b.dataset.host;
  const r = await api.lanAdd({ name, host: b.dataset.host, port: b.dataset.port, token: row.querySelector('.dvf-tok').value });
  if (!r.ok) return toast(r.error);
  audit('إضافة جهاز', name + ' — ' + b.dataset.host);
  row.remove(); toast('تمت إضافة الجهاز'); renderDevices();
});

/* ---------- محرر جدول جهاز ---------- */
function closeDevice() { dvCur = null; dvData = null; $('#dvEditor').hidden = true; }
$('#dvClose').addEventListener('click', closeDevice);
$('#dvRefresh').addEventListener('click', () => dvCur && openDevice(dvCur, $('#dvOwner').value));
$('#dvOwner').addEventListener('change', drawItems);

async function openDevice(id, keepOwner) {
  dvClearMsg();
  const r = await dvCall(id, 'GET', '/api/schedule');
  if (r.status !== 200 || !r.data || !r.data.ok) return dvAlert(dvErr(r));
  dvCur = id; dvData = r.data;
  const d = dvDevices.find((x) => x.id === id);
  $('#dvTitle').textContent = `جدول «${d ? d.name : ''}» — ${dvData.school || ''}`;
  $('#dvOwner').innerHTML = dvData.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} (${u.role === 'admin' ? 'مدير' : 'مدرّس'})</option>`).join('');
  if (keepOwner && dvData.users.some((u) => u.id === keepOwner)) $('#dvOwner').value = keepOwner;
  $('#dvEditor').hidden = false; $('#dvCopyBox').hidden = true;
  resetDvForm(); drawItems(); fillDvSuggestions(); loadPhoneUsers();
  $('#dvEditor').scrollIntoView({ behavior: 'smooth' });
}

const dvItemsOfOwner = () => (dvData ? dvData.items.filter((x) => x.ownerId === $('#dvOwner').value) : [])
  .slice().sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));

function drawItems() {
  const list = dvItemsOfOwner();
  $('#dvItems').innerHTML = list.length
    ? list.map((s, i) => `<tr>
        <td>${i + 1}</td><td>${DAY_NAMES[s.day]}</td><td>${esc(s.subject)}</td><td>${esc(s.group) || 'الكل'}</td>
        <td>${s.start} – ${s.endEff}</td><td>${s.lateMin} د</td><td>${s.auto ? '⚡' : '—'}</td>
        <td>
          <button class="btn sm" data-act="edit" data-id="${esc(s.id)}">تعديل</button>
          <button class="btn sm danger" data-act="del" data-id="${esc(s.id)}">حذف</button>
        </td></tr>`).join('')
    : '<tr><td colspan="8">لا توجد حصص لهذا المستخدم.</td></tr>';
}

function resetDvForm() {
  $('#dvForm').reset(); $('#dvId').value = ''; $('#dvLate').value = 10; $('#dvAuto').checked = true;
}
$('#dvReset').addEventListener('click', resetDvForm);

$('#dvItems').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b || !dvData) return;
  const s = dvData.items.find((x) => x.id === b.dataset.id); if (!s) return;
  if (b.dataset.act === 'edit') {
    $('#dvId').value = s.id; $('#dvDay').value = s.day; $('#dvSubject').value = s.subject; $('#dvGroup').value = s.group;
    $('#dvStart').value = s.start; $('#dvEnd').value = s.end; $('#dvLate').value = s.lateMin; $('#dvAuto').checked = s.auto;
    $('#dvForm').scrollIntoView({ behavior: 'smooth' });
  } else if (confirm(`حذف حصة «${s.subject}» من الهاتف؟`)) {
    const r = await dvCall(dvCur, 'POST', '/api/schedule/delete', { id: s.id });
    if (r.status !== 200) return dvAlert(dvErr(r));
    audit('حذف حصة من هاتف', `${devName()} — ${DAY_NAMES[s.day]} ${s.start} ${s.subject}`);
    toast('تم الحذف'); openDevice(dvCur, $('#dvOwner').value);
  }
});

const devName = () => { const d = dvDevices.find((x) => x.id === dvCur); return d ? d.name : ''; };

$('#dvForm').addEventListener('submit', async (e) => {
  e.preventDefault(); dvClearMsg();
  const item = {
    id: $('#dvId').value || undefined, ownerId: $('#dvOwner').value, day: Number($('#dvDay').value),
    subject: $('#dvSubject').value.trim(), group: $('#dvGroup').value.trim(), start: $('#dvStart').value,
    end: $('#dvEnd').value || '', lateMin: Number($('#dvLate').value) || 0, auto: $('#dvAuto').checked
  };
  if (item.end && item.end <= item.start) return toast('وقت الانتهاء يجب أن يكون بعد وقت البدء');
  const r = await dvCall(dvCur, 'POST', '/api/schedule/save', { item });
  if (r.status !== 200) return dvAlert(dvErr(r));
  audit(item.id ? 'تعديل حصة في هاتف' : 'إضافة حصة في هاتف', `${devName()} — ${DAY_NAMES[item.day]} ${item.start} ${item.subject}`);
  dvMemAdd('dvGroups', item.group); dvMemAdd('dvSubjects', item.subject);
  toast('تم الحفظ في الهاتف'); openDevice(dvCur, item.ownerId);
});

/* ---------- نسخ جدول إلى جهاز آخر ---------- */
$('#dvCopy').addEventListener('click', () => {
  const others = dvDevices.filter((d) => d.id !== dvCur);
  if (!others.length) return toast('أضف جهازاً آخر أولاً');
  $('#dvTarget').innerHTML = others.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  $('#dvCopyBox').hidden = false; loadTargetUsers();
});
$('#dvCopyCancel').addEventListener('click', () => { $('#dvCopyBox').hidden = true; });
$('#dvTarget').addEventListener('change', loadTargetUsers);

async function loadTargetUsers() {
  $('#dvTargetOwner').innerHTML = '';
  const r = await dvCall($('#dvTarget').value, 'GET', '/api/schedule');
  if (r.status !== 200 || !r.data || !r.data.ok) return dvAlert(dvErr(r));
  $('#dvTargetOwner').innerHTML = r.data.users.map((u) => `<option value="${esc(u.id)}">${esc(u.name)} (${u.role === 'admin' ? 'مدير' : 'مدرّس'})</option>`).join('');
}

$('#dvCopyGo').addEventListener('click', async () => {
  const items = dvItemsOfOwner();
  if (!items.length) return toast('لا توجد حصص لنسخها');
  const tid = $('#dvTarget').value, tOwner = $('#dvTargetOwner').value;
  const tName = (dvDevices.find((d) => d.id === tid) || {}).name || '';
  if (!tOwner) return toast('اختر مستخدم الهدف');
  if (!confirm(`سيُستبدل جدول المستخدم المحدد في «${tName}» بـ ${items.length} حصة. متابعة؟`)) return;
  const r = await dvCall(tid, 'POST', '/api/schedule/replace', {
    ownerId: tOwner,
    items: items.map((s) => ({ day: s.day, subject: s.subject, group: s.group, start: s.start, end: s.end, lateMin: s.lateMin, auto: s.auto }))
  });
  if (r.status !== 200) return dvAlert(dvErr(r));
  audit('نسخ جدول إلى هاتف', `${devName()} ← ${tName} (${items.length} حصة)`);
  toast('تم النسخ'); $('#dvCopyBox').hidden = true;
});

/* ---------- نافذة تغيير الرمز (بديل prompt غير المدعومة في Electron) ---------- */
let tokDevice = null;
const tokClose = () => { $('#tokModal').hidden = true; tokDevice = null; };
$('#tokCancel').addEventListener('click', tokClose);
$('#tokInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#tokOk').click(); if (e.key === 'Escape') tokClose(); });
$('#tokOk').addEventListener('click', async () => {
  if (!tokDevice) return;
  const r = await api.lanSetToken({ id: tokDevice, token: $('#tokInput').value.trim() });
  if (!r.ok) return toast(r.error);
  tokClose(); toast('تم حفظ الرمز');
});


/* ---------- مستخدمو الهاتف (إنشاء/تحديث/حذف من الحاسوب) ---------- */
let dvPhoneUsers = [];
let pwTarget = null;
const lastAdminErr = (r) => JSON.stringify(r).includes('آخر مدير');
async function loadPhoneUsers() {
  $('#dvUsers').innerHTML = '<tr><td colspan="5">…</td></tr>';
  const r = await dvCall(dvCur, 'GET', '/api/users');
  if (r.status === 404) { $('#dvUsers').innerHTML = '<tr><td colspan="5">إدارة المستخدمين تحتاج نسخة الأندرويد v18 أو أحدث على هذا الهاتف.</td></tr>'; return; }
  if (r.status !== 200 || !r.data || !r.data.ok) { $('#dvUsers').innerHTML = `<tr><td colspan="5">${esc(dvErr(r))}</td></tr>`; return; }
  dvPhoneUsers = r.data.users;
  $('#dvUsers').innerHTML = dvPhoneUsers.map((u) => `<tr>
    <td dir="ltr">${esc(u.username)}</td><td>${esc(u.name)}</td><td>${u.role === 'admin' ? 'مدير' : 'مدرّس'}</td>
    <td>${u.cardUid ? '💳×' + u.cardUid.split(',').filter(Boolean).length : '—'}</td>
    <td><button class="btn sm" data-act="upw" data-id="${esc(u.id)}">🔑 كلمة المرور</button>
        <button class="btn sm" data-act="uedit" data-id="${esc(u.id)}">تعديل</button>
        <button class="btn sm danger" data-act="udel" data-id="${esc(u.id)}">حذف</button></td></tr>`).join('');
}
$('#dvUsers').addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const u = dvPhoneUsers.find((x) => x.id === b.dataset.id); if (!u) return;
  if (b.dataset.act === 'upw') {
    pwTarget = u; $('#dvPwTitle').textContent = `🔑 كلمة مرور «${u.name}» (@${u.username})`;
    $('#dvPw1').value = ''; $('#dvPw2').value = ''; $('#dvPwErr').textContent = '';
    $('#dvPwDlg').showModal(); $('#dvPw1').focus();
  } else if (b.dataset.act === 'uedit') {
    $('#dvuUsername').value = u.username; $('#dvuName').value = u.name; $('#dvuRole').value = u.role; $('#dvuPass').value = '';
    $('#dvuPass').focus();
  } else if (confirm(`حذف المستخدم «${u.name}» من الهاتف؟`)) {
    let r = await dvCall(dvCur, 'POST', '/api/users/delete', { id: u.id });
    if (r.status === 409 && lastAdminErr(r) && confirm('هذا آخر مدير في الهاتف. إن حذفته فلن يوجد مدير على الهاتف إلى أن ترسل مديراً من الحاسوب.\nهل تريد الحذف فعلاً؟'))
      r = await dvCall(dvCur, 'POST', '/api/users/delete', { id: u.id, force: true });
    if (r.status !== 200) return dvAlert(dvErr(r));
    audit('حذف مستخدم من هاتف', `${devName()} — @${u.username}`);
    toast('تم الحذف'); loadPhoneUsers();
  }
});
$('#dvUserForm').addEventListener('submit', async (e) => {
  e.preventDefault(); dvClearMsg();
  const username = $('#dvuUsername').value.trim();
  const exists = dvPhoneUsers.some((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!exists && !$('#dvuPass').value) return toast('كلمة المرور مطلوبة للمستخدم الجديد');
  const body = { id: dvCur, username, name: $('#dvuName').value, role: $('#dvuRole').value, password: $('#dvuPass').value };
  let r = await api.lanPhoneUser(body);
  if (r.status === 409 && lastAdminErr(r) && confirm('هذا آخر مدير في الهاتف. بعد تحويله إلى مدرّس لن يوجد مدير على الهاتف إلى أن ترسل مديراً من الحاسوب (إنشاء مستخدم بدور «مدير»).\nهل تريد تغيير الصلاحية فعلاً؟'))
    r = await api.lanPhoneUser({ ...body, force: true });
  if (r.status !== 200 || !r.data || !r.data.ok) return dvAlert(dvErr(r));
  audit(r.data.created ? 'إنشاء مستخدم في هاتف' : 'تحديث مستخدم في هاتف', `${devName()} — @${username}`);
  $('#dvUserForm').reset(); toast(r.data.created ? 'أُنشئ المستخدم في الهاتف' : 'تم تحديث المستخدم'); loadPhoneUsers();
});

$('#dvPwCancel').addEventListener('click', () => $('#dvPwDlg').close());
$('#dvPwOk').addEventListener('click', async () => {
  const p1 = $('#dvPw1').value, p2 = $('#dvPw2').value;
  if (!p1) return ($('#dvPwErr').textContent = 'اكتب كلمة المرور الجديدة');
  if (p1 !== p2) return ($('#dvPwErr').textContent = 'كلمتا المرور غير متطابقتين');
  const u = pwTarget; if (!u) return;
  const r = await api.lanPhoneUser({ id: dvCur, username: u.username, name: u.name, role: u.role, password: p1 });
  if (r.status !== 200 || !r.data || !r.data.ok) return ($('#dvPwErr').textContent = dvErr(r));
  $('#dvPwDlg').close();
  audit('تغيير كلمة مرور مستخدم في هاتف', `${devName()} — @${u.username}`);
  toast('تم تغيير كلمة المرور على الهاتف');
});
