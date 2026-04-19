/**
 * SMC (Smart Money Concepts) strategy — main entry.
 *
 * Usage:
 *   const { scan } = require('./strategies/smc');
 *   const signal = scan(candles, config);
 *
 * Candles: CCXT-style [openTime, o, h, l, c, v, closeTime] tuples.
 *
 * Multi-timeframe handling: if only one candle series is supplied,
 * we treat it as BOTH htf and mtf. Ideally, the scanner/backtest
 * engine passes candlesMtf = caller's main TF and candlesHtf = 4×
 * upsampled (e.g. 15m main → 1h htf). For MVP we use the single
 * series and let the SMC rules still apply — less confluence available
 * but a valid signal still emerges when all 5 steps align.
 */

const { analyze } = require('./analyzer');
const { buildSignal } = require('./signalBuilder');
const { DEFAULT_CONFIG } = require('./config');

/**
 * Standard strategy interface: scan(candles, config) → Signal | null.
 */
function scan(candles, userConfig = {}) {
  if (!Array.isArray(candles) || candles.length < 80) return null;

  // Single-series mode: use same candles for HTF + MTF, LTF falls back to MTF too.
  const analysis = analyze({
    htf: candles,
    mtf: candles,
    ltf: candles,
    config: userConfig,
  });

  return buildSignal('', analysis, userConfig);
}

module.exports = { scan, analyze, DEFAULT_CONFIG };
