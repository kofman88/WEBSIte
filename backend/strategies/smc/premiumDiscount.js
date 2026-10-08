'use strict';
/**
 * premiumDiscount.js — one-to-one port of `smc/premium_discount.py`
 * (spec strategy-smc.md §4.7): strict 50/50 split of the swing range.
 */

const { pyRound } = require('../common/pyround');

/**
 * get_premium_discount(swing_high, swing_low, current_price, buffer_pct=0.0).
 * `buffer_pct` is accepted and ignored (no equilibrium dead-zone).
 * position_pct is returned ROUNDED to 1 decimal (Python round) — the rounded value
 * is what the signal builder's F3 / c5 read; the zone itself is decided on the
 * unrounded value (>= 50.0 → PREMIUM).
 */
function getPremiumDiscount(swingHigh, swingLow, currentPrice /* , bufferPct = 0.0 */) {
  if (swingHigh <= swingLow) {
    return {
      zone: 'NEUTRAL',
      position_pct: 50.0,
      equilibrium: currentPrice,
      premium_above: currentPrice,
      discount_below: currentPrice,
      swing_high: swingHigh,
      swing_low: swingLow,
    };
  }
  const fullRange = swingHigh - swingLow;
  const equilibrium = (swingHigh + swingLow) / 2;
  const premiumAbove = equilibrium;
  const discountBelow = equilibrium;
  const positionPct = (currentPrice - swingLow) / fullRange * 100;
  const zone = positionPct >= 50.0 ? 'PREMIUM' : 'DISCOUNT';
  return {
    zone,
    position_pct: pyRound(positionPct, 1),
    equilibrium,
    premium_above: premiumAbove,
    discount_below: discountBelow,
    swing_high: swingHigh,
    swing_low: swingLow,
  };
}

module.exports = { getPremiumDiscount };
