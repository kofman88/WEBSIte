'use strict';
/**
 * stars.js — quality_scale.py: the single LEVELS quality scale 0..10 → 1..5 stars.
 *
 *   levelsStars(quality)  0-1 → 1★, 2-3 → 2★, 4-5 → 3★, 6-7 → 4★, 8-10 → 5★
 *   starsStr(n)           "⭐" × n + "☆" × (5 − n)
 *
 * "A" = 4★ = quality ≥ 6, "A+" = 5★ = quality ≥ 8 (spec §14). Inputs go through Python's
 * `float(quality or 0)` / `int(n or 0)` semantics (strings parsed like CPython, parse
 * errors → 0) and the builtin max/min (common/pyround.pyMax / pyMin: a NaN survives the
 * clamp as in Python, so `levels_stars("nan")` is 5).
 */

const { pyMax, pyMin } = require('../common/pyround');
const N = require('../common/pynum');

/**
 * CPython float(str) (common/pynum.js: Unicode digits and spaces of unicodedata 14.0.0,
 * underscores between digits, "nan" / "inf" / "infinity" with an optional sign in any case);
 * hex/octal/binary prefixes and anything else raise.
 */
function pyFloatStr(s) {
  const v = N.floatFromStr(String(s));
  if (v === undefined) throw new Error(N.floatErrorText(String(s)));
  return v;
}

/** Python `float(x or 0)` for the inputs levels_stars sees (None/0/""/False → 0; parse errors → 0.0). */
function toPyFloat(x) {
  if (x === null || x === undefined || x === '' || x === 0 || x === false) return 0.0;
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1.0 : 0.0;
  try {
    return pyFloatStr(x);
  } catch (_e) {
    return 0.0;
  }
}

/** levels_stars(quality): float(quality or 0) (errors → 0), max(0.0, min(10.0, q)), int(q) // 2 + 1 clamped 1..5. */
function levelsStars(quality) {
  let q = toPyFloat(quality);
  q = pyMax(0.0, pyMin(10.0, q));
  // int(q) on a NaN raises in Python — unreachable: max(0.0, min(10.0, nan)) is 10.0
  const whole = Number.isFinite(q) ? Math.trunc(q) : 10;
  return Math.max(1, Math.min(5, Math.floor(whole / 2) + 1));
}

/** stars_str(n): int(n or 0) (errors → 0), clamp 0..5. */
function starsStr(n) {
  let k;
  if (n === null || n === undefined || n === '' || n === 0 || n === false) k = 0;
  else if (typeof n === 'number') k = Number.isFinite(n) ? Math.trunc(n) : 0;
  else if (typeof n === 'boolean') k = 1;
  else {
    const lit = N.intLiteral(String(n));          // int("2.9") raises → 0
    k = lit && lit.limit === undefined ? N.intFromLiteral(lit) : 0;
  }
  k = Math.max(0, Math.min(5, k));
  return '⭐'.repeat(k) + '☆'.repeat(5 - k);
}

module.exports = { pyFloatStr, toPyFloat, levelsStars, starsStr };
