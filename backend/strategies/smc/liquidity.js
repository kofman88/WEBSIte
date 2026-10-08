'use strict';
/**
 * liquidity.js — one-to-one port of `smc/liquidity.py`: equal highs/lows
 * clustering and liquidity sweeps on the last CLOSED bar (spec strategy-smc.md §4.2).
 */

const { pyRound } = require('../common/pyround');

function nBars(frame) {
  return frame.length !== undefined ? frame.length : frame.c.length;
}

/**
 * find_equal_levels(levels, threshold_pct): sort by price ascending, walk and
 * group while |price − ref| / ref · 100 ≤ threshold where `ref` is the FIRST
 * member of the current group (not a running mean). Groups of ≥ 2 are emitted as
 * {price: mean, count, levels, type}.
 */
function findEqualLevels(levels, thresholdPct = 0.05) {
  if (!levels || !levels.length) return [];
  const sorted = levels.slice().sort((a, b) => a.price - b.price);
  const groups = [];
  let group = [sorted[0]];
  const emit = () => {
    if (group.length >= 2) {
      // Python sum() over floats: sequential left-to-right from 0
      let s = 0.0;
      for (const x of group) s += x.price;
      groups.push({
        price: s / group.length,
        count: group.length,
        levels: group,
        type: group[0].type === undefined ? '' : group[0].type,
      });
    }
  };
  for (let k = 1; k < sorted.length; k++) {
    const lvl = sorted[k];
    const ref = group[0].price;
    const diff = Math.abs(lvl.price - ref) / ref * 100;
    if (diff <= thresholdPct) {
      group.push(lvl);
    } else {
      emit();
      group = [lvl];
    }
  }
  emit();
  return groups;
}

/**
 * detect_liquidity_sweep(df, equal_level, direction, close_required, wick_ratio)
 * on the last closed bar. "UP" = equal lows swept from below (LONG side),
 * "DOWN" = equal highs swept from above. `wick_ratio` of the result = round(wr, 3).
 */
function detectLiquiditySweep(frame, equalLevel, direction, closeRequired = true, wickRatio = 0.6) {
  const result = { swept: false, level: equalLevel.price, direction, wick_ratio: 0.0 };
  const n = nBars(frame);
  if (n < 5) return result;
  const lvl = equalLevel.price;
  const o = frame.o[n - 1], h = frame.h[n - 1], l = frame.l[n - 1], c = frame.c[n - 1];
  const rng = Math.max(h - l, 1e-10);

  if (direction === 'UP') {
    const tol = lvl * 0.0002; // 0.02 % tolerance for tick touches
    // [SWEEP-FIX] the candle must pass through the level: wick below AND high above
    const sweptBelow = l < lvl + tol && h > lvl;
    const closedBack = closeRequired ? c > lvl : true;
    const lw = Math.min(c, o) - l;   // lower wick
    const wr = lw / rng;
    if (sweptBelow && closedBack && wr >= wickRatio) {
      result.swept = true;
      result.wick_ratio = pyRound(wr, 3);
    }
  } else {
    const tol = lvl * 0.0002;
    const sweptAbove = h > lvl - tol && l < lvl;
    const closedBack = closeRequired ? c < lvl : true;
    const uw = h - Math.max(c, o);   // upper wick
    const wr = uw / rng;
    if (sweptAbove && closedBack && wr >= wickRatio) {
      result.swept = true;
      result.wick_ratio = pyRound(wr, 3);
    }
  }
  return result;
}

/**
 * find_liquidity_sweeps(df, swing_highs, swing_lows, threshold_pct, close_required, wick_ratio).
 * Tags the swing dicts in place (`type: "high" | "low"`), clusters equal levels and
 * picks `sweep_up` = first swept equal-low group ascending, `sweep_down` = first
 * swept equal-high group descending. Defaults carry no `wick_ratio` key.
 */
function findLiquiditySweeps(frame, swingHighs, swingLows, thresholdPct = 0.05, closeRequired = true, wickRatio = 0.6) {
  for (const sh of swingHighs) sh.type = 'high';
  for (const sl of swingLows) sl.type = 'low';

  const eqHighs = findEqualLevels(swingHighs, thresholdPct);
  const eqLows = findEqualLevels(swingLows, thresholdPct);

  let sweepUp = { swept: false, level: 0.0, direction: 'UP' };
  let sweepDown = { swept: false, level: 0.0, direction: 'DOWN' };

  for (const eq of eqLows) {
    const res = detectLiquiditySweep(frame, eq, 'UP', closeRequired, wickRatio);
    if (res.swept) { sweepUp = res; break; }
  }
  for (let k = eqHighs.length - 1; k >= 0; k--) {
    const res = detectLiquiditySweep(frame, eqHighs[k], 'DOWN', closeRequired, wickRatio);
    if (res.swept) { sweepDown = res; break; }
  }

  return { equal_highs: eqHighs, equal_lows: eqLows, sweep_up: sweepUp, sweep_down: sweepDown };
}

module.exports = { findEqualLevels, detectLiquiditySweep, findLiquiditySweeps };
