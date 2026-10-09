'use strict';
/**
 * scheduler.js — the background loops bot.py main() starts, in the bot's order and timing
 * (`asyncio.gather(_guarded(...), _guarded_restart(...), …)`, data-and-market.md §5).
 *
 * Every task is started at t = 0 in the gather order below; the "boot order" of the bot
 * (feeds → cache warmer → trend monitor → loops) comes from each loop's own first delay:
 *
 *   #  task               side    wrapper                first run / period (bot)
 *   1  scanner            worker  _guarded_restart(10)   MidScanner.runForever() (levelsScanner.js)
 *   2  smc_coin_warmup    worker  _guarded               3 s, then getAllUsdtPairs(500 000) every 600 s
 *   3  cache_gc           worker  _guarded               300 s, then every 3600 s (+ the 24 h block)
 *   4  genome_maintenance main    _guarded               120 s, then a check every 300 s (GC 24 h, baseline 6 h)
 *   5  health_monitor     worker  _guarded               120 s, then every 300 s
 *   6  coin_quality       worker  _guarded               restore + recompute if > 6 h, wake every 600 s
 *   7  regime_loop        worker  _guarded               60 s, then every 1800 s (+ genome regime provider)
 *   8  momentum_loop      worker  _guarded               120 s, then every 300 s
 *   9  ghost_cleanup      main    _guarded               300 s, then every 6 h
 *  10  genome_evolution   main    _guarded               300 s + kv resume, cycle LEVELS→SMC→VOLUME, 6 h
 *  11  candle_prefetch    worker  _guarded               600 s, then every 3600 s
 *  12  ws_feed            worker  _guarded               5 s → universe → WS pool (feeds)
 *  13  cache_warmer       worker  _guarded               waits ≤ 30 × 1 s for the feeds, warmer 10 s / 30 s
 *  14  smc_scanner        worker  _guarded_restart(30)   every 300 s or on a bar close
 *  15  volume_scanner     worker  _guarded_restart(10)   volumeScanner.js (60 s floor)
 *  16  free_report        worker  _guarded               21:00 UTC daily
 *  17  trend_monitor      worker  _guarded               90 s, then every INTERVAL_S (60 s)
 *  18  signal_tracker     worker  _guarded               120 s, then every INTERVAL_S (60 s)
 *
 * Not carried over (no site equivalent or a later milestone): polling, turso_sync, subs_backup,
 * notification_drainer, daily_summary / weekly_digest / engagement / challenge / entry_advisor
 * (report and retention loops, M10b / M17), hour_filter_monitor, plan_audit_monitor,
 * sub_reminder (planService.startExpiryLoop), time_sync, health_server, metrics_*, mem_trim,
 * log_monitor_*, drip_campaign, ton_subscription_checker, feedback / optimizer / retrain loops
 * (the ML optimizer is not ported), state_reconcile / trade_state_cleanup / anomaly_detector /
 * sl_verifier / orphan_sweeper (auto-trade, M13–M14), binance_lead, loop_lag_monitor.
 *
 * _guarded(name, coro): an exception → log.critical + admin alert "💀 <b>Задача упала: …</b>",
 *   the task is dead (no restart). A clean return ends it.
 * _guarded_restart(name, factory, base_delay=10, max_delay=300): an exception → log.critical +
 *   alert "💀 <b>{name} упала — авто-рестарт через {delay}s</b>", sleep delay, restart; the next
 *   delay is base_delay when the failed run lasted ≥ 300 s, else min(delay × 2, max_delay). A clean
 *   return = an intended stop. Cancellation (scheduler.stop → AbortSignal) ends both wrappers.
 * stop(): abort every loop, wait ≤ 4 s (the bot's `wait_for(gather(*pending), 4.0)`), then
 *   signal_registry.force_save() ("🛑 signal_registry persisted: %d записей").
 *
 * Sleeps go through `ctx.sleep(ms)` — setTimeout based and resolved early by the abort signal —
 * so the whole schedule runs under fake timers (tests/engine/worker/scheduler.timing.test.js
 * replays a PY311 trace of these loops over 6 simulated hours).
 *
 * The three scanners (scanners/index.js) get the thread's wiring of what bot.py hands them:
 *   MidScanner(config, bot, um, stop_event)   new MidScanner(botConfig(env), ctx.bot, um, stopEvent,
 *                                             scannerDeps('LEVELS')) — its `.fetcher` (the thread's
 *                                             BingX REST client + get_global_trend) is `scanner.fetcher`
 *                                             of every other loop
 *   run_volume_scanner(bot, um, fetcher, …)   runVolumeScanner(ctx.bot, um, fetcher, {health, signal,
 *                                             deps: scannerDeps('VOLUME')}) (configures the module instance)
 *   run_smc_scanner(bot, um, fetcher, …)      runSmcScanner(ctx.bot, um, fetcher, {health, signal, deps})
 * scannerDeps: the scheduler clock / abortable sleep / log / env, the candle cache, the WS bar-close
 * bus (marketData/bingxWsFeed.registerOnBarClose = ws_feed.register_on_bar_close), the candle store
 * (LEVELS warm-up), and the site side of telegram_safe / chart_sender: `siteSafeSend` (the bot's
 * safe_send_message over ctx.bot.sendMessage; a card is recognised by its on_sent =
 * `siteRememberSignalMessage(trade_id)`, the delivery side then stores signal_msg_id + the card
 * snapshot), `siteSendChart` (the chart descriptor, D3). Auto-trade (execute_auto_trade + the user's
 * API keys) is `deps.autoTrade` — until M13b none: no keys → no trade and no counter-trend notice,
 * the same for all three scanners.
 */

const os = require('os');
const { performance } = require('perf_hooks');
const { fmtFixed, pyRepr } = require('../../strategies/common/pyfmt');
const { pyStrRepr } = require('../../strategies/common/pyUnicode');
const { pyInt, pyFloat } = require('./pycoerce');
const { log: mdLog } = require('../marketData/mdLog');

const RESTART_MAX_DELAY_S = 300;
const RESTART_HEALTHY_RUN_S = 300;
const SHUTDOWN_WAIT_MS = 4000;

// bot.py timings
const COIN_WARMUP_FIRST_S = 3;
const COIN_WARMUP_INTERVAL_S = 600;
const COIN_WARMUP_MIN_VOL = 500_000;
const GC_FIRST_S = 300;
const GC_INTERVAL = 3600;
const GC_DAILY_S = 86400;
const GHOST_FIRST_S = 300;
const GHOST_INTERVAL_S = 6 * 3600;
const GHOST_MAX_AGE_DAYS = 3;
const WS_FEED_FIRST_S = 5;
const WARMER_WAIT_TRIES = 30;
const PREFETCH_INTERVAL_S = 3600;
const EVOLUTION_BETWEEN_TFS_MS = 10_000;
const LOW_LOAD_MAX_RATIO = 0.9;
const LOW_LOAD_TIMEOUT_S = 600.0;
const LOW_LOAD_RECHECK_S = 60.0;
const CPU_WINDOW_S = 5.0;

/**
 * Config.CACHE_MAX_KEYS: int(CACHE_MAX_KEYS) when set (non-empty), else the deprecated
 * CACHE_MAX_SYMBOLS (with its warning), else 4000. CPython int() of the text (a bad value raises,
 * like the bot's config import).
 */
function cacheMaxKeys(env = process.env, log = mdLog) {
  if (env.CACHE_MAX_KEYS) return pyInt(String(env.CACHE_MAX_KEYS));
  if (env.CACHE_MAX_SYMBOLS) {
    log.warning('env var CACHE_MAX_SYMBOLS is deprecated, rename to CACHE_MAX_KEYS (semantics unchanged)');
    return pyInt(String(env.CACHE_MAX_SYMBOLS));
  }
  return 4000;
}

/**
 * The bot's Config fields a MidScanner reads (config.py): the performance constants
 * (API_CONCURRENCY 12, SCAN_WORKERS 10, CHUNK_SIZE 15, CHUNK_SLEEP 0.01, SCAN_LOOP_SLEEP 5 — class
 * constants, no env), PAYMENT_ADDRESS = os.getenv("PAYMENT_ADDRESS", ""), LEVELS_MIN_RR =
 * float(os.environ.get("LEVELS_MIN_RR", "1.8")), CACHE_MAX_KEYS. ADMIN_IDS are site admins
 * (users.is_admin).
 */
function botConfig(env = process.env) {
  return Object.freeze({
    ADMIN_IDS: Object.freeze([]),
    API_CONCURRENCY: 12,
    SCAN_WORKERS: 10,
    CHUNK_SIZE: 15,
    CHUNK_SLEEP: 0.01,
    SCAN_LOOP_SLEEP: 5,
    PAYMENT_ADDRESS: env.PAYMENT_ADDRESS === undefined ? '' : String(env.PAYMENT_ADDRESS),
    LEVELS_MIN_RR: pyFloat(env.LEVELS_MIN_RR === undefined ? '1.8' : String(env.LEVELS_MIN_RR)),
    CACHE_MAX_KEYS: cacheMaxKeys(env, { warning() {} }),
    env,
  });
}

/** repr(dict) of exchange_symbols.get_stats() for the "📋 Exchange symbols loaded: %s" line. */
function statsRepr(stats) {
  const FLOATS = new Set(['updated_at', 'binance_paused_until']);
  const val = (k, v) => {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (typeof v === 'number') return FLOATS.has(k) ? pyRepr(v) : String(Math.trunc(v));
    return pyStrRepr(String(v));
  };
  return `{${Object.entries(stats || {}).map(([k, v]) => `'${k}': ${val(k, v)}`).join(', ')}}`;
}

/** html.escape(s, quote=True) */
function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

/** str(e)[:300] — the message, first 300 code points */
function errHead(e, n = 300) {
  const s = e && e.message !== undefined ? String(e.message) : String(e);
  return Array.from(s).slice(0, n).join('');
}

const pyD = (v) => String(Math.trunc(Number(v)));

/** A sleep that resolves after `ms` or as soon as `signal` aborts (the loop then sees `signal.aborted`). */
function makeSleep(signal, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h) } = {}) {
  return function sleep(ms) {
    if (signal && signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let h = null;
      const done = () => {
        if (h !== null) clearTimer(h);
        h = null;
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      };
      h = setTimer(done, Math.max(0, Number(ms) || 0));
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  };
}

/** asyncio.Event for MidScanner(stop_event=…): set() on scheduler stop. */
class StopEvent {
  constructor() { this._set = false; this._waiters = []; }
  isSet() { return this._set; }
  set() {
    this._set = true;
    for (const w of this._waiters.splice(0)) w();
  }
  wait() {
    if (this._set) return Promise.resolve(true);
    return new Promise((r) => this._waiters.push(() => r(true)));
  }
}

/** log.critical(msg, exc_info=True): the message, the stack as the record's extra argument. */
function critical(log, msg, err) {
  const stack = err && err.stack ? String(err.stack) : errHead(err);
  if (typeof log.critical === 'function') log.critical(msg, stack);
  else log.error(msg, stack);
}

/** _guarded(name, coro): one failing task never kills the others; a crash is reported, not restarted. */
async function guarded(name, run, ctx) {
  try {
    await run();
  } catch (e) {
    if (ctx.signal && ctx.signal.aborted) return;          // CancelledError → raise (shutdown)
    critical(ctx.log, `💀 Задача '${name}' завершилась с необработанным исключением!`, e);
    try {
      await ctx.bot.alertAdmins(`💀 <b>Задача упала: ${name}</b>\n<code>${htmlEscape(errHead(e))}</code>\nТребуется перезапуск бота.`);
    } catch (e2) {
      ctx.log.debug(`silent exc bot.py:799: ${e2 && e2.message}`);
    }
  }
}

/** _guarded_restart(name, factory, base_delay, max_delay) */
async function guardedRestart(name, factory, ctx, { baseDelay = 10, maxDelay = RESTART_MAX_DELAY_S } = {}) {
  let delay = baseDelay;
  for (;;) {
    const t0 = ctx.mono();
    try {
      await factory();
      return;                                              // a clean exit = intended stop
    } catch (e) {
      if (ctx.signal && ctx.signal.aborted) return;        // CancelledError → raise
      const ran = (ctx.mono() - t0) / 1000;
      critical(ctx.log, `💀 Задача '${name}' упала (ran ${fmtFixed(ran, 0)}s) — авто-рестарт через ${pyD(delay)}s`, e);
      try {
        await ctx.bot.alertAdmins(`💀 <b>${name} упала — авто-рестарт через ${pyD(delay)}s</b>\n<code>${htmlEscape(errHead(e))}</code>`);
      } catch (_e) {
        ctx.log.debug(`guarded_restart alert ${name} failed`);
      }
      await ctx.sleep(delay * 1000);
      if (ctx.signal && ctx.signal.aborted) return;
      // Здоровый прогон (>5 мин) → сброс backoff; иначе эскалация.
      delay = ran >= RESTART_HEALTHY_RUN_S ? baseDelay : Math.min(delay * 2, maxDelay);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  health_monitor.py
// ═══════════════════════════════════════════════════════════════════════

class HealthMonitor {
  constructor(bot, { now = () => Date.now() / 1000, log = mdLog } = {}) {
    this._bot = bot;
    this._checkInterval = 300;
    this._heartbeats = new Map();
    this._errorCounts = new Map();
    this._now = now;
    this._log = log;
    this.onHeartbeat = null;            // engine worker: forwards scanner heartbeats to the supervisor
  }

  /** Called by the scanners at the end of each cycle. */
  heartbeat(scannerName) {
    const t = this._now();
    this._heartbeats.set(scannerName, t);
    if (this.onHeartbeat) {
      try { this.onHeartbeat(scannerName, t); } catch (_e) { /* never break a scanner */ }
    }
  }

  reportError(source) {
    this._errorCounts.set(source, (this._errorCounts.get(source) || 0) + 1);
  }

  async runForever({ signal = null, sleep } = {}) {
    await sleep(120 * 1000);
    if (signal && signal.aborted) return;
    this._log.info(`🏥 HealthMonitor запущен (проверка каждые ${this._checkInterval} сек)`);
    while (!(signal && signal.aborted)) {
      try {
        await this.checkHealth();
      } catch (e) {
        this._log.error(`HealthMonitor ошибка: ${e && e.message}`);
      }
      await sleep(this._checkInterval * 1000);
    }
  }

  async checkHealth() {
    const alerts = [];
    const now = this._now();
    for (const [name, timeout] of Object.entries(HealthMonitor.SCANNER_TIMEOUTS)) {
      const last = this._heartbeats.get(name) || 0;
      if (last <= 0) continue;
      const elapsed = now - last;
      if (elapsed > timeout) alerts.push(`🔴 Сканер <b>${name}</b> не отвечает ${Math.trunc(elapsed / 60)} мин!`);
    }
    for (const [source, count] of Array.from(this._errorCounts)) {
      if (count > 10) alerts.push(`⚠️ <b>${source}</b>: ${count} API-ошибок за период`);
    }
    this._errorCounts.clear();
    if (alerts.length) {
      const text = '🚨 <b>Health Alert</b>\n\n' + alerts.join('\n');
      this._log.warning(`Health alert: ${alerts.join(' | ')}`);
      try {
        await this._bot.alertAdmins(text);
      } catch (e) {
        this._log.debug(`health alert send: ${e && e.message}`);
      }
    }
    return alerts;
  }
}
HealthMonitor.SCANNER_TIMEOUTS = Object.freeze({ LEVELS: 600, ORPHAN: 1200, VOLUME: 900 });

// ═══════════════════════════════════════════════════════════════════════
//  loops nested in bot.py main()
// ═══════════════════════════════════════════════════════════════════════

/** _coin_universe_warmup_loop(fetcher) — [SMC-COIN-WARMUP] */
async function coinUniverseWarmupLoop(ctx) {
  const { log, signal } = ctx;
  await ctx.sleep(COIN_WARMUP_FIRST_S * 1000);
  let firstOk = false;
  while (!signal.aborted) {
    try {
      const t0 = ctx.now();
      const coins = await ctx.fetcher().getAllUsdtPairs(COIN_WARMUP_MIN_VOL);
      const dt = ctx.now() - t0;
      if (coins && coins.length) {
        if (!firstOk) {
          log.info(`[SMC-COIN-WARMUP] initial warm-up OK — ${coins.length} coins populated in ${fmtFixed(dt, 1)}s (fetcher.vol_by_sym ready for first SMC scan)`);
          firstOk = true;
        } else {
          log.debug(`[SMC-COIN-WARMUP] refresh OK — ${coins.length} coins in ${fmtFixed(dt, 1)}s`);
        }
      } else {
        log.warning('[SMC-COIN-WARMUP] refresh returned 0 coins (OKX slow / network issue?) — keeping previous cache');
      }
    } catch (e) {
      if (signal.aborted) return;
      log.warning(`[SMC-COIN-WARMUP] refresh exception: ${e && e.message}`);
    }
    await ctx.sleep(COIN_WARMUP_INTERVAL_S * 1000);
  }
}

/**
 * cache_gc._cleanup_once() over the caches that exist on the site (engine-worker module
 * state), in the bot's order. Returns {name: freed}. Caches of unported modules (handlers
 * cooldowns, auto-trade locks / registries, exchange instrument caches, skip_notify,
 * anomaly detector, tilt / correlation caps) are not there to clean.
 */
function cacheGcOnce(ctx) {
  const t = ctx.now();
  const freed = {};
  const L = ctx.log;
  const smc = ctx.smcInstance ? ctx.smcInstance() : null;
  if (smc) {
    try {
      const n = smc.gcTfCache(t);
      if (n) freed['smc._tf_cache'] = n;
    } catch (e) { L.debug(`GC smc._tf_cache: ${e && e.message}`); }
    try {
      const cutoff = t - 86400;
      let n = 0;
      for (const [k, ts] of Array.from(smc._lastScan)) if (ts < cutoff) { smc._lastScan.delete(k); n += 1; }
      if (n) freed['smc._SMC_LAST_SCAN'] = n;
    } catch (e) { L.debug(`GC smc._SMC_LAST_SCAN: ${e && e.message}`); }
  }
  try {
    const vol = ctx.scanners.loadModule('VolumeScanner');
    if (vol && typeof vol.gcSent === 'function') {
      const n = vol.gcSent();
      if (n) freed['volume_scanner._sent_bars'] = n;
    }
  } catch (e) { L.debug(`GC volume_scanner._sent_bars: ${e && e.message}`); }
  try {
    const n = ctx.confluence().gcRecent();
    if (n) freed['signal_confluence._recent'] = n;
  } catch (e) { L.debug(`GC signal_confluence._recent: ${e && e.message}`); }
  try {
    const n = ctx.balanceCache().gcCache();
    if (n) freed['balance_cache._BALANCE_CACHE'] = n;
  } catch (e) { L.debug(`GC balance_cache: ${e && e.message}`); }
  try {
    const fr = ctx.freeReport();
    const sent = fr.previewSent;
    const today = require('../../strategies/common/pytime').utcDate(t);
    const stale = [];
    for (const [uid, entries] of sent) {
      if (!(entries instanceof Map)) { stale.push(uid); continue; }
      if (Array.from(entries.values()).every((v) => v !== today)) stale.push(uid);
    }
    for (const uid of stale) sent.delete(uid);
    if (stale.length) freed['free_report._FREE_PREVIEW_SENT'] = stale.length;
  } catch (e) {
    L.warning(`cache_gc free_report: unhandled ${e && e.message}`);
  }
  return freed;
}

/** cache_gc.gc_loop(): 300 s, then hourly; the 24 h block = candle store cleanup + trades GC. */
async function cacheGcLoop(ctx) {
  const { log, signal } = ctx;
  log.info(`🧹 Cache GC запущен (интервал ${GC_INTERVAL}с)`);
  await ctx.sleep(GC_FIRST_S * 1000);
  let lastJsonBackup = 0.0;
  while (!signal.aborted) {
    try {
      const freed = ctx.cacheGcOnce(ctx);
      const keys = Object.keys(freed);
      if (keys.length) log.info(`🧹 Cache GC: удалено записей — ${keys.map((k) => `${k}=${freed[k]}`).join(', ')}`);
      else log.debug('🧹 Cache GC: нечего удалять');
    } catch (e) {
      log.warning(`Cache GC error: ${e && e.message}`);
    }
    if (ctx.now() - lastJsonBackup > GC_DAILY_S) {
      // The subs JSON export has no site equivalent (the site DB is the subscriptions' source
      // of truth); its success stamp gates the daily block exactly like the bot's.
      lastJsonBackup = ctx.now();
      try {
        await ctx.candleStore().cleanup({ now: () => ctx.now() * 1000, log });
      } catch (e) {
        log.debug(`Candle store GC: ${e && e.message}`);
      }
      try {
        ctx.ghost().runTradesGc(ctx.db(), { log, now: ctx.now() });
      } catch (e) {
        log.debug(`Trades GC: ${e && e.message}`);
      }
    }
    await ctx.sleep(GC_INTERVAL * 1000);
  }
}

/** _ghost_cleanup_loop(): 300 s, then every 6 h, db_cleanup_ghost_trades_all(max_age_days=3). */
async function ghostCleanupLoop(ctx) {
  await ctx.sleep(GHOST_FIRST_S * 1000);
  while (!ctx.signal.aborted) {
    try {
      ctx.ghost().runGhostCleanup(ctx.db(), { log: ctx.log, now: ctx.now(), maxAgeDays: GHOST_MAX_AGE_DAYS });
    } catch (e) {
      ctx.log.warning(`_ghost_cleanup_loop: ${e && e.message}`);
    }
    await ctx.sleep(GHOST_INTERVAL_S * 1000);
  }
}

function _envInt(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && String(n) === String(raw).trim() ? n : dflt;
}

/** _start_ws_feed(fetcher): 5 s, the coin universe, then the sharded WS pool until stop. */
async function startWsFeed(ctx) {
  const { log, signal, env } = ctx;
  await ctx.sleep(WS_FEED_FIRST_S * 1000);
  if (signal.aborted) return;
  const wsPool = ctx.wsPool();
  let pool = null;
  try {
    const symbols = await wsPool.selectUniverse({ rest: ctx.fetcher(), cache: ctx.cache(), env, log });
    if (!symbols || !symbols.length) return;          // "ws_feed: нет монет для подписки, отложен запуск"
    const timeframes = wsPool.DEFAULT_TIMEFRAMES.slice();
    const numShards = Math.max(1, _envInt(env, 'WS_FEED_NUM_SHARDS', 1));
    const wsMax = wsPool.resolveMaxSymbols(env);
    log.info(`ws_feed: подписываемся на top-${symbols.length} монет × ${timeframes.length} TF = ${symbols.length * timeframes.length} channels `
      + `(WS_FEED_MAX_SYMBOLS=${wsMax}, WS_FEED_NUM_SHARDS=${numShards}, per-shard~${Math.floor(symbols.length / Math.max(numShards, 1))} coins)`);
    pool = await wsPool.runWsPool({ rest: ctx.fetcher(), cache: ctx.cache(), symbols, timeframes, env, log, sleep: ctx.sleep });
    ctx.state.wsPool = pool;
    // run_ws_feed keeps running until cancelled
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, { once: true });
    });
  } catch (e) {
    if (signal.aborted) return;
    log.error(`ws_feed startup error: ${e && e.message}`);
  } finally {
    if (pool && signal.aborted) {
      try { await pool.stop(); } catch (_e) { /* best effort */ }
    }
  }
}

/** _start_cache_warmer(fetcher): wait ≤ 30 × 1 s for the feeds, one CacheWarmer per shard. */
async function startCacheWarmer(ctx) {
  const { log, signal } = ctx;
  const wsPool = ctx.wsPool();
  for (let i = 0; i < WARMER_WAIT_TRIES; i++) {
    if (wsPool.getActiveFeeds().length) break;
    await ctx.sleep(1000);
    if (signal.aborted) return;
  }
  const feeds = wsPool.getActiveFeeds();
  if (!feeds.length) {
    log.warning('cache_warmer: _active_feed(s) не появились за 30с — abort');
    return;
  }
  const W = ctx.CacheWarmer();
  const warmers = feeds.map((f) => W.fromEnv(f, ctx.fetcher(), { env: ctx.env, log, sleep: ctx.sleep, now: () => ctx.now() }));
  for (const w of warmers) await w.start();
  ctx.state.warmers = warmers;
  log.info(`[PHASE-16.5] cache_warmer: ${warmers.length} warmer(s) started`);
  const onAbort = () => { for (const w of warmers) w.stop().catch(() => {}); };
  if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  await Promise.allSettled(warmers.map((w) => w._task).filter(Boolean));
}

/** genome._proc_cpu_ratio(window): (user+sys) / wall / allowed CPUs of this process. */
async function procCpuRatio(ctx, windowS = CPU_WINDOW_S) {
  const c0 = process.cpuUsage();
  const w0 = ctx.mono();
  await ctx.sleep(windowS * 1000);
  const c1 = process.cpuUsage(c0);
  const wall = Math.max(1e-6, (ctx.mono() - w0) / 1000);
  return ((c1.user + c1.system) / 1e6) / wall / cpuAllowed();
}

function cpuAllowed() {
  try {
    const n = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return n > 0 ? n : 1;
  } catch (_e) {
    return 1;
  }
}

/** genome._wait_for_low_load(max_load_ratio=0.9, timeout=600) as the evolution loop calls it. */
async function waitForLowLoad(ctx, { maxLoadRatio = LOW_LOAD_MAX_RATIO, timeout = LOW_LOAD_TIMEOUT_S, recheckS = LOW_LOAD_RECHECK_S } = {}) {
  let waited = 0.0;
  const ratioOf = ctx.cpuRatio || ((w) => procCpuRatio(ctx, w));
  while (waited < timeout) {
    try {
      const ratio = await ratioOf(CPU_WINDOW_S);
      waited += CPU_WINDOW_S;
      if (ratio < maxLoadRatio) {
        if (waited > CPU_WINDOW_S) {
          ctx.log.info(`🧬 process cpu=${fmtFixed(ratio, 2)} of ${cpuAllowed()} CPU OK (waited ${fmtFixed(waited, 0)}s) — starting evolution`);
        }
        return true;
      }
      ctx.log.info(`🧬 skip evolution: process cpu=${fmtFixed(ratio, 2)} of ${cpuAllowed()} CPU >= ${fmtFixed(maxLoadRatio, 2)}, recheck in 60s`);
    } catch (e) {
      ctx.log.warning(`genome._wait_for_low_load() unhandled exception: ${e && e.message}`);
      return true;
    }
    await ctx.sleep(recheckS * 1000);
    waited += recheckS;
  }
  return false;
}

/**
 * The evolution cycle of genome_evolution_loop with every generation in a genome worker
 * (services/genome/runner.runGenerationInWorker, mode 'cycle'): LEVELS → SMC → VOLUME, each
 * over its TFs, the bot's log line per generation, 10 s between TFs.
 */
async function runEvolutionCycle(ctx) {
  const C = require('../genome/config');
  const out = [];
  for (const S of C.STRATEGIES) {
    for (const tf of C.getTfs(S)) {
      try {
        const r = await ctx.runGeneration({ strategy: S, tf, mode: 'cycle' });
        if (!r || !r.ok) throw new Error((r && r.error) || 'unknown');
        const n = (v) => (v === undefined || v === null ? 0 : Number(v));
        ctx.log.info(`🧬 ${S}/${tf} evolution: gen=${pyD(n(r.generation))} fitness=${fmtFixed(n(r.best_fitness), 3)} WR=${fmtFixed(n(r.best_wr), 1)}% PF=${fmtFixed(n(r.best_pf), 2)} (${fmtFixed(n(r.elapsed), 0)}s)`);
        out.push({ strategy: S, tf, ...r });
      } catch (e) {
        ctx.log.warning(`🧬 ${S}/${tf} evolution failed: ${e && e.message}`);
      }
      await ctx.sleep(EVOLUTION_BETWEEN_TFS_MS);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
//  the task table (bot.py gather order)
// ═══════════════════════════════════════════════════════════════════════

const TASKS = Object.freeze([
  Object.freeze({ name: 'scanner', side: 'worker', restart: true, baseDelay: 10 }),
  Object.freeze({ name: 'smc_coin_warmup', side: 'worker' }),
  Object.freeze({ name: 'cache_gc', side: 'worker' }),
  Object.freeze({ name: 'genome_maintenance', side: 'main' }),
  Object.freeze({ name: 'health_monitor', side: 'worker' }),
  Object.freeze({ name: 'coin_quality', side: 'worker' }),
  Object.freeze({ name: 'regime_loop', side: 'worker' }),
  Object.freeze({ name: 'momentum_loop', side: 'worker' }),
  Object.freeze({ name: 'ghost_cleanup', side: 'main' }),
  Object.freeze({ name: 'genome_evolution', side: 'main' }),
  Object.freeze({ name: 'candle_prefetch', side: 'worker' }),
  Object.freeze({ name: 'ws_feed', side: 'worker' }),
  Object.freeze({ name: 'cache_warmer', side: 'worker' }),
  Object.freeze({ name: 'smc_scanner', side: 'worker', restart: true, baseDelay: 30 }),
  Object.freeze({ name: 'volume_scanner', side: 'worker', restart: true, baseDelay: 10 }),
  Object.freeze({ name: 'free_report', side: 'worker' }),
  Object.freeze({ name: 'trend_monitor', side: 'worker' }),
  Object.freeze({ name: 'signal_tracker', side: 'worker' }),
]);

/** What each task runs (ctx → Promise). */
const RUNNERS = {
  scanner: (ctx) => ctx.levels.runForever(),
  smc_coin_warmup: (ctx) => coinUniverseWarmupLoop(ctx),
  cache_gc: (ctx) => cacheGcLoop(ctx),
  genome_maintenance: (ctx) => ctx.genomeMaintenance().runGenomeMaintenanceLoop({
    log: ctx.log, sleep: ctx.sleep, stop: () => ctx.signal.aborted, now: () => ctx.now(), store: ctx.genomeStore(),
  }),
  health_monitor: (ctx) => ctx.health.runForever({ signal: ctx.signal, sleep: ctx.sleep }),
  coin_quality: (ctx) => ctx.coinQuality().runLoop({ signal: ctx.signal, sleep: ctx.sleep }),
  regime_loop: (ctx) => {
    const loop = ctx.regime();
    // the regime the strategies / the genome read (market_regime.get_cached_regime) = this loop's cache
    if (ctx.regimeProvider) require('../genome/regime').setRegimeProvider(() => loop.getCachedRegime());
    return loop.runLoop({ signal: ctx.signal, sleep: ctx.sleep });
  },
  momentum_loop: (ctx) => ctx.momentum().runLoop(ctx.lastClosed1h, { signal: ctx.signal, sleep: ctx.sleep }),
  ghost_cleanup: (ctx) => ghostCleanupLoop(ctx),
  genome_evolution: (ctx) => ctx.genomeEvolve().genomeEvolutionLoop({
    log: ctx.log, sleep: ctx.sleep, now: () => ctx.now(), store: ctx.genomeStore(),
    state: { lock: ctx.genomeLock() }, stop: () => ctx.signal.aborted,
    waitForLowLoad: () => waitForLowLoad(ctx), runCycle: () => runEvolutionCycle(ctx),
  }),
  candle_prefetch: async (ctx) => {
    // _run_candle_prefetch(): candle_store.candle_prefetch_loop(HistoryLoader()); a crash → log.error, done
    try {
      const cs = ctx.candleStore();
      const loop = cs.candlePrefetchLoop(ctx.historyLoader(), PREFETCH_INTERVAL_S, { sleep: ctx.sleep, log: ctx.log });
      const onAbort = () => loop.stop();
      if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
      await loop.done;
    } catch (e) {
      if (ctx.signal.aborted) return;
      ctx.log.error(`candle_prefetch crashed: ${e && e.message}`);
    }
  },
  ws_feed: (ctx) => startWsFeed(ctx),
  cache_warmer: (ctx) => startCacheWarmer(ctx),
  smc_scanner: (ctx) => ctx.smcRun(ctx.bot, ctx.um(), ctx.fetcher(), { health: ctx.health, signal: ctx.signal, deps: ctx.smcDeps }),
  volume_scanner: (ctx) => ctx.volumeRun(ctx.bot, ctx.um(), ctx.fetcher(), { health: ctx.health, signal: ctx.signal, deps: ctx.scannerDeps('VOLUME') }),
  free_report: (ctx) => ctx.freeReport().runEveningLoop(
    () => ctx.um().allUsers(),
    async (uid, text) => {
      if (!(await ctx.bot.sendText(uid, text, { type: 'report', kind: 'evening_report' }))) throw new Error('not delivered');
    },
    { signal: ctx.signal, sleep: ctx.sleep },
  ),
  trend_monitor: (ctx) => ctx.trend().runLoop({ signal: ctx.signal }),
  signal_tracker: async (ctx) => {
    const tracker = ctx.tracker();
    if (!tracker.start({ armDelayMs: 120_000 })) return;
    await new Promise((resolve) => {
      if (ctx.signal.aborted) resolve();
      else ctx.signal.addEventListener('abort', resolve, { once: true });
    });
    tracker.stop();
  },
};

const lazyMod = (deps, key, path) => () => (deps[key] !== undefined ? deps[key] : require(path));

/** createSmcScanner deps of the scheduler: deps.smcDeps + the auto-trade hooks of deps.autoTrade (M13b). */
function smcDepsOf(deps) {
  const at = deps.autoTrade || null;
  if (!at && !deps.smcDeps) return null;
  const out = {};
  if (at && at.executeAutoTrade) out.executeAutoTrade = at.executeAutoTrade;
  if (at && at.getApiKeys) {
    out.userApiKeys = (user, exchange) => at.getApiKeys(user, exchange) || { apiKey: '', apiSecret: '' };
  }
  if (at && at.getBalance) out.getBalance = at.getBalance;
  return { ...out, ...(deps.smcDeps || {}) };
}

/**
 * createScheduler({ side, deps }) — side: 'worker' | 'main' | 'all'.
 *
 * deps (all optional; defaults are the thread's module instances):
 *   bot            delivery facade (signalDelivery.createRemoteDelivery / localFacade)
 *   um             traderSettingsService            rest / fetcher   bingxRest.getRest()
 *   cache          candleCache                      scanners         scanners/index.js registry
 *   trend          trendMonitor instance (with send + fetcher; see installTrendMonitor)
 *   regime / momentum / coinQuality / freeReport / confluence / balanceCache    module instances
 *   tracker        signalTracker instance            ghost / candleStore / wsPool / CacheWarmer
 *   db             better-sqlite3 handle             genomeStore / genomeLock / runGeneration
 *   historyLoader  candleStore.HistoryLoader         lastClosed1h  () → [[o,c],[o,c]] | null
 *   now (s) / mono (ms) / log / env / setTimer / clearTimer / cpuRatio / smcDeps / only (task names)
 */
function createScheduler({ side = 'all', deps = {} } = {}) {
  const controller = new AbortController();
  const signal = controller.signal;
  const log = deps.log || mdLog;
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now() / 1000);
  const mono = deps.mono || (() => performance.now());
  const sleep = makeSleep(signal, { setTimer: deps.setTimer, clearTimer: deps.clearTimer });
  const stopEvent = new StopEvent();
  const scanners = deps.scanners || require('./scanners');

  const memo = {};
  const once = (k, make) => () => {
    if (!(k in memo)) memo[k] = make();
    return memo[k];
  };

  const ctx = {
    side, signal, log, env, now, mono, sleep, stopEvent, scanners, state: {},
    bot: deps.bot || require('./signalDelivery').localFacade(require('./signalDelivery').createSignalDelivery({ log })),
    um: lazyMod(deps, 'um', '../traderSettingsService'),
    cache: lazyMod(deps, 'cache', '../marketData/candleCache'),
    wsPool: lazyMod(deps, 'wsPool', '../marketData/wsPool'),
    candleStore: lazyMod(deps, 'candleStore', '../marketData/candleStore'),
    exchangeSymbols: lazyMod(deps, 'exchangeSymbols', '../exchanges/exchangeSymbols'),
    ghost: lazyMod(deps, 'ghost', './ghostCleanup'),
    genomeMaintenance: lazyMod(deps, 'genomeMaintenance', '../genome/maintenance'),
    genomeEvolve: lazyMod(deps, 'genomeEvolve', '../genome/evolve'),
    genomeStore: lazyMod(deps, 'genomeStore', '../genome/store'),
    genomeLock: () => (deps.genomeLock || require('../genome/runner').LOCK),
    runGeneration: deps.runGeneration || ((opts) => require('../genome/runner').runGenerationInWorker(opts)),
    db: lazyMod(deps, 'db', '../../models/database'),
    CacheWarmer: () => deps.CacheWarmer || require('../marketData/cacheWarmer').CacheWarmer,
    confluence: () => deps.confluence || require('./signalConfluence').defaultConfluence,
    balanceCache: () => deps.balanceCache || require('../exchanges/balanceCache'),
    freeReport: () => deps.freeReport || require('./freeReport').defaultFreeReport,
    coinQuality: () => deps.coinQuality || require('./coinQualityLearner').defaultLearner,
    momentum: () => deps.momentum || require('./momentumDetector').defaultDetector,
    cpuRatio: deps.cpuRatio || null,
    regimeProvider: deps.regimeProvider !== false,
    smcDeps: smcDepsOf(deps),
    cacheGcOnce: deps.cacheGcOnce || cacheGcOnce,
  };
  // MidScanner.__init__: self.fetcher = make_fetcher() — the REST client every loop shares
  const makeFetcher = once('restFetcher', () => withGlobalTrend(
    deps.fetcher || deps.rest || require('../marketData/bingxRest').getRest(), { now, env, log },
  ));
  ctx.fetcher = once('fetcher', () => {
    if (ctx.levels && ctx.levels.fetcher) return ctx.levels.fetcher;     // bot: scanner.fetcher
    return makeFetcher();
  });
  ctx.regime = once('regime', () => deps.regime || installDefault(
    require('./regimeLoop').defaultLoop,
    require('./regimeLoop').createRegimeLoop({ fetcher: ctx.fetcher(), log }),
  ));
  ctx.trend = once('trend', () => deps.trend || installTrendMonitor({
    send: (uid, text, o = {}) => ctx.bot.sendText(uid, text, { ...o, type: 'trend' }),
    fetcher: ctx.fetcher(), sleep, log,
  }));
  ctx.lastClosed1h = deps.lastClosed1h || (() => require('./momentumDetector').lastClosed1hViaFetcher(ctx.fetcher()));
  ctx.historyLoader = once('historyLoader', () => deps.historyLoader || new (require('../marketData/candleStore').HistoryLoader)({ log }));
  ctx.tracker = once('tracker', () => deps.tracker || require('./signalTracker').createSignalTracker({
    db: ctx.db(),
    provider: require('./signalTracker').marketDataProvider({ cache: ctx.cache(), rest: ctx.fetcher() }),
    notifier: ctx.bot.notifier, sse: ctx.bot.sse, log,
  }));
  ctx.health = deps.health || new HealthMonitor(ctx.bot, { now, log });
  /** The thread's wiring of a LEVELS / VOLUME scanner (see the header); deps.scannerDeps[S] override it. */
  ctx.scannerDeps = (strategy) => {
    const at = deps.autoTrade || null;
    const out = {
      clock: { now: () => ctx.now(), monotonic: () => ctx.mono() / 1000 },
      sleep, log, env,
      cache: ctx.cache(),
      wsFeed: deps.wsFeed || { registerOnBarClose: (cb) => require('../marketData/bingxWsFeed').registerOnBarClose(cb) },
      safeSendMessage: siteSafeSend({ log, sleep }),
      rememberSignalMessage: siteRememberSignalMessage,
      sendChart: siteSendChart(strategy, { db: ctx.db, log }),
      executeAutoTrade: at && at.executeAutoTrade ? at.executeAutoTrade : null,
      getApiKeys: at && at.getApiKeys ? at.getApiKeys : () => null,
      getBalance: at && at.getBalance ? at.getBalance : null,
    };
    if (deps.setTimer) out.timers = { setTimeout: deps.setTimer, clearTimeout: deps.clearTimer || ((h) => clearTimeout(h)) };
    if (strategy === 'LEVELS') {
      out.fetcher = makeFetcher();
      out.candleStore = ctx.candleStore();
    }
    return { ...out, ...((deps.scannerDeps && deps.scannerDeps[strategy]) || {}) };
  };
  ctx.smcRun = deps.smcRun || scanners.get('SmcScanner');
  ctx.volumeRun = deps.volumeRun || scanners.get('VolumeScanner');
  ctx.smcInstance = deps.smcInstance || (() => {
    const mod = scanners.loadModule('SmcScanner');
    return mod && typeof mod.currentScanner === 'function' ? mod.currentScanner() : null;
  });

  const only = deps.only ? new Set(deps.only) : null;
  const plan = TASKS.filter((t) => (side === 'all' || t.side === side) && (!only || only.has(t.name)));
  const running = [];
  let doneCount = 0;
  let started = false;

  function buildLevels() {
    const MidScanner = scanners.get('MidScanner');
    if (!MidScanner) return null;
    // bot.py: scanner = MidScanner(config, bot, um, stop_event=_stop_event); scanner._health = health
    const sc = new MidScanner(deps.config || botConfig(env), ctx.bot, ctx.um(), stopEvent, ctx.scannerDeps('LEVELS'));
    sc._health = ctx.health;
    return sc;
  }

  return {
    ctx, signal, tasks: plan.map((t) => t.name),

    /**
     * bot.py main() before the gather (worker side): "⏳ Инициализация кэша..." +
     * cache.init_cache(max_keys=Config.CACHE_MAX_KEYS) (skipped when this thread's cache already
     * exists), then exchange_symbols.start_background_refresh() — the per-exchange listings the
     * scanners filter by — "📋 Exchange symbols loaded: {…}" / "Exchange symbols load failed: …".
     * The engine worker runs it when started with `boot` (startEngine); tests drive start() alone.
     */
    async boot() {
      if (side === 'main') return;
      const cache = ctx.cache();
      if (cache && typeof cache.initCache === 'function' && !(typeof cache.getCache === 'function' && cache.getCache())) {
        log.info('⏳ Инициализация кэша...');
        cache.initCache(cacheMaxKeys(env, log), { log });
      }
      try {
        const ex = ctx.exchangeSymbols();
        ctx.state.exchangeRefresh = await ex.startBackgroundRefresh({ log, env, sleep, now: () => ctx.now() });
        if (signal.aborted && ctx.state.exchangeRefresh) ctx.state.exchangeRefresh.stop();
        log.info(`📋 Exchange symbols loaded: ${statsRepr(ex.getStats({ now: () => ctx.now(), env }))}`);
      } catch (e) {
        log.warning(`Exchange symbols load failed: ${e && e.message}`);
      }
    },

    /** Start every task of this side in the gather order. Returns the started task names. */
    start() {
      if (started) return this.tasks;
      started = true;
      const names = [];
      if (side !== 'main') {
        try { ctx.levels = buildLevels(); } catch (e) { log.error(`MidScanner init failed: ${e && e.message}`); ctx.levels = null; }
      }
      for (const t of plan) {
        if (t.name === 'scanner' && !ctx.levels) {
          log.warning('[ENGINE] LEVELS scanner not installed (services/engine/levelsScanner.js) — task "scanner" not started');
          continue;
        }
        if (t.name === 'smc_scanner' && !ctx.smcRun) {
          log.warning('smc import failed: services/engine/smcScanner.js not available');
          continue;
        }
        if (t.name === 'volume_scanner' && !ctx.volumeRun) {
          log.warning('[ENGINE] VOLUME scanner not installed (services/engine/volumeScanner.js) — task "volume_scanner" not started');
          continue;
        }
        const run = () => RUNNERS[t.name](ctx);
        const p = t.restart
          ? guardedRestart(t.name, run, ctx, { baseDelay: t.baseDelay })
          : guarded(t.name, run, ctx);
        running.push(p.catch(() => {}).finally(() => { doneCount += 1; }));
        names.push(t.name);
      }
      this.started = names;
      return names;
    },

    /**
     * Graceful stop: "🛑 Завершение — отменяем фоновые задачи...", abort, wait ≤ 4 s, then the
     * registry force-save (worker side). Returns {pending, saved}.
     */
    async stop({ timeoutMs = SHUTDOWN_WAIT_MS } = {}) {
      log.info('🛑 Завершение — отменяем фоновые задачи...');
      if (ctx.state.exchangeRefresh) {
        try { ctx.state.exchangeRefresh.stop(); } catch (_e) { /* best effort */ }
      }
      stopEvent.set();
      controller.abort();
      let timer = null;
      const settled = Promise.allSettled(running).then(() => 'done');
      const timeout = new Promise((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
      const how = await Promise.race([settled, timeout]);
      clearTimeout(timer);
      let pending = 0;
      if (how === 'timeout') {
        pending = running.length - doneCount;
        log.warning(`🛑 shutdown: ${pending} задач не завершились за 4с — продолжаем`);
      }
      let saved = null;
      if (side !== 'main') {
        try {
          const reg = deps.registry || require('./signalRegistry').defaultRegistry;
          saved = reg.forceSave();
          log.info(`🛑 signal_registry persisted: ${saved} записей`);
        } catch (e) {
          log.warning(`signal_registry shutdown save failed: ${e && e.message}`);
        }
      }
      return { pending, saved };
    },
  };
}

/**
 * trend_monitor_loop(bot, um, fetcher) passes the bot and the fetcher at loop start; the port
 * takes them at construction. Build the worker's monitor with them and make it THE module
 * instance (every bound export of trendMonitor.js — getTrend, applyMtfBonus, cardLine… — reads
 * the same state, like the bot's module globals).
 */
function installTrendMonitor({ send, fetcher, sleep, log, now } = {}) {
  const tm = require('./trendMonitor');
  return installDefault(tm.defaultMonitor, tm.createTrendMonitor({ send, fetcher, sleep, log, now }));
}

/**
 * Make `inst` the module's default instance: its methods (bound to its own state) replace the
 * default object's, so the module-level helpers (`getCachedRegime()`, `getTrend()`, …) every
 * other module calls read the loop's state — the bot's module globals. Returns `inst`.
 */
function installDefault(target, inst) {
  Object.assign(target, inst);
  return inst;
}

// ═══════════════════════════════════════════════════════════════════════
//  the site side of telegram_safe / chart_sender for scanner_mid / volume_scanner
// ═══════════════════════════════════════════════════════════════════════

/**
 * signal_tracker.remember_signal_message(trade_id) → the on_sent callback of a card. On the site
 * the delivery side stores signal_msg_id (= notifications.id) + the card snapshot itself
 * (signalDelivery.deliver, like the SMC cards); the callback only marks the message as the card
 * of `tradeId` for `siteSafeSend`.
 */
function siteRememberSignalMessage(tradeId) {
  const onSent = () => {};
  onSent.siteCard = { tradeId: String(tradeId) };
  return onSent;
}

/**
 * telegram_safe.safe_send_message(bot, uid, text, …) for LEVELS / VOLUME: the bot's function
 * (levelsScanner.safeSendMessage: split > 4096, retries, error classes) over
 * `bot.sendMessage(uid, text, kw)` with `kw.site` = {tradeId} for a card (on_sent of
 * siteRememberSignalMessage), else {type: opts.siteType || 'report'} (the auto-trade notices
 * pass siteType 'trade').
 */
function siteSafeSend({ log, sleep }) {
  return (bot, uid, text, opts = {}) => {
    const lv = require('./levelsScanner');
    const card = opts && opts.onSent && opts.onSent.siteCard;
    const site = card ? { tradeId: card.tradeId } : { type: (opts && opts.siteType) || 'report' };
    const tagged = bot && typeof bot.sendMessage === 'function'
      ? { sendMessage: (u, t, kw) => bot.sendMessage(u, t, { ...(kw || {}), site }) }
      : bot;
    return lv.safeSendMessage(tagged, uid, text, opts, { log, sleep });
  };
}

/**
 * chart_sender.send_signal_chart_bg(bot, user, sig, df, strategy, lang, …) → the chart descriptor
 * over ctx.bot.deliverChart (D3: the client draws it from GET /api/app/signals/:id/chart). The
 * bot skips a frame shorter than 10 bars; the signal's row (just written) gives the trade id.
 */
function siteSendChart(strategy, { db, log }) {
  return (bot, user, sig, df, opts = {}) => {
    if (!bot || typeof bot.deliverChart !== 'function' || !df || df.length < 10) return;
    const strat = (opts && opts.strategy) || strategy;
    let row = null;
    try {
      row = db().prepare('SELECT trade_id, timeframe FROM signal_trades WHERE user_id = ? AND symbol = ? AND direction = ? AND strategy = ? '
        + 'ORDER BY created_at DESC, rowid DESC LIMIT 1').get(user.user_id, sig.symbol, sig.direction, strat);
    } catch (e) {
      log.debug(`chart row ${strat} uid=${user.user_id} ${sig.symbol}: ${e && e.message}`);
    }
    const nums = (a) => (Array.isArray(a) ? a.map(Number) : []);
    try {
      bot.deliverChart({
        userId: user.user_id, tradeId: row ? row.trade_id : null, strategy: strat, lang: (opts && opts.lang) || 'ru',
        symbol: sig.symbol, timeframe: df.tf || (row && row.timeframe) || sig.timeframe || null,
        bars: df.length, lastTs: df.t[df.length - 1],
        extra: strat === 'LEVELS'
          ? { pivot_levels: nums(opts.pivotLevels), hvn_levels: nums(opts.hvnLevels), lvn_levels: nums(opts.lvnLevels) }
          : null,
      });
    } catch (e) {
      log.debug(`chart ${strat} uid=${user.user_id} ${sig.symbol}: ${e && e.message}`);
    }
  };
}

/** fetcher.get_global_trend(): the LEVELS header trend on the thread's REST client (globalTrend.js + the trend monitor). */
function withGlobalTrend(rest, { now, env, log }) {
  if (rest && typeof rest.getGlobalTrend !== 'function') {
    const gt = require('../marketData/globalTrend').createGlobalTrend({
      rest, now, env, log, getMonitorTrend: (tf) => require('./trendMonitor').getTrend(tf),
    });
    rest.getGlobalTrend = () => gt.get();
  }
  return rest;
}

module.exports = {
  TASKS, RESTART_MAX_DELAY_S, RESTART_HEALTHY_RUN_S, SHUTDOWN_WAIT_MS,
  botConfig, cacheMaxKeys, statsRepr, htmlEscape, errHead, makeSleep, StopEvent, guarded, guardedRestart, HealthMonitor,
  coinUniverseWarmupLoop, cacheGcOnce, cacheGcLoop, ghostCleanupLoop, startWsFeed, startCacheWarmer,
  procCpuRatio, waitForLowLoad, runEvolutionCycle, installTrendMonitor, installDefault, createScheduler,
  siteRememberSignalMessage, siteSafeSend, siteSendChart, withGlobalTrend,
};
