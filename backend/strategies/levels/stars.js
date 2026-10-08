'use strict';
/**
 * stars.js — quality_scale.py: the single LEVELS quality scale 0..10 → 1..5 stars.
 *
 *   levelsStars(quality)  0-1 → 1★, 2-3 → 2★, 4-5 → 3★, 6-7 → 4★, 8-10 → 5★
 *   starsStr(n)           "⭐" × n + "☆" × (5 − n)
 *
 * "A" = 4★ = quality ≥ 6, "A+" = 5★ = quality ≥ 8 (spec §14).
 */

/** levels_stars(quality): float(quality or 0) (parse errors → 0), clamp 0..10, int(q)//2 + 1 clamped 1..5. */
function levelsStars(quality) {
  let q = Number(quality || 0);
  if (Number.isNaN(q)) q = 0.0;
  q = Math.max(0.0, Math.min(10.0, q));
  return Math.max(1, Math.min(5, Math.floor(Math.trunc(q) / 2) + 1));
}

/** stars_str(n): int(n or 0) (errors → 0), clamp 0..5. */
function starsStr(n) {
  let k = Math.trunc(Number(n || 0));
  if (Number.isNaN(k)) k = 0;
  k = Math.max(0, Math.min(5, k));
  return '⭐'.repeat(k) + '☆'.repeat(5 - k);
}

module.exports = { levelsStars, starsStr };
