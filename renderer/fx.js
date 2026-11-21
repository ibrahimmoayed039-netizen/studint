// تأثير الميلان المجسّم للبطاقات عند مرور المؤشر (لا يؤثر على منطق البرنامج)
(function () {
  const MAX = 5;
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest && e.target.closest('.card:not(.login-card), .stat');
    document.querySelectorAll('.tilting').forEach((x) => { if (x !== el) { x.classList.remove('tilting'); x.style.transform = ''; } });
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.classList.add('tilting');
    el.style.transform = `perspective(900px) rotateY(${px * MAX}deg) rotateX(${-py * MAX}deg) translateZ(6px)`;
  });
  document.addEventListener('mouseleave', () => {
    document.querySelectorAll('.tilting').forEach((x) => { x.classList.remove('tilting'); x.style.transform = ''; });
  });
})();
