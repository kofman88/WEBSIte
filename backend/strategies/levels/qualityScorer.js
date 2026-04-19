/**
 * Quality scorer — heuristic 0..10 for a candidate LEVELS signal.
 *
 * Replaces the ML-based filter used in the bot (XGBoost). Until we have
 * access to the trained model via ONNX (Phase 3+), this heuristic gives
 * a reasonable approximation. Each factor adds partial points.
 *
 * Scoring rubric:
 *   Touches (stronger level = more valid):     +0..2
 *   Volume on signal bar > average:            +0..2
 *   Risk-reward >= 2:                          +0..2
 *   HTF trend aligned with signal direction:   +0..1
 *   RSI in healthy zone (not extreme):         +0..1
 *   Bullish/bearish candle pattern confluence: +0..1
 *   Level freshness (recent touch):            +0..1
 *
 *   Total clamped to [0, 10].
 */

const indicators = require('../../services/indicators');

function scoreSignal({ candles, index, level, side, rr, cfg, regime }) {
  let score = 0;

  // 1. Touches: 2 touches = +0, 3 = +1, 4+ = +2
  if (level.touches.length >= 4) score += 2;
  else if (level.touches.length >= 3) score += 1;

  // 2. Volume confluence
  const vp = indicators.volumeProfile(candles, Math.min(20, candles.length - 1));
  const volRatio = vp[index] ? vp[index].ratio : NaN;
  if (Number.isFinite(volRatio)) {
    if (volRatio >= 2.0) score += 2;
    else if (volRatio >= cfg.volumeRatioMin) score += 1;
  }

  // 3. Risk-reward
  if (rr >= 3) score += 2;
  else if (rr >= 2) score += 1;

  // 4. HTF trend alignment
  if ((side === 'long' && regime === 'bull') || (side === 'short' && regime === 'bear')) {
    score += 1;
  }

  // 5. RSI in healthy zone
  const closes = candles.map((c) => c[4]);
  const rsi = indicators.rsi(closes, 14);
  const r = rsi[index];
  if (Number.isFinite(r)) {
    if (side === 'long'  && r >= 35 && r <= 55) score += 1;
    if (side === 'short' && r >= 45 && r <= 65) score += 1;
  }

  // 6. Candle pattern confluence
  const pattern = indicators.detectCandlePattern(candles, index);
  if (side === 'long' && (pattern === 'hammer' || pattern === 'bullish_engulfing')) score += 1;
  if (side === 'short' && (pattern === 'shooting_star' || pattern === 'bearish_engulfing')) score += 1;

  // 7. Freshness
  const barsAgo = index - level.lastTouch;
  if (barsAgo <= 20) score += 1;

  return Math.max(0, Math.min(10, score));
}

module.exports = { scoreSignal };
