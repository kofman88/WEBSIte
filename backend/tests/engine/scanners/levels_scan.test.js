/**
 * LEVELS scanner differential replay: the bot's REAL MidScanner._cycle() (scanner_mid.py) ran
 * 12 consecutive cycles over the golden candles with 14 users (py/levels_scan.py →
 * levels_fixtures/scan.json.gz); the JS MidScanner replays the same script (users, clock,
 * trend / regime / momentum / WS cache seeds, bar-close triggers, settings mutations) on the
 * site's trader_settings / signal_trades tables and must reproduce, cycle by cycle:
 * every delivered message (text, parse mode, protect / silent flags, keyboard), every
 * signal_trades row (all columns), trade_events, kv, the registry (state + persisted JSON),
 * user counters, REST calls, charts, auto-trade calls, metrics, scanner state (last_scan,
 * perf counters, indicator cooldowns), the free missed buffer, confluence, momentum state
 * and the ordered INFO+ log lines.
 *
 *   Python: cd <bot> && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> \
 *           <site>/backend/tests/engine/scanners/py/levels_scan.py
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9b-levels-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'levels-scan.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const H = req('./levels_harness.js');
const FIX = H.loadFixture(path.join(__dirname, 'levels_fixtures', 'scan.json.gz'));

let db; let ts; let engineSchema;
let run = null;   // the replay result per cycle

const SITE_TRADE_COLS = [
  'trade_id', 'user_id', 'symbol', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'tp1_rr', 'tp2_rr',
  'tp3_rr', 'quality', 'timeframe', 'breakout_type', 'result', 'result_rr', 'created_at', 'trail_level',
  'order_id', 'be_set', 'tp_placed', 'risk_pct', 'pos_idx', 'leverage', 'strategy', 'copied_from', 'state',
  'state_changed_at', 'placement_attempts', 'closed_pnl_usd', 'qty', 'original_sl', 'order_link_id',
  'signal_type', 'skip_reason', 'entry_lo', 'entry_hi', 'exchange', 'tp_retry_count', 'rsi', 'volume_ratio',
  'is_counter_trend', 'mtf_aligned', 'trend_ctx', 'btc_corr', 'session', 'preset_name', 'ai_filter_json',
  'signal_msg_id', 'progress_stage', 'progress_ts', 'signal_card_json', 'expire_rr', 'user_note',
];
const USER_STATE_COLS = [
  'user_id', 'active', 'long_active', 'short_active', 'smc_long_active', 'smc_short_active',
  'vol_long_active', 'vol_short_active', 'sub_status', 'sub_plan', 'expired_notified', 'signals_received',
  'free_signals_date', 'free_signals_morning', 'free_signals_evening', 'free_signals_night',
  'free_signals_today', 'free_missed_today', 'free_smc_preview_today', 'free_smc_preview_date',
];

async function replay() {
  db = req('../../../models/database.js');
  ts = req('../../../services/traderSettingsService.js');
  engineSchema = req('../../../models/engineSchema.js');
  const candleCache = req('../../../services/marketData/candleCache.js');
  const exSym = req('../../../services/exchanges/exchangeSymbols.js');
  const { createSignalRegistry } = req('../../../services/engine/signalRegistry.js');
  const { createFreshness } = req('../../../services/engine/signalFreshness.js');
  const { createMomentumVeto } = req('../../../services/engine/momentumVeto.js');
  const { createMomentumDetector } = req('../../../services/engine/momentumDetector.js');
  const { createTrendMonitor } = req('../../../services/engine/trendMonitor.js');
  const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
  const { createCoinQualityLearner } = req('../../../services/engine/coinQualityLearner.js');
  const { createFreeReport } = req('../../../services/engine/freeReport.js');
  const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
  const LS = req('../../../services/engine/levelsScanner.js');

  const clock = new H.Clock(FIX.start_t);
  const cap = H.logCapture();
  const quiet = { debug() {}, info() {}, warning() {}, error() {} };
  const kv = H.memKv();

  // users (site users + trader_settings rows exactly as the bot stored them)
  const cols = new Set(ts.COLUMNS);
  for (const row of FIX.users) {
    db.prepare('INSERT INTO users (id, email, password_hash, referral_code, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(row.user_id, `u${row.user_id}@x.test`, 'x', `R${row.user_id}`, row.user_id === 123 ? 1 : 0);
    const keys = Object.keys(row).filter((k) => k === 'user_id' || cols.has(k));
    db.prepare(`INSERT INTO trader_settings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((k) => row[k]));
  }
  ts.invalidateCache();
  const um = {
    getActiveUsers: () => ts.getActiveUsers({ now: clock.now() }),
    allUsers: () => ts.allUsers({ now: clock.now() }),
    save: (u) => ts.save(u, { now: clock.now() }),
    get: (uid) => ts.get(uid),
  };

  // market data
  candleCache._resetForTests();
  candleCache.initCache(FIX.cache_max_keys, { now: () => clock.now(), log: quiet });
  exSym._resetForTests();
  for (const [ex, natives] of Object.entries(FIX.exchange_symbols)) exSym._setSymbols(ex, natives, { updatedAt: FIX.start_t });
  const fetcher = new H.FakeFetcher(clock, FIX.volumes, FIX.global_trend);
  for (const s of FIX.rest_missing) fetcher.missing.add(s);

  // pipeline blocks (one instance each, the bot's module state)
  const registry = createSignalRegistry({ kv, now: () => clock.now(), log: cap.make('CHM.SignalRegistry'), isAdmin: (u) => u.user_id === 123 });
  const freshness = createFreshness({ env: {}, getCandles: (s, tf) => candleCache.getCandles(s, tf), log: cap.make('CHM.SignalFreshness') });
  const veto = createMomentumVeto({});
  const momentum = createMomentumDetector({ now: () => clock.now(), log: cap.make('CHM.Momentum') });
  const trend = createTrendMonitor({ env: {}, kv: null, now: () => clock.now(), log: cap.make('CHM.TrendMonitor') });
  const confluence = createSignalConfluence({ now: () => clock.now() });
  const blKv = H.memKv();
  blKv.set('coin_blacklist_v1', JSON.stringify(Object.fromEntries(FIX.blacklist.map(([s, st, u]) => [`${s}::${st}`, u]))));
  const coinQuality = createCoinQualityLearner({ now: () => clock.now(), kv: blKv, log: quiet });
  coinQuality.restoreFromKv();
  const freeReport = createFreeReport({ kv, now: () => clock.now(), log: cap.make('CHM.FreeReport') });
  const repo = createSignalTradesRepo({ db, now: () => clock.now(), log: quiet });
  let regimeNow = null;
  const regime = { getCachedRegime: () => regimeNow };
  const bot = new H.FakeBot();
  for (const u of FIX.bot_fail) bot.fail.add(u);
  const rand = new H.Rand();
  const atCalls = [];
  const charts = [];
  const metricCalls = [];
  const fund = { block: '' };
  const apiKeys = FIX.api_keys;
  const atResult = FIX.at_result;
  const balances = FIX.balances;
  const optParams = new Map(FIX.opt_params.map(([uid, s, p]) => [`${uid}|${s}`, p]));

  LS._resetModuleStateForTests();
  const scanner = new LS.MidScanner({ SCAN_WORKERS: 1, PAYMENT_ADDRESS: '' }, bot, um, null, {
    clock,
    sleep: async () => {},
    random: rand,
    log: cap.make('CHM.Scanner'),
    indicatorLog: cap.make('CHM.Indicator'),
    tgLog: cap.make('CHM.TgSafe'),
    fetcher,
    cache: candleCache,
    registry, freshness, veto, momentum, regime, trend, confluence, coinQuality, freeReport,
    exchangeSymbols: exSym,
    repo,
    kv,
    optimizerStore: { loadOptimizerParams: (uid, s) => { const p = optParams.get(`${uid}|${s}`); return p === undefined ? null : JSON.parse(JSON.stringify(p)); } },
    executeAutoTrade: async (kw) => {
      const k = { ...kw };
      delete k.bot;
      atCalls.push(k);
      return { ...(atResult[String(kw.user_id)] || { executed: false, show_trade_btn: false, limit_msg: null }) };
    },
    getApiKeys: (user, exchange) => {
      const k = apiKeys[String(user.user_id)];
      return k && k[0] === exchange ? { apiKey: k[1], apiSecret: k[2] } : null;
    },
    getBalance: async (user) => (Object.prototype.hasOwnProperty.call(balances, String(user.user_id)) ? balances[String(user.user_id)] : null),
    fundamental: { getMarketContextBlock: async () => fund.block },
    sendChart: (_bot, user, sig, df, o) => {
      charts.push({ uid: user.user_id, strategy: o.strategy, lang: o.lang, symbol: sig.symbol, df_len: df.length, df_last: df.t[df.length - 1],
        pivots: o.pivotLevels || [], hvn: o.hvnLevels || [], lvn: o.lvnLevels || [], extra: o.extraSignalData || null });
    },
    metrics: { record: async (name, value, tags) => { metricCalls.push([name, value, { ...(tags || {}) }]); } },
    isAdmin: (u) => u.user_id === 123,
  });
  scanner.fetcher = fetcher;

  const breakoutMap = momentum.levelsOpts().breakoutState;   // the one map every analysis shares
  const out = [];
  const prev = { sent: 0, charts: 0, at: 0, metrics: 0, rest: 0, logs: 0 };
  const kvBaseline = new Map();
  for (const [ci, cyc] of FIX.cycles.entries()) {
    clock.t = cyc.ts;
    for (const k of Object.keys(trend._state)) delete trend._state[k];
    for (const k of Object.keys(trend._strength)) delete trend._strength[k];
    const st = {};
    for (const [tf, tr] of Object.entries(cyc.trend)) st[tf] = { trend: tr, since: cyc.ts - 3600.0, price: 90000.0 };
    trend._seed(st, cyc.strength);
    regimeNow = cyc.regime;
    if (cyc.momentum) {
      const m = cyc.momentum;
      momentum.activateRelaxed(m.symbol, m.reason, 2.4, 1.1);
      momentum._state.relaxed_until = cyc.ts + m.relaxed_for;
    }
    fund.block = cyc.fund;
    for (const [uid, field, value] of cyc.mutate || []) {
      const u = ts.get(uid);
      u[field] = value;
      ts.save(u, { now: clock.now() });
    }
    for (const sym of FIX.symbols) {
      if (FIX.ws_missing.includes(sym)) continue;
      for (const tf of FIX.meta.ws_tfs) {
        const f = H.frameAt(sym, tf, cyc.ts, 300);
        if (f) candleCache.setCandles(sym, tf, f, FIX.cache_ttl);
      }
    }
    for (const [inst, tf] of cyc.ws) await scanner._onWsBarClose(inst, tf);

    await scanner._cycle();

    const indic = {};
    for (const [jk, ind] of scanner._indicators) indic[jk] = Object.fromEntries(ind.cooldown.map);
    const kvNow = {};
    for (const [k, v] of kv.map) if (k !== 'signal_registry') kvNow[k] = v;
    out.push({
      sent: bot.sent.slice(prev.sent),
      charts: charts.slice(prev.charts),
      at_calls: atCalls.slice(prev.at),
      metrics: metricCalls.slice(prev.metrics),
      rest: fetcher.calls.slice(prev.rest),
      logs: cap.lines.slice(prev.logs),
      trades: db.prepare('SELECT * FROM signal_trades ORDER BY rowid').all().map((r) => Object.fromEntries(SITE_TRADE_COLS.map((c) => [c, r[c] === undefined ? null : r[c]]))),
      trade_events: db.prepare('SELECT trade_id, ts, event_type, payload_json FROM trade_events ORDER BY id').all(),
      kv: kvNow,
      registry: registry.snapshot(),
      registry_file: kv.map.has('signal_registry') ? kv.map.get('signal_registry') : null,
      registry_stats: registry.getStats(),
      users: db.prepare('SELECT * FROM trader_settings ORDER BY user_id').all().map((r) => Object.fromEntries(USER_STATE_COLS.map((c) => [c, r[c]]))),
      last_scan: Object.fromEntries(scanner._lastScan),
      perf: { ...scanner._perf },
      indicators: indic,
      confluence: confluence.getStats(),
      missed: Object.fromEntries(Array.from(freeReport.missedBuffer).map(([k, v]) => [String(k), v])),
      breakout: Object.fromEntries(breakoutMap),
      momentum: { relaxed: momentum._state.relaxed, until: momentum._state.relaxed_until },
      freshness_ema: freshness.getCycleEma('LEVELS') ? { LEVELS: freshness.getCycleEma('LEVELS') } : {},
      cache: candleCache.cacheStats(),
      rand_k: rand.k,
    });
    Object.assign(prev, { sent: bot.sent.length, charts: charts.length, at: atCalls.length, metrics: metricCalls.length, rest: fetcher.calls.length, logs: cap.lines.length });
    void ci; void kvBaseline;
  }
  return out;
}

/** The Python kv table minus the keys init_db wrote before the first cycle. */
function pyKv(c, base) {
  const o = {};
  for (const [k, v] of Object.entries(c.kv)) if (!(k in base) || base[k] !== v) o[k] = v;
  return o;
}

/** signal_card_json: Python {"html", "kb"} vs site {"html", "actions", "lang"} — same html, same keyboard. */
function cardOf(json, site) {
  if (!json) return null;
  const d = JSON.parse(json);
  const kb = site ? (d.actions ? req('../../../services/engine/cards/keyboards.js').toTelegram(d.actions) : null) : d.kb;
  return { html: d.html, kb };
}

describe('MidScanner differential replay (scanner_mid.py)', () => {
  beforeAll(async () => { run = await replay(); }, 300_000);
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ } });

  it('fixture covers the scenario (signals, free quota, auto-trade gate, hints, backfill)', () => {
    const all = FIX.expected;
    const trades = all[all.length - 1].trades;
    expect(trades.length).toBeGreaterThanOrEqual(5);
    expect(all.some((c) => c.sent.some((s) => s.text.includes('Авто-трейд: сделка не открыта')))).toBe(true);
    expect(all.some((c) => c.logs.some((l) => l[2].includes('[LEVELS-BACKFILL]')))).toBe(true);
    expect(all.some((c) => c.logs.some((l) => l[2].includes('[FREE-WINDOW]')))).toBe(true);
    expect(all.some((c) => c.at_calls.length > 0)).toBe(true);
  });

  it('QUIRK pins (bot behaviour the replay reproduces)', () => {
    const last = FIX.expected[FIX.expected.length - 1];
    // signals_received is bumped and saved even when the card was not delivered (blocked bot):
    const u1014 = last.users.find((u) => u.user_id === 1014);
    const t1014 = last.trades.filter((t) => t.user_id === 1014);
    expect(t1014.length).toBe(3);
    expect(t1014.every((t) => t.result === 'SKIP' && t.skip_reason === 'not_delivered')).toBe(true);
    expect(u1014.signals_received).toBe(3);
    // the not-delivered card is not committed to the registry, so the next cycle re-sends it
    expect(new Set(t1014.map((t) => t.symbol)).size).toBe(1);
    // the counter-trend auto-trade block still delivers the card (+ the 🚫 notice)
    expect(FIX.expected.some((c) => c.logs.some((l) => l[2].startsWith('[FILTER-BLOCK]') && l[2].includes('gate=counter_trend_scanner')))).toBe(true);
  });

  const N = FIX.cycles.length;
  const base = FIX.kv_baseline || {};
  for (let ci = 0; ci < N; ci++) {
    describe(`cycle ${ci} ${FIX.cycles[ci].t}`, () => {
      const E = () => FIX.expected[ci];
      const J = () => run[ci];
      it('logs (INFO+, in order)', () => { expect(H.norm(J().logs)).toEqual(E().logs); });
      it('delivered messages', () => { expect(H.norm(J().sent)).toEqual(E().sent); });
      it('REST calls / charts / auto-trade calls / metrics', () => {
        expect(H.norm(J().rest)).toEqual(E().rest);
        expect(H.norm(J().charts)).toEqual(E().charts);
        expect(H.norm(J().at_calls)).toEqual(E().at_calls);
        expect(H.norm(J().metrics)).toEqual(E().metrics);
      });
      it('signal_trades rows (all columns) and trade_events', () => {
        const jt = H.norm(J().trades).map((r) => ({ ...r, signal_card_json: cardOf(r.signal_card_json, true) }));
        const et = E().trades.map((r) => ({ ...r, signal_card_json: cardOf(r.signal_card_json, false) }));
        expect(jt).toEqual(et);
        expect(H.norm(J().trade_events)).toEqual(E().trade_events);
      });
      it('kv, registry (state + persisted JSON), user counters', () => {
        expect(J().kv).toEqual(pyKv(E(), base));
        expect(H.norm(J().registry)).toEqual(E().registry);
        expect(J().registry_file).toEqual(E().registry_file);
        expect(J().registry_stats).toEqual(E().registry_stats);
        const ju = J().users.map((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, typeof v === 'boolean' ? Number(v) : v])));
        expect(ju).toEqual(E().users);
      });
      it('scanner state: last_scan, perf, cooldowns, free buffer, confluence, momentum, cache', () => {
        expect(J().last_scan).toEqual(E().last_scan);
        expect(H.norm(J().perf)).toEqual(E().perf);
        expect(H.norm(J().indicators)).toEqual(E().indicators);
        expect(H.norm(J().missed)).toEqual(E().missed);
        expect(J().confluence).toEqual(E().confluence);
        expect(H.norm(J().breakout)).toEqual(E().breakout);
        expect(J().momentum).toEqual(E().momentum);
        expect(J().freshness_ema).toEqual(E().freshness_ema);
        expect(J().cache).toEqual(E().cache);
        expect(J().rand_k).toEqual(E().rand_k);
      });
    });
  }
});
