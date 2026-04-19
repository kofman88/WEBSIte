/**
 * Market regime classifier — returns 'bull' | 'bear' | 'sideways'.
 *
 * Uses:
 *   - EMA20 vs EMA50 on closes (slope direction)
 *   - Last N closes: where does 50% of price action sit vs EMA50?
 *
 * Used in qualityScorer as a confluence factor (long signals during bull
 * regime get +1 point).
 */

const indicators = require('../../services/indicators');

function classifyRegime(candles, emaPeriod = 50) {
  if (candles.length < emaPeriod + 5) return 'sideways';
  const closes = candles.map((c) => c[4]);
  const emaShort = indicators.ema(closes, Math.max(10, Math.floor(emaPeriod / 2.5)));
  const emaLong  = indicators.ema(closes, emaPeriod);

  const last = closes.length - 1;
  const s = emaShort[last];
  const l = emaLong[last];
  if (!Number.isFinite(s) || !Number.isFinite(l)) return 'sideways';

  const price = closes[last];
  const slope = (emaLong[last] - emaLong[last - 5]) / 5 / emaLong[last]; // % per bar
  const SLOPE_THRESHOLD = 0.0003; // 0.03% per bar → ~1.5% over 5 bars

  if (s > l && price > l && slope > SLOPE_THRESHOLD) return 'bull';
  if (s < l && price < l && slope < -SLOPE_THRESHOLD) return 'bear';
  return 'sideways';
}

module.exports = { classifyRegime };
