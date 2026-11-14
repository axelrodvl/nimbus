// Тема ставится до первой отрисовки (без вспышки). Логика дублирует src/lib/theme/theme.ts.
// Отдельным файлом, а не инлайн-скриптом: CSP бэкенда разрешает только script-src 'self'.
(function () {
  try {
    var v = localStorage.getItem('nimbus:theme');
    var dark = v === 'light' ? false : v === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : true;
    var el = document.documentElement;
    el.classList.toggle('dark', dark);
    var c = dark ? '#121212' : '#fafafa';
    document.querySelectorAll('meta[name="theme-color"]').forEach(function (m) {
      m.removeAttribute('media');
      m.setAttribute('content', c);
    });
  } catch (e) {}
})();
