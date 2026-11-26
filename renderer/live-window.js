/* نافذة «المراحل الشاغلة»: تستعلم /api/live من كل الهواتف المرتبطة + جلسات هذا الحاسوب، وتعرض المراحل المشغولة وعدد الحاضرين. */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mins = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const dur = (m) => { m = Math.max(0, Math.round(m)); return m >= 60 ? `${Math.floor(m / 60)}س ${m % 60}د` : `${m}د`; };

let timer = null, busy = false, pinned = false;

async function collect() {
  const devs = await api.lanList();
  const out = { sessions: [], free: new Map(), devs: [], school: '' };
  const addGrades = (grades) => grades.forEach((g) => out.free.set(g.name, Math.max(out.free.get(g.name) || 0, g.count)));
  const addSessions = (place, d) => d.sessions.forEach((s) => out.sessions.push({ place, s, nowMin: mins(d.now), nowTs: d.nowTs }));

  const local = await api.liveLocal();
  out.school = local.school || '';
  addGrades(local.grades); addSessions('هذا الحاسوب', local);

  await Promise.all(devs.map(async (d) => {
    const r = await api.lanCall({ id: d.id, method: 'GET', path: '/api/live' });
    if (r.status === 200 && r.data && r.data.ok) {
      out.devs.push({ name: d.name, st: 'ok', n: r.data.sessions.length });
      addGrades(r.data.grades); addSessions(d.name, r.data);
      if (!out.school) out.school = r.data.school || '';
    } else {
      out.devs.push({ name: d.name, st: r.status === 404 ? 'old' : r.status === 401 ? 'auth' : 'off' });
    }
  }));
  return out;
}

function draw(o) {
  const all = o.sessions;
  const present = all.reduce((n, a) => n + a.s.present, 0);
  const late = all.reduce((n, a) => n + a.s.late, 0);
  const expected = all.reduce((n, a) => n + a.s.expected, 0);
  $('#lwSchool').textContent = (o.school ? o.school + ' — ' : '') + 'المراحل الشاغلة';
  $('#lwTotal').innerHTML = `
    <div class="lw-big ok"><b>${present + late}</b><span>حاضر الآن</span></div>
    <div class="lw-big late"><b>${late}</b><span>منهم متأخر</span></div>
    <div class="lw-big bad"><b>${Math.max(0, expected - present - late)}</b><span>لم يحضر بعد (من ${expected})</span></div>
    <div class="lw-big"><b>${new Set(all.map((a) => a.s.group || '*')).size}</b><span>مرحلة شاغلة</span></div>`;

  const stages = new Set(all.filter((a) => a.s.group).map((a) => a.s.group));
  const sorted = all.slice().sort((a, b) => (a.s.group || '').localeCompare(b.s.group || '', 'ar'));
  $('#lwBusy').innerHTML = sorted.length ? sorted.map(({ place, s, nowMin, nowTs }) => {
    const e = Math.max(s.expected, s.present + s.late, 1);
    const left = mins(s.end) - nowMin;
    const conflict = s.group && all.filter((x) => x.s.group === s.group).length > 1;
    return `<div class="lw-card ${left < -5 || conflict ? 'warn' : ''}">
      <div><div class="lw-stage">${esc(s.group) || 'كل المراحل'}</div><div class="lw-place">📍 ${esc(place)}${conflict ? ' · ⚠️ تعارض: المرحلة في أكثر من مكان' : ''}</div></div>
      <div class="lw-count"><b>${s.present + s.late}</b><span>حاضر من ${s.expected}${s.late ? ` (${s.late} متأخر)` : ''}</span></div>
      <div class="lw-prog"><i class="p" style="width:${(s.present / e) * 100}%"></i><i class="l" style="width:${(s.late / e) * 100}%"></i></div>
      <div class="lw-sub">${esc(s.subject)}${s.teacher ? ' — ' + esc(s.teacher) : ''}</div>
      <div class="lw-sub">بدأت ${esc(s.start)} · مضى ${dur((nowTs - s.startTs) / 60000)} · ${left >= 0 ? 'تنتهي بعد ' + dur(left) : '⏰ تجاوزت الوقت بـ ' + dur(-left)}</div>
    </div>`;
  }).join('') : '<div class="lw-empty" style="grid-column:1/-1">لا توجد محاضرة جارية الآن في أي جهاز.</div>';

  const free = [...o.free.keys()].filter((g) => !stages.has(g)).sort((a, b) => a.localeCompare(b, 'ar'));
  $('#lwFree').innerHTML = free.length ? free.map((g) => `<span class="lw-chip">${esc(g)} · ${o.free.get(g)} طالب</span>`).join('') : '<span class="hint">—</span>';

  $('#lwDev').innerHTML = o.devs.concat(o.devs.length ? [] : []).map((d) => {
    const t = d.st === 'ok' ? `🟢 ${esc(d.name)}${d.n ? ' (مشغول)' : ' (متاح)'}` : d.st === 'old' ? `⬆️ ${esc(d.name)}: حدّث التطبيق إلى v15+` : d.st === 'auth' ? `🔑 ${esc(d.name)}: رمز الاتصال خاطئ` : `🔴 ${esc(d.name)}: غير متصل`;
    return `<span>${t}</span>`;
  }).join('') || '<span>لا توجد هواتف مضافة (تبويب «الأجهزة»)</span>';
  $('#lwUpd').textContent = 'آخر تحديث: ' + new Date().toLocaleTimeString('en-GB');
}

async function refresh() {
  if (busy) return; busy = true;
  try { draw(await collect()); } catch { $('#lwUpd').textContent = 'تعذّر التحديث'; }
  busy = false;
}
function schedule() { clearInterval(timer); timer = setInterval(refresh, Number($('#lwEvery').value) * 1000); }

setInterval(() => { $('#lwClock').textContent = new Date().toLocaleTimeString('en-GB'); }, 1000);
$('#lwClock').textContent = new Date().toLocaleTimeString('en-GB');
$('#lwEvery').addEventListener('change', schedule);
$('#lwNow').addEventListener('click', refresh);
$('#lwPin').addEventListener('click', async () => { pinned = await api.livePin(!pinned); $('#lwPin').textContent = pinned ? '📌 مثبّتة فوق النوافذ' : '📌 تثبيت فوق النوافذ'; });
$('#lwFull').addEventListener('click', () => api.liveFull());
schedule(); refresh();
