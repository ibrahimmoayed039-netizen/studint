/* تبويب «تقارير الأجهزة»: سحب بيانات الحضور الخام من هواتف الأندرويد (POST /api/report) ودمجها في تقرير واحد. */
let plData = [];          // [{ dev, data }] الأجهزة التي نجح سحبها
let plSel = new Set();    // الأجهزة المحددة
let plRows = [];          // الصفوف المحسوبة بعد التصفية

const plMonthStart = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; };

async function renderPull() {
  if (!$('#plFrom').value) $('#plFrom').value = plMonthStart();
  if (!$('#plTo').value) $('#plTo').value = todayStr();
  const devs = await api.lanList();
  if (!plSel.size) devs.forEach((d) => plSel.add(d.id));
  $('#plDevs').innerHTML = devs.length
    ? devs.map((d) => `<label class="lv-inl"><input type="checkbox" data-id="${esc(d.id)}" ${plSel.has(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')
    : '<span class="hint">لا توجد أجهزة — أضف الهواتف من تبويب «الأجهزة» أولاً.</span>';
}
$('#plDevs').addEventListener('change', (e) => {
  const c = e.target.closest('input[data-id]'); if (!c) return;
  c.checked ? plSel.add(c.dataset.id) : plSel.delete(c.dataset.id);
});
$('#plMonth').addEventListener('click', () => { $('#plFrom').value = plMonthStart(); $('#plTo').value = todayStr(); });

$('#plGo').addEventListener('click', async () => {
  const from = $('#plFrom').value, to = $('#plTo').value;
  if (!from || !to || from > to) return toast('اختر نطاق تاريخ صحيحاً');
  const devs = (await api.lanList()).filter((d) => plSel.has(d.id));
  if (!devs.length) return toast('حدّد جهازاً واحداً على الأقل');
  const btn = $('#plGo'); btn.disabled = true; btn.textContent = '⏳ جارٍ السحب...';
  $('#plStatus').textContent = 'جارٍ الاتصال بـ ' + devs.length + ' جهاز...';
  const res = await Promise.all(devs.map(async (d) => {
    const r = await dvCall(d.id, 'POST', '/api/report', { from, to });
    if (r.status === 200 && r.data && r.data.ok) return { dev: d, data: r.data };
    const why = r.status === 404 ? 'نسخة التطبيق قديمة (حدّثها إلى v16)' : r.status === 401 ? 'رمز الاتصال خاطئ' : (r.data && r.data.error) || r.error || 'فشل';
    return { dev: d, error: why };
  }));
  btn.disabled = false; btn.textContent = '⬇️ سحب التقارير';
  plData = res.filter((x) => x.data);
  $('#plStatus').innerHTML = res.map((x) => x.data
    ? `✅ ${esc(x.dev.name)}: ${x.data.students.length} طالب، ${x.data.sessions.length} محاضرة، ${x.data.att.length} سجل`
    : `❌ ${esc(x.dev.name)}: ${esc(x.error)}`).join('<br>');
  audit('سحب تقارير من الأجهزة', `${from} ← ${to}: ${plData.length}/${devs.length} جهاز`);
  const grades = [...new Set(plData.flatMap((x) => x.data.students.map((s) => s.grade)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ar'));
  $('#plGrade').innerHTML = '<option value="">الكل</option>' + grades.map((g) => `<option>${esc(g)}</option>`).join('');
  $('#plDevice').innerHTML = '<option value="">الكل</option>' + plData.map((x) => `<option value="${esc(x.dev.id)}">${esc(x.dev.name)}</option>`).join('');
  plDraw();
});

/* نفس منطق monthlyStats: الحصص المنطبقة = بلا مجموعة أو مجموعتها = صف الطالب */
function plCompute() {
  const group = $('#plGrade').value, devId = $('#plDevice').value, q = $('#plQ').value.trim().toLowerCase();
  const per = [];
  plData.forEach(({ dev, data }) => {
    if (devId && dev.id !== devId) return;
    const recs = new Map(data.att.map((a) => [a[0] + '|' + a[1], a[2]]));
    data.students.forEach((st) => {
      if ((group && st.grade !== group) || (q && !st.name.toLowerCase().includes(q))) return;
      const applicable = data.sessions.filter((s) => !s.group || s.group === st.grade);
      let present = 0, late = 0;
      applicable.forEach((s) => { const r = recs.get(s.id + '|' + st.id); if (r === 'p') present++; else if (r === 'l') late++; });
      per.push({ name: st.name, grade: st.grade, device: dev.name, total: applicable.length, present, late });
    });
  });
  let rows = per;
  if ($('#plMerge').checked) {
    const m = new Map();
    per.forEach((r) => {
      const k = r.name.trim() + '|' + r.grade;
      const x = m.get(k);
      if (!x) m.set(k, { ...r, devices: [r.device] });
      else { x.total += r.total; x.present += r.present; x.late += r.late; if (!x.devices.includes(r.device)) x.devices.push(r.device); }
    });
    rows = [...m.values()].map((r) => ({ ...r, device: r.devices.join('، ') }));
  }
  rows.forEach((r) => { r.absent = r.total - r.present - r.late; r.pct = r.total ? Math.round(((r.present + r.late) / r.total) * 100) : 0; });
  if ($('#plSort').value === 'low') rows.sort((a, b) => (a.total ? a.pct : 101) - (b.total ? b.pct : 101) || a.name.localeCompare(b.name, 'ar'));
  else rows.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  return rows;
}

function plDraw() {
  plRows = plCompute();
  const withData = plRows.filter((r) => r.total);
  const avg = withData.length ? Math.round(withData.reduce((a, r) => a + r.pct, 0) / withData.length) : 0;
  const low = withData.filter((r) => r.pct < 75).length;
  $('#plStats').hidden = $('#plTools').hidden = $('#plTable').hidden = false;
  $('#plStats').innerHTML = `
    <div class="stat"><b>${plRows.length}</b><span>طالب</span></div>
    <div class="stat"><b>${avg}%</b><span>متوسط الحضور</span></div>
    <div class="stat"><b>${low}</b><span>دون 75%</span></div>
    <div class="stat"><b>${plData.length}</b><span>جهاز تم سحبه</span></div>`;
  const colr = (r) => !r.total ? '' : r.pct >= 90 ? 'color:#7af0bb' : r.pct >= 75 ? 'color:#ffd27a' : 'color:#ff93ac';
  $('#plBody').innerHTML = plRows.length
    ? plRows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.grade) || '—'}</td><td>${esc(r.device)}</td>
        <td>${r.total}</td><td>${r.present}</td><td>${r.late}</td><td>${r.absent}</td><td style="font-weight:700;${colr(r)}">${r.total ? r.pct + '%' : '—'}</td></tr>`).join('')
    : '<tr><td colspan="9" class="empty">لا توجد بيانات مطابقة</td></tr>';
}
['#plGrade', '#plDevice', '#plSort', '#plMerge'].forEach((s) => $(s).addEventListener('change', plDraw));
$('#plQ').addEventListener('input', plDraw);

const plRange = () => `${$('#plFrom').value} → ${$('#plTo').value}`;
const plFile = (ext) => `devices-report-${$('#plFrom').value}_${$('#plTo').value}.${ext}`;

$('#plCsv').addEventListener('click', () => {
  if (!plRows.length) return toast('لا توجد بيانات');
  csvDownload(plFile('csv'), [['الاسم', 'الصف', 'الجهاز', 'عدد الحصص', 'حاضر', 'متأخر', 'غائب', 'نسبة الحضور'],
    ...plRows.map((r) => [r.name, r.grade, r.device, r.total, r.present, r.late, r.absent, r.total ? r.pct + '%' : ''])]);
});
$('#plXlsx').addEventListener('click', async () => {
  if (!plRows.length) return toast('لا توجد بيانات');
  const data = [
    [db.settings.schoolName || 'حضور الطلبة'],
    ['تقرير الحضور من الأجهزة — ' + plRange() + ($('#plGrade').value ? ' — ' + $('#plGrade').value : '')],
    [],
    ['#', 'اسم الطالب', 'الصف', 'الجهاز', 'عدد الحصص', 'حاضر', 'متأخر', 'غائب', 'نسبة الحضور'],
    ...plRows.map((r, i) => [i + 1, r.name, r.grade, r.device, r.total, r.present, r.late, r.absent, r.total ? r.pct + '%' : '-'])
  ];
  if (await api.saveXlsx(plFile('xlsx'), 'تقرير الأجهزة', data, [6, 30, 18, 18, 12, 10, 10, 10, 14], [0, 1, 3])) toast('تم حفظ ملف Excel');
});
$('#plPdf').addEventListener('click', async () => {
  if (!plRows.length) return toast('لا توجد بيانات');
  const withData = plRows.filter((r) => r.total);
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
    <div class="head">${logo}<div><h1>${esc(db.settings.schoolName || 'حضور الطلبة')}</h1><h2>تقرير الحضور (مسحوب من الأجهزة)</h2>
    <div class="sub">الفترة: ${esc(plRange())} &nbsp;•&nbsp; ${$('#plGrade').value ? 'المرحلة: ' + esc($('#plGrade').value) : 'كل الطلاب'}</div></div></div>
    <div class="sum">عدد الطلاب: ${plRows.length} &nbsp;•&nbsp; متوسط الحضور: ${avg}% &nbsp;•&nbsp; دون 75%: ${low} طالب</div>
    <table><thead><tr><th class="c">#</th><th>اسم الطالب</th><th>الصف</th><th>الجهاز</th><th class="c">الحصص</th><th class="c">حاضر</th><th class="c">متأخر</th><th class="c">غائب</th><th class="c">النسبة</th></tr></thead><tbody>
    ${plRows.map((r, i) => `<tr><td class="c">${i + 1}</td><td class="n">${esc(r.name)}</td><td class="n">${esc(r.grade) || '—'}</td><td class="n">${esc(r.device)}</td><td class="c">${r.total}</td><td class="c">${r.present}</td><td class="c">${r.late}</td><td class="c">${r.absent}</td><td class="c" style="font-weight:700;color:${colr(r)}">${r.total ? r.pct + '%' : '—'}</td></tr>`).join('')}
    </tbody></table>
    <div class="foot">طُبع بتاريخ ${todayStr()}</div></body></html>`;
  if (await api.savePdf(html, plFile('pdf'))) toast('تم حفظ ملف PDF');
});

/* PDF تفصيلي: لكل محاضرة (حسب الجهاز ثم التاريخ) أسماء الحاضرين والمتأخرين والغائبين. يحترم تصفية المرحلة والجهاز. */
$('#plDetail').addEventListener('click', async () => {
  if (!plData.length) return toast('اسحب التقارير أولاً');
  const group = $('#plGrade').value, devId = $('#plDevice').value;
  const ar = (a, b) => a.localeCompare(b, 'ar');
  const blocks = [];
  plData.forEach(({ dev, data }) => {
    if (devId && dev.id !== devId) return;
    const recs = new Map(data.att.map((a) => [a[0] + '|' + a[1], a[2]]));
    data.sessions.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).forEach((s) => {
      if (group && s.group && s.group !== group) return;
      const P = [], L = [], A = [];
      data.students.forEach((st) => {
        if ((s.group && s.group !== st.grade) || (group && st.grade !== group)) return;
        const r = recs.get(s.id + '|' + st.id);
        (r === 'p' ? P : r === 'l' ? L : A).push(st.name);
      });
      blocks.push({ dev: dev.name, s, P: P.sort(ar), L: L.sort(ar), A: A.sort(ar) });
    });
  });
  if (!blocks.length) return toast('لا توجد محاضرات في هذا النطاق');
  const logo = db.settings.logo ? `<img class="logo" src="${db.settings.logo}">` : '';
  const names = (arr) => arr.length ? esc(arr.join('، ')) : '—';
  let lastDev = null;
  const body = blocks.map((b) => {
    const head = b.dev !== lastDev ? `<h3>📱 ${esc(b.dev)}</h3>` : '';
    lastDev = b.dev;
    return `${head}<div class="ses"><div class="st"><b>${esc(b.s.date)}</b> ${esc(b.s.start)} — ${esc(b.s.subject)} — ${esc(b.s.group) || 'كل المراحل'}${b.s.teacher ? ' — ' + esc(b.s.teacher) : ''}
      <span class="cnt">حاضر ${b.P.length} • متأخر ${b.L.length} • غائب ${b.A.length}</span></div>
      <div class="ln ok"><b>الحاضرون:</b> ${names(b.P)}</div>
      <div class="ln lt"><b>المتأخرون:</b> ${names(b.L)}</div>
      <div class="ln ab"><b>الغائبون:</b> ${names(b.A)}</div></div>`;
  }).join('');
  const html = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
    @page { size: A4; margin: 14mm; }
    body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; color: #111; font-size: 12px; }
    .head { display: flex; align-items: center; gap: 16px; border-bottom: 3px solid #6d7cff; padding-bottom: 10px; margin-bottom: 8px; }
    .logo { height: 72px; max-width: 120px; object-fit: contain; }
    h1 { margin: 0; font-size: 24px; color: #2a3170; } h2 { margin: 2px 0; font-size: 15px; font-weight: 500; color: #444; }
    h3 { margin: 16px 0 6px; font-size: 15px; color: #fff; background: #3d4a9e; padding: 5px 10px; border-radius: 6px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .ses { border: 1px solid #d5d9ee; border-radius: 6px; padding: 7px 10px; margin-bottom: 7px; page-break-inside: avoid; }
    .st { font-size: 13px; margin-bottom: 4px; } .cnt { float: left; color: #555; font-size: 11px; }
    .ln { line-height: 1.7; } .ok b { color: #0e8f5a; } .lt b { color: #c77f0a; } .ab b { color: #d32f57; }
    .foot { margin-top: 14px; color: #888; font-size: 10px; text-align: center; }
  </style></head><body>
    <div class="head">${logo}<div><h1>${esc(db.settings.schoolName || 'حضور الطلبة')}</h1><h2>سجل الحضور التفصيلي (مسحوب من الأجهزة)</h2>
    <div>الفترة: ${esc(plRange())} &nbsp;•&nbsp; ${group ? 'المرحلة: ' + esc(group) : 'كل المراحل'} &nbsp;•&nbsp; ${blocks.length} محاضرة</div></div></div>
    ${body}<div class="foot">طُبع بتاريخ ${todayStr()}</div></body></html>`;
  if (await api.savePdf(html, plFile('pdf').replace('devices-report', 'devices-detail'))) toast('تم حفظ ملف PDF التفصيلي');
});
