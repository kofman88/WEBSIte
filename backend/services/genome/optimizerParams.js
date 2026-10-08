'use strict';
/**
 * optimizerParams.js — the read side of optimizer_params, the row genome auto-apply writes
 * (apply.autoApplyBestGenome → store.saveOptimizerParams). One-to-one with the bot:
 *
 *   normalizeRegime(v)           optimizer._normalize_regime: canonical trending_up / trending_down /
 *                                ranging / high_vol, the legacy aliases, anything else → ""
 *   paramsForRegime(p, regime)   optimizer.params_for_regime: global keys ← _bayesian.params
 *                                (+ _bayesian_symbol) ← _regime[canon] (+ _active_regime);
 *                                flat dicts / non-dicts / empty → returned as-is (same object)
 *   applyLevelsOptimizerParams   scanner_mid._run_job "ШАГ 9" ([GENOME-AUTO-APPLY-FIX]): with
 *     (cfg, user, deps)          optimizer_enabled OR genome_auto_apply, min_rr > 0 → cfg.min_rr =
 *                                float(min_rr); min_quality > 0 → cfg.min_quality =
 *                                max(cfg.min_quality, int(min_quality)) — the optimizer never
 *                                lowers the user's quality; any error → log.debug, the fields set
 *                                before it stay set
 *   smcOptimizerFilters(user, d) smc/scanner per-user hoist ([SIGNAL-DELIVERY P1.1]):
 *                                {min_rr_filter: float(min_rr or 0), min_q_filter: int(min_quality or 0)}
 *   smcPassesOptimizerFilters    the per-signal gate: rr < min_rr_filter or score < min_q_filter → skip
 *     (uc, sig)                  (a filter ≤ 0 is off)
 *
 * The scanners (services/engine/**, strategies/levels/**) are owned elsewhere; they call these
 * helpers with their own cfg / user rows. deps: {store (loadOptimizerParams), getRegime
 * (market_regime.get_cached_regime, default regime.getCachedRegime — may throw like the bot's),
 * log}. Each helper returns the caught error (or null) as `error` for observability.
 */

const { pyTruthy, pyFloat, pyMax2 } = require('../../strategies/common/pyval');
const { pyIntOf } = require('./constraints');
const regimeHook = require('./regime');

const REGIME_NAMES = Object.freeze(['trending_up', 'trending_down', 'ranging', 'high_vol']);
const REGIME_ALIASES = Object.freeze({
  trend_up: 'trending_up', uptrend: 'trending_up',
  trend_down: 'trending_down', downtrend: 'trending_down',
  range: 'ranging', sideways: 'ranging',
  volatile: 'high_vol', high_volatility: 'high_vol',
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// str.isspace() code points (CPython 3.12) — str.strip() removes exactly these.
const PY_WS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000]);

function pyStrip(s) {
  let a = 0;
  let b = s.length;
  while (a < b && PY_WS.has(s.charCodeAt(a))) a++;
  while (b > a && PY_WS.has(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

/** optimizer._normalize_regime — str() of a non-string never names a regime, so it maps to "". */
function normalizeRegime(value) {
  if (!pyTruthy(value)) return '';
  if (typeof value !== 'string') return '';
  const s = pyStrip(value.toLowerCase());
  if (REGIME_NAMES.includes(s)) return s;
  return own(REGIME_ALIASES, s) ? REGIME_ALIASES[s] : '';
}

/** optimizer.params_for_regime(params, regime) */
function paramsForRegime(params, regime) {
  if (!pyTruthy(params)) return params;
  if (!isDict(params)) return params;
  const bayesian = own(params, '_bayesian') ? params._bayesian : null;
  const regimeMap = own(params, '_regime') ? params._regime : null;
  const hasBayesian = isDict(bayesian) && own(bayesian, 'params') && isDict(bayesian.params);
  const hasRegimeMap = isDict(regimeMap) && pyTruthy(regimeMap);
  if (!hasBayesian && !hasRegimeMap) return params;

  const merged = {};
  for (const [k, v] of Object.entries(params)) if (!k.startsWith('_')) merged[k] = v;
  if (hasBayesian) {
    Object.assign(merged, bayesian.params);
    merged._bayesian_symbol = own(bayesian, 'symbol') ? bayesian.symbol : '';
  }
  if (hasRegimeMap) {
    const canon = normalizeRegime(regime);
    const sub = canon && own(regimeMap, canon) ? regimeMap[canon] : null;
    if (isDict(sub)) {
      Object.assign(merged, sub);
      merged._active_regime = canon;
    }
  }
  return merged;
}

function attrError(v) {
  const kind = Array.isArray(v) ? 'list' : typeof v === 'string' ? 'str' : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'float') : typeof v;
  const e = new TypeError(`'${kind}' object has no attribute 'get'`);
  e.name = 'AttributeError';
  return e;
}

/** Python `x > 0` for a JSON value: numbers / bools compare, anything else is a TypeError. */
function pyGt0(x) {
  if (typeof x === 'boolean') return x;
  if (typeof x === 'number') return x > 0;
  throw new TypeError(`'>' not supported between instances of '${x === null ? 'NoneType' : Array.isArray(x) ? 'list' : typeof x}' and 'int'`);
}

const dictGet = (o, k, dflt) => {
  if (!isDict(o)) throw attrError(o);
  return own(o, k) ? o[k] : dflt;
};

function deps(d) {
  return {
    store: d.store || require('./store'),
    getRegime: d.getRegime || regimeHook.getCachedRegime,
    log: d.log || null,
  };
}

const enabled = (user) => pyTruthy(user && user.optimizer_enabled) || pyTruthy(user && user.genome_auto_apply);

/** load_params + the regime pick shared by both scanners (`params_for_regime(...) or _opt`). */
function loadForRegime(uid, strategy, d, tag) {
  let opt = d.store.loadOptimizerParams(uid, strategy);
  if (pyTruthy(opt)) {
    try {
      const cur = d.getRegime();
      const picked = paramsForRegime(opt, cur);
      opt = pyTruthy(picked) ? picked : opt;
    } catch (e) {
      if (d.log) d.log.debug(`${tag} regime-aware params: ${e.message}`);
    }
  }
  return opt;
}

/** scanner_mid._run_job ШАГ 9 — mutates and returns {cfg, error}. */
function applyLevelsOptimizerParams(cfg, user, depsIn = {}) {
  const d = deps(depsIn);
  if (!enabled(user)) return { cfg, error: null };
  try {
    const opt = loadForRegime(user.user_id, 'LEVELS', d, 'LEVELS');
    if (pyTruthy(opt)) {
      if (pyGt0(dictGet(opt, 'min_rr', 0))) cfg.min_rr = pyFloat(opt.min_rr);
      if (pyGt0(dictGet(opt, 'min_quality', 0))) cfg.min_quality = pyMax2(cfg.min_quality, pyIntOf(opt.min_quality));
    }
  } catch (e) {
    if (d.log) d.log.debug(`_run_job optimizer params uid=${user.user_id}: ${e.message}`);
    return { cfg, error: e };
  }
  return { cfg, error: null };
}

/** smc/scanner per-user hoist → {min_rr_filter, min_q_filter, error}. */
function smcOptimizerFilters(user, depsIn = {}) {
  const d = deps(depsIn);
  const out = { min_rr_filter: 0.0, min_q_filter: 0, error: null };
  if (!enabled(user)) return out;
  try {
    const opt = loadForRegime(user.user_id, 'SMC', d, 'SMC');
    if (pyTruthy(opt)) {
      const rr = dictGet(opt, 'min_rr', 0);
      out.min_rr_filter = pyFloat(pyTruthy(rr) ? rr : 0);
      const q = dictGet(opt, 'min_quality', 0);
      out.min_q_filter = pyIntOf(pyTruthy(q) ? q : 0);
    }
  } catch (e) {
    if (d.log) d.log.debug(`SMC hoist optimizer uid=${user.user_id}: ${e.message}`);
    out.error = e;
  }
  return out;
}

/** smc/scanner per-signal gate on the hoisted filters (`_uc.get(...)` defaults 0.0 / 0). */
function smcPassesOptimizerFilters(uc, sig) {
  const rrF = uc && own(uc, 'min_rr_filter') ? uc.min_rr_filter : 0.0;
  const qF = uc && own(uc, 'min_q_filter') ? uc.min_q_filter : 0;
  if (rrF > 0 && sig.rr < rrF) return false;
  if (qF > 0 && sig.score < qF) return false;
  return true;
}

module.exports = {
  REGIME_NAMES, REGIME_ALIASES, pyStrip, normalizeRegime, paramsForRegime,
  applyLevelsOptimizerParams, smcOptimizerFilters, smcPassesOptimizerFilters,
};
