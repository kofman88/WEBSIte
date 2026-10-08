'use strict';
/**
 * evaluate.js — genome.evaluate_genome(strategy, genome, tf, _coins, _preloaded,
 * _live_wr_baseline) (genome-challenge-profiles.md §1.6): eval cache, the backtests over the
 * preloaded coin basket with CPU-share pacing, the trade list → fitness.scoreTrades, the
 * coin-champion kv side effect.
 *
 *   evaluateGenome(strategy, genome, tf, opts) → Promise<metrics>
 *     opts = { preloaded: Map|object coin → Frame, coins: [coin] (no preload → loader),
 *              liveWrBaseline, deps }
 *   cacheKey(strategy, genome, tf, days)   sha1("S|tf|days|compact json")[:16]
 *   cleanupEvalCache(cache, now)           drop > 3 h, then the oldest above 500
 *   ZERO                                   the _ZERO metrics
 *   DeadlineError                          kind 'genome' | 'generation' | 'manual'
 *
 * deps (all optional): { backtesterFactory, cache, now() → s, mono() → ms, sleep(ms),
 *   cpuShare, log, store (kv), loader, mcRng, deadlines: [{at: mono ms, kind}] }
 * QUIRK kept: the per-coin WR is read as `getattr(r, "winrate", 0)` — the attribute is
 * `win_rate`, so every per_coin wr is 0.0 and every coin-champion `coin_fit` is 0.0.
 */

const crypto = require('crypto');
const { pyRound } = require('../../strategies/common/pyround');
const { compactGenomeJson, serializeGenome, pyDumps } = require('./geneSpace');
const { createBacktester } = require('./backtester');
const { scoreTrades, coinFitness } = require('./fitness');
const C = require('./config');

const ZERO = Object.freeze({
  winrate: 0, profit_factor: 0, trades: 0, drawdown: 0, fitness: 0, wr_ci_low: 0, wr_ci_high: 0, live_pf: 0,
});
const zero = () => ({ ...ZERO });

class DeadlineError extends Error {
  constructor(kind, message) {
    super(message || `deadline exceeded (${kind})`);
    this.name = 'TimeoutError';
    this.kind = kind;
  }
}

const defaultLog = () => require('../../utils/logger');
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { performance } = require('perf_hooks');

/** The process-wide eval cache (genome._eval_cache). */
const EVAL_CACHE = new Map();

function cacheKey(strategy, genome, tf, days) {
  const raw = `${strategy}|${tf}|${days}|${compactGenomeJson(genome)}`;
  return crypto.createHash('sha1').update(Buffer.from(raw, 'utf8')).digest('hex').slice(0, 16);
}

function cleanupEvalCache(cache = EVAL_CACHE, now = Date.now() / 1000) {
  for (const [k, v] of cache) if (now - v.ts > C.EVAL_CACHE_TTL) cache.delete(k);
  if (cache.size > C.EVAL_CACHE_MAX) {
    const keys = Array.from(cache.keys()).sort((a, b) => cache.get(a).ts - cache.get(b).ts);
    for (const k of keys.slice(0, cache.size - C.EVAL_CACHE_MAX)) cache.delete(k);
  }
}

function resolveDeps(deps = {}) {
  return {
    backtesterFactory: deps.backtesterFactory || createBacktester,
    cache: deps.cache || EVAL_CACHE,
    now: deps.now || (() => Date.now() / 1000),
    mono: deps.mono || (() => performance.now()),
    sleep: deps.sleep || realSleep,
    cpuShare: deps.cpuShare || C.genomeCpuShare(),
    log: deps.log || defaultLog(),
    store: deps.store || require('./store'),
    loader: deps.loader || null,
    mcRng: deps.mcRng || null,
    deadlines: deps.deadlines || [],
    env: deps.env || process.env,
  };
}

function checkDeadlines(d) {
  if (!d.deadlines.length) return;
  const t = d.mono();
  for (const dl of d.deadlines) if (t >= dl.at) throw new DeadlineError(dl.kind);
}

const short = (coin) => String(coin).split('-USDT-SWAP').join('');
const entriesOf = (pre) => (pre instanceof Map ? Array.from(pre.entries()) : Object.entries(pre || {}));

/** Python `float(x or 0)` for a backtest attribute. */
const num0 = (x) => (x === undefined || x === null || x === false || x === 0 || x === '' ? 0 : Number(x));

/** run_simple(symbol, tf, days): loader.loadCached → < 150 bars → empty result; else the backtest. */
async function runSimple(bt, loader, symbol, tf, days) {
  const df = await loader.loadCached(symbol, tf, days);
  if (!df || df.length < 150) return { total_trades: 0, trades: [], profit_factor: Infinity };
  return bt.runInThread(symbol, df, tf, days);
}

/**
 * evaluate_genome(strategy, genome, tf=None, *, _coins, _preloaded, _live_wr_baseline)
 */
async function evaluateGenome(strategy, genome, tf = null, { preloaded = null, coins = null, liveWrBaseline = null, deps = {} } = {}) {
  const d = resolveDeps(deps);
  const log = d.log;
  const t = tf || C.getDefaultTf(strategy);
  const evalDays = C.evalDaysForTf(t, strategy);

  const ck = cacheKey(strategy, genome, t, evalDays);
  const cached = d.cache.get(ck);
  if (cached && d.now() - cached.ts < C.EVAL_CACHE_TTL) return { ...cached.data };

  const results = [];
  const perCoinMetrics = {};
  const perCoinStr = [];
  let totalSeen = -1;
  let firstErr = 'none';
  const hasPreloaded = preloaded && entriesOf(preloaded).length > 0;
  try {
    const params = { ...(genome || {}) };
    if (!Object.prototype.hasOwnProperty.call(params, 'fee_pct')) params.fee_pct = C.FEE_ROUND_TRIP_PCT;
    if (!Object.prototype.hasOwnProperty.call(params, 'slippage_extra_pct')) params.slippage_extra_pct = C.SLIPPAGE_PCT;
    const bt = d.backtesterFactory(strategy, params, { env: d.env });
    if (hasPreloaded) {
      totalSeen = 0;
      let errors = 0;
      firstErr = '';
      for (const [coin, df] of entriesOf(preloaded)) {
        checkDeadlines(d);
        try {
          const t0 = d.mono();
          const r = bt.runInThread(coin, df, t, evalDays);
          // [GENOME-CPU-BUDGET] give the core back: pause ∝ the backtest's own duration
          const el = (d.mono() - t0) / 1000;
          const pause = C.cpuPauseS(el, d.cpuShare);
          if (pause > 0.01) await d.sleep(pause * 1000);
          if (r !== null && r !== undefined) {
            const n = r.total_trades || 0;
            totalSeen += n;
            perCoinStr.push(`${short(coin)}=${n}`);
            if (n >= 1) {
              results.push(r);
              const coinWr = num0(r.winrate);            // QUIRK: the attribute is win_rate → always 0.0
              const coinPf = num0(r.profit_factor);
              perCoinMetrics[coin] = { trades: n, wr: pyRound(coinWr, 1), pf: pyRound(coinPf, 2) };
            }
          } else {
            perCoinStr.push(`${short(coin)}=None`);
          }
        } catch (e) {
          if (e instanceof DeadlineError) throw e;
          log.debug(`genome bt ${strategy}/${t} ${coin}: ${e.message}`);
          errors += 1;
          if (!firstErr) firstErr = `${e.name || 'Error'}: ${String(e.message).slice(0, 100)}`;
          perCoinStr.push(`${short(coin)}=ERR`);
          continue;
        }
        await d.sleep(0);
      }
      if (!results.length) {
        const snip = {};
        for (const k of ['min_rr', 'min_quality', 'use_rsi', 'use_volume', 'ema_fast', 'ema_slow', 'rsi_ob', 'rsi_os']) {
          if (Object.prototype.hasOwnProperty.call(genome || {}, k)) snip[k] = genome[k];
        }
        log.warn(`🧬 [${strategy}/${t}] genome ZERO: total=${totalSeen} err=${errors} [${perCoinStr.join(' ')}] gene=${JSON.stringify(snip)} err1=${firstErr || 'none'}`);
      }
    } else if (coins && coins.length) {
      let fail = 0;
      for (const coin of coins) {
        checkDeadlines(d);
        try {
          const r = await runSimple(bt, d.loader, coin, t, evalDays);
          if (r && r.total_trades >= 1) results.push(r);
        } catch (e) {
          if (e instanceof DeadlineError) throw e;
          fail += 1;
          if (fail <= 2) log.debug(`evaluate_genome ${strategy}/${t} ${coin}: ${e.message}`);
        }
      }
      if (fail > 0 && !results.length) log.warn(`evaluate_genome ${strategy}/${t}: all ${fail} coins failed (e.g. OKX timeout)`);
    } else if (d.loader) {
      // run_scan(timeframe, days, top_n, min_volume_usdt=5M, min_trades_per_coin=1)
      const top = (await d.loader.getTopCoins(5_000_000)).slice(0, C.evalTopN(strategy));
      const scan = [];
      for (const coin of top) {
        checkDeadlines(d);
        try {
          const r = await runSimple(bt, d.loader, coin, t, evalDays);
          if (r && r.total_trades >= 1) scan.push(r);
        } catch (e) {
          if (e instanceof DeadlineError) throw e;
          log.warn(`run_scan ${coin}: ${e.message}`);
        }
      }
      scan.sort((a, b) => b.profit_factor - a.profit_factor);
      results.push(...scan);
    }
  } catch (e) {
    if (e instanceof DeadlineError) throw e;
    log.warn(`evaluate_genome ${strategy}/${t}: ${e.message}`);
  }

  if (!results.length) {
    // AUDIT-FIX-C33/C41: NOT cached (a one-off DNS / API flap)
    log.warn(`🧬 [${strategy}/${t}] genome EMPTY-RESULTS: total_seen=${totalSeen} [${perCoinStr.join(' ') || 'n/a'}] err1=${firstErr || 'none'}`);
    return zero();
  }

  // ── every individual trade with its timestamp, sorted by the ts string (stable) ──
  const allTrades = [];
  for (const r of results) {
    for (const tr of r.trades || []) {
      const ts = tr.exit_time || tr.entry_time || '';
      const rr = tr.rr_realized;
      if (ts && rr !== null && rr !== undefined) allTrades.push([String(ts), Number(rr)]);
    }
  }
  allTrades.sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0)));

  const minTrades = C.evalMinTrades(strategy);
  if (allTrades.length < minTrades) {
    const rawTotal = results.reduce((s, r) => s + (r.total_trades || 0), 0);
    log.warn(`🧬 [${strategy}/${t}] genome LOW-TRADES: results=${results.length} total_raw=${rawTotal} all_trades_filtered=${allTrades.length} (min=${minTrades}, per-strategy) — вернули _ZERO`);
    d.cache.set(ck, { ts: d.now(), data: zero() });
    return zero();
  }

  const out = scoreTrades(allTrades, results.map((r) => r.total_trades || 0), strategy, {
    liveWrBaseline, mcRng: d.mcRng, mcP95Dd: deps.mcP95Dd, perCoin: hasPreloaded ? perCoinMetrics : {},
  });
  const raw = out._raw;
  log.debug(`[FIT-BREAKDOWN] ${strategy}/${t} raw=${raw.fitnessRaw.toFixed(3)} × sample=${out.sample_mult.toFixed(2)} × div=${out.div_mult.toFixed(2)} × regime=${out.regime_mult.toFixed(2)} × mc=${raw.mcMult.toFixed(2)} × wf=${out.wf_mult.toFixed(2)} × live=${out.live_cal_mult.toFixed(2)} → final=${out.fitness.toFixed(3)}`);

  // ── coin-champion kv (genome_coin_champ_{S}_{tf}_{coin}) ──
  if (hasPreloaded && Object.keys(perCoinMetrics).length && out.fitness > 0.3) {
    try {
      for (const [coin, cm] of Object.entries(perCoinMetrics)) {
        if (cm.trades < 3) continue;
        const coinDd = 2.0;   // float(_cm.get("dd", 2.0) or 2.0) — per-coin DD is never recorded
        const coinFit = coinFitness(cm.wr, cm.pf, cm.trades, coinDd);
        const key = `genome_coin_champ_${strategy}_${t}_${coin}`;
        const existingRaw = d.store.kvGet(key);
        let shouldSave = true;
        if (existingRaw) {
          try {
            const ex = JSON.parse(existingRaw);
            const exAgeDays = (d.now() - Number(ex.ts || 0)) / 86400;
            if (coinFit < Number(ex.coin_fit || 0) && exAgeDays < 7) shouldSave = false;
          } catch (_e) { /* keep shouldSave */ }
        }
        if (shouldSave) {
          d.store.kvSet(key, pyDumps({
            genome: serializeGenome(genome || {}), coin_fit: coinFit, wr: cm.wr, pf: cm.pf, trades: cm.trades, ts: d.now(),
          }, { floatKeys: new Set(['coin_fit', 'wr', 'pf', 'ts']) }));
        }
      }
    } catch (e) {
      log.debug(`save coin champion ${strategy}/${t}: ${e.message}`);
    }
  }
  d.cache.set(ck, { ts: d.now(), data: out });
  return out;
}

module.exports = { ZERO, DeadlineError, EVAL_CACHE, cacheKey, cleanupEvalCache, evaluateGenome, runSimple };
