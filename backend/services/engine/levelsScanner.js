/**
 * levelsScanner — the bot's scanner_mid.py (MidScanner, the LEVELS scanner) one-to-one
 * (signal-pipeline.md §2.1, strategy-levels.md §13 scanner, §2.3 IndConfig).
 *
 * Per cycle: active users → ScanJob per (user, LONG | SHORT | BOTH) whose interval passed →
 * coin universe (_load_coins + the MidScanner volume filter) → candles once per TF → a
 * worker queue runs `_runJob` per job: optimizer / Genome params (ШАГ 9) → indicator (cached
 * per job key, rebuilt when the IndConfig changes) → per symbol: min volume, stale, too short,
 * cooldown, analyze (memoised per cycle on (symbol, tf, IndConfig, last bar, HTF)), MTF bonus,
 * squeeze boost, min quality (momentum relax), direction, trend_only, coin blacklist, BTC/ETH
 * correlation, registry peek (+ MULTI peek / claim), confluence record, free quota, long_only
 * (inert), exchange listing, notify → `_send` (TP resolve, momentum veto, freshness, the
 * signal_trades row, the counter-trend gate + auto-trade, card, chart) → commit + cooldown +
 * free counter after a confirmed delivery; `[LEVELS-PROFILE]` + the silent-scanner hint.
 *
 * Same class / method names as the bot so the scheduler drives it like bot.py drives
 * MidScanner (`new MidScanner(config, bot, um, stopEvent, deps)`, `runForever()`,
 * `_onWsBarClose(instId, tf)`, `getTrend()`, `getPerf()`, `analyzeOnDemand(symbol, cfg)`).
 *
 * ── deps (every member optional; the bot equivalent on the right) ────────────────────────
 *   clock          { now() → unix s, monotonic() → s }        time.time() / time.monotonic()
 *   sleep(ms)      → Promise                                   asyncio.sleep
 *   timers         { setTimeout, clearTimeout }                the loop's timer (wait_for timeouts)
 *   random         { randint(a, b) }                           random.randint (trade_id suffix)
 *   log            logger of 'CHM.Scanner' {debug,info,warning,error}   log = getLogger("CHM.Scanner")
 *   indicatorLog   logger of 'CHM.Indicator'                   indicator.py's log (ATR breakout line)
 *   tgLog          logger of 'CHM.TgSafe'                      telegram_safe.log
 *   fetcher        { getCandles(sym, tf, limit), getAllUsdtPairs(minVol, blacklist, maxCoins),
 *                    volBySym, getGlobalTrend() }              self.fetcher = make_fetcher()
 *   cache          { getCandles, setCandles(sym, tf, frame, ttlMap), getCoins, setCoins,
 *                    cacheStats }                              cache.py (marketData/candleCache)
 *   registry       signalRegistry instance                     signal_registry
 *   freshness      signalFreshness instance                    signal_freshness
 *   veto           momentumVeto instance                       momentum_veto
 *   momentum       momentumDetector instance                   momentum_detector (relaxed mode,
 *                                                              the shared _last_breakout_alert)
 *   regime         regimeLoop instance                         market_regime.get_cached_regime
 *   trend          trendMonitor instance                       trend_monitor
 *   confluence     signalConfluence instance                   signal_confluence
 *   coinQuality    coinQualityLearner instance                 coin_quality_learner
 *   freeReport     freeReport instance                         free_report
 *   exchangeSymbols { isAvailable(sym, exchange) } | null       exchange_symbols (None → skipped)
 *   repo           signalTradesRepo instance                   db.db_add_trade / db_set_trade_result
 *   emitEvent(tid, type, payload, opts)                        db.trade_events.emit_bg
 *   rememberSignalMessage(tradeId) → onSent(msg)               signal_tracker.remember_signal_message
 *   safeSendMessage(bot, uid, text, opts) → bool               telegram_safe.safe_send_message
 *   kv             { get, set }                                db.db_kv_get / db_kv_set (hint throttle)
 *   optimizerStore { loadOptimizerParams(uid, strategy) }      optimizer.load_params
 *   executeAutoTrade(kwargs) → {executed, show_trade_btn, limit_msg}   auto_trade.execute_auto_trade
 *   getApiKeys(user, exchange) → {apiKey, apiSecret} | null    user.<exchange>_api_key / _api_secret
 *   getBalance(user, exchange) → number | null                 balance_cache.get_cached_balance
 *   fundamental    { getMarketContextBlock() } | null          fundamental (_FUND_OK)
 *   sendChart(bot, user, sig, df, opts)                        chart_sender.send_signal_chart_bg
 *   metrics        { record(name, value, tags) }               metrics.record
 *   isAdmin(user) → bool                                       user_id in Config.ADMIN_IDS
 *   checkAccess(user) → [ok, reason]                           UserSettings.check_access()
 *   strategyEnabled(user, S) → bool                            config.strategy_enabled
 *   wsFeed         { registerOnBarClose(cb) }                  ws_feed.register_on_bar_close
 *   candleStore    { ensureCandles, HistoryLoader } | null     candle_store + backtest.HistoryLoader
 *   beMonitorLoop(scanner, {restoreHintThrottle}) → Promise    MidScanner._be_monitor_loop body (M15 U7)
 *   sentry         { captureException(e) }                     sentry_sdk
 *   analysisExecutor(fn) → value | Promise                     run_in_executor(self._analysis_executor)
 *   env            process.env-like                            os.environ (CACHE_FIRST_MODE, …)
 *
 * `bot` (2nd constructor argument) is the delivery adapter the scheduler wires:
 * `bot.sendMessage(uid, text, {parseMode, replyMarkup, protectContent, disableNotification,
 * disableWebPagePreview})` → message `{message_id, html, actions, lang}` (the site:
 * signalDelivery → notifier feed row, message_id = notifications.id). It throws an Error whose
 * `name` is TelegramRetryAfter (`retry_after`) / TelegramNetworkError / TelegramForbiddenError /
 * TelegramBadRequest for the failures safe_send_message classifies. `null` = the bot's `bot is
 * None` (nothing is delivered).
 *
 * Concurrency: N queue workers (Config.SCAN_WORKERS) as asyncio tasks → promises; the bot's
 * cancellation (wait_for timeouts, worker.cancel()) is cooperative here: a cancelled worker
 * raises CancelledError at its next checkpoint (between symbols, after an await). The analysis
 * runs inline (the engine worker thread is the executor) unless `analysisExecutor` returns a
 * promise; the 10 s analyze timeout applies to such a promise.
 *
 * Markers: [LEVELS-PROFILE], [LEVELS-HINT], [LEVELS-HINT-FREE], [LEVELS-BACKFILL],
 * [TRACE-SCAN-LEVELS], [TRACE-DB-WRITE], [STALE-SIGNAL], [SQUEEZE-BOOST], [MOMENTUM-VETO],
 * [FILTER-BLOCK], [TRACE-AT-FAIL], [WS-TRIGGER], [QUEUE-DRAIN], [LEVELS-CYCLE-TIMEOUT],
 * [LEVELS-CYCLE-SLOW], [WORKER-FAILED], [WORKER-CANCELLED], [CACHE-FIRST-SHADOW-AGG].
 */

'use strict';

const levels = require('../../strategies/levels');
const { cfgToInd: indCfgToInd, LEVELS_ENV } = require('../../strategies/levels/config');
const { computeSqueezeScore } = require('../../strategies/common/squeeze');
const { pctChange, pearson } = require('../../strategies/common/series');
const { fmtFixed, fmtG, pyRepr } = require('../../strategies/common/pyfmt');
const { pyRound } = require('../../strategies/common/pyround');
const { pyTruthy } = require('../../strategies/common/pyval');
const { pyLower, pyUpper, pyStrip, pyStrRepr } = require('../../strategies/common/pyUnicode');
const { pyJsonDumps } = require('./pyjson');
const { pyInt } = require('./pycoerce');
const tradeCfg = require('./tradeCfg');
const cardsLevels = require('./cards/levels');
const lite = require('./cards/lite');
const keyboards = require('./cards/keyboards');
const { levelsStars } = require('./cards/qualityScale');
const { escape } = require('./cards/html');
const { wmInject } = require('./watermark');
const { positionLine } = require('./positionLine');
const quietHours = require('./quietHours');
const volumeFilter = require('./volumeFilter');
const optimizerParams = require('../genome/optimizerParams');
const { computeClientOrderId } = require('../exchanges/orderIdUtils');
const { regimeAllowsDirection } = require('../../strategies/common/marketRegime');
const { pyIndex } = require('../exchanges/pyCompat');
const { log: defaultLog } = require('../marketData/mdLog');

// ── config.Config values the scanner reads ───────────────────────────────────────────
const CACHE_TTL = Object.freeze({
  '1m': 55, '5m': 270, '15m': 870, '30m': 1770, '1h': 3570, '4h': 14370,
  '1d': 85000, '1D': 85000, '1H': 3570, '4H': 14370,
});
const AUTO_BLACKLIST = Object.freeze(['USDC-USDT-SWAP', 'BUSD-USDT-SWAP', 'TUSD-USDT-SWAP', 'FDUSD-USDT-SWAP', 'DAI-USDT-SWAP']);
const DEFAULT_CONFIG = Object.freeze({
  API_CONCURRENCY: 12,
  SCAN_WORKERS: 10,
  CHUNK_SIZE: 15,
  CHUNK_SLEEP: 0.01,
  SCAN_LOOP_SLEEP: 5,
  CACHE_TTL,
  CACHE_MAX_KEYS: 4000,
  AUTO_BLACKLIST,
  PRICE_PRO: '69$',
  PAYMENT_NETWORK: 'BEP20 (BSC)',
  PAYMENT_ADDRESS: '',
  ADMIN_CONTACT: '@crypto_chm',
  LEVELS_MIN_RR: LEVELS_ENV.LEVELS_MIN_RR,
});

// 2026-04-21 L2.1: TF-aware stale-candles threshold (2 × candle + 120 s grace).
const TF_DURATION_S = Object.freeze({
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400,
  '6h': 21600, '12h': 43200, '1d': 86400, '1w': 604800,
});
const STALE_GRACE_S = 120.0;

// 2026-04-21 L2.7: smart hints for silent LEVELS scanners.
const HINT_MIN_SCANNED = 10;
const HINT_DOMINANT_RATIO = 0.5;
const HINT_THROTTLE_S = 4 * 3600;
const KV_HINT_LAST_TS = 'levels_hint_last_ts_v1';
const ANALYZE_TIMEOUT_S = 10.0;
const QUEUE_JOIN_TIMEOUT_S = 120.0;
const WORKER_IDLE_S = 5.0;
const BTC = 'BTC-USDT-SWAP';
const ETH = 'ETH-USDT-SWAP';

const HINT_MESSAGES = Object.freeze({
  levels_hint_free_simple: {
    ru: '💡 <b>Сейчас рынок тихий — сигналов мало.</b>\n\n'
      + 'Это нормально: стратегии ждут чёткие сетапы, '
      + 'не торгуют ради торговли.\n\n'
      + 'Нажми «Применить рекомендации» — бот ослабит фильтры '
      + 'LEVELS, и сигналы будут приходить чаще.',
    en: '💡 <b>Market is quiet — fewer signals right now.</b>\n\n'
      + "That's normal: strategies wait for clean setups, "
      + "they don't trade for the sake of trading.\n\n"
      + 'Tap «Apply recommended» — the bot relaxes LEVELS filters '
      + 'so signals arrive more often.',
  },
  levels_hint_zones: {
    ru: '💡 <b>LEVELS: сигналов нет</b> ({count}/{total} отклонений '
      + '— цена далеко от уровней)\n\n'
      + 'Это нормально в <b>трендовом рынке</b> — монеты летят, не '
      + 'консолидируются у support/resistance.\n\n'
      + '<b>Что можно сделать:</b>\n'
      + '1️⃣ Попробуй стратегию <b>SMC</b> (работает в тренде)\n'
      + '   🏠 Меню → ⚙️ Стратегия → SMC\n\n'
      + '2️⃣ Ослабь диапазон поиска уровней:\n'
      + '   🏠 Меню → ⚙️ LONG / SHORT → Max Distance %\n'
      + '   (твой сейчас <b>{cur_dist}%</b> — попробуй 3-7%)\n\n'
      + '3️⃣ Снизь Pivot Strength: твой <b>{cur_pivot}</b> → 3-5 '
      + '— больше уровней\n\n'
      + '<i>Сам бот не меняет настройки — выбор за тобой.</i>',
    en: '💡 <b>LEVELS: no signals</b> ({count}/{total} rejects '
      + '— price too far from S/R)\n\n'
      + 'Normal in a <b>trending market</b> — coins fly in the trend, '
      + "they don't consolidate at support/resistance.\n\n"
      + '<b>Options:</b>\n'
      + '1️⃣ Try <b>SMC</b> strategy (works in trends)\n'
      + '   🏠 Menu → ⚙️ Strategy → SMC\n\n'
      + '2️⃣ Loosen the level-search window:\n'
      + '   🏠 Menu → ⚙️ LONG / SHORT → Max Distance %\n'
      + '   (yours is <b>{cur_dist}%</b> — try 3-7%)\n\n'
      + '3️⃣ Lower Pivot Strength: yours <b>{cur_pivot}</b> → 3-5 '
      + '— more levels\n\n'
      + "<i>The bot won't change settings for you — your call.</i>",
  },
  levels_hint_volume: {
    ru: '💡 <b>LEVELS: сигналов нет</b> ({count}/{total} отклонений '
      + '— объём ниже порога)\n\n'
      + 'Рынок <b>тихий</b> — объёмы ниже среднего × 0.7, стратегия '
      + 'пропускает сигналы без подтверждения объёмом.\n\n'
      + '<b>Что можно сделать:</b>\n'
      + '1️⃣ Снизь <b>Volume Multiplier</b>: твой <b>{cur_vol_mult}</b> → 0.7:\n'
      + '   🏠 Меню → ⚙️ LONG / SHORT → Vol Mult\n\n'
      + '2️⃣ Увеличь <b>Vol Length</b> до 30 (для сглаживания):\n'
      + '   🏠 Меню → ⚙️ LONG / SHORT → Vol Length\n\n'
      + '3️⃣ Или подожди активности рынка (US session, US открытие)\n\n'
      + '<i>Сам бот не меняет настройки — выбор за тобой.</i>',
    en: '💡 <b>LEVELS: no signals</b> ({count}/{total} rejects '
      + '— volume below threshold)\n\n'
      + 'Market is <b>quiet</b> — volume below avg × 0.7, strategy '
      + 'skips unconfirmed signals.\n\n'
      + '<b>Options:</b>\n'
      + '1️⃣ Lower <b>Volume Multiplier</b>: yours <b>{cur_vol_mult}</b> → 0.7:\n'
      + '   🏠 Menu → ⚙️ LONG / SHORT → Vol Mult\n\n'
      + '2️⃣ Raise <b>Vol Length</b> to 30 (smoother avg):\n'
      + '   🏠 Menu → ⚙️ LONG / SHORT → Vol Length\n\n'
      + '3️⃣ Or wait for market activity (US session / US open)\n\n'
      + "<i>The bot won't change settings for you — your call.</i>",
  },
  levels_hint_signal: {
    ru: '💡 <b>LEVELS: сигналов нет</b> ({count}/{total} отклонений '
      + '— подход к уровню недостаточный)\n\n'
      + 'Строгие требования к <b>качеству подхода</b> (паттерн, скорость, '
      + 'отскок). Часто встречается в консолидации без резких движений.\n\n'
      + '<b>Что можно сделать:</b>\n'
      + '1️⃣ Попробуй стратегию <b>SMC</b> (мягче к подходу)\n'
      + '   🏠 Меню → ⚙️ Стратегия → SMC\n\n'
      + '2️⃣ Увеличь <b>Max Level Age</b>: твой <b>{cur_max_age}</b> → 150:\n'
      + '   🏠 Меню → ⚙️ LONG / SHORT → Max Level Age\n\n'
      + '3️⃣ Или дождись пробойного движения\n\n'
      + '<i>Сам бот не меняет настройки — выбор за тобой.</i>',
    en: '💡 <b>LEVELS: no signals</b> ({count}/{total} rejects '
      + '— approach quality insufficient)\n\n'
      + 'Strict <b>approach quality</b> requirements (pattern, speed, '
      + 'bounce). Common in quiet consolidation.\n\n'
      + '<b>Options:</b>\n'
      + '1️⃣ Try <b>SMC</b> strategy (softer on approach)\n'
      + '   🏠 Menu → ⚙️ Strategy → SMC\n\n'
      + '2️⃣ Raise <b>Max Level Age</b>: yours <b>{cur_max_age}</b> → 150:\n'
      + '   🏠 Menu → ⚙️ LONG / SHORT → Max Level Age\n\n'
      + '3️⃣ Or wait for a breakout move\n\n'
      + "<i>The bot won't change settings for you — your call.</i>",
  },
  levels_hint_rsi: {
    ru: '💡 <b>LEVELS: сигналов нет</b> ({count}/{total} отклонений '
      + '— RSI overbought/oversold)\n\n'
      + 'Рынок в <b>экстремальной зоне</b> — твой RSI-фильтр режет все '
      + 'сигналы контр-направления.\n\n'
      + '<b>Что можно сделать:</b>\n'
      + '1️⃣ Расширь диапазон RSI:\n'
      + '   🏠 Меню → ⚙️ LONG → RSI OB (твой <b>{cur_rsi_ob}</b> → 75)\n'
      + '   🏠 Меню → ⚙️ SHORT → RSI OS (твой <b>{cur_rsi_os}</b> → 25)\n\n'
      + '2️⃣ Или отключи RSI-фильтр:\n'
      + '   🏠 Меню → ⚙️ LONG / SHORT → Use RSI (OFF)\n\n'
      + '3️⃣ Или дождись коррекции рынка\n\n'
      + '<i>Сам бот не меняет настройки — выбор за тобой.</i>',
    en: '💡 <b>LEVELS: no signals</b> ({count}/{total} rejects '
      + '— RSI overbought/oversold)\n\n'
      + 'Market in <b>extreme zone</b> — your RSI filter blocks all '
      + 'counter-direction signals.\n\n'
      + '<b>Options:</b>\n'
      + '1️⃣ Widen RSI range:\n'
      + '   🏠 Menu → ⚙️ LONG → RSI OB (yours <b>{cur_rsi_ob}</b> → 75)\n'
      + '   🏠 Menu → ⚙️ SHORT → RSI OS (yours <b>{cur_rsi_os}</b> → 25)\n\n'
      + '2️⃣ Or disable RSI filter:\n'
      + '   🏠 Menu → ⚙️ LONG / SHORT → Use RSI (OFF)\n\n'
      + '3️⃣ Or wait for a market correction\n\n'
      + "<i>The bot won't change settings for you — your call.</i>",
  },
});
const HINT_I18N = Object.freeze({
  zones: 'levels_hint_zones', volume: 'levels_hint_volume', signal: 'levels_hint_signal', rsi: 'levels_hint_rsi',
});

// ── small Python-semantics helpers ───────────────────────────────────────────────────
const own = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
/** getattr(o, k, d) */
const getattr = (o, k, d) => (own(o, k) && o[k] !== undefined ? o[k] : d);
/** str(x) of the values the bot formats with %s (bool → True/False, None → None). */
function pyS(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e16 && !Object.is(v, -0) ? String(v) : pyRepr(v);
  return String(v);
}
/** str() of a TradeCfg field: floats keep their ".0" (the dataclass field type decides). */
function cfgStr(cfg, field, dflt = '?') {
  if (!own(cfg, field)) return dflt;
  const v = cfg[field];
  if (typeof v === 'number' && tradeCfg.FIELD_TYPES[field] === 'float') return pyRepr(v);
  return pyS(v);
}
/** "%d" of a Python int / float. */
const pyD = (v) => String(Math.trunc(Number(v)));
const errMsg = (e) => (e && e.message !== undefined ? e.message : String(e));

class CancelledError extends Error {
  constructor(msg = 'cancelled') { super(msg); this.name = 'CancelledError'; }
}
class TimeoutError extends Error {
  constructor(msg = '') { super(msg); this.name = 'TimeoutError'; }   // str(asyncio.TimeoutError()) == ''
}
const isCancelled = (e) => e instanceof CancelledError || (e && e.name === 'CancelledError');

function defaultTimers() {
  return {
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; },
    clearTimeout: (h) => clearTimeout(h),
  };
}

/** asyncio.wait_for(promise, timeout) — rejects with TimeoutError; the timer is always cleared. */
function waitFor(promise, timeoutS, timers) {
  return new Promise((resolve, reject) => {
    if (!(timeoutS > 0)) {
      // wait_for(timeout <= 0): the coroutine is not done yet → TimeoutError at once
      Promise.resolve(promise).catch(() => {});
      reject(new TimeoutError());
      return;
    }
    let done = false;
    const h = timers.setTimeout(() => {
      if (done) return;
      done = true;
      reject(new TimeoutError());
    }, Math.max(0, timeoutS * 1000));
    Promise.resolve(promise).then((v) => {
      if (done) return;
      done = true;
      timers.clearTimeout(h);
      resolve(v);
    }, (e) => {
      if (done) return;
      done = true;
      timers.clearTimeout(h);
      reject(e);
    });
  });
}

/** asyncio.Semaphore: FIFO waiters, acquire() resolves immediately when a slot is free. */
class Semaphore {
  constructor(n) { this.value = n; this.waiters = []; }
  acquire() {
    if (this.value > 0 && this.waiters.length === 0) { this.value -= 1; return Promise.resolve(); }
    return new Promise((r) => this.waiters.push(r));
  }
  release() {
    const w = this.waiters.shift();
    if (w) w(); else this.value += 1;
  }
}

/** asyncio.Queue subset: put / get(timeout, token) / get_nowait / task_done / join / qsize / empty. */
class AsyncQueue {
  constructor() { this.items = []; this.getters = []; this.unfinished = 0; this.joiners = []; }
  qsize() { return this.items.length; }
  empty() { return this.items.length === 0; }
  put(item) {
    this.unfinished += 1;
    const g = this.getters.shift();
    if (g) g.resolve(item); else this.items.push(item);
  }
  getNowait() {
    if (!this.items.length) { const e = new Error('QueueEmpty'); e.name = 'QueueEmpty'; throw e; }
    return this.items.shift();
  }
  /** get() with a timeout (TimeoutError) and a cancel token (CancelledError). */
  get(timeoutS, timers, token = null) {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise((resolve, reject) => {
      const g = {};
      const finish = () => {
        const i = this.getters.indexOf(g);
        if (i >= 0) this.getters.splice(i, 1);
        if (g.h !== undefined) timers.clearTimeout(g.h);
        if (token) token.off(g.onCancel);
      };
      g.resolve = (item) => { finish(); resolve(item); };
      g.onCancel = () => { finish(); reject(new CancelledError()); };
      g.h = timers.setTimeout(() => { finish(); reject(new TimeoutError()); }, timeoutS * 1000);
      if (token) token.on(g.onCancel);
      this.getters.push(g);
    });
  }
  taskDone() {
    if (this.unfinished <= 0) { const e = new Error('task_done() called too many times'); e.name = 'ValueError'; throw e; }
    this.unfinished -= 1;
    if (this.unfinished === 0) { const js = this.joiners.splice(0); for (const j of js) j(); }
  }
  join() {
    if (this.unfinished === 0) return Promise.resolve();
    return new Promise((r) => this.joiners.push(r));
  }
}

/** A cooperative cancellation token (the stand-in for Task.cancel()). */
class CancelToken {
  constructor() { this.cancelled = false; this.listeners = []; }
  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const l of this.listeners.splice(0)) { try { l(); } catch (_e) { /* listener */ } }
  }
  on(fn) { if (this.cancelled) fn(); else this.listeners.push(fn); }
  off(fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); }
  check() { if (this.cancelled) throw new CancelledError(); }
}

// ── telegram_safe.safe_send_message ──────────────────────────────────────────────────
const TG_TEXT_LIMIT = 4096;
const TG_SPLIT_SOFT = 3900;

/** str[:n] / len(str) of Python: code points, not UTF-16 units (an emoji is one character). */
function cpSlice(s, n) {
  const str = String(s);
  return str.length <= n ? str : Array.from(str).slice(0, n).join('');
}
function cpLen(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

/** _split_for_telegram(text, limit): split on '\n', a single over-long line hard-cut (lengths in code points). */
function splitForTelegram(text, limit = TG_SPLIT_SOFT) {
  if (cpLen(text) <= limit) return [text];
  const parts = [];
  let buf = '';
  let bufLen = 0;
  for (const raw of text.split('\n')) {
    let line = Array.from(raw);
    while (line.length > limit) {
      if (buf) { parts.push(buf); buf = ''; bufLen = 0; }
      parts.push(line.slice(0, limit).join(''));
      line = line.slice(limit);
    }
    const str = line.join('');
    if (buf && bufLen + 1 + line.length > limit) {
      parts.push(buf);
      buf = str;
      bufLen = line.length;
    } else if (buf) {
      buf = `${buf}\n${str}`;
      bufLen += 1 + line.length;
    } else {
      buf = str;
      bufLen = line.length;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * safe_send_message(bot, user_id, text, {parseMode='HTML', replyMarkup, protectContent,
 * disableWebPagePreview, retries=3, onSent, disableNotification}) → bool: RetryAfter → sleep
 * retry_after + 1 and retry, network → backoff 1/2/4 s, Forbidden / BadRequest / anything else
 * → false; `onSent(msg)` with the delivered message (first part of a split text).
 */
async function safeSendMessage(bot, userId, text, opts = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const {
    parseMode = 'HTML', replyMarkup = null, protectContent = false, disableWebPagePreview = false,
    retries = 3, onSent = null, disableNotification = false,
  } = opts;
  if (bot === null || bot === undefined || !userId) return false;
  if (text && cpLen(text) > TG_TEXT_LIMIT) {
    const parts = splitForTelegram(text);
    let allOk = true;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const ok = await safeSendMessage(bot, userId, parts[i], {
        parseMode, replyMarkup: last ? replyMarkup : null, protectContent, disableWebPagePreview, retries,
        onSent: i === 0 ? onSent : null, disableNotification,
      }, ctx);
      allOk = allOk && ok;
    }
    return allOk;
  }
  const kwargs = {};
  if (parseMode) kwargs.parseMode = parseMode;
  if (replyMarkup !== null && replyMarkup !== undefined) kwargs.replyMarkup = replyMarkup;
  if (protectContent) kwargs.protectContent = protectContent;
  if (disableWebPagePreview) kwargs.disableWebPagePreview = disableWebPagePreview;
  if (disableNotification) kwargs.disableNotification = true;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const msg = await bot.sendMessage(userId, text, kwargs);
      if (onSent) {
        try { onSent(msg); } catch (cbE) { log.debug(`[TG-SAFE] uid=${userId} on_sent callback: ${errMsg(cbE)}`); }
      }
      if (attempt > 0) log.info(`[TG-SAFE] uid=${userId} delivered after ${attempt + 1} attempt(s)`);
      return true;
    } catch (e) {
      const name = e && e.name;
      if (name === 'TelegramRetryAfter') {
        const wait = Number(e.retry_after === undefined ? 1 : e.retry_after) + 1.0;
        log.warning(`[TG-SAFE] uid=${userId} TelegramRetryAfter ${fmtFixed(wait, 1)}s (attempt ${attempt + 1}/${retries})`);
        await sleep(wait * 1000);
      } else if (name === 'TelegramNetworkError') {
        if (attempt < retries - 1) {
          const backoff = 2 ** attempt;
          log.warning(`[TG-SAFE] uid=${userId} network err attempt ${attempt + 1}/${retries}: ${cpSlice(errMsg(e), 100)} — backoff ${fmtFixed(backoff, 1)}s`);
          await sleep(backoff * 1000);
        } else {
          log.error(`[TG-SAFE] uid=${userId} network err — all ${retries} attempts exhausted: ${cpSlice(errMsg(e), 150)}`);
          return false;
        }
      } else if (name === 'TelegramForbiddenError') {
        log.info(`[TG-SAFE] uid=${userId} blocked bot — notification lost`);
        return false;
      } else if (name === 'TelegramBadRequest') {
        log.warning(`[TG-SAFE] uid=${userId} BadRequest: ${cpSlice(errMsg(e), 150)} — message dropped`);
        return false;
      } else {
        log.warning(`[TG-SAFE] uid=${userId} unexpected ${(e && e.constructor && e.constructor.name) || 'Error'}: ${cpSlice(errMsg(e), 150)}`);
        return false;
      }
    }
  }
  return false;
}

// ── pure helpers of scanner_mid ──────────────────────────────────────────────────────
/** pct_change().dropna().tail(n) of the close column. */
function returnsTail(frame, periods) {
  const r = pctChange(frame.c, 1);
  const out = [];
  for (let i = 0; i < r.length; i++) if (r[i] === r[i]) out.push(r[i]);
  return out.slice(Math.max(0, out.length - periods));
}

/** _compute_correlation(df1, df2, periods=30): Pearson of the % returns, round(…, 2); < 10 points / NaN → 0.0. */
function computeCorrelation(df1, df2, periods = 30) {
  try {
    const r1 = returnsTail(df1, periods);
    const r2 = returnsTail(df2, periods);
    const n = Math.min(r1.length, r2.length);
    if (n < 10) return 0.0;
    const corr = pearson(r1.slice(r1.length - n), r2.slice(r2.length - n));
    return corr === corr ? pyRound(corr, 2) : 0.0;
  } catch (_e) {
    return 0.0;
  }
}

/**
 * _compute_correlation_batch(target_dfs, ref_df, periods=30) — every coin vs one reference
 * (np.corrcoef of the stacked matrix, all rows cut to the shortest length). Not called by the
 * scan path (kept for parity with the bot module).
 */
function computeCorrelationBatch(targetDfs, refDf, periods = 30) {
  const out = {};
  const syms = Object.keys(targetDfs);
  if (!refDf || !refDf.length) { for (const s of syms) out[s] = 0.0; return out; }
  try {
    const ref = returnsTail(refDf, periods);
    if (ref.length < 10) { for (const s of syms) out[s] = 0.0; return out; }
    const rows = [];
    const valid = [];
    for (const s of syms) {
      const df = targetDfs[s];
      if (!df || !df.length) { out[s] = 0.0; continue; }
      const r = returnsTail(df, periods);
      const n = Math.min(r.length, ref.length);
      if (n < 10) { out[s] = 0.0; continue; }
      rows.push(r.slice(r.length - n));
      valid.push(s);
    }
    if (!rows.length) return out;
    let minLen = Math.min(...rows.map((r) => r.length));
    minLen = Math.min(minLen, ref.length);
    if (minLen < 10) { for (const s of valid) out[s] = 0.0; return out; }
    const refCut = ref.slice(ref.length - minLen);
    valid.forEach((s, i) => {
      const c = pearson(refCut, rows[i].slice(rows[i].length - minLen));
      out[s] = c === c ? pyRound(c, 2) : 0.0;
    });
    return out;
  } catch (_e) {
    const res = {};
    for (const s of syms) res[s] = own(out, s) ? out[s] : 0.0;
    return res;
  }
}

/** _stale_threshold_s(tf): 2 × candle + 120 s; unknown / empty tf → 120 s. */
function staleThresholdS(tf) {
  if (!tf) return STALE_GRACE_S;
  const dur = TF_DURATION_S[pyLower(String(tf))] || 0;
  if (dur <= 0) return STALE_GRACE_S;
  return 2.0 * dur + STALE_GRACE_S;
}

/** _dominant_stage(stats) → [category, count] (first maximum in insertion order), ['', 0] when empty. */
function dominantStage(stats) {
  const entries = stats instanceof Map ? Array.from(stats.entries()) : Object.entries(stats || {});
  if (!entries.length) return ['', 0];
  let best = entries[0];
  for (const e of entries) if (e[1] > best[1]) best = e;
  return best;
}

/** scanner_mid._cfg_to_ind(cfg, high_wr_mode) — MIN_RR = max(cfg.min_rr, Config.LEVELS_MIN_RR). */
function cfgToInd(cfg, highWrMode = false, levelsMinRr = LEVELS_ENV.LEVELS_MIN_RR) {
  return indCfgToInd(cfg, highWrMode, { ...LEVELS_ENV, LEVELS_MIN_RR: levelsMinRr });
}

/** i18n.t(key, lang, **kwargs) over HINT_MESSAGES (str.format; any error → the raw text). */
function hintText(key, lang, kwargs = null) {
  const entry = HINT_MESSAGES[key];
  if (!entry) return key;
  const text = entry[lang] || entry.ru || key;
  if (!kwargs) return text;
  try {
    return text.replace(/\{(\w+)\}/g, (_m, name) => {
      if (!own(kwargs, name)) throw new Error(name);
      return kwargs[name];
    });
  } catch (_e) {
    return text;
  }
}

/** The ScanJob dataclass: user + direction + cfg; job_key / tf / interval properties. */
class ScanJob {
  constructor(user, direction, cfg) { this.user = user; this.direction = direction; this.cfg = cfg; }
  get jobKey() { return String(this.user.user_id) + '_' + this.direction; }
  get tf() { return this.cfg.timeframe; }
  get interval() { return this.cfg.scan_interval; }
}

// module-level state of scanner_mid / indicator (shared by every MidScanner, like the bot)
const userHintLastTs = new Map();     // _user_hint_last_ts
const ANALYZE_STATS = new Map();      // indicator._ANALYZE_STATS
const shadow = { misses: 0, lastLog: 0.0 };   // _SHADOW_MISS_LEVELS / _SHADOW_LAST_LOG_LEVELS

/** indicator.get_analyze_stats() / reset_analyze_stats() */
function getAnalyzeStats() { return new Map(ANALYZE_STATS); }
function resetAnalyzeStats() { ANALYZE_STATS.clear(); }
function bumpAnalyzeStats(res) {
  // `_none_stat(reason)` fires inside _do_analyze; the prologue guards (too short / cooldown) do not count
  if (res && res.rejectReason && res.rejectReason !== levels.REJECT.NONE) {
    ANALYZE_STATS.set(res.rejectReason, (ANALYZE_STATS.get(res.rejectReason) || 0) + 1);
  }
}

/** _restore_hint_throttle(): kv levels_hint_last_ts_v1 → _user_hint_last_ts (entries younger than 2 × throttle). */
async function restoreHintThrottle({ kv, now = () => Date.now() / 1000, log = defaultLog } = {}) {
  try {
    const raw = await kv.get(KV_HINT_LAST_TS);
    if (!raw) return 0;
    let decoded;
    try {
      decoded = require('./signalTradesRepo').pyLoads(raw, { mapDepth: 1 });
    } catch (_e) {
      log.debug(`kv ${KV_HINT_LAST_TS}: bad JSON — ignoring`);
      return 0;
    }
    if (!(decoded instanceof Map)) return 0;
    const t = now();
    let restored = 0;
    for (const [kS, tsV] of decoded) {
      let uid;
      let tsF;
      try {
        uid = pyInt(kS);
        tsF = require('./pycoerce').pyFloat(tsV);
      } catch (_e) {
        continue;
      }
      if (t - tsF > HINT_THROTTLE_S * 2) continue;
      userHintLastTs.set(uid, tsF);
      restored += 1;
    }
    if (restored) log.info(`[LEVELS-HINT-THROTTLE-RESTORE] ${restored} entries restored from kv`);
    return restored;
  } catch (e) {
    log.debug(`restore hint throttle: ${errMsg(e)}`);
    return 0;
  }
}

/** _persist_hint_throttle(): prune entries older than 2 × throttle, then kv ← json.dumps({str(uid): float(ts)}). */
async function persistHintThrottle({ kv, now = () => Date.now() / 1000, log = defaultLog } = {}) {
  try {
    const t = now();
    for (const [uid, ts] of Array.from(userHintLastTs)) if (t - ts > HINT_THROTTLE_S * 2) userHintLastTs.delete(uid);
    // dict insertion order (a JS object would put integer-like keys first, sorted)
    // json.dumps of a float: repr, NaN / Infinity / -Infinity for the non-finite ones
    const fl = (x) => (Number.isFinite(x) ? pyRepr(x) : (Number.isNaN(x) ? 'NaN' : (x > 0 ? 'Infinity' : '-Infinity')));
    const parts = Array.from(userHintLastTs, ([uid, ts]) => `${pyJsonDumps(String(uid))}: ${fl(Number(ts))}`);
    await kv.set(KV_HINT_LAST_TS, `{${parts.join(', ')}}`);
  } catch (e) {
    log.debug(`persist hint throttle: ${errMsg(e)}`);
  }
}

/**
 * A deep copy of a signal object (copy.deepcopy of the memoised SignalResult). The LEVELS
 * signal is a plain data object (numbers incl. NaN, strings, arrays, nested objects), which the
 * structured clone copies exactly (Node ≥ 17).
 */
function deepCopySig(sig) {
  return globalThis.structuredClone(sig);
}

// ── defaults wiring (lazy: requiring this module touches neither the DB nor the network) ──
function lazyDefaults(deps) {
  const lazy = (name, make) => {
    let v;
    let made = false;
    Object.defineProperty(deps, name, {
      configurable: true, enumerable: true,
      get() { if (!made) { v = make(); made = true; } return v; },
      set(x) { v = x; made = true; },
    });
  };
  const nowS = () => deps.clock.now();
  if (!deps.clock) deps.clock = { now: () => Date.now() / 1000, monotonic: () => Number(process.hrtime.bigint()) / 1e9 };
  if (!deps.clock.monotonic) deps.clock.monotonic = () => Number(process.hrtime.bigint()) / 1e9;
  if (!deps.timers) deps.timers = defaultTimers();
  if (!deps.sleep) deps.sleep = (ms) => new Promise((r) => deps.timers.setTimeout(r, ms));
  if (!deps.random) deps.random = { randint: (a, b) => a + Math.floor(Math.random() * (b - a + 1)) };
  if (!deps.log) deps.log = defaultLog;
  if (!deps.indicatorLog) deps.indicatorLog = deps.log;
  if (!deps.tgLog) deps.tgLog = deps.log;
  if (!deps.env) deps.env = process.env;
  const set = (name, make) => { if (deps[name] === undefined) lazy(name, make); };
  set('cache', () => require('../marketData/candleCache'));
  set('registry', () => require('./signalRegistry').defaultRegistry);
  set('freshness', () => require('./signalFreshness').defaultFreshness);
  set('veto', () => require('./momentumVeto').defaultVeto);
  set('momentum', () => require('./momentumDetector').defaultDetector);
  set('regime', () => require('./regimeLoop').defaultLoop);
  set('trend', () => require('./trendMonitor').defaultMonitor);
  set('confluence', () => require('./signalConfluence').defaultConfluence);
  set('coinQuality', () => require('./coinQualityLearner').defaultLearner);
  set('freeReport', () => require('./freeReport').defaultFreeReport);
  set('exchangeSymbols', () => require('../exchanges/exchangeSymbols'));
  set('repo', () => require('./signalTradesRepo').createSignalTradesRepo({ now: nowS }));
  set('kv', () => require('../engineKvService'));
  set('optimizerStore', () => require('../genome/store'));
  set('wsFeed', () => null);
  set('candleStore', () => null);
  set('fundamental', () => null);
  set('metrics', () => null);
  set('sentry', () => null);
  set('beMonitorLoop', () => null);
  set('analysisExecutor', () => null);
  set('executeAutoTrade', () => null);
  set('sendChart', () => null);
  set('getBalance', () => null);
  if (!deps.emitEvent) deps.emitEvent = (tid, type, payload, opts) => deps.repo.addTradeEvent(tid, type, payload, opts);
  if (!deps.rememberSignalMessage) {
    deps.rememberSignalMessage = (tradeId) => (msg) => {
      const mid = msg && Number(msg.message_id) ? Math.trunc(Number(msg.message_id)) : 0;
      if (!mid || !tradeId) return;
      try {
        deps.repo.setSignalMsgId(tradeId, mid, deps.repo.cardSnapshot({ html: msg.html || '', actions: msg.actions || null, lang: msg.lang || 'ru' }));
      } catch (e) {
        deps.log.debug(`[SIGNAL-PROGRESS] remember msg tid=${tradeId}: ${errMsg(e)}`);
      }
    };
  }
  if (!deps.safeSendMessage) deps.safeSendMessage = (bot, uid, text, opts) => safeSendMessage(bot, uid, text, opts, { log: deps.tgLog, sleep: deps.sleep });
  if (!deps.isAdmin) {
    deps.isAdmin = (user) => {
      try { return require('../traderSettingsService').isAdmin(user.user_id); } catch (_e) { return false; }
    };
  }
  if (!deps.checkAccess) deps.checkAccess = (user) => require('./userAccess').checkAccess(user, { admin: Boolean(deps.isAdmin(user)), now: nowS() });
  if (!deps.strategyEnabled) deps.strategyEnabled = (user, s) => require('../../config/planFeatures').strategyEnabled(user, s, { admin: Boolean(deps.isAdmin(user)) });
  if (!deps.planFeatures) lazy('planFeatures', () => require('../../config/planFeatures').PLAN_FEATURES);
  if (!deps.getApiKeys) {
    deps.getApiKeys = (user, exchange) => {
      try {
        const db = require('../../models/database');
        const row = db.prepare("SELECT id FROM exchange_keys WHERE user_id = ? AND exchange = ? AND label = 'default'").get(user.user_id, exchange);
        if (!row) return null;
        const c = require('../exchangeService').getCredentials(row.id, user.user_id);
        return { apiKey: c.apiKey, apiSecret: c.apiSecret, passphrase: c.passphrase };
      } catch (_e) {
        return null;
      }
    };
  }
  return deps;
}

/** The default UserManager over traderSettingsService (get_active_users / all_users / save / get). */
function defaultUserManager(clock) {
  const ts = require('../traderSettingsService');
  return {
    getActiveUsers: () => ts.getActiveUsers({ now: clock.now() }),
    allUsers: () => ts.allUsers({ now: clock.now() }),
    save: (u) => ts.save(u, { now: clock.now() }),
    get: (uid) => ts.get(uid),
  };
}

class MidScanner {
  constructor(config = {}, bot = null, um = null, stopEvent = null, deps = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
    this.bot = bot;
    this._stopEvent = stopEvent;
    this.deps = lazyDefaults({ ...deps });
    this.um = um || defaultUserManager(this.deps.clock);
    this.log = this.deps.log;
    this.fetcher = this.deps.fetcher || null;

    // job_key → indicator (CHMIndicator) / its IndConfig
    this._indicators = new Map();
    this._indConfigs = new Map();
    // job_key → last scan ts
    this._lastScan = new Map();
    this._cycleCount = 0;

    this._apiSem = new Semaphore(this.cfg.API_CONCURRENCY);
    this._queue = new AsyncQueue();
    this._tradeLocks = new Map();

    this._perf = { cycles: 0, users: 0, signals: 0, api_calls: 0, api_calls_total: 0, signals_total: 0 };
    this._globalTrend = {};
    this._trendUpdatedAt = 0;
    this._trendTtl = 3600;
    this._fundBlock = '';
    this._anMemo = null;
    this._health = this.deps.health || null;
    this._wsTrigLast = new Map();
    // ws_feed.register_on_bar_close(self._on_ws_bar_close): one bound callback per scanner, so a
    // re-registration after a _guarded_restart is the same callback (`if cb not in callbacks`)
    this._onWsBarCloseCb = (inst, tf) => this._onWsBarClose(inst, tf);
    // shutdown: bot.py cancels the gather tasks → CancelledError inside the running _cycle at
    // its next await; here the stop event cancels the cycle's token (checked between steps)
    this._cycleToken = null;
    if (stopEvent && typeof stopEvent.wait === 'function') {
      Promise.resolve(stopEvent.wait()).then(() => { if (this._cycleToken) this._cycleToken.cancel(); }, () => {});
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  _now() { return this.deps.clock.now(); }

  async _safeSend(uid, text, opts = {}) {
    return this.deps.safeSendMessage(this.bot, uid, text, opts);
  }

  _captureException(e) {
    try { if (this.deps.sentry) this.deps.sentry.captureException(e); } catch (_e) { /* sentry */ }
  }

  async _metric(name, value, tags) {
    try {
      if (this.deps.metrics && typeof this.deps.metrics.record === 'function') await this.deps.metrics.record(name, value, tags);
    } catch (e) {
      this.log.debug(`metrics ${name}: ${errMsg(e)}`);
    }
  }

  // ── indicator ─────────────────────────────────────────────────────────────
  /** _indicator(job): CHMIndicator per job key, rebuilt when _cfg_to_ind(job.cfg) changes. */
  _indicator(job) {
    const ic = cfgToInd(job.cfg, Boolean(getattr(job.user, 'high_wr_mode', false)), this.cfg.LEVELS_MIN_RR);
    const icKey = JSON.stringify(ic);
    if (this._indConfigs.get(job.jobKey) !== icKey) {
      this._indicators.set(job.jobKey, levels.createIndicator(ic, { clock: () => this._now() }));
      this._indConfigs.set(job.jobKey, icKey);
    }
    return this._indicators.get(job.jobKey);
  }

  /**
   * One ind.analyze() call with the live state indicator.py reads from momentum_detector /
   * market_regime / time.time(): relaxed mode, the shared ATR-breakout cooldown map, the
   * trigger reason and the cached regime. Bumps the module-level reject counters like
   * `_none_stat` and logs the relaxed-mode ATR breakout like indicator.analyze.
   */
  _analyzeOnce(ind, symbol, df, dfHtf, dfBtc, dfEth) {
    const extra = { ...this.deps.momentum.levelsOpts(), regime: this.deps.regime.getCachedRegime(), nowSec: this._now() };
    const res = ind.analyze(symbol, df, dfHtf, dfBtc, dfEth, extra);
    bumpAnalyzeStats(res);
    if (res.stage === 'atr_breakout' && res.signal) {
      this.deps.indicatorLog.info(`ATR Breakout signal: ${symbol} ${res.signal.direction} entry=${fmtG(res.signal.entry, 6)}`);
    }
    return res.signal || null;
  }

  /** The memo future: {done, value, error, promise} (run_in_executor(self._analysis_executor, …)). */
  _startAnalysis(ind, symbol, df, dfHtf, dfBtc, dfEth) {
    const exec = this.deps.analysisExecutor;
    const fut = { done: false, value: null, error: null, promise: null };
    const run = () => this._analyzeOnce(ind, symbol, df, dfHtf, dfBtc, dfEth);
    let out;
    try {
      out = exec ? exec(run) : run();
    } catch (e) {
      fut.done = true;
      fut.error = e;
      return fut;
    }
    if (out && typeof out.then === 'function') {
      fut.promise = out.then((v) => { fut.done = true; fut.value = v; return v; }, (e) => { fut.done = true; fut.error = e; throw e; });
      fut.promise.catch(() => {});
    } else {
      fut.done = true;
      fut.value = out;
    }
    return fut;
  }

  // ── global trend ──────────────────────────────────────────────────────────
  async _updateTrendIfNeeded() {
    if (this._now() - this._trendUpdatedAt > this._trendTtl) {
      try {
        this._globalTrend = await this.fetcher.getGlobalTrend();
        this._trendUpdatedAt = this._now();
        const btc = getattr(this._globalTrend, 'BTC', {});
        const eth = getattr(this._globalTrend, 'ETH', {});
        this.log.info('🌍 Тренд: BTC=' + getattr(btc, 'trend_text', '?') + ' ETH=' + getattr(eth, 'trend_text', '?'));
      } catch (e) {
        this.log.warning('Тренд: ' + errMsg(e));
      }
    }
  }

  getTrend() { return this._globalTrend; }

  // ── coins ─────────────────────────────────────────────────────────────────
  async _loadCoins(_minVol) {
    const cached = await this.deps.cache.getCoins();
    if (pyTruthy(cached)) {
      // the vol data is missing (first run after a restart) → refresh it
      if (!pyTruthy(this.fetcher.volBySym)) await this.fetcher.getAllUsdtPairs(0, this.cfg.AUTO_BLACKLIST);
      return cached;
    }
    this.log.info('📋 Загружаю список монет...');
    // always without the minimum volume — filtered below (also fills fetcher.volBySym)
    const coins = await this.fetcher.getAllUsdtPairs(0, this.cfg.AUTO_BLACKLIST);
    if (pyTruthy(coins)) {
      await this.deps.cache.setCoins(coins);
      this.log.info('   Монет (всего): ' + String(coins.length));
    }
    return coins || [];
  }

  /** _apply_vol_filter(coins, all_jobs): the MidScanner variant over the jobs' users. */
  _applyVolFilter(coins, allJobs) {
    if (!pyTruthy(coins) || !pyTruthy(allJobs)) return coins;
    return volumeFilter.midScannerVolFilter(coins, allJobs.map((j) => j.user), this.fetcher.volBySym);
  }

  // ── candles (cache → REST) ────────────────────────────────────────────────
  async _fetch(symbol, tf) {
    let df = await this.deps.cache.getCandles(symbol, tf);
    if (df !== null && df !== undefined) return df;
    // [PHASE-16.2] CACHE_FIRST_MODE: off (REST fallback) / shadow (log + REST) / enforce (no REST)
    const mode = pyLower(String(this.deps.env.CACHE_FIRST_MODE === undefined ? 'off' : this.deps.env.CACHE_FIRST_MODE));
    if (mode === 'enforce') {
      this._perf.cache_first_skip = (this._perf.cache_first_skip || 0) + 1;
      return null;
    }
    await this._apiSem.acquire();
    try {
      df = await this.deps.cache.getCandles(symbol, tf);
      if (df !== null && df !== undefined) {
        this._perf.cache_hits_after_wait = (this._perf.cache_hits_after_wait || 0) + 1;
        return df;
      }
      if (mode === 'shadow') {
        shadow.misses += 1;
        const t = this._now();
        if (shadow.lastLog === 0.0) shadow.lastLog = t;
        if (t - shadow.lastLog >= 60.0) {
          this.log.info(`[CACHE-FIRST-SHADOW-AGG] LEVELS: ${shadow.misses} misses in last ${fmtFixed(t - shadow.lastLog, 0)}s (REST fallback active)`);
          shadow.misses = 0;
          shadow.lastLog = t;
        }
        this._perf.cache_first_shadow = (this._perf.cache_first_shadow || 0) + 1;
      }
      this._perf.api_calls += 1;
      this._perf.api_calls_total += 1;
      df = await this.fetcher.getCandles(symbol, tf, 300);
      if (df !== null && df !== undefined) await this.deps.cache.setCandles(symbol, tf, df, this.cfg.CACHE_TTL);
      return df;
    } finally {
      this._apiSem.release();
    }
  }

  /** _load_tf_candles(tf, coins): CHUNK_SIZE batches gathered, frames with < 50 bars dropped. */
  async _loadTfCandles(tf, coins) {
    const result = new Map();
    const chunk = this.cfg.CHUNK_SIZE;
    for (let i = 0; i < coins.length; i += chunk) {
      const batch = coins.slice(i, i + chunk);
      const dfs = await Promise.allSettled(batch.map((s) => this._fetch(s, tf)));
      batch.forEach((sym, k) => {
        const r = dfs[k];
        if (r.status !== 'fulfilled') return;
        const df = r.value;
        if (df === null || df === undefined || df.length < 50) return;
        result.set(sym, df);
      });
      await this.deps.sleep(this.cfg.CHUNK_SLEEP * 1000);
    }
    return result;
  }

  // ── one job ───────────────────────────────────────────────────────────────
  async _runJob(job, candles, token = null) {
    const { user, cfg } = job;
    const log = this.log;
    const ck = () => { if (token) token.check(); };
    let signals = 0;
    resetAnalyzeStats();   // [LEVELS-PROFILE] counts only this (uid, tf, dir)
    let scanned = 0;
    const rej = {
      min_volume: 0, stale: 0, analyze_none: 0,
      analyze_too_short: 0, analyze_cooldown: 0, analyze_no_pattern: 0,
      analyze_error: 0, analyze_timeout: 0, quality_low: 0,
      direction_mismatch: 0, counter_trend: 0,
      cross_dedup: 0, free_quota: 0, symbol_unavailable: 0,
    };

    // ШАГ 9: optimizer / Genome params BEFORE the indicator ([GENOME-AUTO-APPLY-FIX], regime-aware)
    optimizerParams.applyLevelsOptimizerParams(cfg, user, {
      store: this.deps.optimizerStore,
      getRegime: () => this.deps.regime.getCachedRegime(),
      log,
    });

    const ind = this._indicator(job);

    // BTC / ETH for the correlation, once per job
    let btcDf = candles.has(BTC) ? candles.get(BTC) : null;
    if (btcDf === null) { btcDf = await this._fetch(BTC, job.tf); ck(); }
    let ethDf = candles.has(ETH) ? candles.get(ETH) : null;
    if (ethDf === null) { ethDf = await this._fetch(ETH, job.tf); ck(); }

    // SPEEDUP #1: one gather for the HTF frames of every symbol
    const syms = Array.from(candles.keys());
    let htfMap = new Map();
    if (cfg.use_htf && syms.length) {
      const res = await Promise.allSettled(syms.map((s) => this._fetch(s, '1D')));
      ck();
      htfMap = new Map(syms.map((s, i) => [s, res[i].status === 'fulfilled' ? res[i].value : null]));
    }

    // FIX-B13 / PER-USER: the user's own min volume (not the merged cfg)
    const volMap = this.fetcher.volBySym || {};
    const userMinVol = Number(getattr(user, 'min_volume_usdt', 0) || 0);
    const hasVolMap = pyTruthy(volMap);

    const cfgRepr = JSON.stringify(ind.cfg);   // [ANALYZE-MEMO] once per job
    for (const [sym, df] of candles) {
      ck();
      scanned += 1;
      if (userMinVol > 0 && hasVolMap) {
        const symVol = own(volMap, sym) ? volMap[sym] : 0;
        if (symVol > 0 && symVol < userMinVol) {
          rej.min_volume += 1;
          continue;
        }
      }
      // AUDIT-FIX-C79 #3 + L2.1: TF-aware stale check on the last bar's open time
      const staleMax = staleThresholdS(job.tf);
      let lastTs = 0.0;
      if (df && df.length > 0) {
        lastTs = Number(df.t[df.length - 1]);
        if (lastTs > 1e12) lastTs /= 1000.0;
      }
      if (lastTs > 0 && this._now() - lastTs > staleMax) {
        log.debug(`LEVELS skip ${sym}: stale candles (age=${fmtFixed(this._now() - lastTs, 0)}s > tf=${job.tf} limit=${fmtFixed(staleMax, 0)}s)`);
        rej.stale += 1;
        continue;
      }
      const dfHtf = cfg.use_htf ? (htfMap.has(sym) ? htfMap.get(sym) : null) : null;

      // L2.5: pre-analyze gates (too short / cooldown) attributed to their own counters
      const emaSlowNeed = Math.trunc(Math.max(pyTruthy(ind.cfg.EMA_SLOW) ? ind.cfg.EMA_SLOW : 200, 100));
      const dfLen = df ? df.length : 0;
      if (dfLen < emaSlowNeed) {
        log.debug(`LEVELS skip ${sym}: len(df)=${dfLen} < need=${emaSlowNeed} (EMA_SLOW gate)`);
        rej.analyze_too_short += 1;
        rej.analyze_none += 1;
        continue;
      }
      try {
        const cooldownBars = Math.trunc(Number(ind.cfg.COOLDOWN_BARS || 0));
        const since = ind.barsSinceSignal(sym, df);
        if (since < cooldownBars) {
          log.debug(`LEVELS skip ${sym}: cooldown ${cooldownBars - since} bars left`);
          rej.analyze_cooldown += 1;
          rej.analyze_none += 1;
          continue;
        }
      } catch (e) {
        log.debug(`cooldown peek ${sym}: ${errMsg(e)}`);
      }

      let sig;
      try {
        // [ANALYZE-MEMO] key = symbol + TF + IndConfig + last bar (+ HTF last bar)
        const memo = this._anMemo;
        let mk = null;
        if (memo) {
          try {
            mk = JSON.stringify([sym, job.tf, cfgRepr, df.t[df.length - 1], df.length,
              dfHtf ? [dfHtf.t[dfHtf.length - 1], dfHtf.length] : null]);
          } catch (_e) {
            mk = null;
          }
        }
        let fut = mk !== null ? memo.get(mk) : undefined;
        const memoHit = fut !== undefined;
        if (!memoHit) {
          fut = this._startAnalysis(ind, sym, df, dfHtf, btcDf, ethDf);
          this._perf.analyze_runs = (this._perf.analyze_runs || 0) + 1;
          if (mk !== null) memo.set(mk, fut);
        } else {
          this._perf.analyze_memo_hits = (this._perf.analyze_memo_hits || 0) + 1;
        }
        if (fut.done) {
          if (fut.error) throw fut.error;
          sig = fut.value;
        } else {
          sig = await waitFor(fut.promise, ANALYZE_TIMEOUT_S, this.deps.timers);
          ck();
        }
        if (memoHit && sig) sig = deepCopySig(sig);   // the cooldown is set after delivery (mark_signal)
      } catch (e) {
        if (isCancelled(e)) throw e;
        if (e instanceof TimeoutError) {
          log.warning(`LEVELS analyze TIMEOUT (>10s): ${sym} — skipped`);
          rej.analyze_timeout += 1;
          continue;
        }
        log.debug(`${sym}: ${errMsg(e)}`);
        rej.analyze_error += 1;
        continue;
      }
      if (sig === null || sig === undefined) {
        log.debug(`LEVELS no_sig ${sym}: analyze returned None (no pattern)`);
        rej.analyze_no_pattern += 1;
        rej.analyze_none += 1;
        continue;
      }

      // [MTF-ALIGNED] +1 when BTC 15m/1H/4H agree (idempotent over the memo copies)
      try {
        this.deps.trend.applyMtfBonus(sig, 'quality', 10);
      } catch (e) {
        log.debug(`mtf bonus LEVELS ${sym}: ${errMsg(e)}`);
      }

      // [SQUEEZE] +1 out of a volatility squeeze, once (sig._sq_boosted)
      try {
        const sqScore = !getattr(sig, '_sq_boosted', false) ? computeSqueezeScore(df) : 0;
        if (sqScore >= 1) {
          sig._sq_boosted = true;
          const qBefore = Math.trunc(Number(getattr(sig, 'quality', 0) || 0));
          sig.quality = Math.min(qBefore + 1, 10);
          log.info(`[SQUEEZE-BOOST] LEVELS ${sym}: quality ${qBefore}→${pyD(sig.quality)} (sq=${pyD(sqScore)})`);
        }
      } catch (e) {
        log.debug(`squeeze boost LEVELS ${sym}: ${errMsg(e)}`);
      }

      // momentum relaxed mode lowers the quality floor
      let effMinQ;
      try {
        effMinQ = this.deps.momentum.relaxMinQuality(cfg.min_quality);
      } catch (_e) {
        log.error('scanner_mid._run_job() unhandled exception');
        effMinQ = cfg.min_quality;
      }
      if (sig.quality < effMinQ) {
        log.debug(`LEVELS reject ${sym}: quality=${pyS(sig.quality)} < min=${pyS(effMinQ)}`);
        rej.quality_low += 1;
        continue;
      }
      if (job.direction === 'LONG' && sig.direction !== 'LONG') {
        log.debug(`LEVELS reject ${sym}: direction mismatch ${sig.direction} vs ${job.direction}`);
        rej.direction_mismatch += 1;
        continue;
      }
      if (job.direction === 'SHORT' && sig.direction !== 'SHORT') {
        log.debug(`LEVELS reject ${sym}: direction mismatch ${sig.direction} vs ${job.direction}`);
        rej.direction_mismatch += 1;
        continue;
      }
      if (cfg.trend_only && sig.is_counter_trend) {
        log.debug(`LEVELS reject ${sym}: counter-trend filtered`);
        rej.counter_trend += 1;
        continue;
      }

      // [COIN-BLACKLIST] PF < 0.7 over ≥ 10 trades in 30 d → 14 d ban
      try {
        if (this.deps.coinQuality.isBlacklisted(sig.symbol, 'LEVELS')) {
          rej.coin_blacklisted = (rej.coin_blacklisted || 0) + 1;
          log.debug(`[COIN-BLACKLIST] skip ${sig.symbol} LEVELS uid=${user.user_id}`);
          continue;
        }
      } catch (e) {
        log.debug(`coin_quality check LEVELS: ${errMsg(e)}`);
      }

      // BTC / ETH correlation (not for BTC / ETH themselves)
      if (sym !== BTC && sym !== ETH) {
        if (btcDf !== null && btcDf !== undefined) sig.btc_corr = computeCorrelation(df, btcDf);
        if (ethDf !== null && ethDf !== undefined) sig.eth_corr = computeCorrelation(df, ethDf);
      }

      // FIX-B5 / [DEDUP-AFTER-SEND]: peek only; the slot is taken after delivery
      const reg = this.deps.registry;
      if (!reg.peekCanSend(user.user_id, sig.symbol, sig.direction)) {
        log.debug(`cross-dedup skip LEVELS ${sig.symbol} ${sig.direction} uid=${user.user_id}`);
        rej.cross_dedup += 1;
        continue;
      }
      if (!reg.peekCanSendMulti(user, sig.symbol, sig.direction)) {
        rej.cross_dedup += 1;
        continue;
      }
      reg.claimMulti(user, sig.symbol, sig.direction);   // [MULTI-CLAIM] ST-10

      // [CONFLUENCE] recorded before the remaining gates
      try {
        this.deps.confluence.recordSignal(sig.symbol, sig.direction, 'LEVELS', Math.trunc(Number(getattr(sig, 'quality', 0) || 0)));
      } catch (e) {
        log.debug(`confluence record LEVELS: ${errMsg(e)}`);
      }

      // FREE: permission only; the counter moves after a confirmed delivery
      let freeSignalPending = false;
      if (getattr(user, 'sub_plan', '') === 'free') {
        try {
          const fr = this.deps.freeReport;
          const canSendFree = await fr.shouldSendFreeSignal(user, sig.quality);
          ck();
          if (!canSendFree) {
            rej.free_quota += 1;
            fr.recordMissedSignal(user, sig.symbol, sig.direction, sig.quality, own(sig, 'rr') ? sig.rr : 0);
            await this.um.save(user);
            ck();
            continue;
          }
          freeSignalPending = true;
        } catch (e) {
          if (isCancelled(e)) throw e;
          log.debug(`free_filter: ${errMsg(e)}`);
        }
      }

      // [MARKETING-TIERS] long_only — inert while PLAN_FEATURES.*.long_only is False
      if (sig.direction === 'SHORT') {
        try {
          const PF = this.deps.planFeatures;
          const isAdminLo = Boolean(this.deps.isAdmin(user));
          const planLo = getattr(user, 'sub_plan', '') || 'free';
          const featLo = own(PF, planLo) ? PF[planLo] : PF.free;
          if (getattr(featLo, 'long_only', false) && !isAdminLo) {
            let bypass = false;
            if (planLo === 'free') {
              try {
                const nowH = new Date(Math.floor(this._now()) * 1000).getUTCHours();
                const mornE = getattr(featLo, 'signal_window_morning_utc', [6, 13])[1];
                const evenE = getattr(featLo, 'signal_window_evening_utc', [13, 21])[1];
                const mornUsed = Math.trunc(Number(getattr(user, 'free_signals_morning', 0) || 0));
                const evenUsed = Math.trunc(Number(getattr(user, 'free_signals_evening', 0) || 0));
                if (nowH >= mornE - 1 && nowH < mornE && mornUsed === 0) bypass = true;
                else if (nowH >= evenE - 1 && nowH < evenE && evenUsed === 0) bypass = true;
              } catch (e) {
                log.debug(`long_only bypass check uid=${user.user_id}: ${errMsg(e)}`);
              }
            }
            if (bypass) {
              log.info(`[GUARANTEED-DELIVERY] uid=${user.user_id} sym=${sig.symbol} long_only BYPASSED — last hour, quota=0`);
            } else {
              log.info(`[FILTER-BLOCK] uid=${user.user_id} sym=${sig.symbol} strategy=LEVELS gate=long_only_free reason='free tier = LONG-only' value=SHORT threshold=LONG`);
              rej.long_only_free = (rej.long_only_free || 0) + 1;
              continue;
            }
          }
        } catch (e) {
          log.debug(`long_only filter uid=${user.user_id}: ${errMsg(e)}`);
        }
      }

      // listed on the user's exchange (fail-open while the cache is empty)
      const exchange = getattr(user, 'trade_exchange', 'bybit');
      const exSym = this.deps.exchangeSymbols;
      if (exSym && !exSym.isAvailable(sig.symbol, exchange)) {
        log.debug(`skip ${sig.symbol}: not listed on ${exchange} (uid=${user.user_id})`);
        rej.symbol_unavailable += 1;
        continue;
      }

      log.info(`[TRACE-SCAN-LEVELS] uid=${user.user_id} sym=${sig.symbol} notify=${pyS(user.notify_signal)} exch=${pyS(getattr(user, 'trade_exchange', 'bybit'))}`);
      if (user.notify_signal) {
        const sentOk = await this._send(user, sig, cfg, token);
        if (sentOk) {
          reg.commitSend(user.user_id, sig.symbol, sig.direction);
          reg.commitSendMulti(user, sig.symbol, sig.direction);
          ind.markSignal(sym, df);
        }
        // [DELIVERY-CONFIRMED + PHANTOM-SIGNAL-FIX] the free counter moves only on a confirmed delivery
        if (freeSignalPending && sentOk) {
          try {
            this.deps.freeReport.recordFreeSignalSent(user);
            await this.um.save(user);
          } catch (e) {
            if (isCancelled(e)) throw e;
            log.debug(`record_free_signal_sent: ${errMsg(e)}`);
          }
        }
      }
      signals += 1;   // QUIRK(spec §2.1): counts the candidates past every gate, not the deliveries
    }

    this._perf.users += 1;
    let st;
    try { st = getAnalyzeStats(); } catch (_e) { st = new Map(); }
    const g = (k) => st.get(k) || 0;
    log.info(
      `[LEVELS-PROFILE] uid=${user.user_id} tf=${job.tf} dir=${job.direction} scanned=${scanned} signals=${signals} | `
      + `rej min_vol=${rej.min_volume} stale=${rej.stale} analyze_none=${rej.analyze_none} `
      + `(too_short=${rej.analyze_too_short} cooldown=${rej.analyze_cooldown} no_pattern=${rej.analyze_no_pattern}) `
      + `analyze_err=${rej.analyze_error} analyze_to=${rej.analyze_timeout} quality_low=${rej.quality_low} dir_mismatch=${rej.direction_mismatch} `
      + `counter_trend=${rej.counter_trend} cross_dedup=${rej.cross_dedup} free_quota=${rej.free_quota} sym_unavail=${rej.symbol_unavailable} `
      + `| stage zones=${g('zones')} volume=${g('volume')} signal=${g('signal')} rsi=${g('rsi')} sl_risk=${g('sl_risk')} rr=${g('rr')} `
      + `checklist=${g('checklist')} quality_hwr=${g('quality_hwr')} regime_filter=${g('levels_filter')} `
      + `| cfg min_quality=${cfgStr(cfg, 'min_quality')} min_rr=${cfgStr(cfg, 'min_rr')} trend_only=${cfgStr(cfg, 'trend_only')} use_htf=${cfgStr(cfg, 'use_htf')} `
      + `ema_slow=${cfgStr(cfg, 'ema_slow')} cooldown_bars=${cfgStr(cfg, 'cooldown_bars')}`,
    );

    // L2.7 [LEVELS-HINT]
    try {
      await this._maybeSendLevelsHint({ user, scanned, signals, stageStats: st });
    } catch (e) {
      log.debug(`levels hint uid=${user.user_id}: ${errMsg(e)}`);
    }
    return signals;
  }

  /** _maybe_send_levels_hint: ≥ 10 scanned, 0 signals, one stage ≥ 50 % of the rejects, 4 h throttle. */
  async _maybeSendLevelsHint({ user, scanned, signals, stageStats }) {
    if (signals > 0 || scanned < HINT_MIN_SCANNED) return;
    const vals = stageStats instanceof Map ? Array.from(stageStats.values()) : Object.values(stageStats || {});
    const totalRej = vals.length ? vals.reduce((a, b) => a + b, 0) : 0;
    if (totalRej <= 0) return;
    const [dominant, dominantCount] = dominantStage(stageStats);
    if (!dominant || dominantCount < totalRej * HINT_DOMINANT_RATIO) return;
    const nowTs = this._now();
    const lastTs = userHintLastTs.has(user.user_id) ? userHintLastTs.get(user.user_id) : 0.0;
    if (nowTs - lastTs < HINT_THROTTLE_S) return;
    const lang = getattr(user, 'lang', 'ru') || 'ru';
    const isFree = pyLower(String(getattr(user, 'sub_plan', '') || '')) === 'free';
    const kvCtx = { kv: this.deps.kv, now: () => this._now(), log: this.log };
    if (isFree) {
      try {
        const text = hintText('levels_hint_free_simple', lang);
        const relaxLabel = lang === 'en' ? '✨ Apply recommended' : '✨ Применить рекомендации';
        const kb = [[{ id: 'lvl_relax_apply', label: relaxLabel, action: 'lvl_relax_apply', kind: 'callback' }]];
        await this._safeSend(user.user_id, text, { parseMode: 'HTML', replyMarkup: kb });
        userHintLastTs.set(user.user_id, nowTs);
        await persistHintThrottle(kvCtx);
        this.log.info(`[LEVELS-HINT-FREE] uid=${user.user_id} stage=${dominant} ${dominantCount}/${totalRej} — relax CTA sent`);
      } catch (e) {
        this.log.debug(`[LEVELS-HINT-FREE] send uid=${user.user_id}: ${errMsg(e)}`);
      }
      return;
    }
    const key = own(HINT_I18N, dominant) ? HINT_I18N[dominant] : null;
    if (key === null) return;
    try {
      let shared = null;
      try { shared = tradeCfg.sharedCfg(user); } catch (_e) { shared = null; }
      const gs = (field, dflt) => (shared === null ? dflt : cfgStr(shared, field, dflt));
      const kwargs = {
        count: String(dominantCount), total: String(totalRej),
        cur_dist: gs('max_dist_pct', '1.5'), cur_pivot: gs('pivot_strength', '7'), cur_vol_mult: gs('vol_mult', '1.0'),
        cur_max_age: gs('max_level_age', '100'), cur_rsi_ob: gs('rsi_ob', '70'), cur_rsi_os: gs('rsi_os', '30'),
      };
      const text = hintText(key, lang, kwargs);
      await this._safeSend(user.user_id, text, { parseMode: 'HTML' });
      userHintLastTs.set(user.user_id, nowTs);
      await persistHintThrottle(kvCtx);
      this.log.info(`[LEVELS-HINT] uid=${user.user_id} stage=${dominant} ${dominantCount}/${totalRej} rejects — hint sent`);
    } catch (e) {
      this.log.debug(`[LEVELS-HINT] send uid=${user.user_id}: ${errMsg(e)}`);
    }
  }

  // ── delivery ──────────────────────────────────────────────────────────────
  /** FIX-B1 _resolve_tp: the structural TPs when ordered, else the mechanical R ladder of cfg. */
  static _resolveTp(sig, cfg, risk) {
    const sign = sig.direction === 'LONG' ? 1 : -1;
    const tp1Mech = sig.entry + sign * risk * cfg.tp1_rr;
    const tp2Mech = sig.entry + sign * risk * cfg.tp2_rr;
    const tp3Mech = sig.entry + sign * risk * cfg.tp3_rr;
    const structuralOk = sign === 1
      ? (sig.tp1 > sig.entry && sig.tp2 > sig.tp1 && sig.tp3 > sig.tp2)
      : (sig.tp1 < sig.entry && sig.tp2 < sig.tp1 && sig.tp3 < sig.tp2);
    if (structuralOk) return [sig.tp1, sig.tp2, sig.tp3];
    return [tp1Mech, tp2Mech, tp3Mech];
  }

  /** The cached exchange balance for the position line (3 s timeout, any error → null). */
  async _balanceFor(user) {
    const fn = this.deps.getBalance;
    if (typeof fn !== 'function') return null;
    try {
      const exchange = String(getattr(user, 'trade_exchange', 'bybit') || 'bybit');
      return await waitFor(Promise.resolve().then(() => fn(user, exchange)), 3.0, this.deps.timers);
    } catch (e) {
      this.log.debug(`[POSITION-SIZE] balance uid=${getattr(user, 'user_id', '?')}: ${errMsg(e)}`);
      return null;
    }
  }

  /** position_size.position_line(user, entry, sl, lang, ctx) — the balance is fetched only when the ctx multiplier is > 0. */
  async _positionLine(user, entry, sl, lang, ctx) {
    const trend = this.deps.trend;
    let needBalance = true;
    if (ctx) {
      try { needBalance = Number(trend.ctxRiskMult(ctx)) > 0; } catch (_e) { needBalance = true; }
    }
    const balance = needBalance ? await this._balanceFor(user) : null;
    return positionLine(user, entry, sl, lang, ctx, {
      balance, ctxRiskMult: (c) => trend.ctxRiskMult(c), ctxLabel: (c, l) => trend.ctxLabel(c, l),
    });
  }

  async _send(user, sig, cfg, token = null) {
    const log = this.log;
    const d = this.deps;
    let delivered = false;   // PHANTOM-SIGNAL-FIX: confirmed delivery only
    let rowAdded = false;    // [NOT-DELIVERED] the trades row is written
    let atResult = { executed: false, show_trade_btn: false, limit_msg: null };
    const tradeId = String(user.user_id) + '_' + String(Math.trunc(this._now() * 1000)) + '_' + String(d.random.randint(100, 999));
    const risk = Math.abs(sig.entry - sig.sl);
    const [tp1, tp2, tp3] = MidScanner._resolveTp(sig, cfg, risk);
    sig.tp1 = tp1; sig.tp2 = tp2; sig.tp3 = tp3;

    // [MOMENTUM-VETO] on the 15m cached frame; fail-open
    try {
      const mvDf = await d.cache.getCandles(sig.symbol, '15m');
      if (mvDf !== null && mvDf !== undefined) {
        const [veto, vetoReason] = d.veto.isMomentumVeto(mvDf, sig.direction);
        if (veto) {
          log.info(`[MOMENTUM-VETO] strategy=LEVELS uid=${user.user_id} sym=${sig.symbol} direction=${sig.direction} reason=${vetoReason}`);
          return false;
        }
      }
    } catch (e) {
      log.debug(`momentum_veto LEVELS uid=${user.user_id} sym=${sig.symbol}: ${errMsg(e)}`);
    }

    // [PHASE-12] freshness (price past SL / drift / past TP1 + tolerance → drop)
    try {
      const fresh = await d.freshness.isSignalFresh({
        symbol: sig.symbol, direction: sig.direction, entry: sig.entry, tp1,
        sl: Number(getattr(sig, 'sl', 0) || 0), strategy: 'LEVELS', uid: user.user_id,
      });
      if (!fresh) return false;
    } catch (e) {
      log.debug(`freshness check LEVELS uid=${user.user_id} sym=${sig.symbol}: ${errMsg(e)}`);
    }

    log.info(`[TRACE-DB-WRITE] LEVELS pre-add uid=${user.user_id} sym=${sig.symbol} tid=${tradeId}`);
    try {
      let orderLinkId;
      try {
        orderLinkId = computeClientOrderId(tradeId, user.user_id, getattr(user, 'trade_exchange', 'bybit'), 'entry');
      } catch (_e) {
        orderLinkId = '';
      }
      rowAdded = true;
      let isCounter = Boolean(getattr(sig, 'is_counter_trend', false));
      if (!isCounter) isCounter = Boolean(d.trend.isCounter(sig.direction, getattr(cfg, 'timeframe', '15m')));
      const nowTs = this._now();
      await d.repo.addTrade({
        trade_id: tradeId,
        user_id: user.user_id,
        symbol: sig.symbol,
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        original_sl: sig.sl,
        order_link_id: orderLinkId,
        tp1, tp2, tp3,
        tp1_rr: cfg.tp1_rr,
        tp2_rr: cfg.tp2_rr,
        tp3_rr: cfg.tp3_rr,
        quality: sig.quality,
        timeframe: cfg.timeframe,
        breakout_type: sig.breakout_type,
        created_at: nowTs,
        strategy: 'LEVELS',
        rsi: Number(getattr(sig, 'rsi', 50.0) || 50.0),
        volume_ratio: Number(getattr(sig, 'volume_ratio', 1.0) || 1.0),
        is_counter_trend: isCounter ? 1 : 0,
        mtf_aligned: getattr(sig, 'mtf_aligned', false) ? 1 : 0,
        trend_ctx: cpSlice(String(getattr(sig, 'trend_ctx', '') || ''), 16),
        btc_corr: Number(getattr(sig, 'btc_corr', 0.0) || 0.0),
        session: String(getattr(sig, 'session', '') || ''),
        preset_name: null,
        state: 'PENDING',
        state_changed_at: nowTs,
      });
      log.info(`[TRACE-DB-WRITE] LEVELS post-add OK uid=${user.user_id} sym=${sig.symbol} tid=${tradeId}`);
      try {
        d.emitEvent(tradeId, 'signal_generated', {
          strategy: 'LEVELS', user_id: user.user_id, symbol: sig.symbol, direction: sig.direction,
          entry: sig.entry, sl: sig.sl, tp1, quality: sig.quality, tf: cfg.timeframe,
          breakout_type: sig.breakout_type, is_counter_trend: Boolean(getattr(sig, 'is_counter_trend', false)),
        }, { floatKeys: ['entry', 'sl', 'tp1'] });
      } catch (_e) { /* best-effort */ }
    } catch (e) {
      log.error(`[TRACE-DB-WRITE] LEVELS FAILED uid=${user.user_id} sym=${sig.symbol} tid=${tradeId} err=${errMsg(e)}`);
      throw e;
    }

    await this._metric('signal_emitted', 1.0, {
      strategy: 'levels', symbol: sig.symbol, direction: sig.direction, exchange: getattr(user, 'trade_exchange', 'bybit'),
    });

    log.info(`[STALE-SIGNAL] strategy=LEVELS uid=${user.user_id} sym=${sig.symbol} dir=${sig.direction} tf=${pyS(getattr(user, 'timeframe', '?'))} signal_emit_ts=${Math.trunc(this._now())}`);

    // ── auto-trade ──
    const atEnabled = getattr(user, 'auto_trade', false);
    const autoTradeMode = getattr(user, 'auto_trade_mode', 'confirm');
    const exchange = getattr(user, 'trade_exchange', 'bybit');
    let keys = null;
    try { keys = d.getApiKeys(user, exchange); } catch (_e) { keys = null; }
    const apiKey = keys ? keys.apiKey || '' : '';
    const apiSecret = keys ? keys.apiSecret || '' : '';
    const riskPct = getattr(user, 'trade_risk_pct', 1.0);
    const leverage = Math.trunc(Number(getattr(user, 'trade_leverage', 10) || 10));
    let showTradeBtn = false;
    atResult = { executed: false, show_trade_btn: false, limit_msg: null };
    if (!atEnabled) log.debug(`[AT-SKIP] uid=${user.user_id} sym=${sig.symbol} reason=auto_trade_off exch=${exchange}`);
    else if (!(apiKey && apiSecret)) log.debug(`[AT-SKIP] uid=${user.user_id} sym=${sig.symbol} reason=no_api_keys exch=${exchange}`);
    if (atEnabled && apiKey && apiSecret) {
      // Stage 3A kill-switch: filters_all_off skips the scanner-level counter-trend check
      const ksBypass = Boolean(getattr(user, 'filters_all_off', false));
      const regime = d.regime.getCachedRegime();
      const isCounter = regime !== null && regime !== undefined && !regimeAllowsDirection(regime, sig.direction);
      const allowCounter = Boolean(getattr(user, 'allow_counter_trend', false));
      let minQForCounter;
      try {
        const raw = getattr(user, 'levels_counter_trend_min_quality', 4);
        minQForCounter = pyInt(pyTruthy(raw) ? raw : 4);   // QUIRK: `or 4` — a stored 0 reads as 4
      } catch (_e) {
        minQForCounter = 4;
      }
      minQForCounter = Math.max(0, Math.min(5, minQForCounter));
      const sigStars = levelsStars(sig.quality);   // [QUALITY-SCALE] threshold in stars
      if (!ksBypass && isCounter && (!allowCounter || sigStars < minQForCounter)) {
        log.info(`LEVELS AUTO-TRADE BLOCK uid=${user.user_id} sym=${sig.symbol}: counter-trend regime=${pyS(regime)} `
          + `quality=${pyD(sig.quality)} (${sigStars}⭐) allow=${pyS(allowCounter)} — требуется A/A+ (>=${minQForCounter}⭐)`);
        log.info(`[FILTER-BLOCK] uid=${user.user_id} sym=${sig.symbol} strategy=LEVELS gate=counter_trend_scanner `
          + `reason=${pyStrRepr(`regime=${pyS(regime)} quality=${pyS(sig.quality)} stars=${sigStars} allow=${pyS(allowCounter)}`)} `
          + `value=${sigStars} threshold=${minQForCounter}`);
        try {
          const symShort = sig.symbol.replace(/-USDT-SWAP/g, '').replace(/-USDT/g, '');
          const reason = !allowCounter
            ? '<i>Контр-тренд выключен. Включи в настройках «Контр-тренд (A+ only)» чтобы торговать против тренда.</i>'
            : `<i>Качество сигнала ${sigStars}/5 (${pyS(sig.quality)}/10) — для контр-тренда нужен A или A+ (≥${minQForCounter}/5).</i>`;
          await this._safeSend(user.user_id,
            '🚫 <b>Авто-трейд: сделка не открыта</b>\n'
            + `${escape(symShort)} ${sig.direction}\n`
            + `Режим рынка: <b>${pyS(regime)}</b> (контр-тренд)\n`
            + reason,
            { parseMode: 'HTML', siteType: 'trade' });
        } catch (e) {
          log.debug(`counter-trend notify uid=${user.user_id}: ${errMsg(e)}`);
        }
        atResult = { executed: false, show_trade_btn: false, limit_msg: null };
      } else {
        try {
          if (typeof d.executeAutoTrade !== 'function') throw new Error('execute_auto_trade is not wired');
          atResult = await d.executeAutoTrade({
            user_id: user.user_id,
            symbol: sig.symbol,
            direction: sig.direction,
            entry: sig.entry,
            sl: sig.sl,
            tp1, tp2, tp3,
            trade_id: tradeId,
            api_key: apiKey,
            api_secret: apiSecret,
            risk_pct: riskPct,
            leverage,
            auto_trade_mode: autoTradeMode,
            max_trades: getattr(user, 'max_trades_limit', 5),
            bot: this.bot,
            strategy: 'LEVELS',
            exchange,
            bybit_demo: Boolean(getattr(user, 'bybit_demo', false)),
            quality: Math.trunc(Number(getattr(sig, 'quality', 0) || 0)),
            trend_ctx: String(getattr(sig, 'trend_ctx', '') || ''),
          });
        } catch (e) {
          if (isCancelled(e)) throw e;
          log.error(`[TRACE-AT-FAIL] LEVELS callsite uid=${user.user_id} sym=${sig.symbol} err=${errMsg(e)}`);
          atResult = { executed: false, show_trade_btn: false, limit_msg: null };
        }
      }
      // QUIRK (spec autotrade §0.2): scanner_mid reads at_result["show_trade_btn"] / ["limit_msg"]
      // directly. The three gates that replace the result with {ok, executed, skip}
      // (hour_of_day_levels, min_quality, trending_only) make this a KeyError: it leaves _send
      // before the card, and the worker logs [WORKER-FAILED] for the rest of the (user, tf) job.
      showTradeBtn = pyIndex(atResult, 'show_trade_btn');
      if (pyIndex(atResult, 'limit_msg')) {
        try {
          await this._safeSend(user.user_id, atResult.limit_msg, { siteType: 'trade' });
        } catch (e) {
          log.warning(`[NOTIF-FAIL] silent exc scanner_mid.py:884: ${errMsg(e)}`);
        }
      }
    }

    const lang = getattr(user, 'lang', 'ru');
    let baseText = '';
    try {
      // [PHASE-3] lite vs full card
      if (getattr(user, 'signal_format', 'full') === 'lite') {
        baseText = lite.formatSignalLite({
          symbol: sig.symbol, direction: sig.direction, quality: sig.quality, entry: sig.entry, sl: sig.sl,
          tp1: sig.tp1, tp2: getattr(sig, 'tp2', null), tp3: getattr(sig, 'tp3', null),
          strategy: 'LEVELS', lang, qualityScale: 10,
        });
      } else {
        baseText = cardsLevels.signalText(sig, cfg, lang, { cardLine: (dir, tf, l) => d.trend.cardLine(dir, tf, l) });
      }
      // [POSITION-SIZE]
      try {
        const pl = await this._positionLine(user, sig.entry, sig.sl, lang, getattr(sig, 'trend_ctx', ''));
        if (pl) baseText += '\n' + pl;
      } catch (e) {
        log.debug(`position_line LEVELS uid=${user.user_id}: ${errMsg(e)}`);
      }
      if (this._fundBlock) baseText += cardsLevels.fundBlockSection(this._fundBlock, lang);
      const kb = keyboards.signalCompactKeyboard(tradeId, sig.symbol, {
        showTradeBtn, isCounterTrend: Boolean(getattr(sig, 'is_counter_trend', false)),
        isAutoTraded: Boolean(atResult.executed), lang,
      });
      const cardOk = await this._safeSend(user.user_id, wmInject(baseText, user.user_id), {
        parseMode: 'HTML',
        replyMarkup: kb,
        protectContent: true,
        onSent: d.rememberSignalMessage(tradeId),
        disableNotification: quietHours.isQuiet(user, this._now()),   // [QUIET-HOURS]
      });
      delivered = Boolean(cardOk);   // [NOT-DELIVERED]
      if (token) token.check();
      // [CHART-SENDER] fire-and-forget, df from the cache by the signal TF with fallbacks
      if (!getattr(user, 'send_chart_enabled', true)) {
        log.debug(`chart skip uid=${user.user_id} sym=${sig.symbol} — send_chart_enabled=False`);
      } else {
        try {
          const chartTf = getattr(cfg, 'timeframe', '15m') || '15m';
          let df = await d.cache.getCandles(sig.symbol, chartTf);
          if (!df || df.length < 30) df = await d.cache.getCandles(sig.symbol, '1H');
          if (!df || df.length < 30) df = await d.cache.getCandles(sig.symbol, '1h');
          if (!df || df.length < 30) df = await d.cache.getCandles(sig.symbol, '15m');
          if (!df || df.length < 30) {
            log.debug(`chart attach LEVELS: no df for ${sig.symbol}`);
          } else {
            // SignalResult has no key_levels / hvn_levels / lvn_levels → empty lists (like the bot)
            const pick = (k, n) => (pyTruthy(getattr(sig, k, null)) ? sig[k].slice(0, n).filter((l) => pyTruthy(l)).map(Number) : []);
            if (typeof d.sendChart === 'function') {
              d.sendChart(this.bot, user, sig, df, {
                strategy: 'LEVELS', lang, pivotLevels: pick('key_levels', 8), hvnLevels: pick('hvn_levels', 5), lvnLevels: pick('lvn_levels', 5),
              });
            }
          }
        } catch (e) {
          log.debug(`chart attach LEVELS uid=${user.user_id} sym=${sig.symbol}: ${errMsg(e)}`);
        }
      }
      // QUIRK(spec §2.1 step 23): bumped and saved even when the card was not delivered
      user.signals_received = Math.trunc(Number(user.signals_received || 0)) + 1;
      await this.um.save(user);
      this._perf.signals += 1;
      this._perf.signals_total += 1;
      const rrActual = sig.direction === 'LONG' ? (tp1 - sig.entry) / risk : (sig.entry - tp1) / risk;
      log.info(`✅ LEVELS ${sig.symbol} ${sig.direction} ⭐${pyS(sig.quality)}`
        + ` | entry=${fmtG(sig.entry, 6)} sl=${fmtG(sig.sl, 6)} tp1=${fmtG(tp1, 6)}`
        + ` | RR=${fmtFixed(rrActual, 2)} risk=${fmtFixed(sig.risk_pct, 2)}%`
        + ` → @${getattr(user, 'username', '') || user.user_id}`);
    } catch (e) {
      const name = e && e.name;
      if (name === 'TelegramRetryAfter') {
        log.warning(`Telegram flood control ${pyD(e.retry_after || 0)}s uid=${user.user_id}`);
        await d.sleep((Number(e.retry_after || 0) + 1) * 1000);
        try {
          const retryKb = keyboards.signalCompactKeyboard(tradeId, sig.symbol, {
            showTradeBtn, isCounterTrend: Boolean(getattr(sig, 'is_counter_trend', false)), lang,
          });
          await this._safeSend(user.user_id, wmInject(baseText, user.user_id), { parseMode: 'HTML', replyMarkup: retryKb });
          delivered = true;
        } catch (e2) {
          log.warning(`[NOTIF-FAIL] silent exc scanner_mid.py:936: ${errMsg(e2)}`);
        }
      } else if (name === 'TelegramNetworkError') {
        log.warning(`Telegram network timeout uid=${user.user_id}: ${errMsg(e)}`);
      } else if (isCancelled(e)) {
        // [NOT-DELIVERED] (ST-6) a cancelled worker must not leave a PENDING row
        if (rowAdded && !delivered && !atResult.executed) {
          try {
            await d.repo.setTradeResult(tradeId, 'SKIP', 0.0, { skipReason: 'not_delivered' });
          } catch (nd) {
            log.debug(`not_delivered SKIP (cancelled) tid=${tradeId}: ${errMsg(nd)}`);
          }
        }
        throw e;
      } else if (name === 'TelegramForbiddenError') {
        user.long_active = false;
        user.short_active = false;
        user.active = false;
        for (const dir of ['LONG', 'SHORT', 'BOTH']) this._lastScan.delete(`${user.user_id}_${dir}`);
        await this.um.save(user);
      } else {
        log.error(`scanner_mid._send uid=${user.user_id} failed`);
      }
    }
    if (rowAdded && !delivered && !atResult.executed) {
      // [NOT-DELIVERED] no card and no order — not a 6 h "open" row until ghost cleanup
      try {
        await d.repo.setTradeResult(tradeId, 'SKIP', 0.0, { skipReason: 'not_delivered' });
      } catch (nd) {
        log.debug(`not_delivered SKIP tid=${tradeId}: ${errMsg(nd)}`);
      }
    }
    return delivered;
  }

  // ── worker ────────────────────────────────────────────────────────────────
  async _worker(wid, candlesByTf, token) {
    for (;;) {
      let job;
      try {
        job = await this._queue.get(WORKER_IDLE_S, this.deps.timers, token);
      } catch (e) {
        if (e instanceof TimeoutError) break;
        throw e;   // CancelledError: the worker task ends
      }
      let jobStarted = false;   // AUDIT-FIX-C79 #6
      try {
        jobStarted = true;
        const candles = candlesByTf.has(job.tf) ? candlesByTf.get(job.tf) : new Map();
        await this._runJob(job, candles, token);
      } catch (e) {
        if (isCancelled(e)) {
          this.log.warning(`[WORKER-CANCELLED] wid=${wid} uid=${job.user ? job.user.user_id : 'None'} tf=${pyS(job.tf)} — task_done OK`);
          throw e;
        }
        this.log.error(`[WORKER-FAILED] wid=${wid} uid=${job.user ? job.user.user_id : '?'} tf=${pyS(job.tf)}: ${cpSlice(errMsg(e), 200)} — сигналы для этого (user,tf) пропущены в текущем цикле`);
        this._captureException(e);
      } finally {
        if (jobStarted) {
          try { this._queue.taskDone(); } catch (_e) { /* ValueError */ }
        }
      }
    }
  }

  // ── subscription expiry ───────────────────────────────────────────────────
  async _notifyExpired(user) {
    // free plan has no expiry — nothing to do (avoids the auto-downgrade flip-flop)
    if (pyLower(String(user.sub_plan || '')) === 'free') return;
    user.long_active = false;
    user.short_active = false;
    user.active = false;
    user.sub_status = 'expired';
    for (const dir of ['LONG', 'SHORT', 'BOTH']) this._lastScan.delete(`${user.user_id}_${dir}`);
    this.log.debug(`FIX-AUDIT-43: _last_scan очищен для uid=${user.user_id}`);
    if (user.expired_notified) {
      await this.um.save(user);
      return;
    }
    try {
      user.expired_notified = true;
      await this.um.save(user);
      const cfg = this.cfg;
      const text = '🚫 <b>Подписка истекла!</b>\n\n'
        + '⭐ <b>Pro — ' + cfg.PRICE_PRO + '/мес</b> (все функции)\n\n'
        + '💳 <b>Оплата подписки</b>\n\n'
        + '━━━━━━━━━━━━━━━━━━━━\n'
        + `🔗 <b>Сеть:</b> ${cfg.PAYMENT_NETWORK}\n\n`
        + '📋 <b>Адрес для перевода:</b>\n'
        + `<code>${cfg.PAYMENT_ADDRESS}</code>\n`
        + '━━━━━━━━━━━━━━━━━━━━\n\n'
        + '✅ После оплаты отправь скриншот + свой Telegram ID администратору:\n\n'
        + '🆔 <b>Твой ID:</b> <code>' + String(user.user_id) + '</code>';
      const kb = [[{ id: 'contact_admin', label: '✍️ Написать администратору ' + cfg.ADMIN_CONTACT, action: 'https://t.me/crypto_chm', kind: 'url' }]];
      await this._safeSend(user.user_id, text, { parseMode: 'HTML', replyMarkup: kb });
    } catch (e) {
      this.log.warning(`[NOTIF-FAIL] silent exc scanner_mid.py:1040: ${errMsg(e)}`);
    }
  }

  /** stop_event.is_set() — the scheduler's StopEvent (isSet() method) or an AbortSignal (aborted). */
  _stopped() {
    const ev = this._stopEvent;
    if (!ev) return false;
    if (ev.aborted) return true;
    return typeof ev.isSet === 'function' ? Boolean(ev.isSet()) : Boolean(ev.isSet);
  }

  /** _sub_check_loop: every 5 min, paid users whose sub_expires passed get the expiry notice. */
  async _subCheckLoop() {
    await this.deps.sleep(60 * 1000);
    while (!this._stopped()) {
      try {
        const now = this._now();
        const users = await this.um.allUsers();
        for (const user of users) {
          if (user.sub_status !== 'trial' && user.sub_status !== 'active') continue;
          if (pyLower(String(user.sub_plan || '')) === 'free') continue;
          const left = Number(user.sub_expires) - now;
          if (left <= 0 && !user.expired_notified) await this._notifyExpired(user);
        }
      } catch (e) {
        this.log.error(`_sub_check_loop: ${errMsg(e)}`);
        this._captureException(e);
      }
      if (this._stopped()) break;
      await this.deps.sleep(300 * 1000);
    }
  }

  // ── jobs ──────────────────────────────────────────────────────────────────
  /** _build_jobs(user, now, last_scan): LONG / SHORT / legacy BOTH jobs whose interval passed. */
  static _buildJobs(user, now, lastScan) {
    const jobs = [];
    const last = (k) => (lastScan.has(k) ? lastScan.get(k) : 0);
    if (user.long_active) {
      const cfg = tradeCfg.getLongCfg(user);
      if (now - last(String(user.user_id) + '_LONG') >= cfg.scan_interval) jobs.push(new ScanJob(user, 'LONG', cfg));
    }
    if (user.short_active) {
      const cfg = tradeCfg.getShortCfg(user);
      if (now - last(String(user.user_id) + '_SHORT') >= cfg.scan_interval) jobs.push(new ScanJob(user, 'SHORT', cfg));
    }
    if (user.active && user.scan_mode === 'both') {
      const cfg = tradeCfg.sharedCfg(user);
      if (now - last(String(user.user_id) + '_BOTH') >= cfg.scan_interval) jobs.push(new ScanJob(user, 'BOTH', cfg));
    }
    return jobs;
  }

  // ── the cycle ─────────────────────────────────────────────────────────────
  async _cycle(cycleToken = null) {
    const log = this.log;
    const ck = () => { if (cycleToken) cycleToken.check(); };
    const start = this._now();
    this._perf.api_calls = 0;
    this._perf.signals = 0;
    this._perf.users = 0;
    this._anMemo = new Map();   // [ANALYZE-MEMO] one analysis per symbol / TF / IndConfig / bar per cycle
    this._perf.analyze_runs = 0;
    this._perf.analyze_memo_hits = 0;
    await this._updateTrendIfNeeded();
    ck();

    if (this.deps.fundamental) {
      try {
        this._fundBlock = await this.deps.fundamental.getMarketContextBlock();
      } catch (e) {
        log.debug('fundamental: ' + errMsg(e));
      }
      ck();
    }

    const tUsers0 = this._now();
    const users = await this.um.getActiveUsers();
    ck();
    const tUsers = this._now() - tUsers0;
    if (!pyTruthy(users)) return;
    const now = this._now();

    const allJobs = [];
    for (const u of users) {
      const [has] = this.deps.checkAccess(u);
      if (!has) {
        await this._notifyExpired(u);
        continue;
      }
      // [FINAL-CLOSURE-SCANNER-OWNERSHIP] / [MULTI-STRATEGY]: LEVELS primary or extra
      if (!this.deps.strategyEnabled(u, 'LEVELS')) continue;

      // L1.1 [LEVELS-BACKFILL]: strategy LEVELS with both directions off → enable both, notify once
      if (u.strategy === 'LEVELS' && !getattr(u, 'long_active', false) && !getattr(u, 'short_active', false)) {
        u.long_active = true;
        u.short_active = true;
        try {
          await this.um.save(u);
          log.info(`[LEVELS-BACKFILL] uid=${u.user_id}: enabled both LONG+SHORT (was silent — strategy=LEVELS but both off)`);
          try {
            const langBf = getattr(u, 'lang', 'ru') || 'ru';
            const symOk = '✅';
            const msgRu = 'ℹ️ <b>Авто-восстановление настроек LEVELS</b>\n\n'
              + 'У тебя была выбрана стратегия <b>LEVELS</b>, но оба '
              + 'направления (LONG и SHORT) были выключены — '
              + 'поэтому сигналы не приходили.\n\n'
              + `${symOk} Мы включили оба направления, чтобы `
              + 'сканер начал работать. В '
              + '<b>/settings → Торговля</b> можно оставить только '
              + 'нужное направление.';
            const msgEn = 'ℹ️ <b>LEVELS settings auto-repair</b>\n\n'
              + 'You had <b>LEVELS</b> strategy selected, but both '
              + 'LONG and SHORT directions were disabled — so no '
              + 'signals could be generated.\n\n'
              + `${symOk} We enabled both directions so the `
              + 'scanner can start working. You can disable either '
              + 'via <b>/settings → Trading</b>.';
            await this._safeSend(u.user_id, langBf === 'en' ? msgEn : msgRu, { parseMode: 'HTML' });
          } catch (e) {
            log.debug(`[LEVELS-BACKFILL] notify uid=${u.user_id}: ${errMsg(e)}`);
          }
        } catch (e) {
          log.warning(`[LEVELS-BACKFILL] uid=${u.user_id} save failed: ${errMsg(e)}`);
          u.long_active = false;
          u.short_active = false;
        }
      }
      allJobs.push(...MidScanner._buildJobs(u, now, this._lastScan));
    }
    ck();
    if (!allJobs.length) return;

    log.info('🔍 Цикл #' + String(this._perf.cycles + 1) + ': ' + String(allJobs.length) + ' заданий (' + String(users.length) + ' юзеров)');

    // jobs grouped by TF (insertion order)
    const tfGroups = new Map();
    for (const job of allJobs) {
      if (!tfGroups.has(job.tf)) tfGroups.set(job.tf, []);
      tfGroups.get(job.tf).push(job);
    }

    let coins = await this._loadCoins(0);
    ck();
    coins = this._applyVolFilter(coins, allJobs);

    const tCandles0 = this._now();
    const candlesByTf = new Map();
    for (const [tf, tfJobs] of tfGroups) {
      const t0 = this._now();
      candlesByTf.set(tf, await this._loadTfCandles(tf, coins));
      ck();
      log.info(`  📥 TF=${tf}: ${coins.length} монет для ${tfJobs.length} заданий (${fmtFixed(this._now() - t0, 1)}с)`);
    }
    const tCandles = this._now() - tCandles0;

    for (const job of allJobs) {
      this._lastScan.set(job.jobKey, now);
      this._queue.put(job);
    }

    // [SIGNAL-DELIVERY P1.2] N queue workers (Config.SCAN_WORKERS)
    const n = Math.min(this.cfg.SCAN_WORKERS, this._queue.qsize());
    if (n === 0) return;
    const tWorkers0 = this._now();
    const workerToken = new CancelToken();
    if (cycleToken) cycleToken.on(() => workerToken.cancel());
    const workers = [];
    for (let i = 0; i < n; i++) workers.push(this._worker(i, candlesByTf, workerToken).catch(() => {}));
    try {
      await waitFor(this._queue.join(), QUEUE_JOIN_TIMEOUT_S, this.deps.timers);
    } catch (e) {
      if (!(e instanceof TimeoutError)) throw e;
      log.warning('Scanner workers TIMEOUT (>120s) — cancelling remaining tasks');
    }
    workerToken.cancel();
    // [QUEUE-DRAIN] (ST-6) stale jobs left after a timeout are dropped, not run next cycle
    let dropped = 0;
    while (!this._queue.empty()) {
      try {
        this._queue.getNowait();
        this._queue.taskDone();
        dropped += 1;
      } catch (_e) {
        break;
      }
    }
    if (dropped) log.warning(`[QUEUE-DRAIN] dropped ${dropped} stale scan jobs after worker timeout`);
    const tWorkers = this._now() - tWorkers0;

    const elapsed = this._now() - start;
    // [FRESHNESS-CYCLE-REPORT] the freshness tolerance follows the real cycle time
    try {
      this.deps.freshness.reportCycleTime('LEVELS', Number(elapsed));
    } catch (e) {
      log.debug(`report_cycle_time LEVELS: ${errMsg(e)}`);
    }
    const cs = await this.deps.cache.cacheStats();
    this._perf.cycles += 1;
    // FIX-AUDIT-43: every 100 cycles drop _last_scan keys of users no longer active
    this._cycleCount += 1;
    if (this._cycleCount % 100 === 0) {
      let staleKeys = [];
      try {
        const active = new Set((await this.um.getActiveUsers()).map((u) => String(u.user_id)));
        staleKeys = Array.from(this._lastScan.keys()).filter((k) => !active.has(k.split('_')[0]));
        for (const k of staleKeys) this._lastScan.delete(k);
      } catch (e) {
        log.debug(`_last_scan GC error: ${errMsg(e)}`);
        staleKeys = [];
      }
      if (staleKeys.length) log.debug(`FIX-AUDIT-43: _last_scan GC удалил ${staleKeys.length} устаревших записей`);
    }
    const hits = Number(cs.hits || 0);
    const total = hits + Number(cs.misses || 0);
    const ratio = total ? pyRound(hits / total * 100, 1) : (cs.ratio === undefined ? 0.0 : cs.ratio);
    log.info(
      `  ✅ ${fmtFixed(elapsed, 1)}с | Сигналов: ${this._perf.signals} | API/cycle: ${this._perf.api_calls} (total: ${this._perf.api_calls_total || 0}) | `
      + `Кэш: ${pyD(cs.size || 0)}/${pyD(cs.max_size || 0)} keys, ${fmtFixed(ratio, 1)}% hit, evictions=${pyD(cs.evictions || 0)} | `
      + `analyze: ${this._perf.analyze_runs || 0} run, ${this._perf.analyze_memo_hits || 0} memo`,
    );
    log.debug(`  ⏱  cycle ${fmtFixed(elapsed, 1)}с: users=${fmtFixed(tUsers, 2)}с candles=${fmtFixed(tCandles, 1)}с workers=${fmtFixed(tWorkers, 1)}с`);
    void workers;
  }

  async _scanLoop() {
    // int(os.getenv("LEVELS_CYCLE_TIMEOUT_S", "480") or 480): "" → 480, "0" → 0 (every cycle
    // times out), a non-integer raises out of the loop like the bot's ValueError
    const raw = this.deps.env.LEVELS_CYCLE_TIMEOUT_S;
    const cycleTimeoutS = pyInt(raw === undefined ? '480' : (raw === '' ? 480 : raw));
    while (!this._stopped()) {
      const t0 = this._now();
      const mono0 = this.deps.clock.monotonic();
      const token = new CancelToken();
      this._cycleToken = token;
      if (this._stopped()) token.cancel();
      const cyc = this._cycle(token);
      try {
        // [LEVELS-CYCLE-TIMEOUT] a hung cycle is cancelled and the next one starts
        await waitFor(cyc, cycleTimeoutS, this.deps.timers);
      } catch (e) {
        // CancelledError is a BaseException: `except Exception` does not catch it (shutdown)
        if (isCancelled(e) && this._stopped()) throw e;
        if (e instanceof TimeoutError) {
          token.cancel();
          await cyc.catch(() => {});
          this.log.error(`[LEVELS-CYCLE-TIMEOUT] цикл не уложился в ${cycleTimeoutS}s — прерван (users=${pyS(this._perf.users)} api_calls=${pyS(this._perf.api_calls)})`);
        } else {
          this.log.error('Ошибка цикла: ' + errMsg(e));
          this._captureException(e);
        }
      }
      if (this._health) this._health.heartbeat('LEVELS');
      await this._metric('cycle_duration', (this.deps.clock.monotonic() - mono0) * 1000.0, { scanner: 'levels' });
      try {
        this.deps.freshness.reportCycleTime('LEVELS', this.deps.clock.monotonic() - mono0);
      } catch (e) {
        this.log.debug(`freshness report LEVELS: ${errMsg(e)}`);
      }
      const elapsed = this._now() - t0;
      if (elapsed > 120) {
        this.log.warning(`[LEVELS-CYCLE-SLOW] цикл ${fmtFixed(elapsed, 0)}s (users=${pyS(this._perf.users)} api_calls=${pyS(this._perf.api_calls)})`);
      }
      const sleepS = Math.max(0.0, this.cfg.SCAN_LOOP_SLEEP - elapsed);
      if (sleepS < 5) this.log.debug(`scan_loop: цикл занял ${fmtFixed(elapsed, 1)}с, пауза ${fmtFixed(sleepS, 1)}с`);
      if (this._stopped()) break;
      await this.deps.sleep(sleepS * 1000);
    }
  }

  /**
   * _be_monitor_loop: the BE monitor (scanner_mid._check_breakevens, trade-ops M15) runs from
   * `deps.beMonitorLoop(scanner, {restoreHintThrottle})`: its prologue restores the cooldown maps and then
   * this scanner's levels-hint throttle inside ONE try (scanner_mid.py [BE-MONITOR-RESTORE-GUARD], INF-Q-I1),
   * so the hook gets the throttle restore to call. Unwired (no M15 BE monitor): the throttle restore alone.
   */
  async _beMonitorLoop() {
    const restoreHints = () => restoreHintThrottle({ kv: this.deps.kv, now: () => this._now(), log: this.log });
    if (typeof this.deps.beMonitorLoop === 'function') {
      await this.deps.beMonitorLoop(this, { restoreHintThrottle: restoreHints });
      return;
    }
    try {
      await restoreHints();
    } catch (e) {
      this.log.warning(`[BE-MONITOR-RESTORE-GUARD] restore failed (continuing with fresh state): ${errMsg(e)}`);
    }
  }

  // ── WS bar close ──────────────────────────────────────────────────────────
  /** L3.6B: a closed WS bar resets _last_scan of the jobs on that TF (the next tick scans them). */
  async _onWsBarClose(instId, tfNorm) {
    const tfWant = pyLower(String(tfNorm || ''));
    if (!tfWant) return;
    let users;
    try {
      users = await this.um.getActiveUsers();
    } catch (e) {
      this.log.debug(`_on_ws_bar_close get_active_users: ${errMsg(e)}`);
      return;
    }
    let cleared = 0;
    for (const u of users) {
      if (!this.deps.strategyEnabled(u, 'LEVELS')) continue;
      for (const [dirName, cfgFn] of [['LONG', tradeCfg.getLongCfg], ['SHORT', tradeCfg.getShortCfg], ['BOTH', tradeCfg.sharedCfg]]) {
        let tf;
        try {
          const c = cfgFn(u);
          tf = pyLower(String(getattr(c, 'timeframe', '') || ''));
        } catch (_e) {
          continue;
        }
        if (tf === tfWant) {
          const key = String(u.user_id) + '_' + dirName;
          if (this._lastScan.has(key)) {
            this._lastScan.set(key, 0.0);
            cleared += 1;
          }
        }
      }
    }
    if (cleared) {
      const nowLog = this._now();
      const key = `ws_trig_last_${tfNorm}`;
      if (nowLog - (this._wsTrigLast.has(key) ? this._wsTrigLast.get(key) : 0.0) > 300) {
        this._wsTrigLast.set(key, nowLog);
        this.log.info(`[WS-TRIGGER] bar_close ${instId}/${tfNorm} → reset ${cleared} last_scan keys (throttled 1/5min)`);
      } else {
        this.log.debug(`[WS-TRIGGER] bar_close ${instId}/${tfNorm} → reset ${cleared} last_scan keys`);
      }
    }
  }

  async runForever() {
    this.log.info('🚀 MidScanner v4 | Воркеров: ' + String(this.cfg.SCAN_WORKERS) + ' | API: ' + String(this.cfg.API_CONCURRENCY));
    try {
      if (!this.deps.wsFeed) throw new Error('ws_feed is not wired');
      this.deps.wsFeed.registerOnBarClose(this._onWsBarCloseCb);
      this.log.info('[WS-TRIGGER] registered bar-close callback for LEVELS scanner');
    } catch (e) {
      this.log.debug(`ws_feed register_on_bar_close: ${errMsg(e)}`);
    }
    try {
      this._warmupCache().catch(() => {});
    } catch (e) {
      this.log.debug(`warmup schedule: ${errMsg(e)}`);
    }
    // [SCANNER-RESILIENCE] plain gather: one loop dying propagates to the supervisor.
    // [BE-SINGLE-LOOP 2026-10] one BE monitor per scanner instance: the gather does not stop the other
    // loops when one dies and the supervisor (_guarded_restart) calls runForever() again on THIS instance,
    // so a BE loop still running is reused (never aborted: a cancel mid-pass could fall between an exchange
    // call and its DB write; the engine shutdown abort still reaches it); a finished / crashed one is
    // started again. Start order unchanged: scan → sub → BE. `settled` is set by then(mark, mark) attached
    // before the gather — the derived promise always fulfils (no unhandled rejection), and the mark runs
    // before the gather rejects on a BE crash.
    const scan = this._scanLoop();
    const sub = this._subCheckLoop();
    let be = this._beMonitorTask;
    if (!be || be.settled) {
      const t = { promise: this._beMonitorLoop(), settled: false };
      const mark = () => { t.settled = true; };
      t.promise.then(mark, mark);
      this._beMonitorTask = t;
      be = t;
    } else {
      this.log.info('[BE-SINGLE-LOOP] BE monitor still running — second loop not started');
    }
    await Promise.all([scan, sub, be.promise]);
  }

  /**
   * _warmup_cache: top-30 coins (≥ $5M) × 15m / 1h / 4h. QUIRK: the candle_store branch calls
   * `cache.set_candles(sym, tf, df)` without the TTL map — a TypeError swallowed per coin — so
   * nothing is ever counted from the store and the REST fallback always runs.
   */
  async _warmupCache() {
    try {
      await this.deps.sleep(8000);
      // a shutdown during the delay: the bot's CancelledError ends the task silently
      if (this._stopped()) return;
      this.log.info('🔥 Scanner warmup: загружаю top-30 монет × 3 TF в кэш...');
      const t0 = this._now();
      const coins = await waitFor(this.fetcher.getAllUsdtPairs(5_000_000, this.cfg.AUTO_BLACKLIST), 30.0, this.deps.timers);
      if (!pyTruthy(coins)) return;
      const top = coins.slice(0, 30);
      const tfs = ['15m', '1h', '4h'];
      const loadedFromStore = 0;   // QUIRK: never incremented — see the TypeError below
      const store = this.deps.candleStore;
      if (store && store.ensureCandles && store.HistoryLoader) {
        const loader = new store.HistoryLoader();
        try {
          for (const tf of tfs) {
            for (const sym of top) {
              try {
                const df = await store.ensureCandles(sym, tf, 7, loader);
                if (df && df.length >= 50) {
                  throw new TypeError("set_candles() missing 1 required positional argument: 'ttl_map'");
                }
              } catch (e) {
                this.log.debug(`silent exc scanner_mid.py:2487: ${errMsg(e)}`);
              }
            }
          }
        } finally {
          try { if (loader.close) await loader.close(); } catch (_e) { /* close */ }
        }
      }
      const totalExpected = top.length * tfs.length;
      if (loadedFromStore < totalExpected * 0.5) {
        this.log.info(`🔥 Scanner warmup: candle_store=${loadedFromStore}/${totalExpected}, fallback на OKX...`);
        await Promise.allSettled(tfs.map((tf) => this._loadTfCandles(tf, top)));
      } else {
        this.log.info(`🔥 Scanner warmup: ${loadedFromStore}/${totalExpected} из candle_store (0 HTTP)`);
      }
      const elapsed = this._now() - t0;
      this.log.info(`🔥 Scanner warmup done in ${fmtFixed(elapsed, 1)}s: ${top.length} coins × ${tfs.length} TFs loaded`);
    } catch (e) {
      this.log.warning(`warmup failed: ${errMsg(e)}`);
    }
  }

  getPerf() {
    return { ...this._perf, cache: this.deps.cache.cacheStats() };
  }

  // ── on demand ─────────────────────────────────────────────────────────────
  /** analyze_on_demand(symbol, cfg) → [SignalResult, card text] | null (fresh indicator, no HIGH-WR, ru card). */
  async analyzeOnDemand(symbol, cfg) {
    let sym = pyStrip(pyUpper(String(symbol)));
    if (!sym.endsWith('-SWAP')) {
      if (sym.endsWith('-USDT')) sym += '-SWAP';
      else if (sym.endsWith('USDT')) sym = sym.slice(0, -4) + '-USDT-SWAP';
      else sym += '-USDT-SWAP';
    }
    const tf = cfg.timeframe;
    const df = await this.fetcher.getCandles(sym, tf, 300);
    if (!df || df.length < 50) {
      this.log.debug(`analyze_on_demand ${sym}: not enough candles (${df ? df.length : 0})`);
      return null;
    }
    const ind = levels.createIndicator(cfgToInd(cfg, false, this.cfg.LEVELS_MIN_RR), { clock: () => this._now() });
    let dfHtf = null;
    if (cfg.use_htf) dfHtf = await this.fetcher.getCandles(sym, '1D', 100);
    let sig;
    try {
      const fut = this._startAnalysis(ind, sym, df, dfHtf, null, null);
      if (fut.done) {
        if (fut.error) throw fut.error;
        sig = fut.value;
      } else {
        sig = await waitFor(fut.promise, ANALYZE_TIMEOUT_S, this.deps.timers);
      }
    } catch (e) {
      if (e instanceof TimeoutError) {
        this.log.warning(`analyze_on_demand TIMEOUT (>10s): ${sym} — skipped`);
        return null;
      }
      this.log.warning(`analyze_on_demand ${sym}: ${errMsg(e)}`);
      return null;
    }
    if (!sig) {
      this.log.debug(`analyze_on_demand ${sym}: analyze returned None`);
      return null;
    }
    if (sym !== BTC && sym !== ETH) {
      const btcDf = await this.fetcher.getCandles(BTC, tf, 60);
      const ethDf = await this.fetcher.getCandles(ETH, tf, 60);
      if (btcDf) sig.btc_corr = computeCorrelation(df, btcDf);
      if (ethDf) sig.eth_corr = computeCorrelation(df, ethDf);
    }
    const text = cardsLevels.signalText(sig, cfg, 'ru', { cardLine: (dir, t, l) => this.deps.trend.cardLine(dir, t, l) });
    return [sig, text];
  }

  async analyzeOnDemandLang(symbol, cfg, lang = 'ru') {
    const result = await this.analyzeOnDemand(symbol, cfg);
    if (result === null) return null;
    const [sig] = result;
    return [sig, cardsLevels.signalText(sig, cfg, lang, { cardLine: (dir, t, l) => this.deps.trend.cardLine(dir, t, l) })];
  }
}

/** scanner_mid.signal_text(sig, cfg, lang) (cards/levels with the live trend line). */
function signalText(sig, cfg, lang = 'ru', opts = {}) {
  return cardsLevels.signalText(sig, cfg, lang, opts);
}

module.exports = {
  CACHE_TTL, AUTO_BLACKLIST, DEFAULT_CONFIG, TF_DURATION_S, STALE_GRACE_S,
  HINT_MIN_SCANNED, HINT_DOMINANT_RATIO, HINT_THROTTLE_S, KV_HINT_LAST_TS, HINT_MESSAGES, HINT_I18N,
  ANALYZE_TIMEOUT_S, QUEUE_JOIN_TIMEOUT_S,
  ScanJob, MidScanner, CancelledError, TimeoutError, CancelToken, AsyncQueue, Semaphore, waitFor,
  safeSendMessage, splitForTelegram, cpSlice, cpLen, computeCorrelation, computeCorrelationBatch, staleThresholdS, dominantStage,
  cfgToInd, hintText, signalText, getAnalyzeStats, resetAnalyzeStats, restoreHintThrottle, persistHintThrottle,
  signalCompactKeyboard: keyboards.signalCompactKeyboard, tradeRecordsKeyboard: keyboards.tradeRecordsKeyboard,
  tvUrl: keyboards.tvUrl, corrLabel: cardsLevels.corrLabel,
  _userHintLastTs: userHintLastTs, _ANALYZE_STATS: ANALYZE_STATS, _shadow: shadow,
  _resetModuleStateForTests() {
    userHintLastTs.clear();
    ANALYZE_STATS.clear();
    shadow.misses = 0;
    shadow.lastLog = 0.0;
  },
};
