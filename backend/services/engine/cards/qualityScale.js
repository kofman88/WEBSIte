/**
 * cards/qualityScale — the bot's quality_scale.py verbatim.
 * LEVELS quality 0..10 → 1..5 stars (0-1→1, 2-3→2, 4-5→3, 6-7→4, 8+→5);
 * stars_str(n) = "⭐"*n + "☆"*(5-n).
 */

'use strict';

const { repeat } = require('./html');

/** float(quality or 0) with the (TypeError, ValueError) → 0.0 fallback. */
function pyFloatOr0(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return 0.0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return 1;
  const s = String(v).trim();
  const n = Number(s);
  return s === '' || Number.isNaN(n) ? 0.0 : n;
}

/** levels_stars(quality): 0..10 → 1..5 */
function levelsStars(quality) {
  let q = pyFloatOr0(quality);
  if (Number.isNaN(q)) q = 0.0;
  q = Math.max(0.0, Math.min(10.0, q));
  return Math.max(1, Math.min(5, Math.floor(Math.trunc(q) / 2) + 1));
}

/** stars_str(n): "⭐"*n + "☆"*(5-n), n = clamp(int(n or 0), 0, 5) */
function starsStr(n) {
  let k;
  if (n === null || n === undefined || n === false || n === 0 || n === '') k = 0;
  else if (typeof n === 'number') k = Number.isFinite(n) ? Math.trunc(n) : 0;
  else { const p = parseInt(String(n).trim(), 10); k = Number.isNaN(p) ? 0 : p; }
  k = Math.max(0, Math.min(5, k));
  return repeat('⭐', k) + repeat('☆', 5 - k);
}

module.exports = { levelsStars, starsStr, pyFloatOr0 };
