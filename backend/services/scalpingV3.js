/**
 * scalpingV3.js — Scalping Strategy V3
 * Ported from Python CHM_BREAKER_V4/scalping_strategy.py
 *
 * Three entry methods:
 * 1. VWAP Bounce — entry from volume-weighted average price
 * 2. Liquidity Grab — entry after false breakout (stop hunt)
 * 3. Volume Spike Momentum — entry on anomalous volume breakout
 *
 * Principles:
 * - SL ALWAYS structural (ATR-based), NEVER fixed %
 * - Entry ONLY on closed candle (index -2)
 * - R:R after commissions >= 2.0
 * - Volume = mandatory confirmation
 */

const config = require('../config/tradingDefaults');

/**
 * Run scalping V3 analysis on candle data
 * @param {Array} candles - [{open, high, low, close, volume, ts}]
 * @param {object} params - override defaults from config.SCALPING
 * @returns {object|null} signal or null
 */
function analyzeScalping(candles, params = {}) {
  const cfg = { ...config.SCALPING, ...params };
  if (candles.length < 55) return null;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const opens  = candles.map(c => c.open);
  const vols   = candles.map(c => c.volume);

  // Indicators
  const ema50  = _ema(closes, cfg.macdFast || 50);
  const rsiArr = _rsi(closes, cfg.rsiPeriod);
  const atrArr = _atr(highs, lows, closes, 14);
  const avgVol = _sma(vols, cfg.macdSlow || 20);
  const vwap   = _vwap(highs, lows, closes, vols);

  // Use second-to-last candle (last closed)
  const i = candles.length - 2;
  const c0 = closes[i], o0 = opens[i], h0 = highs[i], l0 = lows[i], v0 = vols[i];
  const e0 = ema50[i], r0 = rsiArr[i], a0 = atrArr[i], av = avgVol[i] || 1;
  const vw = vwap[i];
  const volRatio = v0 / av;

  if (a0 <= 0 || !vw) return null;

  // Try all 3 approaches, pick best R:R
  const signals = [];

  // 1. VWAP Bounce
  if (cfg.useVWAPBounce) {
    const sig = _checkVWAPBounce(c0, o0, h0, l0, v0, vw, e0, r0, a0, av, cfg);
    if (sig) signals.push(sig);
  }

  // 2. Liquidity Grab
  if (cfg.useLiquidityGrab) {
    const sig = _checkLiquidityGrab(candles, i, e0, r0, a0, av, cfg);
    if (sig) signals.push(sig);
  }

  // 3. Volume Spike
  if (cfg.useVolSpike) {
    const sig = _checkVolumeSpike(c0, o0, h0, l0, v0, e0, r0, a0, av, cfg);
    if (sig) signals.push(sig);
  }

  if (!signals.length) return null;

  // Pick best R:R
  signals.sort((a, b) => b.rr - a.rr);
  const best = signals[0];
  best.rsi = Math.round(r0 * 10) / 10;
  best.volRatio = Math.round(volRatio * 100) / 100;
  best.vwap = vw;
  best.confidence = _calcConfidence(best.rr, volRatio, r0, best.direction);
  return best;
}

// ═══════════════════════════════════════════════════════════════
//  APPROACH 1: VWAP BOUNCE
// ═══════════════════════════════════════════════════════════════

function _checkVWAPBounce(c0, o0, h0, l0, v0, vw, e0, r0, a0, av, cfg) {
  if (vw <= 0) return null;
  const tolerance = vw * 0.0015; // 0.15%
  const volRatio = v0 / av;
  const minVol = cfg.vwap_bounce_min_vol_mult || 1.5;

  // LONG: price touched VWAP from below, closed above, bullish trend
  if (l0 <= vw + tolerance && c0 > vw && c0 > e0 && volRatio >= minVol && r0 < (cfg.rsiOB || 75)) {
    const entry = c0;
    let sl = vw - 1.5 * a0;
    sl = _clampSL(entry, sl, 'long', cfg);
    const risk = Math.abs(entry - sl);
    const tp = entry + risk * 2.5;
    const rr = _calcRR(entry, sl, tp, cfg.fee_rt || 0.11);
    if (rr < 2.0) return null;
    return { direction: 'long', entry, sl, tp1: tp, tp2: entry + risk * 3.5, rr, signalType: 'VWAP Bounce' };
  }

  // SHORT: price touched VWAP from above, closed below, bearish trend
  if (h0 >= vw - tolerance && c0 < vw && c0 < e0 && volRatio >= minVol && r0 > (cfg.rsiOS || 25)) {
    const entry = c0;
    let sl = vw + 1.5 * a0;
    sl = _clampSL(entry, sl, 'short', cfg);
    const risk = Math.abs(sl - entry);
    const tp = entry - risk * 2.5;
    const rr = _calcRR(entry, sl, tp, cfg.fee_rt || 0.11);
    if (rr < 2.0) return null;
    return { direction: 'short', entry, sl, tp1: tp, tp2: entry - risk * 3.5, rr, signalType: 'VWAP Bounce' };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  APPROACH 2: LIQUIDITY GRAB
// ═══════════════════════════════════════════════════════════════

function _checkLiquidityGrab(candles, idx, e0, r0, a0, av, cfg) {
  const lb = cfg.lg_lookback || 20;
  if (idx < lb + 2) return null;

  const c0 = candles[idx].close, o0 = candles[idx].open;
  const h0 = candles[idx].high, l0 = candles[idx].low;
  const v0 = candles[idx].volume;
  const volRatio = v0 / av;
  const barSize = h0 - l0;
  if (barSize <= 0) return null;

  const bodyPct = cfg.bodyPctFilter || 0.55;

  // Recent high/low
  let recentHigh = -Infinity, recentLow = Infinity;
  for (let j = idx - lb; j < idx; j++) {
    if (candles[j].high > recentHigh) recentHigh = candles[j].high;
    if (candles[j].low < recentLow) recentLow = candles[j].low;
  }

  // LONG: wick probed below recent low, closed back inside
  const lowerWick = Math.min(o0, c0) - l0;
  if (l0 < recentLow && c0 > recentLow && lowerWick / barSize >= bodyPct
      && volRatio >= (cfg.lg_min_vol_mult || 1.3) && r0 < (cfg.rsiOB || 75)) {
    const entry = c0;
    let sl = l0 - a0 * 0.5;
    sl = _clampSL(entry, sl, 'long', cfg);
    const risk = Math.abs(entry - sl);
    const tp = entry + risk * 2.5;
    const rr = _calcRR(entry, sl, tp, 0.11);
    if (rr < 2.0) return null;
    return { direction: 'long', entry, sl, tp1: tp, tp2: entry + risk * 3.5, rr, signalType: 'Liquidity Grab' };
  }

  // SHORT: wick probed above recent high, closed back inside
  const upperWick = h0 - Math.max(o0, c0);
  if (h0 > recentHigh && c0 < recentHigh && upperWick / barSize >= bodyPct
      && volRatio >= (cfg.lg_min_vol_mult || 1.3) && r0 > (cfg.rsiOS || 25)) {
    const entry = c0;
    let sl = h0 + a0 * 0.5;
    sl = _clampSL(entry, sl, 'short', cfg);
    const risk = Math.abs(sl - entry);
    const tp = entry - risk * 2.5;
    const rr = _calcRR(entry, sl, tp, 0.11);
    if (rr < 2.0) return null;
    return { direction: 'short', entry, sl, tp1: tp, tp2: entry - risk * 3.5, rr, signalType: 'Liquidity Grab' };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  APPROACH 3: VOLUME SPIKE MOMENTUM
// ═══════════════════════════════════════════════════════════════

function _checkVolumeSpike(c0, o0, h0, l0, v0, e0, r0, a0, av, cfg) {
  const barSize = h0 - l0;
  if (barSize <= 0 || a0 <= 0) return null;

  const body = Math.abs(c0 - o0);
  const bodyPct = body / barSize;
  const volRatio = v0 / av;
  const isBullish = c0 > o0;
  const spikeMult = cfg.volSpikeMult || 2.0;
  const minBody = cfg.vol_spike_min_body_pct || 0.55;

  if (volRatio < spikeMult || bodyPct < minBody) return null;

  // LONG: bullish candle with volume spike
  if (isBullish && c0 > e0 && r0 < (cfg.rsiOB || 75)) {
    const entry = c0;
    let sl = (o0 + l0) / 2; // mid-lower half
    sl = _clampSL(entry, sl, 'long', cfg);
    const risk = Math.abs(entry - sl);
    const tp = entry + Math.max(body * 1.5, risk * 2.0);
    const rr = _calcRR(entry, sl, tp, 0.11);
    if (rr < 2.0) return null;
    return { direction: 'long', entry, sl, tp1: tp, tp2: entry + risk * 3.0, rr, signalType: 'Volume Spike' };
  }

  // SHORT: bearish candle with volume spike
  if (!isBullish && c0 < e0 && r0 > (cfg.rsiOS || 25)) {
    const entry = c0;
    let sl = (o0 + h0) / 2; // mid-upper half
    sl = _clampSL(entry, sl, 'short', cfg);
    const risk = Math.abs(sl - entry);
    const tp = entry - Math.max(body * 1.5, risk * 2.0);
    const rr = _calcRR(entry, sl, tp, 0.11);
    if (rr < 2.0) return null;
    return { direction: 'short', entry, sl, tp1: tp, tp2: entry - risk * 3.0, rr, signalType: 'Volume Spike' };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function _clampSL(entry, sl, dir, cfg) {
  const maxPct = (cfg.max_sl_pct || 1.0) / 100;
  const minPct = (cfg.min_sl_pct || 0.25) / 100;
  const slPct = Math.abs(entry - sl) / entry;
  if (dir === 'long') {
    if (slPct > maxPct) sl = entry * (1 - maxPct);
    if (slPct < minPct) sl = entry * (1 - minPct);
  } else {
    if (slPct > maxPct) sl = entry * (1 + maxPct);
    if (slPct < minPct) sl = entry * (1 + minPct);
  }
  return sl;
}

function _calcRR(entry, sl, tp, feeRt) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  if (risk <= 0) return 0;
  const feeAdjust = entry * (feeRt / 100) * 2; // round-trip
  return (reward - feeAdjust) / risk;
}

function _calcConfidence(rr, volRatio, rsi, dir) {
  let c = 50;
  if (rr >= 3.0) c += 15; else if (rr >= 2.5) c += 10; else if (rr >= 2.0) c += 5;
  if (volRatio >= 3.0) c += 15; else if (volRatio >= 2.0) c += 10; else if (volRatio >= 1.5) c += 5;
  if (dir === 'long' && rsi < 40) c += 10; else if (dir === 'long' && rsi < 50) c += 5;
  if (dir === 'short' && rsi > 60) c += 10; else if (dir === 'short' && rsi > 50) c += 5;
  return Math.min(95, Math.max(30, c));
}

function _ema(data, period) {
  const k = 2 / (period + 1);
  const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
  return r;
}

function _sma(data, period) {
  const r = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { r.push(data[i]); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    r.push(sum / period);
  }
  return r;
}

function _rsi(closes, period = 14) {
  const r = new Array(closes.length).fill(50);
  if (closes.length < period + 1) return r;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  r[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    r[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return r;
}

function _atr(highs, lows, closes, period) {
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return _ema(tr, period);
}

function _vwap(highs, lows, closes, volumes) {
  const r = [];
  let cumVol = 0, cumTP = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumVol += volumes[i];
    cumTP += tp * volumes[i];
    r.push(cumVol > 0 ? cumTP / cumVol : closes[i]);
  }
  return r;
}

module.exports = { analyzeScalping };
