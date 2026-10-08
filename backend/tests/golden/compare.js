'use strict';
/**
 * compare.js — tolerance rules of PLAN §3 point 3 for golden comparisons.
 *
 *   numbers   |a − b| ≤ 1e-9 · max(1, |a|, |b|)   (fixtures are float(f"{x:.10g}"), the
 *             engine is float64 end-to-end); fixture null ↔ engine NaN/±Inf;
 *   integers  (quality, score, test_count, level_class, squeeze_score, htf_state …),
 *             booleans and strings (direction, reasons[] in order, human_explanation,
 *             narrative, confirmation labels, …): EXACT;
 *   rounded   fields the bot produces with Python round(x, k) (rr 2 dp, risk_pct 3 dp,
 *             rsi 1 dp, vol_ratio 2 dp, gap_pct 3 dp, position_pct 1 dp, rr_structural
 *             2 dp, wick_ratio 3 dp (smc/liquidity.py round(wr, 3)), rr_ladder 2 dp) go through pyRound before an EXACT
 *             compare — a mismatch there is a pyround/engine bug, never tolerance;
 *   strict    GOLDEN_STRICT=1 additionally requires r10(engine value) === fixture value
 *             for every float (true bit-for-bit after the fixture rounding).
 */

const { pyRound } = require('../../strategies/common/pyround');
const { r10 } = require('../../strategies/common/pyfmt');

const REL_TOL = 1e-9;

/** Python round(x, k) decimals the bot applies to signal fields (per field name). */
const ROUNDED_FIELDS = Object.freeze({
  rr: 2, risk_pct: 3, rsi: 1, vol_ratio: 2, gap_pct: 3, position_pct: 1,
  rr_structural: 2, wick_ratio: 3, rr_ladder: 2, rr_score: 2, btc_corr: 2, eth_corr: 2,
});

/**
 * Python round(x, k) fields inside the SMC analysis digest (expected/smc_analysis.json).
 * The digest's `vol_ratio` is the RAW analyzer ratio (the 2-dp rule above belongs to the
 * VOLUME signal field of the same name), so digests use this map instead.
 */
const DIGEST_ROUNDED_FIELDS = Object.freeze({ position_pct: 1, wick_ratio: 3 });

/** Fields compared exactly even though JSON carries them as numbers. */
const INTEGER_FIELDS = Object.freeze(new Set([
  'quality', 'score', 'test_count', 'level_class', 'squeeze_score', 'htf_state',
  'quality_after_squeeze', 'i', 'open_time_ms', 'n_bars', 'n_htf_bars', 'n_mtf_bars', 'n_ltf_bars',
  'bar_ago', 'idx', 'n_swing_highs', 'n_swing_lows', 'n_fvgs', 'n_ifvgs', 'alignment', 'aligned',
]));

const STRICT = process.env.GOLDEN_STRICT === '1';

function isNum(x) { return typeof x === 'number'; }

/** Number tolerance of PLAN §3: |a−b| ≤ 1e-9·max(1,|a|,|b|); null ↔ non-finite. */
function numbersClose(actual, expected, relTol = REL_TOL) {
  if (expected === null || expected === undefined) return !Number.isFinite(actual) || actual === null || actual === undefined;
  if (!isNum(actual)) return false;
  if (!Number.isFinite(actual)) return false;
  if (actual === expected) return true;
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= relTol * scale;
}

/**
 * Compare an engine value against a fixture value under the rules above.
 * Returns an array of diffs {path, actual, expected, rule}; empty = match.
 * `rounded` is the Python-round field map (ROUNDED_FIELDS for signals,
 * DIGEST_ROUNDED_FIELDS for the SMC analysis digest).
 */
function compareValue(actual, expected, pathStr = '', diffs = [], key = '', rounded = ROUNDED_FIELDS) {
  // null in the fixture: NaN/±Inf/None from Python
  if (expected === null) {
    if (actual === null || actual === undefined || (isNum(actual) && !Number.isFinite(actual))) return diffs;
    diffs.push({ path: pathStr, actual, expected, rule: 'null' });
    return diffs;
  }
  if (typeof expected === 'boolean') {
    if (actual !== expected) diffs.push({ path: pathStr, actual, expected, rule: 'bool' });
    return diffs;
  }
  if (typeof expected === 'string') {
    if (actual !== expected) diffs.push({ path: pathStr, actual, expected, rule: 'string' });
    return diffs;
  }
  if (isNum(expected)) {
    if (!isNum(actual)) { diffs.push({ path: pathStr, actual, expected, rule: 'number' }); return diffs; }
    const k = rounded[key];
    if (k !== undefined) {
      const rounded = pyRound(actual, k);
      if (!(Object.is(rounded, expected) || rounded === expected)) {
        diffs.push({ path: pathStr, actual, rounded, expected, rule: `pyRound(${k})` });
      }
      return diffs;
    }
    if (INTEGER_FIELDS.has(key)) {
      if (actual !== expected) diffs.push({ path: pathStr, actual, expected, rule: 'int' });
      return diffs;
    }
    if (!numbersClose(actual, expected)) {
      diffs.push({ path: pathStr, actual, expected, rule: 'tol1e-9' });
      return diffs;
    }
    if (STRICT && r10(actual) !== expected) {
      diffs.push({ path: pathStr, actual, r10: r10(actual), expected, rule: 'strict-r10' });
    }
    return diffs;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) { diffs.push({ path: pathStr, actual, expected, rule: 'array' }); return diffs; }
    if (actual.length !== expected.length) {
      diffs.push({ path: pathStr, actual: actual.length, expected: expected.length, rule: 'array-length', actualValue: actual, expectedValue: expected });
      return diffs;
    }
    for (let i = 0; i < expected.length; i++) compareValue(actual[i], expected[i], `${pathStr}[${i}]`, diffs, key, rounded);
    return diffs;
  }
  if (typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') { diffs.push({ path: pathStr, actual, expected, rule: 'object' }); return diffs; }
    for (const k of Object.keys(expected)) {
      if (!(k in actual)) { diffs.push({ path: `${pathStr}.${k}`, actual: undefined, expected: expected[k], rule: 'missing-key' }); continue; }
      compareValue(actual[k], expected[k], `${pathStr}.${k}`, diffs, k, rounded);
    }
    return diffs;
  }
  if (actual !== expected) diffs.push({ path: pathStr, actual, expected, rule: 'other' });
  return diffs;
}

/** Compare an SMC analysis digest (make_golden._smc_digest record) with the digest rounding map. */
function compareDigest(actual, expected, pathStr = 'digest') {
  return compareValue(actual, expected, pathStr, [], '', DIGEST_ROUNDED_FIELDS);
}

/**
 * Compare a signal object field by field. `ignoreKeys` are fixture-only keys
 * (e.g. harness-provided i/ts) that the engine is not expected to produce.
 */
function compareSignal(actual, expected, { ignoreKeys = [], pathStr = 'signal' } = {}) {
  const diffs = [];
  if (actual === null || actual === undefined) {
    diffs.push({ path: pathStr, actual: null, expected: '<signal>', rule: 'missing-signal' });
    return diffs;
  }
  for (const k of Object.keys(expected)) {
    if (ignoreKeys.includes(k)) continue;
    if (!(k in actual)) { diffs.push({ path: `${pathStr}.${k}`, actual: undefined, expected: expected[k], rule: 'missing-key' }); continue; }
    compareValue(actual[k], expected[k], `${pathStr}.${k}`, diffs, k);
  }
  return diffs;
}

/** Human-readable one-line summary of a diff list (first N entries). */
function formatDiffs(diffs, max = 8) {
  const lines = diffs.slice(0, max).map((d) => {
    const a = typeof d.actual === 'string' ? JSON.stringify(d.actual) : String(d.actual);
    const e = typeof d.expected === 'string' ? JSON.stringify(d.expected) : String(d.expected);
    const extra = d.rounded !== undefined ? ` (pyRound → ${d.rounded})` : d.r10 !== undefined ? ` (r10 → ${d.r10})` : '';
    return `  ${d.path} [${d.rule}]: got ${a}${extra}, want ${e}`;
  });
  if (diffs.length > max) lines.push(`  … ${diffs.length - max} more`);
  return lines.join('\n');
}

module.exports = {
  REL_TOL, ROUNDED_FIELDS, DIGEST_ROUNDED_FIELDS, INTEGER_FIELDS, STRICT,
  numbersClose, compareValue, compareSignal, compareDigest, formatDiffs,
};
