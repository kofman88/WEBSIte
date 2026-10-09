/**
 * frontend/app ↔ the data routes: the SPA's calls (app.js `api()`: base "/api/app/", Bearer token,
 * method = opts.method || (body ? POST : GET), JSON body) for dashboard / signals / chart / result /
 * stats / analyze / share / feedback are exactly the routes routes/appData.js serves, and the
 * fields the screens read are in the answers. The chart answer goes through the real
 * frontend/app/chart.js (decision D3) on a recording canvas.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import http from 'http';
import { createRequire } from 'module';
import { setupEnv, insertUser, rawRequest, goldenBars, toFrame } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('frontend');

const APP_DIR = path.join(process.cwd(), '..', 'frontend', 'app');
const APP_JS = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
const CHART_JS = fs.readFileSync(path.join(APP_DIR, 'chart.js'), 'utf8');

const UID = 701;
const BARS = goldenBars('BTC-USDT-SWAP_1h').slice(-200);
const LAST = BARS[BARS.length - 1];
const NOW = Math.floor(LAST[0] / 1000) + 3600 + 120;

let db; let app; let authService; let appRouter; let appData; let bridge; let server; let port; let token;

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  authService = nodeRequire('../../../services/authService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appData = nodeRequire('../../../routes/appData.js');
  bridge = nodeRequire('../../../services/engine/engineBridge.js');
  const ts = nodeRequire('../../../services/traderSettingsService.js');
  insertUser(db, UID);
  const u = ts.getOrCreate(UID);
  Object.assign(u, { sub_plan: 'pro', sub_status: 'active', sub_expires: NOW + 86_400 });
  ts.save(u);
  const entry = LAST[4];
  const ins = db.prepare(`INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, original_sl, tp1, tp2, tp3,
      created_at, strategy, timeframe, quality) VALUES (?, ?, 'BTC-USDT-SWAP', 'LONG', ?, ?, ?, ?, ?, ?, ?, 'LEVELS', '1h', 7)`);
  for (const [tid, age] of [['fw-1', 3 * 3600], ['fw-2', 2 * 3600]]) {
    ins.run(tid, UID, entry, entry * 0.99, entry * 0.99, entry * 1.015, entry * 1.03, entry * 1.045, NOW - age);
  }
  const frame = toFrame(BARS);
  bridge.setOverrides({
    cachedCandles: () => frame, currentPrices: (syms) => Object.fromEntries(syms.map((s) => [s, LAST[4]])),
    globalTrend: () => ({}), marketTrend: () => ({}),
  });
  const rest = {
    async getCandles() { return frame; },
    async get24hChange() { return { last: LAST[4], change_pct: 1.25 }; },
  };
  appRouter.resetRateLimits();
  appRouter.setClock(() => NOW);
  appData.configure({ clock: () => NOW, rest, log: { info() {}, warn() {}, debug() {}, error() {} } });
  appData.resetState();
  token = authService._signAccessToken(UID);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  if (!server) return;
  bridge.setOverrides(null);
  appRouter.setClock(null);
  appData.configure({ clock: null, rest: null, log: null });
  await new Promise((r) => server.close(r));
});

/** app.js api(path, opts) as a raw request. */
async function api(p, opts = {}) {
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const method = opts.method || (opts.body ? 'POST' : 'GET');
  const r = await rawRequest(port, { method, target: `/api/app/${p}`, headers, body: opts.body ? JSON.stringify(opts.body) : null });
  return { status: r.status, d: JSON.parse(r.text) };
}

/** chart.js in a sandbox with a canvas that records what is drawn. */
function renderChart(data, sig) {
  const texts = [];
  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === 'fillText') return (s) => texts.push(String(s));
      return () => {};
    },
    set() { return true; },
  });
  const canvas = { getContext: () => ctx, setAttribute() {}, className: '', width: 0, height: 0 };
  const sandbox = { window: { devicePixelRatio: 1 }, document: { createElement: () => canvas }, Math, Number, String, Array, Object, isFinite, Infinity };
  vm.runInNewContext(CHART_JS, sandbox);
  const cv = sandbox.window.CHMChart.render(data, sig, 'chart');
  return { cv, texts };
}

describe('app.js calls the data routes as served', () => {
  it('API base, auth header, and every data-route call site', () => {
    expect(APP_JS).toContain('var API_BASE = "/api/app/"');
    expect(APP_JS).toContain('headers["Authorization"] = "Bearer " + tok');
    expect(APP_JS).toContain('method: opts.method || (opts.body ? "POST" : "GET")');
    const calls = [
      'api("dashboard")',
      'api("signals?status=" + encodeURIComponent(S.sigFilter) + "&limit=50"',
      'api("signals/" + encodeURIComponent(sig.id) + "/chart", { timeout: 30000 })',
      'api("signals/" + encodeURIComponent(sig.id) + "/result", { method: "POST", body: { result: o[0] } })',
      'api("signals/" + encodeURIComponent(sig.id) + "/result", { method: "POST", body: { note: ta.value } })',
      '"stats?days=" + S.statsDays + (S.statsStrat ? "&strategy=" + S.statsStrat : "")',
      'api("analyze", { method: "POST", body: { symbol: sym, strategy: S.an.strategy }, timeout: 60000 })',
      'api("share", { body: { days: 30 } })',
      'api("feedback", { method: "POST", body: { type: fb.type, text: text }, timeout: 15000 })',
    ];
    for (const c of calls) expect(APP_JS, c).toContain(c);
    // every api("<data route>…") literal in the bundle is one of the above
    const seen = new Set();
    for (const m of APP_JS.matchAll(/api\("(dashboard|signals|stats|analyze|share|feedback)[^"]*"/g)) seen.add(m[0]);
    expect([...seen].sort()).toEqual(['api("analyze"', 'api("dashboard"', 'api("feedback"', 'api("share"', 'api("signals/"', 'api("signals?status="']);
    expect(APP_JS).toContain('var MANUAL_OPTS = [["TP1", "TP1"], ["TP2", "TP2"], ["TP3", "TP3"], ["SL", "Стоп"], ["BE", "БУ"], ["SKIP", "Пропустил"]]');
  });
});

describe('the SPA\'s requests against the real routes', () => {
  it('dashboard / signals: the fields the home and list screens read', async () => {
    const { status, d } = await api('dashboard');
    expect(status).toBe(200);
    expect(d).toMatchObject({ ok: true, stats: { days: 30 } });
    expect(Object.keys(d)).toEqual(['ok', 'stats', 'market', 'recent', 'trend', 'rating', 'market_trend']);
    expect(d.recent.map((s) => s.id)).toEqual(['fw-2', 'fw-1']);
    const l = await api(`signals?status=${encodeURIComponent('all')}&limit=50&strategy=${encodeURIComponent('LEVELS')}`);
    expect(l.status).toBe(200);
    expect(l.d.strategy).toBe('LEVELS');
    expect(l.d.signals.map((s) => s.id)).toEqual(['fw-2', 'fw-1']);
    expect(l.d.signals[0]).toMatchObject({ symbol: 'BTC', strategy: 'LEVELS' });
  });

  it('chart: candles + overlays drawn by chart.js', async () => {
    const { status, d } = await api(`signals/${encodeURIComponent('fw-1')}/chart`, { timeout: 30000 });
    expect(status).toBe(200);
    expect(d.ok).toBe(true);
    expect(d.png).toBe(null);
    expect(d.candles.length).toBe(110);
    expect(d.candles[0]).toHaveLength(6);
    expect(Object.keys(d.overlays)).toEqual(['entry', 'sl', 'tps', 'be', 'ob', 'fvg', 'pivots', 'hvn', 'lvn', 'emas']);
    expect(d.overlays.emas.map((e) => e.label)).toEqual(['EMA 20', 'EMA 50', 'EMA 200']);
    for (const e of d.overlays.emas) expect(e.values).toHaveLength(110);
    const sig = { pair: 'BTC/USDT', timeframe: '1h' };
    const { cv, texts } = renderChart(d, sig);
    expect(cv.className).toBe('chm-chart');
    expect(texts).toEqual(expect.arrayContaining(['EMA 20', 'EMA 50', 'EMA 200', 'CHM BREAKER', 'BTC/USDT  ·  1H']));
    for (const lv of ['TP1', 'TP2', 'TP3', 'ВХОД', 'SL']) expect(texts.some((t) => t.startsWith(`${lv} `)), lv).toBe(true);
    expect(texts).not.toContain('нет свечей');
    // someone else's / unknown trade → not_found, which the detail screen shows as "no_data"
    const nf = await api(`signals/${encodeURIComponent('nope')}/chart`);
    expect([nf.status, nf.d]).toEqual([404, { ok: false, error: 'not_found' }]);
  });

  it('manual result + note: d.signal merged into the card; a second result is already_set', async () => {
    const r = await api(`signals/${encodeURIComponent('fw-1')}/result`, { method: 'POST', body: { result: 'TP1' } });
    expect(r.status).toBe(200);
    expect(r.d.ok).toBe(true);
    expect(r.d.signal).toMatchObject({ id: 'fw-1', manual: true });
    const again = await api(`signals/${encodeURIComponent('fw-1')}/result`, { method: 'POST', body: { result: 'SL' } });
    expect(again.d).toEqual({ ok: false, error: 'already_set', result: 'TP1' });
    const n = await api(`signals/${encodeURIComponent('fw-1')}/result`, { method: 'POST', body: { note: '  вошёл по рынку  ' } });
    expect(n.d.ok).toBe(true);
    expect(n.d.signal.note).toBe('вошёл по рынку');
  });

  it('stats / share / feedback: what the profile screens read', async () => {
    const s = await api('stats?days=30&strategy=LEVELS', { timeout: 15000 });
    expect(s.status).toBe(200);
    expect(s.d.ok).toBe(true);
    const sh = await api('share', { body: { days: 30 } });
    expect(sh.status).toBe(200);
    expect(Object.keys(sh.d)).toEqual(['ok', 'sent', 'days', 'stats']);
    expect(sh.d).toMatchObject({ ok: true, sent: false, days: 30 });
    expect(typeof sh.d.stats).toBe('object');
    const fb = await api('feedback', { method: 'POST', body: { type: 'bug', text: 'Не грузится график' }, timeout: 15000 });
    expect(fb.status).toBe(200);
    expect(fb.d.ok).toBe(true);
    const t = db.prepare('SELECT id, user_id, body FROM support_tickets WHERE user_id = ? ORDER BY id DESC').get(UID);
    expect(fb.d.id).toBe(t.id);
    expect(t.body).toBe('Не грузится график');
  });
});
