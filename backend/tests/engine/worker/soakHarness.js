'use strict';
/**
 * soakHarness — the in-process engine worker (runWorker over a real MessageChannel) with every
 * worker-side loop the site runs offline (the three real scanners, the WS feed, cache_gc, the
 * health monitor, coin quality, regime, momentum, the free evening report, the trend monitor, the
 * signal tracker, the SMC coin warm-up) over hours of fake time: a fake WS pool delivers the
 * golden candles of every bar that closed (15m / 1H / 4H / 1D, 42 symbols) at each 15-minute
 * boundary and fires the real bar-close bus; a fake REST client answers from the same candles.
 * Nothing touches the network; fake timers drive everything (setImmediate stays real so the
 * MessagePort flows).
 *
 * Used by engine.soak.test.js:
 *   cpu      process.cpuUsage() over one simulated hour of 1h / 4h closes (the work of every
 *            loop + the delivery RPCs + the main-side notifier, all in this process)
 *   memory   the size of every engine cache / registry / buffer the site keeps, and the heap after
 *            a full GC, sampled every simulated hour; the cycle counts of each loop
 *
 * Callers set DATABASE_PATH & co. before requiring this module and pass their `vi`.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const v8 = require('v8');
const vm = require('vm');
const { getEventListeners } = require('events');

const LV_FIX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '..', 'scanners', 'levels_fixtures', 'scan.json.gz'))).toString('utf8'));
const TF_FILE = { '15m': '15m', '1h': '1h', '1H': '1h', '4h': '4h', '4H': '4h', '1d': '1d', '1D': '1d' };
const FEED_TFS = ['15m', '1H', '4H', '1D'];
const iso = (s) => Date.parse(`${s}Z`) / 1000;

const PRO = { sub_plan: 'pro', sub_status: 'active', lang: 'ru' };
const LV1 = { pivot_strength: 7, use_rsi: false, use_volume: false, min_volume_usdt: 200000 };
const LV4 = { pivot_strength: 5, use_rsi: false, use_volume: false };
const VOL_CFG = { trend_filter: false, use_htf: false, vol_mult: 1.0, min_quality: 2 };
const USERS = [
  [711, PRO, { strategy: 'LEVELS', long_active: true, short_active: true, long_tf: '1h', short_tf: '1h', long_interval: 3600, short_interval: 3600, ...LV1 }],
  [712, PRO, { strategy: 'LEVELS', long_active: true, short_active: true, long_tf: '4h', short_tf: '4h', long_interval: 14400, short_interval: 14400, ...LV4 }],
  [721, PRO, { strategy: 'SMC', smc_long_active: true, smc_short_active: true }],
  [722, PRO, { strategy: 'SMC', smc_long_active: true, smc_short_active: true, smc_cfg: '{"tf_key": "4H"}' }],
  [731, PRO, { strategy: 'VOLUME', vol_long_active: true, vol_short_active: true, vol_timeframe: '1h' }],
  [732, PRO, { strategy: 'VOLUME', vol_long_active: true, vol_short_active: true, vol_timeframe: '4h' }],
  // free plan: LEVELS quota windows + missed buffer, SMC Pro previews
  [741, { sub_plan: 'free', lang: 'ru' }, { strategy: 'LEVELS', long_active: true, long_tf: '1h', long_interval: 3600, ...LV1 }],
  [742, { sub_plan: 'free', lang: 'en' }, { strategy: 'SMC', smc_long_active: true, smc_short_active: true }],
];
const TASKS = ['scanner', 'smc_coin_warmup', 'cache_gc', 'health_monitor', 'coin_quality', 'regime_loop', 'momentum_loop',
  'ws_feed', 'smc_scanner', 'volume_scanner', 'free_report', 'trend_monitor', 'signal_tracker'];

let gcFn = null;
function fullGc() {
  if (!gcFn) {
    v8.setFlagsFromString('--expose_gc');
    gcFn = vm.runInNewContext('gc');
  }
  gcFn();
  gcFn();
}

/** The TFs whose bar closes at `t` (s). */
function closingTfs(t) {
  const out = ['15m'];
  if (t % 3600 === 0) out.push('1H');
  if (t % 14400 === 0) out.push('4H');
  if (t % 86400 === 0) out.push('1D');
  return out;
}

async function runSoak({
  vi, startIso = '2025-12-28T00:00:00', hours = 3, stepMs = 500, cpuHour = null, onSample = null,
  snapshotHours = [], snapshotDir = null,
} = {}) {
  const START = iso(startIso) - 60;
  const END = START + 60 + hours * 3600;
  vi.useFakeTimers({ now: START * 1000, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const { MessageChannel } = require('worker_threads');
  const db = require('../../../models/database.js');
  const ts = require('../../../services/traderSettingsService.js');
  const G = require('../../golden/load.js');
  const candleCache = require('../../../services/marketData/candleCache.js');
  const wsPoolReal = require('../../../services/marketData/wsPool.js');
  const feedMod = require('../../../services/marketData/bingxWsFeed.js');
  const { runWorker } = require('../../../workers/engineWorker.js');
  const { createSignalDelivery } = require('../../../services/engine/signalDelivery.js');
  const smc = require('../../../services/engine/smcScanner.js');
  const vol = require('../../../services/engine/volumeScanner.js');
  const lv = require('../../../services/engine/levelsScanner.js');
  const mdLog = require('../../../services/marketData/mdLog.js');
  const { CACHE_TTL } = lv;

  // counters instead of a log list (a growing list would be the leak we measure)
  const counts = new Map();
  const lastLines = [];
  const bump = (lvl, m) => {
    const s = String(m);
    const key = `${lvl}:${s.replace(/[\d.]+/g, '#').slice(0, 60)}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (lvl !== 'DEBUG') { lastLines.push([Date.now() / 1000, lvl, s.slice(0, 300)]); if (lastLines.length > 200) lastLines.shift(); }
  };
  mdLog.setLogger({
    debug: (m) => bump('DEBUG', m), info: (m) => bump('INFO', m), warn: (m) => bump('WARNING', m),
    warning: (m) => bump('WARNING', m), error: (m) => bump('ERROR', m),
  });
  feedMod._resetBarCloseCallbacks();
  lv._resetModuleStateForTests();

  for (const [uid, plan, cfg] of USERS) {
    db.prepare("INSERT INTO users (id, email, password_hash, referral_code, locale, is_active, email_verified) VALUES (?, ?, 'x', ?, 'ru', 1, 0)")
      .run(uid, `soak${uid}@x.test`, `S${uid}`);
    ts.save({ ...ts.defaults(uid), ...plan, ...cfg, sub_expires: END + 30 * 86400 }, { now: START - 3600 });
  }
  ts.invalidateCache();
  await vol.saveUserCfg(731, VOL_CFG);

  const VOL = { ...LV_FIX.volumes };
  const COINS = LV_FIX.symbols.slice();
  candleCache._resetForTests();
  candleCache.initCache(4000, { log: mdLog.silent });
  let marketAt = null;
  const frameAt = (s, tf, limit = 300) => {
    const f = TF_FILE[tf];
    if (!f || marketAt === null) return null;
    return G.loadFrame(s, f).closedPrefix(f, Math.round(marketAt * 1000), limit);
  };
  let restCalls = 0;
  const fetcher = {
    volBySym: { ...VOL },
    async getAllUsdtPairs(min = 1_000_000, blacklist = null) {
      restCalls += 1;
      if (marketAt === null) return [];
      const bl = new Set(blacklist || []);
      return COINS.filter((s) => VOL[s] >= min && !bl.has(s)).sort((a, b) => VOL[b] - VOL[a]);
    },
    async getCandles(symbol, tf, limit = 300) {
      restCalls += 1;
      return frameAt(symbol, tf, limit);
    },
  };
  const feeds = [];
  let barCloses = 0;
  let closesDelivered = 0;
  const deliverClose = async (close) => {
    marketAt = close;
    candleCache.setCoins(COINS.slice());
    for (const s of COINS) for (const tf of FEED_TFS) { const f = frameAt(s, tf); if (f) candleCache.setCandles(s, tf, f, CACHE_TTL); }
    const tfs = closingTfs(close);
    for (const s of COINS) for (const tf of tfs) { await feedMod.fireBarClose(s, tf); barCloses += 1; }
    closesDelivered += 1;
  };
  const wsPool = {
    DEFAULT_TIMEFRAMES: wsPoolReal.DEFAULT_TIMEFRAMES,
    resolveMaxSymbols: wsPoolReal.resolveMaxSymbols,
    selectUniverse: async () => COINS.slice(),
    getActiveFeeds: () => feeds.slice(),
    async runWsPool({ symbols, timeframes }) {
      feeds.push({ symbols, timeframes });
      // the feed's state at connect time, then every bar close on the 15-minute grid
      await deliverClose(Math.floor(Date.now() / 1000 / 900) * 900);
      const arm = () => {
        const next = (Math.floor(Date.now() / 1000 / 900) + 1) * 900;
        setTimeout(() => { deliverClose(next).finally(arm); }, next * 1000 - Date.now());
      };
      arm();
      return { feeds, async stop() {} };
    },
  };
  const candleStore = {
    async ensureCandles() { return null; },
    HistoryLoader: class { async close() {} },
    async cleanup() {},
    candlePrefetchLoop() { return { stop() {}, done: Promise.resolve() }; },
  };

  const ch = new MessageChannel();
  const delivery = createSignalDelivery({});
  const health = new Map();
  let rpcs = 0;
  ch.port2.on('message', (msg) => {
    if (msg.type === 'health') health.set(msg.name, (health.get(msg.name) || 0) + 1);
    if (msg.type === 'rpc' || msg.type === 'call') rpcs += 1;
    delivery.handleWorkerMessage(msg, (m) => ch.port2.postMessage(m));
  });
  smc._resetDefault();
  const worker = runWorker(ch.port1, {
    logs: false,
    deps: { fetcher, wsPool, cache: candleCache, candleStore, env: { ...process.env, CACHE_WARMER_ENABLED: '0' }, regimeProvider: false },
  });
  ch.port2.postMessage({ type: 'start', options: { only: TASKS } });
  const turn = () => new Promise((r) => setImmediate(r));
  for (let i = 0; i < 100 && worker.scheduler() === null; i++) await turn();

  const sched = () => worker.scheduler();
  const sizes = () => {
    const c = sched().ctx;
    const sc = c.levels;
    const out = {};
    const put = (k, v) => { out[k] = v; };
    put('levels._indicators', sc._indicators.size);
    put('levels._indConfigs', sc._indConfigs.size);
    put('levels._lastScan', sc._lastScan.size);
    put('levels._tradeLocks', sc._tradeLocks.size);
    put('levels._wsTrigLast', sc._wsTrigLast ? sc._wsTrigLast.size : 0);
    put('levels._anMemo', sc._anMemo ? sc._anMemo.size : 0);
    put('levels._queue', sc._queue ? sc._queue.qsize() : 0);
    let cd = 0;
    let hz = 0;
    let zc = 0;
    for (const ind of sc._indicators.values()) {
      if (ind && ind.cooldown && ind.cooldown.map) cd += ind.cooldown.map.size;
      if (ind && ind.htfZoneCache) hz += ind.htfZoneCache.size;
      if (ind && ind.zoneCache && ind.zoneCache.map) zc += ind.zoneCache.map.size;
    }
    put('levels.indicator.cooldown(sum)', cd);
    put('levels.indicator.htfZoneCache(sum)', hz);
    put('levels.indicator.zoneCache(sum)', zc);
    const s = smc.currentScanner();
    put('smc._analyzers', s ? s._analyzers.size : 0);
    put('smc._lastScan', s ? s._lastScan.size : 0);
    put('smc._tfCache', s ? s._tfCache.size : 0);
    put('smc._pending', s ? s._pending.size : 0);
    put('volume._sentBars', vol.defaultScanner._sentBars.size);
    put('volume._htfCache', vol.defaultScanner._htfCache.size);
    const conf = c.confluence().getStats();
    put('confluence.keys', conf.keys);
    put('confluence.entries', conf.entries);
    put('registry.active', require('../../../services/engine/signalRegistry.js').defaultRegistry.getStats().active);
    const fr = c.freeReport();
    put('freeReport.previewSent', fr.previewSent.size);
    put('candleCache.size', candleCache.cacheStats().size || 0);
    put('barClose.callbacks', feedMod._barCloseCallbackCount());
    put('remote.pending', worker.remote.pendingCount);
    put('scheduler.abortListeners', getEventListeners(sched().signal, 'abort').length);
    put('health._heartbeats', c.health._heartbeats.size);
    put('health._errorCounts', c.health._errorCounts.size);
    return out;
  };
  const cycles = () => ({
    levels: health.get('LEVELS') || 0,
    volume: health.get('VOLUME') || 0,
    smc: [...counts].filter(([k]) => k.startsWith('INFO:[SMC-VOL-GATE-SUMMARY]')).reduce((a, [, n]) => a + n, 0),
    closes: closesDelivered,
  });
  const samples = [];
  const sample = () => {
    fullGc();
    const m = process.memoryUsage();
    const reg = require('../../../services/engine/signalRegistry.js').defaultRegistry.snapshot();
    const regTs = Object.values(reg);
    // the data part of the heap: every space except the JIT's code spaces (optimised code keeps
    // growing a little while new paths warm up; a heap-snapshot diff of hours 6 → 16 showed only
    // code there)
    const heapData = v8.getHeapSpaceStatistics().filter((sp) => !/code/.test(sp.space_name)).reduce((a, sp) => a + sp.space_used_size, 0);
    const smp = {
      t: Date.now() / 1000 - START, cycles: cycles(), sizes: sizes(), heapUsed: m.heapUsed, heapData, rss: m.rss,
      rows: db.prepare('SELECT COUNT(*) n FROM signal_trades').get().n,
      registryOldestAgeS: regTs.length ? Date.now() / 1000 - Math.min(...regTs) : 0,
      sentBarsOldestAgeS: vol.defaultScanner._sentBars.size ? Date.now() / 1000 - Math.min(...vol.defaultScanner._sentBars.values()) : 0,
    };
    samples.push(smp);
    if (onSample) onSample(smp);
    const h = Math.round((smp.t - 60) / 3600);
    if (snapshotDir && snapshotHours.includes(h)) v8.writeHeapSnapshot(path.join(snapshotDir, `soak-h${h}.heapsnapshot`));
    return smp;
  };

  // drive the fake clock in small steps with real turns (the MessagePort) in between
  let cpu = null;
  // the measured hour starts 30 s before the hour `cpuHour` closes: its 1h (4h / 1D) close and the
  // three 15m closes after it fall inside, with all the work they trigger
  const cpuStart = cpuHour === null ? null : START + 60 + cpuHour * 3600 - 30;
  let c0 = null;
  let w0 = null;
  let nextSample = START + 60;
  while (Date.now() / 1000 < END) {
    const t = Date.now() / 1000;
    if (cpuStart !== null && c0 === null && t >= cpuStart) { c0 = process.cpuUsage(); w0 = process.hrtime.bigint(); }
    if (c0 !== null && cpu === null && t >= cpuStart + 3600) {
      const d = process.cpuUsage(c0);
      cpu = { userS: d.user / 1e6, systemS: d.system / 1e6, simulatedS: 3600, realS: Number(process.hrtime.bigint() - w0) / 1e9 };
      cpu.ratio = (cpu.userS + cpu.systemS) / cpu.simulatedS;
    }
    if (t >= nextSample) { sample(); nextSample += 3600; }
    await turn();
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  sample();
  const out = { samples, cpu, cycles: cycles(), counts, lastLines, rpcs, restCalls, barCloses };
  const stopping = worker.stop();
  for (let i = 0; i < 400; i++) { await turn(); await vi.advanceTimersByTimeAsync(100); }
  out.stopRes = await stopping;
  out.listenersAfterStop = getEventListeners(sched().signal, 'abort').length;
  ch.port1.close();
  ch.port2.close();
  feedMod._resetBarCloseCallbacks();
  mdLog.setLogger(null);
  vi.useRealTimers();
  return out;
}

module.exports = { runSoak, USERS, TASKS, closingTfs };
