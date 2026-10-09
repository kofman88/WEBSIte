/**
 * Differential replay of the bot's smc/scanner._scan_cycle (+ _send_smc_card_bg, _on_ws_bar_close_smc)
 * against services/engine/smcScanner.js — fixtures/smc_scanner.json.gz from gen/gen_smc_scanner.py
 * (CPython 3.11, the bot's own modules on a temp SQLite; see the generator header for what is real
 * and what is faked). The JS side runs the same 10 cycles + 2 bar-close triggers on the golden
 * candles with the same 16 users (real traderSettingsService on a temp DB, real registry /
 * freeReport / trendMonitor / confluence / freshness / momentum veto + detector / signalTradesRepo /
 * cards / positionLine / watermark), the fakes rebuilt from the scenario stored in the fixture.
 *
 * Compared after every step: Telegram sends (text, keyboard, silent, protect), the signal_trades
 * and trade_events tables, the registry, the free-preview dedup map and its kv bytes, the users'
 * preview counters / flags, _SMC_LAST_SCAN, confluence, chart / auto-trade / smart-prompt / REST /
 * sleep / metric / record_skip calls and the log lines (INFO+ of every module, DEBUG of the scanner).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9b-smc-scanner-diff.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const FIX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'smc_scanner.json.gz'))).toString('utf8'));
const S = FIX.scenario;

const TF_FILE = { '15m': '15m', '1H': '1h', '4H': '4h', '1D': '1d' };
const ADMIN = new Set(S.admin_ids);
const isAdmin = (u) => ADMIN.has(Number(u.user_id));

let JS = null;   // per-step JS observations

function sortedJson(list) {
  return (list || []).map((x) => JSON.stringify(x)).sort();
}

async function replay() {
  const db = req('../../../models/database.js');
  const ts = req('../../../services/traderSettingsService.js');
  const pf = req('../../../config/planFeatures.js');
  const access = req('../../../services/engine/userAccess.js');
  const G = req('../../golden/load.js');
  const Database = req('better-sqlite3');
  const { signalTradesDDL, TRADE_EVENTS_DDL } = req('../../../models/engineSchema.js');
  const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
  const { createSignalRegistry } = req('../../../services/engine/signalRegistry.js');
  const { createFreeReport } = req('../../../services/engine/freeReport.js');
  const { createTrendMonitor } = req('../../../services/engine/trendMonitor.js');
  const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
  const { createFreshness } = req('../../../services/engine/signalFreshness.js');
  const { createMomentumVeto } = req('../../../services/engine/momentumVeto.js');
  const { createMomentumDetector } = req('../../../services/engine/momentumDetector.js');
  const { regimeAllowsDirection } = req('../../../services/engine/regimeLoop.js');
  const OP = req('../../../services/genome/optimizerParams.js');
  const { createSmcScanner } = req('../../../services/engine/smcScanner.js');
  const { toTelegram } = req('../../../services/engine/cards/keyboards.js');
  const { memKv } = req('../pipeline/vectors.js');

  // ── users (real traderSettingsService on the test DB) ──
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM users').run();
  for (const [uid, fields] of S.users) {
    db.prepare("INSERT INTO users (id, email, password_hash, referral_code, locale, is_admin) VALUES (?, ?, 'x', ?, 'ru', ?)")
      .run(uid, `u${uid}@x.test`, `R${uid}`, ADMIN.has(uid) ? 1 : 0);
    ts.save({ ...ts.defaults(uid), ...fields }, { now: S.cycles[0].t - 3600 });
  }

  // ── engine state ──
  const clock = { t: 0 };
  const now = () => clock.t;
  const LOGS = [];
  const logFor = (name) => {
    const rec = (lvl) => (msg) => LOGS.push([name, lvl, String(msg)]);
    return { debug: rec('DEBUG'), info: rec('INFO'), warning: rec('WARNING'), warn: rec('WARNING'), error: rec('ERROR') };
  };
  const tdb = new Database(':memory:');
  tdb.pragma('foreign_keys = OFF');   // signal_trades.user_id REFERENCES users(id): the users live in the service DB
  tdb.exec(signalTradesDDL());
  tdb.exec(TRADE_EVENTS_DDL);
  const repo = createSignalTradesRepo({ db: tdb, now, log: logFor('CHM.DB') });
  const kv = memKv();
  const registry = createSignalRegistry({ kv, now, log: logFor('CHM.SignalRegistry'), isAdmin, isMulti: (u) => pf.isMulti(u, { admin: isAdmin(u) }) });
  const free = createFreeReport({ kv, now, log: logFor('CHM.FreeReport') });
  const trend = createTrendMonitor({ kv: memKv(), now, log: logFor('CHM.TrendMonitor'), env: {} });
  const confluence = createSignalConfluence({ now });
  const momentum = createMomentumDetector({ now, log: logFor('CHM.Momentum') });

  // ── market data fakes ──
  const VOL = Object.fromEntries(S.symbols);
  const COINS = S.symbols.map((x) => x[0]);
  const CACHE_MODE = new Map(S.cache_mode.map(([s, tf, m]) => [`${s}|${tf}`, m]));
  const REST_MODE = new Map(S.rest_mode.map(([s, tf, m]) => [`${s}|${tf}`, m]));
  const FRAMES = new Map();
  const RESTF = new Map();
  const buildFrames = (t) => {
    FRAMES.clear();
    RESTF.clear();
    const closeMs = Math.round(t * 1000);
    for (const s of COINS) {
      for (const tf of Object.keys(TF_FILE)) {
        const full = G.loadFrame(s, TF_FILE[tf]).closedPrefix(TF_FILE[tf], closeMs, 300);
        RESTF.set(`${s}|${tf}`, full);
        const mode = CACHE_MODE.get(`${s}|${tf}`);
        if (mode === 'none') continue;
        FRAMES.set(`${s}|${tf}`, mode === 'short' ? full.tail(20) : full);
      }
    }
  };
  let REC = {};
  const rec = (name, item) => { (REC[name] = REC[name] || []).push(item); };
  const cache = {
    getCandles: (s, tf) => (FRAMES.has(`${s}|${tf}`) ? FRAMES.get(`${s}|${tf}`) : null),
    getCoins: () => COINS.slice(),
  };
  const attempts = new Map();
  const fetcher = {
    volBySym: { ...VOL },
    async getAllUsdtPairs(min) { rec('pairs', [min]); return COINS.filter((s) => VOL[s] >= min); },
    async getCandles(symbol, tf, limit = 300) {
      const key = `${symbol}|${tf}`;
      const n = attempts.get(key) || 0;
      attempts.set(key, n + 1);
      rec('rest', [symbol, tf, limit]);
      const mode = REST_MODE.get(key);
      if (mode === 'timeout2' && n % 3 < 2) throw new Error('Read timeout on endpoint');
      if (mode === 'error') throw new Error('bad payload');
      if (mode === 'null') return null;
      const df = RESTF.get(key);
      return df ? df.tail(limit) : null;
    },
  };
  const freshness = createFreshness({ env: {}, getCandles: cache.getCandles, log: logFor('CHM.SignalFreshness') });
  const veto = createMomentumVeto({});

  // ── delivery / side-effect fakes (the generator's, rebuilt from the scenario) ──
  let FAILS = new Set();
  let FAIL_COUNT = new Map();
  let MSG_ID = S.msg_id0;
  const deliver = async (msg) => {
    const tag = `${msg.kind}:${msg.userId}`;
    FAIL_COUNT.set(tag, (FAIL_COUNT.get(tag) || 0) + 1);
    const ok = !(FAILS.has(tag) || FAILS.has(`${tag}#${FAIL_COUNT.get(tag)}`));
    rec('sends', {
      uid: Number(msg.userId), kind: msg.kind, text: msg.text, kb: msg.keyboard ? toTelegram(msg.keyboard) : null,
      protect: Boolean(msg.protect), silent: Boolean(msg.silent), parse_mode: 'HTML', ok,
    });
    if (ok && msg.kind === 'card') {
      MSG_ID += 1;
      repo.setSignalMsgId(msg.tradeId, MSG_ID, repo.cardSnapshot({ html: msg.text, actions: msg.keyboard, lang: msg.lang }));
    }
    return ok;
  };
  let RAND = [];
  let REGIME = null;
  let FUND = '';
  const env = {};
  const atRule = (uid, symbol) => {
    const rules = S.at_rules[String(uid)] || {};
    return Object.prototype.hasOwnProperty.call(rules, symbol) ? rules[symbol] : (rules.default || { executed: false, show_trade_btn: false, limit_msg: null });
  };
  const scanner = createSmcScanner({
    um: ts, fetcher, cache, registry, freeReport: free, trend, confluence, freshness, momentumVeto: veto,
    coinQuality: { isBlacklisted: (s, st) => S.blacklist.some(([a, b]) => a === s && b === st) },
    regime: { getCachedRegime: () => REGIME, regimeAllowsDirection },
    momentum, repo,
    optimizer: {
      smcOptimizerFilters: (u, d) => OP.smcOptimizerFilters(u, {
        ...d,
        store: { loadOptimizerParams: (uid, st) => (st === 'SMC' && S.opt_params[String(uid)] ? { ...S.opt_params[String(uid)] } : null) },
        getRegime: () => REGIME,
      }),
    },
    exchangeSymbols: {
      isAvailable: (sym, ex) => !((S.unavailable[String(ex).toLowerCase()] || []).includes(sym)),
      recordSkip: (ex, sym) => rec('skips', [ex, sym]),
    },
    access: {
      strategyEnabled: (u, st) => pf.strategyEnabled(u, st, { admin: isAdmin(u) }),
      can: (u, f) => access.can(u, f, { admin: isAdmin(u) }),
    },
    deliver,
    deliverChart: (m) => rec('charts', { uid: Number(m.userId), symbol: m.symbol, strategy: m.strategy, lang: m.lang, bars: m.bars, last_ts: m.lastTs, extra: m.extra }),
    executeAutoTrade: async (p) => {
      const keys = ['user_id', 'symbol', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'trade_id', 'api_key', 'api_secret',
        'risk_pct', 'leverage', 'auto_trade_mode', 'max_trades', 'strategy', 'exchange', 'bybit_demo', 'entry_low', 'entry_high',
        'quality', 'trend_ctx'];
      rec('auto_trade', Object.fromEntries(keys.map((k) => [k, p[k] === undefined ? null : p[k]])));
      const r = atRule(p.user_id, p.symbol);
      if (r === 'raise') throw new Error('exchange down');
      return { ...r };
    },
    userApiKeys: (u, ex) => {
      const k = S.api_keys[String(u.user_id)];
      return k && ex === 'bybit' ? { apiKey: k[0], apiSecret: k[1] } : { apiKey: '', apiSecret: '' };
    },
    getBalance: async () => null,
    fundBlock: async () => FUND,
    smartPromptQuota: (uid) => rec('prompts', Number(uid)),
    metrics: { record: (name, _v, tags) => rec('metrics', [name, { ...(tags || {}) }]) },
    randint: () => {
      if (!RAND.length) throw new Error('randint: Python drew fewer trade ids');
      return RAND.shift();
    },
    sleep: async (ms) => { rec('sleeps', ms / 1000); await new Promise((r) => setImmediate(r)); },
    now, env, log: logFor('CHM.SMC.Scanner'), builderLog: logFor('CHM.SMC.SignalBuilder'), volFilterLog: logFor('CHM.VolumeFilter'),
  });

  const out = [];
  for (let k = 0; k < S.cycles.length; k++) {
    const c = S.cycles[k];
    const py = FIX.steps[k];
    clock.t = c.t;
    REC = {};
    LOGS.length = 0;
    RAND = ((py.rec && py.rec.rand) || []).slice();
    let err = null;
    if (c.op === 'barclose') {
      await scanner.onWsBarClose(c.inst, c.tf);
    } else {
      buildFrames(c.t);
      trend._resetForTests();
      const tset = S.trend_sets[c.trend];
      const trends = {};
      for (const [tf, tr] of Object.entries(tset.trends)) trends[tf] = { trend: tr, since: 0.0, price: 0.0 };
      trend._seed(trends, tset.strength);
      REGIME = c.regime;
      FUND = c.fund;
      FAILS = new Set(c.fail);
      FAIL_COUNT = new Map();
      if (c.cf) env.CACHE_FIRST_MODE = c.cf; else delete env.CACHE_FIRST_MODE;
      if (c.relax) momentum.activateRelaxed('BTC', 'test pump +2.6% за 1H', 2.6, 1.1);
      ts.invalidateCache();
      scanner._state.scanStartTs = now();
      try {
        await scanner.scanCycle();
      } catch (e) {
        err = `${e.name}: ${e.message}`;
      }
      await scanner.drainPending();
    }
    const rows = tdb.prepare('SELECT * FROM signal_trades ORDER BY trade_id').all();
    const events = tdb.prepare('SELECT trade_id, event_type, payload_json FROM trade_events ORDER BY trade_id, event_type, payload_json').all();
    const users = db.prepare('SELECT user_id, free_smc_preview_today, free_smc_preview_date, long_active, short_active, '
      + 'smc_long_active, smc_short_active, active FROM trader_settings ORDER BY user_id').all();
    const previewSent = {};
    for (const [uid, m] of free.previewSent) previewSent[String(uid)] = Object.fromEntries(m);
    out.push({
      error: err,
      rows, events, users,
      kv: kv.get('free_preview_sent'),
      registry: registry.snapshot(),
      preview_sent: previewSent,
      last_scan: Object.fromEntries(Array.from(scanner._lastScan.entries()).map(([u, v]) => [String(u), v])),
      confluence: Object.fromEntries(Object.keys(py.confluence || {}).map((key) => {
        const [sym, dir] = key.split('|');
        return [key, confluence.getConfluentStrategies(sym, dir).map((e) => [e.strategy, e.ts, e.quality])];
      })),
      confluenceStats: confluence.getStats(),
      rec: REC,
      logs: LOGS.filter(([name, lvl, msg]) => !msg.startsWith('[SMC-PROFILE') && (lvl !== 'DEBUG' || name === 'CHM.SMC.Scanner')),
      randLeft: RAND.length,
    });
  }
  return out;
}

beforeAll(async () => {
  JS = await replay();
}, 120_000);

const steps = FIX.steps.map((s, k) => [k, s.op, s]);
const keyed = (rows) => new Map(rows.map((r) => [r.trade_id, r]));

describe('smc scanner = bot smc/scanner.py (PY311 differential)', () => {
  it('fixture provenance: CPython 3.11', () => {
    expect(FIX.python.startsWith('3.11')).toBe(true);
    expect(FIX.steps.length).toBe(S.cycles.length);
  });

  it.each(steps)('step %i (%s): sends, rows, registry, quotas, logs', (k, _op, py) => {
    const js = JS[k];
    expect(js.error).toBe(py.error ?? null);
    expect(js.randLeft).toBe(0);

    // Telegram ↔ deliver
    expect(sortedJson(js.rec.sends)).toEqual(sortedJson(py.rec.sends));

    // signal_trades rows
    const pyRows = keyed(py.rows);
    const jsRows = keyed(js.rows);
    expect(Array.from(jsRows.keys())).toEqual(Array.from(pyRows.keys()));
    for (const [tid, pr] of pyRows) {
      const jr = jsRows.get(tid);
      for (const col of Object.keys(jr)) {
        if (!Object.prototype.hasOwnProperty.call(pr, col)) continue;
        if (col === 'signal_card_json') {
          if (!pr[col]) { expect(jr[col]).toBe(pr[col]); continue; }
          const p = JSON.parse(pr[col]);
          const j = JSON.parse(jr[col]);
          expect(j.html).toBe(p.html);
          expect(j.actions ? toTg(j.actions) : null).toEqual(p.kb);
          continue;
        }
        expect([tid, col, jr[col]]).toEqual([tid, col, pr[col]]);
      }
    }
    expect(js.events.map((e) => [e.trade_id, e.event_type, e.payload_json]))
      .toEqual(py.events.map((e) => [e.trade_id, e.event_type, e.payload_json]));

    // dedup / quota state
    expect(js.registry).toEqual(py.registry);
    expect(js.preview_sent).toEqual(py.preview_sent);
    const pyKv = py.kv.find((r) => r.key === 'free_preview_sent');
    expect(js.kv).toBe(pyKv ? pyKv.value : null);
    expect(js.users.map((u) => [u.user_id, u.free_smc_preview_today, u.free_smc_preview_date, !!u.long_active, !!u.short_active, !!u.smc_long_active, !!u.smc_short_active, !!u.active]))
      .toEqual(py.users.filter((u) => js.users.some((j) => j.user_id === u.user_id))
        .map((u) => [u.user_id, u.free_smc_preview_today, u.free_smc_preview_date, !!u.long_active, !!u.short_active, !!u.smc_long_active, !!u.smc_short_active, !!u.active]));
    expect(js.last_scan).toEqual(py.last_scan);
    const t = S.cycles[k].t;
    let livePy = 0;
    for (const [key, items] of Object.entries(py.confluence)) {
      const live = items.filter((x) => x[1] >= t - 1800);
      if (live.length) livePy += 1;
      expect([key, js.confluence[key]]).toEqual([key, live]);
    }
    expect(js.confluenceStats.keys).toBeGreaterThanOrEqual(livePy);

    // side calls
    for (const name of ['charts', 'auto_trade', 'prompts', 'rest', 'pairs', 'sleeps', 'metrics', 'skips']) {
      expect([name, sortedJson(js.rec[name])]).toEqual([name, sortedJson(py.rec[name])]);
    }

    // log lines (order-free: background deliveries interleave differently)
    expect(sortedJson(js.logs)).toEqual(sortedJson(py.logs));
  });
});

function toTg(actions) {
  return req('../../../services/engine/cards/keyboards.js').toTelegram(actions);
}
