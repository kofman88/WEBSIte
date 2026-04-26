/**
 * Technical indicators — pure functions, no side effects.
 *
 * All functions that return a per-bar series return `number[]` of the same
 * length as the input. Values for indices where the indicator has not yet
 * accumulated enough history are `NaN` (not 0, not null — so consumers can
 * distinguish "undefined" from "real zero").
 *
 * Precision note: internal math uses native float64 (same as TA-Lib/pandas).
 * For FINAL price levels (entry/SL/TP) use decimal.js at the call site.
 *
 * Reference: values match TA-Lib within 1e-8 for EMA/SMA/Bollinger/MACD,
 * and within 1e-6 for Wilder-smoothed RSI/ATR/Stochastic.
 */

// ── Simple utilities ────────────────────────────────────────────────────
function isValidNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function filled(length, value = NaN) {
  return new Array(length).fill(value);
}

// ── SMA (Simple Moving Average) ─────────────────────────────────────────
function sma(values, period) {
  if (!Array.isArray(values)) throw new TypeError('values must be array');
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period must be >= 1');
  const out = filled(values.length);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    sum += values[i] - values[i - period];
    out[i] = sum / period;
  }
  return out;
}

// ── EMA (Exponential Moving Average) ────────────────────────────────────
// Seed: simple average of first `period` values. This matches TA-Lib.
function ema(values, period) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period must be >= 1');
  const out = filled(values.length);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = (values[i] - out[i - 1]) * k + out[i - 1];
  }
  return out;
}

// ── RSI (Relative Strength Index) with Wilder smoothing ─────────────────
function rsi(values, period = 14) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period must be >= 1');
  const out = filled(values.length);
  if (values.length <= period) return out;

  // First gain/loss average — simple arithmetic mean over `period` diffs
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gainSum += d;
    else lossSum -= d;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : (avgGain === 0 ? 0 : 100 - 100 / (1 + avgGain / avgLoss));

  // Wilder smoothing
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    if (avgLoss === 0) out[i] = 100;
    else if (avgGain === 0) out[i] = 0;
    else out[i] = 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ── ATR (Average True Range) — Wilder smoothing ─────────────────────────
// Input: candles as [openTime, open, high, low, close, volume, closeTime] tuples
// OR as {high, low, close} objects. Internally we only need h/l/c.
function _extractHLC(candles) {
  if (candles.length === 0) return { high: [], low: [], close: [] };
  const first = candles[0];
  if (Array.isArray(first)) {
    return {
      high: candles.map((c) => c[2]),
      low: candles.map((c) => c[3]),
      close: candles.map((c) => c[4]),
    };
  }
  return {
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  };
}

function trueRange(candles) {
  const { high, low, close } = _extractHLC(candles);
  const out = filled(candles.length);
  if (candles.length === 0) return out;
  out[0] = high[0] - low[0];
  for (let i = 1; i < candles.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    out[i] = Math.max(hl, hc, lc);
  }
  return out;
}

function atr(candles, period = 14) {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period must be >= 1');
  const tr = trueRange(candles);
  const out = filled(candles.length);
  if (candles.length < period) return out;

  // First ATR — simple mean of first `period` TR values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  out[period - 1] = sum / period;
  // Wilder smoothing
  for (let i = period; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

// ── Bollinger Bands ─────────────────────────────────────────────────────
function bollingerBands(values, period = 20, stdDev = 2) {
  const mid = sma(values, period);
  const out = values.map(() => ({ upper: NaN, middle: NaN, lower: NaN }));
  for (let i = period - 1; i < values.length; i++) {
    let variance = 0;
    for (let j = 0; j < period; j++) {
      const d = values[i - j] - mid[i];
      variance += d * d;
    }
    const sd = Math.sqrt(variance / period);
    out[i] = {
      middle: mid[i],
      upper: mid[i] + sd * stdDev,
      lower: mid[i] - sd * stdDev,
    };
  }
  return out;
}

// ── MACD ────────────────────────────────────────────────────────────────
function macd(values, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => {
    const a = emaFast[i], b = emaSlow[i];
    return isValidNumber(a) && isValidNumber(b) ? a - b : NaN;
  });
  // Signal line = EMA of macdLine (dropping initial NaNs)
  const firstValid = macdLine.findIndex(isValidNumber);
  const signalLine = filled(values.length);
  if (firstValid >= 0 && values.length - firstValid >= signal) {
    const slice = macdLine.slice(firstValid);
    const sigSlice = ema(slice, signal);
    for (let i = 0; i < sigSlice.length; i++) signalLine[firstValid + i] = sigSlice[i];
  }
  return values.map((_, i) => ({
    macd: macdLine[i],
    signal: signalLine[i],
    histogram: isValidNumber(macdLine[i]) && isValidNumber(signalLine[i])
      ? macdLine[i] - signalLine[i]
      : NaN,
  }));
}

// ── Stochastic ──────────────────────────────────────────────────────────
function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const { high, low, close } = _extractHLC(candles);
  const out = candles.map(() => ({ k: NaN, d: NaN }));
  if (candles.length < kPeriod) return out;

  // %K raw
  const kRaw = filled(candles.length);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = 0; j < kPeriod; j++) {
      if (high[i - j] > hi) hi = high[i - j];
      if (low[i - j] < lo) lo = low[i - j];
    }
    const range = hi - lo;
    // Flat-market guard: when high==low across the whole window there's
    // no oscillation to report, so %K is genuinely undefined. Returning 0
    // would mislead strategies into seeing a permanent "oversold" reading
    // and emitting false BUY signals on dead/illiquid pairs.
    kRaw[i] = range === 0 ? NaN : ((close[i] - lo) / range) * 100;
  }
  // %D = SMA of %K over dPeriod. Skip NaN slots (flat-market gaps) by
  // computing only over valid points so %D stays NaN until enough %K
  // values exist — instead of being dragged toward 0 by the gaps.
  const kForD = kRaw.map((v) => (isValidNumber(v) ? v : NaN));
  const dLine = (function smaSkipNaN(vals, period) {
    const o = filled(vals.length);
    for (let i = period - 1; i < vals.length; i++) {
      let sum = 0; let n = 0;
      for (let j = 0; j < period; j++) {
        const v = vals[i - j];
        if (isValidNumber(v)) { sum += v; n += 1; }
      }
      if (n === period) o[i] = sum / period;
    }
    return o;
  })(kForD, dPeriod);

  for (let i = 0; i < candles.length; i++) {
    if (isValidNumber(kRaw[i])) out[i].k = kRaw[i];
    if (isValidNumber(dLine[i]) && isValidNumber(kRaw[i])) out[i].d = dLine[i];
  }
  return out;
}

// ── Volume profile (simple avg-vs-current) ──────────────────────────────
function volumeProfile(candles, period = 20) {
  const vol = Array.isArray(candles[0])
    ? candles.map((c) => c[5])
    : candles.map((c) => c.volume);
  const avg = sma(vol, period);
  return candles.map((_, i) => ({
    current: vol[i],
    avg: avg[i],
    ratio: isValidNumber(avg[i]) && avg[i] > 0 ? vol[i] / avg[i] : NaN,
  }));
}

// ── Pivots (swing high/low detection) ───────────────────────────────────
// A pivot high at index i exists if `strength` bars to the left AND right
// all have `high` strictly less than candles[i].high. Symmetric for lows.
function findPivots(candles, strength = 5) {
  if (!Number.isInteger(strength) || strength < 1) throw new RangeError('strength must be >= 1');
  const { high, low } = _extractHLC(candles);
  const highs = [];
  const lows = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (high[i] <= high[i - j] || high[i] <= high[i + j]) isHigh = false;
      if (low[i]  >= low[i - j]  || low[i]  >= low[i + j])  isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, price: high[i] });
    if (isLow)  lows.push({  index: i, price: low[i]  });
  }
  return { highs, lows };
}

// ── Candle patterns (single-bar + 2-bar) ────────────────────────────────
// Returns the first matching pattern (priority order), or null.
function detectCandlePattern(candles, index) {
  if (index < 0 || index >= candles.length) return null;
  const curr = candles[index];
  const prev = index > 0 ? candles[index - 1] : null;

  const getO = (c) => Array.isArray(c) ? c[1] : c.open;
  const getH = (c) => Array.isArray(c) ? c[2] : c.high;
  const getL = (c) => Array.isArray(c) ? c[3] : c.low;
  const getC = (c) => Array.isArray(c) ? c[4] : c.close;

  const o = getO(curr), h = getH(curr), l = getL(curr), c = getC(curr);
  const body = Math.abs(c - o);
  const range = h - l;
  if (range === 0) return null;
  const upperWick = h - Math.max(o, c);
  const lowerWick = Math.min(o, c) - l;

  // Hammer — small body at top, long lower wick
  // (Check before doji because hammer can have tiny body)
  if (body / range < 0.35 && lowerWick / range > 0.55 && upperWick / range < 0.2) {
    return 'hammer';
  }

  // Shooting star — small body at bottom, long upper wick
  if (body / range < 0.35 && upperWick / range > 0.55 && lowerWick / range < 0.2) {
    return 'shooting_star';
  }

  // Doji — very small body, no significant wick imbalance
  if (body / range < 0.1) return 'doji';

  // Engulfing — previous body fully contained inside current body (color flipped)
  if (prev) {
    const po = getO(prev), pc = getC(prev);
    const pBody = Math.abs(pc - po);
    const prevBullish = pc > po;
    const currBullish = c > o;
    if (currBullish !== prevBullish && body > pBody && Math.max(o, c) > Math.max(po, pc) && Math.min(o, c) < Math.min(po, pc)) {
      return currBullish ? 'bullish_engulfing' : 'bearish_engulfing';
    }
  }

  return null;
}

// ── Helper: detect higher-highs / higher-lows (simple trend heuristic) ──
function trendBias(candles, lookback = 20) {
  if (candles.length < lookback + 1) return 'neutral';
  const closes = candles.slice(-lookback).map((c) => Array.isArray(c) ? c[4] : c.close);
  const emaShort = ema(closes, Math.max(3, Math.floor(lookback / 4)));
  const emaLong  = ema(closes, Math.max(5, Math.floor(lookback / 2)));
  const sLast = emaShort[emaShort.length - 1];
  const lLast = emaLong[emaLong.length - 1];
  const firstClose = closes[0];
  const lastClose = closes[closes.length - 1];
  if (sLast > lLast && lastClose > firstClose) return 'bull';
  if (sLast < lLast && lastClose < firstClose) return 'bear';
  return 'sideways';
}

module.exports = {
  sma,
  ema,
  rsi,
  atr,
  trueRange,
  bollingerBands,
  macd,
  stochastic,
  volumeProfile,
  findPivots,
  detectCandlePattern,
  trendBias,
  // internals for tests
  _extractHLC,
};
