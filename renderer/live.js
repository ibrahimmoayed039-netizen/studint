/* تبويب «المباشر»: أي المراحل/القاعات مشغولة الآن وكم طالب حاضر.
   يجلب GET /api/live من كل هاتف مضاف (عبر main.js) ويضيف المحاضرات الجارية على هذا الحاسوب. */
let lvTimer = null;
let lvClockTimer = null;
let lvSnap = null;      // آخر لقطة: { ts, devices:[...], local:[...] }
let lvBusy = false;

const lvMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const lvFmtDur = (m) => { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}س ${m % 60}د` : `${m}د`; };

/* جلسات هذا الحاسوب بنفس شكل جلسات الهاتف */
function lvLocalSessions() {
  if (typeof db === 'undefined' || !db.sessions) return [];
  const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
  return db.sessions.filter((s) => s.active).map((s) => {
    const recs = db.attendance.filter((a) => a.sessionId === s.id);
    const sched = (db.schedule || []).find((x) => x.id === s.scheduleId);
    const end = sched ? entryEnd(sched) : fromMin(toMin(s.time) + lectureLen());
    return {
      id: s.id, subject: s.subject, group: s.group || '', start: s.time, startTs: s.startTs, end,
      teacher: s.createdByName || '', present: recs.filter((a) => a.status === 'present').length,
      late: recs.filter((a) => a.status === 'late').length,
      expected: db.students.filter((st) => !s.group || st.grade === s.group).length,
      recent: recs.slice().sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 5).map((a) => ({ name: a.studentName, time: a.time, status: a.status })),
      nowTs: now.getTime(), now: fromMin(nowMin)
    };
  });
}

async function lvFetch() {
  const devs = await api.lanList();
  const devices = await Promise.all(devs.map(async (d) => {
    const r = await dvCall(d.id, 'GET', '/api/live');
    if (r.status === 200 && r.data && r.data.ok) return { dev: d, state: 'ok', data: r.data };
    if (r.status === 404) return { dev: d, state: 'old' };
    if (r.status === 401) return { dev: d, state: 'auth' };
    return { dev: d, state: 'off', err: r.error || '' };
  }));
  const now = new Date();
  const local = lvLocalSessions();
  lvSnap = { ts: now.getTime(), devices, local, nowMin: now.getHours() * 60 + now.getMinutes() };
}

/* كل الجلسات الجارية بشكل موحّد: { place, session, nowMin } */
function lvAllSessions() {
  const out = [];
  if (!lvSnap) return out;
  lvSnap.devices.forEach((x) => {
    if (x.state !== 'ok') return;
    const nm = lvMin(x.data.now);
    x.data.sessions.forEach((s) => out.push({ place: x.dev.name, s, nowMin: nm, nowTs: x.data.nowTs }));
  });
  lvSnap.local.forEach((s) => out.push({ place: 'هذا الحاسوب', s, nowMin: lvSnap.nowMin, nowTs: s.nowTs }));
  return out;
}

const lvPct = (s) => s.expected ? Math.round(((s.present + s.late) / s.expected) * 100) : 0;
const lvBar = (s) => {
  const e = Math.max(s.expected, s.present + s.late, 1);
  return `<div class="lv-prog"><i class="p" style="width:${(s.present / e) * 100}%"></i><i class="l" style="width:${(s.late / e) * 100}%"></i></div>`;
};

function lvAlerts(all) {
  const al = [];
  lvSnap.devices.forEach((x) => {
    if (x.state === 'off') al.push(['bad', `🔴 «${x.dev.name}» غير متصل${x.err ? ' — ' + x.err : ''}`]);
    if (x.state === 'auth') al.push(['bad', `🔑 «${x.dev.name}»: رمز الاتصال غير صحيح (غيّره من تبويب الأجهزة)`]);
    if (x.state === 'old') al.push(['warn', `⬆️ «${x.dev.name}»: نسخة التطبيق قديمة لا تدعم المباشر، حدّثها إلى v15 أو أحدث`]);
  });
  all.forEach(({ place, s, nowMin, nowTs }) => {
    const label = `«${s.subject}»${s.group ? ' (' + s.group + ')' : ''} في ${place}`;
    const over = nowMin - lvMin(s.end);
    if (over > 5) al.push(['warn', `⏰ ${label} تجاوزت وقتها بـ ${lvFmtDur(over)} ولم تُنهَ`]);
    const el = (nowTs - s.startTs) / 60000;
    if (el >= 10 && s.present + s.late === 0) al.push(['warn', `👥 ${label}: لا حضور مسجّل بعد ${lvFmtDur(el)} من البدء`]);
  });
  const byStage = {};
  all.forEach((a) => { if (a.s.group) (byStage[a.s.group] = byStage[a.s.group] || []).push(a); });
  Object.entries(byStage).forEach(([g, list]) => {
    if (list.length > 1) al.push(['bad', `⚠️ تعارض: المرحلة «${g}» لها محاضرات جارية في أكثر من مكان (${list.map((a) => a.place).join('، ')})`]);
  });
  return al;
}

function lvDrawStats(all) {
  const present = all.reduce((n, a) => n + a.s.present, 0);
  const late = all.reduce((n, a) => n + a.s.late, 0);
  const expected = all.reduce((n, a) => n + a.s.expected, 0);
  const absent = Math.max(0, expected - present - late);
  const places = lvSnap.devices.length + 1;
  const busyPlaces = new Set(all.map((a) => a.place)).size;
  $('#lvStats').innerHTML = `
    <div class="stat"><b>${present}</b><span>حاضر الآن</span></div>
    <div class="stat"><b>${late}</b><span>متأخر</span></div>
    <div class="stat"><b>${absent}</b><span>لم يحضر بعد (من ${expected})</span></div>
    <div class="stat"><b>${busyPlaces}/${places}</b><span>أماكن مشغولة</span></div>`;
}

function lvDrawStages(all) {
  const rows = new Map();   // المرحلة → { count, sessions[] }
  lvSnap.devices.forEach((x) => { if (x.state === 'ok') x.data.grades.forEach((g) => {
    const r = rows.get(g.name) || { count: 0, list: [] }; r.count = Math.max(r.count, g.count); rows.set(g.name, r);
  }); });
  if (typeof db !== 'undefined') db.students.forEach((st) => { if (st.grade && !rows.has(st.grade)) rows.set(st.grade, { count: db.students.filter((x) => x.grade === st.grade).length, list: [] }); });
  const allStage = [];
  all.forEach((a) => {
    if (!a.s.group) return allStage.push(a);
    const r = rows.get(a.s.group) || { count: a.s.expected, list: [] }; r.list.push(a); rows.set(a.s.group, r);
  });
  const names = [...rows.keys()].sort((a, b) => (rows.get(b).list.length - rows.get(a).list.length) || a.localeCompare(b, 'ar'));
  const line = (name, count, list) => {
    if (!list.length) return `<tr><td><b>${esc(name)}</b></td><td><span class="lv-pill free">🟢 متاحة</span></td><td>—</td><td>—</td><td>${count} طالب</td><td>—</td></tr>`;
    return list.map((a, i) => `<tr><td>${i ? '' : `<b>${esc(name)}</b>`}</td><td><span class="lv-pill busy">🔴 مشغولة</span></td>
      <td>${esc(a.place)}</td><td>${esc(a.s.subject)}${a.s.teacher ? ' — ' + esc(a.s.teacher) : ''}</td>
      <td>${a.s.present + a.s.late} / ${a.s.expected}${a.s.late ? ` <span class="hint">(${a.s.late} متأخر)</span>` : ''}</td><td>${lvPct(a.s)}%</td></tr>`).join('');
  };
  let html = allStage.length ? line('كل المراحل', allStage[0].s.expected, allStage) : '';
  html += names.map((n) => line(n, rows.get(n).count, rows.get(n).list)).join('');
  $('#lvStages').innerHTML = html || '<tr><td colspan="6" class="empty">لا توجد مراحل بعد — أضف طلاباً أو افتح تبويب الأجهزة.</td></tr>';
}

function lvCard(name, state, data, sessions, nowMin, nowTs) {
  const pill = state !== 'ok' ? '<span class="lv-pill off">⚫ غير متاح</span>'
    : sessions.length ? '<span class="lv-pill busy">🔴 مشغول</span>' : '<span class="lv-pill free">🟢 متاح</span>';
  let body = '';
  if (state === 'old') body = '<div class="hint">نسخة التطبيق قديمة — حدّثها إلى v15 أو أحدث.</div>';
  else if (state === 'auth') body = '<div class="hint">رمز الاتصال غير صحيح.</div>';
  else if (state === 'off') body = '<div class="hint">تعذّر الاتصال بالجهاز.</div>';
  else if (!sessions.length) body = '<div class="hint">لا توجد محاضرة جارية.</div>';
  else body = sessions.map((s) => {
    const el = (nowTs - s.startTs) / 60000; const left = lvMin(s.end) - nowMin;
    return `<div class="lv-ses">
      <div><b>${esc(s.subject)}</b>${s.group ? ` — ${esc(s.group)}` : ' — كل المراحل'}${s.teacher ? ` <span class="hint">· ${esc(s.teacher)}</span>` : ''}</div>
      <div class="lv-nums"><span><b>${s.present}</b> حاضر</span><span><b>${s.late}</b> متأخر</span><span><b>${Math.max(0, s.expected - s.present - s.late)}</b> لم يحضر</span><span>من ${s.expected}</span></div>
      ${lvBar(s)}
      <div class="hint">بدأت ${esc(s.start)} · مضى ${lvFmtDur(el)} · ${left >= 0 ? 'تنتهي بعد ' + lvFmtDur(left) : 'تجاوزت الوقت بـ ' + lvFmtDur(-left)}</div>
      ${s.recent && s.recent.length ? `<div class="lv-recent">آخر المسجّلين: ${s.recent.map((r) => esc(r.name) + (r.status === 'late' ? ' ⏱' : '')).join('، ')}</div>` : ''}
    </div>`;
  }).join('');
  let next = '';
  if (state === 'ok' && data.next) next = `<div class="lv-next">⏭️ القادمة: ${esc(data.next.subject)}${data.next.group ? ' (' + esc(data.next.group) + ')' : ''} الساعة ${esc(data.next.start)}${data.next.teacher ? ' — ' + esc(data.next.teacher) : ''}</div>`;
  const cls = state !== 'ok' ? 'off' : sessions.length ? 'busy' : 'free';
  return `<div class="lv-card ${cls}"><div class="lv-head"><b>${esc(name)}</b>${pill}</div>${body}${next}</div>`;
}

function lvDrawCards() {
  const cards = lvSnap.devices.map((x) => lvCard(x.dev.name, x.state, x.data, x.state === 'ok' ? x.data.sessions : [], x.state === 'ok' ? lvMin(x.data.now) : 0, x.state === 'ok' ? x.data.nowTs : 0));
  if (lvSnap.local.length || !cards.length) cards.push(lvCard('هذا الحاسوب', 'ok', { next: null }, lvSnap.local, lvSnap.nowMin, Date.now()));
  $('#lvCards').innerHTML = cards.join('');
}

function lvDraw() {
  if (!lvSnap) return;
  const all = lvAllSessions();
  lvDrawStats(all);
  const al = lvAlerts(all);
  $('#lvAlerts').innerHTML = al.map(([k, t]) => `<div class="lv-alert ${k === 'bad' ? 'bad' : ''}">${esc(t)}</div>`).join('');
  lvDrawStages(all);
  lvDrawCards();
  const t = new Date(lvSnap.ts);
  $('#lvUpdated').textContent = 'آخر تحديث: ' + t.toLocaleTimeString('en-GB');
}

async function lvRefresh() {
  if (lvBusy) return; lvBusy = true;
  try { await lvFetch(); lvDraw(); } catch (e) { toast('تعذّر تحديث المباشر'); }
  lvBusy = false;
}

function lvSchedule() {
  clearInterval(lvTimer); lvTimer = null;
  const sec = Number($('#lvEvery').value);
  if (sec > 0) lvTimer = setInterval(() => {
    if (!$('#live').classList.contains('active')) { clearInterval(lvTimer); lvTimer = null; clearInterval(lvClockTimer); lvClockTimer = null; return; }
    lvRefresh();
  }, sec * 1000);
}

function renderLive() {
  const tick = () => { $('#lvClock').textContent = new Date().toLocaleTimeString('en-GB'); };
  tick(); clearInterval(lvClockTimer); lvClockTimer = setInterval(tick, 1000);
  lvSchedule(); lvRefresh();
}

$('#lvEvery').addEventListener('change', lvSchedule);
$('#lvNow').addEventListener('click', lvRefresh);
$('#lvFull').addEventListener('click', () => {
  const el = $('#live');
  if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen().catch(() => toast('تعذّر ملء الشاشة'));
});
$('#lvCsv').addEventListener('click', () => {
  if (!lvSnap) return toast('لا توجد بيانات بعد');
  const rows = [['المكان', 'الحالة', 'المرحلة', 'المادة', 'المدرّس', 'البدء', 'حاضر', 'متأخر', 'المتوقع', 'لم يحضر', 'النسبة %']];
  lvSnap.devices.forEach((x) => {
    if (x.state !== 'ok') return rows.push([x.dev.name, 'غير متاح', '', '', '', '', '', '', '', '', '']);
    if (!x.data.sessions.length) return rows.push([x.dev.name, 'متاح', '', '', '', '', '', '', '', '', '']);
    x.data.sessions.forEach((s) => rows.push([x.dev.name, 'مشغول', s.group || 'الكل', s.subject, s.teacher, s.start, s.present, s.late, s.expected, Math.max(0, s.expected - s.present - s.late), lvPct(s)]));
  });
  lvSnap.local.forEach((s) => rows.push(['هذا الحاسوب', 'مشغول', s.group || 'الكل', s.subject, s.teacher, s.start, s.present, s.late, s.expected, Math.max(0, s.expected - s.present - s.late), lvPct(s)]));
  csvDownload(`live-${todayStr()}-${pad(new Date().getHours())}${pad(new Date().getMinutes())}.csv`, rows);
});

$('#lvWin').addEventListener('click', () => api.liveOpen());
