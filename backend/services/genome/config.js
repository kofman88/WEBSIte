'use strict';
/**
 * config.js — the module constants and the small per-strategy / per-TF / per-regime lookup
 * helpers of genome.py, verbatim (genome-challenge-profiles.md §1.1, §1.6.1, §1.9, §1.10).
 */

const os = require('os');

// ── population ──
const POP_SIZE = 10;                 // AUDIT-FIX-C33: 15→10 for 1 CPU
const ELITE_FRACTION = 0.25;         // n_elite = max(1, int(10 × 0.25)) = 2
const MUTATION_RATE = 0.3;
const TOURNAMENT_SIZE = 3;

// ── strategies / timeframes ──
const STRATEGIES = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const STRATEGY_TFS = Object.freeze({
  LEVELS: Object.freeze(['15m', '1h', '4h']),
  SMC: Object.freeze(['15m', '1h', '4h']),
  VOLUME: Object.freeze(['15m', '1h', '4h']),
});
const DEFAULT_TF = Object.freeze({ LEVELS: '1h', SMC: '1h', VOLUME: '1h' });
const STRATEGY_TF = DEFAULT_TF;      // backward-compat alias

/** get_tfs(strategy) — exact key lookup, unknown → ["1h"]. */
function getTfs(strategy) {
  return Object.prototype.hasOwnProperty.call(STRATEGY_TFS, strategy) ? STRATEGY_TFS[strategy].slice() : ['1h'];
}

/** get_default_tf(strategy) — exact key lookup, unknown → "1h". */
function getDefaultTf(strategy) {
  return Object.prototype.hasOwnProperty.call(DEFAULT_TF, strategy) ? DEFAULT_TF[strategy] : '1h';
}

// ── evaluation sizing ──
const EVAL_TOP_N = 6;
const EVAL_TOP_N_BY_STRATEGY = Object.freeze({ LEVELS: 12, SMC: 8, VOLUME: 10 });
const EVAL_DAYS = 30;                // display + get_dynamic_eval_days only
const EVAL_MIN_TRADES = 3;           // global floor (apply_best_to_user)
const EVAL_MIN_TRADES_BY_STRATEGY = Object.freeze({ SMC: 3, LEVELS: 10, VOLUME: 6 });
const OOS_SPLIT = 0.50;              // display only (dashboard footer)
const OOS_SPLIT_BY_STRATEGY = Object.freeze({ SMC: 0.50, LEVELS: 0.30 });

const up = (s) => String(s || '').toUpperCase();
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** _eval_top_n(strategy) */
function evalTopN(strategy = '') {
  const k = up(strategy);
  return own(EVAL_TOP_N_BY_STRATEGY, k) ? EVAL_TOP_N_BY_STRATEGY[k] : EVAL_TOP_N;
}

/** _eval_min_trades(strategy) */
function evalMinTrades(strategy = '') {
  const k = up(strategy);
  return own(EVAL_MIN_TRADES_BY_STRATEGY, k) ? EVAL_MIN_TRADES_BY_STRATEGY[k] : EVAL_MIN_TRADES;
}

/** _oos_split(strategy) — VOLUME and unknown → 0.50. */
function oosSplit(strategy = '') {
  const k = up(strategy);
  return own(OOS_SPLIT_BY_STRATEGY, k) ? OOS_SPLIT_BY_STRATEGY[k] : 0.50;
}

/** _eval_days_for_tf(tf, strategy) — history window per TF (low density = LEVELS / VOLUME). */
function evalDaysForTf(tf, strategy = '') {
  const t = String(tf || '').toLowerCase();
  const low = ['LEVELS', 'VOLUME'].includes(up(strategy));
  if (['1m', '3m', '5m'].includes(t)) return 10;
  if (t === '15m') return low ? 25 : 15;
  if (t === '30m') return low ? 30 : 20;
  if (t === '1h') return low ? 60 : 30;
  if (t === '2h') return low ? 80 : 45;
  if (t === '4h') return low ? 90 : 60;
  if (t === '1d') return 180;
  return 30;
}

/** _eval_timeout_for_tf(tf) seconds. */
function evalTimeoutForTf(tf) {
  const t = String(tf || '').toLowerCase();
  if (['15m', '5m', '3m', '1m'].includes(t)) return 240.0;
  if (t === '30m') return 200.0;
  return 180.0;
}

// ── realism ──
const FEE_ROUND_TRIP_PCT = 0.12;
const SLIPPAGE_PCT = 0.10;
const LIVE_PF_DISCOUNT = 0.60;

// ── adaptive evolution ──
const STALE_RESET_AFTER_GENS = 2;
const MAX_STALE_RESETS = 3;
const FITNESS_DECAY_PER_DAY = 0.02;
const CROSS_STRATEGY_RATE = 0.1;
const ENSEMBLE_TOP_N = 3;            // unused (parity)

// ── live validation ──
const DRIFT_THRESHOLD_WR = 15.0;
const DRIFT_MIN_TRADES = 15;
const DRIFT_THRESHOLD_BY_REGIME = Object.freeze({ trending_up: 15.0, trending_down: 15.0, ranging: 25.0, high_vol: 20.0 });
const PF_THRESHOLD_BY_REGIME = Object.freeze({ trending_up: 1.00, trending_down: 1.00, ranging: 0.90, high_vol: 0.95 });
const PF_THRESHOLD_DEFAULT = 1.0;
const PAPER_WR_THRESHOLD = 45.0;
const AGE_WINDOW_DAYS_BY_REGIME = Object.freeze({ trending_up: 3, trending_down: 3, ranging: 14, high_vol: 5 });
const AGE_WINDOW_DAYS_DEFAULT = 14;
const MIN_PAPER_VALIDATION_N = 30;
const LIVE_WR_DISCOUNT = 0.70;

/** _drift_threshold_for_regime(regime): falsy / unknown → 15.0 */
function driftThresholdForRegime(regime) {
  if (!regime) return DRIFT_THRESHOLD_WR;
  const k = String(regime);
  return own(DRIFT_THRESHOLD_BY_REGIME, k) ? DRIFT_THRESHOLD_BY_REGIME[k] : DRIFT_THRESHOLD_WR;
}

/** _pf_threshold_for_regime(regime): falsy / unknown → 1.0 */
function pfThresholdForRegime(regime) {
  if (!regime) return PF_THRESHOLD_DEFAULT;
  const k = String(regime);
  return own(PF_THRESHOLD_BY_REGIME, k) ? PF_THRESHOLD_BY_REGIME[k] : PF_THRESHOLD_DEFAULT;
}

/** _age_window_days_for_regime(regime): falsy / unknown → 14 */
function ageWindowDaysForRegime(regime) {
  if (!regime) return AGE_WINDOW_DAYS_DEFAULT;
  const k = String(regime);
  return own(AGE_WINDOW_DAYS_BY_REGIME, k) ? AGE_WINDOW_DAYS_BY_REGIME[k] : AGE_WINDOW_DAYS_DEFAULT;
}

// ── meta-genome ──
const META_ENABLED = true;
const META_INTERVAL_GENS = 5;

// ── observability / GC ──
const STALE_FITNESS_THRESHOLD = 0.1;
const STALE_FITNESS_STREAK_ALERT = 5;
const COIN_CHAMP_TTL_DAYS = 30;
const COIN_CHAMP_MAX_KEYS = 200;

// ── caches ──
const CONTEXT_COINS_TTL = 900;
const EVAL_CACHE_TTL = 3 * 3600;
const EVAL_CACHE_MAX = 500;
const TOP_COINS_CACHE_TTL = 600;
const TIER2_DYNAMIC_TTL = 24 * 3600;

// ── auto-apply gates ──
const AUTO_APPLY_MIN_FITNESS = 0.5;
const AUTO_APPLY_MIN_WR = 50.0;
const AUTO_APPLY_MIN_PF = 1.3;
const AUTO_APPLY_MIN_TRADES = 20;

/** _genome_auto_apply_enabled(): env must be literally "1" (default "1"), re-read on every call. */
function genomeAutoApplyEnabled(env = process.env) {
  const v = env.GENOME_AUTO_APPLY_ENABLED;
  return (v === undefined ? '1' : v) === '1';
}

// ── background loop ──
const EVOLUTION_INTERVAL = 6 * 3600;
const INITIAL_DELAY = 300;
const EVOLUTION_LAST_KV = 'genome_evolution_last_ts_v1';
const GENERATION_TIMEOUT_S = 1800.0;   // wait_for(gather, 1800)
const MANUAL_EVOLUTION_TIMEOUT_S = 700.0;

/** CPUs the process may use (sched_getaffinity → os.availableParallelism). */
function cpuAllowed() {
  try {
    if (typeof os.availableParallelism === 'function') {
      const n = os.availableParallelism();
      if (n > 0) return n;
    }
  } catch (_e) { /* fall through */ }
  return Math.max(1, (os.cpus() || []).length || 1);
}

/** _default_cpu_share(): 0.15 on ≤ 1 allowed CPU, else 0.35. */
function defaultCpuShare(n = cpuAllowed()) {
  return n <= 1 ? 0.15 : 0.35;
}

/**
 * _GENOME_CPU_SHARE = clamp(float(env GENOME_CPU_SHARE or default), 0.05, 1.0).
 * The bot crashes at import on an unparsable value; the site falls back to the default.
 */
function genomeCpuShare(env = process.env, n = undefined) {
  const raw = env.GENOME_CPU_SHARE;
  let v = raw === undefined || raw === null || String(raw) === '' ? defaultCpuShare(n === undefined ? cpuAllowed() : n) : Number(raw);
  if (!Number.isFinite(v)) v = defaultCpuShare(n === undefined ? cpuAllowed() : n);
  return Math.max(0.05, Math.min(1.0, v));
}

/** The per-coin CPU-budget pause: min(20, elapsed × (1/share − 1)) seconds. */
function cpuPauseS(elapsedS, share) {
  return Math.min(20.0, elapsedS * (1.0 / share - 1.0));
}

module.exports = {
  POP_SIZE, ELITE_FRACTION, MUTATION_RATE, TOURNAMENT_SIZE,
  STRATEGIES, STRATEGY_TFS, DEFAULT_TF, STRATEGY_TF, getTfs, getDefaultTf,
  EVAL_TOP_N, EVAL_TOP_N_BY_STRATEGY, EVAL_DAYS, EVAL_MIN_TRADES, EVAL_MIN_TRADES_BY_STRATEGY,
  OOS_SPLIT, OOS_SPLIT_BY_STRATEGY, evalTopN, evalMinTrades, oosSplit, evalDaysForTf, evalTimeoutForTf,
  FEE_ROUND_TRIP_PCT, SLIPPAGE_PCT, LIVE_PF_DISCOUNT,
  STALE_RESET_AFTER_GENS, MAX_STALE_RESETS, FITNESS_DECAY_PER_DAY, CROSS_STRATEGY_RATE, ENSEMBLE_TOP_N,
  DRIFT_THRESHOLD_WR, DRIFT_MIN_TRADES, DRIFT_THRESHOLD_BY_REGIME, PF_THRESHOLD_BY_REGIME, PF_THRESHOLD_DEFAULT,
  PAPER_WR_THRESHOLD, AGE_WINDOW_DAYS_BY_REGIME, AGE_WINDOW_DAYS_DEFAULT, MIN_PAPER_VALIDATION_N, LIVE_WR_DISCOUNT,
  driftThresholdForRegime, pfThresholdForRegime, ageWindowDaysForRegime,
  META_ENABLED, META_INTERVAL_GENS,
  STALE_FITNESS_THRESHOLD, STALE_FITNESS_STREAK_ALERT, COIN_CHAMP_TTL_DAYS, COIN_CHAMP_MAX_KEYS,
  CONTEXT_COINS_TTL, EVAL_CACHE_TTL, EVAL_CACHE_MAX, TOP_COINS_CACHE_TTL, TIER2_DYNAMIC_TTL,
  AUTO_APPLY_MIN_FITNESS, AUTO_APPLY_MIN_WR, AUTO_APPLY_MIN_PF, AUTO_APPLY_MIN_TRADES, genomeAutoApplyEnabled,
  EVOLUTION_INTERVAL, INITIAL_DELAY, EVOLUTION_LAST_KV, GENERATION_TIMEOUT_S, MANUAL_EVOLUTION_TIMEOUT_S,
  cpuAllowed, defaultCpuShare, genomeCpuShare, cpuPauseS,
};
