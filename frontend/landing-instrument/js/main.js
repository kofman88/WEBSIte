/* Точка входа лендинга: запуск секций, меню, липкая кнопка на мобильных, подсветка пункта меню. */
(function () {
  'use strict';
  const C = window.CHML, L = C.lib, SEC = C.sec, $ = L.$, $$ = L.$$;

  function safe(name) { try { SEC[name](); } catch (e) { console.error('[landing] ' + name, e); } }

  L.defs();
  ['ticker', 'sandbox', 'feed', 'counters', 'showcase', 'story', 'backtest', 'compare', 'genome', 'planner', 'pricing'].forEach(safe);
  L.glare();

  if (C.api.isMock) { $('#mock-chip').hidden = false; $('#ftr-mock').hidden = false; }

  // меню на узких экранах
  const burger = $('#nav-burger'), links = $('#nav-links');
  burger.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  links.addEventListener('click', (e) => { if (e.target.closest('a')) { links.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && links.classList.contains('open')) { links.classList.remove('open'); burger.setAttribute('aria-expanded', 'false'); burger.focus(); } });

  // мобильная липкая кнопка «Открыть приложение» — после hero, прячется над футером
  const mcta = $('#mcta'), hero = $('#sandbox'), ftr = $('.ftr');
  if ('IntersectionObserver' in window) {
    let heroOut = false, ftrIn = false;
    const upd = () => mcta.classList.toggle('show', heroOut && !ftrIn);
    new IntersectionObserver((e) => { heroOut = !e[0].isIntersecting; upd(); }, { rootMargin: '-40% 0px 0px 0px' }).observe(hero);
    new IntersectionObserver((e) => { ftrIn = e[0].isIntersecting; upd(); }).observe(ftr);

    // текущий пункт меню
    const map = {};
    $$('#nav-links a').forEach((a) => { map[a.getAttribute('href').slice(1)] = a; });
    const io = new IntersectionObserver((ents) => ents.forEach((e) => {
      const a = map[e.target.id];
      if (a && e.isIntersecting) { $$('#nav-links a').forEach((x) => x.classList.remove('is-cur')); a.classList.add('is-cur'); }
    }), { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach((id) => { const s = document.getElementById(id); if (s) io.observe(s); });
    new IntersectionObserver((e) => { if (e[0].isIntersecting) $$('#nav-links a').forEach((x) => x.classList.remove('is-cur')); }, { rootMargin: '-45% 0px -50% 0px' }).observe(hero);

    // мягкое появление секций
    if (!L.reduced) {
      const rv = $$('.sec-hd, .now-grid, .sc-bar, .sc-viewport, .bt, .cmp, .gn-grid, .pl, .pr-grid, .calc, .flow, .trust-grid, .app-grid, .faq');
      rv.forEach((el) => el.classList.add('rv'));
      const ro = new IntersectionObserver((ents) => ents.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
      rv.forEach((el) => ro.observe(el));
    }
  }
  // QR для десктопа: модули хранятся битовой строкой (hex), путь строим здесь
  const qr = $('[data-qr]');
  if (qr) {
    const [n, hex] = qr.getAttribute('data-qr').split(':');
    const bit = (i) => (parseInt(hex[i >> 2], 16) >> (3 - (i & 3))) & 1;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (bit(y * n + x)) d += 'M' + x + ' ' + y + 'h1v1h-1z';
    $('#qr-path').setAttribute('d', d);
  }
  // ссылка «Как мы считаем» из футера раскрывает блок методики
  $$('a[href="#how-count"]').forEach((a) => a.addEventListener('click', () => { $('#how-count').open = true; }));
})();
