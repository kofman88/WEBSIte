/**
 * momentumDetector.js — V4 Momentum Detector
 * Ported from Python CHM_BREAKER_V4 bot logic
 *
 * Monitors BTC/ETH for sudden moves and activates "Relaxed Mode"
 * which loosens strategy filters for 30 minutes to catch impulse moves.
 *
 * Also detects ATR Breakout signals — large candles with volume.
 */

const config = require('../config/tradingDefaults');
const log = require('../utils/logger')('Momentum');

let _relaxedUntil = 0;       // timestamp when relaxed mode expires
let _lastCheckTs = 0;
let _btcPrices = [];          // last N BTC prices for move detection
let _ethPrices = [];

/**
 * Check if relaxed mode is currently active
 */
function isRelaxed() {
  return Date.now() < _relaxedUntil;
}

/**
 * Get time remaining in relaxed mode (ms), 0 if not active
 */
function relaxedTimeLeft() {
  return Math.max(0, _relaxedUntil - Date.now());
}

/**
 * Get current relaxed mode overrides for strategy params
 */
function getRelaxedOverrides() {
  if (!isRelaxed()) return null;
  return config.MOMENTUM.relaxed;
}

/**
 * Check BTC/ETH for impulse moves. Call every scan cycle.
 * @param {number} btcPrice - current BTC price
 * @param {number} ethPrice - current ETH price
 * @returns {object|null} { triggered, asset, movePct, duration }
 */
function checkMomentum(btcPrice, ethPrice) {
  const now = Date.now();
  const checkInterval = (config.MOMENTUM.checkIntervalMin || 5) * 60 * 1000;

  // Store prices with timestamps
  _btcPrices.push({ price: btcPrice, ts: now });
  _ethPrices.push({ price: ethPrice, ts: now });

  // Keep only last 2 hours
  const twoHoursAgo = now - 2 * 60 * 60 * 1000;
  _btcPrices = _btcPrices.filter(p => p.ts > twoHoursAgo);
  _ethPrices = _ethPrices.filter(p => p.ts > twoHoursAgo);

  // Rate limit checks
  if (now - _lastCheckTs < checkInterval) return null;
  _lastCheckTs = now;

  const triggerPct = config.MOMENTUM.triggerPct || 2.0;
  const oneHourAgo = now - 60 * 60 * 1000;

  // Check BTC
  const btcOld = _btcPrices.find(p => p.ts <= oneHourAgo + 60000); // ~1 hour ago
  if (btcOld && btcPrice > 0) {
    const btcMove = Math.abs(btcPrice - btcOld.price) / btcOld.price * 100;
    if (btcMove >= triggerPct) {
      _activateRelaxed();
      log.info(`BTC moved ${btcMove.toFixed(1)}% in 1h — Relaxed Mode ON for ${config.MOMENTUM.relaxedDurationMin}min`);
      return { triggered: true, asset: 'BTC', movePct: +btcMove.toFixed(2), direction: btcPrice > btcOld.price ? 'up' : 'down' };
    }
  }

  // Check ETH
  const ethOld = _ethPrices.find(p => p.ts <= oneHourAgo + 60000);
  if (ethOld && ethPrice > 0) {
    const ethMove = Math.abs(ethPrice - ethOld.price) / ethOld.price * 100;
    if (ethMove >= triggerPct) {
      _activateRelaxed();
      log.info(`ETH moved ${ethMove.toFixed(1)}% in 1h — Relaxed Mode ON for ${config.MOMENTUM.relaxedDurationMin}min`);
      return { triggered: true, asset: 'ETH', movePct: +ethMove.toFixed(2), direction: ethPrice > ethOld.price ? 'up' : 'down' };
    }
  }

  return null;
}

/**
 * Check if a candle qualifies as an ATR Breakout signal
 * @param {object} candle - { open, high, low, close, volume }
 * @param {number} atr - current ATR value
 * @param {number} avgVol - average volume
 * @param {string} trendDir - 'up' | 'down' from EMA
 * @returns {object|null} signal
 */
function checkATRBreakout(candle, atr, avgVol, trendDir) {
  if (!isRelaxed()) return null; // ATR breakout only in Relaxed Mode

  const cfg = config.MOMENTUM.atrBreakout;
  const { open, high, low, close, volume } = candle;
  const barSize = high - low;
  const body = Math.abs(close - open);

  // Candle must be > 2x ATR
  if (barSize < atr * (cfg.atrMult || 2.0)) return null;

  // Volume must be > 1.5x average
  if (avgVol > 0 && volume < avgVol * (cfg.volMult || 1.5)) return null;

  // Body must be > 50% of bar (not a doji)
  if (barSize > 0 && body / barSize < 0.5) return null;

  const isBullish = close > open;
  const risk = atr * (cfg.slBuffer || 0.3);

  if (isBullish && trendDir !== 'down') {
    const entry = close;
    const sl = low - risk;
    const riskDist = entry - sl;
    return {
      direction: 'long', entry, sl,
      tp1: entry + atr * (cfg.tp1Mult || 2.0),
      tp2: entry + atr * (cfg.tp2Mult || 3.0),
      rr: riskDist > 0 ? (atr * (cfg.tp1Mult || 2.0)) / riskDist : 0,
      signalType: 'ATR Breakout',
      confidence: 70,
    };
  }

  if (!isBullish && trendDir !== 'up') {
    const entry = close;
    const sl = high + risk;
    const riskDist = sl - entry;
    return {
      direction: 'short', entry, sl,
      tp1: entry - atr * (cfg.tp1Mult || 2.0),
      tp2: entry - atr * (cfg.tp2Mult || 3.0),
      rr: riskDist > 0 ? (atr * (cfg.tp1Mult || 2.0)) / riskDist : 0,
      signalType: 'ATR Breakout',
      confidence: 70,
    };
  }

  return null;
}

function _activateRelaxed() {
  const duration = (config.MOMENTUM.relaxedDurationMin || 30) * 60 * 1000;
  _relaxedUntil = Date.now() + duration;
}

/**
 * Get momentum status for API
 */
function getStatus() {
  return {
    relaxedMode: isRelaxed(),
    relaxedTimeLeftMs: relaxedTimeLeft(),
    relaxedTimeLeftMin: Math.ceil(relaxedTimeLeft() / 60000),
    btcPricesTracked: _btcPrices.length,
    ethPricesTracked: _ethPrices.length,
    lastBtcPrice: _btcPrices.length ? _btcPrices[_btcPrices.length - 1].price : null,
    lastEthPrice: _ethPrices.length ? _ethPrices[_ethPrices.length - 1].price : null,
  };
}

module.exports = { isRelaxed, relaxedTimeLeft, getRelaxedOverrides, checkMomentum, checkATRBreakout, getStatus };
