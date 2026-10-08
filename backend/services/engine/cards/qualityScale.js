/**
 * cards/qualityScale — the bot's quality_scale.py verbatim.
 * LEVELS quality 0..10 → 1..5 stars (0-1→1, 2-3→2, 4-5→3, 6-7→4, 8+→5);
 * stars_str(n) = "⭐"*n + "☆"*(5-n).
 */

'use strict';

const { pyMax, pyMin } = require('../../../strategies/common/pyround');
const { pyFloat, pyInt } = require('../pycoerce');
const { pyTruthy, repeat } = require('./html');

/** float(quality or 0) with the (TypeError, ValueError) → 0.0 fallback. */
function pyFloatOr0(v) {
  try {
    return pyFloat(pyTruthy(v) ? v : 0);
  } catch (_e) {
    return 0.0;
  }
}

/**
 * levels_stars(quality): 0..10 → 1..5. `max(0.0, min(10.0, q))` keeps Python's
 * argument order (NaN → 10.0 → 5 stars, like the bot).
 */
function levelsStars(quality) {
  const q = pyMax(0.0, pyMin(10.0, pyFloatOr0(quality)));
  return pyMax(1, pyMin(5, Math.floor(pyInt(q) / 2) + 1));
}

/** stars_str(n): "⭐"*n + "☆"*(5-n), n = clamp(int(n or 0), 0, 5); int() failing → 0. */
function starsStr(n) {
  let k;
  try {
    k = pyTruthy(n) ? pyInt(n) : 0;
  } catch (_e) {
    k = 0;
  }
  k = pyMax(0, pyMin(5, k));
  return repeat('⭐', k) + repeat('☆', 5 - k);
}

module.exports = { levelsStars, starsStr, pyFloatOr0 };
