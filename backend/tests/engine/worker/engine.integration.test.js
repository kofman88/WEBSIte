/**
 * Engine integration: fake WS feed + golden candles → the engine worker (workers/engineWorker.js
 * runWorker over a real MessageChannel) running the three REAL scanners — LEVELS (MidScanner,
 * levelsScanner.js), SMC (smcScanner.js) and VOLUME (volumeScanner.js) — with the scheduler's
 * wiring (scheduler.scannerDeps / siteSafeSend / siteSendChart) → signal_trades rows + delivered
 * cards over one 1h close and one 4h close.
 *
 * The worker half runs the 'worker' side of the scheduler restricted to ws_feed + scanner +
 * smc_scanner + volume_scanner, with every default module instance (signal registry, free report,
 * trend monitor, confluence, freshness, momentum veto, coin-quality blacklist, regime,
 * signalTradesRepo on the test DB, the strategy engines, cards, watermark, position line). The
 * main half answers its delivery RPCs with signalDelivery.createSignalDelivery() → the real
 * notifier (notifications table + SSE registry; no e-mail / Telegram: the users are unverified
 * and not linked) → signal_msg_id + card snapshot. Nothing touches the network: the REST client
 * and the candle store are fakes, the WS pool is a fake that feeds the candle cache and fires the
 * real bar-close bus (marketData/bingxWsFeed.fireBarClose).
 *
 * Users (Pro): LEVELS 1h and 4h (LONG + SHORT jobs; the 4h jobs on a 4 h interval, so only the
 * 4H bar close re-arms them), SMC tf_key 1H and 4H, VOLUME 1h and 4h.
 *
 * Timeline (fake clock; setImmediate left real so MessagePort messages flow):
 *   T1 − 60 s   worker starts; the feed is connecting: empty cache, REST answers nothing → the first
 *               cycle of every scanner scans its users (LEVELS jobs / SMC interval gates stamped)
 *               and writes nothing
 *   T1 (1h)     the feed's bars closed ≤ T1 land in the candle cache, then the bar-close bus fires
 *               15m + 1H for every coin → LEVELS resets its 1h jobs, SMC its users, VOLUME wakes →
 *               rows + delivered cards for the 1h users of the three strategies
 *   T4 (4h)     the same with 15m + 1H + 4H → the 4h users' rows
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9b-engine-integration.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const LV_FIX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'scanners', 'levels_fixtures', 'scan.json.gz'))).toString('utf8'));
const iso = (s) => Date.parse(`${s}Z`) / 1000;
const T1 = iso(process.env.M9B_T1 || '2025-12-29T11:00:00');   // a 1h close (not a 4h one)
const T4 = iso(process.env.M9B_T4 || '2025-12-29T12:00:00');   // a 4h close
const START = T1 - 60;
const TF_FILE = { '15m': '15m', '1h': '1h', '1H': '1h', '4h': '4h', '4H': '4h', '1d': '1d', '1D': '1d' };
const FEED_TFS = ['15m', '1H', '4H', '1D'];
const EXPLORE = process.env.M9B_EXPLORE === '1';

const PRO = { sub_plan: 'pro', sub_status: 'active', lang: 'ru' };
// settings a user can pick (pivot strength, RSI / volume filters; the VOLUME cfg in kv) under which
// the golden candles carry a setup on both closes
const LV1 = { pivot_strength: 7, use_rsi: false, use_volume: false, min_volume_usdt: 200000 };
const LV4 = { pivot_strength: 5, use_rsi: false, use_volume: false };
const VOL_CFG_631 = { trend_filter: false, use_htf: false, vol_mult: 1.0, min_quality: 2 };
const USERS = [
  [611, 'LEVELS', '1h', { strategy: 'LEVELS', long_active: true, short_active: true, long_tf: '1h', short_tf: '1h', long_interval: 3600, short_interval: 3600, ...LV1 }],
  [612, 'LEVELS', '4h', { strategy: 'LEVELS', long_active: true, short_active: true, long_tf: '4h', short_tf: '4h', long_interval: 14400, short_interval: 14400, ...LV4 }],
  [621, 'SMC', '1h', { strategy: 'SMC', smc_long_active: true, smc_short_active: true }],
  [622, 'SMC', '4h', { strategy: 'SMC', smc_long_active: true, smc_short_active: true, smc_cfg: '{"tf_key": "4H"}' }],
  [631, 'VOLUME', '1h', { strategy: 'VOLUME', vol_long_active: true, vol_short_active: true, vol_timeframe: '1h' }],
  [632, 'VOLUME', '4h', { strategy: 'VOLUME', vol_long_active: true, vol_short_active: true, vol_timeframe: '4h' }],
];

let R = null;

async function run() {
  vi.useFakeTimers({ now: START * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const { MessageChannel } = req('worker_threads');
  const db = req('../../../models/database.js');
  const ts = req('../../../services/traderSettingsService.js');
  const G = req('../../golden/load.js');
  const candleCache = req('../../../services/marketData/candleCache.js');
  const wsPoolReal = req('../../../services/marketData/wsPool.js');
  const { fireBarClose, _resetBarCloseCallbacks } = req('../../../services/marketData/bingxWsFeed.js');
  const { runWorker } = req('../../../workers/engineWorker.js');
  const { createSignalDelivery } = req('../../../services/engine/signalDelivery.js');
  const smc = req('../../../services/engine/smcScanner.js');
  const vol = req('../../../services/engine/volumeScanner.js');
  const lv = req('../../../services/engine/levelsScanner.js');
  const { CACHE_TTL } = lv;
  const mdLog = req('../../../services/marketData/mdLog.js');
  const LOGS = [];
  const at = () => Date.now() / 1000;
  mdLog.setLogger({
    debug() {},
    info: (m) => LOGS.push([at(), 'INFO', String(m)]),
    warn: (m) => LOGS.push([at(), 'WARNING', String(m)]),
    warning: (m) => LOGS.push([at(), 'WARNING', String(m)]),
    error: (m) => LOGS.push([at(), 'ERROR', String(m)]),
  });
  _resetBarCloseCallbacks();
  lv._resetModuleStateForTests();

  // ── the Pro test users ──
  for (const [uid, , , cfg] of USERS) {
    db.prepare("INSERT INTO users (id, email, password_hash, referral_code, locale, is_active, email_verified) VALUES (?, ?, 'x', ?, 'ru', 1, 0)")
      .run(uid, `pro${uid}@x.test`, `R${uid}`);
    ts.save({ ...ts.defaults(uid), ...PRO, ...cfg, sub_expires: T4 + 30 * 86400 }, { now: START - 3600 });
  }
  ts.invalidateCache();
  await vol.saveUserCfg(631, VOL_CFG_631);

  // ── fake feed + golden candles ──
  const VOL = { ...LV_FIX.volumes };
  const COINS = LV_FIX.symbols.slice();
  candleCache._resetForTests();
  candleCache.initCache(4000, { log: { debug() {}, info() {}, warning() {}, error() {} } });
  let marketAt = null;                   // the last close the feed delivered (null = still connecting)
  const frameAt = (s, tf, limit = 300) => {
    const f = TF_FILE[tf];
    if (!f || marketAt === null) return null;
    return G.loadFrame(s, f).closedPrefix(f, Math.round(marketAt * 1000), limit);
  };
  const restCalls = [];
  const fetcher = {
    volBySym: { ...VOL },
    async getAllUsdtPairs(min = 1_000_000, blacklist = null) {
      restCalls.push([at(), 'pairs', Number(min)]);
      if (marketAt === null) return [];
      const bl = new Set(blacklist || []);
      return COINS.filter((s) => VOL[s] >= min && !bl.has(s)).sort((a, b) => VOL[b] - VOL[a]);
    },
    async getCandles(symbol, tf, limit = 300) {
      restCalls.push([at(), 'candles', symbol, tf]);
      return frameAt(symbol, tf, limit);
    },
  };
  const feeds = [];
  let barCloses = 0;
  const deliverClose = async (close, tfs) => {
    marketAt = close;
    candleCache.setCoins(COINS.slice());
    for (const s of COINS) for (const tf of FEED_TFS) { const f = frameAt(s, tf); if (f) candleCache.setCandles(s, tf, f, CACHE_TTL); }
    for (const s of COINS) for (const tf of tfs) { await fireBarClose(s, tf); barCloses += 1; }
  };
  const wsPool = {
    DEFAULT_TIMEFRAMES: wsPoolReal.DEFAULT_TIMEFRAMES,
    resolveMaxSymbols: wsPoolReal.resolveMaxSymbols,
    selectUniverse: async () => COINS.slice(),
    getActiveFeeds: () => feeds.slice(),
    async runWsPool({ symbols, timeframes }) {
      const feed = { symbols, timeframes };
      feeds.push(feed);
      setTimeout(() => { deliverClose(T1, ['15m', '1H']); }, T1 * 1000 - Date.now());
      setTimeout(() => { deliverClose(T4, ['15m', '1H', '4H']); }, T4 * 1000 - Date.now());
      return { feeds, async stop() {} };
    },
  };
  // candle_store (the LEVELS warm-up): the bot's ensure_candles over a history loader — no network here
  const candleStore = {
    async ensureCandles() { return null; },
    HistoryLoader: class { async close() {} },
    async cleanup() {},
  };

  // ── the two halves over a real MessageChannel ──
  const ch = new MessageChannel();
  const delivery = createSignalDelivery({});
  const fromWorker = [];
  const rpcMethods = [];
  ch.port2.on('message', (msg) => {
    fromWorker.push(msg.type);
    if (msg.type === 'rpc' || msg.type === 'call') rpcMethods.push(msg.method);
    delivery.handleWorkerMessage(msg, (m) => ch.port2.postMessage(m));
  });
  smc._resetDefault();
  const worker = runWorker(ch.port1, {
    logs: false,
    deps: { fetcher, wsPool, cache: candleCache, candleStore, env: { ...process.env, CACHE_WARMER_ENABLED: '1', SCAN_WORKERS: '4' }, regimeProvider: false },
  });
  ch.port2.postMessage({ type: 'start', options: { only: ['ws_feed', 'scanner', 'smc_scanner', 'volume_scanner'] } });

  const turn = () => new Promise((r) => setImmediate(r));
  // real turns for the MessagePort + 50 ms of fake time per turn (the SMC 0.1 s pause per symbol);
  // far below the 60 s RPC timeout, so a delivery always gets its answer
  const settle = async (cond, max = 6000, stepMs = 50) => {
    for (let i = 0; i < max; i++) {
      await turn();
      await vi.advanceTimersByTimeAsync(stepMs);
      if (cond()) return i;
    }
    return -1;
  };
  const pending = () => {
    const sc = smc.currentScanner();
    return (sc ? sc._pending.size : 0) + worker.remote.pendingCount;
  };
  const uids = USERS.map((u) => u[0]);
  const rowsOf = () => db.prepare(`SELECT * FROM signal_trades WHERE user_id IN (${uids.join(',')}) ORDER BY created_at, trade_id`).all();
  const count = (prefix) => LOGS.filter(([, , m]) => m.startsWith(prefix)).length;
  // one finished pass of each scanner: LEVELS `✅ …с | Сигналов` summary / the [LEVELS-PROFILE] of
  // its jobs, SMC [SMC-VOL-GATE-SUMMARY], VOLUME [VOLUME-PROFILE] (one per TF group)
  const passes = () => ({ levels: count('  ✅ '), smc: count('[SMC-VOL-GATE-SUMMARY]'), volume: count('[VOLUME-PROFILE]') });
  const quiet = () => pending() === 0;

  await settle(() => worker.scheduler() !== null && fromWorker.includes('ready'), 100, 0);
  // the first cycles at T1 − 60: no market data yet
  await settle(() => LOGS.some(([, , m]) => m.startsWith('[SMC-VOL-GATE-SUMMARY]')) && quiet(), 400);
  const before = { rows: rowsOf().length, lastScanSmc: Object.fromEntries(smc.currentScanner()._lastScan), passes: passes(), now: at() };
  const levelsJobsBefore = Object.fromEntries(worker.scheduler().ctx.levels._lastScan);

  // → T1 (1h close)
  await vi.advanceTimersByTimeAsync(T1 * 1000 - Date.now());
  const p1 = passes();
  await settle(() => barCloses === COINS.length * 2 && passes().levels > p1.levels && passes().smc > p1.smc && passes().volume > p1.volume && quiet()
    && LOGS.slice(-1)[0][0] - T1 > 20);
  const atT1 = { rows: rowsOf(), now: at() };
  // the hour between: nothing new on the market
  const toT4 = T4 * 1000 - Date.now();
  await vi.advanceTimersByTimeAsync(toT4 - 5000);
  await settle(() => quiet(), 200);
  const beforeT4 = { rows: rowsOf(), now: at() };
  await vi.advanceTimersByTimeAsync(T4 * 1000 - Date.now());
  const p4 = passes();
  await settle(() => barCloses === COINS.length * 5 && passes().levels > p4.levels && passes().smc > p4.smc && passes().volume > p4.volume && quiet()
    && LOGS.slice(-1)[0][0] - T4 > 20);
  const atT4 = { rows: rowsOf(), now: at() };

  const out = {
    before, levelsJobsBefore, atT1, beforeT4, atT4,
    notes: db.prepare(`SELECT id, user_id, type, title, body, link FROM notifications WHERE user_id IN (${uids.join(',')}) ORDER BY id`).all(),
    users: Object.fromEntries(uids.map((u) => [u, ts.get(u)])),
    fromWorker: fromWorker.slice(),
    rpcMethods: rpcMethods.slice(),
    logs: LOGS.slice(),
    restCalls: restCalls.slice(),
    scanners: worker.scheduler().ctx.scanners.describe(),
    tasks: worker.scheduler().started,
  };
  const logsAtStop = LOGS.length;
  const stopping = worker.stop();
  for (let i = 0; i < 200 && !fromWorker.includes('stopped'); i++) {
    await turn();
    await vi.advanceTimersByTimeAsync(100);
  }
  out.stopRes = await stopping;
  out.stopAt = at();
  out.logsAfterStop = LOGS.slice(logsAtStop).map(([, l, m]) => [l, m]);
  out.fromWorker = fromWorker.slice();
  // nothing runs after the stop: an hour of fake time, no new rows / cycles
  const rowsAtStop = rowsOf().length;
  const passesAtStop = passes();
  await vi.advanceTimersByTimeAsync(3600 * 1000);
  out.after = { rows: rowsOf().length - rowsAtStop, passes: passes(), passesAtStop };
  ch.port1.close();
  ch.port2.close();
  _resetBarCloseCallbacks();
  mdLog.setLogger(null);
  vi.useRealTimers();
  if (EXPLORE) {
    const show = (rows) => rows.map((r) => [r.user_id, r.strategy, r.symbol, r.direction, r.timeframe, r.created_at - T1, r.result, r.skip_reason, r.signal_msg_id].join(' '));
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ T1: show(atT1.rows), beforeT4: show(beforeT4.rows), T4: show(atT4.rows), stop: out.stopRes, after: out.after }, null, 1));
    // eslint-disable-next-line no-console
    console.log(out.logs.filter(([, l, m]) => l !== 'INFO' || /LEVELS|Цикл|TF=|✅ |MidScanner|warmup|Тренд|Загружаю|Монет/.test(m)).slice(0, 120).map((x) => [x[0] - T1, x[1], x[2].slice(0, 300)].join(' | ')).join('\n'));
  }
  return out;
}

const byUser = (rows, uid) => rows.filter((r) => r.user_id === uid);
const STRAT_OF = Object.fromEntries(USERS.map(([uid, s, tf]) => [uid, [s, tf]]));

describe('engine worker integration — the three real scanners over one 1h close and one 4h close (fake feed + golden candles)', () => {
  beforeAll(async () => { R = await run(); }, 600_000);
  afterAll(() => { vi.useRealTimers(); });

  it('the worker starts the real LEVELS / SMC / VOLUME scanners from the registry (no fakes)', () => {
    expect(R.tasks).toEqual(['scanner', 'ws_feed', 'smc_scanner', 'volume_scanner']);
    for (const name of ['MidScanner', 'SmcScanner', 'VolumeScanner']) expect(R.scanners[name]).toMatchObject({ available: true, error: null });
    const starts = R.logs.map(([, , m]) => m);
    expect(starts).toContain('🚀 MidScanner v4 | Воркеров: 4 | API: 12');
    expect(starts).toContain('[WS-TRIGGER] registered bar-close callback for LEVELS scanner');
    expect(starts).toContain('[WS-TRIGGER] registered bar-close callback for SMC scanner');
    expect(starts).toContain('[VOLUME-START] Volume scanner started, interval=60s');
    expect(starts).toContain('SMC Scanner started, interval=300s');
  });

  it('before the first close the feed has no data: every scanner ran its first cycle and wrote nothing', () => {
    expect(R.before.rows).toBe(0);
    expect(R.before.passes.levels).toBeGreaterThanOrEqual(1);
    expect(R.before.passes.smc).toBeGreaterThanOrEqual(1);
    for (const uid of [621, 622]) expect(R.before.lastScanSmc[uid]).toBeGreaterThanOrEqual(START);
    expect(Object.keys(R.levelsJobsBefore).sort()).toEqual(['611_LONG', '611_SHORT', '612_LONG', '612_SHORT']);
  });

  it('the 1h close: rows for the 1h users of all three strategies, written within seconds of the close; none for the 4h LEVELS / VOLUME users', () => {
    const rows = R.atT1.rows;
    for (const uid of [611, 621, 631]) {
      const mine = byUser(rows, uid);
      expect(mine.length, `user ${uid} ${STRAT_OF[uid]}`).toBeGreaterThan(0);
      for (const r of mine) {
        expect(r.strategy).toBe(STRAT_OF[uid][0]);
        expect(r.created_at).toBeGreaterThanOrEqual(T1);
        expect(r.created_at).toBeLessThan(T1 + 30);
      }
    }
    expect(byUser(rows, 612)).toEqual([]);
    expect(byUser(rows, 632)).toEqual([]);
    expect(byUser(rows, 611).every((r) => r.timeframe === '1h')).toBe(true);
    expect(byUser(rows, 631).every((r) => r.timeframe === '1h')).toBe(true);
    const lines = R.logs.filter(([t]) => t >= T1 && t < T4).map(([, , m]) => m);
    expect(lines.some((m) => /^\[WS-TRIGGER\] bar_close .+\/1H → reset 2 last_scan keys \(throttled 1\/5min\)$/.test(m))).toBe(true);
    expect(lines.some((m) => /^\[WS-TRIGGER\] SMC bar_close .+\/15m → reset 1 last_scan keys \(throttled 1\/5min\)$/.test(m))).toBe(true);
    expect(lines.some((m) => /^✅ LEVELS .+ → @611$/.test(m))).toBe(true);
    expect(lines.some((m) => /^SMC ✅ .+ → @621$/.test(m))).toBe(true);
    expect(lines.some((m) => /^\[VOLUME-SIGNAL\] uid=631 /.test(m))).toBe(true);
  });

  it('between the closes nothing new is written (same bars → dedup)', () => {
    expect(R.beforeT4.rows.map((r) => r.trade_id)).toEqual(R.atT1.rows.map((r) => r.trade_id));
  });

  it('the 4h close: rows for the 4h users of all three strategies, written within seconds of the close', () => {
    const fresh = R.atT4.rows.filter((r) => r.created_at >= T4);
    for (const uid of [612, 622, 632]) {
      const mine = byUser(fresh, uid);
      expect(mine.length, `user ${uid} ${STRAT_OF[uid]}`).toBeGreaterThan(0);
      for (const r of mine) {
        expect(r.strategy).toBe(STRAT_OF[uid][0]);
        expect(r.created_at).toBeLessThan(T4 + 30);
      }
    }
    expect(byUser(fresh, 612).every((r) => r.timeframe === '4h')).toBe(true);
    expect(byUser(fresh, 632).every((r) => r.timeframe === '4h')).toBe(true);
    const lines = R.logs.filter(([t]) => t >= T4).map(([, , m]) => m);
    expect(lines.some((m) => /^\[WS-TRIGGER\] bar_close .+\/4H → reset 2 last_scan keys \(throttled 1\/5min\)$/.test(m))).toBe(true);
  });

  it('every delivered row went through the main thread: a signal notification, signal_msg_id, the card snapshot (all three strategies)', () => {
    const notes = new Map(R.notes.map((n) => [n.id, n]));
    const delivered = R.atT4.rows.filter((r) => r.result === '');
    expect(new Set(delivered.map((r) => r.strategy))).toEqual(new Set(['LEVELS', 'SMC', 'VOLUME']));
    for (const r of delivered) {
      expect(r.signal_msg_id, r.trade_id).toBeGreaterThan(0);
      const n = notes.get(r.signal_msg_id);
      expect(n.user_id).toBe(r.user_id);
      expect(n.type).toBe('signal');
      expect(n.link).toBe(`/app/?tab=signals&id=${encodeURIComponent(r.trade_id)}`);
      const card = JSON.parse(r.signal_card_json);
      expect(card.html).toBe(n.body);
      expect(card.lang).toBe('ru');
      expect(Array.isArray(card.actions)).toBe(true);
    }
    // no undelivered card: every row of the run is a delivered one
    expect(R.atT4.rows.filter((r) => r.skip_reason === 'not_delivered')).toEqual([]);
    expect(R.notes.filter((n) => n.type === 'signal').length).toBe(delivered.length);
    expect(new Set(R.rpcMethods)).toEqual(new Set(['deliver', 'sendMessage', 'deliverChart']));
    expect(R.fromWorker).toContain('heartbeat');
  });

  it('LEVELS bumps signals_received of its users like the bot (the card counter)', () => {
    expect(R.users[611].signals_received).toBe(byUser(R.atT4.rows, 611).length);
    expect(R.users[612].signals_received).toBe(byUser(R.atT4.rows, 612).length);
  });

  it('the worker answered the shutdown with stopped; every loop ended inside the stop window and nothing runs afterwards', () => {
    expect(R.fromWorker).toContain('ready');
    expect(R.fromWorker).toContain('stopped');
    expect(R.stopRes.pending).toBe(0);
    expect(R.logsAfterStop.map(([, m]) => m)).toEqual([
      '🛑 Завершение — отменяем фоновые задачи...',
      `🛑 signal_registry persisted: ${R.stopRes.saved} записей`,
    ]);
    expect(R.stopRes.saved).toBeGreaterThan(0);
    expect(R.after.rows).toBe(0);
    expect(R.after.passes).toEqual(R.after.passesAtStop);
    expect(R.logs.filter(([, l]) => l === 'ERROR')).toEqual([]);
  });
});
