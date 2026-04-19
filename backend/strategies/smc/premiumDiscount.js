/**
 * SMC — Premium / Discount zones.
 *
 * Strict 50/50 split:
 *   DISCOUNT  — lower half (position_pct < 50): LONG-only zone
 *   PREMIUM   — upper half (position_pct >= 50): SHORT-only zone
 *
 * Ported from bot/CHM_BREAKER_V4/smc/premium_discount.py
 */

function getPremiumDiscount(swingHigh, swingLow, currentPrice) {
  if (swingHigh == null || swingLow == null || !Number.isFinite(swingHigh) ||
      !Number.isFinite(swingLow) || swingHigh <= swingLow) {
    return {
      zone: 'NEUTRAL', positionPct: 50,
      equilibrium: currentPrice,
      premiumAbove: currentPrice, discountBelow: currentPrice,
      swingHigh, swingLow,
    };
  }
  const fullRange = swingHigh - swingLow;
  const equilibrium = (swingHigh + swingLow) / 2;
  const positionPct = ((currentPrice - swingLow) / fullRange) * 100;
  const zone = positionPct >= 50 ? 'PREMIUM' : 'DISCOUNT';
  return {
    zone, positionPct: Number(positionPct.toFixed(1)),
    equilibrium, premiumAbove: equilibrium, discountBelow: equilibrium,
    swingHigh, swingLow,
  };
}

module.exports = { getPremiumDiscount };
