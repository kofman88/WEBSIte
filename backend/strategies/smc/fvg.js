'use strict';
/**
 * fvg.js — one-to-one port of `smc/fvg.py`: Fair Value Gaps, the full-fill rule,
 * inverted FVGs and the nearest-by-midpoint pick (spec strategy-smc.md §4.4).
 */

const { pyRound } = require('../common/pyround');

function nBars(frame) {
  return frame.length !== undefined ? frame.length : frame.c.length;
}

/** pandas `df[col].iloc[-1]` on an empty frame raises IndexError (captured as analysis.error). */
function requireLast(frame) {
  if (nBars(frame) === 0) throw new Error('single positional indexer is out-of-bounds');
}

/**
 * find_fvgs(df, min_gap_pct, direction="both", include_filled=False): scan i in
 * [2, n); bullish gap = high[i−2] < low[i], bearish gap = low[i−2] > high[i],
 * gap_pct = (gh − gl) / gl · 100 (bearish: 0 when gl ≤ 0), kept when ≥ min_gap_pct.
 * Fill rule: any LATER bar traversing the far edge (bullish: low ≤ fvg_low,
 * bearish: high ≥ fvg_high); an FVG on the last bar can never be filled.
 * Returned sorted by idx descending (freshest first).
 */
function findFvgs(frame, minGapPct = 0.1, direction = 'both', includeFilled = false) {
  const result = [];
  const highs = frame.h, lows = frame.l;
  const n = nBars(frame);

  for (let i = 2; i < n; i++) {
    if (direction === 'bullish' || direction === 'both') {
      const gapLow = highs[i - 2];
      const gapHigh = lows[i];
      if (gapHigh > gapLow) {
        const gapPct = (gapHigh - gapLow) / gapLow * 100;
        if (gapPct >= minGapPct) {
          result.push({ type: 'bullish', fvg_low: gapLow, fvg_high: gapHigh, gap_pct: pyRound(gapPct, 3), bar_ago: n - 1 - i, idx: i, filled: false, inversed: false });
        }
      }
    }
    if (direction === 'bearish' || direction === 'both') {
      const gapHigh = lows[i - 2];
      const gapLow = highs[i];
      if (gapHigh > gapLow) {
        const gapPct = gapLow > 0 ? (gapHigh - gapLow) / gapLow * 100 : 0;
        if (gapPct >= minGapPct) {
          result.push({ type: 'bearish', fvg_low: gapLow, fvg_high: gapHigh, gap_pct: pyRound(gapPct, 3), bar_ago: n - 1 - i, idx: i, filled: false, inversed: false });
        }
      }
    }
  }

  // [PHASE3-FIX 3C-1] fill checked over ALL bars after the FVG candle
  for (const fvg of result) {
    const i0 = fvg.idx;
    if (i0 + 1 >= n) continue;                 // seg.empty → stays unfilled
    if (fvg.type === 'bullish') {
      for (let j = i0 + 1; j < n; j++) if (lows[j] <= fvg.fvg_low) { fvg.filled = true; break; }
    } else {
      for (let j = i0 + 1; j < n; j++) if (highs[j] >= fvg.fvg_high) { fvg.filled = true; break; }
    }
  }

  const active = includeFilled ? result.slice() : result.filter((f) => !f.filled);
  active.sort((a, b) => b.idx - a.idx);   // stable, like Python sort(reverse=True)
  return active;
}

/**
 * find_ifvgs(df, fvg_list): every FILLED FVG becomes an inverted level — copy with
 * inversed=True, filled=False and the type flipped (bullish → ifvg_bearish,
 * bearish → ifvg_bullish). Reads the last bar (IndexError on an empty frame).
 */
function findIfvgs(frame, fvgList) {
  requireLast(frame);
  const ifvgs = [];
  for (const fvg of fvgList) {
    if (!fvg.filled) continue;
    const inv = { ...fvg, inversed: true, filled: false };
    inv.type = fvg.type === 'bullish' ? 'ifvg_bearish' : 'ifvg_bullish';
    ifvgs.push(inv);
  }
  return ifvgs;
}

/**
 * nearest_fvg(fvg_list, price, direction): among unfilled FVGs of type `direction`
 * or `"ifvg_" + direction`, the one whose midpoint is closest to price (first
 * minimum wins, like Python min()). null when none.
 */
function nearestFvg(fvgList, price, direction = 'bullish') {
  const alt = 'ifvg_' + direction;
  let best = null;
  let bestKey = Infinity;
  for (const f of fvgList) {
    if (!(f.type === direction || f.type === alt) || f.filled) continue;
    const key = Math.abs((f.fvg_low + f.fvg_high) / 2 - price);
    if (best === null || key < bestKey) { best = f; bestKey = key; }
  }
  return best;
}

/**
 * get_fvg_analysis(df, min_gap_pct, inversed_fvg=True, partial_fill_invalid=False)
 * → {all_fvgs (unfilled), ifvgs, bull_fvg, bear_fvg, bull_found, bear_found}.
 * `partial_fill_invalid` is accepted and ignored (spec §4.4).
 */
function getFvgAnalysis(frame, minGapPct = 0.1, inversedFvg = true /* , partialFillInvalid = false */) {
  const all = findFvgs(frame, minGapPct, 'both', true);
  const allFvgs = all.filter((f) => !f.filled);
  const ifvgs = inversedFvg ? findIfvgs(frame, all.filter((f) => f.filled)) : [];

  requireLast(frame);
  const price = frame.c[nBars(frame) - 1];
  const pool = allFvgs.concat(ifvgs);
  const bullFvg = nearestFvg(pool, price, 'bullish');
  const bearFvg = nearestFvg(pool, price, 'bearish');

  return {
    all_fvgs: allFvgs,
    ifvgs,
    bull_fvg: bullFvg,
    bear_fvg: bearFvg,
    bull_found: bullFvg !== null,
    bear_found: bearFvg !== null,
  };
}

module.exports = { findFvgs, findIfvgs, nearestFvg, getFvgAnalysis };
