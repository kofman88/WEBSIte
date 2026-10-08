'use strict';
/**
 * constraints.js — genome._fix_constraints(genome, strategy): repairs gene combinations
 * that can never produce a signal ("dead zones"). Works on a copy; the rules run in this
 * exact order (genome-challenge-profiles.md §1.4). Deterministic for LEVELS and SMC; the
 * VOLUME branch draws a random value for every VOLUME gene MISSING from the dict (legacy
 * populations), so only that step consumes the injected rng.
 *
 * Python value semantics are kept: `dict.get(k, d)` defaults, truthiness (`not x`),
 * `float(x or d)` / `int(x or d)`, round-half-even `round(x, 1)`, and ordered comparisons that
 * raise TypeError for None / mixed str-number operands (a JSON null in a stored genome) where
 * JS would silently coerce.
 */

const { pyRound } = require('../../strategies/common/pyround');
const { pyTruthy, pyOr, pyFloat, pyMax2 } = require('../../strategies/common/pyval');
const { GENE_SPACE, randomGeneValue } = require('./geneSpace');
const { defaultRng } = require('./rng');

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Python int(x) for the scalar kinds a genome holds (bool → 0/1, float → trunc). */
function pyIntOf(x) {
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new RangeError('cannot convert float to integer');
    const t = Math.trunc(x);
    return t === 0 ? 0 : t;
  }
  if (typeof x === 'string' && /^\s*[+-]?\d+\s*$/.test(x)) return parseInt(x, 10);
  throw new TypeError(`int() argument: ${x}`);
}

/** Python type name of a genome scalar (for the TypeError text). */
function pyTypeName(x) {
  if (x === null || x === undefined) return 'NoneType';
  if (typeof x === 'boolean') return 'bool';
  if (typeof x === 'number') return Number.isInteger(x) ? 'int' : 'float';
  if (typeof x === 'string') return 'str';
  return Array.isArray(x) ? 'list' : 'dict';
}

/**
 * Python's ordered comparison of two genome values: numbers and bools compare with each other,
 * strings with strings; anything else (None from a JSON null, str vs number, …) raises
 * TypeError like CPython (`None < 1.2` → "'<' not supported between instances of …").
 */
function pyCmp(op, a, b) {
  const kind = (x) => (typeof x === 'number' || typeof x === 'boolean' ? 'num' : (typeof x === 'string' ? 'str' : null));
  const ka = kind(a);
  if (ka === null || ka !== kind(b)) {
    throw new TypeError(`'${op}' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`);
  }
  const x = typeof a === 'boolean' ? Number(a) : a;
  const y = typeof b === 'boolean' ? Number(b) : b;
  if (op === '<') return x < y;
  if (op === '>') return x > y;
  if (op === '<=') return x <= y;
  return x >= y;
}
const lt = (a, b) => pyCmp('<', a, b);
const gt = (a, b) => pyCmp('>', a, b);
const ge = (a, b) => pyCmp('>=', a, b);

function keyError(k) {
  const e = new Error(`KeyError: '${k}'`);
  e.name = 'KeyError';
  return e;
}

/**
 * _fix_constraints(genome, strategy, rng) → a new dict.
 * @param {object} genome
 * @param {string} strategy  'LEVELS' | 'SMC' | 'VOLUME' (exact case, anything else → copy)
 * @param {object} [rng]     only used by the VOLUME missing-gene fill
 */
function fixConstraints(genome, strategy, rng = defaultRng()) {
  const g = { ...(genome || {}) };
  const get = (k, d) => (own(g, k) ? g[k] : d);

  if (strategy === 'LEVELS') {
    // tp1_rr >= min_rr (otherwise the MIN_RR filter rejects every signal)
    if (lt(get('tp1_rr', 99), get('min_rr', 0))) {
      if (!own(g, 'min_rr')) throw keyError('min_rr');
      g.tp1_rr = g.min_rr;
    }
    // [GENOME-TP-CASCADE-FIX] tp2 ≥ round(tp1 × 1.4, 1)
    const tp1 = pyFloat(pyOr(get('tp1_rr', 1.5), 1.5));
    const tp2Min = pyRound(tp1 * 1.4, 1);
    if (lt(get('tp2_rr', 99), tp2Min)) g.tp2_rr = tp2Min;
    // ema_fast < ema_slow (unreachable with the current choice lists; kept for parity)
    if (ge(get('ema_fast', 0), get('ema_slow', 999))) {
      if (!own(g, 'ema_fast')) throw keyError('ema_fast');
      g.ema_slow = pyMax2(g.ema_fast + 14, 26);
    }
    // both filters off and min_quality ≥ 4 → quality can never reach 4
    if (!pyTruthy(get('use_rsi', false)) && !pyTruthy(get('use_volume', false)) && ge(get('min_quality', 0), 4)) {
      g.min_quality = 3;
    }
  } else if (strategy === 'VOLUME') {
    // migration of the old EMA 9/21 + pullback populations
    for (const k of ['ema_fast', 'ema_slow', 'use_pullback', 'pullback_tol_pct']) delete g[k];
    for (const [k, def] of Object.entries(GENE_SPACE.VOLUME)) {
      if (!own(g, k)) g[k] = randomGeneValue(def, rng);
    }
    // ma_fast < ma_mid < ma_slow < ema_trend
    if (ge(get('ma_fast', 10), get('ma_mid', 20))) g.ma_mid = lt(get('ma_fast', 10), 20) ? 20 : 26;
    if (ge(get('ma_mid', 20), get('ma_slow', 50))) g.ma_slow = lt(get('ma_mid', 20), 50) ? 50 : 100;
    if (ge(get('ma_slow', 50), get('ema_trend', 200))) g.ma_slow = 50;
    // the climax must sit clearly above the spike threshold
    if (pyFloat(pyOr(get('climax_mult', 4.5), 4.5)) < pyFloat(pyOr(get('vol_mult', 1.5), 1.5)) + 1.5) {
      g.climax_mult = pyRound(pyFloat(pyOr(get('vol_mult', 1.5), 1.5)) + 2.0, 1);
    }
    // TP cascade, tp3 = tp2 + 1R
    const t1 = pyFloat(pyOr(get('tp1_rr', 1.0), 1.0));
    if (pyFloat(pyOr(get('tp2_rr', 2.0), 2.0)) < pyRound(t1 * 1.4, 1)) g.tp2_rr = pyRound(t1 * 1.4, 1);
    g.tp3_rr = pyRound(pyFloat(get('tp2_rr', 2.0)) + 1.0, 1);
    // strong volume + the highest quality bar → almost no signals
    if (pyFloat(pyOr(get('vol_mult', 1.5), 1.5)) >= 2.2 && pyIntOf(pyOr(get('min_quality', 3), 3)) >= 4) {
      g.min_quality = 3;
    }
  } else if (strategy === 'SMC') {
    // at least one of the three boolean detectors (deterministically the first)
    if (!['fvg_enabled', 'choch_enabled', 'ob_use_breaker'].some((k) => pyTruthy(get(k, false)))) g.fvg_enabled = true;
    // hard volume filter + 4 confirmations → lower the confirmations
    if (pyTruthy(get('smc_use_volume_filter', null)) && ge(get('min_confirmations', 0), 4)) g.min_confirmations = 3;
    // [GENOME-PACK-A] min_rr > 2.3 with 4 confirmations almost never converges
    if (gt(get('min_rr', 0), 2.3) && ge(get('min_confirmations', 0), 4)) {
      g.min_rr = 2.0;
      g.min_confirmations = 3;
    }
  }

  // [GENOME-PACK-A] LEVELS: every user filter off and min_quality ≥ 3 → force use_volume
  // (use_pattern / use_htf are not genes, so this means "rsi and volume off").
  if (strategy === 'LEVELS') {
    if (!pyTruthy(get('use_rsi', false)) && !pyTruthy(get('use_volume', false))
      && !pyTruthy(get('use_pattern', false)) && !pyTruthy(get('use_htf', false))
      && ge(get('min_quality', 0), 3)) {
      g.use_volume = true;
    }
  }
  return g;
}

module.exports = { fixConstraints, pyIntOf, pyCmp, pyTypeName };
