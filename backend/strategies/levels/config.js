/**
 * LEVELS strategy — default configuration.
 *
 * This is a generic Support-Resistance retest strategy. When access to
 * bot/CHM_BREAKER_V4/scanner_mid.py becomes available, these defaults should
 * be re-calibrated against the bot's exact formulas (see phase_5_report).
 *
 * Each field carries a docstring explaining what it controls. Strategies
 * instantiate with `{ ...DEFAULT_CONFIG, ...userOverrides }`.
 */

const DEFAULT_CONFIG = Object.freeze({
  // ── Pivot detection ─────────────────────────────────────────────────
  /** Bars required on each side of a pivot to qualify as swing high/low. 3-15. */
  pivotStrength: 5,

  /** Max lookback — candles older than this are ignored entirely. */
  maxBarsLookback: 300,

  // ── Level clustering (merging nearby pivots into one level) ─────────
  /** Two pivots merge into one level if |price_a - price_b| < clusterAtrMult * ATR */
  clusterAtrMult: 0.5,

  /** Minimum number of touches for a valid level. 1 = accept every pivot. */
  minTouches: 2,

  /** How many top levels to keep per side (support + resistance). */
  topLevelsPerSide: 5,

  // ── Level freshness ─────────────────────────────────────────────────
  /** Level is considered stale if its most recent touch is older than this. */
  maxLevelAgeBars: 150,

  /** Ignore levels where distance from current price > maxDistAtrMult * ATR. */
  maxDistAtrMult: 8,

  /** Require minimum distance from current price (avoids "already at level") */
  minDistAtrMult: 0.25,

  // ── Retest detection ────────────────────────────────────────────────
  /** Price must be within retestZoneAtrMult * ATR of the level to count as retest */
  retestZoneAtrMult: 0.4,

  /** Current bar must close BACK above (support) or below (resistance) the level */
  requireCloseBack: true,

  // ── Risk management (SL/TP placement) ───────────────────────────────
  /** Stop loss distance beyond the level = slAtrMult * ATR */
  slAtrMult: 1.0,

  /** Take-profit multipliers expressed as RR (SL distance × mult) */
  tp1RR: 1.0,
  tp2RR: 2.0,
  tp3RR: 3.0,

  // ── Quality scoring ─────────────────────────────────────────────────
  /** Minimum acceptable quality (0-10). Signals below this are dropped. */
  minQuality: 5,

  /** Minimum acceptable risk-reward to TP1. */
  minRiskReward: 1.5,

  /** Volume on signal bar must be at least volumeRatioMin × average */
  volumeRatioMin: 1.2,

  // ── HTF confluence (higher-timeframe trend alignment) ───────────────
  /** If true, long signals require HTF trend to NOT be bearish. */
  requireTrendAlignment: false,

  /** EMA period used for trend bias (compared against price on HTF). */
  trendEmaPeriod: 50,
});

module.exports = { DEFAULT_CONFIG };
