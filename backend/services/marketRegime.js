/**
 * marketRegime.js — Market Regime Detection
 * Ported from Python CHM_BREAKER_V4/market_regime.py
 *
 * Detects 4 regimes: trending_up, trending_down, ranging, high_vol
 * Uses BTC EMA slope + ATR/price ratio
 * Cached globally for 4 hours
 */

const config = require('../config/tradingDefaults');
const { getJSON } = require('../utils/httpClient');
const log = require('../utils/logger')('MarketRegime');

let _regime = 'ranging';
let _regimeTs = 0;
let _regimeData = null;

const REGIMES = {
  TRENDING_UP:   'trending_up',
  TRENDING_DOWN: 'trending_down',
  RANGING:       'ranging',
  HIGH_VOL:      'high_vol',
};

/**
 * Get current market regime (cached)
 * @returns {Promise<{regime: string, confidence: number, btcPrice: number}>}
 */
async function getRegime() {
  const cacheTTL = (config.REGIME.cacheTTLMin || 240) * 60 * 1000;
  if (_regimeData && Date.now() - _regimeTs < cacheTTL) {
    return _regimeData;
  }
  return await detectRegime();
}

/**
 * Force-detect market regime from BTC data
 */
async function detectRegime() {
  try {
    const klines = await getJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=210');
    if (!Array.isArray(klines) || klines.length < 200) {
      return { regime: REGIMES.RANGING, confidence: 0, btcPrice: 0 };
    }

    const closes = klines.map(k => parseFloat(k[4]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));

    // EMA 50
    const ema50 = _ema(closes, 50);
    const lastEma = ema50[ema50.length - 1];
    const prevEma = ema50[ema50.length - 2];
    const slope = (lastEma - prevEma) / prevEma;

    // ATR 14
    const atr = _atr(highs, lows, closes, 14);
    const lastATR = atr[atr.length - 1];
    const price = closes[closes.length - 1];
    const atrPct = lastATR / price;

    // Average ATR over last 50 bars
    const avgATR = atr.slice(-50).reduce((s, v) => s + v, 0) / 50;
    const volRatio = lastATR / avgATR;

    let regime, confidence;

    if (volRatio > (config.REGIME.highVolThreshold || 1.5)) {
      regime = REGIMES.HIGH_VOL;
      confidence = Math.min(volRatio / 2, 1);
    } else if (slope > (config.REGIME.trendingThreshold || 0.001)) {
      regime = REGIMES.TRENDING_UP;
      confidence = Math.min(slope / 0.005, 1);
    } else if (slope < -(config.REGIME.trendingThreshold || 0.001)) {
      regime = REGIMES.TRENDING_DOWN;
      confidence = Math.min(Math.abs(slope) / 0.005, 1);
    } else {
      regime = REGIMES.RANGING;
      confidence = 1 - Math.abs(slope) / 0.001;
    }

    _regime = regime;
    _regimeTs = Date.now();
    _regimeData = { regime, confidence: +confidence.toFixed(2), btcPrice: price, atrPct: +(atrPct * 100).toFixed(3), volRatio: +volRatio.toFixed(2) };
    log.info(`Regime: ${regime} (conf=${confidence.toFixed(2)}, BTC=$${price.toFixed(0)}, ATR=${(atrPct*100).toFixed(2)}%)`);
    return _regimeData;
  } catch (e) {
    log.warn('detectRegime error:', e.message);
    return { regime: REGIMES.RANGING, confidence: 0, btcPrice: 0 };
  }
}

/**
 * Check if a signal direction is compatible with current regime
 */
function isCompatible(direction, regime) {
  const dir = direction.toLowerCase();
  // Soft blocks — warnings not hard blocks
  if (regime === REGIMES.TRENDING_DOWN && dir === 'long') return { ok: false, reason: 'counter-trend LONG in downtrend' };
  if (regime === REGIMES.TRENDING_UP && dir === 'short') return { ok: false, reason: 'counter-trend SHORT in uptrend' };
  return { ok: true, reason: 'ok' };
}

// ── Indicator helpers ────────────────────────────────────────────────────────

function _ema(data, period) {
  const k = 2 / (period + 1);
  const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
  return r;
}

function _atr(highs, lows, closes, period) {
  const tr = [];
  for (let i = 0; i < highs.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  // SMA then EMA
  const first = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  const result = new Array(period - 1).fill(0);
  result.push(first);
  const k = 2 / (period + 1);
  for (let i = period; i < tr.length; i++) {
    result.push(tr[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

module.exports = { getRegime, detectRegime, isCompatible, REGIMES };
