/**
 * Scalping strategy — 3 approaches:
 *   1. VWAP Bounce      — price touches VWAP + volume confirmation
 *   2. Liquidity Grab   — wick sweep of recent high/low + reversal close
 *   3. Volume Spike     — anomalous volume candle in trend direction
 *
 * All exits: SL structural (ATR-based), TP ≥ 2R net of fees.
 * Entry: always on CLOSED candle (index = len-2, not the forming candle).
 *
 * Ported from bot/CHM_BREAKER_V4/scalping_strategy.py
 */

const indicators = require('../../services/indicators');

const DEFAULT_CONFIG = Object.freeze({
  // VWAP Bounce
  vwapBounceEnabled: true,
  vwapTouchTolerancePct: 0.15,
  vwapBounceMinVolMult: 1.5,

  // Liquidity Grab
  liquidityGrabEnabled: true,
  lgLookback: 20,
  lgWickPct: 0.55,
  lgMinVolMult: 1.3,

  // Volume Spike
  volSpikeEnabled: true,
  volSpikeMult: 2.5,
  volSpikeMinBodyPct: 0.55,

  // Indicators
  emaTrendPeriod: 50,
  rsiPeriod: 14,
  rsiOverbought: 75,
  rsiOversold: 25,
  atrPeriod: 14,
  atrMaxPct: 0.05,
  volPeriod: 20,
  vwapPeriod: 288,

  // Risk
  slAtrMult: 1.5,
  tpRrMin: 2.0,
  maxSlPct: 1.0,
  minSlPct: 0.25,

  // Filters
  trendOnlyMode: false,
});

// ── Indicator helpers ──────────────────────────────────────────────────
function calcVwap(candles, period = 288) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  let sumTpVol = 0, sumVol = 0;
  const queue = [];
  for (let i = 0; i < n; i++) {
    const [, , h, l, c, v] = candles[i];
    const tp = (h + l + c) / 3;
    queue.push({ tpVol: tp * v, vol: v });
    sumTpVol += tp * v;
    sumVol += v;
    if (queue.length > period) {
      const old = queue.shift();
      sumTpVol -= old.tpVol;
      sumVol -= old.vol;
    }
    out[i] = sumVol > 0 ? sumTpVol / sumVol : c;
  }
  return out;
}

function clampSl(entry, sl, atr, direction, cfg) {
  const slPct = (Math.abs(entry - sl) / entry) * 100;
  const atrPct = entry > 0 ? (atr / entry) * 100 : 0;
  const maxSl = Math.max(cfg.maxSlPct, atrPct * 2.0);
  const minSl = Math.max(cfg.minSlPct, atrPct * 0.3);
  if (slPct > maxSl) {
    return direction === 'long' ? entry * (1 - maxSl / 100) : entry * (1 + maxSl / 100);
  }
  if (slPct < minSl) {
    return direction === 'long' ? entry * (1 - minSl / 100) : entry * (1 + minSl / 100);
  }
  return sl;
}

// ── Approach 1: VWAP Bounce ────────────────────────────────────────────
function checkVwapBounce(candles, { vwap, ema, rsi, atr, volSma, cfg, i }) {
  const [, , h0, l0, c0, v0] = candles[i];
  const vw = vwap[i], e0 = ema[i], r0 = rsi[i], a0 = atr[i];
  const av = volSma[i] > 0 ? volSma[i] : 1;
  if (!Number.isFinite(vw) || !Number.isFinite(a0) || vw <= 0 || a0 <= 0) return null;

  const tolerance = (vw * cfg.vwapTouchTolerancePct) / 100;
  const volRatio = v0 / av;

  // LONG
  if (l0 <= vw + tolerance && c0 > vw && c0 > e0 &&
      volRatio >= cfg.vwapBounceMinVolMult && r0 < cfg.rsiOverbought) {
    const entry = c0;
    let sl = vw - cfg.slAtrMult * a0;
    sl = clampSl(entry, sl, a0, 'long', cfg);
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return null;
    const tp = entry + risk * (cfg.tpRrMin + 0.5);
    return { side: 'long', entry, sl, tp, type: 'VWAP Bounce', rsi: r0, volRatio, vwap: vw, atr: a0 };
  }
  // SHORT
  if (h0 >= vw - tolerance && c0 < vw && c0 < e0 &&
      volRatio >= cfg.vwapBounceMinVolMult && r0 > cfg.rsiOversold) {
    const entry = c0;
    let sl = vw + cfg.slAtrMult * a0;
    sl = clampSl(entry, sl, a0, 'short', cfg);
    const risk = Math.abs(sl - entry);
    if (risk <= 0) return null;
    const tp = entry - risk * (cfg.tpRrMin + 0.5);
    return { side: 'short', entry, sl, tp, type: 'VWAP Bounce', rsi: r0, volRatio, vwap: vw, atr: a0 };
  }
  return null;
}

// ── Approach 2: Liquidity Grab ──────────────────────────────────────────
function checkLiquidityGrab(candles, { ema, rsi, atr, volSma, cfg, i }) {
  const [, o0, h0, l0, c0, v0] = candles[i];
  const e0 = ema[i], r0 = rsi[i], a0 = atr[i];
  const av = volSma[i] > 0 ? volSma[i] : 1;
  if (!Number.isFinite(a0) || a0 <= 0) return null;

  const barSize = h0 - l0;
  if (barSize <= 0) return null;
  const body = Math.abs(c0 - o0);
  if (body / barSize < 0.25) return null;
  const volRatio = v0 / av;

  const lb = cfg.lgLookback;
  if (i < lb + 2) return null;
  let recentHigh = -Infinity, recentLow = Infinity;
  for (let k = i - lb; k < i; k++) {
    if (candles[k][2] > recentHigh) recentHigh = candles[k][2];
    if (candles[k][3] < recentLow) recentLow = candles[k][3];
  }

  // LONG: wick below recent low, closed back above
  const lowerWick = Math.min(o0, c0) - l0;
  if (l0 < recentLow && c0 > recentLow &&
      lowerWick / barSize >= cfg.lgWickPct &&
      volRatio >= cfg.lgMinVolMult &&
      c0 > e0 - a0 && r0 < cfg.rsiOverbought) {
    const entry = c0;
    let sl = l0 - a0 * 0.5;
    sl = clampSl(entry, sl, a0, 'long', cfg);
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return null;
    const tp = entry + risk * (cfg.tpRrMin + 0.5);
    return { side: 'long', entry, sl, tp, type: 'Liquidity Grab', rsi: r0, volRatio, atr: a0 };
  }

  // SHORT: wick above recent high
  const upperWick = h0 - Math.max(o0, c0);
  if (h0 > recentHigh && c0 < recentHigh &&
      upperWick / barSize >= cfg.lgWickPct &&
      volRatio >= cfg.lgMinVolMult &&
      c0 < e0 + a0 && r0 > cfg.rsiOversold) {
    const entry = c0;
    let sl = h0 + a0 * 0.5;
    sl = clampSl(entry, sl, a0, 'short', cfg);
    const risk = Math.abs(sl - entry);
    if (risk <= 0) return null;
    const tp = entry - risk * (cfg.tpRrMin + 0.5);
    return { side: 'short', entry, sl, tp, type: 'Liquidity Grab', rsi: r0, volRatio, atr: a0 };
  }
  return null;
}

// ── Approach 3: Volume Spike ───────────────────────────────────────────
function checkVolumeSpike(candles, { ema, rsi, atr, volSma, cfg, i }) {
  const [, o0, h0, l0, c0, v0] = candles[i];
  const e0 = ema[i], r0 = rsi[i], a0 = atr[i];
  const av = volSma[i] > 0 ? volSma[i] : 1;
  if (!Number.isFinite(a0) || a0 <= 0) return null;

  const barSize = h0 - l0;
  if (barSize <= 0) return null;
  const body = Math.abs(c0 - o0);
  const bodyPct = body / barSize;
  const volRatio = v0 / av;
  const isBullish = c0 > o0;

  if (volRatio < cfg.volSpikeMult || bodyPct < cfg.volSpikeMinBodyPct) return null;

  // LONG: bullish spike in uptrend
  if (isBullish && c0 > e0 && r0 < cfg.rsiOverbought) {
    const entry = c0;
    let sl = l0 - a0 * 0.5;
    sl = clampSl(entry, sl, a0, 'long', cfg);
    const risk = Math.abs(entry - sl);
    if (risk <= 0) return null;
    const tp = entry + Math.max(body * 1.5, risk * 2.0);
    return { side: 'long', entry, sl, tp, type: 'Volume Spike', rsi: r0, volRatio, atr: a0 };
  }

  // SHORT
  if (!isBullish && c0 < e0 && r0 > cfg.rsiOversold) {
    const entry = c0;
    let sl = h0 + a0 * 0.5;
    sl = clampSl(entry, sl, a0, 'short', cfg);
    const risk = Math.abs(sl - entry);
    if (risk <= 0) return null;
    const tp = entry - Math.max(body * 1.5, risk * 2.0);
    return { side: 'short', entry, sl, tp, type: 'Volume Spike', rsi: r0, volRatio, atr: a0 };
  }
  return null;
}

// ── Main scan ───────────────────────────────────────────────────────────
function scan(candles, userConfig = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  if (!Array.isArray(candles)) return null;

  const minBars = Math.max(cfg.emaTrendPeriod, cfg.volPeriod, cfg.lgLookback) + 10;
  if (candles.length < minBars) return null;

  const closes = candles.map((c) => c[4]);
  const vols = candles.map((c) => c[5]);

  const vwap = calcVwap(candles, cfg.vwapPeriod);
  const ema = indicators.ema(closes, cfg.emaTrendPeriod);
  const rsi = indicators.rsi(closes, cfg.rsiPeriod);
  const atr = indicators.atr(candles, cfg.atrPeriod);
  const volSma = indicators.sma(vols, cfg.volPeriod);

  // Evaluate on LAST CLOSED bar (index = len - 2); if only 1 bar exists use last
  const i = candles.length >= 2 ? candles.length - 2 : candles.length - 1;
  const c0 = closes[i], a0 = atr[i];
  if (!Number.isFinite(c0) || !Number.isFinite(a0) || c0 <= 0 || a0 <= 0) return null;

  // ATR volatility filter
  if (a0 / c0 > cfg.atrMaxPct) return null;

  const ctx = { vwap, ema, rsi, atr, volSma, cfg, i };
  const candidates = [];
  if (cfg.vwapBounceEnabled) {
    const s = checkVwapBounce(candles, ctx); if (s) candidates.push(s);
  }
  if (cfg.liquidityGrabEnabled) {
    const s = checkLiquidityGrab(candles, ctx); if (s) candidates.push(s);
  }
  if (cfg.volSpikeEnabled) {
    const s = checkVolumeSpike(candles, ctx); if (s) candidates.push(s);
  }
  if (!candidates.length) return null;

  // Pick best RR
  const best = candidates.reduce((b, s) => {
    const rr = Math.abs(s.tp - s.entry) / Math.abs(s.entry - s.sl);
    s._rr = rr;
    return !b || rr > b._rr ? s : b;
  }, null);

  const risk = Math.abs(best.entry - best.sl);
  const dir = best.side === 'long' ? 1 : -1;

  // Produce standard tp1/2/3 at 1R/2R/3R (scalping splits are tighter)
  const tp1 = best.entry + dir * risk * 1.0;
  const tp2 = best.entry + dir * risk * 2.0;
  const tp3 = best.tp; // best._rr R
  const riskReward = Number((Math.abs(best.tp - best.entry) / risk).toFixed(2));

  if (riskReward < cfg.tpRrMin) return null;

  const quality = Math.min(10, Math.max(
    5,
    Math.round(riskReward * 2 + (best.volRatio > 2 ? 1 : 0))
  ));
  const confidence = Math.min(95, Math.max(55, 55 + Math.round(riskReward * 8)));

  return {
    strategy: 'scalping',
    side: best.side,
    entry: round(best.entry),
    stopLoss: round(best.sl),
    tp1: round(tp1), tp2: round(tp2), tp3: round(tp3),
    riskReward,
    quality,
    confidence,
    reason: `Scalping ${best.type}: vol ${best.volRatio.toFixed(2)}x, RSI ${best.rsi.toFixed(1)}, RR ${riskReward}`,
    metadata: {
      approach: best.type,
      volRatio: Number(best.volRatio.toFixed(2)),
      rsi: Number(best.rsi.toFixed(1)),
      atr: Number(best.atr.toFixed(8)),
      vwap: best.vwap !== undefined ? round(best.vwap) : null,
    },
  };
}

function round(x, d = 8) { if (!Number.isFinite(x)) return x; const p = Math.pow(10, d); return Math.round(x * p) / p; }

module.exports = { scan, DEFAULT_CONFIG };
