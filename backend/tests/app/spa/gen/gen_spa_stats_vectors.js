'use strict';
/**
 * gen_spa_stats_vectors.js — the bot's own Mini App front end (miniapp/static/app.js, [STATS-HONEST
 * 2026-10]: statsBlock / equityCard / stratRow / statWindow / summaryBar / isLive / finalR / liveR)
 * rendered under node (../harness.js: stub h(), fixed clock, UTC dates) over the bot's real API
 * answers — every 200 dashboard / signals body of tests/app/data/fixtures/app_data_replay.json.gz
 * (py/drive_app_data.py) — plus edge cases (an old backend without the [STATS-HONEST] fields, empty
 * stats, the real-window boundary, the refuters' exchange BE at +0.02R). The site's
 * frontend/app/app.js must render the same trees (statsScreens.test.js).
 *
 *   node backend/tests/app/spa/gen/gen_spa_stats_vectors.js [OUT]
 *   (CHM_BOT_DIR=<bot tree> reads <bot tree>/miniapp/static/app.js; default the bot checkout)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const H = require('../harness');
const { pyJsonParse } = require('../../../../services/engine/pyjson');

const BOT = process.env.CHM_BOT_DIR || '/home/user/MAIN_BOT/CHM_BREAKER_V4';
const BOT_APP = path.join(BOT, 'miniapp', 'static', 'app.js');
const FX = path.join(__dirname, '..', '..', 'data', 'fixtures', 'app_data_replay.json.gz');
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..', 'fixtures', 'spa_stats_vectors.json.gz');

const src = fs.readFileSync(BOT_APP, 'utf8');
const app = H.load(src);
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(FX)).toString('utf8'));

const SIG_KEYS = ['id', 'symbol', 'direction', 'strategy', 'entry', 'sl', 'sl0', 'tp1', 'tp2', 'tp3', 'status', 'rr',
  'net_rr', 'final', 'price', 'r_now'];
const slim = (s) => Object.fromEntries(SIG_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(s, k)).map((k) => [k, s[k]]));
const HONEST = ['final_trades', 'final_wins', 'final_losses', 'final_be', 'final_win_rate', 'net_rr', 'net_rr_7d', 'first_ts',
  'open_live', 'equity_net', 'cost_pct', 'exchange_cost_pct'];
function oldBackend(st) {               // the payload of a backend before [STATS-HONEST]
  const o = JSON.parse(JSON.stringify(st));
  for (const k of HONEST) delete o[k];
  for (const b of Object.values(o.per_strategy || {})) for (const k of HONEST) delete b[k];
  return o;
}

const home = [];
const lists = [];
const seenHome = new Set();
const seenList = new Set();
for (const s of fx.steps) {
  if (s.status !== 200 || !(s.headers['content-type'] || '').startsWith('application/json')) continue;
  let d;
  try { d = pyJsonParse(s.text); } catch (_e) { continue; }
  if (!d || d.ok !== true) continue;
  const nowMs = Math.round(s.now * 1000);
  if (s.path.endsWith('/dashboard')) {
    const key = JSON.stringify(d.stats);
    if (!seenHome.has(key)) { seenHome.add(key); home.push({ name: s.name, nowMs, stats: d.stats }); }
    const items = (d.recent || []).map(slim);
    const k2 = JSON.stringify(items);
    if (items.length && !seenList.has(k2)) { seenList.add(k2); lists.push({ name: `${s.name} recent`, items }); }
  } else if (s.path.includes('/signals') && Array.isArray(d.signals)) {
    const items = d.signals.map(slim);
    const key = JSON.stringify(items);
    if (!seenList.has(key)) { seenList.add(key); lists.push({ name: s.name, items }); }
  }
}

// edge cases
const h117 = home.find((c) => c.name === 'dashboard 117 honest');
if (!h117) throw new Error('dashboard 117 honest missing from the app data fixture');
const DAY = 86400;
const now0 = h117.nowMs;
home.push({ name: 'old backend (no [STATS-HONEST] fields)', nowMs: now0, stats: oldBackend(h117.stats) });
home.push({ name: 'empty stats', nowMs: now0, stats: {} });
home.push({ name: 'nothing final yet', nowMs: now0, stats: { ...h117.stats, final_trades: 0, final_wins: 0, final_win_rate: 0.0 } });
for (const [nm, ft] of [['first_ts 4 d ago', now0 / 1000 - 4 * DAY], ['first_ts 29.5 d ago', now0 / 1000 - 29.5 * DAY],
  ['first_ts 30 d ago', now0 / 1000 - 30 * DAY], ['first_ts 31 d ago', now0 / 1000 - 31 * DAY], ['first_ts null', null],
  ['first_ts 1 s ago', now0 / 1000 - 1]]) {
  home.push({ name: nm, nowMs: now0, stats: { ...h117.stats, first_ts: ft } });
}
home.push({ name: 'days 7, first_ts 3 d ago', nowMs: now0, stats: { ...h117.stats, days: 7, first_ts: now0 / 1000 - 3 * DAY } });
home.push({ name: 'locked strategies', nowMs: now0, stats: h117.stats,
  cfg: { LEVELS: { locked: true }, SMC: { locked: false, enabled: false }, VOLUME: { locked: false, enabled: true, primary: true } } });
lists.push({ name: 'refuters: exchange BE +0.02R and TP3', items: [
  { id: 'a', status: 'be', final: true, rr: 0.02, net_rr: -0.18 }, { id: 'b', status: 'tp3', final: true, rr: 3.9, net_rr: 3.65 }] });
lists.push({ name: 'old API (no final / net_rr)', items: lists[0].items.map((x) => {
  const { final: _f, net_rr: _n, ...rest } = x;
  return rest;
}) });
lists.push({ name: 'exchange-closed TP1 is not live', items: [
  { id: 'c', status: 'tp1', final: true, rr: 0.95, net_rr: 0.75, price: 101, r_now: 1.2 },
  { id: 'd', status: 'tp1', final: false, rr: 1.0, net_rr: 0.75, r_now: 0.4 },
  { id: 'e', status: 'open', final: false, rr: null, net_rr: null, entry: 100, sl: 100, sl0: 99.4, price: 100.3, direction: 'LONG' },
  { id: 'f', status: 'sl', final: true, rr: -1.0, net_rr: -1.25 }, { id: 'g', status: 'skip', final: true, rr: null, net_rr: null }] });
lists.push({ name: 'empty list', items: [] });

const out = {
  source: 'miniapp/static/app.js',
  home: home.map((c) => ({ ...c, out: app.render(c) })),
  lists: lists.map((c) => ({ ...c, out: app.bar(c.items) })),
  sig_limit: /var SIG_LIMIT = (\d+);/.exec(src)[1],
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(`${JSON.stringify(out)}\n`, 'utf8'), { level: 9 }));   // gzip mtime 0 → deterministic
console.log('written', OUT, 'home', out.home.length, 'lists', out.lists.length);
