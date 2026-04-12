/**
 * gerchikStrategy.js — Gerchik Level Trading Strategy
 * Ported from Python CHM_BREAKER_V4/gerchik_strategy.py
 *
 * Concept: Price moves from one strong level to another.
 * Trade ONLY from support/resistance levels.
 * No indicators — only Price Action + Volume.
 *
 * Key terms:
 *   БСУ   — bar that formed the level
 *   БПУ-1 — first bar confirming the level (touches and bounces)
 *   БПУ-2 — second confirming bar (right after BPU-1, no gaps)
 *   ТВХ   — entry point (limit order at level + buffer 20% of stop)
 */

const config = require('../config/tradingDefaults');

/**
 * Analyze candles for Gerchik strategy signals
 * @param {Array} candles - [{open, high, low, close, volume, ts}]
 * @param {object} params - override defaults from config.GERCHIK
 * @returns {object|null} signal or null
 */
function analyzeGerchik(candles, params = {}) {
  const cfg = { ...config.GERCHIK, ...params };
  if (candles.length < cfg.lookback + 10) return null;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const vols   = candles.map(c => c.volume);

  // ATR for stop calculation
  const atrArr = _atr(highs, lows, closes, 14);
  const currentATR = atrArr[atrArr.length - 2];
  const lastClose = closes[closes.length - 2];
  if (!currentATR || currentATR <= 0) return null;

  // 1. Find levels (pivots)
  const levels = _findLevels(candles, cfg);
  if (!levels.length) return null;

  // 2. Cluster nearby levels
  const clustered = _clusterLevels(levels, lastClose, cfg.clusterTolerance);

  // 3. Check for BSU → BPU-1 → BPU-2 confirmation
  const lastIdx = candles.length - 2; // last closed candle
  let bestSignal = null;

  for (const level of clustered) {
    const signal = _checkConfirmation(candles, level, lastIdx, currentATR, cfg);
    if (signal) {
      // Check R:R against next opposing level
      const rr = _checkRR(signal, clustered, cfg);
      if (rr >= cfg.minRR) {
        signal.rr = rr;
        signal.confidence = _calcConfidence(level, rr);
        if (!bestSignal || rr > bestSignal.rr) bestSignal = signal;
      }
    }
  }

  return bestSignal;
}

// ═══════════════════════════════════════════════════════════════
//  LEVEL DETECTION
// ═══════════════════════════════════════════════════════════════

function _findLevels(candles, cfg) {
  const levels = [];
  const ps = cfg.pivotStrength || 5;
  const lb = cfg.lookback || 50;
  const start = Math.max(ps, candles.length - lb);
  const end = candles.length - ps - 1;

  for (let i = start; i < end; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    let isResistance = true, isSupport = true;

    for (let j = 1; j <= ps; j++) {
      if (candles[i - j].high >= h || candles[i + j].high >= h) isResistance = false;
      if (candles[i - j].low <= l || candles[i + j].low <= l) isSupport = false;
    }

    if (isResistance) {
      levels.push({ price: h, type: 'resistance', barIndex: i, strength: 1, touchCount: 1, isMirror: false });
    }
    if (isSupport) {
      levels.push({ price: l, type: 'support', barIndex: i, strength: 1, touchCount: 1, isMirror: false });
    }
  }

  // Count touches and detect mirror levels
  const lastClose = candles[candles.length - 2].close;
  for (const level of levels) {
    const tol = level.price * (cfg.clusterTolerance || 0.003);
    for (const c of candles.slice(-lb)) {
      if (Math.abs(c.high - level.price) < tol || Math.abs(c.low - level.price) < tol) {
        level.touchCount++;
      }
    }
    // Mirror level: was support, now resistance (or vice versa)
    const opposites = levels.filter(l => l.type !== level.type && Math.abs(l.price - level.price) < tol);
    if (opposites.length > 0) {
      level.isMirror = true;
      level.strength += cfg.mirrorLevelBonus || 3;
    }
    // Strength from touches
    level.strength += Math.min(level.touchCount - 1, 5);
  }

  return levels;
}

function _clusterLevels(levels, price, tolerance) {
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const clustered = [];

  for (const level of sorted) {
    const existing = clustered.find(c => Math.abs(c.price - level.price) / price < tolerance);
    if (existing) {
      // Merge: keep stronger
      if (level.strength > existing.strength) {
        existing.price = level.price;
        existing.strength = level.strength;
      }
      existing.touchCount = Math.max(existing.touchCount, level.touchCount);
      existing.isMirror = existing.isMirror || level.isMirror;
    } else {
      clustered.push({ ...level });
    }
  }

  return clustered;
}

// ═══════════════════════════════════════════════════════════════
//  BSU → BPU-1 → BPU-2 CONFIRMATION
// ═══════════════════════════════════════════════════════════════

function _checkConfirmation(candles, level, lastIdx, atr, cfg) {
  const tol = level.price * (cfg.clusterTolerance || 0.003);
  const price = candles[lastIdx].close;

  // Check last 3 bars for BPU-1 → BPU-2 pattern
  // BPU-1: touches level and bounces (close away from level)
  // BPU-2: next bar also stays on the right side (strict > BPU-1 close for support)

  const b1 = candles[lastIdx - 1]; // potential BPU-1
  const b2 = candles[lastIdx];     // potential BPU-2

  if (level.type === 'support') {
    // BPU-1: low touched support, closed above
    const b1Touched = Math.abs(b1.low - level.price) < tol;
    const b1Bounced = b1.close > level.price;
    // BPU-2: low >= BPU-1 low (strict >), closed above support
    const b2Valid = b2.low > b1.low && b2.close > level.price; // V4: strict >
    // Volume on BPU bars (V4: check volume)
    const avgVol = _avgVolume(candles, lastIdx - 5, lastIdx - 2);
    const volOk = !cfg.volumeOnBPU || (b1.volume >= avgVol * 0.8 && b2.volume >= avgVol * 0.8);

    if (b1Touched && b1Bounced && b2Valid && volOk) {
      const buffer = cfg.buffer || 0.20;
      const slDist = Math.max(atr * 1.2, level.price * 0.003);
      const sl = level.price - slDist;
      const atrFloor = (cfg.atrFloor || 0.3) / 100 * price;
      const finalSL = Math.min(sl, price - atrFloor);
      const entry = level.price + slDist * buffer; // entry slightly above level
      const risk = Math.abs(entry - finalSL);
      const tp1 = entry + risk * (cfg.tp1R || 3.0);
      const tp2 = entry + risk * (cfg.tp2R || 4.0);

      return {
        direction: 'long', entry, sl: finalSL, tp1, tp2,
        level: level.price, levelType: 'support',
        signalType: 'Gerchik BSU-BPU', strength: level.strength,
        isMirror: level.isMirror, touchCount: level.touchCount,
      };
    }
  }

  if (level.type === 'resistance') {
    const b1Touched = Math.abs(b1.high - level.price) < tol;
    const b1Bounced = b1.close < level.price;
    const b2Valid = b2.high < b1.high && b2.close < level.price;
    const avgVol = _avgVolume(candles, lastIdx - 5, lastIdx - 2);
    const volOk = !cfg.volumeOnBPU || (b1.volume >= avgVol * 0.8 && b2.volume >= avgVol * 0.8);

    if (b1Touched && b1Bounced && b2Valid && volOk) {
      const buffer = cfg.buffer || 0.20;
      const slDist = Math.max(atr * 1.2, level.price * 0.003);
      const sl = level.price + slDist;
      const atrFloor = (cfg.atrFloor || 0.3) / 100 * price;
      const finalSL = Math.max(sl, price + atrFloor);
      const entry = level.price - slDist * buffer;
      const risk = Math.abs(finalSL - entry);
      const tp1 = entry - risk * (cfg.tp1R || 3.0);
      const tp2 = entry - risk * (cfg.tp2R || 4.0);

      return {
        direction: 'short', entry, sl: finalSL, tp1, tp2,
        level: level.price, levelType: 'resistance',
        signalType: 'Gerchik BSU-BPU', strength: level.strength,
        isMirror: level.isMirror, touchCount: level.touchCount,
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════
//  R:R CHECK (against next opposing level)
// ═══════════════════════════════════════════════════════════════

function _checkRR(signal, levels, cfg) {
  const risk = Math.abs(signal.entry - signal.sl);
  if (risk <= 0) return 0;

  if (signal.direction === 'long') {
    // Find nearest resistance above entry
    const resistances = levels.filter(l => l.type === 'resistance' && l.price > signal.entry);
    if (resistances.length) {
      const nearest = resistances.sort((a, b) => a.price - b.price)[0];
      const reward = nearest.price - signal.entry;
      return reward / risk;
    }
  } else {
    // Find nearest support below entry
    const supports = levels.filter(l => l.type === 'support' && l.price < signal.entry);
    if (supports.length) {
      const nearest = supports.sort((a, b) => b.price - a.price)[0];
      const reward = signal.entry - nearest.price;
      return reward / risk;
    }
  }

  // Fallback: use TP from signal
  return Math.abs(signal.tp1 - signal.entry) / risk;
}

function _calcConfidence(level, rr) {
  let c = 45;
  if (level.isMirror) c += 15;
  if (level.touchCount >= 3) c += 10;
  if (level.strength >= 4) c += 10;
  if (rr >= 4.0) c += 10; else if (rr >= 3.0) c += 5;
  return Math.min(95, Math.max(30, c));
}

function _avgVolume(candles, from, to) {
  let sum = 0, count = 0;
  for (let i = Math.max(0, from); i <= Math.min(candles.length - 1, to); i++) {
    sum += candles[i].volume; count++;
  }
  return count > 0 ? sum / count : 1;
}

function _ema(data, period) {
  const k = 2 / (period + 1);
  const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i - 1] * (1 - k));
  return r;
}

function _atr(highs, lows, closes, period) {
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < highs.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  return _ema(tr, period);
}

module.exports = { analyzeGerchik };
