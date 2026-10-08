/* Адаптер данных: пока нет /api/public/*, данные из заглушки mock/mock-api.js. Уберите её
   подключение в index.html — адаптер перейдёт на fetch с той же формой ответов. */
(function () {
  'use strict';
  const M = window.CHM_MOCK_API;
  const MOCK = !!M;
  const BASE = '/api/public/';
  const cache = {};

  function get(path, params) {
    const q = params ? '?' + new URLSearchParams(params).toString() : '';
    return fetch(BASE + path + q, { headers: { Accept: 'application/json' }, credentials: 'omit' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  // один запрос на ресурс за загрузку страницы (ответы кэшируются сервером 30–60 с)
  function once(key, fn) { if (!cache[key]) cache[key] = fn(); return cache[key]; }

  window.CHML = window.CHML || {};
  window.CHML.api = {
    isMock: MOCK,
    trend: (tick) => (MOCK ? M.trend(tick) : get('trend')),
    stats: () => once('stats', () => (MOCK ? M.stats() : get('stats'))),
    feed: () => (MOCK ? M.feed() : get('feed')),
    // реальный режим: поллинг ленты и сравнение id; мок отдаёт следующее событие
    feedNext: (openIds) => (MOCK ? M.feedNext(openIds) : get('feed').then((d) => ({ type: 'snapshot', feed: d }))),
    showcase: () => once('showcase', () => (MOCK ? M.showcase() : get('showcase'))),
    backtestGrid: () => once('grid', () => (MOCK ? M.backtestGrid() : get('backtest-grid'))),
    backtest: (strategy, coin, period) => (MOCK ? M.backtest(strategy, coin, period) : get('backtest', { strategy, coin, period })),
    genome: () => once('genome', () => (MOCK ? M.genome() : get('genome'))),
  };
})();
