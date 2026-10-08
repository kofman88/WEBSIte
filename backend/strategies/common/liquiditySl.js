'use strict';
/**
 * liquiditySl.js — one-to-one port of `liquidity_sl_adjuster.adjust_sl_for_magnets`
 * (shared by SMC and LEVELS) and of the SMC wrapper
 * `smc/signal_builder._adjust_sl_for_liquidity`.
 *
 * Push the SL beyond nearby magnet prices (equal lows/highs, pivot clusters, swing
 * extremes) so a market-maker liquidity sweep grabs the magnet first instead of the
 * stop. Pure widening: the SL only moves further from the entry, never closer.
 * Spec: strategy-smc.md §5.4 step 4.
 *
 * Returns `[adjustedSl, info]` with info = { adjusted, reason, target, capped, n_in_zone }
 * exactly like the Python tuple.
 */

const { pyFloat, pyMinList, pyMaxList, pyTruthy, pyGet } = require('./pyval');

const EPS = 1e-9;   // _EPS: float-precision slack on exact-boundary magnets

/**
 * adjust_sl_for_magnets(sl, direction, magnet_prices, *, danger_zone_pct=0.5,
 *                       extension_buf_pct=0.10, max_extension_pct=0.6)
 */
function adjustSlForMagnets(sl, direction, magnetPrices, { dangerZonePct = 0.5, extensionBufPct = 0.10, maxExtensionPct = 0.6 } = {}) {
  const info = { adjusted: false, reason: 'no_magnets', target: null, capped: false, n_in_zone: 0 };
  if (sl <= 0) {
    info.reason = 'invalid_sl';
    return [sl, info];
  }
  let prices;
  try {
    prices = [];
    for (const p of (magnetPrices || [])) {
      const f = pyFloat(p);
      if (f > 0) prices.push(f);
    }
  } catch {
    info.reason = 'invalid_magnets';
    return [sl, info];
  }
  if (!prices.length) return [sl, info];

  if (direction === 'LONG') {
    // magnets BELOW the current SL within the danger zone
    const thresholdLo = sl * (1.0 - dangerZonePct / 100.0) * (1.0 - EPS);
    const hi = sl * (1.0 + EPS);
    const candidates = prices.filter((p) => thresholdLo <= p && p <= hi);
    info.n_in_zone = candidates.length;
    if (!candidates.length) {
      info.reason = 'no_candidates_in_zone';
      return [sl, info];
    }
    const targetPrice = pyMinList(candidates);   // lowest candidate = most dangerous swept zone
    let newSl = targetPrice * (1.0 - extensionBufPct / 100.0);
    const slFloor = sl * (1.0 - maxExtensionPct / 100.0);
    if (newSl < slFloor) {
      newSl = slFloor;
      info.capped = true;
    }
    Object.assign(info, { adjusted: true, reason: 'magnet_in_zone_long', target: targetPrice });
    return [newSl, info];
  }

  // SHORT
  const thresholdHi = sl * (1.0 + dangerZonePct / 100.0) * (1.0 + EPS);
  const lo = sl * (1.0 - EPS);
  const candidates = prices.filter((p) => lo <= p && p <= thresholdHi);
  info.n_in_zone = candidates.length;
  if (!candidates.length) {
    info.reason = 'no_candidates_in_zone';
    return [sl, info];
  }
  const targetPrice = pyMaxList(candidates);
  let newSl = targetPrice * (1.0 + extensionBufPct / 100.0);
  const slCeil = sl * (1.0 + maxExtensionPct / 100.0);
  if (newSl > slCeil) {
    newSl = slCeil;
    info.capped = true;
  }
  Object.assign(info, { adjusted: true, reason: 'magnet_in_zone_short', target: targetPrice });
  return [newSl, info];
}

/**
 * smc/signal_builder._adjust_sl_for_liquidity(sl, direction, liq, ...): magnets are the
 * cluster `price`s of liquidity.equal_lows (LONG) / equal_highs (SHORT).
 */
function adjustSlForLiquidity(sl, direction, liq, opts = {}) {
  if (!pyTruthy(liq) || sl <= 0) {
    const info = { adjusted: false, target: null, capped: false, n_in_zone: 0 };
    info.reason = !pyTruthy(liq) ? 'no_liq_data' : 'invalid_sl';
    return [sl, info];
  }
  const groups = direction === 'LONG' ? (liq.equal_lows || []) : (liq.equal_highs || []);
  const prices = groups.map((eq) => pyGet(eq, 'price', 0));
  return adjustSlForMagnets(sl, direction, prices, opts);
}

module.exports = { EPS, adjustSlForMagnets, adjustSlForLiquidity };
