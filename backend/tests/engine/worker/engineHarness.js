'use strict';
/**
 * engineHarness — the in-process engine worker (workers/engineWorker.runWorker over a real
 * MessageChannel) with the three real scanners, the main-thread delivery + the real notifier, a
 * fake WS pool that feeds the candle cache with golden candles and fires the real bar-close bus at
 * a 1h close (T1) and a 4h close (T4), a fake REST client and candle store (no network). Used by
 * engine.integration.test.js (the full run) and engine.stop.integration.test.js (a stop in the
 * middle of the T4 cycles). The caller sets DATABASE_PATH & co. before requiring this module and
 * passes its `vi` (fake timers; setImmediate stays real so MessagePort messages flow).
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

/**
 * runEngine({ vi, stopDuringT4, inspect }) — `inspect(ctx)` (optional) is awaited after the T4
 * cycles while the engine still runs and the fake clock stands just past T4: ctx.query is the
 * engine bridge's query over the worker's port (what startEngine installs with bridge.setRemote),
 * ctx.fetcher / ctx.frameAt the fake REST client and golden frames at the feed's last close.
 */
async function runEngine({ vi, stopDuringT4 = false, inspect = null } = {}) {
  vi.useFakeTimers({ now: START * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const { MessageChannel } = require('worker_threads');
  const db = require('../../../models/database.js');
  const ts = require('../../../services/traderSettingsService.js');
  const G = require('../../golden/load.js');
  const candleCache = require('../../../services/marketData/candleCache.js');
  const wsPoolReal = require('../../../services/marketData/wsPool.js');
  const { fireBarClose, _resetBarCloseCallbacks } = require('../../../services/marketData/bingxWsFeed.js');
  const { runWorker } = require('../../../workers/engineWorker.js');
  const { createSignalDelivery } = require('../../../services/engine/signalDelivery.js');
  const smc = require('../../../services/engine/smcScanner.js');
  const vol = require('../../../services/engine/volumeScanner.js');
  // Bot batch D [VOL-MIN-VOLUME 2026-10]: the VOLUME signals this timeline relies on (SYNDN01 ribbon at T1,
  // SYNUP07 bounce at T4) have a ×1.3–1.4 signal bar, under the new ×1.5 setup volume floor. This test
  // pins the worker / scheduler / delivery plumbing, not the strategy thresholds (those are pinned by the
  // golden / probe / scanner vectors), so it runs with the bot's own switch-off VOLUME_MIN_SETUP_VOL_MULT=0
  // (= the pre-floor engine); every other batch-D threshold keeps its default.
  require('../../../strategies/volume').quality.setEnv({ ...process.env, VOLUME_MIN_SETUP_VOL_MULT: '0' });
  const lv = require('../../../services/engine/levelsScanner.js');
  const { CACHE_TTL } = lv;
  const mdLog = require('../../../services/marketData/mdLog.js');
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
  // the app routes' reads of the worker memory (engineBridge query RPC, as startEngine wires it)
  const queries = require('../../../services/engine/engineBridge.js').createQueryClient((m) => ch.port2.postMessage(m));
  const fromWorker = [];
  const rpcMethods = [];
  ch.port2.on('message', (msg) => {
    fromWorker.push(msg.type);
    if (queries.handleMessage(msg)) return;
    if (msg.type === 'rpc' || msg.type === 'call') rpcMethods.push(msg.method);
    delivery.handleWorkerMessage(msg, (m) => ch.port2.postMessage(m));
  });
  smc._resetDefault();
  const worker = runWorker(ch.port1, {
    logs: false,
    deps: { fetcher, wsPool, cache: candleCache, candleStore, env: { ...process.env, CACHE_WARMER_ENABLED: '1' }, regimeProvider: false },
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
  if (stopDuringT4) {
    // stop while the three scanners are inside their T4 cycles: the SMC cycle has started (its
    // 0.1 s pauses take seconds), LEVELS cycle #3 and the VOLUME cycle are under way
    const started = (prefix) => LOGS.some(([t, , m]) => t >= T4 && m.startsWith(prefix));
    await settle(() => started('SMC scan: ') && started('🔍 Цикл #3') && started('[VOLUME-SIGNAL]'), 400, 50);
  } else {
    await settle(() => barCloses === COINS.length * 5 && passes().levels > p4.levels && passes().smc > p4.smc && passes().volume > p4.volume && quiet()
      && LOGS.slice(-1)[0][0] - T4 > 20);
  }
  const atT4 = { rows: rowsOf(), now: at(), passes: passes(), p4 };
  if (inspect && !stopDuringT4) {
    await inspect({ db, ts, vi, at, turn, settle, fetcher, frameAt, coins: COINS.slice(), rowsOf, worker, logs: LOGS,
      query: (method, args, timeoutMs) => queries.query(method, args, timeoutMs) });
  }

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
  const rowsAtStopCall = rowsOf().length;
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
  out.after = { rows: rowsOf().length - rowsAtStop, passes: passes(), passesAtStop, rowsAtStopCall, rowsAtStop, rowsFinal: rowsOf() };
  out.notesFinal = db.prepare(`SELECT id, user_id, type, title, body, link FROM notifications WHERE user_id IN (${uids.join(',')}) ORDER BY id`).all();
  ch.port1.close();
  ch.port2.close();
  _resetBarCloseCallbacks();
  mdLog.setLogger(null);
  vi.useRealTimers();
  if (EXPLORE) {
    const show = (rows) => rows.map((r) => [r.user_id, r.strategy, r.symbol, r.direction, r.timeframe, r.created_at - T1, r.result, r.skip_reason, r.signal_msg_id].join(' '));
    console.log(JSON.stringify({ T1: show(atT1.rows), beforeT4: show(beforeT4.rows), T4: show(atT4.rows), stop: out.stopRes, after: out.after }, null, 1));
    console.log(out.logs.filter(([, l, m]) => l !== 'INFO' || /LEVELS|Цикл|TF=|✅ |MidScanner|warmup|Тренд|Загружаю|Монет/.test(m)).slice(0, 120).map((x) => [x[0] - T1, x[1], x[2].slice(0, 300)].join(' | ')).join('\n'));
  }
  return out;
}


module.exports = { runEngine, USERS, T1, T4, START };
