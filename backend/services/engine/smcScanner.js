'use strict';
/**
 * smcScanner — the bot's smc/scanner.py one-to-one (strategy-smc.md §6, signal-pipeline.md §2.2).
 *
 * Per cycle: active users → SMC users (strategy enabled + can("smc") + a direction on, OR any
 * free user whose daily preview quota is not exhausted) → per-user scan_interval gate → coin
 * universe (candle cache coins / REST pairs, apply_vol_filter floor 200 K, cap 300) → per TF
 * group (`_SMC_TF_MAP`) fetch HTF/MTF/LTF under a Semaphore(16) with a 90 s ceiling →
 * per symbol, per user: shared analysis per `_analysis_key`, volume gate, build_smc_signal,
 * BTC trend bonus, [SMC-CTX-GATE], direction / toggles / optimizer filters, symbol listing,
 * blacklist, momentum veto, freshness → the free "Pro preview" branch (never a row, never a
 * registry slot) → registry peek + MULTI claim → confluence → signal_trades row → the card
 * text → `_send_smc_card_bg` in the background under a Semaphore(_SEND_CONCURRENCY = 12; the
 * bot comment still says 8 — the constant is 12 since [SMC-CONCURRENCY-BUMP]) which runs the
 * scanner-level counter-trend gate + auto-trade, then delivers the card, commits the registry
 * slot after a delivery or an executed trade, and marks an undelivered, untraded row SKIP
 * (`not_delivered`).
 *
 * Site mapping of the Telegram side:
 *   safe_send_message(...)            → deps.deliver({kind, type, userId, text, keyboard, silent,
 *                                       protect, tradeId, strategy, lang, ...}) → Promise<bool>
 *                                       (signalDelivery.js: notifications row, SSE, signal_msg_id)
 *   on_sent=remember_signal_message   → done by the delivery side (signal_msg_id = notification id)
 *   send_signal_chart_bg              → deps.deliverChart({...}) — chart descriptor (D3)
 *   smart_prompts.trigger_after_quota_hit → deps.smartPromptQuota(uid) (M17b; default no-op)
 *   fundamental.get_market_context_block   → deps.fundBlock() (not ported: network; default '' =
 *                                       the bot when alternative.me / CoinGecko are unreachable)
 *   execute_auto_trade                → deps.executeAutoTrade(params) (M13b); the API keys come from
 *                                       deps.userApiKeys(user, exchange) — default: none, so neither
 *                                       the counter-trend notice nor a trade happens (= a bot user
 *                                       without keys) until the auto-trade orchestration is wired.
 *
 * Quirks kept (pinned in tests/engine/scanners/smcScanner.*.test.js):
 *   • every free user (even LEVELS-only) is an SMC user while the preview quota is left;
 *   • the per-user interval gate stamps _SMC_LAST_SCAN before anything else;
 *   • `smc_counter_trend_min_quality or 4` — 0 reads as 4;
 *   • the trade_events payload `is_counter_trend` is getattr(sig, …) → always false;
 *   • "SMC ✅ …" is logged and the chart is attempted even when the card was not delivered;
 *   • `_ws_trig_ts` is never reset (the delay line repeats within 60 s of the last trigger);
 *   • a db_add_trade failure aborts the whole cycle (`raise`).
 *
 * Markers: [SMC-VOL-GATE] [SMC-VOL-GATE-SUMMARY] [SMC-CTX-GATE] [SQUEEZE-BOOST] [SYMBOL-FILTER]
 * [MOMENTUM-VETO] [FREE-UX] [TRACE-DB-WRITE] [STALE-SIGNAL] [SIGNAL-DELTA-MS] [CONFLUENCE]
 * [REVERSAL-OVERRIDE] [FILTER-BLOCK] [SMC-PROFILE] [SMC-PROFILE-DOMINANT(-WARN)] [SMC-CACHE]
 * [SMC-GATHER-TIMEOUT] [WS-TRIGGER] [WS-BARCLOSE-TO-SCAN-DELAY-MS] [CACHE-FIRST-SHADOW-AGG].
 */

const { fmtFixed, fmtG, pyRepr } = require('../../strategies/common/pyfmt');
const { pyTruthy } = require('../../strategies/common/pyval');
const { utcDate } = require('../../strategies/common/pytime');
const { pyStrRepr, pyLower, pyUpper } = require('../../strategies/common/pyUnicode');
const { pyInt, pyFloat } = require('./pycoerce');
const { log: defaultLog } = require('../marketData/mdLog');

// ── constants (smc/scanner.py module level) ──────────────────────────────
// Таймфреймы для SMC (HTF→MTF→LTF)
const SMC_TF_MAP = Object.freeze({
  '4H': Object.freeze(['1D', '4H', '1H']),
  '1H': Object.freeze(['4H', '1H', '15m']),
  // [NO-5M] младший ТФ 15m-группы = 15m
  '15m': Object.freeze(['1H', '15m', '15m']),
});
const SMC_ANALYZERS_MAX = 64;
const OKX_SEM_SIZE = 16;               // _get_okx_sem(): Semaphore(16)
const HTF_TTL_S = 3600.0;
const MTF_TTL_S = 0.0;                 // [MTF-FRESH] — MTF всегда свежий
const LTF_TTL_S = 0.0;
const TF_CACHE_MAX = 1200;
const SEND_CONCURRENCY = 12;           // [SMC-CONCURRENCY-BUMP] was 8
const REVERSAL_OVERRIDE_MIN = 3;
const SMC_FLOOR = 200_000;             // [LOW-VOL] floor 500K$ → 200K$
const SMC_CAP = 300;
const VOL_GATE_LOG_CAP = 5;
const GATHER_TIMEOUT_S = 90.0;         // [SMC-GATHER-TIMEOUT]
const DEFAULT_INTERVAL_S = 300;

const own = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
/** getattr(o, k, d) on a plain object */
const ga = (o, k, d) => (own(o, k) && o[k] !== undefined ? o[k] : d);
/** str() of a value as `%s` prints it */
function pyS(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) < 1e16 ? String(v) : pyRepr(v);
  return String(v);
}
/** `%d` of a number */
const pyD = (v) => String(Math.trunc(Number(v)));
const nowSec = () => Date.now() / 1000;
const monoMs = () => {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
};
const realSleep = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h && h.unref) h.unref(); });

/** asyncio.Semaphore: FIFO waiters. */
class Semaphore {
  constructor(n) { this._n = n; this._waiters = []; }
  get available() { return this._n; }
  async acquire() {
    if (this._n > 0 && !this._waiters.length) { this._n -= 1; return; }
    await new Promise((resolve) => this._waiters.push(resolve));
  }
  release() {
    const w = this._waiters.shift();
    if (w) w(); else this._n += 1;
  }
  async run(fn) {
    await this.acquire();
    try { return await fn(); } finally { this.release(); }
  }
}

/** asyncio.CancelledError: the task was cancelled (bot shutdown) — raised at the cycle's checkpoints. */
class CancelledError extends Error {
  constructor(msg = 'cancelled') { super(msg); this.name = 'CancelledError'; }
}
const isCancelled = (e) => Boolean(e && e.name === 'CancelledError');

/** asyncio.Event */
class WakeEvent {
  constructor() { this._set = false; this._waiters = []; }
  isSet() { return this._set; }
  set() {
    this._set = true;
    const ws = this._waiters.splice(0);
    for (const w of ws) w();
  }
  clear() { this._set = false; }
  /** wait_for(evt.wait(), timeout): true when set, false on timeout / abort. */
  wait(timeoutMs, { setTimer = setTimeout, clearTimer = clearTimeout, signal = null } = {}) {
    if (this._set) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimer(h);
        const i = this._waiters.indexOf(onSet);
        if (i >= 0) this._waiters.splice(i, 1);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      const onSet = () => finish(true);
      const onAbort = () => finish(false);
      this._waiters.push(onSet);
      const h = setTimer(() => finish(false), timeoutMs);
      if (signal) signal.addEventListener('abort', onAbort);
    });
  }
}

/** `key in dict` for a JSON value: lists / dicts are unhashable in Python (TypeError). */
function hashableKey(k) {
  if (k !== null && typeof k === 'object') {
    const e = new TypeError(`unhashable type: '${Array.isArray(k) ? 'list' : 'dict'}'`);
    throw e;
  }
  return k;
}
const inTfMap = (k) => typeof hashableKey(k) === 'string' && own(SMC_TF_MAP, k);

/** _detect_reversal_setup(sig): CHoCH (c1) + Liquidity Sweep (c2) confirmed. */
function detectReversalSetup(sig) {
  const confs = (sig && sig.confirmations) || [];
  if (confs.length < 2) return false;
  try {
    return pyTruthy(confs[0][1]) && pyTruthy(confs[1][1]);
  } catch (_e) {
    return false;
  }
}

/** The bot's fallback when i18n / imports are broken is never hit on the site. */
const SMC_CT_BUTTON = '✅ Разрешить контр-тренд (на свой риск)';

/**
 * createSmcScanner(deps) — the module state of smc/scanner.py on an instance.
 *
 *   um            { getActiveUsers() (sync/async), save(user) }       (traderSettingsService)
 *   fetcher       { volBySym, getAllUsdtPairs(minVol), getCandles(sym, tf, limit) }  (bingxRest)
 *   cache         { getCandles(sym, tf), getCoins() }                   (candleCache)
 *   registry      signalRegistry instance; freeReport; trend (trendMonitor instance);
 *   confluence; freshness; momentumVeto { isMomentumVeto(df, dir) }; coinQuality { isBlacklisted };
 *   regime        { getCachedRegime(), regimeAllowsDirection(regime, dir) };
 *   momentum      { relaxConfirmations, relaxMinRr, isRelaxedMode };
 *   repo          signalTradesRepo (addTrade, setTradeResult, addTradeEvent);
 *   optimizer     { smcOptimizerFilters(user) } (services/genome/optimizerParams);
 *   exchangeSymbols { isAvailable(sym, exchange), recordSkip(exchange, sym) };
 *   access        { strategyEnabled(user, S), can(user, feature) } — admin resolved inside;
 *   deliver(msg) → Promise<bool>; deliverChart(msg); executeAutoTrade(params) → Promise<dict>;
 *   userApiKeys(user, exchange) → {apiKey, apiSecret}; getBalance(user, exchange) → Promise<number|null>;
 *   fundBlock() → Promise<string>; smartPromptQuota(uid); metrics { record(name, value, tags) };
 *   isQuiet(user, now); orderLinkId(tradeId, uid, exchange); randint(a, b);
 *   now() (unix s), mono() (ms), sleep(ms), log, builderLog (smc/signal_builder lines; default log), env.
 */
function createSmcScanner(deps = {}) {
  const log = deps.log || defaultLog;
  const builderLog = deps.builderLog || log;     // smc/signal_builder's module logger
  const now = deps.now || nowSec;
  const mono = deps.mono || monoMs;
  const sleep = deps.sleep || realSleep;
  const env = deps.env || process.env;
  const lazy = (name, factory) => () => (deps[name] !== undefined ? deps[name] : factory());

  const umOf = lazy('um', () => require('../traderSettingsService'));
  const fetcherOf = lazy('fetcher', () => require('../marketData/bingxRest').getRest());
  const cacheOf = lazy('cache', () => require('../marketData/candleCache'));
  const registryOf = lazy('registry', () => require('./signalRegistry').defaultRegistry);
  const freeOf = lazy('freeReport', () => require('./freeReport').defaultFreeReport);
  const trendOf = lazy('trend', () => require('./trendMonitor').defaultMonitor);
  const confluenceOf = lazy('confluence', () => require('./signalConfluence').defaultConfluence);
  const freshnessOf = lazy('freshness', () => require('./signalFreshness').defaultFreshness);
  const vetoOf = lazy('momentumVeto', () => require('./momentumVeto'));
  const blacklistOf = lazy('coinQuality', () => require('./coinQualityLearner'));
  const regimeOf = lazy('regime', () => require('./regimeLoop'));
  const momentumOf = lazy('momentum', () => require('./momentumDetector'));
  const repoOf = lazy('repo', () => require('./signalTradesRepo').defaultRepo);
  const optimizerOf = lazy('optimizer', () => require('../genome/optimizerParams'));
  const exSymOf = lazy('exchangeSymbols', () => require('../exchanges/exchangeSymbols'));
  const quietOf = lazy('quiet', () => require('./quietHours'));
  // the pure SMC engine (strategies/smc, bit-for-bit vs golden); injectable for unit tests
  const engineOf = lazy('engine', () => ({
    analyze: require('../../strategies/smc/analyzer').analyze,
    buildSmcSignal: require('../../strategies/smc/signalBuilder').buildSmcSignal,
    computeSqueezeScore: require('../../strategies/common/squeeze').computeSqueezeScore,
  }));
  const accessOf = lazy('access', () => {
    const ts = require('../traderSettingsService');
    const pf = require('../../config/planFeatures');
    return {
      strategyEnabled: (u, s) => pf.strategyEnabled(u, s, { admin: ts.isAdmin(u.user_id) }),
      can: (u, f) => ts.can(u, f),
    };
  });

  const deliver = deps.deliver || (async () => false);
  const deliverChart = deps.deliverChart || (() => {});
  const executeAutoTrade = deps.executeAutoTrade || null;
  const userApiKeys = deps.userApiKeys || (() => ({ apiKey: '', apiSecret: '' }));
  const getBalance = deps.getBalance || (async () => null);
  const fundBlock = deps.fundBlock || null;
  const smartPromptQuota = deps.smartPromptQuota || ((uid) => log.debug(`smart_prompt quota: uid=${uid} (not wired)`));
  const metrics = deps.metrics || { record() {} };
  const orderLinkId = deps.orderLinkId || ((tid, uid, ex) => require('../exchanges/orderIdUtils').computeClientOrderId(tid, uid, ex, 'entry'));
  const randint = deps.randint || ((a, b) => a + Math.floor(Math.random() * (b - a + 1)));
  const isQuiet = (user) => {
    if (deps.isQuiet) return deps.isQuiet(user, now());
    return quietOf().isQuiet(user, now());
  };

  // ── module state ──────────────────────────────────────────────────────
  const analyzers = new Map();            // _SMC_ANALYZERS: key → analyzer cfg
  const lastScan = new Map();             // _SMC_LAST_SCAN: uid → ts
  const tfCache = new Map();              // _tf_cache: "sym\0tf" → [ts, df]
  const tfCacheStats = { hits: 0, misses: 0, ltf_bypass: 0, saved: 0, none_results: 0 };
  const wsCacheStats = { hits: 0, misses: 0, errors: 0 };
  const pending = new Set();              // _pending_send_tasks
  const wsTrigLast = new Map();           // _WS_TRIG_LAST_SMC
  const state = {
    cancelSignal: null,                   // the running loop's AbortSignal (task cancellation)
    shadowMiss: 0, shadowLastLog: 0.0,    // [SHADOW-LOG-THROTTLE]
    wsTrigTs: 0.0, scanStartTs: 0.0,      // [PHASE-1-C]
    okxSem: null, sendSem: null, wake: null,
  };
  const okxSem = () => { if (!state.okxSem) state.okxSem = new Semaphore(OKX_SEM_SIZE); return state.okxSem; };
  const sendSem = () => { if (!state.sendSem) state.sendSem = new Semaphore(SEND_CONCURRENCY); return state.sendSem; };
  const wakeEvent = () => { if (!state.wake) state.wake = new WakeEvent(); return state.wake; };

  /** _analyzer_for(key, cfg_obj): one analyzer config per key, the map cleared at 64 entries. */
  function analyzerFor(key) {
    const k = JSON.stringify(key);
    let an = analyzers.get(k);
    if (an === undefined) {
      if (analyzers.size >= SMC_ANALYZERS_MAX) analyzers.clear();
      an = require('../../strategies/smc/config').configFromAnalysisKey(key);
      analyzers.set(k, an);
    }
    return an;
  }

  // ── candles ───────────────────────────────────────────────────────────
  /** _fetch_with_retry(fetcher, symbol, tf, limit=200, retries=3) */
  async function fetchWithRetry(fetcher, symbol, tf, limit = 200, retries = 3) {
    try {
      const cache = cacheOf();
      const tfN = tf && 'hd'.includes(pyLower(tf[tf.length - 1])) ? pyUpper(tf) : tf;
      let df = await cache.getCandles(symbol, tfN);
      if (df !== null && df !== undefined && df.length >= 30) { wsCacheStats.hits += 1; return df; }
      if (tfN !== tf) {
        df = await cache.getCandles(symbol, tf);
        if (df !== null && df !== undefined && df.length >= 30) { wsCacheStats.hits += 1; return df; }
      }
      wsCacheStats.misses += 1;
    } catch (e) {
      wsCacheStats.errors += 1;
      log.debug(`WS cache lookup ${symbol}/${tf}: ${e && e.message}`);
    }
    // [PHASE-16.2] CACHE_FIRST_MODE — gate REST fallback
    const cfMode = pyLower(env.CACHE_FIRST_MODE === undefined ? 'off' : String(env.CACHE_FIRST_MODE));
    if (cfMode === 'enforce') return null;
    if (cfMode === 'shadow') {
      state.shadowMiss += 1;
      const t = now();
      if (state.shadowLastLog === 0.0) state.shadowLastLog = t;
      if (t - state.shadowLastLog >= 60.0) {
        log.info(`[CACHE-FIRST-SHADOW-AGG] SMC: ${state.shadowMiss} misses in last ${fmtFixed(t - state.shadowLastLog, 0)}s (REST fallback active)`);
        state.shadowMiss = 0;
        state.shadowLastLog = t;
      }
    }
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        return await fetcher.getCandles(symbol, tf, limit);
      } catch (e) {
        const err = pyLower(String(e && e.message !== undefined ? e.message : e));
        const retryable = err.includes('429') || err.includes('timeout') || err.includes('connection') || err.includes('rate');
        if (retryable && attempt < retries - 1) {
          const wait = 2 ** (attempt + 1);
          log.debug(`SMC ${symbol} ${tf}: retry ${attempt + 1}/${retries} через ${wait}s (${e && e.message})`);
          await sleep(wait * 1000);
        } else {
          throw e;
        }
      }
    }
    return null;
  }

  /** _fetch_with_cache(fetcher, symbol, tf, ttl): ttl ≤ 0 → always fetch (LTF / MTF path). */
  async function fetchWithCache(fetcher, symbol, tf, ttl) {
    if (ttl <= 0) {
      tfCacheStats.ltf_bypass += 1;
      return fetchWithRetry(fetcher, symbol, tf);
    }
    const key = `${symbol}\u0000${tf}`;
    const t = now();
    const hit = tfCache.get(key);
    if (hit !== undefined && (t - hit[0]) < ttl) {
      tfCacheStats.hits += 1;
      return hit[1];
    }
    tfCacheStats.misses += 1;
    const df = await fetchWithRetry(fetcher, symbol, tf);
    if (df !== null && df !== undefined) {
      tfCache.set(key, [t, df]);
      tfCacheStats.saved += 1;
    } else {
      tfCacheStats.none_results += 1;
    }
    return df;
  }

  function resetTfCacheStats() {
    for (const k of Object.keys(tfCacheStats)) tfCacheStats[k] = 0;
    for (const k of Object.keys(wsCacheStats)) wsCacheStats[k] = 0;
  }

  function formatTfCacheStats() {
    const s = tfCacheStats;
    const total = s.hits + s.misses + s.ltf_bypass;
    const hitPct = total ? (100.0 * s.hits / total) : 0.0;
    const ws = wsCacheStats;
    const wsTotal = ws.hits + ws.misses;
    const wsHitPct = wsTotal ? (100.0 * ws.hits / wsTotal) : 0.0;
    return `hits=${s.hits} misses=${s.misses} `
      + `ltf_bypass=${s.ltf_bypass} saved=${s.saved} `
      + `none=${s.none_results} hit_rate=${fmtFixed(hitPct, 1)}% `
      + `cache_size=${tfCache.size} `
      + `| WS-cache: hits=${ws.hits} miss=${ws.misses} `
      + `hit_rate=${fmtFixed(wsHitPct, 1)}% errors=${ws.errors}`;
  }

  /** cache_gc: stale _tf_cache entries (older than HTF TTL) + hard cap (oldest first). */
  function gcTfCache(t = now()) {
    let removed = 0;
    for (const [k, v] of tfCache) if (t - v[0] > HTF_TTL_S) { tfCache.delete(k); removed += 1; }
    if (tfCache.size > TF_CACHE_MAX) {
      const items = Array.from(tfCache.entries()).sort((a, b) => a[1][0] - b[1][0]);
      for (const [k] of items.slice(0, tfCache.size - TF_CACHE_MAX)) { tfCache.delete(k); removed += 1; }
    }
    return removed;
  }

  // ── background dispatch ───────────────────────────────────────────────
  /**
   * _send_smc_card_bg: counter-trend gate + auto-trade + card delivery + registry commit +
   * chart + "SMC ✅" log, under the send semaphore; not delivered and not traded → SKIP.
   */
  async function sendSmcCardBg(user, text, p) {
    const { sig, tradeId, dfMtf, dfHtf, symbol, lang, tfKey } = p;
    await sendSem().acquire();
    try {
      // ── 1. Counter-trend gate + auto_trade ──
      let atResult = { executed: false, show_trade_btn: false, limit_msg: null };
      let effMinScore = p.minScoreForCounter;
      if (p.isCounter && p.minScoreForCounter > REVERSAL_OVERRIDE_MIN && detectReversalSetup(sig)) {
        effMinScore = REVERSAL_OVERRIDE_MIN;
        log.info(`[REVERSAL-OVERRIDE] uid=${pyS(user.user_id)} sym=${sig.symbol} dir=${sig.direction} score=${pyD(sig.score)} `
          + `lowered min_score ${pyD(p.minScoreForCounter)}→${pyD(effMinScore)} (CHoCH+sweep confirmed)`);
      }
      if (pyTruthy(p.atEnabled) && pyTruthy(p.apiKey) && pyTruthy(p.apiSecret)) {
        if (!p.ksBypass && p.isCounter && (!p.allowCounter || sig.score < effMinScore)) {
          log.info(`SMC AUTO-TRADE BLOCK uid=${pyS(user.user_id)} sym=${sig.symbol}: counter-trend `
            + `regime=${pyS(p.regime)} score=${pyD(sig.score)} allow=${pyS(p.allowCounter)} — требуется score>=${pyD(effMinScore)}`);
          log.info(`[FILTER-BLOCK] uid=${pyS(user.user_id)} sym=${sig.symbol} strategy=SMC gate=counter_trend_scanner `
            + `reason=${pyStrRepr(`regime=${pyS(p.regime)} score=${pyS(sig.score)} allow=${pyS(p.allowCounter)}`)} `
            + `value=${pyS(sig.score)} threshold=${pyS(effMinScore)}`);
          try {
            const symShort = String(sig.symbol).replace(/-USDT-SWAP/g, '').replace(/-USDT/g, '');
            let keyboard = null;
            let reason;
            if (!p.allowCounter) {
              reason = '<i>Контр-тренд выключен. Включи «Контр-тренд (A+ only)» '
                + 'в настройках чтобы торговать против тренда.</i>';
              keyboard = [[{ id: 'enable_ct_inline', label: SMC_CT_BUTTON, action: 'enable_ct_inline', kind: 'callback' }]];
            } else {
              reason = `<i>Score сигнала ${pyS(sig.score)}/5 — для контр-тренда нужен ≥${pyS(effMinScore)}/5.</i>`;
            }
            const { escape } = require('./cards/html');
            await deliver({
              kind: 'notice', type: 'trade', userId: user.user_id, strategy: 'SMC', tradeId,
              text: '🚫 <b>Авто-трейд SMC: сделка не открыта</b>\n'
                + `${escape(symShort)} ${sig.direction}\n`
                + `Режим рынка: <b>${pyS(p.regime)}</b> (контр-тренд)\n`
                + `${reason}`,
              keyboard,
            });
          } catch (e) {
            log.debug(`SMC counter-trend notify uid=${pyS(user.user_id)}: ${e && e.message}`);
          }
        } else {
          try {
            if (!executeAutoTrade) throw new Error('auto-trade executor not wired');
            atResult = await executeAutoTrade({
              user_id: user.user_id, symbol: sig.symbol, direction: sig.direction,
              entry: sig.entry_low, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3,
              trade_id: tradeId, api_key: p.apiKey, api_secret: p.apiSecret,
              risk_pct: p.riskPct, leverage: p.leverage, auto_trade_mode: p.autoTradeMode,
              max_trades: ga(user, 'max_trades_limit', 5), strategy: 'SMC', exchange: p.exchange,
              bybit_demo: p.bybitDemo, entry_low: sig.entry_low, entry_high: sig.entry_high,
              quality: pyInt(pyTruthy(sig.score) ? sig.score : 0),
              trend_ctx: String(pyTruthy(sig.trend_ctx) ? sig.trend_ctx : ''),   // [CTX-SIZING]
              user,
            }) || {};
          } catch (e) {
            log.error(`SMC auto_trade uid=${pyS(user.user_id)} sym=${sig.symbol}: ${e && e.message}`);
            atResult = { executed: false, show_trade_btn: false, limit_msg: null };
          }
        }
      }
      const showTradeBtn = ga(atResult, 'show_trade_btn', false);
      log.info(`SMC AUTO-TRADE RESULT uid=${pyS(user.user_id)} sym=${sig.symbol}: executed=${pyS(ga(atResult, 'executed', null))} `
        + `show_btn=${pyS(showTradeBtn)} limit_msg=${pyS(pyTruthy(ga(atResult, 'limit_msg', null)))}`);
      if (pyTruthy(ga(atResult, 'limit_msg', null))) {
        try {
          await deliver({ kind: 'notice', type: 'trade', userId: user.user_id, text: atResult.limit_msg, protect: true, strategy: 'SMC', tradeId });
        } catch (e) {
          log.warning(`[NOTIF-FAIL] silent exc smc limit_msg: ${e && e.message}`);
        }
      }

      // ── 2. card delivery ──
      const executed = pyTruthy(ga(atResult, 'executed', false));
      let cardOk = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const keyboard = require('./cards/keyboards').smcKeyboard(sig.symbol, tradeId, {
            showTradeBtn: pyTruthy(showTradeBtn), isAutoTraded: executed, lang,
          });
          cardOk = Boolean(await deliver({
            kind: 'card', type: 'signal', userId: user.user_id, strategy: 'SMC', tradeId,
            symbol: sig.symbol, direction: sig.direction, text, keyboard, lang,
            protect: true, silent: Boolean(isQuiet(user)),
          }));
          if (cardOk || executed) {
            // [DEDUP-AFTER-SEND] слот антидубля — после доставки/сделки
            registryOf().commitSend(user.user_id, sig.symbol, sig.direction, 'SMC');
            registryOf().commitSendMulti(user, sig.symbol, sig.direction);
          }
          if (!(own(user, 'send_chart_enabled') ? pyTruthy(user.send_chart_enabled) : true)) {
            log.debug(`chart skip uid=${pyS(user.user_id)} sym=${symbol} SMC — toggle off`);
          } else {
            try {
              const useMtf = dfMtf !== null && dfMtf !== undefined && dfMtf.length >= 30;
              const dfChart = useMtf ? dfMtf : dfHtf;
              deliverChart({
                userId: user.user_id, tradeId, strategy: 'SMC', lang, symbol: sig.symbol,
                timeframe: useMtf ? sig.tf_mtf : sig.tf_htf,
                bars: dfChart ? dfChart.length : 0,
                lastTs: dfChart && dfChart.length ? dfChart.t[dfChart.length - 1] : null,
                extra: { ob_low: ga(sig, 'ob_low', null), ob_high: ga(sig, 'ob_high', null), fvg_low: ga(sig, 'fvg_low', null), fvg_high: ga(sig, 'fvg_high', null) },
              });
            } catch (e) {
              log.debug(`chart attach SMC uid=${pyS(user.user_id)} sym=${symbol}: ${e && e.message}`);
            }
          }
          log.info(`SMC ✅ ${symbol} ${sig.direction} ${sig.grade}`
            + ` | entry=${fmtG(sig.entry, 6)} sl=${fmtG(sig.sl, 6)} tp1=${fmtG(sig.tp1, 6)}`
            + ` | RR=${fmtFixed(sig.rr, 2)} risk=${fmtFixed(sig.risk_pct, 2)}%`
            + ` | score=${pyS(sig.score)} tf=${tfKey}`
            + ` → @${pyTruthy(user.username) ? user.username : pyS(user.user_id)}`);
          break;
        } catch (e) {
          log.error(`SMC send ${pyS(user.user_id)}: ${e && e.message}`);
          break;
        }
      }
      if (!cardOk && !executed) {
        // [NOT-DELIVERED 2026-10]
        try {
          repoOf().setTradeResult(tradeId, 'SKIP', 0.0, { skipReason: 'not_delivered' });
        } catch (e) {
          log.debug(`not_delivered SKIP tid=${tradeId}: ${e && e.message}`);
        }
      }
      return { cardOk, executed };
    } finally {
      sendSem().release();
    }
  }

  // ── WS bar-close trigger ──────────────────────────────────────────────
  /** _on_ws_bar_close_smc(inst_id, tf_norm): reset the matching users' last-scan clocks, wake the loop. */
  async function onWsBarClose(instId, tfNorm) {
    const tfWant = pyLower(String(tfNorm || ''));
    if (!tfWant) return 0;
    const matching = new Set(Object.keys(SMC_TF_MAP).filter((k) => pyLower(SMC_TF_MAP[k][2]) === tfWant));
    if (!matching.size) return 0;
    let users;
    try {
      users = await umOf().getActiveUsers({ now: now() });
    } catch (e) {
      log.debug(`_on_ws_bar_close_smc get_active_users: ${e && e.message}`);
      return 0;
    }
    let cleared = 0;
    for (const u of users || []) {
      if (!accessOf().strategyEnabled(u, 'SMC')) continue;
      let tfKey;
      try {
        const c = require('./smcUserCfg').getSmcCfg(u);
        tfKey = pyTruthy(ga(c, 'tf_key', '')) ? pyS(c.tf_key) : '';
      } catch (_e) {
        continue;
      }
      if (matching.has(tfKey) && lastScan.has(pyInt(u.user_id))) {
        lastScan.set(pyInt(u.user_id), 0.0);
        cleared += 1;
      }
    }
    if (cleared) {
      state.wsTrigTs = now();
      try { wakeEvent().set(); } catch (e) { log.debug(`wake event set failed: ${e && e.message}`); }
      const t = now();
      const key = `ws_trig_smc_${tfNorm}`;
      if (t - (wsTrigLast.get(key) || 0.0) > 300) {
        wsTrigLast.set(key, t);
        log.info(`[WS-TRIGGER] SMC bar_close ${instId}/${tfNorm} → reset ${cleared} last_scan keys (throttled 1/5min)`);
      } else {
        log.debug(`[WS-TRIGGER] SMC bar_close ${instId}/${tfNorm} → reset ${cleared} last_scan keys`);
      }
    }
    return cleared;
  }

  // ── the cycle ─────────────────────────────────────────────────────────
  /** The running loop's cancellation: CancelledError at the next await of the cycle (bot shutdown). */
  function cancelPoint() {
    if (state.cancelSignal && state.cancelSignal.aborted) throw new CancelledError();
  }

  /** _scan_cycle(bot, um, fetcher, analyzer) */
  async function scanCycle() {
    const tPhaseStart = mono();
    resetTfCacheStats();
    const phase = {
      users_fetch: 0.0, fundamental: 0.0, coin_load: 0.0, vol_filter: 0.0, tf_groups: 0.0,
      candle_fetch: 0.0, analyze_total: 0.0, analyze_count: 0.0, user_loop: 0.0,
    };
    let volGateBlock = 0;
    let volGatePass = 0;
    const mark = (name, startedAt) => { phase[name] += (mono() - startedAt) / 1000; };
    const um = umOf();
    const fetcher = fetcherOf();
    const access = accessOf();
    const free = freeOf();
    const smcCfgMod = require('./smcUserCfg');

    let t = mono();
    const users = (await um.getActiveUsers({ now: now() })) || [];
    const todayUtc = utcDate(now());
    const freeQuota = free.FREE_SMC_PREVIEW_DAILY_QUOTA !== undefined ? free.FREE_SMC_PREVIEW_DAILY_QUOTA : 5;
    let smcUsers = users.filter((u) => (
      (access.strategyEnabled(u, 'SMC') && access.can(u, 'smc')
        && (pyTruthy(ga(u, 'smc_long_active', false)) || pyTruthy(ga(u, 'smc_short_active', false))))
      || (ga(u, 'sub_plan', '') === 'free'
        && (ga(u, 'free_smc_preview_date', '') !== todayUtc
          || pyInt(pyTruthy(ga(u, 'free_smc_preview_today', 0)) ? u.free_smc_preview_today : 0) < freeQuota))
    ));
    // L3.7.1: per-user scan_interval gate
    const nowTs = now();
    const kept = [];
    for (const u of smcUsers) {
      let userInterval;
      try {
        const si = ga(smcCfgMod.getSmcCfg(u), 'scan_interval', 300);
        userInterval = pyInt(pyTruthy(si) ? si : 300);
      } catch (_e) {
        userInterval = 300;
      }
      const uid = pyInt(u.user_id);
      const last = lastScan.has(uid) ? lastScan.get(uid) : 0.0;
      if (nowTs - last >= userInterval) {
        lastScan.set(uid, nowTs);
        kept.push(u);
      }
    }
    if (kept.length < smcUsers.length) log.debug(`SMC per-user gate: ${kept.length}/${smcUsers.length} scheduled this cycle`);
    smcUsers = kept;
    mark('users_fetch', t);
    if (!smcUsers.length) return { users: 0, emitted: 0 };

    // Фундаментальный контекст один раз на весь цикл
    t = mono();
    let fund = '';
    if (fundBlock) {
      try { fund = (await fundBlock()) || ''; } catch (e) { log.debug(`fundamental: ${e && e.message}`); }
    }
    mark('fundamental', t);

    log.info(`SMC scan: ${smcUsers.length} SMC users`);

    t = mono();
    let coins;
    try {
      const cache = cacheOf();
      coins = await cache.getCoins();
      if (!Object.keys(fetcher.volBySym || {}).length) {
        try {
          const fresh = await fetcher.getAllUsdtPairs(SMC_FLOOR);
          if (!pyTruthy(coins)) coins = fresh;
        } catch (e) {
          log.debug(`SMC vol warmup: ${e && e.message}`);
        }
      }
      if (!pyTruthy(coins)) coins = await fetcher.getAllUsdtPairs(SMC_FLOOR);
    } catch (e) {
      log.warning(`SMC: не удалось загрузить монеты: ${e && e.message}`);
      return { users: smcUsers.length, emitted: 0 };
    }
    mark('coin_load', t);

    t = mono();
    try {
      const { applyVolFilter } = require('./volumeFilter');
      coins = applyVolFilter(coins, smcUsers, fetcher.volBySym, (u) => {
        const v = ga(smcCfgMod.getSmcCfg(u), 'min_volume_usdt', 300_000);
        return pyFloat(pyTruthy(v) ? v : 300_000);
      }, { capCount: SMC_CAP, floorUsdt: SMC_FLOOR, strategyTag: 'SMC', log: deps.volFilterLog || defaultLog });
    } catch (e) {
      log.debug(`SMC vol_filter: ${e && e.message}`);
      coins = (coins || []).slice(0, 50);
    }
    mark('vol_filter', t);

    // Группируем пользователей по их предпочтительному tf_key
    const tfGroups = new Map();
    for (const u of smcUsers) {
      let tfKey = smcCfgMod.getSmcCfg(u).tf_key;
      if (!inTfMap(tfKey)) tfKey = '1H';
      if (!tfGroups.has(tfKey)) tfGroups.set(tfKey, []);
      tfGroups.get(tfKey).push(u);
    }

    let emitted = 0;
    const tTfGroups = mono();
    for (const [tfKey, groupUsers] of tfGroups) {
      const [tfHtf, tfMtf, tfLtf] = SMC_TF_MAP[tfKey];
      log.info(`SMC tf=${tfKey} (${tfHtf}/${tfMtf}/${tfLtf}): ${groupUsers.length} users`);
      const sem = okxSem();

      const fetchSymbol = (sym) => sem.run(async () => {
        const rs = await Promise.allSettled([
          fetchWithCache(fetcher, sym, tfHtf, HTF_TTL_S),
          fetchWithCache(fetcher, sym, tfMtf, MTF_TTL_S),
          fetchWithCache(fetcher, sym, tfLtf, LTF_TTL_S),
        ]);
        const v = rs.map((r) => (r.status === 'fulfilled' && r.value !== undefined ? r.value : null));
        return [sym, v[0], v[1], v[2]];
      });

      const candlesMap = new Map();
      const tFetch = mono();
      let allResults;
      let timer = null;
      const timedOut = Symbol('timeout');
      try {
        const gather = Promise.allSettled(coins.map((s) => fetchSymbol(s)));
        const race = await Promise.race([gather, new Promise((r) => { timer = setTimeout(() => r(timedOut), GATHER_TIMEOUT_S * 1000); })]);
        if (race === timedOut) {
          log.warning(`[SMC-GATHER-TIMEOUT] candle_fetch exceeded 90s — skipping cycle, n_coins=${coins.length} tf_group=${tfKey}`);
          allResults = [];
        } else {
          allResults = race;
        }
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
      for (const r of allResults) {
        if (r.status !== 'fulfilled') { log.debug(`SMC fetch error: ${r.reason && r.reason.message}`); continue; }
        const [sym, htf, mtf, ltf] = r.value;
        if (htf === null || mtf === null) continue;
        if (htf.length < 30 || mtf.length < 30) continue;
        candlesMap.set(sym, [htf, mtf, ltf]);
      }
      mark('candle_fetch', tFetch);

      // hoisted per-user precomputation
      const userCache = new Map();
      const relaxed = (() => { try { return Boolean(momentumOf().isRelaxedMode()); } catch (_e) { return false; } })();
      for (const u of groupUsers) {
        let ucfg;
        try {
          ucfg = smcCfgMod.getSmcCfg(u);
        } catch (e) {
          log.debug(`SMC user cache get_smc_cfg uid=${pyS(ga(u, 'user_id', '?'))}: ${e && e.message}`);
          continue;
        }
        const { builderConfig } = require('../../strategies/smc/smcUserCfg');
        const bc = builderConfig(ucfg, { highWrMode: pyTruthy(ga(u, 'high_wr_mode', 0)), relaxedMode: relaxed });
        let filters = { min_rr_filter: 0.0, min_q_filter: 0 };
        try {
          filters = optimizerOf().smcOptimizerFilters(u, { log });
        } catch (e) {
          log.debug(`SMC hoist optimizer uid=${pyS(u.user_id)}: ${e && e.message}`);
        }
        userCache.set(pyInt(u.user_id), {
          ucfg, cfgObj: bc.cfg, anKey: bc.analysisKey,
          pdFilterEff: bc.pdFilter, mtfCheckEff: bc.mtfCheck,
          min_rr_filter: filters.min_rr_filter, min_q_filter: filters.min_q_filter,
        });
      }

      const tUserLoop = mono();
      for (const symbol of coins) {
        if (!candlesMap.has(symbol)) continue;
        const [dfHtf, dfMtf, dfLtf] = candlesMap.get(symbol);
        const analyses = new Map();
        const analysisFor = (key) => {
          const k = JSON.stringify(key);
          if (analyses.has(k)) return analyses.get(k);
          const tA = mono();
          let analysis;
          try {
            analysis = engineOf().analyze(symbol, dfHtf, dfMtf, dfLtf, analyzerFor(key));
            try {
              analysis.squeeze_score = engineOf().computeSqueezeScore(dfMtf);
            } catch (e) {
              log.debug(`SMC squeeze inject ${symbol}: ${e && e.message}`);
              analysis.squeeze_score = 0;
            }
          } catch (e) {
            log.warning(`SMC ${symbol}: ошибка анализа: ${e && e.message}`);
            analysis = null;
          }
          phase.analyze_total += (mono() - tA) / 1000;
          phase.analyze_count += 1;
          analyses.set(k, analysis);
          return analysis;
        };

        for (const user of groupUsers) {
          const uc = userCache.get(pyInt(user.user_id));
          if (uc === undefined) continue;
          const { ucfg, cfgObj } = uc;
          const analysis = analysisFor(uc.anKey);
          if (analysis === null) continue;

          // [stabilize-find-6] per-user volume gate
          let gateBlocked = false;
          try {
            const um0 = ga(ucfg, 'min_volume_usdt', 5_000_000);
            const userMinVol = pyFloat(pyTruthy(um0) ? um0 : 0);
            const vb = fetcher.volBySym || {};
            const cv0 = own(vb, symbol) ? vb[symbol] : 0;
            const coinVol = pyFloat(pyTruthy(cv0) ? cv0 : 0);
            if (userMinVol > 0 && coinVol < userMinVol) {
              volGateBlock += 1;
              if (volGateBlock <= VOL_GATE_LOG_CAP) {
                log.info(`[SMC-VOL-GATE] uid=${pyS(user.user_id)} sym=${symbol} `
                  + `coin_vol=${fmtFixed(coinVol / 1_000_000.0, 2)}M < user_min=${fmtFixed(userMinVol / 1_000_000.0, 1)}M — skip`);
              }
              gateBlocked = true;
            } else {
              volGatePass += 1;
            }
          } catch (e) {
            log.debug(`SMC per-user vol gate error uid=${pyS(user.user_id)}: ${e && e.message}`);
          }
          if (gateBlocked) continue;

          // [SMC-DIR] направления юзера — внутрь выбора сигнала
          const { allowedDirs } = require('../../strategies/smc/smcUserCfg');
          const dirs = allowedDirs(ucfg, ga(user, 'smc_long_active', false), ga(user, 'smc_short_active', false));
          if (!dirs.length) continue;
          let sig;
          try {
            sig = engineOf().buildSmcSignal(symbol, analysis, cfgObj, {
              tf_htf: tfHtf, tf_mtf: tfMtf, tf_ltf: tfLtf,
              allowed_dirs: dirs,
              conf_type: ga(ucfg, 'smc_conf_type', 'WICK_TOUCH'),
              pd_filter: uc.pdFilterEff,
              retrace_depth: ga(ucfg, 'smc_retrace_depth', 0.0),
              mtf_check: uc.mtfCheckEff,
              log: builderLog,                      // logging.getLogger("CHM.SMC.SignalBuilder")
            });
          } catch (e) {
            log.warning(`SMC ${symbol} build ${pyS(user.user_id)}: ${e && e.message}`);
            continue;
          }
          if (sig === null || sig === undefined) {
            log.debug(`SMC ${symbol} uid=${pyS(user.user_id)}: no signal built (all directions rejected)`);
            continue;
          }

          // [MTF-ALIGNED] +1 к score (не выше 5), grade пересчитываем (+ D6: и при штрафе)
          try {
            trendOf().applyMtfBonus(sig, 'score', 5);
          } catch (e) {
            log.debug(`SMC mtf bonus ${symbol}: ${e && e.message}`);
          }

          try {
            const sq = pyInt(pyTruthy(ga(analysis, 'squeeze_score', 0)) ? analysis.squeeze_score : 0);
            if (sq >= 1) log.info(`[SQUEEZE-BOOST] SMC ${symbol} uid=${pyS(user.user_id)} dir=${sig.direction} score=${pyD(sig.score)} sq=${pyD(sq)}`);
          } catch (_e) { /* observability only */ }

          // [CTX-GATE] (ST-9)
          try {
            const minConf = pyInt(pyTruthy(ga(cfgObj, 'MIN_CONFIRMATIONS', 0)) ? cfgObj.MIN_CONFIRMATIONS : 0);
            if (pyInt(pyTruthy(sig.score) ? sig.score : 0) < minConf) {
              log.info(`[SMC-CTX-GATE] ${symbol} uid=${pyS(user.user_id)}: score ${pyS(sig.score)} < ${pyD(minConf)} after trend-context penalty — skip`);
              continue;
            }
          } catch (e) {
            log.debug(`SMC ctx gate ${symbol}: ${e && e.message}`);
          }

          if (ucfg.direction !== 'BOTH' && sig.direction !== ucfg.direction) {
            log.debug(`SMC reject ${symbol}: direction ${sig.direction} vs user=${pyS(ucfg.direction)}`);
            continue;
          }
          const smcL = pyTruthy(ga(user, 'smc_long_active', false));
          const smcS = pyTruthy(ga(user, 'smc_short_active', false));
          if ((smcL || smcS) && !(sig.direction === 'LONG' ? smcL : smcS)) continue;

          const minRrSmc = own(uc, 'min_rr_filter') ? uc.min_rr_filter : 0.0;
          const minQSmc = own(uc, 'min_q_filter') ? uc.min_q_filter : 0;
          if (minRrSmc > 0 && sig.rr < minRrSmc) continue;
          if (minQSmc > 0 && sig.score < minQSmc) continue;

          // Stage 3A-1: symbol availability filter
          let userExchange = 'bybit';
          try {
            userExchange = ga(user, 'trade_exchange', 'bybit');
            const ex = exSymOf();
            if (!ex.isAvailable(symbol, userExchange)) {
              log.info(`[SYMBOL-FILTER] SMC SKIP ${symbol} on ${pyS(userExchange)} (uid=${pyS(user.user_id)}) — not listed`);
              ex.recordSkip(userExchange, symbol);
              continue;
            }
          } catch (e) {
            log.debug(`smc scanner symbol filter exception: ${e && e.message}`);
          }

          // [COIN-BLACKLIST]
          try {
            if (blacklistOf().isBlacklisted(symbol, 'SMC')) {
              log.debug(`[COIN-BLACKLIST] skip ${symbol} SMC uid=${pyS(user.user_id)}`);
              continue;
            }
          } catch (e) {
            log.debug(`coin_quality check SMC: ${e && e.message}`);
          }

          // [MOMENTUM-VETO]
          try {
            const [veto, vetoReason] = vetoOf().isMomentumVeto(dfLtf, sig.direction);
            if (veto) {
              log.info(`[MOMENTUM-VETO] strategy=SMC uid=${pyS(user.user_id)} sym=${sig.symbol} direction=${sig.direction} reason=${vetoReason}`);
              continue;
            }
          } catch (e) {
            log.debug(`momentum_veto SMC uid=${pyS(user.user_id)} sym=${sig.symbol}: ${e && e.message}`);
          }

          // [PHASE-12] freshness
          try {
            const fresh = await freshnessOf().isSignalFresh({
              symbol: sig.symbol, direction: sig.direction, entry: sig.entry, tp1: sig.tp1,
              sl: pyFloat(pyTruthy(sig.sl) ? sig.sl : 0), strategy: 'SMC', uid: user.user_id,
            });
            if (!fresh) continue;
          } catch (e) {
            log.debug(`freshness check SMC uid=${pyS(user.user_id)} sym=${sig.symbol}: ${e && e.message}`);
          }

          // [FREE-UX] Pro Preview — split path ДО signal_registry (no row / slot / auto-trade)
          if (ga(user, 'sub_plan', '') === 'free') {
            try {
              if (free.freePreviewAlreadySentToday(user.user_id, symbol, sig.direction)) {
                log.debug(`[FREE-UX] SMC preview already sent today uid=${pyS(user.user_id)} sym=${symbol} dir=${sig.direction} — skip duplicate`);
                continue;
              }
              if (!(await free.shouldSendFreeSmcPreview(user))) {
                log.debug(`[FREE-UX] SMC preview quota exhausted uid=${pyS(user.user_id)}`);
                try {
                  Promise.resolve().then(() => smartPromptQuota(user.user_id)).catch((e) => log.debug(`smart_prompt quota: ${e && e.message}`));
                } catch (e) {
                  log.debug(`smart_prompt quota: ${e && e.message}`);
                }
                continue;
              }
              const lang0 = pyTruthy(ga(user, 'lang', 'ru')) ? user.lang : 'ru';
              const previewText = free.previewCardText(sig, symbol, lang0);
              const previewOk = await deliver({
                kind: 'preview', type: 'signal', userId: user.user_id, strategy: 'SMC',
                symbol, direction: sig.direction, text: previewText, lang: lang0,
              });
              // [PREVIEW-DELIVERED] counter only after a confirmed delivery
              if (previewOk) {
                try { free.recordFreeSmcPreviewSent(user); } catch (e) { log.debug(`record_free_smc_preview_sent: ${e && e.message}`); }
                free.markFreePreviewSent(user.user_id, symbol, sig.direction);
                await um.save(user, { now: now() });
                log.info(`[FREE-UX] SMC preview sent uid=${pyS(user.user_id)} sym=${symbol} dir=${sig.direction} q=${pyS(sig.score)}`);
              } else {
                log.warning(`[FREE-UX] SMC preview NOT delivered uid=${pyS(user.user_id)} sym=${symbol} — quota kept`);
              }
            } catch (e) {
              log.warning(`[FREE-UX] SMC preview failed uid=${pyS(user.user_id)}: ${e && e.message}`);
            }
            continue;
          }

          // [DEDUP-AFTER-SEND] peek only; the slot is committed after delivery / a trade
          const reg = registryOf();
          if (!reg.peekCanSend(user.user_id, symbol, sig.direction, 'SMC')) {
            log.debug(`cross-dedup skip SMC ${symbol} ${sig.direction} uid=${pyS(user.user_id)}`);
            continue;
          }
          if (!reg.peekCanSendMulti(user, symbol, sig.direction)) continue;
          reg.claimMulti(user, symbol, sig.direction);   // [MULTI-CLAIM] ST-10

          // [CONFLUENCE] record cross-strategy emission (market property, not per user)
          try {
            confluenceOf().recordSignal(symbol, sig.direction, 'SMC', pyInt(pyTruthy(sig.score) ? sig.score : 0));
          } catch (e) {
            log.debug(`confluence record SMC: ${e && e.message}`);
          }

          // ── signal_trades row ──
          const tradeId = `${pyS(user.user_id)}_${Math.trunc(now() * 1000)}_${randint(100, 999)}`;   // FIX-B8
          log.info(`[TRACE-DB-WRITE] SMC pre-add uid=${pyS(user.user_id)} sym=${sig.symbol} tid=${tradeId}`);
          try {
            // MONEY-AUDIT P1.4: entry orderLinkId
            let link;
            try { link = orderLinkId(tradeId, user.user_id, userExchange); } catch (_e) { link = ''; }
            const [rr1, rr2, rr3] = require('./cards/smc').rrLadder(sig);   // [SMC-RR] реальные R
            const isCounterTrend = (pyTruthy(ga(sig, 'is_counter_trend', false))
              || pyTruthy(trendOf().isCounter(sig.direction, tfMtf))) ? 1 : 0;
            repoOf().addTrade({
              trade_id: tradeId,
              user_id: user.user_id,
              symbol: sig.symbol,
              direction: sig.direction,
              entry: sig.entry,
              entry_lo: sig.entry_low,
              entry_hi: sig.entry_high,
              sl: sig.sl,
              original_sl: sig.sl,
              order_link_id: link,
              tp1: sig.tp1,
              tp2: sig.tp2,
              tp3: sig.tp3,
              tp1_rr: rr1,
              tp2_rr: rr2,
              tp3_rr: rr3,
              quality: sig.score,
              timeframe: tfLtf,
              breakout_type: 'SMC',
              created_at: now(),
              strategy: 'SMC',
              rsi: pyFloat(pyTruthy(ga(sig, 'rsi', 50.0)) ? ga(sig, 'rsi', 50.0) : 50.0),
              volume_ratio: pyFloat(pyTruthy(ga(sig, 'volume_ratio', 1.0)) ? ga(sig, 'volume_ratio', 1.0) : 1.0),
              is_counter_trend: isCounterTrend,
              mtf_aligned: pyTruthy(ga(sig, 'mtf_aligned', false)) ? 1 : 0,
              trend_ctx: Array.from(String(pyTruthy(ga(sig, 'trend_ctx', '')) ? sig.trend_ctx : '')).slice(0, 16).join(''),
              btc_corr: 0.0,
              session: '',
              preset_name: null,
              state: 'PENDING',
              state_changed_at: now(),
            });
            log.info(`[TRACE-DB-WRITE] SMC post-add OK uid=${pyS(user.user_id)} sym=${sig.symbol} tid=${tradeId}`);
            // [FORENSICS] event #1: signal_generated (SMC)
            try {
              const repo = repoOf();
              repo.addTradeEvent(tradeId, 'signal_generated', {
                strategy: 'SMC', user_id: user.user_id,
                symbol: sig.symbol, direction: sig.direction,
                entry: sig.entry, sl: sig.sl, tp1: sig.tp1,
                quality: sig.score, tf: tfLtf,
                rr: sig.rr,
                is_counter_trend: pyTruthy(ga(sig, 'is_counter_trend', false)),
              }, { floatKeys: ['entry', 'sl', 'tp1', 'rr'] });
            } catch (_e) { /* forensic event optional */ }
          } catch (e) {
            log.error(`[TRACE-DB-WRITE] SMC FAILED uid=${pyS(user.user_id)} sym=${sig.symbol} tid=${tradeId} err=${e && e.message}`);
            throw e;
          }

          try { metrics.record('signal_emitted', 1.0, { strategy: 'smc', symbol: sig.symbol, tf: tfLtf }); } catch (e) { log.debug(`metrics signal_emitted SMC: ${e && e.message}`); }
          try {
            log.info(`[STALE-SIGNAL] strategy=SMC uid=${pyS(user.user_id)} sym=${sig.symbol} dir=${sig.direction} `
              + `tf=${tfLtf} signal_emit_ts=${Math.trunc(now())}`);
          } catch (_e) { /* observability */ }
          try {
            const emitDeltaMs = (now() - state.scanStartTs) * 1000.0;
            log.info(`[SIGNAL-DELTA-MS] strategy=SMC uid=${pyS(user.user_id)} sym=${sig.symbol} scan_to_emit_ms=${fmtFixed(emitDeltaMs, 0)}`);
            metrics.record('signal_latency_ms', emitDeltaMs, { strategy: 'smc', symbol: sig.symbol });
          } catch (e) {
            log.debug(`SIGNAL-DELTA-MS log failed: ${e && e.message}`);
          }

          // ── auto-trade params (computed here, dispatched in the background) ──
          const atEnabled = ga(user, 'auto_trade', false);
          const autoTradeMode = ga(user, 'auto_trade_mode', 'confirm');
          const exchange = ga(user, 'trade_exchange', 'bybit');
          const keys = userApiKeys(user, exchange) || {};
          const apiKey = keys.apiKey || '';
          const apiSecret = keys.apiSecret || '';
          const riskPct = ga(user, 'trade_risk_pct', 1.0);
          const leverage = ga(user, 'trade_leverage', 10);
          log.info(`SMC AUTO-TRADE CHECK uid=${pyS(user.user_id)} sym=${sig.symbol}: `
            + `auto_trade=${pyS(atEnabled)} mode=${pyS(autoTradeMode)} exchange=${pyS(exchange)} api_key=${apiKey ? 'SET' : 'EMPTY'}`);

          const ksBypass = pyTruthy(ga(user, 'filters_all_off', false));
          const rg = regimeOf();
          const regime = rg.getCachedRegime();
          const isCounter = regime !== null && regime !== undefined && !rg.regimeAllowsDirection(regime, sig.direction);
          const allowCounter = pyTruthy(ga(user, 'allow_counter_trend', false));
          let minScoreForCounter;
          try {
            const raw = ga(user, 'smc_counter_trend_min_quality', 4);
            minScoreForCounter = pyInt(pyTruthy(raw) ? raw : 4);
          } catch (_e) {
            minScoreForCounter = 4;
          }
          minScoreForCounter = Math.max(0, Math.min(5, minScoreForCounter));

          const lang = ga(user, 'lang', 'ru');
          let rawText;
          if (ga(user, 'signal_format', 'full') === 'lite') {
            const { formatSignalLite } = require('./cards/lite');
            const q = pyTruthy(ga(sig, 'score', null)) ? sig.score : (pyTruthy(ga(sig, 'quality', null)) ? sig.quality : 0);
            rawText = formatSignalLite({
              symbol: sig.symbol, direction: sig.direction, quality: q,
              entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: ga(sig, 'tp2', null), tp3: ga(sig, 'tp3', null),
              strategy: 'SMC', lang,
            });
          } else {
            const T = trendOf();
            rawText = require('./cards/smc').signalTextSmc(sig, fund, lang, { cardLine: (d, tf, l) => T.cardLine(d, tf, l) });
          }
          const { wmInject } = require('./watermark');
          let text = wmInject(rawText, user.user_id);
          text = require('./cards/smc').maybeAppendSmcSlWarning(text, sig, user, lang);
          try {   // [POSITION-SIZE]
            let balance = null;
            try {
              balance = await Promise.race([
                getBalance(user, String(pyTruthy(ga(user, 'trade_exchange', 'bybit')) ? user.trade_exchange : 'bybit')),
                new Promise((r) => { const h = setTimeout(() => r(null), 3000); if (h && h.unref) h.unref(); }),
              ]);
            } catch (e) {
              log.debug(`[POSITION-SIZE] balance uid=${pyS(user.user_id)}: ${e && e.message}`);
              balance = null;
            }
            const T = trendOf();
            const { positionLine } = require('./positionLine');
            const pl = positionLine(user, sig.entry, sig.sl, lang, ga(sig, 'trend_ctx', ''), {
              balance, ctxRiskMult: (c) => T.ctxRiskMult(c), ctxLabel: require('./trendMonitor').ctxLabel,
            });
            if (pl) text += '\n' + pl;
          } catch (e) {
            log.debug(`position_line SMC uid=${pyS(user.user_id)}: ${e && e.message}`);
          }
          try {
            const label = confluenceOf().getConfluenceLabel(sig.symbol, sig.direction, 'SMC');
            if (label) {
              text = `${label}\n${text}`;
              log.info(`[CONFLUENCE] uid=${pyS(user.user_id)} sym=${sig.symbol} dir=${sig.direction} label=${label}`);
            }
          } catch (e) {
            log.debug(`confluence label SMC: ${e && e.message}`);
          }

          emitted += 1;
          const task = sendSmcCardBg(user, text, {
            sig, tradeId, dfMtf, dfHtf, symbol, lang, tfKey,
            atEnabled, autoTradeMode, exchange, apiKey, apiSecret, riskPct, leverage,
            ksBypass, isCounter, regime, allowCounter, minScoreForCounter,
            bybitDemo: pyTruthy(ga(user, 'bybit_demo', false)),
          }).catch((e) => {
            log.error(`smc_dispatch_${pyS(user.user_id)}_${symbol}: ${e && e.message}`);
          });
          pending.add(task);
          task.finally(() => pending.delete(task));
        }
        await sleep(100);
        cancelPoint();
      }
      phase.user_loop += (mono() - tUserLoop) / 1000;
    }
    phase.tf_groups = (mono() - tTfGroups) / 1000;
    phase.user_loop = Math.max(0.0, phase.user_loop - phase.analyze_total);
    const total = (mono() - tPhaseStart) / 1000;
    const avgAnalyzeMs = phase.analyze_count > 0 ? (phase.analyze_total / phase.analyze_count) * 1000 : 0.0;
    log.info(`[SMC-PROFILE] total=${fmtFixed(total, 1)}s | users_fetch=${fmtFixed(phase.users_fetch, 2)}s fundamental=${fmtFixed(phase.fundamental, 2)}s `
      + `coin_load=${fmtFixed(phase.coin_load, 2)}s vol_filter=${fmtFixed(phase.vol_filter, 2)}s | tf_groups=${fmtFixed(phase.tf_groups, 1)}s (fetch=${fmtFixed(phase.candle_fetch, 1)}s `
      + `analyze=${fmtFixed(phase.analyze_total, 1)}s [n=${Math.trunc(phase.analyze_count)} avg=${fmtFixed(avgAnalyzeMs, 0)}ms] user_loop=${fmtFixed(phase.user_loop, 1)}s)`);
    try {
      const pareto = [
        ['users_fetch', phase.users_fetch], ['fundamental', phase.fundamental], ['coin_load', phase.coin_load],
        ['vol_filter', phase.vol_filter], ['candle_fetch', phase.candle_fetch], ['analyze_total', phase.analyze_total],
        ['user_loop', phase.user_loop],
      ];
      const totalForPct = Math.max(total, 0.001);
      const top = pareto.map((x, i) => [x[0], x[1], i]).sort((a, b) => (b[1] - a[1]) || (a[2] - b[2])).slice(0, 3);
      const topStr = top.filter((x) => x[1] > 0.01).map(([name, v]) => `${name}=${fmtFixed(v, 1)}s (${fmtFixed(v / totalForPct * 100, 0)}%)`).join(', ');
      if (total > 120.0) {
        log.warning(`[SMC-PROFILE-DOMINANT-WARN] total=${fmtFixed(total, 1)}s > 120s (target <60s). Top phases: ${topStr}`);
      } else {
        log.info(`[SMC-PROFILE-DOMINANT] total=${fmtFixed(total, 1)}s | top=[${topStr}]`);
      }
    } catch (e) {
      log.debug(`smc profile dominant emit failed: ${e && e.message}`);
    }
    log.info(`[SMC-CACHE] ${formatTfCacheStats()}`);
    log.info(`[SMC-VOL-GATE-SUMMARY] blocked=${volGateBlock} passed=${volGatePass} (first ${Math.min(volGateBlock, VOL_GATE_LOG_CAP)} details above)`);
    return { users: smcUsers.length, emitted };
  }

  /** One loop iteration without the wait (tests / the integration harness). */
  async function cycleOnce() {
    state.scanStartTs = now();
    return scanCycle();
  }

  /**
   * run_smc_scanner(bot, um, fetcher, interval_sec=300, health=None): register the bar-close
   * callback, then forever: cycle → heartbeat("SMC") → report_cycle_time → wait for the wake
   * event or interval_sec. Ends when `signal` aborts — the task's cancellation: inside the cycle it
   * is a CancelledError at the next checkpoint (between symbols) → "SMC Scanner stopped." and
   * re-raised ([SMC-RESTART-ON-STOP]); during the wake wait the bot's CancelledError leaves
   * silently (the wait is outside the try), here the loop just ends.
   */
  async function runSmcScanner({ intervalSec = DEFAULT_INTERVAL_S, health = null, signal = null, registerOnBarClose = null, timers = {} } = {}) {
    log.info(`SMC Scanner started, interval=${intervalSec}s`);
    try {
      const reg = registerOnBarClose || require('../marketData/bingxWsFeed').registerOnBarClose;
      reg(onWsBarClose);
      log.info('[WS-TRIGGER] registered bar-close callback for SMC scanner');
    } catch (e) {
      log.debug(`ws_feed register_on_bar_close SMC: ${e && e.message}`);
    }
    const setTimer = timers.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = timers.clearTimeout || ((h) => clearTimeout(h));
    state.cancelSignal = signal;
    while (!(signal && signal.aborted)) {
      const t0 = mono();
      state.scanStartTs = now();
      if (state.wsTrigTs > 0) {
        const wakeDelayMs = (state.scanStartTs - state.wsTrigTs) * 1000.0;
        if (wakeDelayMs > 0 && wakeDelayMs < 60_000) log.info(`[WS-BARCLOSE-TO-SCAN-DELAY-MS] delta=${fmtFixed(wakeDelayMs, 1)}ms`);
      }
      try {
        await scanCycle();
      } catch (e) {
        if (isCancelled(e)) {
          log.info('SMC Scanner stopped.');
          throw e;
        }
        log.error(`SMC scan cycle error: ${e && e.message}`);
      }
      if (signal && signal.aborted) break;
      if (health) health.heartbeat('SMC');
      try { metrics.record('cycle_duration', mono() - t0, { scanner: 'smc' }); } catch (e) { log.debug(`metrics cycle_duration smc: ${e && e.message}`); }
      try { freshnessOf().reportCycleTime('SMC', (mono() - t0) / 1000); } catch (e) { log.debug(`freshness report SMC: ${e && e.message}`); }
      const evt = wakeEvent();
      const woken = await evt.wait(intervalSec * 1000, { setTimer, clearTimer, signal });
      if (woken) log.debug('[SIGNAL-FRESHNESS-D2] SMC cycle woken by ws event');
      evt.clear();
    }
  }

  /** Await every background dispatch still running (tests; graceful shutdown). */
  async function drainPending() {
    while (pending.size) await Promise.allSettled(Array.from(pending));
  }

  return {
    SMC_TF_MAP, SEND_CONCURRENCY,
    _analyzers: analyzers, _lastScan: lastScan, _tfCache: tfCache, _tfCacheStats: tfCacheStats,
    _wsCacheStats: wsCacheStats, _pending: pending, _state: state,
    analyzerFor, fetchWithRetry, fetchWithCache, resetTfCacheStats, formatTfCacheStats, gcTfCache,
    sendSmcCardBg, onWsBarClose, scanCycle, cycleOnce, runSmcScanner, drainPending,
    wakeEvent, sendSemaphore: sendSem,
  };
}

let _default = null;
/** The module-level scanner of this thread (the worker's), created on first use. */
function defaultScanner(deps) {
  if (!_default) _default = createSmcScanner(deps || {});
  return _default;
}

/** The module state if a scanner exists (cache_gc reads _tf_cache / _SMC_LAST_SCAN), else null. */
function currentScanner() {
  return _default;
}

/**
 * run_smc_scanner(bot, um, fetcher, interval_sec=300, health=None) with the module instance.
 * `bot` is the delivery facade ({deliver, deliverChart}); `opts.deps` are extra createSmcScanner
 * deps. The instance is created on the first call and survives a _guarded_restart (the bot's
 * module globals _SMC_LAST_SCAN / _tf_cache do), so a restart keeps the per-user interval gate.
 */
function runSmcScanner(bot = null, um = null, fetcher = null, opts = {}) {
  const { deps = null, ...loopOpts } = opts || {};
  const d = { ...(deps || {}) };
  if (bot && typeof bot.deliver === 'function') d.deliver = (m) => bot.deliver(m);
  if (bot && typeof bot.deliverChart === 'function') d.deliverChart = (m) => bot.deliverChart(m);
  if (um) d.um = um;
  if (fetcher) d.fetcher = fetcher;
  return defaultScanner(d).runSmcScanner(loopOpts);
}

module.exports = {
  SMC_TF_MAP, SMC_ANALYZERS_MAX, OKX_SEM_SIZE, HTF_TTL_S, MTF_TTL_S, LTF_TTL_S, TF_CACHE_MAX,
  SEND_CONCURRENCY, REVERSAL_OVERRIDE_MIN, SMC_FLOOR, SMC_CAP, VOL_GATE_LOG_CAP, GATHER_TIMEOUT_S,
  DEFAULT_INTERVAL_S, Semaphore, WakeEvent, CancelledError, detectReversalSetup, createSmcScanner, defaultScanner,
  currentScanner, runSmcScanner,
  _resetDefault: () => { _default = null; },
};
