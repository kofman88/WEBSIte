/* MOCK: заглушка GET /api/public/* для лендинга (описание в ../README.md). ВСЕ ЧИСЛА ВЫДУМАНЫ.
* Грузится только при DATA_SOURCE = 'mock'. Сделки как в бэктестере Genome: TP 40/30/30, стоп в БУ после TP1, комиссии 0,12% + 0,1%. */
(function () {
'use strict';
var DAY = 864e5, HOUR = 36e5, MIN = 6e4;
function hash(s) { var h = 2166136261 >>> 0; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {
var a = seed >>> 0;
return function () { a = (a + 0x6D2B79F5) >>> 0; var t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r()); }
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
function rd(x, d) { var k = Math.pow(10, d || 0); return Math.round(x * k) / k; }

var NOW = Date.now(), T0 = Math.floor(NOW / DAY) * DAY;
var PRECALC = (NOW - T0 > 40 * MIN ? T0 : T0 - DAY) + 40 * MIN;
var HOLD_END = T0 - DAY, HOLD_DAYS = 88, SEL_DAYS = 80;
var HOLD_START = HOLD_END - HOLD_DAYS * DAY, SEL_START = HOLD_START - SEL_DAYS * DAY, YEAR_START = HOLD_END - 365 * DAY;

// wins: средний итог TP1→БУ / TP2→БУ / TP3 в R до комиссий; fee: комиссии и проскальзывание в R на сделку
var ST = {
LEVELS: { name: 'Уровни', short: 'УР', tf: '1H', n90: 34, wr: 0.44, sd: 0.02, wins: [0.9, 1.9, 3.0], winW: [0.45, 0.33, 0.22], fee: 0.07, hold: 9, genes: 17 },
SMC: { name: 'SMC', short: 'SMC', tf: '15m', n90: 70, wr: 0.42, sd: 0.02, wins: [1.0, 2.1, 3.3], winW: [0.5, 0.32, 0.18], fee: 0.19, hold: 3, genes: 12 },
VOLUME: { name: 'Объём + MA', short: 'ОБ', tf: '4H', n90: 30, wr: 0.45, sd: 0.025, wins: [0.85, 1.7, 2.7], winW: [0.48, 0.32, 0.2], fee: 0.07, hold: 26, genes: 22 }
};
// монета, объём за 24 ч в млн $, активность, «держать монету» за отложенный период, %
var COINS = [['BTC', 18400, 1, -3.2], ['ETH', 9100, 1, -6.8], ['SOL', 2650, 1.1, -11.4], ['XRP', 1900, 0.95, 4.1], ['DOGE', 1320, 1.1, -14.9],
['SUI', 870, 1.15, -19.6], ['BNB', 610, 0.85, 2.3], ['ADA', 540, 0.95, -9.7], ['LINK', 470, 1, -7.5], ['AVAX', 400, 1.05, -16.1],
['LTC', 330, 0.9, -5.2], ['TON', 300, 0.9, -12.8], ['PEPE', 290, 1.2, -24.3], ['TRX', 260, 0.75, 6.2], ['WIF', 240, 1.2, -27.5],
['DOT', 210, 0.9, -13.3], ['NEAR', 190, 1, -10.9], ['APT', 170, 1, -18.2], ['ARB', 150, 1.05, -21.4], ['OP', 130, 1.05, -17.7]];
var LISTED = { SUI: '2023-05', PEPE: '2023-05', WIF: '2024-01', TON: '2023-08', APT: '2022-10', ARB: '2023-03', OP: '2022-06' };

function genTrades(r, sp, from, to, wr, act, o) {
o = o || {};
var n = Math.max(o.minN || 0, Math.round(sp.n90 * ((to - from) / DAY / HOLD_DAYS) * act * (0.85 + 0.3 * r())));
var nW = clamp(Math.round(n * wr + 0.5 * gauss(r) * Math.sqrt(n * wr * (1 - wr))), 0, n), deck = [], out = [], i, j, t;
for (i = 0; i < n; i++) deck.push(i < nW);
for (i = n - 1; i > 0; i--) { j = Math.floor(r() * (i + 1)); t = deck[i]; deck[i] = deck[j]; deck[j] = t; }
for (i = 0; i < n; i++) {
var g, kind, u = r();
if (deck[i]) { var k = u < sp.winW[0] ? 0 : u < sp.winW[0] + sp.winW[1] ? 1 : 2; g = sp.wins[k] * (0.92 + 0.16 * r()); kind = ['TP1', 'TP2', 'TP3'][k]; }
else if (u < 0.85) { g = -(1 + (o.stress ? 0.15 + 0.75 * r() : 0.04 * r())); kind = 'SL'; }
else { g = -0.5 + 0.6 * r(); kind = 'EXP'; }
var fee = sp.fee * (0.85 + 0.3 * r());
out.push({ t: Math.round(from + (to - from) * r()), side: r() < 0.52 ? 'L' : 'S', kind: kind, g: rd(g, 3), fee: rd(fee, 3), r: rd(g - fee, 3), hold_h: rd(sp.hold * (0.3 + 1.4 * r()), 1) });
}
return out.sort(function (a, b) { return a.t - b.t; });
}
function maxDD(rs) { var e = 0, pk = 0, dd = 0; rs.forEach(function (x) { e += x; if (e > pk) pk = e; if (pk - e > dd) dd = pk - e; }); return dd; }
// p95 просадки: перестановки (весь период) или бутстрэп на горизонте h сделок (месяц)
function p95(rs, seed, h) {
if (rs.length < 2) return maxDD(rs);
var r = rng(seed), a = rs.slice(), dds = [], n = a.length;
for (var k = 0; k < 240; k++) {
if (h) { var s = [], q; for (q = 0; q < h; q++) s.push(a[Math.floor(r() * n)]); dds.push(maxDD(s)); continue; }
for (var i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
dds.push(maxDD(a));
}
dds.sort(function (x, y) { return x - y; });
return dds[Math.floor(0.95 * (dds.length - 1))];
}
function band(rs, seed) {
var n = rs.length, r = rng(seed), a = rs.slice(), cols = [], lo = [], hi = [], k, i;
for (i = 0; i < n; i++) cols.push([]);
for (k = 0; k < 200; k++) {
for (i = n - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
var e = 0; for (i = 0; i < n; i++) { e += a[i]; cols[i].push(e); }
}
cols.forEach(function (c) { c.sort(function (x, y) { return x - y; }); lo.push(rd(c[10], 2)); hi.push(rd(c[189], 2)); });
return { p5: lo, p95: hi };
}
function streak(rs) { var s = 0, m = 0; rs.forEach(function (x) { if (x < 0) { s++; if (s > m) m = s; } else s = 0; }); return m; }
function stats(tr, seed, days) {
var rs = tr.map(function (x) { return x.r; }), pos = 0, neg = 0, gross = 0, fee = 0, hold = 0, wins = 0, sl = [];
tr.forEach(function (x) { if (x.r > 0) pos += x.r; else neg -= x.r; gross += x.g; fee += x.fee; hold += x.hold_h; if (x.kind !== 'SL' && x.kind !== 'EXP') wins++; if (x.kind === 'SL') sl.push(x.r); });
var n = tr.length;
return { n: n, wins: wins, r_total: rd(pos - neg, 2), gross_r: rd(gross, 2), fee_r_total: rd(fee, 2), pf: neg > 0 ? rd(pos / neg, 2) : null,
max_dd_r: rd(maxDD(rs), 2), p95_dd_r: rd(p95(rs, seed || 7), 2), p95_month_r: rd(p95(rs, (seed || 7) + 1, Math.max(8, Math.round(n * 30 / (days || HOLD_DAYS)))), 2),
max_loss_streak: streak(rs), avg_hold_h: n ? rd(hold / n, 1) : null, sl_avg_r: sl.length ? rd(sl.reduce(function (s, x) { return s + x; }, 0) / sl.length, 2) : null };
}
function curve(tr, from) { var e = 0, p = [[from, 0]]; tr.forEach(function (x) { e += x.r; p.push([x.t, rd(e, 2)]); }); return p; }
function byDir(tr, d) { return d === 'both' ? tr : tr.filter(function (x) { return x.side === (d === 'long' ? 'L' : 'S'); }); }

var cc = {}, SALT = { 'LEVELS:BTC': '6' };
function cell(sid, sym) {
var key = sid + ':' + sym;
if (cc[key]) return cc[key];
var sp = ST[sid], c = COINS.find(function (x) { return x[0] === sym; }) || COINS[0], r = rng(hash('cell:' + key + (SALT[key] || '')));
var wr = clamp(sp.wr + sp.sd * gauss(r), sp.wr - 0.05, sp.wr + 0.05);
return (cc[key] = { wr: wr, early: genTrades(r, sp, YEAR_START, SEL_START, wr - 0.005, c[2]), sel: genTrades(r, sp, SEL_START, HOLD_START, wr + 0.09, c[2]), hold: genTrades(r, sp, HOLD_START, HOLD_END, wr, c[2]), hold_pct: c[3] });
}
var gridC = null;
function grid() {
if (gridC) return gridC;
var cells = {};
Object.keys(ST).forEach(function (sid) {
COINS.forEach(function (co) {
var c = cell(sid, co[0]);
['both', 'long', 'short'].forEach(function (d) {
var tr = byDir(c.hold, d);
cells[sid + ':' + co[0] + ':' + d] = Object.assign(stats(tr, hash(sid + co[0] + d)), { curve: curve(tr, HOLD_START), hold_pct: c.hold_pct });
});
});
});
return (gridC = { updated_at: PRECALC, source: 'backtest', period: { from: HOLD_START, to: HOLD_END, days: HOLD_DAYS, kind: 'holdout' }, selection_end: HOLD_START,
fees: { round_trip_pct: 0.12, slippage_pct: 0.1, note: 'после комиссий, оценка' },
strategies: Object.keys(ST).map(function (k) { return { id: k, name: ST[k].name, tf: ST[k].tf, mtf_simplified: k !== 'VOLUME' }; }),
coins: COINS.map(function (c) { return { sym: c[0], vol24h_musd: c[1] }; }), cells: cells });
}

// стресс-окна: архив свечей пока не собран, есть только то, что ещё лежит в 365-дневном хранилище
var OCT = { label: '10–11 октября 2025', from: Date.UTC(2025, 9, 10), to: Date.UTC(2025, 9, 12), event: Date.UTC(2025, 9, 10, 21), expires_at: Date.UTC(2026, 9, 11, 23, 59),
px: { BTC: [121.6, 104.8, 112.4], ETH: [4370, 3436, 3765], SOL: [221, 168, 183] } };
var WIN = { '2021-05': 'Май 2021', '2022-11': 'Ноябрь 2022' };
function stress(sid, sym, dir, o) {
var p = OCT.px[sym], r = rng(hash('st:' + sid + sym + dir)), base = { label: OCT.label, from: OCT.from, to: OCT.to, event: OCT.event, expires_at: OCT.expires_at };
if (!p || NOW > OCT.expires_at) return { available: false, reason: !p ? (LISTED[sym] ? 'not_listed' : 'no_history') : 'expired', window: base, available_for: NOW > OCT.expires_at ? [] : Object.keys(OCT.px) };
var price = [], t;
for (t = OCT.from - 2 * DAY; t <= OCT.to + DAY; t += HOUR) {
var h = (t - OCT.event) / HOUR, v;
if (h < 0) v = p[0] * (1 + 0.006 * Math.sin(h / 5) - 0.0016 * Math.max(0, h + 14));
else if (h < 2) v = p[0] * 0.976 + (p[1] - p[0] * 0.976) * (h / 2);
else v = p[1] + (p[2] - p[1]) * (1 - Math.exp(-(h - 2) / 9)) + p[0] * 0.006 * Math.sin(h / 3);
price.push([t, rd(v * (1 + 0.002 * gauss(r)) * (sym === 'BTC' ? 1000 : 1), sym === 'SOL' ? 2 : 0)]);
}
var n = 4 + Math.floor(r() * 3), tr = [], i, ev = Math.floor(13 * n / 36);
for (i = 0; i < n; i++) {
var tt = OCT.from + (8 + Math.floor((i + r() * 0.8) * 36 / n)) * HOUR, side = dir === 'both' ? (r() < 0.55 ? 'S' : 'L') : dir === 'long' ? 'L' : 'S', u = r(), g, kind, gap = false;
if (i === ev) { tt = OCT.event; if (dir !== 'short') side = 'L'; }
var near = tt >= OCT.event - HOUR && tt <= OCT.event + 3 * HOUR;
if (near) u = side === 'L' ? 0 : 1;
if (u < 0.5) { gap = near; g = gap ? -(1.45 + r() * 0.45) : -(1.12 + r() * 0.25); kind = 'SL'; }
else if (u < 0.72) { g = 0.38; kind = 'TP1'; }
else { g = side === 'S' ? 1.9 + r() * 1.1 : 0.95 + r() * 0.5; kind = side === 'S' ? 'TP3' : 'TP2'; }
if (o.pess && kind === 'TP1') { g = -1.08; kind = 'SL'; }
var fee = o.fees ? rd(ST[sid].fee * (1.1 + 0.4 * r()) + (gap ? 0.06 : 0), 3) : 0;
tr.push({ t: Math.round(tt / HOUR) * HOUR, side: side, kind: kind, gap: gap, g: rd(g, 3), fee: fee, r: rd(g - fee, 3), hold_h: rd(1 + r() * 8, 1) });
}
tr.sort(function (a, b) { return a.t - b.t; });
var c = cell(sid, sym), hs = stats(byDir(c.hold, dir), 3);
return { available: true, source_note: 'свечи из 365-дневного хранилища', window: base, price: price,
zones: [{ id: 'stress', from: OCT.from, to: OCT.to, trades: tr, stats: stats(tr, 11, 2) }], mc: band(tr.map(function (x) { return x.r; }), 5),
normal_sl_r: hs.sl_avg_r, hold_pct: rd((p[2] - p[0]) / p[0] * 100, 1) };
}
function run(q) {
var sid = ST[q.strategy] ? q.strategy : 'LEVELS', sym = q.coin || 'BTC', dir = q.dir || 'both', per = q.period || 'hold', sp = ST[sid];
var o = { pess: q.pessimistic === '1', fees: q.fees !== '0' };
var base = { strategy: sid, coin: sym, dir: dir, tf: sp.tf, period: per, updated_at: PRECALC, source: 'backtest', fees: o.fees ? { round_trip_pct: 0.12, slippage_pct: 0.1 } : null, mtf_simplified: sid !== 'VOLUME' };
if (WIN[per]) return Object.assign(base, { available: false, reason: 'no_archive', window: { label: WIN[per] }, available_for: [] });
if (per === '2025-10') return Object.assign(base, stress(sid, sym, dir, o));
var c = cell(sid, sym), zones = [], f = function (tr) { return byDir(tr, dir); };
if (per === 'year') {
zones.push({ id: 'early', from: YEAR_START, to: SEL_START, trades: f(c.early), stats: stats(f(c.early), 3, 205) });
zones.push({ id: 'sel', from: SEL_START, to: HOLD_START, trades: f(c.sel), stats: stats(f(c.sel), 4, SEL_DAYS) });
}
var h = f(c.hold), all = zones.reduce(function (a, z) { return a.concat(z.trades); }, []).concat(h), q4 = [0, 0, 0, 0], x0 = per === 'year' ? YEAR_START : HOLD_START;
zones.push({ id: 'hold', from: HOLD_START, to: HOLD_END, trades: h, stats: stats(h, hash(sid + sym + dir)) });
all.forEach(function (x) { q4[clamp(Math.floor((x.t - x0) / (HOLD_END - x0) * 4), 0, 3)] += x.r; });
return Object.assign(base, { available: true, selection_end: HOLD_START, zones: zones, mc: band(h.map(function (x) { return x.r; }), hash('mc' + sid + sym)),
quarters: q4.map(function (x) { return rd(x, 2); }), hold_pct: c.hold_pct });
}

var BOTS = [
['lv-majors-1h', 1, 395, 'LEVELS', ['BTC', 'ETH', 'SOL'], 7, 'both', '1H', 94, 62, 0.43, 312, [3.1, 58, 0], 3, 'up',
'Ищет отбой и пробой сильных уровней на 1H. Входит при качестве сетапа от 5/10, цель не меньше 2R, стоп за зоной уровня. После TP1 стоп переносится в безубыток.',
[['Мин. качество', '5 / 10'], ['Мин. R:R', '2,0'], ['Зона уровня', '0,35%'], ['Фильтр тренда', 'старший ТФ']], 'Хуже в узком боковике с ложными пробоями и в первые часы после крупных новостей.'],
['vol-top10-4h', 1, 216, 'VOLUME', ['BTC', 'ETH', 'SOL'], 7, 'long', '4H', 128, 45, 0.44, 141, [2.2, 31, 0], 2, 'up',
'Ждёт всплеск объёма выше среднего за 20 баров и подтверждение скользящими 50/200. Торгует только лонг, стоп под локальным минимумом, цели по ATR.',
[['Всплеск объёма', '× 1,8'], ['MA', '50 / 200'], ['Стоп', '1,2 ATR'], ['Только по тренду', 'да']], 'Почти не торгует в нисходящем рынке; в резкий разворот вниз несколько стопов подряд.'],
['smc-btceth-15m', 2, 14, 'SMC', ['BTC', 'ETH'], 0, 'both', '15m', 71, 120, 0.405, 88, [1.4, 22, 1], 5, 'range',
'Ищет снятие ликвидности и возврат в зону дисбаланса (FVG / order block) на 15m по направлению 1H. Стоп за экстремумом снятия, цель — следующая ликвидность.',
[['Структура', '1H'], ['Зоны', 'FVG + OB'], ['Мин. R:R', '2,5'], ['Сессии', 'Лондон, Нью-Йорк']], 'Много сделок и короткие стопы: комиссии заметно съедают результат. Слабее в азиатскую сессию.'],
['lv-ethsol-4h-s', 1, 27, 'LEVELS', ['ETH', 'SOL'], 0, 'short', '4H', 66, 33, 0.425, 37, [null, 9, 0], 3, 'down',
'Только шорт: отбой от сопротивления на 4H с подтверждением на 1H. Сделок мало, держит позицию дольше суток.',
[['Мин. качество', '6 / 10'], ['Мин. R:R', '2,2'], ['Зона уровня', '0,5%'], ['Фильтр тренда', 'выкл.']], 'В сильном росте почти каждый вход заканчивается стопом.'],
['vol-btc-1h', 1, 340, 'VOLUME', ['BTC'], 0, 'both', '1H', 88, 50, 0.425, 52, [0.8, 20, 0], 3, 'range',
'Один BTC на 1H: всплеск объёма плюс пересечение MA 20/50 по направлению 4H. Стоп за свечой всплеска.',
[['Всплеск объёма', '× 2,0'], ['MA', '20 / 50'], ['Стоп', 'за свечой'], ['Только по тренду', 'да']], 'В тихие выходные сигналов почти нет; в боковике частые выходы в безубыток.'],
['smc-alts-1h', 1, 1390, 'SMC', ['SOL', 'XRP', 'DOGE'], 0, 'both', '1H', 103, 90, 0.375, 64, [-1.9, 27, 2], 5, 'up',
'SMC на альтах: снятие ликвидности на 1H и вход от зоны дисбаланса. Стоп за экстремумом.',
[['Структура', '4H'], ['Зоны', 'OB'], ['Мин. R:R', '2,0'], ['Сессии', 'все']], 'За последние 30 дней в минусе: альты ходят за BTC, и сетапы ломаются его движениями.'],
['lv-top20-15m', 1, 8, 'LEVELS', ['BTC', 'ETH', 'SOL'], 17, 'both', '15m', 41, 150, 0.415, 19, [null, 6, 0], 5, 'range',
'Уровни на 15m по 20 самым ликвидным монетам. Много сделок, стоп короткий, цель от 1,8R.',
[['Мин. качество', '4 / 10'], ['Мин. R:R', '1,8'], ['Зона уровня', '0,25%'], ['Фильтр тренда', '1H']], 'Серии стопов бывают длинными: до 9 подряд на истории. Требует дисциплины по дневному лимиту.'],
['smc-eth-4h', 1, 5, 'SMC', ['ETH'], 0, 'both', '4H', 12, 9, 0.45, 0, [null, 0, 0], 3, 'up',
'SMC на ETH 4H. Опубликован недавно: ждём 30 закрытых сигналов и 30 дней, прежде чем показывать статистику.',
[['Структура', '1D'], ['Зоны', 'FVG'], ['Мин. R:R', '3,0'], ['Сессии', 'все']], 'Данных мало: выводы делать рано.', 'new']
];
var ARCH = [
['SMC', 'DOGE PEPE WIF', '15m', 1, 151, 104, 162, -8.7, 11.2, 'Снят: итог трека ниже −8R'],
['LEVELS', 'ARB OP', '1H', 1, 118, 60, 74, 2.1, 4.6, 'Правка параметров: v1 закрыта, v2 ведёт свой трек'],
['VOLUME', 'LTC', '4H', 1, 97, 18, 11, -0.9, 3.1, 'Снят: меньше одного сигнала в неделю']
];
var scC = null;
function showcase() {
if (scC) return scC;
var REG = ['up', 'down', 'range'];
var bots = BOTS.map(function (b) {
var sp = ST[b[3]], r = rng(hash('bot:' + b[0] + ':' + b[2])), from = T0 - b[8] * DAY + 9 * HOUR;
var spx = Object.assign({}, sp, { n90: b[9] * HOLD_DAYS / b[8], fee: b[7] === '15m' ? 0.2 : b[7] === '4H' ? 0.06 : sp.fee });
var tr = genTrades(r, spx, from, NOW - 65 * MIN, b[10], 1), st = stats(tr, hash(b[0]), b[8]);
var bt = stats(genTrades(r, spx, from - HOLD_DAYS * DAY, from, b[10] - 0.01, 1), 5);
var rr = { up: 0, down: 0, range: 0 };
tr.forEach(function (x) { var u = r(), pref = b[14]; var reg = x.r > 0 ? (u < 0.55 ? pref : REG[Math.floor(r() * 3)]) : (u < 0.3 ? pref : REG[Math.floor(r() * 3)]); rr[reg] += x.r; });
var isNew = b[18] === 'new';
return { id: b[0], version: b[1], status: isNew ? 'new' : 'published', strategy: b[3], strategy_name: sp.name, short: sp.short, coins: b[4], coins_extra: b[5], dir: b[6], tf: b[7],
leverage_max: b[13], source: 'paper', published_at: from, track_days: b[8], params_frozen: true,
stats: Object.assign(st, { r_30d: rd(tr.filter(function (x) { return x.t > NOW - 30 * DAY; }).reduce(function (s, x) { return s + x.r; }, 0), 2) }),
curve: curve(tr, from), trades_tail: tr.slice(-24).map(function (x) { return x.kind; }),
backtest_holdout: { r_total: rd(bt.r_total, 1), pf: bt.pf, n: bt.n, period_days: HOLD_DAYS },
exchange_copies: { median_r: b[12][0], n: b[12][1], liquidations: b[12][2] }, copies: b[11], copies_rule: 'копии, проработавшие не меньше 7 дней',
regime_r: { up: rd(rr.up, 1), down: rd(rr.down, 1), range: rd(rr.range, 1) }, how: b[15], params: b[16], weak: b[17],
min_deposit_usd: b[7] === '15m' ? 300 : 150, updated_at: NOW - 11 * MIN };
});
var archive = ARCH.map(function (a) { return { strategy: a[0], coins: a[1], tf: a[2], v: a[3], from: T0 - a[4] * DAY, to: T0 - a[5] * DAY, n: a[6], r_total: a[7], max_dd_r: a[8], reason: a[9], source: 'paper' }; });
var pub = bots.filter(function (b) { return b.status === 'published'; }).length;
return (scC = { updated_at: NOW - 11 * MIN, rules: { min_signals: 30, min_days: 30, top_window_days: 90, copies_min_days: 7 }, bots: bots, archive: archive,
registry: { launched_since: T0 - 158 * DAY, candidates: 14, published: pub, waiting: 14 - pub - archive.length, archived: archive.length } });
}
function statsResp() {
var sc = showcase(), pub = sc.bots.filter(function (b) { return b.status === 'published'; }), sig = 0, cl = 0, o = { tp2plus: 0, tp1be: 0, sl: 0, exp: 0 };
sc.bots.forEach(function (b) { sig += b.stats.n + 1; cl += b.stats.n; b.trades_tail.forEach(function (k) { if (k === 'SL') o.sl++; else if (k === 'EXP') o.exp++; else if (k === 'TP1') o.tp1be++; else o.tp2plus++; }); });
sc.archive.forEach(function (a) { sig += a.n; cl += a.n; });
var r30 = pub.map(function (b) { return b.stats.r_30d; }).sort(function (a, b) { return a - b; }), m = r30.length;
var first = Math.min.apply(null, pub.map(function (b) { return b.published_at; })), u = NOW - 3 * MIN;
return { source: 'paper', tracked_signals: { value: sig, updated_at: u }, closed_signals: { value: cl, updated_at: u }, open_signals: { value: sig - cl, updated_at: u },
showcase_days: { value: Math.round((NOW - first) / DAY), since: first, updated_at: T0 },
bots_30d: { median_r: rd(m % 2 ? r30[(m - 1) / 2] : (r30[m / 2 - 1] + r30[m / 2]) / 2, 1), positive: r30.filter(function (x) { return x > 0; }).length, total: m, worst_r: rd(r30[0], 1), best_r: rd(r30[m - 1], 1), updated_at: NOW - 11 * MIN },
outcomes_recent: Object.assign(o, { window: 'последние 24 сделки каждого бота', updated_at: NOW - 11 * MIN }), registry: sc.registry };
}

// лента: путь статуса сделки open → tp1 → be / tp2 / tp3, sl, exp; задержка 60 минут, уровни скрыты
var seq = 0, live = {};
var RES = { tp1be: [0.3, 0.45], tp2be: [0.9, 1.1], tp3: [1.7, 2.1], sl: [-1.15, -1.02], exp: [-0.35, 0.2] };
var PATH = { open: ['open'], tp1: ['open', 'tp1'], tp1be: ['open', 'tp1', 'be'], tp2be: ['open', 'tp1', 'tp2', 'be'], tp3: ['open', 'tp1', 'tp2', 'tp3'], sl: ['open', 'sl'], exp: ['open', 'exp'] };
function item(t, st) {
var pub = showcase().bots.filter(function (b) { return b.status === 'published'; }), b = pub[Math.floor(Math.random() * pub.length)];
var pool = b.coins.concat(b.coins_extra ? ['XRP', 'DOGE', 'LINK', 'AVAX', 'SUI', 'BNB'] : []), sym = pool[Math.floor(Math.random() * pool.length)];
var it = { id: 'f' + (++seq), t: Math.round(t), pair: sym + '/USDT', bot_id: b.id, strategy: b.strategy, strategy_name: b.strategy_name, tf: b.tf,
side: b.dir === 'long' ? 'LONG' : b.dir === 'short' ? 'SHORT' : Math.random() < 0.5 ? 'LONG' : 'SHORT' };
return setSt(it, st);
}
function setSt(it, st) { var a = RES[st]; it.status = st; it.path = PATH[st]; it.r = a ? rd(a[0] + (a[1] - a[0]) * Math.random(), 2) : null; return it; }
function pickSt() { var u = Math.random(); return u < 0.2 ? 'open' : u < 0.3 ? 'tp1' : u < 0.55 ? 'sl' : u < 0.72 ? 'tp1be' : u < 0.84 ? 'tp2be' : u < 0.91 ? 'tp3' : 'exp'; }
function feed(q) {
if (!q.after) {
var items = [], t = NOW - 62 * MIN;
for (var i = 0; i < 14; i++) { var it = item(t, pickSt()); items.push(it); live[it.id] = it; t -= (4 + 9 * Math.random()) * MIN; }
return { delay_min: 60, levels_hidden: true, source: 'paper', updated_at: NOW - 60 * MIN, cursor: 'c' + seq, items: items };
}
var open = Object.keys(live).filter(function (k) { return live[k].status === 'open' || live[k].status === 'tp1'; }), ev;
if (open.length && Math.random() < 0.55) {
var x = live[open[Math.floor(Math.random() * open.length)]], u = Math.random();
setSt(x, x.status === 'open' ? (u < 0.5 ? 'sl' : 'tp1') : (u < 0.55 ? 'tp1be' : u < 0.85 ? 'tp2be' : 'tp3'));
ev = { type: 'update', id: x.id, status: x.status, path: x.path, r: x.r };
} else { var n = item(Date.now() - 60 * MIN, Math.random() < 0.6 ? 'open' : pickSt()); live[n.id] = n; ev = { type: 'new', item: n }; }
return { cursor: 'c' + seq, updated_at: Date.now() - 60 * MIN, events: [ev] };
}

var TR = { '15m': ['LONG', 71, 3.2], '1H': ['LONG', 64, 11], '4H': ['RANGE', 38, 50], '1D': ['LONG', 57, 216], '1W': ['SHORT', 44, 480], '1M': ['LONG', 61, 1800] }, chg = { BTC: 1.24, ETH: -0.38 };
function trend(q) {
if (q.tick) {
chg.BTC = rd(clamp(chg.BTC + (Math.random() - 0.5) * 0.08, -6, 6), 2); chg.ETH = rd(clamp(chg.ETH + (Math.random() - 0.5) * 0.1, -6, 6), 2);
['15m', '1H'].forEach(function (k) { TR[k][1] = clamp(TR[k][1] + Math.round((Math.random() - 0.5) * 3), 20, 95); });
}
var tfs = {};
Object.keys(TR).forEach(function (k) { tfs[k] = { trend: TR[k][0], strength: TR[k][1], since: NOW - TR[k][2] * HOUR }; });
return { symbol: 'BTC', updated_at: Date.now() - 4000, tfs: tfs, change_24h: { BTC: chg.BTC, ETH: chg.ETH } };
}

// Genome: история фитнеса по поколениям (популяция 10 × 24 поколения), лучший геном, проверка на отложенном периоде
function genome() {
var G = [['LEVELS', 25 * MIN, 0.61, 0.57, 'pending', [0.47, 1.36, 64, 80], [0.44, 1.12, 41, 4.2]], ['SMC', DAY + 70 * MIN, 0.48, 0.5, 'failed', [0.45, 1.28, 102, 40], [0.39, 0.93, 57, -2.6]],
['VOLUME', 2 * DAY + 15 * MIN, 0.55, 0.55, 'passed', [0.5, 1.45, 38, 120], [0.47, 1.21, 26, 3.1]]];
return { updated_at: PRECALC, auto_apply_bots: false, live_pf_factor: 0.6, strategies: G.map(function (g) {
var r = rng(hash('gen:' + g[0])), hist = [], best = g[2];
for (var k = 0; k < 24; k++) {
var f = k / 23, top = -0.05 + (best + 0.05) * (1 - Math.pow(1 - f, 2.2)), pop = [];
for (var i = 0; i < 10; i++) pop.push(rd(i === 0 ? top : top - Math.abs(gauss(r)) * (0.34 * (1 - f) + 0.07) - (r() < 0.22 * (1 - f) ? 0.35 : 0), 3));
hist.push(pop);
}
hist[23][0] = best;
return { id: g[0], tf: ST[g[0]].tf, last_run: PRECALC - g[1], generations: 24, population: 10, genes: ST[g[0]].genes, best_fitness: g[2], prev_fitness: g[3], holdout_check: g[4],
history: hist, best: { fitness: g[2], wr: g[5][0], pf: g[5][1], n: g[5][2], selection_days: g[5][3] }, holdout: { wr: g[6][0], pf: g[6][1], n: g[6][2], sum_r: g[6][3], days: HOLD_DAYS } };
}) };
}

var H = { trend: trend, stats: statsResp, feed: feed, showcase: showcase, genome: genome, sandbox: function (q) { return q.strategy ? run(q) : grid(); } };
window.CHM_MOCK = {
get: function (path, q) {
var f = H[path];
return new Promise(function (ok, no) { setTimeout(function () { try { ok(f(q || {})); } catch (e) { no(e); } }, 40 + Math.random() * 80); });
}
};
})();
