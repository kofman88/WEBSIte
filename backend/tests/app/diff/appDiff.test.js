/**
 * Adversarial differential replay of the /api/app data routes against the bot, BYTE FOR BYTE.
 *
 * Fixture: py/drive_app_diff.py (an independent driver: its own seed, clock and chart mirror) ran
 * miniapp_api's h_dashboard / h_signals / h_signal_chart / h_signal_result / h_stats / h_analyze /
 * h_share / h_feedback on CPython 3.11 / aiohttp 3.14 — aiohttp's router answers, the handlers'
 * auth and POST bucket in front of them — over raw sockets against a nasty seeded DB (NULL in
 * every nullable column, legacy values, TEXT in REAL columns, ancient / future / infinite
 * timestamps, huge / infinite R, unicode symbols, look-alike ids, trade_events id gaps, hostile kv
 * counters) with hostile requests (page / limit / days as negative / huge / float / text /
 * unicode digits, unknown filters, path ids 0 / -1 / 1e3 / 01 / 20 nines / %00, > 1 MiB bodies,
 * odd charsets, lone surrogates, NaN / 1e400 literals).
 *
 * Here the same seed goes into the site DB and the same raw requests go through the full Express
 * app with the user's JWT. Per step the site must give the bot's status, Content-Type /
 * Cache-Control / Retry-After / Allow, the bot's response BYTES (json.dumps: ", " / ": "
 * separators, ensure_ascii escapes, float repr `0.0` / `1e+16`, NaN / Infinity literals, dict key
 * order) — or, where the site answers by decision D3, the bytes the driver built from what the
 * bot's renderer / share card received — and the bot's side effects: the touched trade row (every
 * column and its SQLite storage class), its trade_events (id, ts, type, payload) and trade_feedback
 * row, the analyze / feedback kv counters, the feedback rows (→ support tickets: id, user, text,
 * type), the in-memory post / chart / share buckets, the analyze cooldown, the market cache, the
 * user row the handler creates and the [MINIAPP] / [MANUAL-RESULT] / [CHART-PMULT-MISMATCH] lines.
 *
 * Regenerate: py/drive_app_diff.py (see its docstring).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createRequire } from 'module';
import {
  setupEnv, loadFixture, rawRequest, stepBody, makeMarket, seedAll, seededTypes, applySql, same, byteDiff,
} from './harness.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('replay');

const FX = loadFixture();
let db; let app; let ts; let authService; let appRouter; let appData; let bridge; let TM; let server; let port;
let pyJsonParse; let pyJsonDumps;
const clock = { now: FX.now };
const LOGS = [];
const log = {
  info: (m) => LOGS.push(`INFO ${m}`), warn: (m) => LOGS.push(`WARNING ${m}`), warning: (m) => LOGS.push(`WARNING ${m}`),
  debug: () => {}, error: (m) => LOGS.push(`ERROR ${m}`),
};
let market;
const RESULTS = [];

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  ts = nodeRequire('../../../services/traderSettingsService.js');
  authService = nodeRequire('../../../services/authService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appData = nodeRequire('../../../routes/appData.js');
  bridge = nodeRequire('../../../services/engine/engineBridge.js');
  TM = nodeRequire('../../../services/engine/trendMonitor.js');
  ({ pyJsonParse, pyJsonDumps } = nodeRequire('../../../services/engine/pyjson.js'));
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
const MARKERS = /^(INFO|WARNING) \[(MINIAPP|MANUAL-RESULT|CHART-PMULT-MISMATCH)\]/;
const FEEDBACK_TYPE_OF_SUBJECT = [[/^🐛 /, 'bug'], [/^💡 /, 'feature'], [/^❓ /, 'question']];
const TF_ORDER = ['15m', '30m', '1h', '4h', '1d'];

function kvRows(uid) {
  const rows = db.prepare('SELECT key, value FROM engine_kv WHERE key LIKE ? OR key LIKE ? ORDER BY key')
    .all(`analyze_count_${uid}_%`, `miniapp_feedback_${uid}_%`);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

function tradeState(tid, cols) {
  const row = db.prepare(`SELECT ${cols.map((c) => `${c}, typeof(${c}) AS "t_${c}"`).join(', ')} FROM signal_trades WHERE trade_id=?`).get(tid);
  const events = db.prepare('SELECT id, ts, event_type, payload_json FROM trade_events WHERE trade_id=? ORDER BY id').all(tid)
    .map((e) => [e.id, e.ts, e.event_type, e.payload_json]);
  // trade_feedback: every column with its storage class; the features JSON byte for byte with the
  // wall-clock session_hour masked (the bot's datetime.utcnow() is not the pinned clock)
  const fbCols = ['id', 'user_id', 'trade_id', 'symbol', 'strategy', 'direction', 'entry', 'sl', 'tp1', 'result', 'pnl_pct',
    'regime', 'features', 'ts'];
  const feedback = db.prepare(`SELECT ${fbCols.map((c) => `${c}, typeof(${c}) AS "t_${c}"`).join(', ')} FROM trade_feedback WHERE trade_id=? ORDER BY id`)
    .all(tid).map((f) => {
      const rec = Object.fromEntries(fbCols.map((c) => [c, [f[c], f[`t_${c}`]]]));
      rec.features[0] = String(f.features).replace(/"session_hour": \d+/, '"session_hour": H');
      return rec;
    });
  if (!row) return { row: null, events, feedback };
  return { row: Object.fromEntries(cols.map((c) => [c, [row[c], row[`t_${c}`]]])), events, feedback };
}

function tickets() {
  return db.prepare('SELECT id, user_id, subject, body FROM support_tickets ORDER BY id').all().map((t) => {
    const hit = FEEDBACK_TYPE_OF_SUBJECT.find(([re]) => re.test(t.subject));
    return [t.id, t.user_id, hit ? hit[1] : t.subject.replace(/^seed /, ''), t.body];
  });
}

/**
 * GET stats `filters.timeframes`: the bot sorts a SET by the TF_ORDER index, so the timeframes the
 * order does not know (key 99) come out in str-hash order — PYTHONHASHSEED-random in production.
 * The site keeps their first appearance; the comparison takes the bot's order for that tail.
 */
function alignHashOrder(siteText, botText) {
  let a; let b;
  try { a = pyJsonParse(siteText); b = pyJsonParse(botText); } catch (_e) { return null; }
  const fa = a && a.filters && a.filters.timeframes;
  const fb = b && b.filters && b.filters.timeframes;
  if (!Array.isArray(fa) || !Array.isArray(fb) || fa.length !== fb.length) return null;
  const known = (x) => TF_ORDER.includes(x);
  const tailA = fa.filter((x) => !known(x)).slice().sort();
  const tailB = fb.filter((x) => !known(x)).slice().sort();
  if (tailA.length < 2 || !same(tailA, tailB) || !same(fa.filter(known), fb.filter(known))) return null;
  return siteText.replace(pyJsonDumps(fa), pyJsonDumps(fb));
}

describe(`Mini App data routes, adversarial — ${FX.steps.length} requests byte for byte against the bot`, () => {
  it('seed: users, trades with the bot\'s storage classes, events, kv', () => {
    expect(FX.users.length).toBeGreaterThanOrEqual(30);
    expect(FX.trades.length).toBeGreaterThanOrEqual(600);
    expect(db.prepare('SELECT COUNT(*) n FROM signal_trades').get().n).toBe(FX.trades.length);
    const got = seededTypes(db, FX.trade_keys);
    const bad = Object.keys(FX.seeded_types).filter((tid) => !same(got[tid], FX.seeded_types[tid]))
      .map((tid) => [tid, FX.trade_keys.filter((c, i) => got[tid] && got[tid][i] !== FX.seeded_types[tid][i])
        .map((c) => `${c}:${got[tid][FX.trade_keys.indexOf(c)]}/${FX.seeded_types[tid][FX.trade_keys.indexOf(c)]}`)]);
    expect(bad.slice(0, 5)).toEqual([]);
    expect(FX.steps.filter((s) => s.mismatch.length)).toEqual([]);      // the driver's own mirror cross-check
  });

  it('every step: status, headers, body bytes, side effects, log lines', async () => {
    const tokens = {};
    const tradeCols = FX.trade_keys;
    for (const s of FX.steps) {
      clock.now = s.now;
      const st = s.set || {};
      if (st.tickers) Object.assign(market.STATE.tickers, JSON.parse(JSON.stringify(st.tickers)));
      if (st.rest) Object.assign(market.STATE.rest, st.rest);
      if (Object.prototype.hasOwnProperty.call(st, 'trend_raw')) market.STATE.trend_raw = st.trend_raw;
      if (st.trend_state) {
        market.monitor._resetForTests();
        market.monitor._seed(JSON.parse(JSON.stringify(st.trend_state)), st.trend_strength || {});
      }
      applySql(db, s.sql);
      LOGS.length = 0;
      const headers = {};
      if (s.auth === 'garbage') headers.Authorization = 'Bearer not.a.jwt';
      else if (s.uid !== null) {
        if (!tokens[s.uid]) tokens[s.uid] = authService._signAccessToken(s.uid);
        headers.Authorization = `Bearer ${tokens[s.uid]}`;
      }
      if (s.ctype) headers['Content-Type'] = s.ctype;
      Object.assign(headers, s.req_headers || {});
      const target = SITE_PREFIX + s.path.slice(BOT_PREFIX.length);
      const res = await rawRequest(port, { method: s.method, target, headers, body: stepBody(s) });
      const problems = [];
      if (res.status !== s.status) problems.push(`status ${res.status} vs bot ${s.status}`);
      for (const h of ['content-type', 'cache-control', 'retry-after', 'allow']) {
        if ((res.headers[h] || null) !== (s.headers[h] || null)) problems.push(`${h} ${res.headers[h]} vs ${s.headers[h]}`);
      }
      // aiohttp writes no validators: an ETag (or Last-Modified) on the site would make conditional GETs answer 304
      for (const h of ['etag', 'last-modified', 'content-encoding']) {
        if (Boolean(res.headers[h]) !== s.all_headers.includes(h)) problems.push(`${h} ${res.headers[h] || '-'} vs bot ${s.all_headers.includes(h) ? 'set' : '-'}`);
      }
      const want = s.expect !== null ? Buffer.from(s.expect, 'utf8') : Buffer.from(s.raw_b64, 'base64');
      let d = byteDiff(res.raw, want);
      if (d && s.path.includes('/stats')) {
        const aligned = alignHashOrder(res.raw.toString('utf8'), want.toString('utf8'));
        if (aligned !== null) d = byteDiff(Buffer.from(aligned, 'utf8'), want);
      }
      if (d) problems.push(`body ${d}`);
      if (s.kv && !same(kvRows(s.uid), s.kv)) problems.push(`kv ${JSON.stringify(kvRows(s.uid))} vs ${JSON.stringify(s.kv)}`);
      if (s.mem) {
        const rate = Object.fromEntries(['post', 'chart', 'share'].map((b) => [b, appRouter._rateHits(b, s.uid)]));
        if (!same(rate, s.mem.rate)) problems.push(`rate ${JSON.stringify(rate)} vs ${JSON.stringify(s.mem.rate)}`);
        const last = appData._analyzeLast(s.uid);
        if (!same(last, s.mem.analyze_last)) problems.push(`analyze_last ${last} vs ${s.mem.analyze_last}`);
        const mk = appData._marketState();
        if (!same(mk, s.mem.market)) problems.push(`market ${JSON.stringify(mk)} vs ${JSON.stringify(s.mem.market)}`);
      }
      if (s.user_row !== undefined) {
        const n = db.prepare('SELECT COUNT(*) n FROM trader_settings WHERE user_id=?').get(s.uid).n;
        if (n !== s.user_row) problems.push(`user row ${n} vs ${s.user_row}`);
      }
      if (s.trade !== null && s.trade !== undefined) {
        // the bot's row in its table's column order (PRAGMA table_info): every column, [value, storage class]
        const got = tradeState(s.trade, s.trade_state.row ? Object.keys(s.trade_state.row) : tradeCols);
        if ((got.row === null) !== (s.trade_state.row === null)) problems.push(`trade row ${got.row === null ? 'missing' : 'unexpected'}`);
        else if (got.row !== null && !same(got.row, s.trade_state.row)) {
          const cols = Object.keys(s.trade_state.row).filter((c) => !same(got.row[c], s.trade_state.row[c]));
          problems.push(`trade row ${cols.map((c) => `${c}=${JSON.stringify(got.row[c])} vs ${JSON.stringify(s.trade_state.row[c])}`).join('; ')}`);
        }
        if (!same(got.events, s.trade_state.events)) problems.push(`trade_events ${JSON.stringify(got.events)} vs ${JSON.stringify(s.trade_state.events)}`);
        if (!same(got.feedback, s.trade_state.feedback)) problems.push(`trade_feedback ${JSON.stringify(got.feedback)} vs ${JSON.stringify(s.trade_state.feedback)}`);
      }
      if (s.feedback_rows) {
        const got = tickets();
        if (!same(got, s.feedback_rows)) problems.push(`tickets ${JSON.stringify(got).slice(-240)} vs ${JSON.stringify(s.feedback_rows).slice(-240)}`);
      }
      const gotLogs = LOGS.filter((l) => MARKERS.test(l));
      const wantLogs = s.logs.filter((l) => MARKERS.test(l));
      if (!same(gotLogs, wantLogs)) problems.push(`logs ${JSON.stringify(gotLogs)} vs ${JSON.stringify(wantLogs)}`);
      RESULTS.push({ s, problems });
    }
    const bad = RESULTS.filter((r) => r.problems.length).map((r) => ({ family: r.s.family, step: r.s.name, problems: r.problems }));
    if (bad.length) {
      const fam = {};
      for (const b of bad) fam[b.family] = (fam[b.family] || 0) + 1;
      console.log('divergent steps by family:', fam);
      if (process.env.APP_DIFF_DUMP) nodeRequire('fs').writeFileSync(process.env.APP_DIFF_DUMP, JSON.stringify(bad, null, 1));
    }
    expect(bad).toEqual([]);
  }, 300_000);

  it('the comparison covered every family and the interesting answers', () => {
    const fam = {};
    for (const { s } of RESULTS) fam[s.family] = (fam[s.family] || 0) + 1;
    for (const f of ['auth', 'route', 'dashboard', 'signals', 'stats', 'chart', 'result', 'analyze', 'share', 'feedback', 'body', 'postbucket', 'poison']) {
      expect(fam[f], f).toBeGreaterThan(0);
    }
    const n = (pred) => RESULTS.filter(({ s }) => pred(s)).length;
    expect(n((s) => s.expect !== null && s.path.endsWith('/chart'))).toBeGreaterThanOrEqual(40);   // chart payloads (D3)
    expect(n((s) => s.expect !== null && s.path.endsWith('/analyze') && s.expect.includes('"candles"'))).toBeGreaterThanOrEqual(3);
    expect(n((s) => s.expect !== null && s.path.endsWith('/share'))).toBeGreaterThanOrEqual(15);
    expect(n((s) => s.status === 500)).toBeGreaterThanOrEqual(10);
    expect(n((s) => s.status === 429)).toBeGreaterThanOrEqual(4);
    expect(n((s) => s.trade !== null && s.trade !== undefined)).toBeGreaterThanOrEqual(60);
    expect(n((s) => s.logs.some((l) => MARKERS.test(l)))).toBeGreaterThanOrEqual(80);
  });
});
