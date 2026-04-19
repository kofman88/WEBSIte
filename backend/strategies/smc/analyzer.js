/**
 * SMC Analyzer — orchestrates 5 steps: Structure → Liquidity → OB → FVG → Premium/Discount.
 * Returns a complete analysis dict that signalBuilder consumes.
 *
 * Ported from bot/CHM_BREAKER_V4/smc/analyzer.py
 */

const indicators = require('../../services/indicators');
const { getMarketStructure } = require('./structure');
const { findLiquiditySweeps } = require('./liquidity');
const { getOrderBlocks } = require('./orderBlock');
const { getFvgAnalysis } = require('./fvg');
const { getPremiumDiscount } = require('./premiumDiscount');
const { DEFAULT_CONFIG } = require('./config');

/**
 * @param {Array} candlesHtf - higher-timeframe candles (for structure + liquidity)
 * @param {Array} candlesMtf - mid-timeframe candles (for OB, premium/discount)
 * @param {Array} candlesLtf - low-timeframe candles (for FVG) — optional, falls back to mtf
 * @param {object} userConfig
 */
function analyze({ htf, mtf, ltf = null, config = {} } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const result = {
    structure: {}, liquidity: {}, ob: {}, fvg: {}, pdZone: {},
    atr: 0, currentPrice: 0, currentHigh: 0, currentLow: 0,
    volumeOk: false, volRatio: 0, volLast: 0, volAvg: 0,
    error: null,
  };

  if (!Array.isArray(htf) || !Array.isArray(mtf)) {
    result.error = 'htf and mtf candles required';
    return result;
  }

  try {
    // Step 1: Structure (HTF)
    const structure = getMarketStructure(htf, {
      lookback: cfg.swingLookback,
      bosConfirm: cfg.bosConfirmation,
      chochEnabled: cfg.chochEnabled,
    });
    result.structure = structure;

    // Step 2: Liquidity (HTF)
    result.liquidity = findLiquiditySweeps(
      htf, structure.swingHighs, structure.swingLows,
      {
        thresholdPct: cfg.equalThresholdPct,
        closeRequired: cfg.sweepCloseRequired,
        wickRatio: cfg.sweepWickRatio,
      }
    );

    // Step 3: Order Blocks (MTF)
    const safeBos = structure.bos || { detected: false, direction: '', price: 0 };
    result.ob = getOrderBlocks(mtf, safeBos, {
      minImpulsePct: cfg.obMinImpulsePct,
      maxAgeCandles: cfg.obMaxAgeCandles,
      mitigatedInvalid: cfg.obMitigatedInvalid,
      useBreakerBlocks: cfg.obUseBreaker,
    });

    // Step 4: FVG (LTF preferred, else MTF)
    const dfFvg = Array.isArray(ltf) && ltf.length ? ltf : mtf;
    result.fvg = cfg.fvgEnabled
      ? getFvgAnalysis(dfFvg, {
          minGapPct: cfg.fvgMinGapPct,
          inversedFvg: cfg.fvgInversed,
        })
      : { bullFvg: null, bearFvg: null, bullFound: false, bearFound: false };

    // ATR on MTF
    const atrSeries = indicators.atr(mtf, 14);
    const atrVal = atrSeries[atrSeries.length - 1];
    result.atr = Number.isFinite(atrVal) ? atrVal : 0;

    // Volume check (MTF)
    const volLen = Math.max(5, cfg.volLen);
    if (mtf.length >= volLen + 2) {
      const volSeries = mtf.map((c) => c[5]);
      const slice = volSeries.slice(-(volLen + 1), -1);
      const volAvg = slice.reduce((s, v) => s + v, 0) / slice.length;
      const volLast = volSeries[volSeries.length - 2];
      const ratio = volAvg > 0 ? volLast / volAvg : 0;
      result.volAvg = volAvg;
      result.volLast = volLast;
      result.volRatio = ratio;
      result.volumeOk = ratio >= cfg.volMult;
    }

    // Step 5: Premium/Discount
    const lastClosedBar = mtf[mtf.length - 2] || mtf[mtf.length - 1];
    const currentPrice = lastClosedBar[4];
    result.currentPrice = currentPrice;
    result.currentHigh = lastClosedBar[2];
    result.currentLow = lastClosedBar[3];

    if (structure.lastSwingHigh && structure.lastSwingLow && cfg.pdEnabled) {
      result.pdZone = getPremiumDiscount(
        structure.lastSwingHigh.price,
        structure.lastSwingLow.price,
        currentPrice
      );
    } else {
      result.pdZone = { zone: 'NEUTRAL', positionPct: 50 };
    }
  } catch (err) {
    result.error = err.message || String(err);
  }

  return result;
}

module.exports = { analyze };
