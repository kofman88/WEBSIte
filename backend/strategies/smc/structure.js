/**
 * SMC — Market Structure (Swing H/L, BOS, CHoCH).
 *
 * Body-Close Confirmation rule (anti-retail filter):
 *   BOS/CHoCH is recognized ONLY if the candle's CLOSE (body) breaches
 *   the structural level. A wick-only touch is classified as a Liquidity
 *   Sweep (wick_sweep=true) and does NOT generate a structural signal.
 *
 * Ported from bot/CHM_BREAKER_V4/smc/structure.py (2025-04-19)
 */

function findSwingHighs(candles, lookback = 10) {
  const n = candles.length;
  const result = [];
  for (let i = lookback; i < n - lookback; i++) {
    const hi = candles[i][2];
    let isMax = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j][2] > hi || candles[i + j][2] > hi) { isMax = false; break; }
      if (candles[i - j][2] === hi || candles[i + j][2] === hi) {
        // allow equals but prefer strict for cleanest pivot; skip if equal
      }
    }
    if (isMax) {
      result.push({ idx: i, price: hi, bar: n - 1 - i, ts: candles[i][0] });
    }
  }
  return result;
}

function findSwingLows(candles, lookback = 10) {
  const n = candles.length;
  const result = [];
  for (let i = lookback; i < n - lookback; i++) {
    const lo = candles[i][3];
    let isMin = true;
    for (let j = 1; j <= lookback; j++) {
      if (candles[i - j][3] < lo || candles[i + j][3] < lo) { isMin = false; break; }
    }
    if (isMin) {
      result.push({ idx: i, price: lo, bar: n - 1 - i, ts: candles[i][0] });
    }
  }
  return result;
}

function detectTrend(swingHighs, swingLows) {
  if (swingHighs.length < 2 || swingLows.length < 2) return 'RANGING';
  const sh = [...swingHighs].sort((a, b) => a.idx - b.idx).slice(-2);
  const sl = [...swingLows].sort((a, b) => a.idx - b.idx).slice(-2);
  const hh = sh[1].price > sh[0].price;
  const hl = sl[1].price > sl[0].price;
  const lh = sh[1].price < sh[0].price;
  const ll = sl[1].price < sl[0].price;
  if (hh && hl) return 'BULLISH';
  if (lh && ll) return 'BEARISH';
  return 'RANGING';
}

function detectBos(candles, swingHighs, swingLows, confirmClose = true) {
  const empty = { detected: false, price: 0, direction: '', barAgo: 0, wickSweep: false };
  if (!swingHighs.length || !swingLows.length) return empty;

  const last = candles[candles.length - 1];
  const close = last[4], high = last[2], low = last[3];

  // BOS UP
  const prevSH = [...swingHighs].sort((a, b) => a.idx - b.idx).slice(-1)[0];
  if (prevSH) {
    const level = prevSH.price;
    if (close > level) {
      return { detected: true, price: level, direction: 'BULLISH', barAgo: prevSH.bar, wickSweep: false };
    }
    if (high > level && confirmClose) {
      // Wick-only → Liquidity Sweep, no structural break
      return { detected: false, price: level, direction: 'BULLISH', barAgo: prevSH.bar, wickSweep: true };
    }
    if (!confirmClose && high > level) {
      return { detected: true, price: level, direction: 'BULLISH', barAgo: prevSH.bar, wickSweep: false };
    }
  }

  // BOS DOWN
  const prevSL = [...swingLows].sort((a, b) => a.idx - b.idx).slice(-1)[0];
  if (prevSL) {
    const level = prevSL.price;
    if (close < level) {
      return { detected: true, price: level, direction: 'BEARISH', barAgo: prevSL.bar, wickSweep: false };
    }
    if (low < level && confirmClose) {
      return { detected: false, price: level, direction: 'BEARISH', barAgo: prevSL.bar, wickSweep: true };
    }
    if (!confirmClose && low < level) {
      return { detected: true, price: level, direction: 'BEARISH', barAgo: prevSL.bar, wickSweep: false };
    }
  }
  return empty;
}

function detectChoch(candles, swingHighs, swingLows) {
  const empty = { detected: false, price: 0, direction: '', barAgo: 0, wickSweep: false };
  const trend = detectTrend(swingHighs, swingLows);
  const last = candles[candles.length - 1];
  const close = last[4], high = last[2], low = last[3];

  if (trend === 'BEARISH' && swingHighs.length) {
    const prevSH = [...swingHighs].sort((a, b) => a.idx - b.idx).slice(-1)[0];
    const level = prevSH.price;
    if (close > level) return { detected: true, price: level, direction: 'UP', barAgo: prevSH.bar, wickSweep: false };
    if (high > level) return { detected: false, price: level, direction: 'UP', barAgo: prevSH.bar, wickSweep: true };
  }

  if (trend === 'BULLISH' && swingLows.length) {
    const prevSL = [...swingLows].sort((a, b) => a.idx - b.idx).slice(-1)[0];
    const level = prevSL.price;
    if (close < level) return { detected: true, price: level, direction: 'DOWN', barAgo: prevSL.bar, wickSweep: false };
    if (low < level) return { detected: false, price: level, direction: 'DOWN', barAgo: prevSL.bar, wickSweep: true };
  }

  return empty;
}

function getMarketStructure(candles, { lookback = 10, bosConfirm = true, chochEnabled = true } = {}) {
  if (candles.length < lookback * 3) {
    return {
      trend: 'RANGING', swingHighs: [], swingLows: [],
      bos: { detected: false, price: 0, direction: '', barAgo: 0, wickSweep: false },
      choch: { detected: false, price: 0, direction: '', barAgo: 0, wickSweep: false },
      lastSwingHigh: null, lastSwingLow: null,
      bosWickSweep: false, chochWickSweep: false,
    };
  }
  const sh = findSwingHighs(candles, lookback);
  const sl = findSwingLows(candles, lookback);
  const trend = detectTrend(sh, sl);
  const bos = detectBos(candles, sh, sl, bosConfirm);
  const choch = chochEnabled
    ? detectChoch(candles, sh, sl)
    : { detected: false, price: 0, direction: '', barAgo: 0, wickSweep: false };
  const lastSH = sh.length ? [...sh].sort((a, b) => a.idx - b.idx).slice(-1)[0] : null;
  const lastSL = sl.length ? [...sl].sort((a, b) => a.idx - b.idx).slice(-1)[0] : null;
  return {
    trend, swingHighs: sh, swingLows: sl,
    bos, choch, lastSwingHigh: lastSH, lastSwingLow: lastSL,
    bosWickSweep: bos.wickSweep, chochWickSweep: choch.wickSweep,
  };
}

module.exports = {
  findSwingHighs, findSwingLows, detectTrend, detectBos, detectChoch, getMarketStructure,
};
