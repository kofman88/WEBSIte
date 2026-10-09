/**
 * /api/app data routes (routes/appData.js) vs the bot's own handlers, request by request.
 *
 * Fixture: py/drive_app_data.py ran miniapp_api's h_dashboard / h_signals / h_signal_chart /
 * h_signal_result / h_stats / h_analyze / h_share / h_feedback (CPython 3.11, aiohttp 3.14, the bot's
 * DB layer on a seeded temp SQLite, raw request targets over a socket, time.time pinned per step).
 * Here the same seed goes into the site DB, the same raw targets / bodies go through the full
 * Express app over a socket with the user's JWT, and every step must give the bot's HTTP status and
 * the bot's JSON value (key order included; NaN / Infinity literals parsed like json.loads), the
 * bot's DB writes (trade row, trade_events, kv quota counters, feedback → support ticket) and the
 * bot's [MINIAPP] / [MANUAL-RESULT] log lines.
 *
 * Where the site answers by decision D3 instead of a PNG the expectation is derived from what the
 * bot's renderer got: the chart / analyze payload = the renderer's inputs run through the renderer's
 * own data steps (driver's mirror_chart, cross-checked there against the real render's None),
 * share = the stats the card was drawn from. Router-level answers (aiohttp's 404 / 405 text, the
 * 500 of an exception in a handler) compare status, Allow, Content-Type and the body byte for byte.
 *
 * Regenerate: py/drive_app_data.py (see its docstring).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createRequire } from 'module';
import { setupEnv, loadFixture, rawRequest, makeMarket, seedAll, same, firstDiff } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('replay');

const FX = loadFixture();
let db; let app; let ts; let authService; let appRouter; let appData; let bridge; let TM; let server; let port;
let pyJsonParse;
const clock = { now: FX.now };
const LOGS = [];
const log = {
  info: (m) => LOGS.push(`INFO ${m}`), warn: (m) => LOGS.push(`WARNING ${m}`), debug: () => {}, error: (m) => LOGS.push(`ERROR ${m}`),
};
let market;

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  ts = nodeRequire('../../../services/traderSettingsService.js');
  authService = nodeRequire('../../../services/authService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appData = nodeRequire('../../../routes/appData.js');
  bridge = nodeRequire('../../../services/engine/engineBridge.js');
  TM = nodeRequire('../../../services/engine/trendMonitor.js');
  ({ pyJsonParse } = nodeRequire('../../../services/engine/pyjson.js'));
  seedAll(db, ts, FX);
  market = makeMarket(FX, clock);
  const monitor = TM.createTrendMonitor({ kv: { get: () => null, set() {}, del() {}, has: () => false }, log: { debug() {}, info() {}, warning() {} } });
  market.monitor = monitor;
  bridge.setOverrides({ ...market.bridge, marketTrend: () => monitor.getAll() });
  appRouter.resetRateLimits();
  appRouter.setClock(() => clock.now);
  appData.configure({ clock: () => clock.now, rest: market.rest, log });
  appData.resetState();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  bridge.setOverrides(null);
  appRouter.setClock(null);
  appData.configure({ clock: null, rest: null, log: null });
  await new Promise((r) => server.close(r));
});

const SITE_PREFIX = '/api/app';
const BOT_PREFIX = '/miniapp/api';
const MARKERS = /^(INFO|WARNING) \[(MINIAPP|MANUAL-RESULT)\]/;

/** The site's expected JSON for a step (D3 substitutions) or null when only the status is compared. */
function expectedJson(s) {
  if (s.status === 500) return null;
  if (!(s.headers['content-type'] || '').startsWith('application/json')) return null;
  const bot = pyJsonParse(s.text);
  const route = s.name.split(' ')[0];
  if ((route === 'chart' || s.path.endsWith('/chart')) && bot.ok) {
    expect(s.renders.length, s.name).toBe(1);
    return { ok: true, png: null, ...s.renders[0].mirror };
  }
  if (route === 'analyze' && bot.ok) {
    const { png, ...rest } = bot;
    if (png === null) return { ...rest, png: null };
    expect(s.renders.length, s.name).toBe(1);
    return { ...rest, png: null, ...s.renders[0].mirror };
  }
  if (route === 'share' && bot.ok) {
    expect(s.shares.length, s.name).toBe(1);
    return { ok: true, sent: false, days: s.shares[0].days, stats: s.shares[0].stats };
  }
  return bot;
}

function expectedLogs(s) {
  const lines = s.logs.filter((l) => MARKERS.test(l));
  const route = s.name.split(' ')[0];
  if (route === 'share' && s.status === 200 && s.shares.length) {
    // the bot logs the share line only after sending the photo (bot=None in the driver); the site always does
    const st = s.shares[0].stats;
    lines.push(`INFO [MINIAPP] share uid=${s.uid} days=${s.shares[0].days} signals=${st.signals}`);
  }
  return lines;
}

function kvRows(uid) {
  const rows = db.prepare('SELECT key, value FROM engine_kv WHERE key LIKE ? OR key LIKE ? ORDER BY key')
    .all(`analyze_count_${uid}_%`, `miniapp_feedback_${uid}_%`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function tradeState(tid) {
  const row = db.prepare('SELECT result, result_rr, skip_reason, state, state_changed_at, user_note FROM signal_trades WHERE trade_id=?').get(tid);
  const ev = db.prepare('SELECT ts, event_type, payload_json FROM trade_events WHERE trade_id=? ORDER BY id').all(tid);
  return { row: row ? [row.result, row.result_rr, row.skip_reason, row.state, row.state_changed_at, row.user_note] : null,
    events: ev.map((e) => [e.ts, e.event_type, e.payload_json]) };
}

describe(`Mini App data routes — ${FX.steps.length} requests replayed against the bot`, () => {
  it('seed: users, 300+ trades, events, kv', () => {
    expect(FX.users.length).toBeGreaterThanOrEqual(15);
    expect(FX.trades.length).toBeGreaterThanOrEqual(300);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_trades').get().n).toBe(FX.trades.length);
  });

  it('every step: status, JSON, DB writes, log markers', async () => {
    const bad = [];
    const tokens = {};
    const seen = { json: 0, text: 0, chartPayload: 0, analyzeChart: 0, share: 0, trade: 0, kv: 0, tickets: 0, logs: 0 };
    for (const s of FX.steps) {
      clock.now = s.now;
      const st = s.set || {};
      if (st.tickers) Object.assign(market.STATE.tickers, st.tickers);
      if (st.rest) Object.assign(market.STATE.rest, st.rest);
      if (Object.prototype.hasOwnProperty.call(st, 'trend_raw')) market.STATE.trend_raw = st.trend_raw;
      if (st.trend_state) {
        market.monitor._resetForTests();
        market.monitor._seed(st.trend_state, st.trend_strength || {});
      }
      LOGS.length = 0;
      const headers = {};
      if (s.uid !== null) {
        if (!tokens[s.uid]) tokens[s.uid] = authService._signAccessToken(s.uid);
        headers.Authorization = `Bearer ${tokens[s.uid]}`;
      }
      if (s.ctype) headers['Content-Type'] = s.ctype;
      const target = SITE_PREFIX + s.path.slice(BOT_PREFIX.length);
      const res = await rawRequest(port, { method: s.method, target, headers, body: s.body });
      const problems = [];
      if (res.status !== s.status) problems.push(`status ${res.status} vs bot ${s.status}`);
      const want = expectedJson(s);
      if (want !== null && res.status === s.status) {
        let got;
        try { got = pyJsonParse(res.text); } catch (_e) { got = `unparsable: ${res.text.slice(0, 120)}`; }
        const d = firstDiff(got, want);
        if (d) problems.push(`json ${d}`);
        seen.json += 1;
        if (want.candles && want.overlays) seen[s.path.endsWith('/analyze') ? 'analyzeChart' : 'chartPayload'] += 1;
        if (want.sent === false) seen.share += 1;
      }
      const botType = s.headers['content-type'] || '';
      if (res.status === s.status && botType.startsWith('text/plain')) {
        seen.text += 1;
        if (res.text !== s.text) problems.push(`text ${JSON.stringify(res.text)} vs ${JSON.stringify(s.text)}`);
        if (res.headers['content-type'] !== botType) problems.push(`content-type ${res.headers['content-type']} vs ${botType}`);
      }
      if (s.status === 429 && res.headers['retry-after'] !== s.headers['retry-after']) problems.push(`retry-after ${res.headers['retry-after']}`);
      if (s.status === 405 && res.headers.allow !== s.headers.allow) problems.push(`allow ${res.headers.allow} vs ${s.headers.allow}`);
      if (s.uid !== null && s.kv && !same(kvRows(s.uid), s.kv)) problems.push(`kv ${JSON.stringify(kvRows(s.uid))} vs ${JSON.stringify(s.kv)}`);
      if (s.trade) {
        seen.trade += 1;
        const d = firstDiff(tradeState(s.trade), s.trade_state);
        if (d) problems.push(`trade ${d}`);
      }
      if (s.kv && Object.keys(s.kv).length) seen.kv += 1;
      if (s.feedback_rows) {
        seen.tickets += 1;
        const tickets = db.prepare('SELECT id, user_id, body FROM support_tickets ORDER BY id').all();
        const want2 = s.feedback_rows.map(([id, uid, , text]) => [id, uid, text]);
        const got2 = tickets.map((t) => [t.id, t.user_id, t.body]);
        if (!same(got2, want2)) problems.push(`tickets ${JSON.stringify(got2).slice(-200)} vs ${JSON.stringify(want2).slice(-200)}`);
      }
      const gotLogs = LOGS.filter((l) => MARKERS.test(l));
      if (gotLogs.length) seen.logs += 1;
      if (!same(gotLogs, expectedLogs(s))) problems.push(`logs ${JSON.stringify(gotLogs)} vs ${JSON.stringify(expectedLogs(s))}`);
      if (problems.length) bad.push({ step: s.name, path: s.path, body: s.body && s.body.slice(0, 80), problems });
    }
    expect(bad).toEqual([]);
    // the comparison really ran over the interesting answers
    expect(seen.json).toBeGreaterThanOrEqual(280);
    expect(seen.text).toBe(FX.steps.filter((s) => (s.headers['content-type'] || '').startsWith('text/plain')).length);
    expect(seen.text).toBeGreaterThanOrEqual(16);                // router 404 / 405 text + the two 500s
    expect(seen.chartPayload).toBeGreaterThanOrEqual(40);
    expect(seen.analyzeChart).toBeGreaterThanOrEqual(5);
    expect(seen.share).toBeGreaterThanOrEqual(15);
    expect(seen.trade).toBeGreaterThanOrEqual(35);
    expect(seen.kv).toBeGreaterThanOrEqual(20);
    expect(seen.tickets).toBeGreaterThanOrEqual(20);
    expect(seen.logs).toBeGreaterThanOrEqual(40);
  }, 120_000);
});
