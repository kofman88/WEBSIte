/**
 * VOLUME scanner differential replay: the bot's REAL volume_scanner._scan_cycle() ran 8
 * consecutive cycles over the golden candles with 14 users (py/volume_scan.py →
 * volume_fixtures/scan.json.gz); the JS scanner replays the same script (users, kv configs
 * via saveUserCfg / resetUserCfg, clock, trend seeds, WS cache seeds incl. missing / short /
 * HTF-less coins, REST failures, gc_sent) on the site's trader_settings / signal_trades tables
 * and must reproduce, cycle by cycle: every delivered message (text, flags, keyboard), every
 * signal_trades row (all columns), trade_events, kv, the registry (state + persisted JSON),
 * user counters, REST calls, charts, auto-trade calls, metrics, _sent_bars, the HTF cache,
 * exchange skip counters, confluence and the ordered INFO+ log lines. Bot batch D (2026-10): the
 * [VOL-LIQ-15M] 15m universe, [VOL-MIN-SL] widened 15m stops (+ the once-per-bar log),
 * [VOL-POST-SL-PAUSE] over seeded previous signals, the [VOL-MIN-VOLUME] floors / kv storage and the
 * `timeframe` auto-trade kwarg.
 *
 *   Python: cd <bot> && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> \
 *           <site>/backend/tests/engine/scanners/py/volume_scan.py
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm9b-volume-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'volume-scan.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const H = req('./levels_harness.js');
const FIX = H.loadFixture(path.join(__dirname, 'volume_fixtures', 'scan.json.gz'));

let run = null;
let cfgKv = null;
const VS_MAX = 3;   // volume_scanner.MAX_SIGNALS_PER_USER_CYCLE

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
  const db = req('../../../models/database.js');
  const ts = req('../../../services/traderSettingsService.js');
  const candleCache = req('../../../services/marketData/candleCache.js');
  const exSym = req('../../../services/exchanges/exchangeSymbols.js');
  const { createSignalRegistry } = req('../../../services/engine/signalRegistry.js');
  const { createFreshness } = req('../../../services/engine/signalFreshness.js');
  const { createTrendMonitor } = req('../../../services/engine/trendMonitor.js');
  const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
  const { createCoinQualityLearner } = req('../../../services/engine/coinQualityLearner.js');
  const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
  const VS = req('../../../services/engine/volumeScanner.js');
  const Q = req('../../../strategies/volume').quality;

  const clock = new H.Clock(FIX.start_t);
  const cap = H.logCapture();
  // a fresh bot process: volume_strategy's once-per-value log state, the batch-D env at its defaults
  Q.setEnv({});
  Q._resetForTests();
  Q.setLog(cap.make('CHM.VolumeStrategy'));
  const quiet = { debug() {}, info() {}, warning() {}, error() {} };
  const kv = H.memKv();

  const cols = new Set(ts.COLUMNS);
  for (const row of FIX.users) {
    db.prepare('INSERT INTO users (id, email, password_hash, referral_code, is_admin) VALUES (?, ?, ?, ?, ?)')
      .run(row.user_id, `u${row.user_id}@x.test`, 'x', `R${row.user_id}`, row.user_id === 123 ? 1 : 0);
    const keys = Object.keys(row).filter((k) => k === 'user_id' || cols.has(k));
    db.prepare(`INSERT INTO trader_settings (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((k) => row[k]));
  }
  ts.invalidateCache();
  const um = { getActiveUsers: () => ts.getActiveUsers({ now: clock.now() }) };

  candleCache._resetForTests();
  candleCache.initCache(FIX.cache_max_keys, { now: () => clock.now(), log: quiet });
  exSym._resetForTests();
  for (const [ex, natives] of Object.entries(FIX.exchange_symbols)) exSym._setSymbols(ex, natives, { updatedAt: FIX.start_t });
  const fetcher = new H.FakeFetcher(clock, FIX.volumes, {});
  for (const s of FIX.rest_missing) fetcher.missing.add(s);
  for (const [s, tf] of FIX.rest_raise) fetcher.raiseOn.add(`${s}|${tf}`);

  const registry = createSignalRegistry({ kv, now: () => clock.now(), log: cap.make('CHM.SignalRegistry'), isAdmin: (u) => u.user_id === 123 });
  const freshness = createFreshness({ env: {}, getCandles: (s, tf) => candleCache.getCandles(s, tf), log: cap.make('CHM.SignalFreshness') });
  const trend = createTrendMonitor({ env: {}, kv: null, now: () => clock.now(), log: cap.make('CHM.TrendMonitor') });
  const confluence = createSignalConfluence({ now: () => clock.now() });
  const blKv = H.memKv();
  blKv.set('coin_blacklist_v1', JSON.stringify(Object.fromEntries(FIX.blacklist.map(([s, st, u]) => [`${s}::${st}`, u]))));
  const coinQuality = createCoinQualityLearner({ now: () => clock.now(), kv: blKv, log: quiet });
  coinQuality.restoreFromKv();
  const repo = createSignalTradesRepo({ db, now: () => clock.now(), log: quiet });
  const bot = new H.FakeBot();
  for (const u of FIX.bot_fail) bot.fail.add(u);
  const rand = new H.Rand();
  const atCalls = [];
  const charts = [];
  const metricCalls = [];

  const scanner = VS.createVolumeScanner({
    clock,
    sleep: async () => {},
    random: rand,
    log: cap.make('CHM.VolumeScanner'),
    filterLog: cap.make('CHM.VolumeFilter'),
    strategyLog: cap.make('CHM.VolumeStrategy'),
    tgLog: cap.make('CHM.TgSafe'),
    cache: candleCache,
    trend, registry, freshness, confluence, coinQuality,
    exchangeSymbols: exSym,
    repo,
    kv,
    metrics: { record: async (name, value, tags) => { metricCalls.push([name, value, { ...(tags || {}) }]); } },
    executeAutoTrade: async (kw) => {
      const k = { ...kw };
      delete k.bot;
      atCalls.push(k);
      const res = FIX.at_result[String(kw.user_id)] || { executed: false, show_trade_btn: false, limit_msg: null };
      if (res === 'raise') throw new Error('exchange down');
      return { ...res };
    },
    getApiKeys: (user, exchange) => {
      const k = FIX.api_keys[String(user.user_id)];
      return k && k[0] === exchange ? { apiKey: k[1], apiSecret: k[2] } : null;
    },
    getBalance: async (user) => (Object.prototype.hasOwnProperty.call(FIX.balances, String(user.user_id)) ? FIX.balances[String(user.user_id)] : null),
    sendChart: (_bot, user, sig, df, o) => {
      charts.push({ uid: user.user_id, strategy: o.strategy, lang: o.lang, symbol: sig.symbol, df_len: df.length, df_last: df.t[df.length - 1] });
    },
    isAdmin: (u) => u.user_id === 123,
  });

  // kv volume_cfg_<uid> exactly as the bot wrote it (save_user_cfg / a raw value)
  for (const [uid, op, arg] of FIX.cfg_init) {
    if (op === 'save') await scanner.saveUserCfg(uid, arg);
    else kv.set(VS.KV_CFG_PREFIX + String(uid), arg);
  }
  cfgKv = {};
  for (const [k, v] of kv.map) if (k.startsWith(VS.KV_CFG_PREFIX)) cfgKv[k] = v;
  // [VOL-POST-SL-PAUSE] the previous signals the bot seeded into `trades` (here signal_trades)
  const seed = db.prepare(`INSERT INTO signal_trades (${FIX.seed_cols.join(', ')}) VALUES (${FIX.seed_cols.map(() => '?').join(', ')})`);
  for (const r of FIX.seed_trades) seed.run(...r);
  cap.lines.length = 0;   // the bot clears its capture here (cfg init logs are not part of any cycle)

  const out = [];
  const prev = { sent: 0, charts: 0, at: 0, metrics: 0, rest: 0, logs: 0 };
  for (const cyc of FIX.cycles) {
    clock.t = cyc.ts;
    for (const k of Object.keys(trend._state)) delete trend._state[k];
    for (const k of Object.keys(trend._strength)) delete trend._strength[k];
    const st = {};
    for (const [tf, tr] of Object.entries(cyc.trend)) st[tf] = { trend: tr, since: cyc.ts - 3600.0, price: 90000.0 };
    trend._seed(st, cyc.strength);
    for (const op of cyc.cfg || []) {
      if (op[1] === 'reset') await scanner.resetUserCfg(op[0]);
      else await scanner.saveUserCfg(op[0], op[2]);
    }
    for (const sym of FIX.symbols) {
      if (FIX.ws_missing.includes(sym)) continue;
      for (const tf of FIX.meta.ws_tfs) {
        if ((FIX.ws_no_htf[sym] || []).includes(tf)) continue;
        const lim = Object.prototype.hasOwnProperty.call(FIX.ws_short, sym) ? FIX.ws_short[sym] : 300;
        const f = H.frameAt(sym, tf, cyc.ts, lim);
        if (f) candleCache.setCandles(sym, tf, f, FIX.cache_ttl);
      }
    }
    const gc = cyc.gc ? scanner.gcSent() : null;

    await scanner._scanCycle(bot, um, fetcher);

    const kvNow = {};
    for (const [k, v] of kv.map) if (k !== 'signal_registry') kvNow[k] = v;
    const exState = exSym._getState();
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
      sent_bars: Object.fromEntries(scanner._sentBars),
      htf: Object.fromEntries(Array.from(scanner._htfCache, ([k, v]) => [k, [v[0], v[1].length, v[1].t[v[1].length - 1]]])),
      skips: [exState.skipCounter, { ...exState.skipSamples }],
      confluence: confluence.getStats(),
      gc,
      rand_k: rand.k,
    });
    Object.assign(prev, { sent: bot.sent.length, charts: charts.length, at: atCalls.length, metrics: metricCalls.length, rest: fetcher.calls.length, logs: cap.lines.length });
  }
  return out;
}

/** The Python kv table minus the keys init_db wrote (migration markers), unchanged. */
function pyKv(c) {
  const base = {};
  for (const [k, v] of Object.entries(FIX.kv_init)) if (!k.startsWith('volume_cfg_')) base[k] = v;
  const o = {};
  for (const [k, v] of Object.entries(c.kv)) if (!(k in base) || base[k] !== v) o[k] = v;
  return o;
}

function cardOf(json, site) {
  if (!json) return null;
  const d = JSON.parse(json);
  const kb = site ? (d.actions ? req('../../../services/engine/cards/keyboards.js').toTelegram(d.actions) : null) : d.kb;
  return { html: d.html, kb };
}

describe('volume_scanner differential replay (volume_scanner.py)', () => {
  beforeAll(async () => { run = await replay(); }, 300_000);
  afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ } });

  it('fixture covers the scenario (cap, dedup, not-delivered, auto-trade, cfg paths, REST / HTF fallbacks)', () => {
    const all = FIX.expected;
    const trades = all[all.length - 1].trades;
    expect(trades.length).toBeGreaterThanOrEqual(30);
    expect(trades.some((t) => t.skip_reason === 'not_delivered')).toBe(true);
    expect(all.some((c) => c.logs.some((l) => l[2].includes('[VOLUME-CFG]')))).toBe(true);
    expect(all.some((c) => c.logs.some((l) => l[2].includes('[TRACE-AT-FAIL]')))).toBe(true);
    expect(all.some((c) => c.at_calls.length > 0)).toBe(true);
    expect(all.some((c) => c.rest.some((r) => r[0] === 'candles'))).toBe(true);
    expect(all.some((c) => c.gc !== null)).toBe(true);
    // batch D (2026-10)
    const logs = all.flatMap((c) => c.logs.map((l) => l[2]));
    expect(logs.some((m) => m.startsWith('[VOL-LIQ-15M] tf=15m coins'))).toBe(true);
    expect(logs.some((m) => m.startsWith('[VOL-MIN-SL] ') && m.includes('(15m floor)'))).toBe(true);
    expect(logs.filter((m) => m.startsWith('[VOL-POST-SL-PAUSE] uid=')).length).toBeGreaterThanOrEqual(3);
    expect(all.some((c) => c.at_calls.some((a) => a.timeframe === '1h'))).toBe(true);
    expect(FIX.seed_trades.length).toBeGreaterThanOrEqual(8);
  });

  it('save_user_cfg wrote the same kv values', () => {
    const py = {};
    for (const [k, v] of Object.entries(FIX.kv_init)) if (k.startsWith('volume_cfg_')) py[k] = v;
    expect(cfgKv).toEqual(py);
  });

  it('QUIRK pins: an undelivered card still counts toward the per-user cap and stays in _sent_bars', () => {
    const c0 = FIX.expected[0];
    const t2008 = c0.trades.filter((t) => t.user_id === 2008);
    expect(t2008.length).toBe(VS_MAX);
    expect(t2008.every((t) => t.skip_reason === 'not_delivered')).toBe(true);
    // the same group's other users got exactly the same 3 coins (cap 3, found 6)
    const t2002 = c0.trades.filter((t) => t.user_id === 2002 && !t.trade_id.startsWith('seed_')).map((t) => t.symbol);
    expect(t2008.map((t) => t.symbol)).toEqual(t2002);
    // [VOL-POST-SL-PAUSE]: 2001's SYNRG01 SHORT is paused (a SL 3 bars ago) — no row, no card, logged once
    const t2001 = c0.trades.filter((t) => t.user_id === 2001 && !t.trade_id.startsWith('seed_')).map((t) => t.symbol);
    expect(t2001).not.toContain('SYNRG01-USDT-SWAP');
    expect(c0.logs.filter((l) => l[2].startsWith('[VOL-POST-SL-PAUSE] uid=2001 SYNRG01-USDT-SWAP SHORT')).length).toBe(1);
    expect(Object.keys(c0.sent_bars).filter((k) => k.startsWith('2008|')).length).toBe(VS_MAX);
    // next cycle (same bars): _sent_bars dedups them (no new row), the 4th coin is delivered instead
    const c1 = FIX.expected[1];
    expect(c1.logs.filter((l) => l[2].startsWith('[VOL-POST-SL-PAUSE] uid=2001')).length).toBe(0);   // same bar: logged once
    const new2008 = c1.trades.filter((t) => t.user_id === 2008).slice(t2008.length);
    expect(new2008.map((t) => t.symbol)).not.toContain(t2008[0].symbol);
  });

  const N = FIX.cycles.length;
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
        expect(J().kv).toEqual(pyKv(E()));
        expect(H.norm(J().registry)).toEqual(E().registry);
        expect(J().registry_file).toEqual(E().registry_file);
        expect(J().registry_stats).toEqual(E().registry_stats);
        const ju = J().users.map((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [k, typeof v === 'boolean' ? Number(v) : v])));
        expect(ju).toEqual(E().users);
      });
      it('scanner state: _sent_bars, HTF cache, exchange skips, confluence, gc_sent', () => {
        expect(H.norm(J().sent_bars)).toEqual(E().sent_bars);
        expect(H.norm(J().htf)).toEqual(E().htf);
        expect(J().skips).toEqual(E().skips);
        expect(J().confluence).toEqual(E().confluence);
        expect(J().gc).toEqual(E().gc);
        expect(J().rand_k).toEqual(E().rand_k);
      });
    });
  }
});
