/**
 * signalFilter.js — V4 Smart Signal Filters
 * Ported from Python CHM_BREAKER_V4/signal_filter.py + auto_trade.py
 *
 * Cascading filters that protect capital:
 * 1. Funding Rate Gate
 * 2. Spread Check
 * 3. Staleness Check
 * 4. BTC Correlation Block
 * 5. Market Regime Filter
 * 6. Cooldown Filter
 * 7. Circuit Breaker (daily loss limit)
 * 8. Quality Gate
 */

const config = require('../config/tradingDefaults');
const { getJSON } = require('../utils/httpClient');
const log = require('../utils/logger')('SignalFilter');

// Cache for BTC trend / funding rates
let _btcTrend = null;      // 'up' | 'down' | 'ranging'
let _btcTrendTs = 0;
let _fundingCache = {};     // { symbol: { rate, ts } }
let _dailyLossR = {};       // { userId: totalLossR }
let _dailyLossDate = '';    // 'YYYY-MM-DD'
let _lastSignalTs = {};     // { 'userId_symbol': timestamp }

/**
 * Run all filters on a signal. Returns { pass: boolean, reason: string }
 */
function filterSignal(signal, userSettings = {}) {
  const filters = config.FILTERS;
  const dir = (signal.direction || 'long').toLowerCase();
  const symbol = signal.symbol || '';

  // 1. Quality Gate
  const minQuality = userSettings.minQuality || config.D_MIN_QUALITY;
  if (signal.quality && signal.quality < minQuality) {
    return { pass: false, reason: `quality ${signal.quality} < min ${minQuality}` };
  }

  // 2. Minimum R:R
  const minRR = userSettings.minRR || config.D_MIN_RR;
  if (signal.rr && signal.rr < minRR) {
    return { pass: false, reason: `R:R ${signal.rr.toFixed(2)} < min ${minRR}` };
  }

  // 3. Staleness Check — price moved too far from signal entry
  if (signal.currentPrice && signal.entry) {
    const movePct = Math.abs(signal.currentPrice - signal.entry) / signal.entry * 100;
    if (movePct > filters.stalenessMaxPct) {
      return { pass: false, reason: `stale: price moved ${movePct.toFixed(1)}% from entry` };
    }
  }

  // 4. Cooldown — min bars between signals for same pair
  const cooldownKey = `${signal.userId || 0}_${symbol}`;
  const now = Date.now();
  if (_lastSignalTs[cooldownKey]) {
    const elapsed = (now - _lastSignalTs[cooldownKey]) / 1000;
    const cooldownSec = (filters.cooldownBars || 5) * _getBarDuration(signal.timeframe || '1h');
    if (elapsed < cooldownSec) {
      return { pass: false, reason: `cooldown: ${Math.round(cooldownSec - elapsed)}s remaining` };
    }
  }

  // 5. Circuit Breaker — daily loss limit
  const maxLoss = userSettings.dailyMaxLossR || config.CIRCUIT_BREAKER.dailyMaxLossR;
  if (maxLoss > 0) {
    const today = new Date().toISOString().slice(0, 10);
    if (_dailyLossDate !== today) {
      _dailyLossR = {};
      _dailyLossDate = today;
    }
    const userId = signal.userId || 0;
    const userLoss = _dailyLossR[userId] || 0;
    if (Math.abs(userLoss) >= maxLoss) {
      return { pass: false, reason: `circuit breaker: daily loss ${userLoss.toFixed(1)}R >= limit ${maxLoss}R` };
    }
  }

  // Mark signal passed
  _lastSignalTs[cooldownKey] = now;
  return { pass: true, reason: 'ok' };
}

/**
 * Async filters that require API calls (funding rate, spread, BTC trend)
 */
async function filterSignalAsync(signal, userSettings = {}) {
  const filters = config.FILTERS;
  const dir = (signal.direction || 'long').toLowerCase();
  const symbol = signal.symbol || '';

  // 1. Funding Rate Gate
  try {
    const funding = await getFundingRate(symbol);
    if (funding !== null) {
      if (dir === 'long' && funding > filters.fundingRateMax) {
        return { pass: false, reason: `funding +${(funding * 100).toFixed(3)}% — LONG blocked` };
      }
      if (dir === 'short' && funding < -filters.fundingRateMax) {
        return { pass: false, reason: `funding ${(funding * 100).toFixed(3)}% — SHORT blocked` };
      }
    }
  } catch (e) { /* funding check optional */ }

  // 2. Spread Check
  try {
    const spread = await getSpread(symbol);
    if (spread !== null && spread > filters.spreadMax) {
      return { pass: false, reason: `spread ${(spread * 100).toFixed(2)}% > max ${(filters.spreadMax * 100).toFixed(1)}%` };
    }
  } catch (e) { /* spread check optional */ }

  // 3. BTC Correlation Block
  if (filters.btcCorrelation && !symbol.startsWith('BTC')) {
    try {
      const trend = await getBTCTrend();
      if (trend === 'down' && dir === 'long') {
        return { pass: false, reason: 'BTC downtrend — ALT LONG blocked' };
      }
      if (trend === 'up' && dir === 'short') {
        return { pass: false, reason: 'BTC uptrend — ALT SHORT blocked' };
      }
    } catch (e) { /* BTC check optional */ }
  }

  return { pass: true, reason: 'ok' };
}

/**
 * Record a trade result for circuit breaker tracking
 */
function recordTradeResult(userId, resultR) {
  const today = new Date().toISOString().slice(0, 10);
  if (_dailyLossDate !== today) {
    _dailyLossR = {};
    _dailyLossDate = today;
  }
  if (!_dailyLossR[userId]) _dailyLossR[userId] = 0;
  _dailyLossR[userId] += resultR;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _getBarDuration(tf) {
  const map = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1H': 3600, '4h': 14400, '4H': 14400, '1d': 86400, '1D': 86400 };
  return map[tf] || 3600;
}

async function getFundingRate(symbol) {
  const cached = _fundingCache[symbol];
  if (cached && Date.now() - cached.ts < 300000) return cached.rate; // 5 min cache

  try {
    const data = await getJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
    const rate = parseFloat(data.lastFundingRate || 0);
    _fundingCache[symbol] = { rate, ts: Date.now() };
    return rate;
  } catch (e) {
    return null;
  }
}

async function getSpread(symbol) {
  try {
    const data = await getJSON(`https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${symbol}`);
    const bid = parseFloat(data.bidPrice || 0);
    const ask = parseFloat(data.askPrice || 0);
    if (bid <= 0 || ask <= 0) return null;
    return (ask - bid) / ((ask + bid) / 2);
  } catch (e) {
    return null;
  }
}

async function getBTCTrend() {
  if (_btcTrend && Date.now() - _btcTrendTs < 900000) return _btcTrend; // 15 min cache

  try {
    const klines = await getJSON('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=55');
    if (!Array.isArray(klines) || klines.length < 55) return 'ranging';

    const closes = klines.map(k => parseFloat(k[4]));
    // EMA 50
    const ema = _ema(closes, 50);
    const last = ema[ema.length - 1];
    const prev = ema[ema.length - 2];
    const slope = (last - prev) / prev;

    _btcTrend = slope > 0.001 ? 'up' : slope < -0.001 ? 'down' : 'ranging';
    _btcTrendTs = Date.now();
    return _btcTrend;
  } catch (e) {
    return 'ranging';
  }
}

function _ema(data, period) {
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

module.exports = {
  filterSignal,
  filterSignalAsync,
  recordTradeResult,
  getFundingRate,
  getSpread,
  getBTCTrend,
};
