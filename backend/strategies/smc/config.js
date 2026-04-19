/**
 * SMC strategy — default configuration.
 * All defaults match bot/CHM_BREAKER_V4/smc/analyzer.py SMCConfig class.
 */

const DEFAULT_CONFIG = Object.freeze({
  // Structure
  swingLookback: 10,
  bosConfirmation: true,
  chochEnabled: true,

  // Liquidity
  equalThresholdPct: 0.1,
  sweepWickRatio: 0.3,
  sweepCloseRequired: false,

  // Order Block
  obMinImpulsePct: 0.15,
  obMaxAgeCandles: 60,
  obMitigatedInvalid: true,
  obUseBreaker: true,

  // FVG
  fvgEnabled: true,
  fvgMinGapPct: 0.08,
  fvgInversed: true,

  // Premium / Discount
  pdEnabled: true,

  // Signal builder
  minConfirmations: 3,
  minRr: 2.0,
  slBufferPct: 0.5,
  tp1Ratio: 0.33,
  tp2Ratio: 0.50,
  tp3Ratio: 0.17,

  // Volume filter
  volMult: 1.2,
  volLen: 20,
  useVolumeFilter: false,

  // SL/TP geometry
  slAtrMult: 1.0,
  tp1Rr: 1.0,
  tp2Rr: 2.0,
  tp3Rr: 3.0,
});

module.exports = { DEFAULT_CONFIG };
