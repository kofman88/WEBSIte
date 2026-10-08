/* MOCK API — заглушка публичных эндпоинтов лендинга CHM Breaker. ВСЕ ЧИСЛА ВЫДУМАНЫ.
 * Форма ответов — как у будущих GET /api/public/{trend,stats,feed,showcase,backtest-grid,backtest,genome}
 * (PRODUCT_CONCEPT §5.4). Генерация детерминированная (seeded PRNG). Модель исходов — как в бэктестере
 * Genome: TP 40/30/30 с переносом стопа в БУ, комиссия 0,12% за круг + проскальзывание 0,1% (fee_r).
 * Когда появится бэкенд, js/api.js переходит на fetch, а этот файл удаляется. */
(function () {
  'use strict';

  const DAY = 864e5, HOUR = 36e5, MIN = 6e4;

  function hash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    const u = Math.max(1e-9, r()), v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const round = (x, d) => { const k = Math.pow(10, d || 0); return Math.round(x * k) / k; };

  const NOW = Date.now();
  const TODAY0 = Math.floor(NOW / DAY) * DAY;
  const PRECALC_AT = (NOW - TODAY0 > 40 * MIN ? TODAY0 : TODAY0 - DAY) + 40 * MIN;
  const HOLD_END = TODAY0 - DAY;
  const HOLD_DAYS = 88, SEL_DAYS = 80, YEAR_DAYS = 365;
  const HOLD_START = HOLD_END - HOLD_DAYS * DAY;
  const SEL_START = HOLD_START - SEL_DAYS * DAY;
  const YEAR_START = HOLD_END - YEAR_DAYS * DAY;

  const STRATS = {
    LEVELS: { id: 'LEVELS', name: 'Уровни', short: 'УР', tf: '1H', n90: 52, wr: 0.462, wrSd: 0.022,
      wins: [0.8, 1.7, 2.8], winW: [0.48, 0.32, 0.20], fee: 0.14, hold: 9, mtfSimplified: true },
    SMC: { id: 'SMC', name: 'SMC', short: 'SMC', tf: '15m', n90: 84, wr: 0.425, wrSd: 0.02,
      wins: [1.0, 2.1, 3.3], winW: [0.5, 0.32, 0.18], fee: 0.2, hold: 3, mtfSimplified: true },
    VOLUME: { id: 'VOLUME', name: 'Объём + MA', short: 'ОБ', tf: '4H', n90: 30, wr: 0.44, wrSd: 0.025,
      wins: [0.85, 1.7, 2.7], winW: [0.48, 0.32, 0.20], fee: 0.09, hold: 26, mtfSimplified: false },
  };

  const COINS = [
    ['BTC', 18400, 1.0], ['ETH', 9100, 1.0], ['SOL', 2650, 1.1], ['XRP', 1900, 0.95], ['DOGE', 1320, 1.1],
    ['SUI', 870, 1.15], ['BNB', 610, 0.85], ['ADA', 540, 0.95], ['LINK', 470, 1.0], ['AVAX', 400, 1.05],
    ['LTC', 330, 0.9], ['TON', 300, 0.9], ['PEPE', 290, 1.2], ['TRX', 260, 0.75], ['WIF', 240, 1.2],
    ['DOT', 210, 0.9], ['NEAR', 190, 1.0], ['APT', 170, 1.0], ['ARB', 150, 1.05], ['OP', 130, 1.05],
  ];
  const LISTED = { SUI: '2023-05', PEPE: '2023-05', WIF: '2024-01', TON: '2023-08', APT: '2022-10', ARB: '2023-03', OP: '2022-06' };

  function genTrades(r, sp, from, to, wr, nScale, opt) {
    const o = opt || {};
    const days = (to - from) / DAY;
    const n = Math.max(o.minN || 0, Math.round(sp.n90 * (days / HOLD_DAYS) * nScale * (0.85 + 0.3 * r())));
    const nWin = clamp(Math.round(n * wr + 0.5 * gauss(r) * Math.sqrt(n * wr * (1 - wr))), 0, n);
    const deck = [];
    for (let i = 0; i < n; i++) deck.push(i < nWin);
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = from + (to - from) * r();
      const side = r() < 0.52 ? 'L' : 'S';
      let g, kind;
      if (deck[i]) {
        const u = r();
        const k = u < sp.winW[0] ? 0 : u < sp.winW[0] + sp.winW[1] ? 1 : 2;
        g = sp.wins[k] * (0.92 + 0.16 * r());
        kind = ['TP1', 'TP2', 'TP3'][k];
      } else if (r() < 0.85) {
        const slip = o.stress ? 0.15 + 0.75 * r() : 0.04 * r();
        g = -(1 + slip);
        kind = 'SL';
      } else {
        g = -0.5 + 0.6 * r();
        kind = 'EXP';
      }
      const fee = sp.fee * (0.85 + 0.3 * r());
      out.push({ t: Math.round(t), side, kind, g: round(g, 3), fee: round(fee, 3), r: round(g - fee, 3),
        hold_h: round(sp.hold * (0.3 + 1.4 * r()), 1) });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  function maxDD(rs) {
    let eq = 0, peak = 0, dd = 0;
    for (const x of rs) { eq += x; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; }
    return dd;
  }
  function mcP95(rs, seed, runs) {
    if (rs.length < 2) return maxDD(rs);
    const r = rng(seed), a = rs.slice(), dds = [];
    for (let k = 0; k < (runs || 200); k++) {
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
      dds.push(maxDD(a));
    }
    dds.sort((x, y) => x - y);
    return dds[Math.floor(0.95 * (dds.length - 1))];
  }
  function mcBand(rs, seed, runs) {
    const n = rs.length, r = rng(seed), a = rs.slice(), cols = [];
    for (let i = 0; i < n; i++) cols.push([]);
    for (let k = 0; k < (runs || 200); k++) {
      for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
      let eq = 0;
      for (let i = 0; i < n; i++) { eq += a[i]; cols[i].push(eq); }
    }
    const p5 = [], p95 = [];
    for (const c of cols) { c.sort((x, y) => x - y); p5.push(round(c[Math.floor(0.05 * (c.length - 1))], 2)); p95.push(round(c[Math.floor(0.95 * (c.length - 1))], 2)); }
    return { p5, p95 };
  }
  function lossStreak(rs) {
    let s = 0, m = 0;
    for (const x of rs) { if (x < 0) { s++; if (s > m) m = s; } else s = 0; }
    return m;
  }
  function stats(trades, seed) {
    const rs = trades.map((x) => x.r);
    let pos = 0, neg = 0, gross = 0, fee = 0, hold = 0, wins = 0;
    for (const x of trades) {
      if (x.r > 0) pos += x.r; else neg -= x.r;
      gross += x.g; fee += x.fee; hold += x.hold_h;
      if (x.kind !== 'SL' && x.kind !== 'EXP') wins++;
    }
    const n = trades.length;
    return {
      n, wins,
      r_total: round(pos - neg, 2),
      gross_r: round(gross, 2),
      fee_r_total: round(fee, 2),
      pf: neg > 0 ? round(pos / neg, 2) : null,
      max_dd_r: round(maxDD(rs), 2),
      p95_dd_r: round(mcP95(rs, seed || 7), 2),
      max_loss_streak: lossStreak(rs),
      avg_hold_h: n ? round(hold / n, 1) : null,
      sl_avg_r: (function () { const sl = trades.filter((x) => x.kind === 'SL'); return sl.length ? round(sl.reduce((s, x) => s + x.r, 0) / sl.length, 2) : null; })(),
    };
  }
  function curve(trades, from) {
    let eq = 0;
    const pts = [[from, 0]];
    for (const x of trades) { eq += x.r; pts.push([x.t, round(eq, 2)]); }
    return pts;
  }
  function byDir(trades, dir) {
    if (dir === 'long') return trades.filter((x) => x.side === 'L');
    if (dir === 'short') return trades.filter((x) => x.side === 'S');
    return trades;
  }

  const cellCache = {};
  function cell(sid, sym) {
    const key = sid + ':' + sym;
    if (cellCache[key]) return cellCache[key];
    const sp = STRATS[sid];
    const coin = COINS.find((c) => c[0] === sym) || COINS[0];
    const r = rng(hash('cell:' + key));
    const wr = clamp(sp.wr + sp.wrSd * gauss(r), sp.wr - 0.05, sp.wr + 0.05);
    const act = coin[2];
    const c = {
      wr,
      early: genTrades(r, sp, YEAR_START, SEL_START, wr - 0.005, act),
      sel: genTrades(r, sp, SEL_START, HOLD_START, wr + 0.09, act),
      hold: genTrades(r, sp, HOLD_START, HOLD_END, wr, act),
      hold_pct: round(14 * gauss(r), 1),
    };
    cellCache[key] = c;
    return c;
  }

  let gridCache = null;
  function buildGrid() {
    if (gridCache) return gridCache;
    const cells = {};
    for (const sid of Object.keys(STRATS)) {
      for (const coin of COINS) {
        const c = cell(sid, coin[0]);
        for (const dir of ['both', 'long', 'short']) {
          const tr = byDir(c.hold, dir);
          const st = stats(tr, hash(sid + coin[0] + dir));
          cells[sid + ':' + coin[0] + ':' + dir] = Object.assign(st, { curve: curve(tr, HOLD_START), hold_pct: c.hold_pct });
        }
      }
    }
    gridCache = {
      updated_at: PRECALC_AT,
      source: 'backtest',
      period: { from: HOLD_START, to: HOLD_END, days: HOLD_DAYS, kind: 'holdout' },
      selection_end: HOLD_START,
      fees: { round_trip_pct: 0.12, slippage_pct: 0.1, note: 'после комиссий, оценка' },
      strategies: Object.keys(STRATS).map((k) => ({ id: k, name: STRATS[k].name, short: STRATS[k].short, tf: STRATS[k].tf, mtf_simplified: STRATS[k].mtfSimplified })),
      coins: COINS.map((c) => ({ sym: c[0], vol24h_musd: c[1] })),
      cells,
    };
    return gridCache;
  }

  const STRESS = {
    '2025-10': { label: '10–11 октября 2025', from: Date.UTC(2025, 9, 10), to: Date.UTC(2025, 9, 12), coins: ['BTC', 'ETH', 'SOL'] },
    '2021-05': { label: 'Май 2021', from: Date.UTC(2021, 4, 1), to: Date.UTC(2021, 5, 1), coins: ['BTC', 'ETH'] },
    '2022-11': { label: 'Ноябрь 2022', from: Date.UTC(2022, 10, 1), to: Date.UTC(2022, 11, 1), coins: ['BTC', 'ETH'] },
  };
  function backtest(sid, sym, period) {
    const sp = STRATS[sid];
    const base = { strategy: sid, coin: sym, tf: sp.tf, period, updated_at: PRECALC_AT, source: 'backtest',
      fees: { round_trip_pct: 0.12, slippage_pct: 0.1 }, mtf_simplified: sp.mtfSimplified };
    if (STRESS[period]) {
      const w = STRESS[period];
      if (w.coins.indexOf(sym) < 0) {
        const listed = LISTED[sym];
        const listedTs = listed ? Date.UTC(+listed.slice(0, 4), +listed.slice(5) - 1, 1) : 0;
        return Object.assign(base, {
          available: false,
          reason: listedTs > w.from ? 'not_listed' : 'no_history',
          listed: listed || null,
          window: { label: w.label, from: w.from, to: w.to },
          available_for: w.coins,
        });
      }
      const r = rng(hash('stress:' + sid + sym + period));
      const c = cell(sid, sym);
      const tr = genTrades(r, sp, w.from, w.to, c.wr - 0.07, (w.to - w.from) / DAY < 5 ? 3.2 : 1.6, { stress: true, minN: 6 });
      return Object.assign(base, {
        available: true, source_note: 'архив стресс-окон',
        window: { label: w.label, from: w.from, to: w.to },
        zones: [{ id: 'stress', from: w.from, to: w.to, trades: tr, stats: stats(tr, 11) }],
        hold_pct: round(period === '2025-10' ? -11 - 6 * r() : -18 - 14 * r(), 1),
      });
    }
    const c = cell(sid, sym);
    const zones = [];
    if (period === 'year') {
      zones.push({ id: 'early', from: YEAR_START, to: SEL_START, trades: c.early, stats: stats(c.early, 3) });
      zones.push({ id: 'sel', from: SEL_START, to: HOLD_START, trades: c.sel, stats: stats(c.sel, 4) });
    }
    zones.push({ id: 'hold', from: HOLD_START, to: HOLD_END, trades: c.hold, stats: stats(c.hold, hash(sid + sym + 'both')) });
    const rs = c.hold.map((x) => x.r);
    const q = [0, 0, 0, 0];
    for (const x of c.hold) q[clamp(Math.floor((x.t - HOLD_START) / (HOLD_END - HOLD_START) * 4), 0, 3)] += x.r;
    return Object.assign(base, {
      available: true,
      selection_end: HOLD_START,
      selection: { from: SEL_START, to: HOLD_START, stats: stats(c.sel, 4) },
      zones,
      mc: mcBand(rs, hash('mc' + sid + sym)),
      quarters: q.map((x) => round(x, 2)),
      hold_pct: c.hold_pct,
    });
  }

  const BOTS = [
    { id: 'lv-majors-1h', v: 1, seed: 922, strategy: 'LEVELS', coins: ['BTC', 'ETH', 'SOL'], extra: 7, dir: 'both', tf: '1H',
      days: 94, n: 96, wr: 0.47, copies: 312, exch: { median_r: 3.1, n: 58 }, regime: ['LONG', 'SHORT', 'RANGE'],
      how: 'Ищет отбой и пробой сильных уровней на 1H. Входит при качестве сетапа от 5/10, цель не меньше 2R, стоп за зоной уровня. После TP1 стоп переносится в безубыток.',
      params: [['Мин. качество', '5 / 10'], ['Мин. R:R', '2,0'], ['Зона уровня', '0,35%'], ['Фильтр тренда', 'старший ТФ']],
      weak: 'Хуже в узком боковике с ложными пробоями и в первые часы после крупных новостей.' },
    { id: 'vol-top10-4h', v: 1, seed: 1541, strategy: 'VOLUME', coins: ['BTC', 'ETH', 'SOL'], extra: 7, dir: 'long', tf: '4H',
      days: 128, n: 60, wr: 0.49, copies: 141, exch: { median_r: 2.2, n: 31 }, regime: ['LONG'],
      how: 'Ждёт всплеск объёма выше среднего за 20 баров и подтверждение скользящими 50/200. Торгует только лонг, стоп под локальным минимумом, цели по ATR.',
      params: [['Всплеск объёма', '× 1,8'], ['MA', '50 / 200'], ['Стоп', '1,2 ATR'], ['Только по тренду', 'да']],
      weak: 'Почти не торгует в нисходящем рынке; в резкий разворот вниз несколько стопов подряд.' },
    { id: 'smc-btceth-15m', v: 2, seed: 1091, strategy: 'SMC', coins: ['BTC', 'ETH'], extra: 0, dir: 'both', tf: '15m',
      days: 71, n: 160, wr: 0.425, copies: 88, exch: { median_r: 1.4, n: 22 }, regime: ['LONG', 'SHORT'],
      how: 'Ищет снятие ликвидности и возврат в зону дисбаланса (FVG / order block) на 15m по направлению 1H. Стоп за экстремумом снятия, цель — следующая ликвидность.',
      params: [['Структура', '1H'], ['Зоны', 'FVG + OB'], ['Мин. R:R', '2,5'], ['Сессии', 'Лондон, Нью-Йорк']],
      weak: 'Много сделок и короткие стопы: комиссии заметно съедают результат. Слабее в азиатскую сессию.' },
    { id: 'lv-ethsol-4h-s', v: 1, seed: 478, strategy: 'LEVELS', coins: ['ETH', 'SOL'], extra: 0, dir: 'short', tf: '4H',
      days: 66, n: 36, wr: 0.455, copies: 37, exch: { median_r: null, n: 9 }, regime: ['SHORT', 'RANGE'],
      how: 'Только шорт: отбой от сопротивления на 4H с подтверждением на 1H. Сделок мало, держит позицию дольше суток.',
      params: [['Мин. качество', '6 / 10'], ['Мин. R:R', '2,2'], ['Зона уровня', '0,5%'], ['Фильтр тренда', 'выкл.']],
      weak: 'В сильном росте почти каждый вход заканчивается стопом.' },
    { id: 'vol-btc-1h', v: 1, seed: 1096, strategy: 'VOLUME', coins: ['BTC'], extra: 0, dir: 'both', tf: '1H',
      days: 88, n: 80, wr: 0.455, copies: 52, exch: { median_r: 0.8, n: 20 }, regime: ['LONG', 'SHORT'],
      how: 'Один BTC на 1H: всплеск объёма плюс пересечение MA 20/50 по направлению 4H. Стоп за свечой всплеска.',
      params: [['Всплеск объёма', '× 2,0'], ['MA', '20 / 50'], ['Стоп', 'за свечой'], ['Только по тренду', 'да']],
      weak: 'В тихие выходные сигналов почти нет; в боковике частые выходы в безубыток.' },
    { id: 'smc-alts-1h', v: 1, seed: 2171, strategy: 'SMC', coins: ['SOL', 'XRP', 'DOGE'], extra: 0, dir: 'both', tf: '1H',
      days: 103, n: 130, wr: 0.395, copies: 64, exch: { median_r: -1.9, n: 27 }, regime: ['LONG'],
      how: 'SMC на альтах: снятие ликвидности на 1H и вход от зоны дисбаланса. Стоп за экстремумом.',
      params: [['Структура', '4H'], ['Зоны', 'OB'], ['Мин. R:R', '2,0'], ['Сессии', 'все']],
      weak: 'За последние 30 дней в минусе: альты ходят за BTC, и сетапы ломаются его движениями.' },
    { id: 'lv-top20-15m', v: 1, seed: 1273, strategy: 'LEVELS', coins: ['BTC', 'ETH', 'SOL'], extra: 17, dir: 'both', tf: '15m',
      days: 41, n: 250, wr: 0.44, copies: 19, exch: { median_r: null, n: 6 }, regime: ['LONG', 'SHORT', 'RANGE'],
      how: 'Уровни на 15m по 20 самым ликвидным монетам. Много сделок, стоп короткий, цель от 1,8R.',
      params: [['Мин. качество', '4 / 10'], ['Мин. R:R', '1,8'], ['Зона уровня', '0,25%'], ['Фильтр тренда', '1H']],
      weak: 'Серии стопов бывают длинными: до 9 подряд на истории. Требует дисциплины по дневному лимиту.' },
    { id: 'smc-eth-4h', v: 1, seed: 5, strategy: 'SMC', coins: ['ETH'], extra: 0, dir: 'both', tf: '4H', status: 'new',
      days: 12, n: 9, wr: 0.45, copies: 0, exch: { median_r: null, n: 0 }, regime: ['LONG', 'SHORT'],
      how: 'SMC на ETH 4H. Опубликован недавно: ждём 30 закрытых сигналов и 30 дней, прежде чем показывать статистику.',
      params: [['Структура', '1D'], ['Зоны', 'FVG'], ['Мин. R:R', '3,0'], ['Сессии', 'все']],
      weak: 'Данных мало: выводы делать рано.' },
  ];
  const ARCHIVE = [
    { id: 'smc-memes-15m', v: 1, strategy: 'SMC', coins: 'DOGE PEPE WIF', tf: '15m', from: 151, to: 104, n: 162, r_total: -8.7, max_dd_r: 11.2, reason: 'Снят: просадка больше 10R' },
    { id: 'lv-l2-1h', v: 1, strategy: 'LEVELS', coins: 'ARB OP', tf: '1H', from: 118, to: 60, n: 74, r_total: 2.1, max_dd_r: 4.6, reason: 'Правка параметров: v1 закрыта, v2 ведёт свой трек' },
    { id: 'vol-ltc-4h', v: 1, strategy: 'VOLUME', coins: 'LTC', tf: '4H', from: 97, to: 18, n: 11, r_total: -0.9, max_dd_r: 3.1, reason: 'Снят: меньше одного сигнала в неделю' },
  ];

  let showcaseCache = null;
  function genBot(b, seed) {
    const sp = STRATS[b.strategy];
    const r = rng(hash('bot:' + b.id + ':' + seed));
    const from = TODAY0 - b.days * DAY + 9 * HOUR;
    const to = NOW - 65 * MIN;
    const spx = Object.assign({}, sp, { n90: b.n * HOLD_DAYS / b.days });
    if (b.tf === '15m' && b.strategy === 'LEVELS') spx.fee = 0.2;
    if (b.tf === '4H' && b.strategy === 'LEVELS') spx.fee = 0.08;
    const tr = genTrades(r, spx, from, to, b.wr, 1);
    const st = stats(tr, hash(b.id));
    const r30 = tr.filter((x) => x.t > NOW - 30 * DAY).reduce((s, x) => s + x.r, 0);
    const bt = genTrades(r, spx, from - HOLD_DAYS * DAY, from, b.wr - 0.01, 1);
    const btSt = stats(bt, 5);
    return { sp, from, tr, st, r30, btSt };
  }
  function buildShowcase() {
    if (showcaseCache) return showcaseCache;
    const bots = BOTS.map((b) => {
      const g = genBot(b, b.seed);
      const sp = g.sp, from = g.from, tr = g.tr, st = g.st, r30 = g.r30, btSt = g.btSt;
      return {
        id: b.id, version: b.v, status: b.status || 'published', strategy: b.strategy, strategy_name: sp.name, short: sp.short,
        coins: b.coins, coins_extra: b.extra, dir: b.dir, tf: b.tf,
        source: 'paper', published_at: from, track_days: b.days, params_frozen: true,
        stats: Object.assign(st, { r_30d: round(r30, 2) }),
        curve: curve(tr, from),
        trades_tail: tr.slice(-24),
        backtest_holdout: { r_total: round(btSt.r_total, 1), pf: btSt.pf, n: btSt.n, period_days: HOLD_DAYS },
        exchange_copies: b.exch,
        copies: b.copies, copies_rule: 'копии, проработавшие не меньше 7 дней',
        regime_fit: b.regime,
        how: b.how, params: b.params, weak: b.weak,
        updated_at: NOW - 11 * MIN,
      };
    });
    const archive = ARCHIVE.map((a) => Object.assign({}, a, { from: TODAY0 - a.from * DAY, to: TODAY0 - a.to * DAY, source: 'paper' }));
    showcaseCache = {
      updated_at: NOW - 11 * MIN,
      rules: { min_signals: 30, min_days: 30, top_window_days: 90, copies_min_days: 7 },
      bots, archive,
      registry: { launched_since: TODAY0 - 158 * DAY, candidates: 14, published: bots.filter((b) => b.status === 'published').length, waiting: 4, archived: archive.length },
    };
    return showcaseCache;
  }

  function buildStats() {
    const sc = buildShowcase();
    const pub = sc.bots.filter((b) => b.status === 'published');
    let signals = 0, closed = 0;
    const o = { tp2plus: 0, tp1be: 0, sl: 0, exp: 0 };
    for (const b of sc.bots) {
      signals += b.stats.n + 1; closed += b.stats.n;
      for (const x of b.trades_tail) { if (x.kind === 'SL') o.sl++; else if (x.kind === 'EXP') o.exp++; else if (x.kind === 'TP1') o.tp1be++; else o.tp2plus++; }
    }
    for (const a of sc.archive) { signals += a.n; closed += a.n; }
    const r30 = pub.map((b) => b.stats.r_30d).sort((a, b) => a - b);
    const med = r30.length % 2 ? r30[(r30.length - 1) / 2] : (r30[r30.length / 2 - 1] + r30[r30.length / 2]) / 2;
    const first = Math.min.apply(null, pub.map((b) => b.published_at));
    return {
      source: 'paper',
      tracked_signals: { value: signals, updated_at: NOW - 3 * MIN },
      closed_signals: { value: closed, updated_at: NOW - 3 * MIN },
      open_signals: { value: signals - closed, updated_at: NOW - 3 * MIN },
      showcase_days: { value: Math.round((NOW - first) / DAY), since: first, updated_at: TODAY0 },
      bots_30d: {
        median_r: round(med, 1), positive: r30.filter((x) => x > 0).length, total: r30.length,
        worst_r: round(r30[0], 1), best_r: round(r30[r30.length - 1], 1), updated_at: NOW - 11 * MIN,
      },
      outcomes_recent: Object.assign(o, { window: 'последние 24 сделки каждого бота', updated_at: NOW - 11 * MIN }),
      registry: sc.registry,
    };
  }

  const FEED_KIND = {
    OPEN: { st: 'open', r: null }, TP1: { st: 'tp1be' }, TP2: { st: 'tp2' }, TP3: { st: 'tp3' }, SL: { st: 'sl' }, EXP: { st: 'exp' },
  };
  let feedSeq = 0;
  function feedItem(t, rnd) {
    const sc = buildShowcase();
    const pub = sc.bots.filter((b) => b.status === 'published');
    const b = pub[Math.floor(rnd() * pub.length)];
    const pool = b.coins.concat(b.coins_extra ? ['XRP', 'DOGE', 'LINK', 'AVAX', 'SUI', 'BNB'] : []);
    const sym = pool[Math.floor(rnd() * pool.length)];
    const u = rnd();
    const kind = u < 0.28 ? 'OPEN' : u < 0.52 ? 'SL' : u < 0.7 ? 'TP1' : u < 0.82 ? 'TP2' : u < 0.89 ? 'TP3' : 'EXP';
    const sp = STRATS[b.strategy];
    let rr = null;
    if (kind === 'SL') rr = -(1 + 0.04 * rnd()) - sp.fee;
    else if (kind === 'TP1') rr = sp.wins[0] - sp.fee;
    else if (kind === 'TP2') rr = sp.wins[1] - sp.fee;
    else if (kind === 'TP3') rr = sp.wins[2] - sp.fee;
    else if (kind === 'EXP') rr = -0.4 + 0.5 * rnd();
    return {
      id: 'f' + (++feedSeq), t: Math.round(t), pair: sym + '/USDT', bot_id: b.id, strategy: b.strategy, strategy_name: sp.name, tf: b.tf,
      side: b.dir === 'long' ? 'LONG' : b.dir === 'short' ? 'SHORT' : (rnd() < 0.5 ? 'LONG' : 'SHORT'),
      status: FEED_KIND[kind].st, r: rr === null ? null : round(rr, 2),
    };
  }
  function buildFeed() {
    const r = Math.random;
    const items = [];
    let t = NOW - 60 * MIN - 2 * MIN;
    for (let i = 0; i < 12; i++) { items.push(feedItem(t, r)); t -= (4 + 9 * r()) * MIN; }
    return { delay_min: 60, levels_hidden: true, source: 'paper', updated_at: NOW - 60 * MIN, items };
  }
  function feedNext(openIds) {
    const r = Math.random;
    if (openIds && openIds.length && r() < 0.5) {
      const id = openIds[Math.floor(r() * openIds.length)];
      const u = r();
      const st = u < 0.45 ? 'sl' : u < 0.8 ? 'tp1be' : 'tp2';
      return { type: 'update', id, status: st, r: st === 'sl' ? round(-1.1 - 0.06 * r(), 2) : st === 'tp1be' ? round(0.62 + 0.1 * r(), 2) : round(1.52 + 0.1 * r(), 2) };
    }
    return { type: 'new', item: feedItem(Date.now() - 60 * MIN, r) };
  }

  const trendState = {
    '15m': { trend: 'LONG', strength: 71, since: NOW - 3.2 * HOUR },
    '1H': { trend: 'LONG', strength: 64, since: NOW - 11 * HOUR },
    '4H': { trend: 'RANGE', strength: 38, since: NOW - 2.1 * DAY },
    '1D': { trend: 'LONG', strength: 57, since: NOW - 9 * DAY },
    '1W': { trend: 'SHORT', strength: 44, since: NOW - 20 * DAY },
    '1M': { trend: 'LONG', strength: 61, since: NOW - 75 * DAY },
  };
  const chg = { BTC: 1.24, ETH: -0.38 };
  function buildTrend(tick) {
    if (tick) {
      chg.BTC = round(clamp(chg.BTC + (Math.random() - 0.5) * 0.08, -6, 6), 2);
      chg.ETH = round(clamp(chg.ETH + (Math.random() - 0.5) * 0.1, -6, 6), 2);
      for (const k of ['15m', '1H']) trendState[k].strength = clamp(trendState[k].strength + Math.round((Math.random() - 0.5) * 3), 20, 95);
    }
    return { symbol: 'BTC', updated_at: Date.now() - 4000, tfs: JSON.parse(JSON.stringify(trendState)), change_24h: { BTC: chg.BTC, ETH: chg.ETH } };
  }

  function buildGenome() {
    return {
      updated_at: PRECALC_AT,
      auto_apply_bots: false,
      strategies: [
        { id: 'LEVELS', tf: '1H', last_run: PRECALC_AT - 25 * MIN, generations: 24, population: 10, best_fitness: 0.61, prev_fitness: 0.57, holdout_check: 'pending' },
        { id: 'SMC', tf: '15m', last_run: PRECALC_AT - DAY - 70 * MIN, generations: 24, population: 10, best_fitness: 0.48, prev_fitness: 0.5, holdout_check: 'failed' },
        { id: 'VOLUME', tf: '4H', last_run: PRECALC_AT - 2 * DAY - 15 * MIN, generations: 24, population: 10, best_fitness: 0.55, prev_fitness: 0.55, holdout_check: 'passed' },
      ],
    };
  }

  const delay = (v, ms) => new Promise((res) => setTimeout(() => res(v), ms));
  window.CHM_MOCK_API = {
    IS_MOCK: true,
    trend: (tick) => delay(buildTrend(tick), 60),
    stats: () => delay(buildStats(), 120),
    feed: () => delay(buildFeed(), 140),
    feedNext: (openIds) => delay(feedNext(openIds), 20),
    showcase: () => delay(buildShowcase(), 160),
    backtestGrid: () => delay(buildGrid(), 90),
    backtest: (sid, sym, period) => delay(backtest(sid, sym, period), 120),
    genome: () => delay(buildGenome(), 80),
    _sync: { buildGrid, buildShowcase, buildStats, backtest, buildFeed, buildTrend, genBot, BOTS },
  };
})();
