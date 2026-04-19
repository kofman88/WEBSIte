/**
 * GERCHIK strategy — default configuration.
 *
 * Gerchik's method is essentially a *strict* level-retest system:
 *   1. Only trade "key reference points" (KRP) — levels with ≥3 touches
 *   2. Require an absorption candle at the level (hammer / shooting star /
 *      engulfing) that closes BACK across the level
 *   3. Confirm with volume spike (≥1.5× average) on the signal bar
 *   4. Must align with higher-timeframe trend (no counter-trend trades)
 *   5. Fixed minimum R:R 2.0, target 3.0 on TP2
 *
 * Where the core `levels` strategy casts a wider net and accepts lower-quality
 * setups, `gerchik` trades fewer, higher-confidence signals.
 */

const DEFAULT_CONFIG = Object.freeze({
  // Pivot & level-building (stricter than base levels)
  pivotStrength: 5,
  maxBarsLookback: 300,
  clusterAtrMult: 0.5,
  minTouches: 3,                 // KRP — 3+ touches required
  topLevelsPerSide: 3,
  maxLevelAgeBars: 200,
  maxDistAtrMult: 6,
  minDistAtrMult: 0.3,

  // Retest detection
  retestZoneAtrMult: 0.4,
  requireCloseBack: true,

  // Risk management (Gerchik's 1:2 / 1:3 targets)
  slAtrMult: 1.0,
  tp1RR: 1.5,
  tp2RR: 2.5,
  tp3RR: 3.5,

  // Quality
  minQuality: 6,
  minRiskReward: 2.0,            // Gerchik's fixed minimum
  volumeRatioMin: 1.5,           // volume spike required

  // HTF trend alignment — MANDATORY
  requireTrendAlignment: true,
  trendEmaPeriod: 50,

  // Absorption candle — MANDATORY
  requireAbsorption: true,
});

// Absorption patterns Gerchik accepts at a level (direction-dependent)
const LONG_ABSORPTION  = new Set(['hammer', 'bullish_engulfing']);
const SHORT_ABSORPTION = new Set(['shooting_star', 'bearish_engulfing']);

module.exports = { DEFAULT_CONFIG, LONG_ABSORPTION, SHORT_ABSORPTION };
